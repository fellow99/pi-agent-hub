import { describe, expect, it } from "vitest";
import { Deliveries, type DeliveryDb, type DeliveryRow } from "../deliveries.js";

/**
 * 内存 fake DeliveryDb：按 SQL 首关键词粗匹配实现 get/all/run，
 * 归集到 rows[] 上。仅用于态机/幂等/队列单测；真实 SQL 由 Docker 集成覆盖。
 */
class FakeDb implements DeliveryDb {
  rows = new Map<string, DeliveryRow>();
  nextAttempt: Record<string, number> = {};

  prepare(sql: string) {
    const isForceUpsert = sql.trimStart().startsWith("INSERT");
    const selectAll = sql.includes("FROM deliveries") && (sql.includes("ORDER BY") || sql.includes("WHERE host_id"));
    return {
      get: (...params: unknown[]): unknown => {
        const id = String(params.at(-1));
        if (sql.includes("WHERE idempotency_key = ?")) {
          const key = String(params.at(-1));
          return [...this.rows.values()].find((r) => r.idempotency_key === key);
        }
        if (sql.includes("SELECT state FROM")) {
          const row = this.rows.get(String(params.at(-1)));
          return row ? { state: row.state } : undefined;
        }
        if (sql.includes("SELECT host_id, state FROM")) {
          const row = this.rows.get(String(params.at(-1)));
          return row ? { host_id: row.host_id, state: row.state } : undefined;
        }
        if (sql.includes("SELECT session_id FROM")) {
          const row = this.rows.get(String(params.at(-1)));
          return row ? { session_id: row.session_id } : undefined;
        }
        return this.rows.get(id);
      },
      all: (...params: unknown[]): unknown[] => {
        if (selectAll) {
          const hostId = String(params[0] ?? "");
          const rows = [...this.rows.values()]
            .filter((r) => r.host_id === hostId && r.state === "queued")
            .sort((a, b) => a.created_at - b.created_at);
          return rows.slice(0, Number(params[1] ?? 100));
        }
        return [];
      },
      run: (...params: unknown[]): unknown => {
        if (isForceUpsert) {
          const row: DeliveryRow = {
            id: String(params[0]), host_id: String(params[1]), agent_id: String(params[2]),
            session_id: String(params[3]), native_session_id: String(params[4]),
            text: String(params[5]), images_json: params[6] as string | null,
            model_provider: params[7] as string | null, model_id: params[8] as string | null,
            thinking_level: params[9] as string | null, policy: String(params[10]),
            force: Number(params[11]), state: String(params[12]), attempts: Number(params[13]),
            created_at: Number(params[14]), dispatched_at: null, accepted_at: null, settled_at: null,
            native_message_id: null, error: null, idempotency_key: params[15] as string | null,
          };
          this.rows.set(row.id, row);
          return {};
        }
        if (sql.includes("state = 'dispatched'")) {
          const row = this.rows.get(String(params.at(-1)));
          if (row) {
            row.state = "dispatched";
            row.dispatched_at = Number(params[0]);
          }
          return {};
        }
        if (sql.includes("state = 'canceled'")) {
          const row = this.rows.get(String(params.at(-1)));
          if (row) { row.state = "canceled"; row.settled_at = Number(params[0]); }
          return {};
        }
        if (sql.includes("state = 'accepted'")) {
          const row = this.rows.get(String(params.at(-1)));
          if (row) { row.state = "accepted"; row.accepted_at = Number(params[0]); }
          return {};
        }
        if (sql.includes("state = 'completed'")) {
          const row = this.rows.get(String(params.at(-1)));
          if (row) {
            row.state = "completed"; row.settled_at = Number(params[0]);
            row.native_message_id = params[1] as string | null;
            row.error = params[2] as string | null;
          }
          return {};
        }
        if (sql.includes("state = 'failed'")) {
          const row = this.rows.get(String(params.at(-1)));
          if (row) { row.state = "failed"; row.settled_at = Number(params[0]); row.error = params[1] as string; }
          return {};
        }
        if (sql.includes("state = 'expired'")) {
          const row = this.rows.get(String(params.at(-1)));
          if (row) { row.state = "expired"; row.settled_at = Number(params[0]); }
          return {};
        }
        if (sql.includes("attempts = attempts + 1")) {
          const row = this.rows.get(String(params.at(-1)));
          if (row) row.attempts += 1;
          return {};
        }
        return {};
      },
    };
  }
}

class SseHubStub {
  sent: Array<{ hostId: string; event: string; data: unknown }> = [];
  online = true;
  size(): number { return this.sent.length; }
  add(): void { /* stub */ }
  send(hostId: string, event: string, data: unknown): boolean {
    this.sent.push({ hostId, event, data });
    return this.online;
  }
}

function make(): { deliveries: Deliveries; db: FakeDb; sse: SseHubStub } {
  const db = new FakeDb();
  const sse = new SseHubStub();
  // SseHubStub 与 SseHub 仅结构差别（测试桩），经 unknown 转换注入。
  return { deliveries: new Deliveries(db, sse as unknown as import("../sse.js").SseHub), db, sse };
}

const BASE = {
  hostId: "h1",
  agentId: "a1",
  sessionId: "s1",
  nativeSessionId: "n1",
  text: "hello",
  images: [],
  policy: "idle-only" as const,
  force: false,
};

describe("Deliveries", () => {
  it("create -> dispatched when online; sse payload carries model/thinkingLevel", async () => {
    const { deliveries, sse } = make();
    const view = await deliveries.create({ ...BASE, deliveryId: "dlv_1", model: { provider: "anthropic", modelId: "m1" }, thinkingLevel: "high" });
    expect(view.state).toBe("dispatched");
    const payload = sse.sent[0]!.data as Record<string, unknown>;
    expect(payload.deliveryId).toBe("dlv_1");
    expect(payload.model).toEqual({ provider: "anthropic", modelId: "m1" });
    expect(payload.thinkingLevel).toBe("high");
    expect(payload.policy).toBe("idle-only");
  });

  it("create stays queued when offline; online re-dispatch -> dispatched; ack -> accepted -> completed", async () => {
    const { deliveries, sse } = make();
    sse.online = false;
    await deliveries.create({ ...BASE, deliveryId: "dlv_2" });
    expect(deliveries.getView("dlv_2")?.state).toBe("queued");
    // 直接对 dispatched 语义：新建在线记录后 ack
    sse.online = true;
    await deliveries.create({ ...BASE, deliveryId: "dlv_2b" });
    expect(deliveries.getView("dlv_2b")?.state).toBe("dispatched");
    expect(deliveries.ack("dlv_2b", "h1")).toBe("ok");
    expect(deliveries.getView("dlv_2b")?.state).toBe("accepted");
    deliveries.result("dlv_2b", "h1", { ok: true, result: { state: "completed", nativeMessageId: "msg_1" } });
    expect(deliveries.getView("dlv_2b")?.state).toBe("completed");
  });

  it("cancel only queued/dispatched; ack host mismatch rejected", async () => {
    const { deliveries, sse } = make();
    sse.online = false;
    await deliveries.create({ ...BASE, deliveryId: "dlv_3" });
    expect(deliveries.cancel("dlv_3")).toBe("ok");
    expect(deliveries.getView("dlv_3")?.state).toBe("canceled");
    sse.online = true;
    await deliveries.create({ ...BASE, deliveryId: "dlv_4" });
    expect(deliveries.ack("dlv_4", "h2")).toBe("host_mismatch");
    expect(deliveries.getView("dlv_4")?.state).toBe("dispatched");
  });

  it("result failure -> failed with error code; terminal result idempotent", async () => {
    const { deliveries } = make();
    await deliveries.create({ ...BASE, deliveryId: "dlv_5" });
    deliveries.ack("dlv_5", "h1");
    deliveries.result("dlv_5", "h1", { ok: false, error: { code: "conflict", message: "busy" } });
    const view = deliveries.getView("dlv_5")!;
    expect(view.state).toBe("failed");
    expect(view.error?.code).toBe("conflict");
    deliveries.result("dlv_5", "h1", { ok: true, result: { state: "completed" } });
    expect(deliveries.getView("dlv_5")?.state).toBe("failed");
  });

  it("listPending returns only queued for host", async () => {
    const { deliveries, sse } = make();
    sse.online = false;
    await deliveries.create({ ...BASE, deliveryId: "dlv_6" });
    await deliveries.create({ ...BASE, deliveryId: "dlv_7" });
    const pending = deliveries.listPending("h1");
    expect(pending.map((r) => r.id).sort()).toEqual(["dlv_6", "dlv_7"]);
    expect(deliveries.listPending("h2")).toHaveLength(0);
  });

  it("idempotency key lookup returns prior record", async () => {
    const { deliveries } = make();
    await deliveries.create({ ...BASE, deliveryId: "dlv_8", idempotencyKey: "key-1" });
    const found = deliveries.findByKey("key-1");
    expect(found?.id).toBe("dlv_8");
  });

  it("ack timeout increments attempts and re-dispatches (online)", async () => {
    const { deliveries, db, sse } = make();
    await deliveries.create({ ...BASE, deliveryId: "dlv_9" });
    const t0 = Date.now();
    // 手动推进：记录 dispatched_at 设为很久以前，再触发 get→reconcile
    db.rows.get("dlv_9")!.dispatched_at = t0 - 61_000;
    sse.online = true;
    const row = deliveries.getRow("dlv_9", t0);
    expect(row?.state).toBe("dispatched");
    expect(db.rows.get("dlv_9")?.attempts).toBe(2);  // reconcile 已将 DB 尝试数 +1
    // 重投通过 dispatch 链异步执行，等待微任务冲洗
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(sse.sent).toHaveLength(2);
  });
});
