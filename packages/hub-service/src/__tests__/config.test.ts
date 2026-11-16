import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadHubConfig } from "../config.js";

const user = { username: "admin", password: "123456", role: "admin" as const };

describe("loadHubConfig — daemonTokens 缺省/空值", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "hub-config-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function loadWith(rawConfig: unknown) {
    const configPath = join(dir, "hub-service.json");
    await writeFile(configPath, `${JSON.stringify(rawConfig)}\n`, "utf8");
    return loadHubConfig(configPath);
  }

  it("daemonTokens 为空数组时允许启动并归一化为 []", async () => {
    const loaded = await loadWith({ users: [user], daemonTokens: [] });
    expect(loaded.config.daemonTokens).toEqual([]);
  });

  it("daemonTokens 为 null 时允许启动并归一化为 []", async () => {
    const loaded = await loadWith({ users: [user], daemonTokens: null });
    expect(loaded.config.daemonTokens).toEqual([]);
  });

  it("daemonTokens 缺省（undefined）时允许启动并归一化为 []", async () => {
    const loaded = await loadWith({ users: [user] });
    expect(loaded.config.daemonTokens).toEqual([]);
  });

  it('daemonTokens 为 ""（非法项）时过滤为空数组并允许启动', async () => {
    const loaded = await loadWith({ users: [user], daemonTokens: [""] });
    expect(loaded.config.daemonTokens).toEqual([]);
  });

  it("合法 daemonTokens 保留，非法元素被过滤", async () => {
    const valid = { name: "host-a", hostName: "host-a", token: "tok-abc" };
    const loaded = await loadWith({
      users: [user],
      daemonTokens: [valid, "", null, { name: "incomplete" }],
    });
    expect(loaded.config.daemonTokens).toEqual([valid]);
  });

  it("无任何用户时仍拒绝启动", async () => {
    await expect(loadWith({ users: [], daemonTokens: [] })).rejects.toThrow(
      "hub config requires at least one user",
    );
  });
});
