import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CanonicalEntry, SyncRequest } from "@pi-agent-hub/protocol";
import type { SessionRow, Store } from "../db.js";
import { SessionStore } from "../session-store.js";
import { SyncAttachmentStore } from "../sync-attachment-store.js";

/**
 * 路由安全矩阵测试。createApp 内部 new Store() 依赖 node:sqlite（vite 测试管线无法打包），
 * 故此处以 MemStore + 真实 SyncAttachmentStore 复刻 GET attachments 路由的全部判定步骤
 * （与 app.ts 处理函数同序：hash 白名单 → row 存在 → 注册表精确比对 → read → 响应头）。
 */
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const HOST = "debian-opencode";
const AGENT = "opencode";
const HS = "hs_route000000000000000000000000";

class MemStore implements Pick<Store, "getSession" | "upsertSession"> {
  private readonly rows = new Map<string, SessionRow>();
  constructor(row?: SessionRow) {
    if (row) this.rows.set(row.id, row);
  }
  getSession(id: string): SessionRow | undefined {
    return this.rows.get(id);
  }
  upsertSession(row: SessionRow): void {
    this.rows.set(row.id, row);
  }
}

function row(id: string): SessionRow {
  return {
    id, host_id: HOST, agent_id: AGENT, native_id: "native-route-1", native_path: null,
    cwd: "D:/demo", title: null, created_at: Date.now(), updated_at: 0,
    last_timestamp: null, last_entry_id: null, entry_count: 0, bytes: 0,
    state: "idle", imported_from: null,
  };
}

/** 与 app.ts 路由处理函数同序的判定，返回模拟响应 {status, headers, body}。 */
async function handleGet(
  sessions: SessionStore,
  attachments: SyncAttachmentStore,
  db: MemStore,
  id: string,
  hash: string,
) {
  const headers = new Map<string, string>();
  if (!/^[0-9a-f]{64}$/.test(hash)) return { status: 400, headers, body: null };
  const sessionRow = db.getSession(id);
  if (!sessionRow) return { status: 404, headers, body: null };
  const registered = await sessions.registeredAttachment(id, hash);
  const expectedUrl = `/api/hub/sessions/${encodeURIComponent(id)}/attachments/${hash}`;
  if (!registered || registered.url !== expectedUrl) return { status: 404, headers, body: null };
  const buffer = await attachments.read(sessionRow.host_id, sessionRow.agent_id, id, hash);
  if (!buffer) return { status: 404, headers, body: null };
  headers.set("Content-Type", registered.mime);
  headers.set("Cache-Control", "public, max-age=31536000, immutable");
  headers.set("ETag", `"${hash}"`);
  headers.set("X-Content-Type-Options", "nosniff");
  return { status: 200, headers, body: buffer };
}

describe("GET attachments 路由安全矩阵（处理逻辑复刻）", () => {
  let dir: string;
  let db: MemStore;
  let sessions: SessionStore;
  let attachments: SyncAttachmentStore;
  let hash: string;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "hub-route-"));
    db = new MemStore(row(HS));
    attachments = new SyncAttachmentStore(dir);
    sessions = new SessionStore(db as unknown as Store, dir, attachments);
    const entries: CanonicalEntry[] = [{
      type: "message", id: "e1", parentId: null, timestamp: "2026-11-18T09:00:00.000Z",
      message: { role: "user", content: [{ type: "image", mimeType: "image/png", dataBase64: PNG }] },
    }];
    const req: SyncRequest = {
      agentId: AGENT, nativeId: "native-route-1", mode: "full",
      session: { cwd: "D:/demo", createdAt: Date.now(), updatedAt: Date.now(), state: "idle" },
      entries,
    };
    await sessions.sync(db.getSession(HS)!, req);
    hash = createHash("sha256").update(Buffer.from(PNG, "base64")).digest("hex");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("hash 非 64 位小写 hex（含穿越序列）→ 400", async () => {
    expect((await handleGet(sessions, attachments, db, HS, "../passwd")).status).toBe(400);
    expect((await handleGet(sessions, attachments, db, HS, "A".repeat(64))).status).toBe(400);
    expect((await handleGet(sessions, attachments, db, HS, "a".repeat(63))).status).toBe(400);
  });

  it("会话不存在 → 404", async () => {
    expect((await handleGet(sessions, attachments, db, "hs_nonexistent00000000000000000000", hash)).status).toBe(404);
  });

  it("合法 hash 但未在该会话注册 → 404（不暴露存在性）", async () => {
    expect((await handleGet(sessions, attachments, db, HS, "a".repeat(64))).status).toBe(404);
  });

  it("注册附件 → 200，响应头四件套齐备且内容一致", async () => {
    const res = await handleGet(sessions, attachments, db, HS, hash);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("image/png");
    expect(res.headers.get("Cache-Control")).toBe("public, max-age=31536000, immutable");
    expect(res.headers.get("ETag")).toBe(`"${hash}"`);
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect((res.body as Buffer).toString("base64")).toBe(PNG);
  });

  it("文件被删后 → 404（注册表仍在但存储缺失，客户端按占位渲染）", async () => {
    // 仅删除内容文件、保留镜像注册表，验证 read 缺失 → 404 分支。
    rmSync(join(dir, "sync", HOST, AGENT, HS, hash), { force: true });
    expect((await handleGet(sessions, attachments, db, HS, hash)).status).toBe(404);
  });
});
