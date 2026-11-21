import { copyFile, open, readdir, readFile, stat, writeFile } from "node:fs/promises";
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
  isSessionEntry,
  isSessionHeader,
  linearize,
  readSessionFile,
  serializeSession,
  sessionFilePath,
  sha256,
  timestampMs,
  validateEntries,
  type SessionHeader,
} from "@pi-agent-hub/pi-session";
import { promptPiSession, queryModelInfo } from "./pi-rpc.js";

interface PiPluginOptions {
  agentDir?: string;
  piCommand?: string;
}

interface PiInstance {
  instanceId: string;
  displayName: string;
  homeDir: string;
}

/**
 * list_sessions 只读必要区间，不整文件解析，并按 (size, mtime) 缓存扫描结果。
 *
 * 本地实测会话目录 712MB、单文件最大 75MB：原先每次 list_sessions 都整文件
 * readSessionFile + 逐行 JSON.parse，30s 一轮会把 700MB 重读一遍，
 * 直接表现为日志中反复出现的 `plugin request timeout: list_sessions`。
 * 头部取 header/cwd，尾部取最后一条 entry 的时间戳（与 read_session 的
 * meta.updatedAt 同源，hub 才能用 updatedAt 相等判定 skipped），标题按需顺序扫描。
 */
const HEAD_BYTES = 128 * 1024;
const TAIL_BYTES = 64 * 1024;
/** 尾部找不到 entry 时逐级扩大窗口（单条 entry 可能比初始窗口更大）。 */
const TAIL_GROWTH = 4;
/** 顺序扫描找 session_info 时单行缓冲上限：超长行（巨型消息）不可能含 session_info。 */
const MAX_LINE_CHARS = 1024 * 1024;

interface ScannedSession {
  header: SessionHeader;
  title?: string;
  updatedAt?: number;
}

interface CachedScan {
  size: number;
  mtimeMs: number;
  value: ScannedSession;
}

async function scanSessionFile(file: string, size: number): Promise<ScannedSession | undefined> {
  const handle = await open(file, "r");
  try {
    const headLength = Math.min(size, HEAD_BYTES);
    const head = Buffer.alloc(headLength);
    if (headLength > 0) await handle.read(head, 0, headLength, 0);
    // 截断读取时边界那一行可能不完整（含多字节字符被切），直接丢弃。
    const headLines = splitLines(head.toString("utf8"), size > headLength ? "last" : "none");
    const headRecords = headLines.map(parseLine);
    const header = headRecords.find(isSessionHeader);
    if (!header) return undefined;

    let tailLines: string[] | undefined;
    let updatedAt: number | undefined;
    if (size <= HEAD_BYTES) {
      updatedAt = lastEntryTimestamp(headLines);
    } else {
      let window = Math.min(size, TAIL_BYTES);
      for (;;) {
        const start = size - window;
        const tail = Buffer.alloc(window);
        await handle.read(tail, 0, window, start);
        tailLines = splitLines(tail.toString("utf8"), start > 0 ? "first" : "none");
        updatedAt = lastEntryTimestamp(tailLines);
        if (updatedAt !== undefined || start === 0) break;
        window = Math.min(size, window * TAIL_GROWTH);
      }
    }

    // pi 把重命名写成追加的 session_info（文件末尾），因此标题先看尾部再看头部；
    // 两者都没有时顺序扫描到第一条 session_info（多数会话的该条在头部窗口之外）。
    let title = (tailLines ? lastSessionInfoName(tailLines) : undefined)
      ?? lastSessionInfoName(headLines);
    if (title === undefined) title = await findSessionInfoName(handle, size);
    title ??= firstUserMessageTitle(headRecords);
    return { header, title, updatedAt };
  } finally {
    await handle.close();
  }
}

/** 分块顺序扫描，遇到第一条 session_info 即返回（只做一次，之后走 mtime 缓存）。 */
async function findSessionInfoName(
  handle: import("node:fs/promises").FileHandle,
  size: number,
): Promise<string | undefined> {
  const buffer = Buffer.alloc(HEAD_BYTES);
  const decoder = new TextDecoder("utf-8");
  let position = 0;
  let partial = "";
  while (position < size) {
    const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, size - position), position);
    if (bytesRead <= 0) break;
    position += bytesRead;
    partial += decoder.decode(buffer.subarray(0, bytesRead), { stream: true });
    let newline = partial.indexOf("\n");
    while (newline >= 0) {
      const name = sessionInfoNameOfLine(partial.slice(0, newline));
      if (name !== undefined) return name;
      partial = partial.slice(newline + 1);
      newline = partial.indexOf("\n");
    }
    if (partial.length > MAX_LINE_CHARS) partial = "";
  }
  return sessionInfoNameOfLine(partial);
}

/** 快路径：不含 session_info 字样的行直接跳过，避免 JSON.parse 长行。 */
function sessionInfoNameOfLine(line: string): string | undefined {
  if (!line.includes("\"session_info\"")) return undefined;
  const value = parseLine(line);
  if (isRecord(value) && value.type === "session_info" && typeof value.name === "string") return value.name;
  return undefined;
}

function splitLines(text: string, dropEdge: "none" | "first" | "last"): string[] {
  const lines = text.split("\n");
  if (dropEdge === "first" && lines.length > 0) lines.shift();
  if (dropEdge === "last" && lines.length > 0) lines.pop();
  return lines;
}

function parseLine(line: string): unknown {
  const raw = line.trim();
  if (!raw) return undefined;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
}

/** 从尾部行集里倒序找最后一条合法 entry 的时间戳。 */
function lastEntryTimestamp(lines: readonly string[]): number | undefined {
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const value = parseLine(lines[index] ?? "");
    if (!isSessionEntry(value)) continue;
    const ms = Date.parse(value.timestamp);
    if (!Number.isNaN(ms)) return ms;
  }
  return undefined;
}

/** 取最后一条 session_info 的 name（重命名取最新名字）。 */
function lastSessionInfoName(lines: readonly string[]): string | undefined {
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const value = parseLine(lines[index] ?? "");
    if (isRecord(value) && value.type === "session_info" && typeof value.name === "string") return value.name;
  }
  return undefined;
}

/** 标题兜底规则：首条 content 为字符串的 user 消息前 80 字符。 */
function firstUserMessageTitle(records: readonly unknown[]): string | undefined {
  for (const record of records) {
    if (!isRecord(record) || record.type !== "message" || !isRecord(record.message)) continue;
    const message = record.message;
    if (message.role !== "user") continue;
    if (typeof message.content === "string") return message.content.slice(0, 80);
  }
  return undefined;
}

/** 标题规则（session_info.name 优先，其次首条 user 消息）。窗口内找不到则留空。 */
function titleOfRecords(records: readonly unknown[]): string | undefined {
  for (const record of records) {
    if (isRecord(record) && record.type === "session_info" && typeof record.name === "string") return record.name;
  }
  return firstUserMessageTitle(records);
}

export class PiPlugin {
  private options: PiPluginOptions = {};
  private instance: PiInstance | undefined;
  private workDir = "";
  /** 007：每个 nativeId 最近一次本插件成功 prompt 的完成时刻，用于 idle 判定排除自己的写入。 */
  private lastPromptAt = new Map<string, number>();
  /** list_sessions 扫描缓存：(size, mtime) 未变则复用，避免每 30s 重扫全部会话文件。 */
  private readonly sessionScans = new Map<string, CachedScan>();

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
    return { pluginVersion: "0.1.2", protocolVersion: "1.0", capabilities: this.capabilities };
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
    const seen = new Set<string>();
    for (const dir of projectDirs) {
      let files: string[];
      try {
        files = (await readdir(dir)).filter((file) => file.endsWith(".jsonl")).map((file) => join(dir, file));
      } catch {
        continue;
      }
      for (const file of files) {
        try {
          const info = await stat(file);
          seen.add(file);
          const scanned = await this.scanCached(file, info.size, info.mtimeMs);
          if (!scanned) continue;
          sessions.push({
            nativeId: scanned.header.id,
            nativePath: file,
            updatedAt: scanned.updatedAt ?? info.mtimeMs,
            title: scanned.title,
            cwd: scanned.header.cwd,
            state: "idle",
          });
        } catch {
          // skip unreadable session files; they are reported by the daemon log
        }
      }
    }
    sessions.sort((a, b) => b.updatedAt - a.updatedAt);
    // 清理已删除会话的缓存条目（目录长期使用后文件会持续增长）。
    for (const cachedPath of this.sessionScans.keys()) {
      if (!seen.has(cachedPath)) this.sessionScans.delete(cachedPath);
    }
    return { sessions };
  }

  /** 按 (size, mtime) 复用扫描结果；文件未变时 list_sessions 几乎零 I/O。 */
  private async scanCached(file: string, size: number, mtimeMs: number): Promise<ScannedSession | undefined> {
    const cached = this.sessionScans.get(file);
    if (cached && cached.size === size && cached.mtimeMs === mtimeMs) return cached.value;
    const value = await scanSessionFile(file, size);
    if (value) this.sessionScans.set(file, { size, mtimeMs, value });
    else this.sessionScans.delete(file);
    return value;
  }

  private titleOf(entries: readonly CanonicalEntry[]): string | undefined {
    return titleOfRecords(entries);
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
    let mode: "delta" | "full" = since === undefined ? "full" : "delta";

    let entries = parsed.entries;
    if (since !== undefined) {
      const lastIndex = lastEntryId ? entries.findIndex((entry) => entry.id === lastEntryId) : -1;
      // pi 会话为树（v3 支持 fork/分支）。若增量片段头不再续接已知 leaf（lastEntryId 下一条的
      // parentId ≠ leaf），说明源中发生了分支续写，delta 会破坏镜像单链 → 回退为全量线性化重同步。
      if (lastIndex >= 0 && lastIndex + 1 < entries.length) {
        const leaf = entries[lastIndex];
        const next = entries[lastIndex + 1];
        if (next.parentId !== leaf.id && timestampMs(next) > since) mode = "full";
      }
      entries = entries.filter((entry, index) => timestampMs(entry) > since || (lastIndex >= 0 && index > lastIndex));
    }

    const output = mode === "full" ? linearize(entries) : entries;
    if (mode === "full") {
      // full 目标为单链镜像，针对线性化后的链做校验（pi 源树天然未必单链）。
      const errors = validateEntries(output);
      if (errors.length > 0 && output.length > 0) {
        throw new PluginError("invalid_output", `invalid pi entry chain: ${errors[0]}`);
      }
    }

    const meta = {
      cwd: parsed.header.cwd,
      title: this.titleOf(parsed.entries),
      createdAt: Date.parse(parsed.header.timestamp),
      updatedAt: output.length > 0 ? timestampMs(output[output.length - 1]!) : Date.parse(parsed.header.timestamp),
      state: "idle" as const,
    };

    const serialized = output.map((entry) => JSON.stringify(entry)).join("\n");
    if (output.length > 2_000 || serialized.length > 4 * 1024 * 1024) {
      await ensureDir(join(this.workDir, "native"));
      const tmp = join(this.workDir, "native", `${nativeId}.ndjson`);
      await writeFile(tmp, serialized + (output.length > 0 ? "\n" : ""), "utf8");
      return {
        mode,
        since,
        entriesPath: tmp,
        sha256: sha256(serialized),
        count: output.length,
        meta,
      };
    }

    return {
      mode,
      since,
      entries: output,
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
        images: request.images?.map((image) => ({ mime: image.mime ?? "image/png", path: image.path ?? "" })).filter((image) => image.path !== ""),
        model: request.model ?? null,
        thinkingLevel: request.thinkingLevel ?? null,
      });
      this.lastPromptAt.set(request.nativeId, Date.now());
      return { ok: true, state: "completed" };
    } catch (error) {
      throw new PluginError("agent_error", error instanceof Error ? error.message : String(error));
    }
  }

  /** 006：模型信息查询（get_available_models + get_available_thinking_levels + get_state，最小投影）。 */
  async getModelInfo(params: Record<string, unknown>): Promise<{
    agentId: string;
    models: Array<{ provider: string; modelId: string; name: string; reasoning: boolean; input: string[]; thinkingLevels: string[] }>;
    currentModel: { provider: string; modelId: string } | null;
    currentThinkingLevel: string | null;
  }> {
    const nativeId = typeof params.nativeId === "string" ? params.nativeId : "";
    const file = await this.findSessionPath(nativeId);
    const result = await queryModelInfo({
      command: this.options.piCommand ?? "pi",
      sessionPath: file,
      agentDir: this.agentDir(),
    });
    if (!this.instance) throw new PluginError("invalid_request", "plugin not initialized");
    return {
      agentId: this.instance.instanceId,
      models: result.models,
      currentModel: result.currentModel,
      currentThinkingLevel: result.currentThinkingLevel,
    };
  }

  /** 007：空闲检查（C-1 单写者）。区分「本插件上次 prompt」与「外部写入」：由外部写入的新 mtime 才判 busy。 */
  async checkIdle(params: Record<string, unknown>): Promise<{ idle: boolean }> {
    const nativeId = typeof params.nativeId === "string" ? params.nativeId : "";
    if (!nativeId) return { idle: true };
    try {
      const file = await this.findSessionPath(nativeId);
      const info = await stat(file);
      // 本插件从未写过：以 now-120s 为基线（新会话 mtime 在窗内视为外部活跃）；
      // 本插件写过：基线 = 上次 prompt 完成时刻，仅当外部写入的 mtime 晚于它才判 busy。
      const baseline = this.lastPromptAt.get(nativeId) ?? (Date.now() - 120_000);
      const busy = info.mtimeMs > baseline;
      return { idle: !busy };
    } catch {
      return { idle: true };
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
