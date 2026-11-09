import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { CanonicalEntry, SessionMeta } from "@pi-agent-hub/protocol";

export interface SessionHeader {
  type: "session";
  version?: number;
  id: string;
  timestamp: string;
  cwd: string;
  parentSession?: string;
}

export interface ParsedSession {
  header: SessionHeader;
  entries: CanonicalEntry[];
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isSessionHeader(value: unknown): value is SessionHeader {
  return isRecord(value)
    && value.type === "session"
    && typeof value.id === "string"
    && typeof value.timestamp === "string"
    && typeof value.cwd === "string";
}

export function isSessionEntry(value: unknown): value is CanonicalEntry {
  return isRecord(value)
    && typeof value.type === "string"
    && typeof value.id === "string"
    && (typeof value.parentId === "string" || value.parentId === null)
    && typeof value.timestamp === "string";
}

export function parseJsonLines(text: string): unknown[] {
  const result: unknown[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    try {
      result.push(JSON.parse(line));
    } catch {
      // Ignore malformed trailing lines; callers validate the parsed shape.
    }
  }
  return result;
}

export async function readSessionFile(path: string): Promise<ParsedSession> {
  const text = await readFile(path, "utf8");
  const records = parseJsonLines(text);
  const header = records.find(isSessionHeader);
  if (!header) throw new Error(`Invalid pi session header: ${path}`);
  const entries = records.filter(isSessionEntry);
  return { header, entries };
}

export function validateEntries(entries: readonly CanonicalEntry[]): string[] {
  const errors: string[] = [];
  const seen = new Set<string>();
  let previous: string | null = null;
  for (const [index, entry] of entries.entries()) {
    if (seen.has(entry.id)) errors.push(`duplicate entry id: ${entry.id}`);
    seen.add(entry.id);
    if (index === 0 && entry.parentId !== null) errors.push(`first entry parentId must be null: ${entry.id}`);
    if (index > 0 && entry.parentId !== previous) errors.push(`broken chain at ${entry.id}`);
    if (Number.isNaN(timestampMs(entry))) errors.push(`invalid timestamp: ${entry.id}`);
    previous = entry.id;
  }
  return errors;
}

export function linearize(entries: readonly CanonicalEntry[]): CanonicalEntry[] {
  return entries.map((entry, index) => ({ ...entry, parentId: index === 0 ? null : entries[index - 1]!.id }));
}

export function timestampMs(entry: CanonicalEntry): number {
  return Date.parse(entry.timestamp);
}

export function encodeSessionDir(cwd: string): string {
  const resolved = resolve(cwd);
  const safe = resolved.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-");
  return `--${safe}--`;
}

export function sessionFileName(timestamp: string, id: string): string {
  return `${timestamp.replace(/[:.]/g, "-")}_${id}.jsonl`;
}

export function sessionFilePath(agentDir: string, cwd: string, timestamp: string, id: string): string {
  return join(agentDir, "sessions", encodeSessionDir(cwd), sessionFileName(timestamp, id));
}

export function sha256(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

export function createSessionHeader(cwd: string, id: string, timestamp = new Date().toISOString()): SessionHeader {
  return { type: "session", version: 3, id, timestamp, cwd };
}

export function serializeSession(header: SessionHeader, entries: readonly CanonicalEntry[]): string {
  return [header, ...entries].map((record) => JSON.stringify(record)).join("\n") + "\n";
}

export function metaFromHeader(header: SessionHeader): SessionMeta {
  return { cwd: header.cwd, createdAt: Date.parse(header.timestamp), updatedAt: Date.parse(header.timestamp) };
}
