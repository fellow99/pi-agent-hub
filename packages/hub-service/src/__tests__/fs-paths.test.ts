import { describe, expect, it } from "vitest";
import {
  collectHostCwds,
  isAllowedByCwds,
  isPathWithin,
  normalizeFsPath,
} from "../fs-paths.js";
import type { SessionRow } from "../db.js";

describe("normalizeFsPath", () => {
  it("统一反斜杠与斜杠分隔符并小写化盘符", () => {
    expect(normalizeFsPath("D:\\pi-workspace")).toBe("d:/pi-workspace");
    expect(normalizeFsPath("D:/pi-workspace/")).toBe("d:/pi-workspace");
    // Windows 路径不区分大小写：盘符与各段统一 case-fold。
    expect(normalizeFsPath("D:\\PI-WORKSPACE\\a")).toBe("d:/pi-workspace/a");
  });

  it("栈式折叠 .. 与 . 段", () => {
    expect(normalizeFsPath("D:\\pi-workspace\\pi-agent-hub\\..\\docs")).toBe("d:/pi-workspace/docs");
    expect(normalizeFsPath("D:/pi-workspace/./packages")).toBe("d:/pi-workspace/packages");
    expect(normalizeFsPath("D:\\pi-workspace\\..\\..\\other")).toBe("d:/other");
  });

  it("盘符根锚点不被 .. 弹出", () => {
    expect(normalizeFsPath("D:\\..\\pi-workspace")).toBe("d:/pi-workspace");
  });

  it("posix 绝对路径与相对路径保持大小写（Linux 区分大小写）", () => {
    expect(normalizeFsPath("/home/user/proj/../proj2")).toBe("/home/user/proj2");
    expect(normalizeFsPath("/home/user/MyProj/READ.md")).toBe("/home/user/MyProj/READ.md");
    expect(normalizeFsPath("src/../lib/a.ts")).toBe("lib/a.ts");
    expect(normalizeFsPath("../outside/a.ts")).toBe("../outside/a.ts");
  });

  it("拒绝含 NUL 的路径", () => {
    expect(() => normalizeFsPath("D:\\bad\\\0path")).toThrow();
  });
});

describe("isPathWithin 段边界", () => {
  const root = "D:\\pi-workspace";

  it("相等与子路径放行", () => {
    expect(isPathWithin("D:\\pi-workspace", root)).toBe(true);
    expect(isPathWithin("D:\\pi-workspace\\pi-agent-hub", root)).toBe(true);
    expect(isPathWithin("d:/PI-WORKSPACE/packages", root)).toBe(true);
  });

  it("前缀相似的兄弟目录拒绝（禁止字符串 includes）", () => {
    expect(isPathWithin("D:\\pi-workspace-evil\\x", root)).toBe(false);
  });

  it(".. 折叠后越界拒绝", () => {
    expect(isPathWithin("D:\\pi-workspace\\..\\other\\secret.txt", root)).toBe(false);
  });

  it("posix 根同样按段边界判定", () => {
    expect(isPathWithin("/home/user/proj/src", "/home/user/proj")).toBe(true);
    expect(isPathWithin("/home/user/project-x", "/home/user/proj")).toBe(false);
  });
});

describe("isAllowedByCwds", () => {
  it("任一 cwd 命中即放行，全部不命中拒绝", () => {
    const cwds = ["D:\\pi-workspace", "D:\\oh-workspace\\app"];
    expect(isAllowedByCwds("D:\\pi-workspace\\a\\b.ts", cwds)).toBe(true);
    expect(isAllowedByCwds("D:\\oh-workspace\\app\\entry.ets", cwds)).toBe(true);
    expect(isAllowedByCwds("C:\\windows\\system32", cwds)).toBe(false);
    expect(isAllowedByCwds("any", [])).toBe(false);
  });
});

describe("collectHostCwds", () => {
  const base = {
    id: "hs_1",
    agent_id: "a_1",
    native_id: "n1",
    native_path: null,
    title: null,
    created_at: 0,
    updated_at: 0,
    last_timestamp: null,
    last_entry_id: null,
    entry_count: 0,
    bytes: 0,
    state: "idle",
    imported_from: null,
  } satisfies Partial<SessionRow>;

  function row(host_id: string, cwd: string): SessionRow {
    return { ...base, id: `hs_${host_id}_${cwd}`, host_id, cwd } as SessionRow;
  }

  it("按 host 过滤并对归一后相同 cwd 去重", () => {
    const rows = [
      row("laptop-win", "D:\\pi-workspace"),
      row("laptop-win", "D:/pi-workspace/"),
      row("laptop-win", "D:\\oh-workspace\\app"),
      row("other-host", "D:\\pi-workspace"),
    ];
    const cwds = collectHostCwds(rows, "laptop-win");
    expect(cwds).toEqual(["D:\\pi-workspace", "D:\\oh-workspace\\app"]);
  });

  it("忽略空 cwd", () => {
    expect(collectHostCwds([row("h", "")], "h")).toEqual([]);
  });
});
