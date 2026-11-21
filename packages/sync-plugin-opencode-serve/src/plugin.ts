import { readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
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
import { PluginError, ensureDir, sha256File } from "@pi-agent-hub/sync-plugin-sdk";
import { isRecord, linearize, timestampMs, validateEntries } from "@pi-agent-hub/pi-session";

/**
 * sync-plugin-opencode-serve：以 HTTP 对接 opencode v2.x（≥2.3.0）headless server（Server API 形态）。
 *
 * - 采集（list/read）：全走 server HTTP（/api/session、/api/session/:id/message）
 * - 模型 / 下发：/api/model、/api/session/:id/model、/api/session/:id/prompt（扁平 PromptInput，图片走 files data-uri）
 * - v2 headless 自动执行：deliver 无需客户端维持事件连接。
 * 不再支持 opencode 1.x（已移除磁盘 schema 读取路径）。
 */
interface OpencodeOptions {
  server?: string;
  password?: string;
  token?: string;
}

// v2 SessionMessage.type 中作为对话内容外显的类型
const MESSAGE_TYPES = new Set(["user", "assistant", "system", "synthetic"]);

export class OpencodePlugin {
  private options: OpencodeOptions = {};
  private instance: PluginInstance | undefined;
  private workDir = "";

  private readonly capabilities: PluginCapabilities = {
    collect: true,
    deliver: true,
    import: false,
    losslessImport: false,
    exportNative: true,
    controlInterface: "native-api",
    readStrategy: ["api"],
    deliveryStrategy: ["api"],
    largeReadMode: "temp-file",
    watch: false,
  };

  async initialize(params: PluginInitializeParams): Promise<PluginInitializeResult> {
    const config = isRecord(params.config.options) ? params.config.options : {};
    this.options = {
      server: typeof config.server === "string" ? config.server : undefined,
      password: typeof config.password === "string" ? config.password : undefined,
      token: typeof config.token === "string" ? config.token : undefined,
    };
    const base = this.serverBase();
    this.instance = {
      instanceId: `opencode-${Buffer.from(base || "default").toString("base64url").slice(0, 12)}`,
      displayName: params.config.instance?.name ?? "default",
      homeDir: "",
    };
    this.workDir = params.workDir;
    return { pluginVersion: "0.1.2", protocolVersion: "1.0", capabilities: this.capabilities };
  }

  async detect(): Promise<{ instances: PluginInstance[] }> {
    if (!this.instance) throw new PluginError("invalid_request", "plugin not initialized");
    return { instances: [this.instance] };
  }

  // ---------- HTTP 基座 ----------

  private serverBase(): string {
    return (this.options.server ?? "").replace(/\/+$/, "");
  }

  private authHeaders(): Record<string, string> {
    if (this.options.token) return { Authorization: `Bearer ${this.options.token}` };
    if (this.options.password) {
      const encoded = Buffer.from(`opencode:${this.options.password}`).toString("base64");
      return { Authorization: `Basic ${encoded}` };
    }
    // opencode v2 serve 默认生成随机密码（打印在启动日志）——未配置时尝试无鉴权。
    return {};
  }

  private async request<T>(method: string, path: string, body?: unknown, timeoutMs = 15_000): Promise<T | null> {
    const base = this.serverBase();
    if (!base) throw new PluginError("unsupported", "opencode request requires options.server");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(`${base}${path}`, {
        method,
        headers: { ...this.authHeaders(), ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: controller.signal,
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new PluginError("agent_error", `opencode ${method} ${path} failed: ${res.status} ${text.slice(0, 300)}`);
      }
      if (res.status === 204) return null;
      return (await res.json().catch(() => null)) as T | null;
    } finally {
      clearTimeout(timer);
    }
  }

  private itemsOf<T>(payload: unknown, key = "items"): T[] {
    if (Array.isArray(payload)) return payload as T[];
    if (isRecord(payload)) {
      if (Array.isArray(payload[key])) return payload[key] as T[];
      if (Array.isArray(payload.data)) return payload.data as T[];
    }
    return [];
  }

  // ---------- 会话同步（HTTP） ----------

  async listSessions(): Promise<{ sessions: NativeSessionMeta[] }> {
    const payload = await this.request<unknown>("GET", "/api/session", undefined, 20_000);
    const sessions: NativeSessionMeta[] = [];
    for (const raw of this.itemsOf<Record<string, unknown>>(payload)) {
      const id = typeof raw.id === "string" ? raw.id : "";
      if (!id) continue;
      const info = isRecord(raw.info) ? raw.info : raw;
      const time = isRecord(raw.time) ? raw.time : {};
      const title = typeof raw.title === "string" ? raw.title
        : (typeof info.title === "string" ? info.title : undefined);
      const location = isRecord(raw.location) ? raw.location : (isRecord(info.location) ? info.location : {});
      const directory = typeof location.directory === "string" ? location.directory
        : (typeof info.directory === "string" ? info.directory : undefined);
      const updated = pickNumber(time.updated, info.time_updated, raw.time_updated, info.updated);
      sessions.push({
        nativeId: id,
        updatedAt: updated ?? Date.now(),
        title,
        cwd: directory,
        state: "idle",
      });
    }
    sessions.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
    return { sessions };
  }

  async readSession(params: Record<string, unknown>): Promise<SessionChunk> {
    const nativeId = typeof params.nativeId === "string" ? params.nativeId : "";
    const since = typeof params.since === "number" ? params.since : undefined;
    if (!nativeId) throw new PluginError("invalid_request", "nativeId required");

    // 会话 info（meta）
    const metaPayload = await this.request<unknown>("GET", `/api/session/${encodeURIComponent(nativeId)}`, undefined, 20_000);
    const metaInfo = isRecord(metaPayload) && isRecord(metaPayload.info) ? metaPayload.info : (isRecord(metaPayload) ? metaPayload : {});
    const cwd = typeof metaInfo.directory === "string" ? metaInfo.directory : "";
    const title = typeof metaInfo.title === "string" ? metaInfo.title : undefined;

    // 消息分页拉取（type 过滤 + cursor 翻页，上限保护）
    const allRaw: Array<Record<string, unknown>> = [];
    let cursor: unknown;
    const MAX_PAGES = 20;
    for (let page = 0; page < MAX_PAGES; page += 1) {
      // v2 type query 只接受单枚举值；不传 type 全量拉取后在端侧过滤（MESSAGE_TYPES）。
      const query = new URLSearchParams({ limit: "200" });
      if (cursor !== undefined && cursor !== null) query.set("cursor", String(cursor));
      const payload = await this.request<unknown>("GET", `/api/session/${encodeURIComponent(nativeId)}/message?${query}`, undefined, 30_000);
      if (payload === null) break;
      const arr = this.itemsOf<Record<string, unknown>>(payload);
      allRaw.push(...arr);
      if (Array.isArray(arr) && arr.length < 200) break;
      cursor = isRecord(payload) ? (payload.cursor ?? payload.nextCursor) : undefined;
      if (cursor === undefined || cursor === null) break;
    }

    const entries: CanonicalEntry[] = [];
    for (const raw of allRaw) {
      const rowType = typeof raw.type === "string" ? raw.type : "";
      if (!MESSAGE_TYPES.has(rowType)) continue;
      const id = typeof raw.id === "string" ? raw.id : "";
      // v2 message 端点为展开结构：user.text / assistant.content 在顶层（raw.data 无）。
      const data = isRecord(raw.data) ? raw.data : raw;
      const tsMs = pickNumber(
        isRecord(data.time) && data.time.created,
        raw.time_created, raw.timeCreated, raw.timestamp,
      ) ?? Date.now();
      const previous = entries[entries.length - 1];
      const role = rowType === "assistant" ? "assistant" : (rowType === "user" || rowType === "synthetic" ? "user" : "system");
      entries.push({
        type: "message",
        id: id || `${nativeId}-${entries.length}`,
        parentId: previous?.id ?? null,
        timestamp: new Date(tsMs).toISOString(),
        message: {
          role,
          content: v2MessageParts(data),
          timestamp: tsMs,
        },
      });
    }

    const filtered = since === undefined ? entries : entries.filter((entry) => timestampMs(entry) > since);
    if (since === undefined) {
      const errors = validateEntries(filtered);
      if (errors.length > 0 && filtered.length > 0) throw new PluginError("invalid_output", errors[0]!);
    }
    const updatedAt = allRaw.reduce((max, raw) => {
      const d = isRecord(raw.data) ? raw.data : raw;
      const t = pickNumber(
        isRecord(d.time) ? d.time.created : undefined,
        raw.time_created, raw.timeCreated,
      );
      return t !== undefined && t > max ? t : max;
    }, 0) || Date.now();

    return {
      mode: since === undefined ? "full" : "delta",
      since,
      entries: since === undefined ? linearize(filtered) : filtered,
      meta: {
        cwd,
        title,
        createdAt: Date.now(),
        updatedAt,
        state: "idle",
      },
    };
  }

  // ---------- 模型信息（006） ----------

  async getModelInfo(params: Record<string, unknown>): Promise<{
    agentId: string;
    models: Array<{ provider: string; modelId: string; name: string; reasoning: boolean; input: string[]; thinkingLevels: string[] }>;
    currentModel: { provider: string; modelId: string } | null;
    currentThinkingLevel: string | null;
  }> {
    void params;
    const list = await this.request<unknown>("GET", "/api/model", undefined, 20_000);
    const models = this.itemsOf<Record<string, unknown>>(list)
      .map((m) => {
        const provider = typeof m.providerID === "string" && m.providerID !== "" ? m.providerID
          : (typeof m.provider === "string" ? m.provider : "");
        const modelId = typeof m.id === "string" ? m.id : "";
        const name = typeof m.name === "string" ? m.name : modelId;
        const reasoning = m.reasoning === true || m.reasoningEffort !== undefined;
        return {
          provider,
          modelId,
          name,
          reasoning,
          // v2 无专属 thinking API；推理模型给 ['off','high']（真实档位 ⬜ 待真机）
          input: ["text", "image"],
          thinkingLevels: reasoning ? ["off", "high"] : ["off"],
        };
      })
      .filter((m) => m.provider !== "" && m.modelId !== "");

    let currentModel: { provider: string; modelId: string } | null = null;
    // v2 无会话专属 current 接口：优先读目标会话的 session.model（选模型后即变化），
    // 查不到再回退全局默认模型。
    const nativeId = typeof params.nativeId === "string" ? params.nativeId : "";
    if (nativeId) {
      const sessList = await this.request<unknown>("GET", "/api/session", undefined, 15_000);
      const sess = this.itemsOf<Record<string, unknown>>(sessList)
        .find((s) => s.id === nativeId && isRecord(s.model));
      const sessionModel = sess && isRecord(sess.model) ? (sess.model as Record<string, unknown>) : undefined;
      const id = typeof sessionModel?.id === "string" ? String(sessionModel.id) : "";
      const provider = typeof sessionModel?.providerID === "string" ? String(sessionModel.providerID) : "";
      if (id && provider) currentModel = { provider, modelId: id };
    }
    if (!currentModel) {
      const def = await this.request<unknown>("GET", "/api/model/default", undefined, 15_000);
      if (isRecord(def)) {
        const provider = typeof def.providerID === "string" && def.providerID !== "" ? def.providerID
          : (typeof def.provider === "string" ? def.provider : "");
        const id = typeof def.id === "string" ? def.id : "";
        if (provider && id) currentModel = { provider, modelId: id };
        if (!currentModel && typeof def.model === "string" && def.model.includes("/")) {
          const [p, mid] = def.model.split("/");
          currentModel = { provider: p, modelId: mid };
        }
      }
      if (!currentModel && models[0]) currentModel = { provider: models[0].provider, modelId: models[0].modelId };
    }

    return {
      agentId: this.instance?.instanceId ?? "",
      models,
      currentModel,
      currentThinkingLevel: null,
    };
  }

  // ---------- 下发（007） ----------

  async deliver(request: DeliverRequest): Promise<DeliverResult> {
    if (!this.options.server) throw new PluginError("unsupported", "opencode delivery requires options.server");
    if (request.model) {
      await this.request("POST", `/api/session/${encodeURIComponent(request.nativeId)}/model`, {
        model: { id: request.model.modelId, providerID: request.model.provider },
      }, 20_000);
    }
    const files: Array<{ uri: string; name?: string }> = [];
    for (const image of request.images ?? []) {
      const data = image.dataBase64 ?? (image.path ? (await readFile(image.path)).toString("base64") : "");
      const mime = image.mime ?? "image/png";
      files.push({ uri: `data:${mime};base64,${data}` });
    }
    const body: Record<string, unknown> = { text: request.message, delivery: "steer" };
    if (files.length > 0) body.files = files;
    await this.request("POST", `/api/session/${encodeURIComponent(request.nativeId)}/prompt`, body, 60_000);
    return {
      ok: true,
      state: "completed",
      warnings: files.length ? ["opencode image attachments sent as files data-uri"] : undefined,
    };
  }

  // ---------- 空闲 / 导入 / 导出 ----------

  async checkIdle(params: Record<string, unknown>): Promise<{ idle: boolean }> {
    void params;
    // v2 会话运行状态读取（/api/session/active）⬜ 待真机；默认视为空闲。
    return { idle: true };
  }

  async importSession(_request: ImportRequest): Promise<ImportResult> {
    throw new PluginError("unsupported", "opencode import not wired yet");
  }

  async exportNative(request: ExportNativeRequest): Promise<ExportNativeResult> {
    const payload = await this.request<string | Record<string, unknown>>(
      "GET", `/api/experimental/session/${encodeURIComponent(request.nativeId)}/export`, undefined, 30_000,
    );
    const serialized = typeof payload === "string"
      ? payload
      : JSON.stringify(payload, null, 2);
    const dir = join(request.workDir, "native");
    await ensureDir(dir);
    const target = join(dir, `${request.nativeId}.json`);
    await writeFile(target, serialized, "utf8");
    const info = await stat(target);
    return {
      nativePath: target,
      format: "opencode-v2-export",
      sha256: await sha256File(target),
      bytes: info.size,
    };
  }
}

/** opencode v2 assistant/user message.data → canonical parts（text/thinking/toolCall）。 */
function v2MessageParts(data: Record<string, unknown>): unknown[] {
  const parts: unknown[] = [];
  if (typeof data.text === "string") parts.push({ type: "text", text: data.text });
  // v2 图片走顶层 files[].data(base64, 无前缀) + .mime（deliver 用 PromptInput files data-uri 存储后即此形态）。
  if (Array.isArray(data.files)) {
    for (const file of data.files) {
      if (!isRecord(file)) continue;
      const mimeType = typeof file.mime === "string" ? file.mime : "image/png";
      const raw = typeof file.data === "string" ? file.data : "";
      if (raw) parts.push({ type: "image", mimeType, dataBase64: raw });
    }
  }
  if (Array.isArray(data.parts)) {
    for (const part of data.parts) {
      if (!isRecord(part)) continue;
      const type = typeof part.type === "string" ? part.type : "";
      if (type === "text" && typeof part.text === "string") {
        parts.push({ type: "text", text: part.text });
      } else if (type === "reasoning" && typeof part.text === "string") {
        parts.push({ type: "thinking", thinking: part.text });
      } else if (type === "tool") {
        parts.push({ type: "toolCall", id: String(part.id ?? ""), name: String(part.name ?? part.tool ?? ""), arguments: part.input ?? null });
      }
    }
  }
  if (Array.isArray(data.content)) {
    for (const block of data.content) {
      if (!isRecord(block) || typeof block.type !== "string") continue;
      if (block.type === "text" && typeof block.text === "string") parts.push({ type: "text", text: block.text });
      else if (block.type === "reasoning" && typeof block.text === "string") parts.push({ type: "thinking", thinking: block.text });
      else if (block.type === "toolCall" || block.type === "tool") {
        parts.push({ type: "toolCall", id: String(block.id ?? ""), name: String(block.name ?? ""), arguments: block.arguments ?? block.input ?? null });
      }
    }
  }
  return parts;
}

function pickNumber(...values: unknown[]): number | undefined {
  for (const v of values) {
    if (typeof v === "number" && Number.isFinite(v)) return v;
    if (typeof v === "string") {
      const n = Date.parse(v);
      if (!Number.isNaN(n)) return n;
      const num = Number(v);
      if (Number.isFinite(num) && num > 0) return num;
    }
  }
  return undefined;
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
