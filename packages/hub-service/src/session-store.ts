import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type {
  CanonicalEntry,
  FileContentResponse,
  SessionFilesResponse,
  SessionMeta,
  SubagentSummary,
  SubagentTranscriptResponse,
  SyncRequest,
} from "@pi-agent-hub/protocol";
import { encodeSessionDir, readSessionFile, serializeSession, sessionFileName, timestampMs, validateEntries } from "@pi-agent-hub/pi-session";
import type { SessionRow, Store } from "./db.js";
import {
  buildFileTree,
  CONTENT_READ_TOOLS,
  CONTENT_WRITE_TOOLS,
  MAX_CONTENT_BYTES,
  serializeNode,
  resolveRelative,
} from "./file-tree.js";
import type { FileTreeScan } from "./file-tree.js";

export interface UploadRecord {
  uploadId: string;
  hubSessionId: string;
  kind: string;
  mode: "full" | "delta";
  since?: number;
  encoding: "ndjson+gzip";
  tmpPath: string;
  expiresAt: number;
  maxBytes: number;
  state: "open" | "ready" | "committed" | "failed";
  bytes: number;
}

export interface SessionSummary {
  id: string;
  hostId: string;
  agentId: string;
  nativeId: string;
  cwd: string;
  title: string | null;
  createdAt: number;
  updatedAt: number;
  lastTimestamp: number | null;
  lastEntryId: string | null;
  entryCount: number;
  bytes: number;
  state: string;
}

export class SessionStore {
  constructor(
    private readonly store: Store,
    private readonly dataDir: string,
  ) {}

  private readonly uploads = new Map<string, UploadRecord>();
  private readonly uploadsDir = "uploads";

  getUpload(uploadId: string): UploadRecord | undefined {
    return this.uploads.get(uploadId);
  }

  createUpload(input: {
    hubSessionId: string;
    kind: string;
    mode: "full" | "delta";
    since?: number;
    encoding: "ndjson+gzip";
  }): UploadRecord {
    const uploadId = `upl_${randomBytes(12).toString("base64url")}`;
    const record: UploadRecord = {
      uploadId,
      hubSessionId: input.hubSessionId,
      kind: input.kind,
      mode: input.mode,
      since: input.since,
      encoding: input.encoding,
      tmpPath: join(this.dataDir, this.uploadsDir, uploadId),
      expiresAt: Date.now() + 60 * 60 * 1000,
      maxBytes: 128 * 1024 * 1024,
      state: "open",
      bytes: 0,
    };
    this.uploads.set(uploadId, record);
    return record;
  }

  setUploadReady(uploadId: string, bytes: number): void {
    const record = this.uploads.get(uploadId);
    if (record) {
      record.bytes = bytes;
      record.state = "ready";
    }
  }

  async removeUpload(uploadId: string): Promise<void> {
    const record = this.uploads.get(uploadId);
    this.uploads.delete(uploadId);
    if (record?.tmpPath) await rm(record.tmpPath, { force: true }).catch(() => undefined);
  }

  hubSessionId(hostId: string, agentId: string, nativeId: string): string {
    const digest = createHash("sha256").update(`${hostId}\0${agentId}\0${nativeId}`).digest("base64url");
    return `hs_${digest.slice(0, 26).toLowerCase()}`;
  }

  summary(row: SessionRow): SessionSummary {
    return {
      id: row.id,
      hostId: row.host_id,
      agentId: row.agent_id,
      nativeId: row.native_id,
      cwd: row.cwd,
      title: row.title,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      lastTimestamp: row.last_timestamp,
      lastEntryId: row.last_entry_id,
      entryCount: row.entry_count,
      bytes: row.bytes,
      state: row.state,
    };
  }

  async sync(row: SessionRow, request: SyncRequest): Promise<{ merged: number; skipped: number; lastTimestamp: number; lastEntryId: string; entryCount: number }> {
    const entries = request.entries ?? [];
    const existingPath = row.native_path;
    const path = existingPath ?? this.pathFor(row, request.session);
    const previous = existingPath ? (await readSessionFile(existingPath).catch(() => undefined)) : undefined;
    const header = { type: "session" as const, version: 3, id: row.id, timestamp: new Date(request.session.createdAt).toISOString(), cwd: request.session.cwd };
    let fresh: CanonicalEntry[];

    if (request.mode === "full") {
      const errors = validateEntries(entries);
      if (errors.length > 0) throw new Error(errors[0]);
      fresh = entries;
      const tmp = `${path}.tmp-${process.pid}`;
      await mkdir(dirname(path), { recursive: true });
      await writeFile(tmp, serializeSession(header, fresh), "utf8");
      await rename(tmp, path);
    } else {
      if (entries.some((entry) => Number.isNaN(Date.parse(entry.timestamp)))) {
        throw new Error("invalid entry timestamp");
      }
      const existingIds = new Set(previous?.entries.map((entry) => entry.id) ?? []);
      fresh = entries.filter((entry) => !existingIds.has(entry.id));
      await mkdir(dirname(path), { recursive: true });
      if (!previous) {
        await writeFile(path, serializeSession(header, fresh), "utf8");
      } else {
        const text = fresh.map((entry) => JSON.stringify(entry)).join("\n");
        if (text) await writeFile(path, text + "\n", { flag: "a", encoding: "utf8" });
      }
    }

    const all = await readSessionFile(path);
    const last = all.entries[all.entries.length - 1];
    const info = await stat(path);
    const updated: SessionRow = {
      ...row,
      native_path: path,
      cwd: request.session.cwd,
      title: request.session.title ?? row.title,
      updated_at: request.session.updatedAt,
      last_timestamp: last ? timestampMs(last) : null,
      last_entry_id: last?.id ?? null,
      entry_count: all.entries.length,
      bytes: info.size,
    };
    this.store.upsertSession(updated);
    return {
      merged: fresh.length,
      skipped: entries.length - fresh.length,
      lastTimestamp: updated.last_timestamp ?? 0,
      lastEntryId: updated.last_entry_id ?? "",
      entryCount: updated.entry_count,
    };
  }

  private pathFor(row: SessionRow, meta: SessionMeta): string {
    const now = new Date(meta.createdAt || Date.now()).toISOString();
    return join(this.dataDir, "agent", "sessions", encodeSessionDir(meta.cwd), sessionFileName(now, row.id));
  }

  async transcript(id: string, tail: number, before?: number): Promise<{ items: unknown[]; hasMore: boolean; oldestSeq: number; newestSeq: number; lastTimestamp: number | null; unavailable: boolean }> {
    const row = this.store.getSession(id);
    if (!row?.native_path) return { items: [], hasMore: false, oldestSeq: 0, newestSeq: 0, lastTimestamp: null, unavailable: false };
    // 镜像文件缺失（如宿主会话目录被清理/未重同步）时返回 unavailable，由路由映射为 404，避免 500
    const parsed = await readSessionFile(row.native_path).catch(() => null);
    if (!parsed) return { items: [], hasMore: false, oldestSeq: 0, newestSeq: 0, lastTimestamp: row.last_timestamp, unavailable: true };
    const items = parsed.entries.map((entry, index) => toTranscriptItem(entry, index + 1));
    const filtered = before ? items.filter((item) => item.seq < before) : items;
    const sliced = filtered.slice(-tail);
    return {
      items: sliced,
      hasMore: filtered.length > sliced.length,
      oldestSeq: sliced[0]?.seq ?? 0,
      newestSeq: sliced[sliced.length - 1]?.seq ?? 0,
      lastTimestamp: row.last_timestamp,
      unavailable: false,
    };
  }

  async readEntry(id: string, seq: number): Promise<CanonicalEntry | undefined> {
    const row = this.store.getSession(id);
    if (!row?.native_path) return undefined;
    const parsed = await readSessionFile(row.native_path).catch(() => null);
    if (!parsed) return undefined;
    return parsed.entries[seq - 1];
  }

  /** 读取会话镜像条目；镜像缺失时返回 null（路由映射为 content_unavailable），无镜像路径返回空数组。 */
  async readMirrorEntries(id: string): Promise<CanonicalEntry[] | null> {
    const row = this.store.getSession(id);
    if (!row?.native_path) return [];
    const parsed = await readSessionFile(row.native_path).catch(() => null);
    if (!parsed) return null;
    return parsed.entries;
  }

  /** 202：推导会话项目虚拟文件树（FR-202-008~010）。 */
  async scanFileTree(id: string): Promise<(SessionFilesResponse & { scan: FileTreeScan }) | null> {
    const row = this.store.getSession(id);
    const entries = await this.readMirrorEntries(id);
    if (entries === null || !row) return null;
    const scan = buildFileTree(entries, row.cwd);
    const contentKeys = this.collectContentKeys(entries, row.cwd);
    for (const [key, node] of scan.fileIndex) {
      if (contentKeys.has(key)) node.hasContent = true;
    }
    return {
      cwd: row.cwd,
      root: serializeNode(scan.root),
      truncated: scan.truncated,
      pathCount: scan.pathCount,
      scan,
    };
  }

  /** 202：读取虚拟文件内容，write 输入 → read 结果 → 无内容三级回退（FR-202-011/012）。 */
  async readFileContent(id: string, requestedPath: string): Promise<FileContentResponse | null> {
    const row = this.store.getSession(id);
    const entries = await this.readMirrorEntries(id);
    if (entries === null || !row) return null;
    const rel = resolveRelative(requestedPath, row.cwd);
    if (!rel) return { path: requestedPath, available: false, reason: "no_mirror_content" };
    for (let i = entries.length - 1; i >= 0; i--) {
      const call = toolCallOf(entries[i]!, CONTENT_WRITE_TOOLS);
      if (call && this.callPath(call) === rel && typeof call.args.content === "string") {
        const content = call.args.content;
        return {
          path: rel,
          available: true,
          source: "write_input",
          toolName: call.name,
          entrySeq: i + 1,
          content: content.slice(0, MAX_CONTENT_BYTES),
          truncated: content.length > MAX_CONTENT_BYTES,
        };
      }
    }
    for (let i = entries.length - 1; i >= 0; i--) {
      const call = toolCallOf(entries[i]!, CONTENT_READ_TOOLS);
      if (!call || this.callPath(call) !== rel) continue;
      const callId = typeof call.part.id === "string" ? call.part.id : undefined;
      const result = this.findToolResult(entries, i, callId, call.name);
      if (result) {
        return {
          path: rel,
          available: true,
          source: "read_result",
          toolName: call.name,
          entrySeq: result.seq,
          content: result.preview.slice(0, MAX_CONTENT_BYTES),
          truncated: result.preview.length > MAX_CONTENT_BYTES,
        };
      }
    }
    return { path: rel, available: false, reason: "no_mirror_content" };
  }

  /** 202：子 agent 调用列表（FR-202-013）。 */
  async listSubagents(id: string): Promise<SubagentSummary[] | null> {
    const entries = await this.readMirrorEntries(id);
    if (entries === null) return null;
    const groups = new Map<string, SubagentSummary & { order: number }>();
    entries.forEach((entry, index) => {
      const marker = subagentMarkerOf(entry);
      if (!marker) return;
      const ts = timestampMs(entry);
      const existing = groups.get(marker.parentToolCallId);
      if (existing) {
        existing.markerCount += 1;
        existing.lastTs = existing.lastTs === null ? ts : Math.max(existing.lastTs, ts);
        return;
      }
      groups.set(marker.parentToolCallId, {
        subagentId: marker.parentToolCallId,
        agentName: marker.agentName,
        markerCount: 1,
        firstTs: ts,
        lastTs: ts,
        description: null,
        order: index,
      });
    });
    for (const entry of entries) {
      if (entry.type !== "message" || !isRecord(entry.message) || !Array.isArray(entry.message.content)) continue;
      for (const part of entry.message.content) {
        if (!isRecord(part) || part.type !== "toolCall") continue;
        const name = String(part.name ?? "").toLocaleLowerCase();
        if (name !== "task" && name !== "subagent" && name !== "subtask") continue;
        const args = isRecord(part.arguments) ? part.arguments : isRecord(part.input) ? part.input : undefined;
        const callId = typeof part.id === "string" ? part.id : "";
        const group = groups.get(callId);
        if (group && group.description === null && args && typeof args.description === "string") {
          group.description = args.description;
        }
      }
    }
    return [...groups.values()]
      .sort((a, b) => a.order - b.order)
      .map(({ order: _order, ...summary }) => summary);
  }

  /** 202：单次子 agent 调用的 transcript（FR-202-014~016）。 */
  async subagentTranscript(id: string, subagentId: string): Promise<Omit<SubagentTranscriptResponse, "items"> & { items: TranscriptItemView[] } | { notFound: true } | null> {
    const entries = await this.readMirrorEntries(id);
    if (entries === null) return null;
    const markerData: Array<{ index: number; parentToolCallId: string; aMessageId: string }> = [];
    const owned = new Set<number>();
    entries.forEach((entry, index) => {
      const marker = subagentMarkerOf(entry);
      if (!marker) return;
      markerData.push({ index, parentToolCallId: marker.parentToolCallId, aMessageId: marker.aMessageId });
      if (marker.parentToolCallId === subagentId) owned.add(index);
    });
    if (owned.size === 0) return { notFound: true };
    // 段边界（真实镜像数据验证）：marker 段在下一个全局 marker 处结束；
    // 最后一个 marker 的段延伸到下一条父会话 user 消息（不含），无 user 消息则到文件末尾。
    const nextUserAfter = (from: number): number => {
      for (let i = from + 1; i < entries.length; i++) {
        const entry = entries[i]!;
        if (entry.type === "message" && isRecord(entry.message) && entry.message.role === "user") return i;
      }
      return entries.length;
    };
    const chosen = new Set<number>();
    for (let m = 0; m < markerData.length; m++) {
      const marker = markerData[m]!;
      const end = m + 1 < markerData.length ? markerData[m + 1]!.index : nextUserAfter(marker.index);
      if (!owned.has(marker.index)) continue;
      for (let i = marker.index + 1; i < end; i++) chosen.add(i);
    }
    const seenIds = new Set<string>();
    const items = [...chosen]
      .sort((a, b) => a - b)
      .filter((index) => {
        const entry = entries[index]!;
        if (seenIds.has(entry.id)) return false;
        seenIds.add(entry.id);
        return true;
      })
      .map((index) => toTranscriptItem(entries[index]!, index + 1));
    return { subagentId, items, count: items.length };
  }

  private collectContentKeys(entries: readonly CanonicalEntry[], cwd: string): Set<string> {
    const keys = new Set<string>();
    for (const entry of entries) {
      for (const toolSet of [CONTENT_WRITE_TOOLS, CONTENT_READ_TOOLS]) {
        const call = toolCallOf(entry, toolSet);
        if (!call) continue;
        const raw = this.callPath(call);
        if (raw) {
          const rel = resolveRelative(raw, cwd);
          if (rel) keys.add(rel);
        }
      }
    }
    return keys;
  }

  private callPath(call: { args: Record<string, unknown> }): string | null {
    const value = call.args.path ?? call.args.file_path ?? call.args.filePath;
    return typeof value === "string" ? value : null;
  }

  private findToolResult(
    entries: readonly CanonicalEntry[],
    afterIndex: number,
    callId: string | undefined,
    toolName: string,
  ): { preview: string; seq: number } | null {
    for (let i = afterIndex + 1; i < entries.length; i++) {
      const entry = entries[i]!;
      if (entry.type !== "message" || !isRecord(entry.message) || entry.message.role !== "toolResult") continue;
      const message = entry.message;
      const idMatch = !callId || message.toolCallId === callId;
      const nameMatch = !toolName || message.toolName === toolName;
      if (idMatch && nameMatch) {
        const preview = toolResultPreview(message.content);
        if (preview) return { preview, seq: i + 1 };
      }
    }
    return null;
  }
}

/** pi-desktop 迁移器写入的子 agent 标记 custom 条目类型（202 需求）。 */
export const SUBAGENT_CUSTOM_TYPE = "pi-desktop-import:subagent";

export interface TranscriptItemView {
  seq: number;
  entryId: string;
  type: string;
  ts: number;
  role?: string;
  blocks: unknown[];
}

function toTranscriptItem(entry: CanonicalEntry, seq: number): TranscriptItemView {
  const ts = timestampMs(entry);
  if (entry.type === "message" && isRecord(entry.message)) {
    const message = entry.message;
    const role = typeof message.role === "string" ? message.role : "assistant";
    const blocks: unknown[] = [];
    const content = message.content;
    if (typeof content === "string") blocks.push({ kind: "text", text: content, markdown: true });
    else if (Array.isArray(content)) {
      for (const part of content) {
        if (!isRecord(part)) continue;
        if (part.type === "text" && typeof part.text === "string") blocks.push({ kind: "text", text: part.text, markdown: true });
        else if (part.type === "thinking" && typeof part.thinking === "string") blocks.push({ kind: "thinking", text: part.thinking });
        else if (part.type === "toolCall") {
          // pi v3 原生参数在 `arguments`，早期实现只读 `input` 导致参数恒丢失（FR-202-001）。
          blocks.push({ kind: "toolCall", callId: String(part.id ?? ""), name: String(part.name ?? ""), input: part.input ?? part.arguments ?? null, status: "ok" });
        } else if (part.type === "image" && typeof part.mimeType === "string") blocks.push({ kind: "image", mime: part.mimeType, url: "" });
      }
    }
    if (role === "toolResult") {
      // 工具结果结构化输出：保留 callId/toolName/isError 与文本 preview（FR-202-002）。
      const preview = toolResultPreview(content);
      blocks.length = 0;
      blocks.push({
        kind: "toolResult",
        callId: typeof message.toolCallId === "string" ? message.toolCallId : undefined,
        name: typeof message.toolName === "string" ? message.toolName : "",
        ok: message.isError !== true,
        preview,
        bytes: Buffer.byteLength(preview),
        truncated: false,
      });
      return { seq, entryId: entry.id, type: entry.type, ts, role: "tool", blocks };
    }
    if (role === "bashExecution") {
      return { seq, entryId: entry.id, type: entry.type, ts, role: "system", blocks: [{ kind: "bash", command: String(message.command ?? ""), output: String(message.output ?? ""), exitCode: typeof message.exitCode === "number" ? message.exitCode : undefined }] };
    }
    return { seq, entryId: entry.id, type: entry.type, ts, role, blocks };
  }
  if (entry.type === "compaction" || entry.type === "branch_summary") {
    return { seq, entryId: entry.id, type: entry.type, ts, role: "meta", blocks: [{ kind: "summary", summaryType: entry.type === "compaction" ? "compaction" : "branch", text: String(entry.summary ?? ""), tokensBefore: typeof entry.tokensBefore === "number" ? entry.tokensBefore : undefined }] };
  }
  if (entry.type === "custom") {
    // 子 agent 标记结构化（FR-202-003）；其余 custom 保留 meta 降级但 label 带 customType。
    if (entry.customType === SUBAGENT_CUSTOM_TYPE && isRecord(entry.data)) {
      return {
        seq, entryId: entry.id, type: entry.type, ts, role: "meta",
        blocks: [{
          kind: "subagentMarker",
          agentName: String(entry.data.agentName ?? ""),
          parentToolCallId: String(entry.data.parentToolCallId ?? ""),
          aMessageId: String(entry.data.aMessageId ?? ""),
        }],
      };
    }
    return { seq, entryId: entry.id, type: entry.type, ts, role: "meta", blocks: [{ kind: "meta", label: String(entry.customType ?? "custom") }] };
  }
  return { seq, entryId: entry.id, type: entry.type, ts, role: "meta", blocks: [{ kind: "meta", label: entry.type }] };
}

/** 从 toolResult 消息 content 提取文本 preview（字符串或 text part 数组）。 */
function toolResultPreview(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((part): part is Record<string, unknown> => isRecord(part) && part.type === "text" && typeof part.text === "string")
      .map((part) => String(part.text))
      .join("\n");
  }
  return "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

interface ToolCallMatch {
  name: string;
  part: Record<string, unknown>;
  args: Record<string, unknown>;
}

/** 提取条目内首个命中工具集合的 toolCall（兼容 arguments/input 两种参数字段）。 */
function toolCallOf(entry: CanonicalEntry, names: ReadonlySet<string>): ToolCallMatch | null {
  if (entry.type !== "message" || !isRecord(entry.message) || !Array.isArray(entry.message.content)) return null;
  for (const part of entry.message.content) {
    if (!isRecord(part) || part.type !== "toolCall") continue;
    const name = String(part.name ?? "").toLocaleLowerCase();
    if (!names.has(name)) continue;
    const args = isRecord(part.arguments) ? part.arguments : isRecord(part.input) ? part.input : null;
    if (args) return { name: String(part.name ?? ""), part, args };
  }
  return null;
}

/** 识别子 agent marker 条目并返回其数据。 */
function subagentMarkerOf(entry: CanonicalEntry): { agentName: string; parentToolCallId: string; aMessageId: string } | null {
  if (entry.type !== "custom" || entry.customType !== SUBAGENT_CUSTOM_TYPE || !isRecord(entry.data)) return null;
  const parentToolCallId = entry.data.parentToolCallId;
  if (typeof parentToolCallId !== "string" || parentToolCallId.length === 0) return null;
  return {
    agentName: String(entry.data.agentName ?? ""),
    parentToolCallId,
    aMessageId: String(entry.data.aMessageId ?? ""),
  };
}
