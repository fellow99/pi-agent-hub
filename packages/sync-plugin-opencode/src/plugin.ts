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
  token?: string;
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
  private schema: "v2" | "native" | null = null;

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
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>;
    const names = new Set(tables.map((table) => table.name));
    // V2：session_v2 + session_message + session_part（早期/迁移后 schema）
    if (names.has("session_v2") && names.has("session_message") && names.has("session_part")) {
      this.schema = "v2";
      return db;
    }
    // native：opencode 现行 schema（session + message + part）
    if (names.has("session") && names.has("message") && names.has("part")) {
      this.schema = "native";
      return db;
    }
    db.close();
    throw new PluginError("unsupported", "opencode storage version not supported (expected session_v2/session_message/session_part or session/message/part)");
  }

  async listSessions(): Promise<{ sessions: NativeSessionMeta[] }> {
    const db = this.open();
    try {
      const table = this.schema === "v2" ? "session_v2" : "session";
      const rows = db.prepare(
        `SELECT id, title, directory, time_created, time_updated, version FROM ${table} ORDER BY time_updated DESC`,
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

  private async readSessionNative(db: DatabaseSync, nativeId: string, since: number | undefined): Promise<SessionChunk> {
    const session = db.prepare(
      "SELECT id, title, directory, time_created, time_updated, version FROM session WHERE id = ?",
    ).get(nativeId) as SessionRow | undefined;
    if (!session) throw new PluginError("not_found", `opencode session not found: ${nativeId}`);

    const messages = db.prepare(
      "SELECT id, time_created, data FROM message WHERE session_id = ? ORDER BY time_created ASC, id ASC",
    ).all(nativeId) as unknown as Array<{ id: string; time_created: number | null; data: string }>;
    const parts = db.prepare(
      "SELECT message_id, data FROM part WHERE session_id = ? ORDER BY message_id ASC",
    ).all(nativeId) as unknown as Array<{ message_id: string; data: string }>;

    const partsByMessage = new Map<string, string[]>();
    for (const part of parts) {
      const list = partsByMessage.get(part.message_id) ?? [];
      list.push(part.data);
      partsByMessage.set(part.message_id, list);
    }

    const entries: CanonicalEntry[] = messages.map((message, index) => {
      const previous = messages[index - 1];
      const timestamp = new Date(message.time_created ?? session.time_created ?? Date.now()).toISOString();
      const data = parseJson(message.data);
      const role = isRecord(data) && typeof data.role === "string" ? data.role : "user";
      return {
        type: "message",
        id: message.id,
        parentId: previous?.id ?? null,
        timestamp,
        message: {
          role,
          content: nativeContent(partsByMessage.get(message.id) ?? [], data),
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
  }

  async readSession(params: Record<string, unknown>): Promise<SessionChunk> {
    const nativeId = typeof params.nativeId === "string" ? params.nativeId : "";
    const since = typeof params.since === "number" ? params.since : undefined;
    const db = this.open();
    try {
      if (this.schema === "native") return this.readSessionNative(db, nativeId, since);
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
      throw new PluginError("unsupported", "opencode delivery requires options.server (e.g. http://127.0.0.1:4096)");
    }
    const base = this.options.server.replace(/\/+$/, "");
    const headers = this.authHeaders();
    // 模型切换（可选）：POST /api/session/{sessionID}/model，body { model: { id, providerID } }（Model.Ref 子集）
    if (request.model) {
      const resp = await timeoutFetch(`${base}/api/session/${encodeURIComponent(request.nativeId)}/model`, {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({ model: { id: request.model.modelId, providerID: request.model.provider } }),
      }, 15_000);
      if (!resp.ok && resp.status !== 404) {
        throw new PluginError("model_not_found", `opencode set_model failed: ${resp.status} ${await resp.text().catch(() => "")}`);
      }
    }
    // 下发：POST /api/session/{sessionID}/prompt，body { prompt: { text } }（PromptInput.text）
    const body: Record<string, unknown> = { prompt: { text: request.message } };
    // ⬜ 待真机验证：opencode PromptInput 图片附件（图片需 parts；当前文本链路已完成验证）
    const response = await timeoutFetch(`${base}/api/session/${encodeURIComponent(request.nativeId)}/prompt`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }, 30_000);
    if (!response.ok) {
      throw new PluginError("agent_error", `opencode prompt failed: ${response.status} ${await response.text().catch(() => "")}`);
    }
    return { ok: true, state: "completed", warnings: request.images?.length ? ["opencode image attachments ⬜ 待验证"] : undefined };
  }

  /** 006：模型信息查询（HTTP GET /api/model?types=chat + /api/model/default）。字段映射 ⬜ 待真机验证。 */
  async getModelInfo(params: Record<string, unknown>): Promise<{
    agentId: string;
    models: Array<{ provider: string; modelId: string; name: string; reasoning: boolean; input: string[]; thinkingLevels: string[] }>;
    currentModel: { provider: string; modelId: string } | null;
    currentThinkingLevel: string | null;
  }> {
    void params;
    if (!this.options.server) {
      throw new PluginError("unsupported", "opencode model info requires options.server");
    }
    const base = this.options.server.replace(/\/+$/, "");
    const headers = this.authHeaders();
    const listResponse = await timeoutFetch(`${base}/api/model`, { headers }, 15_000);
    const envelope = listResponse.ok ? await listResponse.json().catch(() => null) : null;
    const list = (envelope && Array.isArray(envelope.data) ? envelope.data : []) as unknown[];
    const models = list.map((m) => {
      const record = typeof m === "object" && m !== null ? m as Record<string, unknown> : {};
      const id = typeof record.id === "string" ? record.id : "";
      const provider = typeof record.provider === "string"
        ? record.provider
        : id.includes("/") ? id.split("/")[0] ?? "" : "";
      const modelId = typeof record.model === "string" ? record.model : id;
      const name = typeof record.name === "string" ? record.name : modelId;
      const reasoning = record.reasoning === true;
      return {
        provider,
        modelId,
        name,
        reasoning,
        input: ["text", ...(reasoning ? [] : [])],
        // ⬜ 待真机验证：opencode 无 pi 式 7 档，映射 reasoning 开 = ["off","high"]
        thinkingLevels: reasoning ? ["off", "high"] : ["off"],
      };
    });
    let currentModel: { provider: string; modelId: string } | null = null;
    const def = await timeoutFetch(`${base}/api/model/default`, { headers }, 10_000);
    if (def.ok) {
      const d = await def.json().catch(() => null) as Record<string, unknown> | null;
      const id = d && typeof d.id === "string" ? d.id : "";
      currentModel = id ? { provider: typeof d.provider === "string" ? d.provider : (id.split("/")[0] ?? ""), modelId: typeof d.model === "string" ? d.model : id } : null;
    }
    if (!currentModel) {
      currentModel = list[0] ? { provider: (list[0] as Record<string, unknown>).providerID as string, modelId: (list[0] as Record<string, unknown>).id as string } : null;
    }
    return {
      agentId: this.instance?.instanceId ?? "",
      models,
      currentModel,
      currentThinkingLevel: null,
    };
  }

  /** 007：空闲检查（默认视为空闲；server 有运行中会话时 ⬜ 待接 session/active）。 */
  async checkIdle(params: Record<string, unknown>): Promise<{ idle: boolean }> {
    void params;
    return { idle: true };
  }

  private authHeaders(): Record<string, string> {
    // 优先插件配置 token；否则由 opencode 本机 auth.json 决定（server 按需将来接 keychain）。
    if (this.options.token) return { Authorization: `Bearer ${this.options.token}` };
    return {};
  }

  async importSession(_request: ImportRequest): Promise<ImportResult> {
    throw new PluginError("unsupported", "opencode import not wired yet");
  }

  async exportNative(request: ExportNativeRequest): Promise<ExportNativeResult> {
    const db = this.open();
    try {
      const sessionTable = this.schema === "v2" ? "session_v2" : "session";
      const session = db.prepare(`SELECT id FROM ${sessionTable} WHERE id = ?`).get(request.nativeId);
      if (!session) throw new PluginError("not_found", `opencode session not found: ${request.nativeId}`);
      const dir = join(request.workDir, "native");
      await ensureDir(dir);
      const target = join(dir, `${request.nativeId}.json`);
      const messages = this.schema === "v2"
        ? db.prepare("SELECT * FROM session_message WHERE session_id = ? ORDER BY seq").all(request.nativeId)
        : db.prepare("SELECT * FROM message WHERE session_id = ? ORDER BY time_created ASC, id ASC").all(request.nativeId);
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

function defaultDataDir(): string {  if (process.platform === "win32") {
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

function nativeContent(parts: readonly string[], data: unknown): string {
  const textParts: string[] = [];
  for (const raw of parts) {
    const part = parseJson(raw);
    if (isRecord(part) && part.type === "text" && typeof part.text === "string") textParts.push(part.text);
  }
  if (textParts.length > 0) return textParts.join("\n");
  if (isRecord(data) && typeof data.content === "string") return data.content;
  return JSON.stringify(data).slice(0, 2_000);
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

/** fetch + 超时（AbortController）。 */
async function timeoutFetch(url: string, init: RequestInit = {}, timeoutMs = 15_000): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}
