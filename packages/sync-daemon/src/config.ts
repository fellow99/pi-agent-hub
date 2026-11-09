import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import type { SyncDaemonConfig } from "@pi-agent-hub/protocol";
import { expandHome } from "@pi-agent-hub/sync-plugin-sdk";

export function defaultConfigPath(): string {
  return join(homedir(), ".pi-agent-hub", "sync-daemon.json");
}

export async function loadConfig(path = defaultConfigPath()): Promise<SyncDaemonConfig> {
  const raw = await readFile(expandHome(path), "utf8");
  const parsed: unknown = JSON.parse(raw);
  if (!isRecord(parsed)) throw new Error("sync-daemon config must be a JSON object");
  if (!isRecord(parsed.hub) || typeof parsed.hub.url !== "string" || typeof parsed.hub.token !== "string") {
    throw new Error("sync-daemon config requires hub.url and hub.token");
  }
  if (!isRecord(parsed.host) || typeof parsed.host.name !== "string") {
    throw new Error("sync-daemon config requires host.name");
  }
  if (!Array.isArray(parsed.plugins) || parsed.plugins.length === 0) {
    throw new Error("sync-daemon config requires a non-empty plugins array");
  }
  return parsed as unknown as SyncDaemonConfig;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
