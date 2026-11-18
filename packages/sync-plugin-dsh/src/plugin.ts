import { copyFile, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join, basename } from "node:path";
import { createHash, randomUUID } from "node:crypto";
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
  /** 附件对象库根（默认 ~/.dsh/attachments/v1/objects）。 */
  attachmentRoot?: string;
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
      attachmentRoot: typeof config.attachmentRoot === "string"
        ? expandHome(config.attachmentRoot)
        : expandHome("~/.dsh/attachments/v1/objects"),
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
    // dsh event 流 → canonical：只保留可展示的消息事件（user/assistant/system），
    // 噪音事件（permission/turn/step/job/request/session-log-* 等）过滤；
    // content blocks 映射为 hub parts（text/thinking/image）。
    const SHOWN_TYPES = new Set(["user/message", "assistant/message", "system/message", "developer/message"]);
    const entries: CanonicalEntry[] = [];
    let shownIndex = 0;
    for (const record of records) {
      if (!isRecord(record) || typeof record.type !== "string") continue;
      if (!SHOWN_TYPES.has(record.type)) continue;
      const data = record;
      const recordType = data.type as string;
      const isDevOrSystem = recordType === "system/message" || recordType === "developer/message";
      // dsh 记录体在 record.data（user/message 的 content 在此；assistant/system 在 data.message）
      const body = isRecord(data.data) ? data.data : data;
      const payload = recordType === "user/message" ? body : (isRecord(body.message) ? body.message : body);
      const role = typeof payload.role === "string" ? payload.role : (recordType === "user/message" ? "user" : "assistant");
      const content = await toHubParts(Array.isArray(payload.content) ? payload.content : [], this.options.attachmentRoot);
      const rawId = isRecord(payload) && typeof payload.id === "string" ? payload.id : undefined;
      const timestamp = typeof data.time === "number"
        ? new Date(data.time).toISOString()
        : (typeof data.timestamp === "string" ? data.timestamp : new Date(file.updatedAt).toISOString());
      const id = rawId ?? `${nativeId}-${shownIndex}`;
      entries.push({
        type: "message",
        id,
        parentId: shownIndex === 0 ? null : entries[shownIndex - 1]!.id,
        timestamp,
        message: {
          role: isDevOrSystem ? "system" : role,
          content,
        },
      } satisfies CanonicalEntry);
      shownIndex += 1;
    }
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
    if (!this.options.host) {
      throw new PluginError("unsupported", "dsh delivery requires options.host (e.g. http://127.0.0.1:8080)");
    }
    // 模型/思考深度切换（可选）：session/selectModel（args.request = SessionSelectModelRequest）
    if (request.model || request.thinkingLevel) {
      await this.rpc("session/selectModel", {
        request: {
          sessionId: request.nativeId,
          provider: request.model?.provider ?? "",
          model: request.model?.modelId ?? "",
          ...(request.thinkingLevel ? { reasoningEffort: request.thinkingLevel } : {}),
        },
      }, 15_000);
    }
    // 下发：session/prompt（args.request = SessionPromptRequest：text/image 块，image 内联 base64）
    const content: unknown[] = [];
    if (request.message) content.push({ type: "text", text: request.message });
    for (const image of request.images ?? []) {
      const data = image.path ? (await readFile(image.path)).toString("base64") : (image.dataBase64 ?? "");
      content.push({ type: "image", mediaType: image.mime ?? "image/png", data, name: "attachment" });
    }
    await this.rpc("session/prompt", {
      request: {
        requestId: `hub-${request.deliveryId}`,
        sessionId: request.nativeId,
        mode: "queue",
        content,
      },
    }, 30_000);
    return { ok: true, state: "completed" };
  }

  /** 006：模型信息查询（Remote session/modelCatalog）。字段映射来自 dsh 源码类型。 */
  async getModelInfo(params: Record<string, unknown>): Promise<{
    agentId: string;
    models: Array<{ provider: string; modelId: string; name: string; reasoning: boolean; input: string[]; thinkingLevels: string[] }>;
    currentModel: { provider: string; modelId: string } | null;
    currentThinkingLevel: string | null;
  }> {
    void params;
    if (!this.options.host) {
      throw new PluginError("unsupported", "dsh model info requires options.host");
    }
    const catalog = await this.rpc<{
      groups?: Array<{ id?: string; name?: string; models?: Array<Record<string, unknown>> }>;
      default?: { provider?: string; model?: string; reasoningEffort?: string };
    }>("session/modelCatalog", {}, 15_000);
    const models: Array<{ provider: string; modelId: string; name: string; reasoning: boolean; input: string[]; thinkingLevels: string[] }> = [];
    for (const group of catalog.groups ?? []) {
      const provider = group.id ?? group.name ?? "";
      for (const model of group.models ?? []) {
        const id = typeof model.id === "string" ? model.id : "";
        const reasoningMeta = (model.reasoning ?? {}) as { efforts?: Array<{ id?: string }> };
        const thinkingLevels = Array.isArray(reasoningMeta.efforts)
          ? reasoningMeta.efforts.map((e) => e.id ?? "").filter((v) => v !== "")
          : [];
        models.push({
          provider,
          modelId: id,
          name: typeof model.name === "string" ? model.name : id,
          reasoning: thinkingLevels.length > 0,
          input: ["text", "image"],
          thinkingLevels,
        });
      }
    }
    const def = catalog.default;
    return {
      agentId: this.instance?.instanceId ?? "",
      models,
      currentModel: def?.provider && def.model ? { provider: def.provider, modelId: def.model } : (models[0] ? { provider: models[0]!.provider, modelId: models[0]!.modelId } : null),
      // ⬜ 待真机验证：会话级当前选择端点未定，先回退模型目录 default（含 reasoningEffort）
      currentThinkingLevel: def?.reasoningEffort ?? null,
    };
  }

  /** 007：空闲检查（默认视为空闲；session/active 状态读取 ⬜ 待接）。 */
  async checkIdle(params: Record<string, unknown>): Promise<{ idle: boolean }> {
    void params;
    return { idle: true };
  }

  /** dsh Connection RPC：POST /api/<method>，body { type:"client-request", rpcId, method, payload }。
   *  鉴权：先 GET /?token= 换 303 + 登录 cookie，后续请求带 cookie。 */
  private cookie = "";

  private async handshake(): Promise<void> {
    const host = this.options.host;
    if (!host) throw new PluginError("unsupported", "dsh RPC requires options.host");
    const base = host.replace(/\/+$/, "");
    if (!this.options.token) return; // 无 token 时直接尝试（trusted-host / 未加固场景）
    const res = await fetch(`${base}/?token=${encodeURIComponent(this.options.token)}`, {
      redirect: "manual",
      signal: AbortSignal.timeout(10_000),
    });
    const setCookie = res.headers.get("set-cookie");
    if (setCookie) this.cookie = setCookie.split(";")[0];
  }

  private async rpc<T>(method: string, payload: Record<string, unknown>, timeoutMs = 15_000): Promise<T> {
    const host = this.options.host;
    if (!host) throw new PluginError("unsupported", "dsh RPC requires options.host");
    const base = host.replace(/\/+$/, "");
    if (!this.cookie && this.options.token) await this.handshake();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const requestBody = JSON.stringify({
        type: "client-request",
        rpcId: randomUUID(),
        method,
        payload: { args: payload },
      });
      const response = await fetch(`${base}/api/${method}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(this.cookie ? { Cookie: this.cookie } : {}),
        },
        body: requestBody,
        signal: controller.signal,
      });
      if (!response.ok) {
        const text = await response.text().catch(() => "");
        throw new PluginError("agent_error", `dsh ${method} failed: ${response.status} ${text.slice(0, 300)}`);
      }
      const data: unknown = await response.json();
      const parsedEnvelope = (typeof data === "object" && data !== null ? data : {}) as {
        result?: { ok?: boolean; value?: T; error?: { code?: string; message?: string } };
      };
      const result = parsedEnvelope.result;
      if (result && result.ok === false) {
        throw new PluginError("agent_error", `dsh ${method} error: ${result.error?.code ?? ""} ${result.error?.message ?? ""}`);
      }
      return result && "value" in result ? (result.value as T) : (data as T);
    } finally {
      clearTimeout(timer);
    }
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
  const decoded = dirName.slice(2, -2).replace(/-/g, "/");
  if (decoded.startsWith("/") || /^[A-Za-z]:/.test(decoded)) return decoded;
  return `/${decoded}`;
}

/** 解析 dsh image block 的 `attachment.attachmentId`（sha256:<hash>）为内联 base64 part。
 *  对象库布局 `~/.dsh/attachments/v1/objects/<hash前2位>/<hash>`（真机 2026-11-18 取证）。
 *  读不到对象时降级为仅 mimeType 占位，不阻断同步。 */
async function resolveImagePart(block: Record<string, unknown>, attachmentRoot: string | undefined): Promise<Record<string, unknown>> {
  const attachment = isRecord(block.attachment) ? block.attachment : undefined;
  const mime = typeof block.mimeType === "string" ? block.mimeType
    : (attachment && typeof attachment.mediaType === "string" ? attachment.mediaType
      : (typeof block.mediaType === "string" ? block.mediaType : "image/png"));
  const name = attachment && typeof attachment.name === "string" ? attachment.name : undefined;
  const rawId = attachment && typeof attachment.attachmentId === "string" ? attachment.attachmentId : "";
  const hash = rawId.startsWith("sha256:") ? rawId.slice("sha256:".length) : "";
  if (attachmentRoot && /^[0-9a-f]{64}$/.test(hash)) {
    const objectPath = join(attachmentRoot, hash.slice(0, 2), hash);
    try {
      const buffer = await readFile(objectPath);
      return {
        type: "image",
        mimeType: mime,
        dataBase64: buffer.toString("base64"),
        ...(name ? { name } : {}),
      };
    } catch {
      // 对象缺失/不可读：降级占位（设计 §8.3）。
    }
  }
  return { type: "image", mimeType: mime, ...(name ? { name } : {}) };
}

/** dsh content blocks → hub 可渲染 parts（text/thinking/image）。 */
async function toHubParts(blocks: unknown[], attachmentRoot: string | undefined): Promise<unknown[]> {
  const parts: unknown[] = [];
  for (const block of blocks) {
    if (!isRecord(block) || typeof block.type !== "string") continue;
    if (block.type === "text" && typeof block.text === "string") {
      parts.push({ type: "text", text: block.text });
    } else if (block.type === "reasoning" && typeof block.text === "string") {
      parts.push({ type: "thinking", thinking: block.text });
    } else if (block.type === "image") {
      parts.push(await resolveImagePart(block, attachmentRoot));
    }
  }
  return parts;
}
