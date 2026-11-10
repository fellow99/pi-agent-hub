#!/usr/bin/env node
// sync-daemon-starter.js — 零依赖 Node ESM 启动器（FR-301-001~005）
// 用法: node sync-daemon-starter.js run [--config <path>] [--once]
// 职责: 解析 @pi-agent-hub/sync-daemon 入口(exports/env/local/global) -> spawn -> 信号/退出码透传
// 全失败: 退出码 1，stderr 输出单行 JSON {error:"starter_resolve_failed", reason, message}
import { spawn, execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const SELF_DIR = dirname(fileURLToPath(import.meta.url));
const SELF_REQUIRE = createRequire(import.meta.url);

function argValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function resolveDaemon() {
  // 1) 调试：环境变量指向的入口（可指向本仓库 packages/sync-daemon）
  const env = process.env.PI_AGENT_HUB_DAEMON;
  if (env) {
    if (existsSync(env)) return { entry: env, source: "env" };
    return {
      error: "env_not_found",
      message: `PI_AGENT_HUB_DAEMON 指向不存在的文件: ${env}`,
    };
  }
  // 2) 安装包内置 / 本地 node_modules
  const local = join(SELF_DIR, "node_modules", "@pi-agent-hub", "sync-daemon", "dist", "main.js");
  if (existsSync(local)) return { entry: local, source: "local" };
  // 3) 全局 npm（npm root -g）
  try {
    const npmBin = process.platform === "win32" ? "npm.cmd" : "npm";
    const root = execFileSync(npmBin, ["root", "-g"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    if (root) {
      const globalRequire = createRequire(join(root, "package.json"));
      const resolved = globalRequire.resolve("@pi-agent-hub/sync-daemon/dist/main.js");
      if (existsSync(resolved)) return { entry: resolved, source: "global" };
    }
  } catch {
    // fall through
  }
  return {
    error: "global_not_found",
    message: "本地与全局未找到 @pi-agent-hub/sync-daemon（无内置 node_modules，也非全局安装）",
  };
}

const command = process.argv[2];
if (command !== "run") {
  process.stderr.write("usage: node sync-daemon-starter.js run [--config <path>] [--once]\n");
  process.exit(2);
}

const found = resolveDaemon();
if (found.error) {
  process.stderr.write(JSON.stringify({ error: "starter_resolve_failed", reason: found.error, message: found.message }) + "\n");
  process.exit(1);
}

const config = argValue("--config");
const once = process.argv.includes("--once");
const args = [found.entry, "run"];
if (config) args.push("--config", config);
if (once) args.push("--once");

process.stderr.write(`[sync-daemon-starter] resolved=${found.source} entry=${found.entry}\n`);

const child = spawn(process.execPath, args, { stdio: "inherit" });

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    if (!child.killed) child.kill(signal);
  });
}

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
  } else {
    process.exit(typeof code === "number" ? code : 1);
  }
});
