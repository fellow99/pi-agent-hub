import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { toHubParts } from "../plugin.js";

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);
const HASH = createHash("sha256").update(PNG).digest("hex");

describe("dsh toHubParts 附件对象解析", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "dsh-att-"));
    mkdirSync(join(root, HASH.slice(0, 2)), { recursive: true });
    writeFileSync(join(root, HASH.slice(0, 2), HASH), PNG);
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("解析 sha256 attachmentId 为内联 dataBase64 part", async () => {
    const parts = await toHubParts([
      { type: "text", text: "这图片是什么？" },
      {
        type: "image",
        attachment: {
          attachmentId: `sha256:${HASH}`,
          mediaType: "image/png",
          width: 200,
          height: 200,
          bytes: PNG.byteLength,
          name: "logo.png",
        },
      },
    ], root);
    expect(parts).toHaveLength(2);
    const image = parts[1] as Record<string, unknown>;
    expect(image.type).toBe("image");
    expect(image.mimeType).toBe("image/png");
    expect(image.dataBase64).toBe(PNG.toString("base64"));
    expect(image.name).toBe("logo.png");
  });

  it("对象缺失时降级为仅 mimeType 占位，不抛错", async () => {
    const missing = "a".repeat(64);
    const parts = await toHubParts([
      { type: "image", attachment: { attachmentId: `sha256:${missing}`, mediaType: "image/webp" } },
    ], root);
    const image = parts[0] as Record<string, unknown>;
    expect(image.type).toBe("image");
    expect(image.mimeType).toBe("image/webp");
    expect(image.dataBase64).toBeUndefined();
  });

  it("非法 attachmentId / 无 attachment 字段时安全降级", async () => {
    const parts = await toHubParts([
      { type: "image", attachment: { attachmentId: "not-a-hash", mediaType: "image/gif" } },
      { type: "image", mimeType: "image/jpeg" },
    ], root);
    expect((parts[0] as Record<string, unknown>).dataBase64).toBeUndefined();
    expect((parts[0] as Record<string, unknown>).mimeType).toBe("image/gif");
    expect((parts[1] as Record<string, unknown>).mimeType).toBe("image/jpeg");
  });

  it("text/reasoning 映射不受影响", async () => {
    const parts = await toHubParts([
      { type: "text", text: "hello" },
      { type: "reasoning", text: "think" },
    ], root);
    expect(parts).toEqual([
      { type: "text", text: "hello" },
      { type: "thinking", thinking: "think" },
    ]);
  });
});
