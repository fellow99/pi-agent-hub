#!/usr/bin/env node
import { runDaemon } from "./daemon.js";

function argValue(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const command = process.argv[2];
if (command !== "run") {
  process.stderr.write("usage: pi-agent-hub-sync-daemon run [--config <path>] [--once]\n");
  process.exit(2);
}

void runDaemon({
  configPath: argValue("--config"),
  once: process.argv.includes("--once"),
}).catch((error: unknown) => {
  process.stderr.write(`sync-daemon failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
