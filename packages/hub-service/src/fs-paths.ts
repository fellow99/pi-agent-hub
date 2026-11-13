import type { SessionRow } from "./db.js";

/**
 * 005 FS Bridge 第一道白名单（hub 侧，平台无关字符串归一）。
 *
 * hub-service 运行在 Linux 容器，而会话 cwd 为主机 Windows 路径（如 `D:\pi-workspace`），
 * 因此禁止使用 node:path 的 resolve/normalize（posix 语义会把 `D:\foo` 当单段文件名）。
 * 本模块只做字符串级处理，不访问真实文件系统；realpath 终判是 sync-daemon 的职责。
 */

const SEP = "/";

/**
 * NUL 字符路径一律拒绝（防截断注入）。
 * 输出整体小写：Windows 路径（以盘符开头）文件系统不区分大小写，盘符与各段统一 case-fold
 * 才能正确比较；posix 绝对路径（/ 开头）保持原样大小写（Linux 区分大小写）。
 */
export function normalizeFsPath(input: string): string {
  if (input.includes("\0")) {
    throw new Error("path contains NUL character");
  }
  // 统一分隔符：\ 与 / -> /，连续分隔符合并。
  const unified = input.replace(/[\\/]+/g, SEP);
  const isAbsolute = unified.startsWith(SEP);
  const isWindowsDrive = /^[A-Za-z]:[\/]/.test(unified);
  const rawSegments = unified.split(SEP).filter((segment) => segment.length > 0);
  const stack: string[] = [];
  for (const segment of rawSegments) {
    if (segment === ".") continue;
    if (segment === "..") {
      const top = stack.length > 0 ? stack[stack.length - 1] : undefined;
      // 盘符段是 Windows 根锚点，不可被 .. 弹出（D:\.. 仍为盘根）；越界上溯 fail-closed。
      if (top !== undefined && top !== ".." && !/^[a-z]:$/.test(top)) {
        stack.pop();
      } else if (!isAbsolute && !isWindowsDrive && top === undefined) {
        stack.push("..");
      }
      continue;
    }
    stack.push(isWindowsDrive ? segment.toLocaleLowerCase() : segment);
  }
  const body = stack.join(SEP);
  if (isAbsolute) return SEP + body;
  return body;
}

/** 段边界前缀匹配：归一后相等，或 target 以 root + 分隔符开头（禁止字符串 includes）。 */
export function isPathWithin(target: string, root: string): boolean {
  const normalizedTarget = normalizeFsPath(target);
  const normalizedRoot = normalizeFsPath(root);
  if (normalizedTarget === normalizedRoot) return true;
  return normalizedTarget.startsWith(normalizedRoot + SEP);
}

/** 目标路径落在任一 cwd 之内即放行。 */
export function isAllowedByCwds(path: string, cwds: readonly string[]): boolean {
  return cwds.some((cwd) => isPathWithin(path, cwd));
}

/** 从 sessions 行收集指定 host 的 cwd 白名单（归一去重，保留首个原文）。 */
export function collectHostCwds(rows: readonly SessionRow[], hostId: string): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const row of rows) {
    if (row.host_id !== hostId || !row.cwd) continue;
    const key = normalizeFsPath(row.cwd);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(row.cwd);
  }
  return result;
}


