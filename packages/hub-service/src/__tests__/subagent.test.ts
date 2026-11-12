import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { CanonicalEntry } from "@pi-agent-hub/protocol";
import { SessionStore, SUBAGENT_CUSTOM_TYPE } from "../session-store.js";
import type { SessionRow, Store } from "../db.js";

/** 最小 Store 桩：仅实现 SessionStore 用到的 getSession。 */
class StubStore implements Pick<Store, "getSession"> {
  constructor(private readonly row: SessionRow | undefined) {}
  getSession(id: string): SessionRow | undefined {
    return this.row?.id === id ? this.row : undefined;
  }
}

function marker(id: string, parentId: string, parentToolCallId: string, agentName = "explorer"): CanonicalEntry {
  return {
    type: "custom",
    id,
    parentId,
    timestamp: "2026-11-12T00:00:00.000Z",
    customType: SUBAGENT_CUSTOM_TYPE,
    data: { agentName, parentToolCallId, aMessageId: parentId },
  };
}

function message(id: string, parentId: string | null, role: "assistant" | "toolResult" | "user", text: string, toolName?: string): CanonicalEntry {
  return {
    type: "message",
    id,
    parentId,
    timestamp: "2026-11-12T00:00:00.000Z",
    message: role === "toolResult"
      ? { role, toolName: toolName ?? "read", toolCallId: "c1", content: [{ type: "text", text }] }
      : { role, content: [{ type: "text", text }] },
  };
}

describe("子 agent 提取（线性 marker 区间）", () => {
  let dir: string;
  let mirrorPath: string;
  let emptyMirrorPath: string;
  const sessionId = "hs_test_subagent";

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "hub-subagent-"));
    const sessionsDir = join(dir, "agent", "sessions");
    await mkdir(sessionsDir, { recursive: true });
    mirrorPath = join(sessionsDir, "mirror.jsonl");
    // 线性镜像结构（linearize 后 parentId 为紧邻前条）：
    // m1(A) segA1 m2(B) segB1 m3(A) segA2 user(父会话恢复) tail；marker 紧邻其 aMessage 之后。
    const entries: CanonicalEntry[] = [
      message("e0", null, "assistant", "start"),
      marker("m1", "e0", "callA"),
      message("a1", "m1", "assistant", "A-segment-1"),
      marker("m2", "a1", "callB"),
      message("b1", "m2", "assistant", "B-segment-1"),
      marker("m3", "b1", "callA"),
      message("a2", "m3", "assistant", "A-segment-2"),
      message("u1", "a2", "user", "parent resumes"),
      message("tail", "u1", "assistant", "back in parent"),
    ];
    // 模拟 linearize：parentId 重写为前一条 id（首条 null）。
    entries.forEach((entry, index) => {
      entry.parentId = index === 0 ? null : entries[index - 1]!.id;
    });
    const header = { type: "session" as const, version: 3, id: sessionId, timestamp: "2026-11-12T00:00:00.000Z", cwd: "D:/demo" };
    await writeFile(mirrorPath, `${JSON.stringify(header)}\n${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`, "utf8");
    emptyMirrorPath = join(sessionsDir, "empty.jsonl");
    await writeFile(emptyMirrorPath, `${JSON.stringify(header)}\n${JSON.stringify(message("only", null, "assistant", "plain"))}\n`, "utf8");
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  function store(): SessionStore {
    const row: SessionRow = {
      id: sessionId,
      host_id: "h",
      agent_id: "a",
      native_id: "n",
      native_path: mirrorPath,
      cwd: "D:/demo",
      title: null,
      created_at: 0,
      updated_at: 1,
      last_timestamp: null,
      last_entry_id: null,
      entry_count: 8,
      bytes: 0,
      state: "idle",
      imported_from: null,
    };
    return new SessionStore(new StubStore(row) as unknown as Store, dir);
  }

  it("按 parentToolCallId 聚合并统计 marker 数", async () => {
    const items = await store().listSubagents(sessionId);
    expect(items).not.toBeNull();
    const a = items!.find((item) => item.subagentId === "callA");
    const b = items!.find((item) => item.subagentId === "callB");
    expect(a?.markerCount).toBe(2);
    expect(a?.agentName).toBe("explorer");
    expect(b?.markerCount).toBe(1);
    // 顺序按 marker 首次出现位置
    expect(items!.map((item) => item.subagentId)).toEqual(["callA", "callB"]);
  });

  it("嵌套区间按全局 marker 切分且按 entryId 去重", async () => {
    const service = store();
    const a = await service.subagentTranscript(sessionId, "callA");
    if (a === null || "notFound" in a) throw new Error("callA transcript missing");
    const texts = a.items.flatMap((item) => item.blocks.map((block) => (block as { text?: string }).text ?? ""));
    // A 的段 = (m1,m2) 与 (m3,末尾)，不含 B 独占的 b1
    expect(texts).toContain("A-segment-1");
    expect(texts).toContain("A-segment-2");
    expect(texts).not.toContain("B-segment-1");
    expect(texts).not.toContain("back in parent");
    expect(a.count).toBe(2);

    const b = await service.subagentTranscript(sessionId, "callB");
    if (b === null || "notFound" in b) throw new Error("callB transcript missing");
    const bTexts = b.items.flatMap((item) => item.blocks.map((block) => (block as { text?: string }).text ?? ""));
    expect(bTexts).toEqual(["B-segment-1"]);
  });

  it("最后 marker 的段在父会话恢复消息处结束（不含父尾部）", async () => {
    const result = await store().subagentTranscript(sessionId, "callA");
    if (result === null || "notFound" in result) throw new Error("callA missing");
    expect(result.count).toBe(2);
  });

  it("未知 subagentId 返回 notFound", async () => {
    const result = await store().subagentTranscript(sessionId, "callX");
    expect(result).toEqual({ notFound: true });
  });

  it("无 marker 会话返回空列表", async () => {
    const row: SessionRow = {
      id: "hs_empty",
      host_id: "h",
      agent_id: "a",
      native_id: "n2",
      native_path: emptyMirrorPath,
      cwd: "D:/demo",
      title: null,
      created_at: 0,
      updated_at: 1,
      last_timestamp: null,
      last_entry_id: null,
      entry_count: 1,
      bytes: 0,
      state: "idle",
      imported_from: null,
    };
    const service = new SessionStore(new StubStore(row) as unknown as Store, dir);
    const items = await service.listSubagents("hs_empty");
    expect(items).toEqual([]);
  });
});
