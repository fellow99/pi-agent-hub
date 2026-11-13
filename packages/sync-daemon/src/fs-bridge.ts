import { lstat, readdir, readFile, realpath } from "node:fs/promises";
import type { Dirent } from "node:fs";
import { extname, join, parse, resolve, sep } from "node:path";
import {
  FS_LIMITS,
  type DirEntry,
  type DirListingResult,
  type FileContentResult,
  type FsErrorCode,
} from "@pi-agent-hub/protocol";
// FsErrorCode 仅用于 FsError 的稳定码约束（见下）。

/** 005 FS Bridge 主机端错误：携带稳定错误码，daemon 捕获后转 ok:false 回传。 */
export class FsError extends Error {
  constructor(
    readonly code: FsErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "FsError";
  }
}

export interface FsBridgeDeps {
  /** 显式白名单（config 已 realpath 归一）；null 模式返回 []。 */
  getRoots: () => readonly string[];
  /** fsAllowedDirs 是否为显式数组（含空数组全禁模式）。 */
  isExplicitMode: () => boolean;
  /** null 模式下的会话 cwd 快照（realpath 归一）。 */
  getKnownCwds: () => readonly string[];
}

interface FileClass {
  kind: "text" | "image" | "video" | "pdf" | "unsupported";
  mime?: string;
  maxBytes: number;
}

const TEXT_EXTENSIONS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".vue", ".json", ".json5",
  ".md", ".txt", ".css", ".scss", ".html", ".xml", ".yaml", ".yml", ".ini",
  ".conf", ".sh", ".bat", ".ps1", ".sql", ".csv", ".log", ".ets",
]);

const IMAGE_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".bmp": "image/bmp",
  ".ico": "image/x-icon",
};

const VIDEO_TYPES: Record<string, string> = {
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mov": "video/quicktime",
  ".m4v": "video/x-m4v",
};

export function classifyFile(name: string): FileClass {
  const ext = extname(name).toLocaleLowerCase();
  if (TEXT_EXTENSIONS.has(ext)) return { kind: "text", maxBytes: FS_LIMITS.textBytes };
  if (ext === ".pdf") return { kind: "pdf", mime: "application/pdf", maxBytes: FS_LIMITS.binaryBytes };
  if (ext in IMAGE_TYPES) return { kind: "image", mime: IMAGE_TYPES[ext], maxBytes: FS_LIMITS.binaryBytes };
  if (ext in VIDEO_TYPES) return { kind: "video", mime: VIDEO_TYPES[ext], maxBytes: FS_LIMITS.binaryBytes };
  return { kind: "unsupported", maxBytes: 0 };
}

export class FsBridge {
  constructor(private readonly deps: FsBridgeDeps) {}

  async listDir(inputPath: string): Promise<DirListingResult> {
    const target = await this.assertAllowed(inputPath);
    const targetStat = await safeStat(target, "list_dir");
    if (!targetStat.isDirectory()) {
      throw new FsError("not_a_directory", "list_dir target is not a directory");
    }
    let dirents: Dirent[];
    try {
      dirents = await readdir(target, { withFileTypes: true });
    } catch (error) {
      throw mapFsError(error, "list_dir");
    }
    const entries: DirEntry[] = [];
    let truncated = false;
    for (const dirent of dirents) {
      if (entries.length >= FS_LIMITS.maxDirEntries) {
        truncated = true;
        break;
      }
      const fullPath = join(target, dirent.name);
      try {
        // lstat 不跟随 symlink：链接项按链接本身展示。
        const stat = await lstat(fullPath);
        let isDir = dirent.isDirectory();
        if (dirent.isSymbolicLink()) {
          // 纵深防御：symlink 在列目录阶段即做 realpath 白名单终判，越界链接不作为可展开目录暴露。
          const real = await realOrResolved(fullPath);
          if (!this.isWithinAllowed(real)) {
            continue;
          }
          // 白名单内的目录 symlink 才可作为目录项展开。
          isDir = stat.isDirectory();
        }
        entries.push({ name: dirent.name, isDir, size: stat.size, mtimeMs: stat.mtimeMs });
      } catch (error) {
        // 单项 stat 失败（权限/竞态删除）不应让整个目录失败：跳过该项并保留可观测性。
        if (error instanceof FsError) throw error;
        continue;
      }
    }
    entries.sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    return { path: target, entries, truncated };
  }

  async readFile(inputPath: string): Promise<FileContentResult> {
    const target = await this.assertAllowed(inputPath);
    const stat = await safeStat(target, "read_file");
    if (stat.isDirectory()) {
      throw new FsError("not_a_file", "read_file target is a directory");
    }
    const classification = classifyFile(parse(target).base);
    if (classification.kind === "unsupported") {
      throw new FsError("binary_unsupported", `unsupported file type: ${parse(target).base}`);
    }
    if (stat.size > classification.maxBytes) {
      throw new FsError(
        "file_too_large",
        `file size ${stat.size} exceeds limit ${classification.maxBytes} bytes`,
      );
    }
    const buffer = await readFile(target).catch((error: unknown) => {
      throw mapFsError(error, "read_file");
    });
    if (classification.kind === "text") {
      try {
        const content = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
        return { path: target, type: "text", content, size: buffer.byteLength };
      } catch {
        throw new FsError("text_decode_failed", "file is not valid UTF-8 text");
      }
    }
    const dataUrl = `data:${classification.mime};base64,${buffer.toString("base64")}`;
    return {
      path: target,
      type: classification.kind,
      mimeType: classification.mime ?? "application/octet-stream",
      dataUrl,
      size: buffer.byteLength,
    };
  }

  /**
   * 白名单终判（daemon 拥有最终否决权）。返回可安全操作的 realpath。
   * 顺序：NUL/参数 → 显式模式（[]全禁 / roots 段边界）→ null 模式（knownCwds 段边界）。
   */
  async assertAllowed(input: string): Promise<string> {
    if (typeof input !== "string" || input.length === 0 || input.includes("\0")) {
      throw new FsError("denied", "invalid path");
    }
    const resolved = resolve(input);
    const real = await realOrResolved(resolved);
    if (this.deps.isExplicitMode()) {
      const roots = this.deps.getRoots();
      if (roots.length === 0) {
        throw new FsError("denied_all", "fsAllowedDirs is empty: all file system access denied");
      }
      if (!within(real, roots)) {
        throw new FsError("denied", "path is outside fsAllowedDirs");
      }
      return real;
    }
    const cwds = this.deps.getKnownCwds();
    if (!within(real, cwds)) {
      throw new FsError("denied", "path is outside known session cwds");
    }
    return real;
  }

  /** 按当前模式（显式 roots / null 回退 cwds）判定 realpath 是否在白名单内。 */
  private isWithinAllowed(real: string): boolean {
    if (this.deps.isExplicitMode()) {
      const roots = this.deps.getRoots();
      return roots.length > 0 && within(real, roots);
    }
    return within(real, this.deps.getKnownCwds());
  }
}

/** 目标存在时取 realpath（解析 symlink）；不存在时退回 resolve 结果（后续 fs 调用归 not_found）。 */
async function realOrResolved(resolved: string): Promise<string> {
  try {
    return await realpath(resolved);
  } catch {
    return resolved;
  }
}

/** 段边界前缀匹配：相等或 target 以 root + 平台分隔符开头。 */
function within(target: string, roots: readonly string[]): boolean {
  const normalizedTarget = normalizeForCompare(target);
  return roots.some((root) => {
    const normalizedRoot = normalizeForCompare(root);
    return normalizedTarget === normalizedRoot
      || normalizedTarget.startsWith(normalizedRoot + sep);
  });
}

/**
 * 比较归一：Windows 文件系统不区分大小写，盘符与各路径段统一 case-fold；
 * posix 区分大小写，保持原样。同机 realpath 已消除符号链接与相对段差异。
 */
function normalizeForCompare(pathValue: string): string {
  if (process.platform !== "win32") return pathValue;
  return pathValue.toLocaleLowerCase();
}

async function safeStat(path: string, operation: string): Promise<{ size: number; isDirectory: () => boolean }> {
  try {
    return await lstat(path);
  } catch (error) {
    throw mapFsError(error, operation);
  }
}

function mapFsError(error: unknown, operation: string): FsError {
  if (error instanceof FsError) return error;
  const code = typeof error === "object" && error !== null && "code" in error
    ? String((error as { code?: unknown }).code)
    : "";
  if (code === "ENOENT") return new FsError("not_found", `${operation}: path not found`);
  if (code === "ENOTDIR") return new FsError("not_a_directory", `${operation}: not a directory`);
  if (code === "EISDIR") return new FsError("not_a_file", `${operation}: path is a directory`);
  return new FsError("daemon_error", error instanceof Error ? error.message : String(error));
}
