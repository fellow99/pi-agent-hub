import { describe, expect, it } from "vitest";
import { parseFsResultPayload } from "../fs-payload.js";

describe("parseFsResultPayload", () => {
  it("接受 list_dir 结果（含 entries，无 type 字段）", () => {
    const payload = parseFsResultPayload({
      ok: true,
      result: {
        path: "D:\\pi-workspace",
        entries: [{ name: ".git", isDir: true, size: 0, mtimeMs: 1 }],
        truncated: false,
      },
    });
    expect(payload).toBeDefined();
    expect(payload?.ok).toBe(true);
    if (payload?.ok) {
      expect("entries" in payload.result).toBe(true);
    }
  });

  it("接受 read_file 文本结果（含 type=text）", () => {
    const payload = parseFsResultPayload({
      ok: true,
      result: { path: "a.md", type: "text", content: "hi", size: 2 },
    });
    expect(payload?.ok).toBe(true);
  });

  it("接受 read_file 二进制结果（dataUrl）", () => {
    const payload = parseFsResultPayload({
      ok: true,
      result: { path: "a.png", type: "image", mimeType: "image/png", dataUrl: "data:image/png;base64,AA==", size: 2 },
    });
    expect(payload?.ok).toBe(true);
  });

  it("接受失败结果（error 带合法 code/message）", () => {
    const payload = parseFsResultPayload({
      ok: false,
      error: { code: "denied", message: "blocked" },
    });
    expect(payload?.ok).toBe(false);
    if (payload && !payload.ok) {
      expect(payload.error.code).toBe("denied");
    }
  });

  it("拒绝缺 path 的成功结果", () => {
    expect(parseFsResultPayload({ ok: true, result: { entries: [] } })).toBeUndefined();
  });

  it("拒绝既无 entries 又无 type 的结果", () => {
    expect(parseFsResultPayload({ ok: true, result: { path: "x" } })).toBeUndefined();
  });

  it("拒绝非布尔 ok 与非法错误码", () => {
    expect(parseFsResultPayload({ ok: "yes" })).toBeUndefined();
    expect(parseFsResultPayload({ ok: false, error: { code: "csrf_failed", message: "x" } })).toBeUndefined();
    expect(parseFsResultPayload({ ok: false, error: { code: "denied" } })).toBeUndefined();
  });
});
