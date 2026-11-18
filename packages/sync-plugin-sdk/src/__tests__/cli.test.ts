import { describe, expect, it } from "vitest";
import { runCli } from "../cli.js";

const node = process.execPath;
const fixtureDir = new URL("./fixtures", import.meta.url).pathname;

describe("runCli", () => {

  it("成功命令返回 stdout/stderr/exitCode", async () => {
    const result = await runCli(node, ["-e", "console.log('hi');console.error('err')"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("hi\n");
    expect(result.stderr).toBe("err\n");
    expect(result.truncated).toBe(false);
  });

  it("非 0 退出返回 exitCode（不自动抛错）", async () => {
    const result = await runCli(node, ["-e", "process.exit(3)"]);
    expect(result.exitCode).toBe(3);
  });

  it("超时 kill 并以 code=timeout 拒绝", async () => {
    const promise = runCli(node, ["-e", "setTimeout(()=>{}, 60000)"], { timeoutMs: 300 });
    await expect(promise).rejects.toMatchObject({ code: "timeout" });
  });
  it("maxBytes 截断 stdout 并标记 truncated", async () => {
    const result = await runCli(node, ["-e", "process.stdout.write('x'.repeat(1024))"], { maxBytes: 512 });
    expect(result.stdout.length).toBeLessThanOrEqual(512);
    expect(result.truncated).toBe(true);
  });

  it("spawn 不存在的命令以 agent_error 拒绝", async () => {
    const promise = runCli("__definitely_missing_cmd__", []);
    await expect(promise).rejects.toMatchObject({ code: "agent_error" });
  });
});
