import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { linearize, validateEntries } from "@pi-agent-hub/pi-session";
import type { CanonicalEntry } from "@pi-agent-hub/protocol";
import { PiWebPlugin } from "../plugin.js";

/**
 * 011-version-0.1.2 回归用例：full 模式必须返回线性化后的 entries。
 *
 * hub 镜像的 full 模式要求严格单链（`validateEntries`），而 pi v3 会话是树
 * （fork / compaction 会让 parentId 指向非相邻条目）。插件在两处返回结果：
 * entriesPath（大会话）与 entries（内联），二者都必须压平——本用例守住内联分支。
 */

const NATIVE_ID = "01a2b3c4-d5e6-7788-99aa-bbccddeeff00";
const CWD = "D:\\proj";
const T0 = Date.parse("2026-01-01T00:00:00.000Z");

function entry(id: string, parentId: string | null, offsetSeconds: number): CanonicalEntry {
  return {
    type: "message",
    id,
    parentId,
    timestamp: new Date(T0 + offsetSeconds * 1_000).toISOString(),
    message: { role: "user", content: id },
  };
}

/** 分支会话：e4 的父是 e2 而不是 e3，文件顺序不等于单链顺序。 */
function branchedEntries(): CanonicalEntry[] {
  return [entry("e1", null, 0), entry("e2", "e1", 1), entry("e3", "e2", 2), entry("e4", "e2", 3)];
}

function writeSession(agentDir: string, entries: readonly CanonicalEntry[]): void {
  const dir = join(agentDir, "sessions", "--D--proj--");
  mkdirSync(dir, { recursive: true });
  const header = { type: "session", version: 3, id: NATIVE_ID, timestamp: new Date(T0).toISOString(), cwd: CWD };
  const text = [header, ...entries].map((record) => JSON.stringify(record)).join("\n") + "\n";
  writeFileSync(join(dir, `2026-01-01T00-00-00-000Z_${NATIVE_ID}.jsonl`), text, "utf8");
}

describe("sync-plugin-pi-web readSession 线性化", () => {
  let root: string;
  let plugin: PiWebPlugin;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "piweb-read-"));
    plugin = new PiWebPlugin();
    await plugin.initialize({
      protocolVersion: "1.0",
      daemonVersion: "0.1.2",
      hostId: "test-host",
      agentId: "a_test",
      kind: "pi-web",
      workDir: join(root, ".work"),
      config: { options: { agentDir: root }, instance: { name: "default" } },
    });
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("full 模式内联返回已线性化的单链（树 -> 链）", async () => {
    const source = branchedEntries();
    // 前置断言：原始文件顺序确实不是单链，否则本用例失去意义。
    expect(validateEntries(source).length).toBeGreaterThan(0);
    writeSession(root, source);

    const chunk = await plugin.readSession({ nativeId: NATIVE_ID });

    expect(chunk.mode).toBe("full");
    expect(chunk.entriesPath).toBeUndefined();
    const entries = chunk.entries ?? [];
    expect(entries).toHaveLength(source.length);
    expect(validateEntries(entries)).toEqual([]);
    expect(entries.map((item) => [item.id, item.parentId])).toEqual([
      ["e1", null],
      ["e2", "e1"],
      ["e3", "e2"],
      ["e4", "e3"],
    ]);
  });

  it("full 模式大会话走 entriesPath 时临时文件同样线性化", async () => {
    const source: CanonicalEntry[] = [];
    for (let index = 0; index < 2_001; index += 1) {
      source.push(entry(`e${index}`, index === 0 ? null : `e${index - 1}`, index));
    }
    // 制造一处分支：e1500 回指 e1498（而非文件里上一条 e1499）
    source[1_500] = entry("e1500", "e1498", 1_500);
    writeSession(root, source);

    const chunk = await plugin.readSession({ nativeId: NATIVE_ID });

    expect(chunk.mode).toBe("full");
    expect(chunk.entriesPath).toBeDefined();
    expect(chunk.entries).toBeUndefined();
    const lines = readFileSync(chunk.entriesPath!, "utf8").split("\n").filter((line) => line.trim());
    const written = lines.map((line) => JSON.parse(line) as CanonicalEntry);
    expect(validateEntries(written)).toEqual([]);
    expect(written).toEqual(linearize(source));
  });

  it("delta 模式不重排、只按 since 过滤", async () => {
    const source = branchedEntries();
    writeSession(root, source);

    const chunk = await plugin.readSession({ nativeId: NATIVE_ID, since: T0 + 1_000, lastEntryId: "e2" });

    expect(chunk.mode).toBe("delta");
    expect(chunk.entriesPath).toBeUndefined();
    expect((chunk.entries ?? []).map((item) => [item.id, item.parentId])).toEqual([
      ["e3", "e2"],
      ["e4", "e2"],
    ]);
  });
});
