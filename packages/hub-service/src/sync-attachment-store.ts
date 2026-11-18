import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { SYNC_ATTACHMENT_LIMITS, type SyncAttachmentErrorCode } from "@pi-agent-hub/protocol";

/**
 * 004 会话同步-附属文件落盘转存（方案 B）。
 *
 * daemon→hub 同步时，canonical image/attachment part 内联的 base64 在此统一校验、
 * 以 sha256 内容寻址落盘 `<dataDir>/sync/<host>/<agent>/<hubSessionId>/<sha256hex>`，
 * 镜像 part 脱敏为纯 url 引用（见 session-store.ts）。
 * 读取走 /api/hub cookie 鉴权 + 镜像 block url 注册表校验（app.ts）。
 */

export interface SyncAttachmentInput {
  mime: string;
  dataBase64: string;
  name?: string;
}

export interface SyncAttachmentRef {
  mime: string;
  url: string;
  sha256: string;
  bytes: number;
  name?: string;
}

export class SyncAttachmentError extends Error {
  constructor(
    readonly code: SyncAttachmentErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "SyncAttachmentError";
  }
}

const HASH_PATTERN = /^[0-9a-f]{64}$/;

/** 目录段只允许可信 token：拒绝分隔符、NUL、`.`/`..` 穿越段（纵深防御，正常 row 不会命中）。 */
function assertSegment(value: string, label: string): void {
  if (typeof value !== "string" || value.length === 0
    || value.includes("/") || value.includes("\\") || value.includes("\0")
    || value === "." || value === "..") {
    throw new SyncAttachmentError("attachment_invalid", `invalid ${label} path segment`);
  }
}

function isAllowedMime(mime: string): boolean {
  return SYNC_ATTACHMENT_LIMITS.mimePrefixes.some((prefix) => mime.startsWith(prefix))
    || (SYNC_ATTACHMENT_LIMITS.mimeExact as readonly string[]).includes(mime);
}

export class SyncAttachmentStore {
  constructor(private readonly dataDir: string) {}

  sessionDir(host: string, agent: string, sessionId: string): string {
    assertSegment(host, "host");
    assertSegment(agent, "agent");
    assertSegment(sessionId, "sessionId");
    return join(this.dataDir, "sync", host, agent, sessionId);
  }

  /**
   * 校验并落盘一批附件。groups 按 entry（消息）分组，组内数量受 maxCount 约束。
   * 返回与 groups 扁平化顺序一一对应的引用数组（同内容 hash 共享同一文件与 url）。
   * 任一失败：回滚本轮新建文件后抛 SyncAttachmentError，不污染既有文件与镜像。
   */
  async save(
    host: string,
    agent: string,
    sessionId: string,
    groups: SyncAttachmentInput[][],
  ): Promise<SyncAttachmentRef[]> {
    const dir = this.sessionDir(host, agent, sessionId);
    const decoded: Array<{ input: SyncAttachmentInput; buffer: Buffer }> = [];
    let totalBytes = 0;
    for (const group of groups) {
      if (group.length > SYNC_ATTACHMENT_LIMITS.maxCount) {
        throw new SyncAttachmentError(
          "attachment_too_large",
          `at most ${SYNC_ATTACHMENT_LIMITS.maxCount} attachments per message`,
        );
      }
      for (const input of group) {
        if (!isAllowedMime(input.mime)) {
          throw new SyncAttachmentError("attachment_mime_denied", `unsupported mime: ${input.mime}`);
        }
        let buffer: Buffer;
        try {
          buffer = Buffer.from(input.dataBase64, "base64");
        } catch {
          throw new SyncAttachmentError("attachment_invalid", "invalid base64 attachment data");
        }
        if (buffer.byteLength === 0) {
          throw new SyncAttachmentError("attachment_invalid", "empty attachment data");
        }
        if (buffer.byteLength > SYNC_ATTACHMENT_LIMITS.singleBytes) {
          throw new SyncAttachmentError(
            "attachment_too_large",
            `attachment size ${buffer.byteLength} exceeds limit ${SYNC_ATTACHMENT_LIMITS.singleBytes} bytes`,
          );
        }
        totalBytes += buffer.byteLength;
        if (totalBytes > SYNC_ATTACHMENT_LIMITS.totalBytes) {
          throw new SyncAttachmentError("attachment_too_large", "total attachment bytes exceed limit");
        }
        decoded.push({ input, buffer });
      }
    }
    if (decoded.length === 0) return [];

    await mkdir(dir, { recursive: true });
    const created: string[] = [];
    const refsByHash = new Map<string, SyncAttachmentRef>();
    try {
      const refs: SyncAttachmentRef[] = [];
      for (const { input, buffer } of decoded) {
        const sha256 = createHash("sha256").update(buffer).digest("hex");
        const existing = refsByHash.get(sha256);
        if (existing) {
          refs.push(existing);
          continue;
        }
        const file = join(dir, sha256);
        // 内容寻址：同 hash 文件已存在即跳过（跨重试/跨批次幂等去重）。
        let alreadyOnDisk = false;
        try {
          await readFile(file);
          alreadyOnDisk = true;
        } catch {
          // 不存在 → 走临时文件 + 原子 rename。
        }
        if (!alreadyOnDisk) {
          const tmp = join(dir, `tmp-${process.pid}-${randomBytes(6).toString("hex")}`);
          await writeFile(tmp, buffer);
          await rename(tmp, file);
          created.push(file);
        }
        const ref: SyncAttachmentRef = {
          mime: input.mime,
          url: `/api/hub/sessions/${encodeURIComponent(sessionId)}/attachments/${sha256}`,
          sha256,
          bytes: buffer.byteLength,
          ...(input.name ? { name: input.name } : {}),
        };
        refsByHash.set(sha256, ref);
        refs.push(ref);
      }
      return refs;
    } catch (error) {
      // 回滚本轮新建文件；已存在的去重文件与其他会话目录不动。
      await Promise.all(created.map((file) => rm(file, { force: true }).catch(() => undefined)));
      if (error instanceof SyncAttachmentError) throw error;
      throw new SyncAttachmentError(
        "attachment_invalid",
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  /** 读取附件；hash 格式非法或文件不存在返回 null（路由映射 400/404）。 */
  async read(
    host: string,
    agent: string,
    sessionId: string,
    hash: string,
  ): Promise<Buffer | null> {
    if (!HASH_PATTERN.test(hash)) return null;
    const file = join(this.sessionDir(host, agent, sessionId), hash);
    try {
      return await readFile(file);
    } catch {
      return null;
    }
  }

  /** 会话级附件目录清理（幂等）；供会话删除/GC 钩子调用（当前无删除 API，能力位预留）。 */
  async cleanupSession(host: string, agent: string, sessionId: string): Promise<void> {
    await rm(this.sessionDir(host, agent, sessionId), { recursive: true, force: true })
      .catch(() => undefined);
  }
}
