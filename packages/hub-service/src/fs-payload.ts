import type { FsErrorCode, FsResultData, FsResultPayload } from "@pi-agent-hub/protocol";

/** 005：daemon 侧允许回传的错误码集合（不含仅 hub 产生的 csrf/role 类）。 */
export const FS_ERROR_CODES = new Set<string>([
  "not_found",
  "denied",
  "denied_all",
  "not_a_directory",
  "not_a_file",
  "file_too_large",
  "binary_unsupported",
  "text_decode_failed",
  "daemon_error",
]);

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 005：校验 daemon FS result 回传体形状（判别联合）。
 * list_dir 结果携带 entries（无 type）；read_file 结果携带 type；二者公共字段为 path。
 */
export function parseFsResultPayload(body: unknown): FsResultPayload | undefined {
  if (!isPlainRecord(body) || typeof body.ok !== "boolean") return undefined;
  if (body.ok) {
    const result = body.result;
    const hasListShape = isPlainRecord(result) && typeof result.path === "string"
      && Array.isArray(result.entries);
    const hasFileShape = isPlainRecord(result) && typeof result.path === "string"
      && typeof result.type === "string";
    if (!hasListShape && !hasFileShape) {
      return undefined;
    }
    // 结构形状已校验；具体判别成员由 daemon 端按 kind 保证，hub 仅透传存储。
    return { ok: true, result: result as unknown as FsResultData };
  }
  const error = body.error;
  if (
    isPlainRecord(error)
    && typeof error.code === "string" && FS_ERROR_CODES.has(error.code)
    && typeof error.message === "string"
  ) {
    return { ok: false, error: { code: error.code as FsErrorCode, message: error.message } };
  }
  return undefined;
}
