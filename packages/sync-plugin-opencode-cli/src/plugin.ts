import { mkdir, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
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
import { PluginError, runCli } from "@pi-agent-hub/sync-plugin-sdk";
import { isRecord, linearize, timestampMs, validateEntries } from "@pi-agent-hub/pi-session";

/**
 * sync-plugin-opencode-cli：以「spawn opencode CLI」方式对接 opencode v2（≥2.3.0）。
 *
 * - 采集（list/read）：`opencode session list --format json` + `opencode session export <id>`
 * - 模型信息：`opencode models`（纯文本 providerID/id 列表投影；无 reasoning/thinking 元数据）
 * - 下发（007）：`opencode run --session <id> [--model] [--file] --format json -- <message>`
 * - 与 sync-plugin-opencode-serve（HTTP 对接常驻 server）形成 opencode 宿主的两套接入实现；
 *   本插件面向「不常驻 server、逐次 spawn CLI」的轻量接入，由 opencode CLI 自管连接（不复用外部 serve）。
 */
interface OpencodeCliOptions {
  openCommand?: string;
  /** CLI 工作目录（会话项目根；缺省用 daemon 提供 workDir 或 process cwd）。 */
  cwd?: string;
  /** 单条 CLI 超时 ms（deliver 覆盖为可配置）。 */
  timeoutMs?: number;
}

// opencode v2 SessionMessage.type 中作为对话内容外显的类型
const MESSAGE_TYPES = new Set(["user", "assistant", "system", "synthetic"]);

export class OpencodeCliPlugin {
  private options: OpencodeCliOptions = {};
  private instance: PluginInstance | undefined;
  private workDir = "";
  private cwd = process.cwd();

  private readonly capabilities: PluginCapabilities = {
    collect: true,
    deliver: true,
    import: false,
    losslessImport: false,
    exportNative: true,
    controlInterface: "cli",
    readStrategy: ["cli"],
    deliveryStrategy: ["cli"],
    largeReadMode: "temp-file",
    watch: false,
  };

  async initialize(params: PluginInitializeParams): Promise<PluginInitializeResult> {
    const config = isRecord(params.config.options) ? params.config.options : {};
    this.options = {
      openCommand: typeof config.openCommand === "string" ? config.openCommand : "opencode",
      cwd: typeof config.cwd === "string" ? config.cwd : undefined,
      timeoutMs: typeof config.timeoutMs === "number" ? config.timeoutMs : undefined,
    };
    this.cwd = this.options.cwd ?? homedir();
    this.instance = {
      instanceId: `opencode-cli-${Buffer.from(this.cwd || "default").toString("base64url").slice(0, 12)}`,
      displayName: params.config.instance?.name ?? "default",
      homeDir: "",
    };
    this.workDir = params.workDir;
    return { pluginVersion: "0.1.1", protocolVersion: "1.0", capabilities: this.capabilities };
  }

  async detect(): Promise<{ instances: PluginInstance[] }> {
    if (!this.instance) throw new PluginError("invalid_request", "plugin not initialized");
    return { instances: [this.instance] };
  }

  private command(): string {
    return this.options.openCommand ?? "opencode";
  }

  private timeout(defaultMs: number): number {
    return this.options.timeoutMs ?? defaultMs;
  }

  private async cli(args: string[], timeoutMs: number): Promise<string> {
    const result = await runCli(this.command(), args, {
      cwd: this.cwd,
      timeoutMs,
      maxBytes: 64 * 1024 * 1024,
    });
    if (result.truncated) {
      // 采集/导出依赖完整 JSON：被截断会解析失败或落盘损坏，必须显式失败而非静默返回坏数据。
      throw new PluginError("agent_error", `opencode ${args[0] ?? ""} output exceeded limit and was truncated`);
    }
    if (result.exitCode !== 0) {
      const tail = result.stderr.trim().slice(-500) || result.stdout.trim().slice(-500);
      throw new PluginError(
        "agent_error",
        `opencode ${args[0] ?? ""} exited ${result.exitCode}: ${tail}`,
      );
    }
    return result.stdout;
  }

  // ---------- 会话同步（CLI） ----------

  async listSessions(): Promise<{ sessions: NativeSessionMeta[] }> {
    const out = await this.cli(["session", "list", "--format", "json"], this.timeout(30_000));
    const parsed: unknown = JSON.parse(out);
    const sessions: NativeSessionMeta[] = [];
    for (const raw of Array.isArray(parsed) ? parsed : []) {
      if (!isRecord(raw)) continue;
      const id = typeof raw.id === "string" ? raw.id : "";
      if (!id) continue;
      const title = typeof raw.title === "string" && raw.title ? raw.title : undefined;
      const directory = typeof raw.directory === "string" && raw.directory ? raw.directory : undefined;
      const updated = pickNumber(raw.updated) ?? Date.now();
      sessions.push({ nativeId: id, updatedAt: updated, title, cwd: directory, state: "idle" });
    }
    const byId = new Map<string, number>();
    for (const s of sessions) byId.set(s.nativeId, (byId.get(s.nativeId) ?? 0) + 1);
    return { sessions: dedupeSessions(sessions, byId) };
  }

  async readSession(params: Record<string, unknown>): Promise<SessionChunk> {
    const nativeId = typeof params.nativeId === "string" ? params.nativeId : "";
    const since = typeof params.since === "number" ? params.since : undefined;
    if (!nativeId) throw new PluginError("invalid_request", "nativeId required");

    const out = await this.cli(["session", "export", nativeId], this.timeout(60_000));
    const doc = JSON.parse(out) as unknown;
    const info = isRecord(doc) && isRecord(doc.info) ? doc.info : {};
    const rawMessages = isRecord(doc) && Array.isArray(doc.messages) ? doc.messages : [];
    const loc = isRecord(info.location) ? info.location : {};
    const cwd = typeof loc.directory === "string" ? loc.directory
      : (typeof info.directory === "string" ? info.directory : "");
    const title = typeof info.title === "string" && info.title ? info.title : undefined;

    // 导出消息顺序即时间序（id/seq 升序），逐条归一 canonical（parentId=上一条）。
    const entries: CanonicalEntry[] = [];
    for (const raw of rawMessages) {
      if (!isRecord(raw)) continue;
      const rowType = typeof raw.type === "string" ? raw.type : "";
      if (!MESSAGE_TYPES.has(rowType)) continue;
      const id = typeof raw.id === "string" ? raw.id : `${nativeId}-${entries.length}`;
      const time = isRecord(raw.time) ? raw.time : {};
      const tsMs = pickNumber(time.created, raw.time_created, raw.timeCreated, raw.timestamp) ?? Date.now();
      const previous = entries[entries.length - 1];
      const role = rowType === "assistant" ? "assistant" : (rowType === "user" || rowType === "synthetic" ? "user" : "system");
      const content = rowType === "assistant"
        ? assistantContent(raw.content)
        : userContent(raw, rowType === "synthetic");
      entries.push({
        type: "message",
        id,
        parentId: previous?.id ?? null,
        timestamp: new Date(tsMs).toISOString(),
        message: { role, content: content ?? [], timestamp: tsMs },
      });
    }

    const filtered = since === undefined ? entries : entries.filter((entry) => timestampMs(entry) > since);
    if (since === undefined) {
      const errors = validateEntries(filtered);
      if (errors.length > 0 && filtered.length > 0) throw new PluginError("invalid_output", errors[0]!);
    }
    const updatedAt = entries.length > 0 ? timestampMs(entries[entries.length - 1]!) : Date.now();

    return {
      mode: since === undefined ? "full" : "delta",
      since,
      entries: since === undefined ? linearize(filtered) : filtered,
      meta: { cwd, title, createdAt: Date.now(), updatedAt, state: "idle" },
    };
  }

  // ---------- 模型信息（006，CLI 投影受限） ----------

  async getModelInfo(params: Record<string, unknown>): Promise<{
    agentId: string;
    models: Array<{ provider: string; modelId: string; name: string; reasoning: boolean; input: string[]; thinkingLevels: string[] }>;
    currentModel: { provider: string; modelId: string } | null;
    currentThinkingLevel: string | null;
  }> {
    void params;
    const out = await this.cli(["models"], this.timeout(30_000));
    const models: Array<{ provider: string; modelId: string; name: string; reasoning: boolean; input: string[]; thinkingLevels: string[] }> = [];
    for (const line of out.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const slash = trimmed.lastIndexOf("/");
      if (slash < 1) continue;
      const provider = trimmed.slice(0, slash);
      const modelId = trimmed.slice(slash + 1);
      if (!provider || !modelId) continue;
      models.push({
        provider,
        modelId,
        name: modelId,
        // opencode models 纯文本无 reasoning/input 元数据 → 保守投影 ⬜ 待真机改进
        reasoning: false,
        input: ["text"],
        thinkingLevels: ["off"],
      });
    }
    return {
      agentId: this.instance?.instanceId ?? "",
      models,
      currentModel: null,
      currentThinkingLevel: null,
    };
  }

  // ---------- 下发（007，CLI run） ----------

  async deliver(request: DeliverRequest): Promise<DeliverResult> {
    const args = ["run", "--session", request.nativeId, "--format", "json", "--thinking"];
    if (request.model) args.push("--model", `${request.model.provider}/${request.model.modelId}`);
    for (const image of request.images ?? []) {
      if (image.path) args.push("--file", image.path);
    }
    if (!request.message) throw new PluginError("invalid_request", "deliver message empty");
    // 消息作为单个 argv（-- 之后），保留换行/缩进/代码块；argv 直传无 shell 注入面。
    args.push("--", request.message);

    await this.cli(args, this.timeout(10 * 60_000));
    return { ok: true, state: "completed" };
  }

  // ---------- 空闲 / 导入 / 导出 ----------

  async checkIdle(params: Record<string, unknown>): Promise<{ idle: boolean }> {
    void params;
    // CLI 形态每次 deliver 都是同步阻塞的 run；无常驻状态可查，视为空闲。
    return { idle: true };
  }

  async importSession(_request: ImportRequest): Promise<ImportResult> {
    throw new PluginError("unsupported", "opencode-cli import not wired yet");
  }

  async exportNative(request: ExportNativeRequest): Promise<ExportNativeResult> {
    const out = await this.cli(["session", "export", request.nativeId], this.timeout(60_000));
    const dir = join(request.workDir, "native");
    await mkdir(dir, { recursive: true });
    const target = join(dir, `${request.nativeId}.json`);
    await writeFile(target, out, "utf8");
    const info = await stat(target);
    return {
      nativePath: target,
      format: "opencode-v2-export",
      sha256: await sha256Of(target),
      bytes: info.size,
    };
  }
}

/** user/synthetic 消息 → canonical parts（text + files 图片 data URI）。 */
function userContent(raw: Record<string, unknown>, synthetic: boolean): unknown[] {
  const parts: unknown[] = [];
  const text = typeof raw.text === "string" ? raw.text : "";
  if (text) {
    if (synthetic) parts.push({ type: "text", text, synthetic: true });
    else parts.push({ type: "text", text });
  }
  if (Array.isArray(raw.files)) {
    for (const file of raw.files) {
      if (!isRecord(file)) continue;
      const mimeType = typeof file.mime === "string" ? file.mime : "image/png";
      const data = typeof file.data === "string" ? file.data : "";
      if (data) parts.push({ type: "image", mimeType, dataBase64: data });
    }
  }
  return parts;
}

/** assistant 消息 content（text/reasoning/tool）→ canonical parts。 */
function assistantContent(content: unknown): unknown[] {
  const parts: unknown[] = [];
  if (!Array.isArray(content)) return parts;
  for (const block of content) {
    if (!isRecord(block)) continue;
    const type = typeof block.type === "string" ? block.type : "";
    if (type === "text" && typeof block.text === "string") parts.push({ type: "text", text: block.text });
    else if (type === "reasoning" && typeof block.text === "string") parts.push({ type: "thinking", thinking: block.text });
    else if (type === "tool") {
      const state = isRecord(block.state) ? block.state : {};
      parts.push({
        type: "toolCall",
        id: String(block.id ?? ""),
        name: String(block.name ?? ""),
        arguments: state.input ?? state.arguments ?? null,
      });
    }
  }
  return parts;
}

/** session list 输出可能含同 id 多条目（同 project 下重复行），按 updatedAt 去重保最新。 */
function dedupeSessions(sessions: NativeSessionMeta[], byId: Map<string, number>): NativeSessionMeta[] {
  const out: NativeSessionMeta[] = [];
  for (const session of sessions) {
    if ((byId.get(session.nativeId) ?? 0) > 1) {
      const existing = out.find((s) => s.nativeId === session.nativeId);
      if (existing) {
        if ((session.updatedAt ?? 0) >= (existing.updatedAt ?? 0)) {
          Object.assign(existing, session);
        }
        continue;
      }
    }
    out.push({ ...session });
  }
  return out.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
}

async function sha256Of(path: string): Promise<string> {
  const { createHash } = await import("node:crypto");
  const { createReadStream } = await import("node:fs");
  const hash = createHash("sha256");
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(path);
    stream.on("data", (chunk: string | Buffer) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve());
  });
  return hash.digest("hex");
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
