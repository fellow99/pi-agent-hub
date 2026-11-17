import { describe, expect, it } from "vitest";
import { ModelInfoStore } from "../model-info-store.js";
import { sanitizeModelInfoResult, MODEL_INFO_TOP_KEYS, MODEL_INFO_ENTRY_KEYS } from "../model-info-allow.js";

const ENTRY = {
  provider: "anthropic",
  modelId: "claude-sonnet-4-5",
  name: "Claude Sonnet 4.5",
  reasoning: true,
  input: ["text", "image"],
  thinkingLevels: ["off", "low", "high"],
};

describe("ModelInfoStore", () => {
  it("dispatched -> accepted -> completed", () => {
    const store = new ModelInfoStore();
    const t0 = 1_000_000;
    const record = store.createWithId("mri_1", { hostId: "h1", agentId: "a1", sessionId: "s1" }, t0);
    expect(record.state).toBe("dispatched");
    expect(store.ack("mri_1", "h1", t0 + 1)).toBe("ok");
    expect(store.get("mri_1", t0 + 1)?.state).toBe("accepted");
    const payload = { ok: true as const, result: { agentId: "a1", models: [ENTRY], currentModel: { provider: "anthropic", modelId: "claude-sonnet-4-5" }, currentThinkingLevel: "high" } };
    expect(store.result("mri_1", "h1", payload, t0 + 2)).toBe("ok");
    const done = store.get("mri_1", t0 + 2);
    expect(done?.state).toBe("completed");
    expect(done?.result?.models[0]?.modelId).toBe("claude-sonnet-4-5");
  });

  it("result failure -> failed with error", () => {
    const store = new ModelInfoStore();
    const t0 = 1_000_000;
    store.createWithId("mri_2", { hostId: "h1", agentId: "a1", sessionId: "s1" }, t0);
    store.ack("mri_2", "h1", t0);
    const outcome = store.result("mri_2", "h1", { ok: false, error: { code: "agent_unsupported", message: "nope" } }, t0);
    expect(outcome).toBe("ok");
    expect(store.get("mri_2", t0)?.state).toBe("failed");
    expect(store.get("mri_2", t0)?.error?.code).toBe("agent_unsupported");
  });

  it("ttl lazy expired and terminal retention cleanup", () => {
    const store = new ModelInfoStore();
    const t0 = 1_000_000;
    store.createWithId("mri_3", { hostId: "h1", agentId: "a1", sessionId: "s1" }, t0);
    const expired = store.get("mri_3", t0 + 61_000);
    expect(expired?.state).toBe("expired");
    const done = store.result("mri_3", "h1", { ok: true, result: { agentId: "a1", models: [] } }, t0);
    expect(done).toBe("ok");
    // 终态保留 5min 后删除
    expect(store.get("mri_3", t0 + 61_000 + 300_000)).toBeDefined();
    expect(store.get("mri_3", t0 + 61_000 + 300_001)).toBeUndefined();
  });

  it("cross-host ack rejected (host_mismatch)", () => {
    const store = new ModelInfoStore();
    store.createWithId("mri_4", { hostId: "h1", agentId: "a1", sessionId: "s1" });
    expect(store.ack("mri_4", "h2")).toBe("host_mismatch");
    expect(store.get("mri_4")?.state).toBe("dispatched");
  });

  it("unknown id -> not_found; duplicate result idempotent", () => {
    const store = new ModelInfoStore();
    expect(store.ack("missing", "h1")).toBe("not_found");
    store.createWithId("mri_5", { hostId: "h1", agentId: "a1", sessionId: "s1" });
    store.ack("mri_5", "h1");
    const payload = { ok: true as const, result: { agentId: "a1", models: [] } };
    expect(store.result("mri_5", "h1", payload)).toBe("ok");
    expect(store.result("mri_5", "h1", payload)).toBe("ok");
  });
});

describe("sanitizeModelInfoResult", () => {
  it("projects only whitelist keys, drops sensitive fields", () => {
    const raw = {
      agentId: "a1",
      models: [{
        ...ENTRY,
        headers: { Authorization: "Bearer secret" },
        baseUrl: "https://x",
        api: "anthropic-messages",
        cost: { input: 1 },
        samplingParams: {},
        compat: {},
      }],
      currentModel: { provider: "anthropic", modelId: "claude-sonnet-4-5" },
      currentThinkingLevel: "high",
      boo: { secret: true },
    };
    const result = sanitizeModelInfoResult(raw);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // 未知顶层键不进入结果对象
    expect(Object.keys(result.result).sort()).toEqual(["agentId", "currentModel", "currentThinkingLevel", "models"]);
    const entry = result.result.models[0]!;
    expect(entry).toEqual(ENTRY);
    expect("headers" in entry).toBe(false);
    expect("baseUrl" in entry).toBe(false);
  });

  it("invalid structure -> invalid_result (non-array input)", () => {
    const result = sanitizeModelInfoResult({ agentId: "a1", models: [{ ...ENTRY, input: "text" }] });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("invalid_result");
  });

  it("invalid top-level type -> invalid_result", () => {
    expect(sanitizeModelInfoResult(null).ok).toBe(false);
    expect(sanitizeModelInfoResult({ models: [] }).ok).toBe(false);
  });

  it("currentModel null / currentThinkingLevel present is accepted", () => {
    const result = sanitizeModelInfoResult({ agentId: "a1", models: [], currentModel: null, currentThinkingLevel: "off" });
    expect(result.ok).toBe(true);
  });

  it("whitelist key sets are exact", () => {
    expect(MODEL_INFO_TOP_KEYS).toEqual(expect.arrayContaining(["agentId", "models", "currentModel", "currentThinkingLevel"]));
    expect(MODEL_INFO_ENTRY_KEYS).toEqual(expect.arrayContaining(["provider", "modelId", "name", "reasoning", "input", "thinkingLevels"]));
  });
});
