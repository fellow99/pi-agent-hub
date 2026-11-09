import { createHash } from "node:crypto";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { CanonicalEntry, SessionMeta, SyncRequest } from "@pi-agent-hub/protocol";
import { encodeSessionDir, readSessionFile, serializeSession, sessionFileName, timestampMs, validateEntries } from "@pi-agent-hub/pi-session";
import type { SessionRow, Store } from "./db.js";

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

  async transcript(id: string, tail: number, before?: number): Promise<{ items: unknown[]; hasMore: boolean; oldestSeq: number; newestSeq: number; lastTimestamp: number | null }> {
    const row = this.store.getSession(id);
    if (!row?.native_path) return { items: [], hasMore: false, oldestSeq: 0, newestSeq: 0, lastTimestamp: null };
    const parsed = await readSessionFile(row.native_path);
    const items = parsed.entries.map((entry, index) => toTranscriptItem(entry, index + 1));
    const filtered = before ? items.filter((item) => item.seq < before) : items;
    const sliced = filtered.slice(-tail);
    return {
      items: sliced,
      hasMore: filtered.length > sliced.length,
      oldestSeq: sliced[0]?.seq ?? 0,
      newestSeq: sliced[sliced.length - 1]?.seq ?? 0,
      lastTimestamp: row.last_timestamp,
    };
  }

  async readEntry(id: string, seq: number): Promise<CanonicalEntry | undefined> {
    const row = this.store.getSession(id);
    if (!row?.native_path) return undefined;
    const parsed = await readSessionFile(row.native_path);
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
