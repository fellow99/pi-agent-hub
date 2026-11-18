import { beforeEach, describe, expect, it, vi } from "vitest";

// mock runCli 以避免真实 spawn
vi.mock("@pi-agent-hub/sync-plugin-sdk", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@pi-agent-hub/sync-plugin-sdk")>();
  return { ...actual, runCli: vi.fn() };
});

import { OpencodeCliPlugin } from "../plugin.js";
import { runCli } from "@pi-agent-hub/sync-plugin-sdk";
import type { DeliverRequest } from "@pi-agent-hub/protocol";

const mockedRunCli = vi.mocked(runCli);

const SESSION_LIST = JSON.stringify([
  { id: "ses_aaa", title: "会话A", updated: 1750000000000, created: 1749990000000, projectId: "proj1", directory: "/work/a" },
  { id: "ses_bbb", title: "", updated: 1750001000000, created: 1750000000000, projectId: "proj1", directory: "/work/a" },
], null, 2);

const SESSION_EXPORT = JSON.stringify({
  info: { id: "ses_aaa", title: "会话A", location: { directory: "/work/a" } },
  messages: [
    { id: "msg_1", type: "user", text: "hello", files: [], time: { created: 1750000000000 } },
    { id: "msg_2", type: "assistant", time: { created: 1750000001000 }, content: [
      { type: "reasoning", text: "thinking...", time: { created: 1750000001010 } },
      { type: "text", text: "hi there", time: { created: 1750000001020 } },
      { type: "tool", id: "tool_1", name: "bash", state: { status: "completed", input: { command: "ls" } }, time: { created: 1750000001030 } },
    ] },
    { id: "msg_3", type: "idle", time: { created: 1750000002000 } },
    { id: "msg_4", type: "system", text: "system note", time: { created: 1750000003000 } },
  ],
}, null, 2);

async function makePlugin(): Promise<OpencodeCliPlugin> {
  const plugin = new OpencodeCliPlugin();
  await plugin.initialize({
    protocolVersion: "1.0", daemonVersion: "0.1.0", hostId: "h", agentId: "a",
    kind: "opencode-cli", workDir: "/tmp/work",
    config: { options: { openCommand: "opencode", cwd: "/work/a" }, instance: { name: "default" } },
  });
  return plugin;
}

describe("OpencodeCliPlugin CLI 形态", () => {
  beforeEach(() => {
    mockedRunCli.mockReset();
  });

  it("listSessions 解析 session list JSON", async () => {
    mockedRunCli.mockResolvedValue({ exitCode: 0, signal: null, stdout: SESSION_LIST, stderr: "", truncated: false });
    const plugin = await makePlugin();
    const { sessions } = await plugin.listSessions();
    expect(sessions).toHaveLength(2);
    expect(sessions[0]!.nativeId).toBe("ses_bbb");
    expect(sessions[1]!.cwd).toBe("/work/a");
  });

  it("readSession 组装 canonical（user/assistant/system，过滤 idle，图片转 image part）", async () => {
    const exportWithImage = JSON.stringify({
      info: { id: "ses_aaa", title: "带图", location: { directory: "/work/a" } },
      messages: [
        { id: "msg_1", type: "user", text: "看", files: [{ mime: "image/png", data: "iVBORw0KGgo=" }], time: { created: 1000 } },
      ],
    });
    mockedRunCli.mockResolvedValue({ exitCode: 0, signal: null, stdout: exportWithImage, stderr: "", truncated: false });
    const plugin = await makePlugin();
    const chunk = await plugin.readSession({ nativeId: "ses_aaa" });
    expect(chunk.mode).toBe("full");
    const entries = chunk.entries ?? [];
    expect(entries).toHaveLength(1);
    const user = entries[0] as unknown as { message: { role: string; content: unknown[] } };
    expect(user.message.role).toBe("user");
    expect((user.message.content[1] as { type: string }).type).toBe("image");
  });

  it("readSession 过滤 assistant parts（reasoning→thinking / text→text / tool→toolCall）", async () => {
    mockedRunCli.mockResolvedValue({ exitCode: 0, signal: null, stdout: SESSION_EXPORT, stderr: "", truncated: false });
    const plugin = await makePlugin();
    const chunk = await plugin.readSession({ nativeId: "ses_aaa" });
    const entries = (chunk.entries ?? []).filter((e) => e.type === "message") as unknown as Array<{ message: { role: string; content: unknown[] } }>;
    expect(entries).toHaveLength(3); // user + assistant + system（idle 被过滤）
    const assistant = entries[1]!.message;
    expect(assistant.role).toBe("assistant");
    const kinds = assistant.content.map((c) => (c as { type: string }).type);
    expect(kinds).toEqual(["thinking", "text", "toolCall"]);
  });

  it("readSession since 增量过滤", async () => {
    mockedRunCli.mockResolvedValue({ exitCode: 0, signal: null, stdout: SESSION_EXPORT, stderr: "", truncated: false });
    const plugin = await makePlugin();
    const chunk = await plugin.readSession({ nativeId: "ses_aaa", since: 1750000001500 });
    expect(chunk.mode).toBe("delta");
    const entries = chunk.entries ?? [];
    expect(entries).toHaveLength(1); // 只有 msg_4 (sys) > since
  });

  it("deliver 组装 run 参数（--session/--model/--file/--thinking/消息单 argv）", async () => {
    mockedRunCli.mockResolvedValue({ exitCode: 0, signal: null, stdout: "{}", stderr: "", truncated: false });
    const plugin = await makePlugin();
    const request: DeliverRequest = {
      deliveryId: "d1", instanceId: "i", nativeId: "ses_aaa",
      message: "继续\n看这段代码", model: { provider: "opencode-free", modelId: "gpt-4o" },
      images: [{ mime: "image/png", path: "/tmp/x.png" }],
    };
    const result = await plugin.deliver(request);
    expect(result.ok).toBe(true);
    expect(mockedRunCli).toHaveBeenCalledTimes(1);
    const args = mockedRunCli.mock.calls[0]![1];
    expect(args).toContain("--session");
    expect(args).toContain("ses_aaa");
    expect(args).toContain("--model");
    expect(args).toContain("opencode-free/gpt-4o");
    expect(args).toContain("--file");
    expect(args).toContain("/tmp/x.png");
    expect(args).toContain("--thinking");
    // 消息是 -- 之后的单个 argv，保留换行
    expect(args[args.indexOf("--") + 1]).toBe("继续\n看这段代码");
  });

  it("deliver 空消息抛 invalid_request", async () => {
    const plugin = await makePlugin();
    await expect(plugin.deliver({ deliveryId: "d1", instanceId: "i", nativeId: "ses_aaa", message: "", images: [], model: null, thinkingLevel: null }))
      .rejects.toMatchObject({ code: "invalid_request" });
    expect(mockedRunCli).not.toHaveBeenCalled();
  });

  it("getModelInfo 投影 models（保守：reasoning=false, thinkingLevels=[off]）", async () => {
    mockedRunCli.mockResolvedValue({ exitCode: 0, signal: null, stdout: "opencode-free/gpt-4o\ndeepseek/deepseek-chat\n", stderr: "", truncated: false });
    const plugin = await makePlugin();
    const info = await plugin.getModelInfo({ nativeId: "ses_aaa" });
    expect(info.models).toHaveLength(2);
    expect(info.models[0]).toMatchObject({ provider: "opencode-free", modelId: "gpt-4o", reasoning: false, thinkingLevels: ["off"] });
    expect(info.currentModel).toBeNull();
  });
});
