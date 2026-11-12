import { describe, expect, it } from "vitest";
import {
  MAX_FILE_PATHS,
  buildFileTree,
  normalizeSeparators,
  projectKey,
  resolveRelative,
  serializeNode,
} from "../file-tree.js";
import type { CanonicalEntry } from "@pi-agent-hub/protocol";

const cwd = "D:\\\\work\\\\demo";

function toolEntry(id: string, name: string, args: Record<string, unknown>): CanonicalEntry {
  return {
    type: "message",
    id,
    parentId: null,
    timestamp: "2026-11-12T00:00:00.000Z",
    message: { role: "assistant", content: [{ type: "toolCall", id: `call_${id}`, name, arguments: args }] },
  };
}

describe("路径归一化", () => {
  it("统一反斜杠与斜杠分隔符", () => {
    expect(normalizeSeparators("a\\b\\c")).toBe("a/b/c");
    expect(projectKey("D:\\Work\\Demo\\")).toBe("d:/work/demo");
  });

  it("相对路径基于 cwd 解析为 POSIX 相对键", () => {
    expect(resolveRelative("src/index.ts", cwd)).toBe("src/index.ts");
    expect(resolveRelative(".\\src\\a.ts", cwd)).toBe("src/a.ts");
  });

  it("绝对路径在 cwd 内时取相对部分", () => {
    expect(resolveRelative("D:/work/demo/src/b.ts", cwd)).toBe("src/b.ts");
    expect(resolveRelative("D:\\work\\demo\\src\\b.ts", cwd)).toBe("src/b.ts");
  });

  it("越出 cwd 的路径归入 _outside", () => {
    const rel = resolveRelative("D:/other/secret.txt", cwd);
    expect(rel?.startsWith("_outside/")).toBe(true);
  });

  it("折叠内部 .. 与重复分隔符", () => {
    expect(resolveRelative("src/../lib/a.ts", cwd)).toBe("lib/a.ts");
    expect(resolveRelative("src//a.ts", cwd)).toBe("src/a.ts");
  });
});

describe("buildFileTree", () => {
  it("从 read/write/edit 工具参数构建目录树并记录 touchedBy", () => {
    const entries = [
      toolEntry("1", "read", { path: "src/index.ts" }),
      toolEntry("2", "write", { path: "src/index.ts", content: "// hello" }),
      toolEntry("3", "Edit", { path: "README.md" }),
      toolEntry("4", "bash", { command: "ls -la D:/work/demo/docs" }),
    ];
    const scan = buildFileTree(entries, cwd);
    const serialized = serializeNode(scan.root);
    const src = serialized.children.find((node) => node.name === "src");
    expect(src?.isDir).toBe(true);
    const index = src?.children.find((node) => node.name === "index.ts");
    expect(index?.isDir).toBe(false);
    expect(index?.touchedBy).toContain("read");
    expect(index?.touchedBy).toContain("write");
    expect(serialized.children.find((node) => node.name === "README.md")?.touchedBy).toContain("Edit");
  });

  it("edit.edits 内路径全部收集", () => {
    const entries = [
      toolEntry("1", "edit", { edits: [{ path: "a/x.ts" }, { path: "a/y.ts" }] }),
    ];
    const scan = buildFileTree(entries, cwd);
    expect([...scan.fileIndex.keys()].sort()).toEqual(["a/x.ts", "a/y.ts"]);
  });

  it("同路径重复出现不重复计数，仅合并 touchedBy", () => {
    const entries = [toolEntry("1", "read", { path: "a.ts" }), toolEntry("2", "read", { path: "a.ts" })];
    const scan = buildFileTree(entries, cwd);
    expect(scan.pathCount).toBe(1);
  });

  it("超过路径上限时 truncated=true", () => {
    const entries = Array.from({ length: MAX_FILE_PATHS + 10 }, (_v, i) =>
      toolEntry(String(i), "read", { path: `f${i}.ts` }),
    );
    const scan = buildFileTree(entries, cwd);
    expect(scan.truncated).toBe(true);
    expect(scan.pathCount).toBe(MAX_FILE_PATHS);
  });

  it("bash 提取拒绝 regex/glob 元字符伪路径，保留真实路径", () => {
    const entries = [
      // 真实命令：grep -o '](\\./[^)#]*' README.md 中的 [^)#] 不应成为文件
      toolEntry("1", "bash", {
        command:
          "for link in $(grep -o '](./[^)#]*' README.md | sed 's/](./\\.///' | sort -u); do [ -e \"$link\" ] || echo BROKEN; done",
      }),
      toolEntry("2", "bash", { command: "cat D:/work/demo/docs/guide.md" }),
      toolEntry("3", "bash", { command: "grep -rn pattern D:/work/demo/src/lib/app.ts" }),
    ];
    const scan = buildFileTree(entries, cwd);
    const keys = [...scan.fileIndex.keys()];
    expect(keys.some((k) => k.includes("[^)#]") || k.startsWith("["))).toBe(false);
    expect(keys).toContain("docs/guide.md");
    expect(keys).toContain("src/lib/app.ts");
  });

  it("glob/grep 的 pattern 仅断言目录", () => {
    const entries = [
      toolEntry("1", "glob", { pattern: "**/config/*.json" }),
      toolEntry("2", "grep", { pattern: "thing", path: "src/sub" }),
    ];
    const scan = buildFileTree(entries, cwd);
    expect(scan.fileIndex.size).toBe(0);
    const flat: string[] = [];
    const walk = (path: string): void => {
      flat.push(path);
    };
    walk(scan.root.path);
    expect(scan.root.children.size).toBeGreaterThan(0);
  });
});
