import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, symlink, writeFile, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FsBridge, FsError, classifyFile } from "../fs-bridge.js";
import { validateFsAllowedDirs } from "../config.js";
import { FS_LIMITS } from "@pi-agent-hub/protocol";

interface Fixture {
  root: string;
  evil: string;
  bridge: FsBridge;
  /** 全禁模式 bridge（fsAllowedDirs=[]）。 */
  denyAllBridge: FsBridge;
  /** null 回退模式 bridge，cwds 可动态替换。 */
  fallbackCwds: string[];
  fallbackBridge: FsBridge;
  /** symlink 逃逸样本是否创建成功（Windows 无特权时可能失败）。 */
  symlinkSupported: boolean;
}

let fixture: Fixture;

beforeAll(async () => {
  const base = await mkdtemp(join(tmpdir(), "fs-bridge-"));
  const root = join(base, "allowed");
  const evil = join(base, "allowed-evil");
  await mkdir(evil, { recursive: true });
  await mkdir(join(root, "z-dir"), { recursive: true });
  await mkdir(join(root, "a-dir"), { recursive: true });
  await mkdir(join(root, "nested"), { recursive: true });
  await writeFile(join(root, "b-file.txt"), "hello world", "utf8");
  await writeFile(join(root, "a-file.md"), "# title", "utf8");
  await writeFile(join(root, "image.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  await writeFile(join(root, "doc.pdf"), Buffer.from("%PDF-1.7"));
  await writeFile(join(root, "blob.bin"), Buffer.from([0, 1, 2, 3]));
  // symlink 逃逸：allowed/escape.txt -> allowed-evil/secret.txt（Windows 无特权时创建可能失败）
  await writeFile(join(evil, "secret.txt"), "top secret", { encoding: "utf8" });
  let symlinkSupported = true;
  try {
    await symlink(join(evil, "secret.txt"), join(root, "escape.txt"));
  } catch {
    symlinkSupported = false;
  }
  // 非法 UTF-8 文本
  await writeFile(join(root, "bad-utf8.txt"), Buffer.from([0xff, 0xfe, 0x00, 0x68]));
  // 超限文本（1MB + 1B）
  await writeFile(join(root, "huge.txt"), Buffer.alloc(FS_LIMITS.textBytes + 1, 0x61));

  const deps = {
    isExplicitMode: () => true,
    getRoots: () => [root],
    getKnownCwds: () => [],
  };
  const bridge = new FsBridge(deps);
  const denyAllBridge = new FsBridge({ ...deps, getRoots: () => [] });
  const fallbackCwds: string[] = [root];
  const fallbackBridge = new FsBridge({
    isExplicitMode: () => false,
    getRoots: () => [],
    getKnownCwds: () => fallbackCwds,
  });

  fixture = { root, evil, bridge, denyAllBridge, fallbackCwds, fallbackBridge, symlinkSupported };
});

afterAll(async () => {
  if (!fixture) return;
  await rm(fixture.root, { recursive: true, force: true });
  await rm(fixture.evil, { recursive: true, force: true });
});

async function expectFsError(promise: Promise<unknown>, code: string): Promise<void> {
  await expect(promise).rejects.toMatchObject({ name: "FsError", code });
}

describe("白名单终判", () => {
  it("显式 roots 内放行，兄弟目录 denied（段边界）", async () => {
    const listing = await fixture.bridge.listDir(fixture.root);
    expect(listing.entries.length).toBeGreaterThan(0);
    await expectFsError(fixture.bridge.readFile(join(fixture.evil, "secret.txt")), "denied");
  });

  it("[] 全禁 denied_all，且不读取文件", async () => {
    await expectFsError(fixture.denyAllBridge.listDir(fixture.root), "denied_all");
    await expectFsError(fixture.denyAllBridge.readFile(join(fixture.root, "a-file.md")), "denied_all");
  });

  it("null 回退 knownCwds 模式：集合内放行，集合外 denied", async () => {
    expect(fixture.fallbackCwds).toContain(fixture.root);
    await fixture.fallbackBridge.listDir(fixture.root);
    await expectFsError(fixture.fallbackBridge.readFile(join(fixture.evil, "secret.txt")), "denied");
  });

  it("null 模式 cwd 为空时全部 denied", async () => {
    const bridge = new FsBridge({
      isExplicitMode: () => false,
      getRoots: () => [],
      getKnownCwds: () => [],
    });
    await expectFsError(bridge.listDir(fixture.root), "denied");
  });

  it("symlink 逃逸 realpath 二次判定拦截", async () => {
    // Windows 非开发者模式/无特权无法建 symlink：环境不支持时跳过，CI/Linux 仍完整覆盖。
    if (!fixture.symlinkSupported) return;
    await expectFsError(fixture.bridge.readFile(join(fixture.root, "escape.txt")), "denied");
  });

  it("symlink 目录在 list_dir 阶段即被前移拦截，不作为可展开目录暴露", async () => {
    if (!fixture.symlinkSupported) return;
    const { entries } = await fixture.bridge.listDir(fixture.root);
    const escape = entries.find((entry) => entry.name === "escape.txt");
    // 越界 symlink 被直接跳过，不出现在列表中。
    expect(escape).toBeUndefined();
  });

  it("Windows 路径段大小写不敏感比较（平台条件）", async () => {
    if (process.platform !== "win32") return;
    const upperRoot = fixture.root.toLocaleUpperCase();
    const bridge = new FsBridge({
      isExplicitMode: () => true,
      getRoots: () => [upperRoot],
      getKnownCwds: () => [],
    });
    // root 大写、请求小写：case-fold 后应放行而非 denied。
    const listing = await bridge.listDir(fixture.root.toLocaleLowerCase());
    expect(listing.entries.length).toBeGreaterThan(0);
  });

  it("NUL 路径拒绝", async () => {
    await expectFsError(fixture.bridge.readFile(`${fixture.root}\0x`), "denied");
  });
});

describe("listDir", () => {
  it("目录在前文件在后、各自名称升序", async () => {
    const { entries } = await fixture.bridge.listDir(fixture.root);
    const dirs = entries.filter((e) => e.isDir).map((e) => e.name);
    const files = entries.filter((e) => !e.isDir).map((e) => e.name);
    expect(dirs).toEqual([...dirs].sort((a, b) => a.localeCompare(b)));
    expect(files).toEqual([...files].sort((a, b) => a.localeCompare(b)));
    expect(entries[0]?.isDir).toBe(true);
    expect(entries.some((e) => e.name === "a-file.md")).toBe(true);
  });

  it("目标不是目录 -> not_a_directory；对文件调 list_dir", async () => {
    await expectFsError(fixture.bridge.listDir(join(fixture.root, "a-file.md")), "not_a_directory");
  });

  it("不存在 -> not_found", async () => {
    await expectFsError(fixture.bridge.listDir(join(fixture.root, "missing")), "not_found");
  });

  it("返回字段含 size/mtimeMs/truncated=false", async () => {
    const result = await fixture.bridge.listDir(fixture.root);
    expect(result.truncated).toBe(false);
    const file = result.entries.find((e) => e.name === "b-file.txt");
    expect(file?.size).toBe(11);
    expect(typeof file?.mtimeMs).toBe("number");
  });
});

describe("readFile 分类与限额", () => {
  it("文本 UTF-8 原文", async () => {
    const result = await fixture.bridge.readFile(join(fixture.root, "b-file.txt"));
    expect(result.type).toBe("text");
    if (result.type === "text") {
      expect(result.content).toBe("hello world");
      expect(result.size).toBe(11);
    }
  });

  it("图片 base64 data URL 与 MIME", async () => {
    const result = await fixture.bridge.readFile(join(fixture.root, "image.png"));
    expect(result.type).toBe("image");
    if (result.type === "image") {
      expect(result.mimeType).toBe("image/png");
      expect(result.dataUrl.startsWith("data:image/png;base64,")).toBe(true);
    }
  });

  it("PDF data URL", async () => {
    const result = await fixture.bridge.readFile(join(fixture.root, "doc.pdf"));
    expect(result.type).toBe("pdf");
    if (result.type === "pdf") expect(result.dataUrl.startsWith("data:application/pdf;base64,")).toBe(true);
  });

  it("不支持的二进制 -> binary_unsupported", async () => {
    await expectFsError(fixture.bridge.readFile(join(fixture.root, "blob.bin")), "binary_unsupported");
  });

  it("超限 -> file_too_large", async () => {
    await expectFsError(fixture.bridge.readFile(join(fixture.root, "huge.txt")), "file_too_large");
  });

  it("非法 UTF-8 -> text_decode_failed", async () => {
    await expectFsError(fixture.bridge.readFile(join(fixture.root, "bad-utf8.txt")), "text_decode_failed");
  });

  it("对目录调 read_file -> not_a_file", async () => {
    await expectFsError(fixture.bridge.readFile(join(fixture.root, "a-dir")), "not_a_file");
  });

  it("base64 内容可还原原文件", async () => {
    const result = await fixture.bridge.readFile(join(fixture.root, "image.png"));
    if (result.type !== "image") throw new Error("expected image");
    const decoded = Buffer.from(result.dataUrl.split(",")[1] ?? "", "base64");
    const original = await readFile(join(fixture.root, "image.png"));
    expect(decoded.equals(original)).toBe(true);
  });
});

describe("classifyFile 纯函数", () => {
  it("各类扩展名命中与限额", () => {
    expect(classifyFile("a.ts").kind).toBe("text");
    expect(classifyFile("a.ets").kind).toBe("text");
    expect(classifyFile("photo.JPG").kind).toBe("image");
    expect(classifyFile("clip.mp4").kind).toBe("video");
    expect(classifyFile("doc.PDF").kind).toBe("pdf");
    expect(classifyFile("unknown.xyz").kind).toBe("unsupported");
    expect(classifyFile("a.ts").maxBytes).toBe(FS_LIMITS.textBytes);
    expect(classifyFile("a.png").maxBytes).toBe(FS_LIMITS.binaryBytes);
  });
});

describe("validateFsAllowedDirs 配置校验", () => {
  it("undefined/null -> null 回退模式", async () => {
    expect(await validateFsAllowedDirs(undefined)).toBeNull();
    expect(await validateFsAllowedDirs(null)).toBeNull();
  });

  it("空数组合法（全禁语义）", async () => {
    expect(await validateFsAllowedDirs([])).toEqual([]);
  });

  it("非数组/非字符串条目报错", async () => {
    await expect(validateFsAllowedDirs("D:\\\\x")).rejects.toThrow();
    await expect(validateFsAllowedDirs([123])).rejects.toThrow();
    await expect(validateFsAllowedDirs(["  "])).rejects.toThrow();
  });

  it("盘根拒绝", async () => {
    await expect(validateFsAllowedDirs(["/"])).rejects.toThrow(/drive root/);
    await expect(validateFsAllowedDirs(["D:\\"])).rejects.toThrow(/drive root/);
    await expect(validateFsAllowedDirs(["D:"])).rejects.toThrow(/drive root/);
  });

  it("不存在目录报错", async () => {
    await expect(validateFsAllowedDirs([join(tmpdir(), `no-such-${Date.now()}`)])).rejects.toThrow(/does not exist/);
  });
});
