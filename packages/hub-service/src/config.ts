import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import YAML from "yaml";
import type { DaemonTokenConfig, HubConfig, HubUserConfig } from "@pi-agent-hub/protocol";
import { expandHome } from "@pi-agent-hub/sync-plugin-sdk";

export interface LoadedConfig {
  config: HubConfig;
  dataDir: string;
  configPath: string;
}

export async function loadHubConfig(path?: string): Promise<LoadedConfig> {
  const configPath = expandHome(path ?? process.env.HUB_CONFIG_FILE ?? join(homedir(), ".pi-agent-hub", "hub-service.json"));
  const text = await readFile(configPath, "utf8");
  const parsed: unknown = configPath.endsWith(".yml") || configPath.endsWith(".yaml")
    ? YAML.parse(text)
    : JSON.parse(text);
  if (!isRecord(parsed)) throw new Error("hub config must be an object");
  const users = Array.isArray(parsed.users) ? parsed.users.filter(isHubUser) : [];
  const daemonTokens = Array.isArray(parsed.daemonTokens) ? parsed.daemonTokens.filter(isDaemonToken) : [];
  if (users.length === 0) throw new Error("hub config requires at least one user");
  if (daemonTokens.length === 0) throw new Error("hub config requires at least one daemon token");
  const config = parsed as unknown as HubConfig;
  const dataDir = expandHome(config.dataDir ?? process.env.PI_AGENT_HUB_HOME ?? join(homedir(), ".pi-agent-hub"));
  return { config: { ...config, users, daemonTokens }, dataDir, configPath };
}

function isHubUser(value: unknown): value is HubUserConfig {
  return isRecord(value)
    && typeof value.username === "string"
    && (value.role === "admin" || value.role === "viewer")
    && (typeof value.password === "string" || typeof value.passwordHash === "string");
}

function isDaemonToken(value: unknown): value is DaemonTokenConfig {
  return isRecord(value)
    && typeof value.name === "string"
    && typeof value.hostName === "string"
    && (typeof value.token === "string" || typeof value.tokenHash === "string");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
