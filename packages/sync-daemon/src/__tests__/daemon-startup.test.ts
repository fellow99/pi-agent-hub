import { afterEach, describe, expect, it, vi } from "vitest";

// 事件连接是否在首次 syncAll 完成之前就被建立。
// 用一个 deferred 让首次 syncAll 永久挂起，模拟海量会话首次全量同步长时间不返回。
let syncAllDeferred: { promise: Promise<void>; resolve: () => void } | undefined;
let connectEventsCalls = 0;

vi.mock("../hub-client.js", () => {
  class HubClient {
    constructor(public config: unknown) {}
    async connectEvents(): Promise<void> {
      connectEventsCalls += 1;
      // 模拟 SSE 长连接：保持 pending，直到测试结束 abort。
      await new Promise<void>(() => {});
    }
  }
  return { HubClient };
});

vi.mock("../plugin-manager.js", () => {
  class PluginManager {
    async start(): Promise<void> {}
    list(): unknown[] {
      return [];
    }
    async stop(): Promise<void> {}
  }
  return { PluginManager };
});

vi.mock("../control.js", () => ({
  startControlServer: async () => ({ close: () => {} }),
}));

vi.mock("../logger.js", () => ({
  Logger: class {
    async init(): Promise<void> {}
    async info(): Promise<void> {}
    async warn(): Promise<void> {}
    async error(): Promise<void> {}
  },
}));

vi.mock("../fs-bridge.js", () => ({
  FsBridge: class {},
  FsError: class extends Error {},
}));

import { Daemon } from "../daemon.js";
import type { SyncDaemonConfig } from "@pi-agent-hub/protocol";

function baseConfig(): SyncDaemonConfig {
  return {
    hub: { url: "https://example.test/hub-service", token: "tok", heartbeatSeconds: 30, sse: { retryMs: 3000 } },
    host: { name: "host-a" },
    plugins: ["@pi-agent-hub/sync-plugin-pi-cli"],
    pluginInstall: false,
    pluginAllowlist: ["@pi-agent-hub/*"],
    pluginRoot: "./tmp-plugin-root",
    agents: {},
  } as unknown as SyncDaemonConfig;
}

describe("Daemon.start — SSE 不被首次全量同步阻塞", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    connectEventsCalls = 0;
    syncAllDeferred = undefined;
  });

  it("首次 syncAll 长时间不返回时，SSE 事件连接仍先行建立", async () => {
    const daemon = new Daemon(baseConfig());
    // 让首次全量同步永久挂起（模拟远程海量会话首次上传）。
    // syncAll 是私有方法，用索引签名绕过 TS 可见性检查，运行时与生产对象结构一致。
    syncAllDeferred = createDeferred();
    (daemon as unknown as { syncAll: () => Promise<void> }).syncAll = () => syncAllDeferred!.promise;

    // start 不会 resolve（syncAll 挂起），但不能 await；给事件循环一个排空窗口。
    void daemon.start(false);
    await flush(200);

    expect(connectEventsCalls).toBeGreaterThanOrEqual(1);
  });
});

function createDeferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function flush(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
