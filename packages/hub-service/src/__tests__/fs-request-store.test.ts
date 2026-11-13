import { describe, expect, it } from "vitest";
import { FsRequestStore } from "../fs-request-store.js";
import type { DirListingResult } from "@pi-agent-hub/protocol";

const T0 = 1_000_000;
const listing: DirListingResult = { path: "D:\\pi-workspace", entries: [], truncated: false };

describe("FsRequestStore 状态机", () => {
  it("正常迁移 dispatched -> accepted -> completed", () => {
    const store = new FsRequestStore();
    const record = store.create({ hostId: "h1", kind: "list_dir", path: "D:\\p" }, T0);
    expect(record.state).toBe("dispatched");

    expect(store.ack(record.requestId, "h1", T0 + 100)).toBe("ok");
    expect(store.get(record.requestId, T0 + 200)?.state).toBe("accepted");
    expect(store.get(record.requestId, T0 + 200)?.acceptedAt).toBe(T0 + 100);

    expect(store.result(record.requestId, "h1", { ok: true, result: listing }, T0 + 300)).toBe("ok");
    const done = store.get(record.requestId, T0 + 400);
    expect(done?.state).toBe("completed");
    expect(done?.result).toEqual(listing);
    expect(done?.finishedAt).toBe(T0 + 300);
  });

  it("result 失败迁移 failed 并保存 error", () => {
    const store = new FsRequestStore();
    const record = store.create({ hostId: "h1", kind: "read_file", path: "D:\\p\\a.ts" }, T0);
    const outcome = store.result(
      record.requestId,
      "h1",
      { ok: false, error: { code: "denied", message: "blocked" } },
      T0 + 500,
    );
    expect(outcome).toBe("ok");
    const failed = store.get(record.requestId, T0 + 600);
    expect(failed?.state).toBe("failed");
    expect(failed?.error?.code).toBe("denied");
  });

  it("60s 未终态惰性 expired", () => {
    const store = new FsRequestStore();
    const record = store.create({ hostId: "h1", kind: "list_dir", path: "D:\\p" }, T0);
    expect(store.get(record.requestId, T0 + 59_999)?.state).toBe("dispatched");
    expect(store.get(record.requestId, T0 + 60_001)?.state).toBe("expired");
  });

  it("终态记录保留 5 分钟后惰性删除", () => {
    const store = new FsRequestStore();
    const record = store.create({ hostId: "h1", kind: "list_dir", path: "D:\\p" }, T0);
    store.result(record.requestId, "h1", { ok: true, result: listing }, T0 + 1_000);
    expect(store.get(record.requestId, T0 + 1_000)).toBeDefined();
    expect(store.get(record.requestId, T0 + 1_000 + 300_001)).toBeUndefined();
  });

  it("未知 id 返回 undefined（路由层 404）", () => {
    expect(new FsRequestStore().get("fsr_nonexistent", T0)).toBeUndefined();
  });

  it("跨 host ack/result 拒绝且不改变状态", () => {
    const store = new FsRequestStore();
    const record = store.create({ hostId: "host-a", kind: "list_dir", path: "D:\\p" }, T0);
    expect(store.ack(record.requestId, "host-b", T0)).toBe("host_mismatch");
    expect(store.get(record.requestId, T0)?.state).toBe("dispatched");
    expect(
      store.result(record.requestId, "host-b", { ok: true, result: listing }, T0),
    ).toBe("host_mismatch");
    expect(store.get(record.requestId, T0)?.state).toBe("dispatched");
  });

  it("重复 ack 幂等不回退，终态后 result 忽略", () => {
    const store = new FsRequestStore();
    const record = store.create({ hostId: "h1", kind: "list_dir", path: "D:\\p" }, T0);
    store.ack(record.requestId, "h1", T0 + 10);
    store.ack(record.requestId, "h1", T0 + 20);
    expect(store.get(record.requestId, T0 + 20)?.acceptedAt).toBe(T0 + 10);
    store.result(record.requestId, "h1", { ok: true, result: listing }, T0 + 30);
    store.result(
      record.requestId,
      "h1",
      { ok: false, error: { code: "daemon_error", message: "late" } },
      T0 + 40,
    );
    expect(store.get(record.requestId, T0 + 40)?.state).toBe("completed");
  });

  it("createWithId 保留外部指定 id", () => {
    const store = new FsRequestStore();
    const record = store.createWithId("fsr_fixed", { hostId: "h1", kind: "list_dir", path: "D:\\p" }, T0);
    expect(record.requestId).toBe("fsr_fixed");
    expect(store.get("fsr_fixed", T0)?.requestId).toBe("fsr_fixed");
  });
});
