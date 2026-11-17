import {
  type DeliverImageUrl,
  type DeliveryPolicy,
} from "@pi-agent-hub/protocol";
import type { SseHub } from "./sse.js";

/**
 * 007 下发聊天消息：hub 侧 delivery 持久化 + 态机 + 重投。
 *
 * 态机：queued → dispatched → accepted → completed | failed
 *       （宿主离线时保持 queued；ack 60s / result 10min 超时惰性判定，attempt≤5 重投，超限 expired；
 *        仅 queued/dispatched 可 canceled）
 *
 * 执行顺序与重投都在内存态机内惰性处理（配合 GET 轮询触发），DB 只做持久化与查询。
 * 同一 session 的多次 dispatch 经 per-session 队列串行，避免并发 sse.send 交错。
 */

export interface DeliveryRow {
  id: string;
  host_id: string;
  agent_id: string | null;
  session_id: string;
  native_session_id: string | null;
  text: string | null;
  images_json: string | null;
  model_provider: string | null;
  model_id: string | null;
  thinking_level: string | null;
  policy: string | null;
  force: number;
  state: string;
  attempts: number;
  created_at: number;
  dispatched_at: number | null;
  accepted_at: number | null;
  settled_at: number | null;
  native_message_id: string | null;
  error: string | null;
  idempotency_key: string | null;
}

/** console 可见的交付视图（207 api.ts 同形）。 */
export interface DeliveryView {
  deliveryId: string;
  state: string;
  sessionId: string;
  error?: { code: string; message: string };
  warnings?: string[];
}

export interface CreateDeliveryInput {
  deliveryId: string;
  hostId: string;
  agentId: string;
  sessionId: string;
  nativeSessionId: string;
  text: string;
  images: DeliverImageUrl[];
  model?: { provider: string; modelId: string } | null;
  thinkingLevel?: string | null;
  policy: DeliveryPolicy;
  force: boolean;
  idempotencyKey?: string;
}

const ACK_TTL_MS = 60_000;
const RESULT_TTL_MS = 10 * 60_000;
const MAX_ATTEMPTS = 5;
const TERMINAL = new Set(["completed", "failed", "expired", "canceled"]);

export type DeliveryOutcome = "ok" | "not_found" | "host_mismatch";

/**
 * deliveries 的持久化依赖：结构型接口（DatabaseSync 天然满足；单测可用内存 fake 替代，
 * 规避 vitest 对 node:sqlite 的解析问题）。
 */
export interface DeliveryDb {
  prepare(sql: string): {
    get(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
    run(...params: unknown[]): unknown;
  };
}

export class Deliveries {
  /** per-session 串行链：key = sessionId，dispatch 按链排队。 */
  private readonly dispatchChains = new Map<string, Promise<unknown>>();

  constructor(
    private readonly db: DeliveryDb,
    private readonly sse: SseHub,
  ) {}

  private rowToView(row: DeliveryRow): DeliveryView {
    const view: DeliveryView = {
      deliveryId: row.id,
      state: row.state,
      sessionId: row.session_id,
    };
    if (row.error) {
      try {
        const parsed = JSON.parse(row.error) as { code: string; message: string; warnings?: string[] };
        view.error = { code: parsed.code, message: parsed.message };
        if (Array.isArray(parsed.warnings)) view.warnings = parsed.warnings;
      } catch {
        view.error = { code: "agent_error", message: row.error };
      }
    }
    return view;
  }

  getView(id: string): DeliveryView | null {
    const row = this.getRow(id);
    return row ? this.rowToView(row) : null;
  }

  /** 按幂等键查询（未终态的复用记录）。 */
  findByKey(idempotencyKey: string): DeliveryRow | null {
    const row = this.db.prepare("SELECT * FROM deliveries WHERE idempotency_key = ?").get(idempotencyKey);
    return row === undefined ? null : row as unknown as DeliveryRow;
  }

  getRow(id: string, now = Date.now()): DeliveryRow | null {
    const row = this.db.prepare("SELECT * FROM deliveries WHERE id = ?").get(id);
    if (row === undefined) return null;
    const record = row as unknown as DeliveryRow;
    this.reconcile(record, now);
    return record;
  }


  listPending(hostId: string, limit = 100): DeliveryRow[] {
    return this.db
      .prepare("SELECT * FROM deliveries WHERE host_id = ? AND state = 'queued' ORDER BY created_at ASC LIMIT ?")
      .all(hostId, limit) as unknown as DeliveryRow[];
  }

  async create(input: CreateDeliveryInput, now = Date.now()): Promise<DeliveryView> {
    const row: DeliveryRow = {
      id: input.deliveryId,
      host_id: input.hostId,
      agent_id: input.agentId,
      session_id: input.sessionId,
      native_session_id: input.nativeSessionId,
      text: input.text,
      images_json: input.images.length > 0 ? JSON.stringify(input.images) : null,
      model_provider: input.model?.provider ?? null,
      model_id: input.model?.modelId ?? null,
      thinking_level: input.thinkingLevel ?? null,
      policy: input.policy,
      force: input.force ? 1 : 0,
      state: "queued",
      attempts: 1,
      created_at: now,
      dispatched_at: null,
      accepted_at: null,
      settled_at: null,
      native_message_id: null,
      error: null,
      idempotency_key: input.idempotencyKey ?? null,
    };
    this.db.prepare(`
      INSERT INTO deliveries (id, host_id, agent_id, session_id, native_session_id, text, images_json,
        model_provider, model_id, thinking_level, policy, force, state, attempts, created_at, idempotency_key)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      row.id, row.host_id, row.agent_id, row.session_id, row.native_session_id, row.text, row.images_json,
      row.model_provider, row.model_id, row.thinking_level, row.policy, row.force, row.state, row.attempts,
      row.created_at, row.idempotency_key,
    );
    await this.dispatch(input.deliveryId, input.agentId, input.nativeSessionId, now);
    return this.getView(input.deliveryId)!;
  }

  /** 经 per-session 链串行发送；成功后置 dispatched。 */
  private dispatch(deliveryId: string, agentId: string, nativeSessionId: string, now = Date.now()): Promise<unknown> {
    const row = this.db.prepare("SELECT session_id FROM deliveries WHERE id = ?").get(deliveryId) as { session_id: string } | undefined;
    if (!row) return Promise.resolve();
    const sessionId = row.session_id;
    const previous = this.dispatchChains.get(sessionId) ?? Promise.resolve();
    const next = previous.then(() => {
      const current = this.db.prepare("SELECT state FROM deliveries WHERE id = ?").get(deliveryId) as { state: string } | undefined;
      // 可发送态：queued（初次）与 dispatched（ack 超时重投）都重发；accepted/终态不再发送。
      if (!current || current.state === "accepted" || TERMINAL.has(current.state)) return;
      const record = this.db.prepare("SELECT * FROM deliveries WHERE id = ?").get(deliveryId) as unknown as DeliveryRow;
      const images = record.images_json ? JSON.parse(record.images_json) as DeliverImageUrl[] : [];
      const sent = this.sse.send(record.host_id, "deliver", {
        deliveryId,
        agentId,
        nativeSessionId,
        hubSessionId: record.session_id,
        message: record.text ?? "",
        images,
        model: record.model_provider && record.model_id
          ? { provider: record.model_provider, modelId: record.model_id }
          : null,
        thinkingLevel: record.thinking_level,
        policy: record.policy ?? "idle-only",
        force: record.force === 1,
        attempt: record.attempts,
        createdAt: record.created_at,
        expiresAt: now + RESULT_TTL_MS,
      });
      if (sent) {
        this.db.prepare("UPDATE deliveries SET state = 'dispatched', dispatched_at = ? WHERE id = ?").run(now, deliveryId);
      }
    }).catch(() => undefined);
    this.dispatchChains.set(sessionId, next);
    return next;
  }

  cancel(id: string): "ok" | "not_found" | "not_cancellable" {
    const row = this.db.prepare("SELECT state FROM deliveries WHERE id = ?").get(id) as { state: string } | undefined;
    if (!row) return "not_found";
    if (row.state !== "queued" && row.state !== "dispatched") return "not_cancellable";
    this.db.prepare("UPDATE deliveries SET state = 'canceled', settled_at = ? WHERE id = ?").run(Date.now(), id);
    return "ok";
  }

  ack(id: string, hostId: string, now = Date.now()): DeliveryOutcome {
    const row = this.db.prepare("SELECT host_id, state FROM deliveries WHERE id = ?").get(id) as { host_id: string; state: string } | undefined;
    if (!row) return "not_found";
    if (row.host_id !== hostId) return "host_mismatch";
    if (row.state === "dispatched") {
      this.db.prepare("UPDATE deliveries SET state = 'accepted', accepted_at = ? WHERE id = ?").run(now, id);
    }
    return "ok";
  }

  result(id: string, hostId: string, body: { ok: boolean; result?: { state: string; nativeMessageId?: string; warnings?: string[] }; error?: { code: string; message: string; retryable?: boolean } }, now = Date.now()): DeliveryOutcome {
    const row = this.db.prepare("SELECT host_id, state FROM deliveries WHERE id = ?").get(id) as { host_id: string; state: string } | undefined;
    if (!row) return "not_found";
    if (row.host_id !== hostId) return "host_mismatch";
    if (TERMINAL.has(row.state)) return "ok";
    if (body.ok) {
      this.db.prepare(`
        UPDATE deliveries SET state = 'completed', settled_at = ?, native_message_id = ?, error = ? WHERE id = ?
      `).run(now, body.result?.nativeMessageId ?? null, this.jsonError(body.result?.warnings), id);
    } else {
      this.db.prepare("UPDATE deliveries SET state = 'failed', settled_at = ?, error = ? WHERE id = ?")
        .run(now, JSON.stringify({ code: body.error?.code ?? "agent_error", message: body.error?.message ?? "delivery failed", warnings: body.result?.warnings }), id);
    }
    return "ok";
  }

  /** 惰性生命周期：ack/result 超时 + attempt 重投。GET 轮询命中时触发。 */
  private reconcile(row: DeliveryRow, now: number): void {
    if (TERMINAL.has(row.state)) return;
    if (row.state === "accepted") {
      const since = row.accepted_at ?? row.created_at;
      if (now - since > RESULT_TTL_MS) {
        this.db.prepare("UPDATE deliveries SET state = 'expired', settled_at = ? WHERE id = ?").run(now, row.id);
      }
      return;
    }
    // queued / dispatched：ack 超时重投
    const since = row.dispatched_at ?? row.created_at;
    if (now - since <= ACK_TTL_MS) return;
    if (row.attempts >= MAX_ATTEMPTS) {
      this.db.prepare("UPDATE deliveries SET state = 'expired', settled_at = ? WHERE id = ?").run(now, row.id);
      return;
    }
    if (row.agent_id && row.native_session_id) {
      this.db.prepare("UPDATE deliveries SET attempts = attempts + 1 WHERE id = ?").run(row.id);
      void this.dispatch(row.id, row.agent_id, row.native_session_id, now);
    }
  }

  private jsonError(warnings?: string[]): string | null {
    if (!warnings || warnings.length === 0) return null;
    return JSON.stringify({ code: "ok", message: "ok", warnings });
  }
}
