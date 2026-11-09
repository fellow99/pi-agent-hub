import { copyFile, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join, basename } from "node:path";
import { createHash } from "node:crypto";
import { zstdDecompressSync } from "node:zlib";
import type {
  CanonicalEntry,
  DeliverRequest,
  DeliverResult,
  ExportNativeRequest,
  ExportNativeResult,
  ImportRequest,
  ImportResult,
  NativeSessionMeta,
  PluginCapabilities,
  PluginInitializeParams,
  PluginInitializeResult,
  PluginInstance,
  SessionChunk,
} from "@pi-agent-hub/protocol";
import { PluginError, ensureDir, expandHome, sha256File } from "@pi-agent-hub/sync-plugin-sdk";
import { isRecord, linearize, timestampMs, validateEntries } from "@pi-agent-hub/pi-session";

interface DshOptions {
  sessionRoot?: string;
  host?: string;
  token?: string;
}

interface SessionFile {
  nativeId: string;
  path: string;
  updatedAt: number;
  cwd?: string;
}

export class DshPlugin {
  private options: DshOptions = {};
  private instance: PluginInstance | undefined;
  private workDir = "";

  private readonly capabilities: PluginCapabilities = {
    collect: true,
    deliver: true,
    import: false,
    losslessImport: false,
    exportNative: true,
    controlInterface: "native-api",
    readStrategy: ["storage", "api"],
    deliveryStrategy: ["api"],
    largeReadMode: "temp-file",
    watch: false,
  };

  async initialize(params: PluginInitializeParams): Promise<PluginInitializeResult> {
    const config = isRecord(params.config.options) ? params.config.options : {};
    this.options = {
      sessionRoot: typeof config.sessionRoot === "string" ? expandHome(config.sessionRoot) : undefined,
      host: typeof config.host === "string" ? config.host : undefined,
      token: typeof config.token === "string" ? config.token : undefined,
    };
    const root = this.options.sessionRoot
      ?? (params.config.instance?.sessionRoot ? expandHome(params.config.instance.sessionRoot) : expandHome("~/.dsh/sessions"));
    this.instance = {
      instanceId: `dsh-${Buffer.from(root).toString("base64url").slice(0, 12)}`,
      displayName: params.config.instance?.name ?? "default",
      homeDir: root,
    };
    this.workDir = params.workDir;
    return { pluginVersion: "0.1.0", protocolVersion: "1.0", capabilities: this.capabilities };
  }

  async detect(): Promise<{ instances: PluginInstance[] }> {
    if (!this.instance) throw new PluginError("invalid_request", "plugin not initialized");
    return { instances: [this.instance] };
  }

  private root(): string {
    if (!this.instance) throw new PluginError("invalid_request", "plugin not initialized");
    return this.instance.homeDir;
  }

  private async scan(): Promise<SessionFile[]> {
    const root = this.root();
    const result: SessionFile[] = [];
    let projects: string[];
    try {
      projects = (await readdir(root, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory())
        .map((entry) => join(root, entry.name));
    } catch {
      return [];
    }
    for (const project of projects) {
      let sessions: string[];
      try {
        sessions = (await readdir(project, { withFileTypes: true }))
          .filter((entry) => entry.isDirectory())
          .map((entry) => join(project, entry.name));
      } catch {
        continue;
      }
      for (const sessionDir of sessions) {
        let files: string[];
        try {
          files = await readdir(sessionDir);
        } catch {
          continue;
        }
        const file = files
          .filter((name) => name.startsWith("session.v") && (name.endsWith(".jsonl") || name.endsWith(".jsonl.zstd")))
          .sort()
          .pop();
        if (!file) continue;
        const path = join(sessionDir, file);
        const info = await stat(path);
        result.push({
          nativeId: basename(sessionDir),
          path,
          updatedAt: info.mtimeMs,
          cwd: decodeCwd(basename(project)),
        });
      }
    }
    return result;
  }

  async listSessions(): Promise<{ sessions: NativeSessionMeta[] }> {
    const files = await this.scan();
    return {
      sessions: files.map((file) => ({
        nativeId: file.nativeId,
        nativePath: file.path,
        updatedAt: file.updatedAt,
        cwd: file.cwd,
        state: "idle",
      })),
    };
  }

  private async readRecords(path: string): Promise<unknown[]> {
    const buffer = await readFile(path);
    const text = path.endsWith(".zstd")
      ? zstdDecompressSync(buffer).toString("utf8")
      : buffer.toString("utf8");
    return text.split("\n").filter(Boolean).map((line) => {
      try {
        return JSON.parse(line) as unknown;
      } catch {
        return undefined;
      }
    }).filter((value): value is unknown => value !== undefined);
  }

  async readSession(params: Record<string, unknown>): Promise<SessionChunk> {
    const nativeId = typeof params.nativeId === "string" ? params.nativeId : "";
    const since = typeof params.since === "number" ? params.since : undefined;
    const files = await this.scan();
    const file = files.find((candidate) => candidate.nativeId === nativeId);
    if (!file) throw new PluginError("not_found", `dsh session not found: ${nativeId}`);
    const records = await this.readRecords(file.path);
    const entries: CanonicalEntry[] = records.map((record, index) => {
      const data = isRecord(record) ? record : { value: record };
      const timestamp = typeof data.timestamp === "string" ? data.timestamp : new Date(file.updatedAt).toISOString();
      return {
        type: "custom",
        customType: "dsh.event",
        id: typeof data.id === "string" ? data.id : `${nativeId}-${index}`,
        parentId: index === 0 ? null : (`${nativeId}-${index - 1}`),
        timestamp,
        data,
      };
    });
    const filtered = since === undefined ? entries : entries.filter((entry) => timestampMs(entry) > since);
    if (since === undefined) {
      const errors = validateEntries(filtered);
      if (errors.length > 0) throw new PluginError("invalid_output", errors[0]!);
    }
    return {
      mode: since === undefined ? "full" : "delta",
      since,
      entries: since === undefined ? linearize(filtered) : filtered,
      meta: {
        cwd: file.cwd ?? "",
        createdAt: file.updatedAt,
        updatedAt: file.updatedAt,
        state: "idle",
      },
    };
  }

  async deliver(request: DeliverRequest): Promise<DeliverResult> {
    throw new PluginError("unsupported", `dsh delivery not wired yet: ${request.deliveryId}`);
  }

  async importSession(_request: ImportRequest): Promise<ImportResult> {
    throw new PluginError("unsupported", "dsh import is not supported");
  }

  async exportNative(request: ExportNativeRequest): Promise<ExportNativeResult> {
    const files = await this.scan();
    const file = files.find((candidate) => candidate.nativeId === request.nativeId);
    if (!file) throw new PluginError("not_found", `dsh session not found: ${request.nativeId}`);
    const dir = join(request.workDir, "native");
    await ensureDir(dir);
    const target = join(dir, `${request.nativeId}${file.path.endsWith(".zstd") ? ".zstd" : ".jsonl"}`);
    await copyFile(file.path, target);
    return {
      nativePath: target,
      format: "dsh-jsonl",
      sha256: await sha256File(target),
      bytes: (await stat(target)).size,
    };
  }
}

function decodeCwd(dirName: string): string | undefined {
  if (!dirName.startsWith("--") || !dirName.endsWith("--")) return undefined;
  return dirName.slice(2, -2).replace(/-/g, "/");
}
