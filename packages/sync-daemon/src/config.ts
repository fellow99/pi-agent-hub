import { readFile, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
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
  const config = parsed as unknown as SyncDaemonConfig;
  config.fsAllowedDirs = await validateFsAllowedDirs(parsed.fsAllowedDirs);
  return config;
}

/**
 * 005：校验并归一 fsAllowedDirs。
 * - undefined/null：null 回退模式（运行期按会话 cwd 集合判定）；
 * - 数组：条目必须为非空字符串；盘根拒绝（防止全盘暴露）；realpath 归一，不存在即配置错误；
 * - [] 合法：运行期语义为全禁（denied_all）。
 */
export async function validateFsAllowedDirs(value: unknown): Promise<string[] | null> {
  if (value === undefined || value === null) return null;
  if (!Array.isArray(value)) {
    throw new Error("sync-daemon config fsAllowedDirs must be an array of strings or null");
  }
  const normalized: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string" || entry.trim().length === 0) {
      throw new Error("sync-daemon config fsAllowedDirs entries must be non-empty strings");
    }
    // 盘根检查先于 expand/resolve：Windows 下 resolve('/') 会变成当前盘符根、resolve('D:') 会拼 CWD。
    if (isDriveRoot(entry.trim())) {
      throw new Error(`sync-daemon config fsAllowedDirs entry must not be a drive root: ${entry}`);
    }
    const expanded = expandHome(entry);
    if (isDriveRoot(expanded)) {
      throw new Error(`sync-daemon config fsAllowedDirs entry must not be a drive root: ${entry}`);
    }
    try {
      normalized.push(await realpath(resolve(expanded)));
    } catch {
      throw new Error(`sync-daemon config fsAllowedDirs entry does not exist: ${entry}`);
    }
  }
  return normalized;
}

function isDriveRoot(pathValue: string): boolean {
  // posix 盘根；Windows 下 "/" 与 "\\" 均解析为当前盘符根，同样拒绝。
  if (pathValue === "/" || pathValue === "\\") return true;
  // Windows 盘根：D:、D:\、D:/ 三种形态（盘符字母 + 冒号 + 可选单个分隔符）。
  if (pathValue.length >= 2 && pathValue.length <= 3) {
    const hasDriveLetter = (pathValue.charCodeAt(0) | 0x20) - 0x60 >= 1
      && (pathValue.charCodeAt(0) | 0x20) - 0x60 <= 26
      && pathValue.charAt(1) === ":";
    if (!hasDriveLetter) return false;
    if (pathValue.length === 2) return true;
    const tail = pathValue.charAt(2);
    return tail === "\\" || tail === "/";
  }
  return false;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
