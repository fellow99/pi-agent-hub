import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CanonicalEntry, SyncRequest } from "@pi-agent-hub/protocol";
import { readSessionFile } from "@pi-agent-hub/pi-session";
import type { SessionRow, Store } from "../db.js";
import { SessionStore } from "../session-store.js";
import { SyncAttachmentStore } from "../sync-attachment-store.js";

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const GIF = "R0lGODlhAQABAIAAAAUEBAAAACwAAAAAAQABAAACAkQBADs=";
const HOST = "debian-opencode";
const AGENT = "opencode";
const HS = "hs_testattach00000000000000000";

/** 内存 Store 桩：SessionStore 仅依赖 getSession/upsertSession（避免 vite 无法打包 node:sqlite）。 */
class MemStore implements Pick<Store, "getSession" | "upsertSession"> {
  private readonly rows = new Map<string, SessionRow>();
  constructor(row: SessionRow) {
    this.rows.set(row.id, row);
  }
  getSession(id: string): SessionRow | undefined {
    return this.rows.get(id);
  }
  upsertSession(row: SessionRow): void {
    this.rows.set(row.id, row);
  }
}

function imageEntry(id: string, part: Record<string, unknown>, parentId: string | null = null): CanonicalEntry {
  return {
    type: "message",
    id,
    parentId,
    timestamp: "2026-11-18T08:00:00.000Z",
    message: { role: "user", content: [{ type: "text", text: "看图" }, part] },
  };
}

function syncRequest(entries: CanonicalEntry[]): SyncRequest {
  return {
    agentId: AGENT,
    nativeId: "native-1",
    mode: "full",
    session: { cwd: "D:/demo", createdAt: Date.now(), updatedAt: Date.now(), state: "idle" },
    entries,
  };
}

function row(id: string): SessionRow {
  return {
    id, host_id: HOST, agent_id: AGENT, native_id: "native-1", native_path: null,
    cwd: "D:/demo", title: null, created_at: Date.now(), updated_at: 0,
    last_timestamp: null, last_entry_id: null, entry_count: 0, bytes: 0,
    state: "idle", imported_from: null,
  };
}

describe("SessionStore 附属文件落盘接入", () => {
  let dir: string;
  let sessions: SessionStore;
  let db: MemStore;
  let id: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "hub-sync-session-"));
    sessions = new SessionStore(
      new MemStore(row(HS)) as unknown as Store,
      dir,
      new SyncAttachmentStore(dir),
    );
    // 与装配相同的 id 推导。
    id = sessions.hubSessionId(HOST, AGENT, "native-1");
    db = new MemStore(row(id));
    sessions = new SessionStore(db as unknown as Store, dir, new SyncAttachmentStore(dir));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("落盘内联 image（dataBase64 与 data 两形态）并把镜像 part 脱敏为 url", async () => {
    const entries = [
      imageEntry("e1", { type: "image", mimeType: "image/png", dataBase64: PNG }),
      imageEntry("e2", { type: "image", mimeType: "image/png", data: PNG }, "e1"),
    ];
    await sessions.sync(db.getSession(id)!, syncRequest(entries));

    const current = db.getSession(id)!;
    const mirror = await readSessionFile(current.native_path!);
    const parts = mirror.entries.flatMap((entry) =>
      (entry.message as { content: Array<Record<string, unknown>> }).content.filter((p) => p.type === "image"));
    expect(parts).toHaveLength(2);
    for (const part of parts) {
      expect(part.url as string).toMatch(/^\/api\/hub\/sessions\/.+\/attachments\/[0-9a-f]{64}$/);
      expect(part.dataBase64).toBeUndefined();
      expect(part.data).toBeUndefined();
    }
    const files = readdirSync(join(dir, "sync", HOST, AGENT, id)).filter((name) => !name.startsWith("tmp-"));
    expect(files).toHaveLength(1); // 同内容去重
    expect(readFileSync(join(dir, "sync", HOST, AGENT, id, files[0]!)).toString("base64")).toBe(PNG);
  });

  it("attachment part 同样落盘脱敏并保留 name", async () => {
    await sessions.sync(db.getSession(id)!, syncRequest([
      imageEntry("e1", { type: "attachment", mimeType: "application/pdf", dataBase64: PNG, name: "clip.pdf" }),
    ]));
    const mirror = await readSessionFile(db.getSession(id)!.native_path!);
    const part = (mirror.entries[0]!.message as { content: Array<Record<string, unknown>> }).content[1]!;
    expect(part.type).toBe("attachment");
    expect(part.name).toBe("clip.pdf");
    expect(typeof part.url).toBe("string");
    expect(part.dataBase64).toBeUndefined();
  });

  it("缺 mime 的内联 part 抛带 entryId 的 attachment_invalid 且零落盘", async () => {
    await expect(sessions.sync(db.getSession(id)!, syncRequest([
      imageEntry("bad-entry", { type: "image", dataBase64: PNG }),
    ]))).rejects.toThrow(/bad-entry/);
    expect(existsSync(join(dir, "sync"))).toBe(false);
  });

  it("重复同步幂等：已脱敏 part 不二次落盘、不报错", async () => {
    const req = syncRequest([imageEntry("e1", { type: "image", mimeType: "image/png", dataBase64: PNG })]);
    await sessions.sync(db.getSession(id)!, req);
    const dirPath = join(dir, "sync", HOST, AGENT, id);
    const first = readdirSync(dirPath);
    await sessions.sync(db.getSession(id)!, req);
    expect(readdirSync(dirPath)).toEqual(first);
  });
});

describe("toTranscriptItem 三级出图（含存量 data-uri 兼容）", () => {
  let dir: string;
  let sessions: SessionStore;
  let db: MemStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "hub-transcript-"));
    db = new MemStore(row(HS));
    sessions = new SessionStore(db as unknown as Store, dir, new SyncAttachmentStore(dir));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("新同步落盘 url；存量旧镜像内联 base64 即时 data-uri 且镜像零改写；无数据占位", async () => {
    // 1) 新同步：内联 PNG 落盘脱敏。
    await sessions.sync(db.getSession(HS)!, syncRequest([
      imageEntry("new", { type: "image", mimeType: "image/png", dataBase64: PNG }),
    ]));
    const afterSync = db.getSession(HS)!;
    const synced = await readSessionFile(afterSync.native_path!);
    const syncedImage = (synced.entries[0]!.message as { content: Array<Record<string, unknown>> }).content[1]!;
    expect(syncedImage.url as string).toContain("/attachments/");
    expect(syncedImage.dataBase64).toBeUndefined();

    // 2) 模拟上线前存量镜像：手工追加含内联 data 的旧 part（不经过 sync 落盘）。
    const legacyEntry: CanonicalEntry = {
      type: "message", id: "legacy", parentId: "new", timestamp: "2026-11-18T08:01:00.000Z",
      message: { role: "user", content: [{ type: "image", mimeType: "image/gif", data: GIF }] },
    };
    const emptyEntry: CanonicalEntry = {
      type: "message", id: "empty", parentId: "legacy", timestamp: "2026-11-18T08:02:00.000Z",
      message: { role: "user", content: [{ type: "image", mimeType: "image/webp" }] },
    };
    mkdirSync(dirname(afterSync.native_path!), { recursive: true });
    writeFileSync(afterSync.native_path!, `${JSON.stringify(legacyEntry)}\n${JSON.stringify(emptyEntry)}\n`, { flag: "a" });

    const transcript = await sessions.transcript(HS, 100);
    const imageBlocks = (transcript.items as Array<{ blocks: Array<Record<string, unknown>> }>)
      .flatMap((item) => item.blocks)
      .filter((block) => block.kind === "image");
    expect(imageBlocks).toHaveLength(3);
    expect(imageBlocks[0]!.url as string).toContain("/attachments/");
    expect(imageBlocks[1]!.url).toBe(`data:image/gif;base64,${GIF}`);
    expect(imageBlocks[2]!.url).toBe("");

    // 3) 存量镜像只读不改写：内联 data 原样保留、未被写 url。
    const mirror = await readSessionFile(afterSync.native_path!);
    const legacyPart = (mirror.entries[1]!.message as { content: Array<Record<string, unknown>> }).content[0]!;
    expect(legacyPart.data).toBe(GIF);
    expect(legacyPart.url).toBeUndefined();
  });

  it("registeredAttachment 仅放行镜像已注册的精确 url", async () => {
    await sessions.sync(db.getSession(HS)!, syncRequest([
      imageEntry("e1", { type: "image", mimeType: "image/png", dataBase64: PNG }),
    ]));
    const mirror = await readSessionFile(db.getSession(HS)!.native_path!);
    const part = (mirror.entries[0]!.message as { content: Array<Record<string, unknown>> }).content[1]!;
    const hash = (part.url as string).split("/").pop()!;
    const registered = await sessions.registeredAttachment(HS, hash);
    expect(registered?.mime).toBe("image/png");
    expect(registered?.url).toBe(part.url);
    expect(await sessions.registeredAttachment(HS, "a".repeat(64))).toBeNull();
    expect(await sessions.registeredAttachment(HS, "../passwd000000000000000000000000000000000000000000000000000")).toBeNull();
    expect(await sessions.registeredAttachment("hs_other00000000000000000000000000", hash)).toBeNull();
  });
});
