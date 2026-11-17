import type { ModelInfoEntry, ModelInfoError, ModelInfoResult } from "@pi-agent-hub/protocol";

/**
 * 006 模型信息结果脱敏（白名单投影纯函数）。
 *
 * daemon 侧插件负责最小投影，但 hub 仍需兜底校验：插件可能越界透传
 * headers/baseUrl/cost/api/samplingParams 等含凭据或实现细节的字段。
 * 本模块只保留模型目录必需的字段，其它一律丢弃；结构不符 → invalid_result。
 *
 * 顶层允许：agentId / models / currentModel / currentThinkingLevel
 * models[] 每项允许：provider / modelId / name / reasoning / input / thinkingLevels
 */

const TOP_KEYS = new Set(["agentId", "models", "currentModel", "currentThinkingLevel"]);
const ENTRY_KEYS = new Set(["provider", "modelId", "name", "reasoning", "input", "thinkingLevels"]);

export type SanitizedModelInfo =
  | { ok: true; result: ModelInfoResult }
  | { ok: false; error: ModelInfoError };

export function sanitizeModelInfoResult(raw: unknown): SanitizedModelInfo {
  if (!isPlainObject(raw)) {
    return invalid("model info result must be an object");
  }

  const agentId = raw.agentId;
  if (typeof agentId !== "string" || agentId.length === 0) {
    return invalid("agentId must be a non-empty string");
  }

  let models: ModelInfoEntry[];
  if (Array.isArray(raw.models)) {
    const entries: ModelInfoEntry[] = [];
    for (const item of raw.models) {
      const entry = sanitizeEntry(item);
      if (entry === null) return invalid("models entry failed structure validation");
      entries.push(entry);
    }
    models = entries;
  } else {
    models = [];
  }

  let currentModel: ModelInfoResult["currentModel"];
  if (raw.currentModel === undefined || raw.currentModel === null) {
    currentModel = null;
  } else if (isPlainObject(raw.currentModel)) {
    if (typeof raw.currentModel.provider !== "string" || typeof raw.currentModel.modelId !== "string") {
      return invalid("currentModel must be {provider, modelId}");
    }
    currentModel = { provider: raw.currentModel.provider, modelId: raw.currentModel.modelId };
  } else {
    return invalid("currentModel must be an object or null");
  }

  const currentThinkingLevel = raw.currentThinkingLevel === undefined || raw.currentThinkingLevel === null
    ? null
    : raw.currentThinkingLevel;
  if (currentThinkingLevel !== null && typeof currentThinkingLevel !== "string") {
    return invalid("currentThinkingLevel must be a string or null");
  }

  return {
    ok: true,
    result: {
      agentId,
      models,
      currentModel,
      currentThinkingLevel,
    },
  };
}

function sanitizeEntry(raw: unknown): ModelInfoEntry | null {
  if (!isPlainObject(raw)) return null;
  const { provider, modelId, name } = raw;
  if (typeof provider !== "string" || provider.length === 0) return null;
  if (typeof modelId !== "string" || modelId.length === 0) return null;
  if (typeof name !== "string" || name.length === 0) return null;
  if (typeof raw.reasoning !== "boolean") return null;
  if (!Array.isArray(raw.input) || !raw.input.every((item) => typeof item === "string")) return null;
  if (!Array.isArray(raw.thinkingLevels) || !raw.thinkingLevels.every((item) => typeof item === "string")) return null;
  // 显式只拷贝白名单键，杜绝越界透传。
  return {
    provider,
    modelId,
    name,
    reasoning: raw.reasoning,
    input: [...raw.input],
    thinkingLevels: [...raw.thinkingLevels],
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalid(message: string): SanitizedModelInfo {
  return { ok: false, error: { code: "invalid_result", message } };
}

// 暴露键集合便于测试断言白名单覆盖。
export const MODEL_INFO_TOP_KEYS = [...TOP_KEYS];
export const MODEL_INFO_ENTRY_KEYS = [...ENTRY_KEYS];
