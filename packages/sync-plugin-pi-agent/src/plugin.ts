import { copyFile, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
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
import { PluginError, ensureDir, ensureParent, expandHome, sha256File } from "@pi-agent-hub/sync-plugin-sdk";
import {
  createSessionHeader,
  isRecord,
  linearize,
  readSessionFile,
  serializeSession,
  sessionFilePath,
  sha256,
  timestampMs,
  validateEntries,
} from "@pi-agent-hub/pi-session";
import { promptPiSession } from "./pi-rpc.js";

interface PiPluginOptions {
  agentDir?: string;
  piCommand?: string;
}

interface PiInstance {
  instanceId: string;
  displayName: string;
  homeDir: string;
}

export class PiPlugin {
  private options: PiPluginOptions = {};
  private instance: PiInstance | undefined;
  private workDir = "";

  private readonly capabilities: PluginCapabilities = {
    collect: true,
    deliver: true,
    import: true,
    losslessImport: true,
    exportNative: true,
    controlInterface: "native-api",
    readStrategy: ["storage"],
    deliveryStrategy: ["api"],
    largeReadMode: "temp-file",
    watch: false,
  };

  async initialize(params: PluginInitializeParams): Promise<PluginInitializeResult> {
    const config = isRecord(params.config.options) ? params.config.options : {};
    this.options = {
      agentDir: typeof config.agentDir === "string" ? expandHome(config.agentDir) : undefined,
      piCommand: typeof config.piCommand === "string" ? config.piCommand : "pi",
    };
    const homeDir = this.options.agentDir
      ?? (params.config.instance?.agentDir ? expandHome(params.config.instance.agentDir) : expandHome("~/.pi/agent"));
    this.instance = {
      instanceId: `pi-${Buffer.from(homeDir).toString("base64url").slice(0, 12)}`,
      displayName: params.config.instance?.name ?? "default",
      homeDir,
    };
    this.workDir = params.workDir;
    return { pluginVersion: "0.1.0", protocolVersion: "1.0", capabilities: this.capabilities };
  }

  async detect(): Promise<{ instances: PluginInstance[] }> {
    if (!this.instance) throw new PluginError("invalid_request", "plugin not initialized");
    return {
      instances: [{
        instanceId: this.instance.instanceId,
        displayName: this.instance.displayName,
        homeDir: this.instance.homeDir,
      }],
    };
  }

  private agentDir(): string {
    if (!this.instance) throw new PluginError("invalid_request", "plugin not initialized");
    return this.instance.homeDir;
  }

  async listSessions(): Promise<{ sessions: NativeSessionMeta[] }> {
    const sessionsDir = join(this.agentDir(), "sessions");
    let projectDirs: string[];
    try {
      projectDirs = (await readdir(sessionsDir, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
        .map((entry) => join(sessionsDir, entry.name));
    } catch {
      return { sessions: [] };
    }

    const sessions: NativeSessionMeta[] = [];
    for (const dir of projectDirs) {
      let files: string[];
      try {
        files = (await readdir(dir)).filter((file) => file.endsWith(".jsonl")).map((file) => join(dir, file));
      } catch {
        continue;
      }
      for (const file of files) {
        try {
          const parsed = await readSessionFile(file);
          const info = await stat(file);
          const last = parsed.entries[parsed.entries.length - 1];
          sessions.push({
            nativeId: parsed.header.id,
            nativePath: file,
            updatedAt: last ? timestampMs(last) : info.mtimeMs,
            title: this.titleOf(parsed.entries),
            cwd: parsed.header.cwd,
            state: "idle",
            entryCount: parsed.entries.length,
          });
        } catch {
          // skip unreadable session files; they are reported by the daemon log
        }
      }
    }
    sessions.sort((a, b) => b.updatedAt - a.updatedAt);
    return { sessions };
  }

  private titleOf(entries: readonly CanonicalEntry[]): string | undefined {
    for (const entry of entries) {
      if (entry.type === "session_info" && typeof entry.name === "string") return entry.name;
    }
    for (const entry of entries) {
      if (entry.type !== "message" || !isRecord(entry.message)) continue;
      const message = entry.message;
      if (message.role !== "user") continue;
      if (typeof message.content === "string") return message.content.slice(0, 80);
    }
    return undefined;
  }

  private async findSessionPath(nativeId: string): Promise<string> {
    const sessions = await this.listSessions();
    const found = sessions.sessions.find((session) => session.nativeId === nativeId);
    if (!found?.nativePath) throw new PluginError("not_found", `pi session not found: ${nativeId}`);
    return found.nativePath;
  }

  async readSession(params: Record<string, unknown>): Promise<SessionChunk> {
    const nativeId = typeof params.nativeId === "string" ? params.nativeId : "";
    const since = typeof params.since === "number" ? params.since : undefined;
    const lastEntryId = typeof params.lastEntryId === "string" ? params.lastEntryId : undefined;
    const file = await this.findSessionPath(nativeId);
    const parsed = await readSessionFile(file);
    const mode = since === undefined ? "full" : "delta";

    let entries = parsed.entries;
    if (since !== undefined) {
      const lastIndex = lastEntryId ? entries.findIndex((entry) => entry.id === lastEntryId) : -1;
      entries = entries.filter((entry, index) => timestampMs(entry) > since || (lastIndex >= 0 && index > lastIndex));
    }

    if (mode === "full") {
      const errors = validateEntries(entries);
      if (errors.length > 0 && entries.length > 0) {
        throw new PluginError("invalid_output", `invalid pi entry chain: ${errors[0]}`);
      }
    }

    const meta = {
      cwd: parsed.header.cwd,
      title: this.titleOf(parsed.entries),
      createdAt: Date.parse(parsed.header.timestamp),
      updatedAt: entries.length > 0 ? timestampMs(entries[entries.length - 1]!) : Date.parse(parsed.header.timestamp),
      state: "idle" as const,
    };

    const serialized = entries.map((entry) => JSON.stringify(entry)).join("\n");
    if (entries.length > 2_000 || serialized.length > 4 * 1024 * 1024) {
      await ensureDir(join(this.workDir, "native"));
      const output = join(this.workDir, "native", `${nativeId}.ndjson`);
      await writeFile(output, serialized + (entries.length > 0 ? "\n" : ""), "utf8");
      return {
        mode,
        since,
        entriesPath: output,
        sha256: sha256(serialized),
        count: entries.length,
        meta,
      };
    }

    return {
      mode,
      since,
      entries: mode === "full" ? linearize(entries) : entries,
      meta,
    };
  }

  async deliver(request: DeliverRequest): Promise<DeliverResult> {
    const file = await this.findSessionPath(request.nativeId);
    try {
      await promptPiSession({
        command: this.options.piCommand ?? "pi",
        sessionPath: file,
        agentDir: this.agentDir(),
        message: request.message,
      });
      return { ok: true, state: "completed" };
    } catch (error) {
      throw new PluginError("agent_error", error instanceof Error ? error.message : String(error));
    }
  }

  async importSession(request: ImportRequest): Promise<ImportResult> {
    const raw = await readFile(request.bundlePath, "utf8");
    const bundle: unknown = JSON.parse(raw);
    if (!isRecord(bundle) || !isRecord(bundle.canonical) || !Array.isArray(bundle.canonical.entries)) {
      throw new PluginError("invalid_request", "bundle.canonical.entries missing");
    }
    const entries = bundle.canonical.entries.filter((entry): entry is CanonicalEntry =>
      isRecord(entry)
      && typeof entry.type === "string"
      && typeof entry.id === "string"
      && (typeof entry.parentId === "string" || entry.parentId === null)
      && typeof entry.timestamp === "string"
    );
    const errors = validateEntries(entries);
    if (errors.length > 0) throw new PluginError("invalid_request", errors[0]!);

    const id = randomUUID();
    const timestamp = new Date().toISOString();
    const header = createSessionHeader(request.targetCwd, id, timestamp);
    const path = sessionFilePath(this.agentDir(), request.targetCwd, timestamp, id);
    await ensureParent(path);
    await writeFile(path, serializeSession(header, entries), "utf8");
    return { nativeId: id, nativePath: path };
  }

  async exportNative(request: ExportNativeRequest): Promise<ExportNativeResult> {
    const file = await this.findSessionPath(request.nativeId);
    const nativeDir = join(request.workDir, "native");
    await ensureDir(nativeDir);
    const target = join(nativeDir, `${request.nativeId}.jsonl`);
    await copyFile(file, target);
    const info = await stat(target);
    return {
      nativePath: target,
      format: "pi-jsonl-v3",
      sha256: await sha256File(target),
      bytes: info.size,
    };
  }
}
