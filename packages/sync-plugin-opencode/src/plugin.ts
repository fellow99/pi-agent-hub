import { readFile, readdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { DatabaseSync } from "node:sqlite";
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

interface OpencodeOptions {
  dataDir?: string;
  dbPath?: string;
  server?: string;
  password?: string;
  opencodeCommand?: string;
}

interface SessionRow {
  id: string;
  title: string | null;
  directory: string;
  time_created: number | null;
  time_updated: number | null;
  version: string | null;
}

interface MessageRow {
  id: string;
  type: string;
  seq: number;
  time_created: number | null;
  data: string;
}

interface PartRow {
  message_id: string;
  ordinal: number;
  type: string;
  data: string;
}

export class OpencodePlugin {
  private options: OpencodeOptions = {};
  private instance: PluginInstance | undefined;
  private workDir = "";
  private schema: "v2" | null = null;

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
      dataDir: typeof config.dataDir === "string" ? expandHome(config.dataDir) : undefined,
      dbPath: typeof config.dbPath === "string" ? expandHome(config.dbPath) : undefined,
      server: typeof config.server === "string" ? config.server : undefined,
      password: typeof config.password === "string" ? config.password : undefined,
      opencodeCommand: typeof config.opencodeCommand === "string" ? config.opencodeCommand : "opencode",
    };
    const dataDir = this.options.dataDir ?? defaultDataDir();
    this.instance = {
      instanceId: `opencode-${Buffer.from(dataDir).toString("base64url").slice(0, 12)}`,
      displayName: params.config.instance?.name ?? "default",
      homeDir: dataDir,
    };
    this.workDir = params.workDir;
    return { pluginVersion: "0.1.0", protocolVersion: "1.0", capabilities: this.capabilities };
  }

  async detect(): Promise<{ instances: PluginInstance[] }> {
    if (!this.instance) throw new PluginError("invalid_request", "plugin not initialized");
    return { instances: [this.instance] };
  }

  private async dbPath(): Promise<string> {
    if (this.options.dbPath) return this.options.dbPath;
    const dataDir = this.options.dataDir ?? defaultDataDir();
    const candidates = ["opencode.db"];
    for (const name of candidates) {
      const path = join(dataDir, name);
      try {
        await readFile(path, { encoding: "utf8", flag: "r" });
        return path;
      } catch {
        // try next candidate
      }
    }
    return join(dataDir, "opencode.db");
  }

  private open(): DatabaseSync {
    const path = this.options.dbPath ?? join(this.options.dataDir ?? defaultDataDir(), "opencode.db");
    const db = new DatabaseSync(path, { readOnly: true });
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>;
    const names = new Set(tables.map((table) => table.name));
    if (names.has("session_v2") && names.has("session_message")) {
      this.schema = "v2";
      return db;
    }
    db.close();
    throw new PluginError("unsupported", "opencode storage version not supported (expected V2 session_v2)");
  }

  async listSessions(): Promise<{ sessions: NativeSessionMeta[] }> {
    const db = this.open();
    try {
      const rows = db.prepare(
        "SELECT id, title, directory, time_created, time_updated, version FROM session_v2 ORDER BY time_updated DESC",
      ).all() as unknown as SessionRow[];
      return {
        sessions: rows.map((row) => ({
          nativeId: row.id,
          updatedAt: row.time_updated ?? row.time_created ?? Date.now(),
          title: row.title ?? undefined,
          cwd: row.directory,
          state: "idle",
        })),
      };
    } finally {
      db.close();
    }
  }

  async readSession(params: Record<string, unknown>): Promise<SessionChunk> {
    const nativeId = typeof params.nativeId === "string" ? params.nativeId : "";
    const since = typeof params.since === "number" ? params.since : undefined;
    const db = this.open();
    try {
      const session = db.prepare(
        "SELECT id, title, directory, time_created, time_updated, version FROM session_v2 WHERE id = ?",
      ).get(nativeId) as SessionRow | undefined;
      if (!session) throw new PluginError("not_found", `opencode session not found: ${nativeId}`);

      const messages = db.prepare(
        "SELECT id, type, seq, time_created, data FROM session_message WHERE session_id = ? ORDER BY seq ASC",
      ).all(nativeId) as unknown as MessageRow[];
      const parts = db.prepare(
        "SELECT message_id, ordinal, type, data FROM session_part WHERE session_id = ? ORDER BY message_id, ordinal ASC",
      ).all(nativeId) as unknown as PartRow[];

      const partsByMessage = new Map<string, PartRow[]>();
      for (const part of parts) {
        const list = partsByMessage.get(part.message_id) ?? [];
        list.push(part);
        partsByMessage.set(part.message_id, list);
      }

      const entries: CanonicalEntry[] = messages.map((message, index) => {
        const previous = messages[index - 1];
        const timestamp = new Date(message.time_created ?? session.time_created ?? Date.now()).toISOString();
        const data = parseJson(message.data);
        const role = isRecord(data) && typeof data.role === "string" ? data.role : message.type;
        return {
          type: "message",
          id: message.id,
          parentId: previous?.id ?? null,
          timestamp,
          message: {
            role,
            content: messageContent(partsByMessage.get(message.id) ?? [], data),
            timestamp: message.time_created ?? Date.now(),
          },
        };
      });

      const filtered = since === undefined
        ? entries
        : entries.filter((entry) => timestampMs(entry) > since);
      if (since === undefined) {
        const errors = validateEntries(filtered);
        if (errors.length > 0) throw new PluginError("invalid_output", errors[0]!);
      }
      return {
        mode: since === undefined ? "full" : "delta",
        since,
        entries: since === undefined ? linearize(filtered) : filtered,
        meta: {
          cwd: session.directory,
          title: session.title ?? undefined,
          createdAt: session.time_created ?? Date.now(),
          updatedAt: session.time_updated ?? Date.now(),
          state: "idle",
        },
      };
    } finally {
      db.close();
    }
  }

  async deliver(request: DeliverRequest): Promise<DeliverResult> {
    if (!this.options.server) {
      throw new PluginError("unsupported", "opencode delivery requires options.server (ACP/API not wired yet)");
    }
    throw new PluginError("unsupported", `opencode prompt API not wired yet: ${request.deliveryId}`);
  }

  async importSession(_request: ImportRequest): Promise<ImportResult> {
    throw new PluginError("unsupported", "opencode import not wired yet");
  }

  async exportNative(request: ExportNativeRequest): Promise<ExportNativeResult> {
    const db = this.open();
    try {
      const session = db.prepare("SELECT id FROM session_v2 WHERE id = ?").get(request.nativeId);
      if (!session) throw new PluginError("not_found", `opencode session not found: ${request.nativeId}`);
      const dir = join(request.workDir, "native");
      await ensureDir(dir);
      const target = join(dir, `${request.nativeId}.json`);
      const messages = db.prepare("SELECT * FROM session_message WHERE session_id = ? ORDER BY seq").all(request.nativeId);
      await writeFile(target, JSON.stringify({ session, messages }, null, 2), "utf8");
      return {
        nativePath: target,
        format: "opencode-export",
        sha256: await sha256File(target),
        bytes: (await stat(target)).size,
      };
    } finally {
      db.close();
    }
  }
}

function defaultDataDir(): string {
  if (process.platform === "win32") {
    return join(process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "opencode");
  }
  if (process.platform === "darwin") {
    return join(homedir(), "Library", "Application Support", "opencode");
  }
  return join(process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"), "opencode");
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function messageContent(parts: readonly PartRow[], data: unknown): string {
  const textParts = parts
    .map((part) => (part.type === "text" ? parseJson(part.data) : undefined))
    .filter((value): value is { text: string } => isRecord(value) && typeof value.text === "string")
    .map((value) => value.text);
  if (textParts.length > 0) return textParts.join("\n");
  if (isRecord(data) && typeof data.content === "string") return data.content;
  return JSON.stringify(data).slice(0, 2_000);
}
