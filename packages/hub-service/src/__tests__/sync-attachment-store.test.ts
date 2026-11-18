import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SyncAttachmentError, SyncAttachmentStore } from "../sync-attachment-store.js";

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const GIF = "R0lGODlhAQABAIAAAAUEBAAAACwAAAAAAQABAAACAkQBADs=";

let dir: string;
let store: SyncAttachmentStore;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hub-sync-att-"));
  store = new SyncAttachmentStore(dir);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const H = (host = "debian-opencode", agent = "opencode", hs = "hs_aaaaaaaaaaaaaaaaaaaaaaaaaa") => ({ host, agent, hs });

describe("SyncAttachmentStore.save", () => {
  it("saves valid attachment and returns url/sha256/bytes", async () => {
    const ctx = H();
    const refs = await store.save(ctx.host, ctx.agent, ctx.hs, [[{ mime: "image/png", dataBase64: PNG }]]);
    expect(refs).toHaveLength(1);
    const ref = refs[0]!;
    expect(ref.mime).toBe("image/png");
    expect(ref.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(ref.bytes).toBe(Buffer.from(PNG, "base64").byteLength);
    expect(ref.url).toBe(`/api/hub/sessions/${ctx.hs}/attachments/${ref.sha256}`);
    const file = join(dir, "sync", ctx.host, ctx.agent, ctx.hs, ref.sha256);
    expect(existsSync(file)).toBe(true);
    expect(readFileSync(file).toString("base64")).toBe(PNG);
  });

  it("deduplicates identical content within and across batches", async () => {
    const ctx = H();
    const first = await store.save(ctx.host, ctx.agent, ctx.hs, [[{ mime: "image/png", dataBase64: PNG }]]);
    const second = await store.save(ctx.host, ctx.agent, ctx.hs, [
      [{ mime: "image/png", dataBase64: PNG }, { mime: "image/gif", dataBase64: GIF }],
    ]);
    expect(second[0]!.sha256).toBe(first[0]!.sha256);
    const files = readdirSync(join(dir, "sync", ctx.host, ctx.agent, ctx.hs))
      .filter((name) => !name.startsWith("tmp-"));
    expect(files.sort()).toEqual([first[0]!.sha256, second[1]!.sha256].sort());
  });

  it("accepts video/audio/pdf and rejects other mime types", async () => {
    const ctx = H();
    for (const mime of ["video/mp4", "audio/mpeg", "application/pdf"]) {
      const refs = await store.save(ctx.host, ctx.agent, ctx.hs, [[{ mime, dataBase64: PNG }]]);
      expect(refs[0]!.mime).toBe(mime);
    }
    await expect(store.save(ctx.host, ctx.agent, ctx.hs, [[{ mime: "application/x-exec", dataBase64: PNG }]]))
      .rejects.toMatchObject({ code: "attachment_mime_denied" });
    await expect(store.save(ctx.host, ctx.agent, ctx.hs, [[{ mime: "text/html", dataBase64: PNG }]]))
      .rejects.toBeInstanceOf(SyncAttachmentError);
  });

  it("rejects more than 10 attachments in one message group", async () => {
    const ctx = H();
    const many = Array.from({ length: 11 }, () => ({ mime: "image/png", dataBase64: PNG }));
    await expect(store.save(ctx.host, ctx.agent, ctx.hs, [many]))
      .rejects.toMatchObject({ code: "attachment_too_large" });
  });

  it("rejects a single attachment larger than 10MB", async () => {
    const ctx = H();
    const big = Buffer.alloc(10 * 1024 * 1024 + 1, 0x61).toString("base64");
    await expect(store.save(ctx.host, ctx.agent, ctx.hs, [[{ mime: "image/png", dataBase64: big }]]))
      .rejects.toMatchObject({ code: "attachment_too_large" });
  });

  it("rejects total bytes over 100MB and leaves no files", async () => {
    const ctx = H();
    const chunk = Buffer.alloc(9 * 1024 * 1024, 0x62).toString("base64");
    const groups = Array.from({ length: 12 }, () => [{ mime: "image/png", dataBase64: chunk }]);
    await expect(store.save(ctx.host, ctx.agent, ctx.hs, groups))
      .rejects.toMatchObject({ code: "attachment_too_large" });
    expect(existsSync(join(dir, "sync"))).toBe(false);
  });

  it("rejects empty base64 data", async () => {
    const ctx = H();
    await expect(store.save(ctx.host, ctx.agent, ctx.hs, [[{ mime: "image/png", dataBase64: "" }]]))
      .rejects.toMatchObject({ code: "attachment_invalid" });
  });

  it("rolls back newly created files when a later part fails", async () => {
    const ctx = H();
    await expect(store.save(ctx.host, ctx.agent, ctx.hs, [
      [{ mime: "image/png", dataBase64: PNG }, { mime: "application/x-bat", dataBase64: GIF }],
    ])).rejects.toMatchObject({ code: "attachment_mime_denied" });
    // 校验先于落盘：失败时整个 sync 目录都不应创建。
    expect(existsSync(join(dir, "sync", ctx.host, ctx.agent, ctx.hs))).toBe(false);
  });

  it("keeps pre-existing deduplicated files when a later batch fails", async () => {
    const ctx = H();
    const first = await store.save(ctx.host, ctx.agent, ctx.hs, [[{ mime: "image/png", dataBase64: PNG }]]);
    await expect(store.save(ctx.host, ctx.agent, ctx.hs, [
      [{ mime: "image/png", dataBase64: PNG }, { mime: "text/plain", dataBase64: GIF }],
    ])).rejects.toMatchObject({ code: "attachment_mime_denied" });
    expect(existsSync(join(dir, "sync", ctx.host, ctx.agent, ctx.hs, first[0]!.sha256))).toBe(true);
  });

  it("rejects unsafe path segments", async () => {
    await expect(store.save("../etc", "opencode", "hs_x", [[{ mime: "image/png", dataBase64: PNG }]]))
      .rejects.toMatchObject({ code: "attachment_invalid" });
    await expect(store.save("h", "a", "..", [[{ mime: "image/png", dataBase64: PNG }]]))
      .rejects.toMatchObject({ code: "attachment_invalid" });
  });
});

describe("SyncAttachmentStore.read", () => {
  it("reads a stored attachment", async () => {
    const ctx = H();
    const refs = await store.save(ctx.host, ctx.agent, ctx.hs, [[{ mime: "image/png", dataBase64: PNG }]]);
    const buffer = await store.read(ctx.host, ctx.agent, ctx.hs, refs[0]!.sha256);
    expect(buffer?.toString("base64")).toBe(PNG);
  });

  it("returns null for malformed hash or missing file", async () => {
    const ctx = H();
    expect(await store.read(ctx.host, ctx.agent, ctx.hs, "../passwd")).toBeNull();
    expect(await store.read(ctx.host, ctx.agent, ctx.hs, "ABC".padEnd(64, "0"))).toBeNull();
    expect(await store.read(ctx.host, ctx.agent, ctx.hs, "a".repeat(63))).toBeNull();
    expect(await store.read(ctx.host, ctx.agent, ctx.hs, "a".repeat(64))).toBeNull();
  });
});

describe("SyncAttachmentStore.cleanupSession", () => {
  it("removes the session directory and is idempotent", async () => {
    const ctx = H();
    const refs = await store.save(ctx.host, ctx.agent, ctx.hs, [[{ mime: "image/png", dataBase64: PNG }]]);
    const sessionPath = join(dir, "sync", ctx.host, ctx.agent, ctx.hs);
    expect(existsSync(join(sessionPath, refs[0]!.sha256))).toBe(true);
    await store.cleanupSession(ctx.host, ctx.agent, ctx.hs);
    expect(existsSync(sessionPath)).toBe(false);
    await expect(store.cleanupSession(ctx.host, ctx.agent, ctx.hs)).resolves.toBeUndefined();
  });
});
