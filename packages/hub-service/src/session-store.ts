import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { CanonicalEntry, SessionMeta, SyncRequest } from "@pi-agent-hub/protocol";
import { encodeSessionDir, readSessionFile, serializeSession, sessionFileName, timestampMs, validateEntries } from "@pi-agent-hub/pi-session";
import type { SessionRow, Store } from "./db.js";

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
}

function toTranscriptItem(entry: CanonicalEntry, seq: number): { seq: number; entryId: string; type: string; ts: number; role?: string; blocks: unknown[] } {
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
        else if (part.type === "toolCall") blocks.push({ kind: "toolCall", callId: String(part.id ?? ""), name: String(part.name ?? ""), input: part.input, status: "ok" });
        else if (part.type === "image" && typeof part.mimeType === "string") blocks.push({ kind: "image", mime: part.mimeType, url: "" });
      }
    }
    if (role === "toolResult") {
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
  return { seq, entryId: entry.id, type: entry.type, ts, role: "meta", blocks: [{ kind: "meta", label: entry.type }] };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
