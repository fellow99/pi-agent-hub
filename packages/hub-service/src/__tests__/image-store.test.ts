import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ImageStore, ImageValidationError } from "../image-store.js";

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

let dir: string;
let store: ImageStore;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hub-img-"));
  store = new ImageStore(dir);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("ImageStore", () => {
  it("saves valid images and returns url/sha256/bytes", async () => {
    const urls = await store.saveImages("dlv_1", [{ mime: "image/png", dataBase64: PNG, name: "a.png" }]);
    expect(urls).toHaveLength(1);
    expect(urls[0]!.mime).toBe("image/png");
    expect(urls[0]!.url).toBe("/api/v1/deliveries/dlv_1/images/0");
    expect(urls[0]!.bytes).toBeGreaterThan(0);
    expect(urls[0]!.sha256).toHaveLength(64);
    const raw = readFileSync(join(dir, "deliveries", "dlv_1", "images", "0"));
    expect(raw.toString("base64")).toBe(PNG);
  });

  it("rejects unsupported mime", async () => {
    await expect(store.saveImages("dlv_2", [{ mime: "image/avif", dataBase64: PNG }]))
      .rejects.toBeInstanceOf(ImageValidationError);
  });

  it("rejects >10 images", async () => {
    const many = Array.from({ length: 11 }, () => ({ mime: "image/png", dataBase64: PNG }));
    await expect(store.saveImages("dlv_3", many)).rejects.toMatchObject({ code: "image_too_large" });
  });

  it("read/stat image and cleanup", async () => {
    const [url] = await store.saveImages("dlv_4", [{ mime: "image/png", dataBase64: PNG }]);
    await store.readImage("dlv_4", 0).then((buf) => expect(buf).not.toBeNull());
    await expect(store.readImage("dlv_4", 9)).resolves.toBeNull();
    await store.cleanupDelivery("dlv_4");
    await expect(store.readImage("dlv_4", 0)).resolves.toBeNull();
  });
});
