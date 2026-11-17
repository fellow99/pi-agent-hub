import { randomUUID } from "node:crypto";
import {
  MODEL_INFO_LIMITS,
  type ModelInfoError,
  type ModelInfoRequestRecord,
} from "@pi-agent-hub/protocol";

/**
 * 006 Model Info 请求态机（纯内存，hub 重启即失）。
 *
 * 生命周期：dispatched ->（ack）accepted ->（result ok）completed /（result !ok）failed；
 * 60s 未达终态惰性置 expired；终态记录保留 5 分钟后惰性删除。无后台定时器。
 * 与 005 FsRequestStore 同构，差异：记录带 agentId/sessionId，result 先经服务层脱敏。
 */

const TERMINAL_STATES = new Set(["completed", "failed", "expired"]);

export type StoreOutcome = "ok" | "not_found" | "host_mismatch";

export interface CreateModelInfoInput {
  hostId: string;
  agentId: string;
  sessionId: string;
}

export class ModelInfoStore {
  private readonly records = new Map<string, ModelInfoRequestRecord>();

  create(input: CreateModelInfoInput, now = Date.now()): ModelInfoRequestRecord {
    return this.createWithId(`mri_${randomUUID()}`, input, now);
  }

  /** 带显式 requestId 的创建（路由先于 SSE 发送取 id，保证事件与记录同 id）。 */
  createWithId(requestId: string, input: CreateModelInfoInput, now = Date.now()): ModelInfoRequestRecord {
    this.evictIfNeeded(now);
    const record: ModelInfoRequestRecord = {
      requestId,
      hostId: input.hostId,
      agentId: input.agentId,
      sessionId: input.sessionId,
      state: "dispatched",
      createdAt: now,
    };
    this.records.set(requestId, record);
    return record;
  }

  /** 惰性生命周期判定：TTL expired、终态保留期删除。 */
  get(requestId: string, now = Date.now()): ModelInfoRequestRecord | undefined {
    const record = this.records.get(requestId);
    if (!record) return undefined;
    if (TERMINAL_STATES.has(record.state)) {
      if (record.finishedAt !== undefined && now - record.finishedAt > MODEL_INFO_LIMITS.resultRetentionMs) {
        this.records.delete(requestId);
        return undefined;
      }
      return record;
    }
    if (now - record.createdAt > MODEL_INFO_LIMITS.requestTtlMs) {
      record.state = "expired";
      record.finishedAt = now;
    }
    return record;
  }

  ack(requestId: string, hostId: string, now = Date.now()): StoreOutcome {
    const record = this.records.get(requestId);
    if (!record) return "not_found";
    if (record.hostId !== hostId) return "host_mismatch";
    if (record.state === "dispatched") {
      record.state = "accepted";
      record.acceptedAt = now;
    }
    return "ok";
  }

  /**
   * result 落态。payload 已由服务层 sanitizeModelInfoResult 脱敏：
   * ok=true 的 result 已通过白名单，ok=false 的 error 为稳定错误码。
   */
  result(
    requestId: string,
    hostId: string,
    payload: { ok: true; result: ModelInfoRequestRecord["result"] }
      | { ok: false; error: ModelInfoError },
    now = Date.now(),
  ): StoreOutcome {
    const record = this.records.get(requestId);
    if (!record) return "not_found";
    if (record.hostId !== hostId) return "host_mismatch";
    if (TERMINAL_STATES.has(record.state)) return "ok";
    if (payload.ok) {
      record.state = "completed";
      record.result = payload.result;
    } else {
      record.state = "failed";
      record.error = payload.error;
    }
    record.finishedAt = now;
    return "ok";
  }

  private evictIfNeeded(now: number): void {
    let openCount = 0;
    let oldestOpen: { id: string; createdAt: number } | undefined;
    for (const [id, record] of this.records) {
      if (TERMINAL_STATES.has(record.state)) continue;
      openCount += 1;
      if (oldestOpen === undefined || record.createdAt < oldestOpen.createdAt) {
        oldestOpen = { id, createdAt: record.createdAt };
      }
    }
    if (openCount >= MODEL_INFO_LIMITS.maxOpenRecords && oldestOpen) {
      const evicted = this.records.get(oldestOpen.id);
      if (evicted) {
        evicted.state = "expired";
        evicted.finishedAt = now;
      }
    }
  }
}
