/**
 * 202-console-session-viewer：从会话镜像条目中推导虚拟文件树的纯函数模块。
 * hub 不具备主机文件系统访问权，文件树仅反映会话工具活动触碰过的路径。
 */
import type { CanonicalEntry } from "@pi-agent-hub/protocol";

/** 带结构化路径参数的工具（小写匹配，兼容 Read/Write 等大写变体）。 */
const PATH_TOOLS = new Set(["read", "write", "edit", "apply_patch", "glob", "grep"]);
/** 输出文件完整正文的工具，其参数可作为文件内容来源。 */
export const CONTENT_WRITE_TOOLS = new Set(["write"]);
/** 结果 preview 可作为文件内容回退来源的工具。 */
export const CONTENT_READ_TOOLS = new Set(["read"]);
const DIR_ONLY_TOOLS = new Set(["glob", "grep"]);
const OUTSIDE_ROOT = "_outside";
/** 单会话虚拟路径上限（FR-202-010）。 */
export const MAX_FILE_PATHS = 2000;
/** 文件内容返回上限（FR-202-011）。 */
export const MAX_CONTENT_BYTES = 256 * 1024;

export type PathConfidence = "high" | "low";

export interface ExtractedPath {
  /** 工具内原始路径字符串。 */
  raw: string;
  toolName: string;
  confidence: PathConfidence;
  /** glob/grep 的 pattern 仅能断言目录时为 true。 */
  dirOnly: boolean;
}

export interface VirtualNode {
  name: string;
  /** 相对会话 cwd 的 POSIX 路径；目录以 / 结尾；越界项位于 _outside/ 下。 */
  path: string;
  isDir: boolean;
  touchedBy: Set<string>;
  hasContent: boolean;
  confidence: PathConfidence;
  children: Map<string, VirtualNode>;
}

export interface FileTreeScan {
  root: VirtualNode;
  pathCount: number;
  truncated: boolean;
  /** 相对路径键 -> 节点（文件叶子），供内容接口快速校验。 */
  fileIndex: Map<string, VirtualNode>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 把 Windows/POSIX 混用分隔符统一为 POSIX。 */
export function normalizeSeparators(p: string): string {
  return p.replace(/\\/g, "/");
}

/** 归一化 cwd 作为项目键（小写、POSIX、去尾部分隔符），仅用于分组键。 */
export function projectKey(cwd: string): string {
  return normalizeSeparators(cwd.trim()).replace(/\/+$/, "").toLocaleLowerCase();
}

function isAbsolute(p: string): boolean {
  return /^([a-zA-Z]:)?[\/]/.test(p) || /^[a-zA-Z]:/.test(p);
}

/** 消除 ./、重复分隔符与内部 ..（越界的 .. 由调用方根据结果判定）。 */
function collapseDots(segments: string[]): string[] {
  const out: string[] = [];
  for (const seg of segments) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      if (out.length > 0 && out[out.length - 1] !== "..") out.pop();
      else out.push("..");
      continue;
    }
    out.push(seg);
  }
  return out;
}

/**
 * 把工具原始路径解析为相对 cwd 的 POSIX 路径。
 * 返回 null 表示无法解析；越界路径返回以 _outside/ 开头的保序键。
 */
export function resolveRelative(rawPath: string, cwd: string): string | null {
  const raw = normalizeSeparators(rawPath.trim()).replace(/^["']|["']$/g, "");
  if (!raw || raw === "." || raw.startsWith("http://") || raw.startsWith("https://")) return null;
  const cwdNorm = normalizeSeparators(cwd);
  if (!isAbsolute(raw)) {
    // 相对路径：直接相对 cwd 解析，折叠 .. 后越界则归入 _outside。
    const segments = collapseDots(raw.split("/"));
    if (segments.some((s) => s === "..")) return `${OUTSIDE_ROOT}/${segments.join("/")}`;
    return segments.length > 0 ? segments.join("/") : null;
  }
  const driveMatch = raw.match(/^([a-zA-Z]):[\/]/);
  const rootPrefix = driveMatch ? `${driveMatch[1]!.toLocaleLowerCase()}:` : "";
  const segments = collapseDots(raw.replace(/^[a-zA-Z]:/, "").split("/"));
  if (segments.some((s) => s === "..")) {
    // 越出 cwd：保序编码为 _outside 下的虚拟键（FR-202-008）。
    return `${OUTSIDE_ROOT}/${rootPrefix}${segments.join("/")}`;
  }
  const cwdSegs = collapseDots(cwdNorm.replace(/^[a-zA-Z]:/, "").split("/"));
  if (segments.length >= cwdSegs.length && cwdSegs.every((s, i) => s.toLocaleLowerCase() === segments[i]?.toLocaleLowerCase())) {
    const rel = segments.slice(cwdSegs.length);
    return rel.length > 0 ? rel.join("/") : null;
  }
  return `${OUTSIDE_ROOT}/${rootPrefix}${segments.join("/")}`;
}

/** 从 bash 命令行尽力提取带分隔符的路径 token（低置信度）。 */
function extractBashPaths(command: string): string[] {
  const matches = command.match(/(?:[a-zA-Z]:[\/][^\s"'`*?|<>]+|[\/][^\s"'`*?|<>]+|(?:\.\.?)?[\/][^\s"'`*?|<>]+)/g);
  if (!matches) return [];
  return matches
    .filter((m) => m.includes("/") || m.includes("\\"))
    // 去掉 shell token 尾部粘连的分隔符/引号/括号（如 `spec.md;`、`a.txt"`）。
    .map((m) => m.replace(/[;,)"']+$/, ""))
    // 协议 URL 与裸选项不是文件路径。
    .filter((m) => !/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(m) && !m.startsWith("-"));
}

/** 遍历单条 entry 的工具调用，提取路径候选。 */
export function extractPathsFromEntry(entry: CanonicalEntry): ExtractedPath[] {
  if (entry.type !== "message" || !isRecord(entry.message)) return [];
  const message = entry.message;
  const content = message.content;
  if (!Array.isArray(content)) return [];
  const out: ExtractedPath[] = [];
  for (const part of content) {
    if (!isRecord(part) || part.type !== "toolCall") continue;
    const toolName = String(part.name ?? "");
    const lower = toolName.toLocaleLowerCase();
    const args = isRecord(part.arguments) ? part.arguments : isRecord(part.input) ? part.input : undefined;
    if (lower === "bash" && args && typeof args.command === "string") {
      for (const raw of extractBashPaths(args.command)) {
        out.push({ raw, toolName, confidence: "low", dirOnly: false });
      }
      continue;
    }
    if (!PATH_TOOLS.has(lower) || !args) continue;
    const dirOnly = DIR_ONLY_TOOLS.has(lower);
    const direct = args.path ?? args.file_path ?? args.filePath;
    const candidates: Array<{ raw: unknown; dirOnly: boolean }> = [];
    if (typeof direct === "string") candidates.push({ raw: direct, dirOnly });
    if (Array.isArray(args.edits)) {
      for (const edit of args.edits) {
        if (isRecord(edit) && typeof edit.path === "string") candidates.push({ raw: edit.path, dirOnly: false });
      }
    }
    if (typeof args.pattern === "string" && dirOnly) {
      const pattern = normalizeSeparators(args.pattern);
      if (pattern.includes("/")) candidates.push({ raw: pattern.slice(0, pattern.lastIndexOf("/")), dirOnly: true });
      if (typeof args.path === "string") candidates.push({ raw: args.path, dirOnly: true });
    }
    for (const candidate of candidates) {
      if (typeof candidate.raw === "string" && candidate.raw.length > 0) {
        out.push({ raw: candidate.raw, toolName, confidence: "high", dirOnly: candidate.dirOnly });
      }
    }
  }
  return out;
}

function makeNode(name: string, path: string, isDir: boolean, confidence: PathConfidence): VirtualNode {
  return { name, path, isDir, touchedBy: new Set(), hasContent: false, confidence, children: new Map() };
}

/** 扫描全部条目构建虚拟文件树。 */
export function buildFileTree(entries: readonly CanonicalEntry[], cwd: string): FileTreeScan {
  const root = makeNode("", "", true, "high");
  const fileIndex = new Map<string, VirtualNode>();
  const knownPaths = new Set<string>();
  let truncated = false;

  const ensureDir = (segments: string[], confidence: PathConfidence): VirtualNode => {
    let current = root;
    let acc = "";
    for (const seg of segments) {
      acc = acc ? `${acc}/${seg}` : seg;
      let next = current.children.get(seg);
      if (!next) {
        next = makeNode(seg, `${acc}/`, true, confidence);
        current.children.set(seg, next);
      }
      current = next;
    }
    return current;
  };

  for (const entry of entries) {
    for (const extracted of extractPathsFromEntry(entry)) {
      const rel = resolveRelative(extracted.raw, cwd);
      if (!rel) continue;
      if (extracted.dirOnly) {
        ensureDir(rel.split("/"), extracted.confidence).touchedBy.add(extracted.toolName);
        continue;
      }
      if (knownPaths.has(rel)) {
        const existing = fileIndex.get(rel);
        if (existing) {
          existing.touchedBy.add(extracted.toolName);
          if (extracted.confidence === "high") existing.confidence = "high";
        }
        continue;
      }
      if (knownPaths.size >= MAX_FILE_PATHS) {
        truncated = true;
        continue;
      }
      const segments = rel.split("/");
      const fileSeg = segments.pop()!;
      const dir = ensureDir(segments, extracted.confidence);
      const file = makeNode(fileSeg, rel, false, extracted.confidence);
      file.touchedBy.add(extracted.toolName);
      dir.children.set(fileSeg, file);
      fileIndex.set(rel, file);
      knownPaths.add(rel);
    }
  }
  return { root, pathCount: knownPaths.size, truncated, fileIndex };
}

/** 转为前端消费的可序列化树（Set → 数组、Map → 排序 children）。 */
export interface SerializableFileNode {
  name: string;
  path: string;
  isDir: boolean;
  touchedBy: string[];
  hasContent: boolean;
  confidence: PathConfidence;
  children: SerializableFileNode[];
}

export function serializeNode(node: VirtualNode): SerializableFileNode {
  const children = [...node.children.values()]
    .sort((a, b) => (a.isDir === b.isDir ? a.name.localeCompare(b.name) : a.isDir ? -1 : 1))
    .map(serializeNode);
  return {
    name: node.name,
    path: node.path,
    isDir: node.isDir,
    touchedBy: [...node.touchedBy].sort(),
    hasContent: node.hasContent,
    confidence: node.confidence,
    children,
  };
}
