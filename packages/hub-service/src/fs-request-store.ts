import { randomUUID } from "node:crypto";
import {
  FS_LIMITS,
  type FsRequestKind,
  type FsRequestRecord,
  type FsResultPayload,
} from "@pi-agent-hub/protocol";

/**
 * 005 FS Bridge 请求态机（纯内存，hub 重启即失）。
 *
 * 生命周期：dispatched ->（ack）accepted ->（result ok）completed /（result !ok）failed；
 * 60s 未达终态惰性置 expired；终态记录保留 5 分钟后惰性删除。无后台定时器。
 */

/** 打开态记录软上限：超出时淘汰最老非终态记录，防止异常轮询/下发导致内存膨胀。 */
const MAX_OPEN_RECORDS = 10_000;

export type StoreOutcome = "ok" | "not_found" | "host_mismatch";

const TERMINAL_STATES = new Set(["completed", "failed", "expired"]);

export class FsRequestStore {
  private readonly records = new Map<string, FsRequestRecord>();

  create(input: { hostId: string; kind: FsRequestKind; path: string }, now = Date.now()): FsRequestRecord {
    this.evictIfNeeded(now);
    const record: FsRequestRecord = {
      requestId: `fsr_${randomUUID()}`,
      hostId: input.hostId,
      kind: input.kind,
      path: input.path,
      state: "dispatched",
      createdAt: now,
    };
    this.records.set(record.requestId, record);
    return record;
  }

  /** 带显式 requestId 的创建（路由先于 SSE 发送取 id，保证事件与记录同 id）。 */
  createWithId(
    requestId: string,
    input: { hostId: string; kind: FsRequestKind; path: string },
    now = Date.now(),
  ): FsRequestRecord {
    this.evictIfNeeded(now);
    const record: FsRequestRecord = {
      requestId,
      hostId: input.hostId,
      kind: input.kind,
      path: input.path,
      state: "dispatched",
      createdAt: now,
    };
    this.records.set(requestId, record);
    return record;
  }

  /** 惰性生命周期判定：TTL expired、终态保留期删除。 */
  get(requestId: string, now = Date.now()): FsRequestRecord | undefined {
    const record = this.records.get(requestId);
    if (!record) return undefined;
    if (TERMINAL_STATES.has(record.state)) {
      if (record.finishedAt !== undefined && now - record.finishedAt > FS_LIMITS.resultRetentionMs) {
        this.records.delete(requestId);
        return undefined;
      }
      return record;
    }
    if (now - record.createdAt > FS_LIMITS.requestTtlMs) {
      record.state = "expired";
      record.finishedAt = now;
    }
    return record;
  }

  ack(requestId: string, hostId: string, now = Date.now()): StoreOutcome {
    const record = this.records.get(requestId);
    if (!record) return "not_found";
    if (record.hostId !== hostId) return "host_mismatch";
    // 重复 ack 幂等：已 accepted/终态不回退。
    if (record.state === "dispatched") {
      record.state = "accepted";
      record.acceptedAt = now;
    }
    return "ok";
  }

  result(requestId: string, hostId: string, payload: FsResultPayload, now = Date.now()): StoreOutcome {
    const record = this.records.get(requestId);
    if (!record) return "not_found";
    if (record.hostId !== hostId) return "host_mismatch";
    // 终态后重复 result 幂等忽略。
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
    if (openCount >= MAX_OPEN_RECORDS && oldestOpen) {
      const evicted = this.records.get(oldestOpen.id);
      if (evicted) {
        evicted.state = "expired";
        evicted.finishedAt = now;
      }
    }
  }
}
