import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

export interface SessionRow {
  id: string;
  host_id: string;
  agent_id: string;
  native_id: string;
  native_path: string | null;
  cwd: string;
  title: string | null;
  created_at: number;
  updated_at: number;
  last_timestamp: number | null;
  last_entry_id: string | null;
  entry_count: number;
  bytes: number;
  state: string;
  imported_from: string | null;
}

export class Store {
  readonly db: DatabaseSync;

  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true });
    this.db = new DatabaseSync(join(dataDir, "hub.db"));
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        host_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        native_id TEXT NOT NULL,
        native_path TEXT,
        cwd TEXT NOT NULL,
        title TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        last_timestamp INTEGER,
        last_entry_id TEXT,
        entry_count INTEGER NOT NULL DEFAULT 0,
        bytes INTEGER NOT NULL DEFAULT 0,
        state TEXT NOT NULL DEFAULT 'idle',
        imported_from TEXT,
        UNIQUE (agent_id, native_id)
      );
      CREATE TABLE IF NOT EXISTS deliveries (
        id TEXT PRIMARY KEY,
        host_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        state TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        error TEXT
      );
    `);
  }

  getSession(id: string): SessionRow | undefined {
    return this.db.prepare("SELECT * FROM sessions WHERE id = ?").get(id) as SessionRow | undefined;
  }

  getByNative(agentId: string, nativeId: string): SessionRow | undefined {
    return this.db.prepare("SELECT * FROM sessions WHERE agent_id = ? AND native_id = ?").get(agentId, nativeId) as SessionRow | undefined;
  }

  listSessions(): SessionRow[] {
    return this.db.prepare("SELECT * FROM sessions WHERE state != 'deleted' ORDER BY updated_at DESC").all() as unknown as SessionRow[];
  }

  upsertSession(row: SessionRow): void {
    this.db.prepare(`
      INSERT INTO sessions (id, host_id, agent_id, native_id, native_path, cwd, title, created_at, updated_at,
        last_timestamp, last_entry_id, entry_count, bytes, state, imported_from)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        native_path = excluded.native_path,
        cwd = excluded.cwd,
        title = excluded.title,
        updated_at = excluded.updated_at,
        last_timestamp = excluded.last_timestamp,
        last_entry_id = excluded.last_entry_id,
        entry_count = excluded.entry_count,
        bytes = excluded.bytes,
        state = excluded.state
    `).run(
      row.id, row.host_id, row.agent_id, row.native_id, row.native_path, row.cwd, row.title,
      row.created_at, row.updated_at, row.last_timestamp, row.last_entry_id, row.entry_count,
      row.bytes, row.state, row.imported_from,
    );
  }
}
