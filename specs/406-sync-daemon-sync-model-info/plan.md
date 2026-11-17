# 406-sync-daemon-sync-model-info Technical Plan（sync-daemon 实现方案）

> Corresponding spec: ./spec.md · 上游：006-sync-model-info/plan.md
> Last Updated: 2026-11-17

## 1. 技术上下文

- daemon `handleEvent` 现有 deliver/import/export_native/fs_request 分支（`src/daemon.ts`）；
  `runtime.client.request(method, params, timeoutMs)` 由 plugin-manager 提供（JSON-RPC/stdio）。
- `this.manager.list()` 返回 `AgentRuntime[]`（含 `agentId/instanceId/kind`）；`hub` 为 `HubClient`。
- 005 的 `handleFsRequest` 是「ack → 执行 → result（异常也回 ok:false）」的现成范式，直接照搬其骨架与
  日志风格。

## 2. Constitution 符合性

- ✅ 仅新增一个 SSE 事件分支与两个 HubClient 方法；不新增 daemon 配置。
- ✅ 严格类型（DTO 来自 protocol）；错误归一为稳定枚举；不做任何 agent 特判。
- ✅ 只读查询；缓存为内存性能优化，可随时失效。

## 3. 模块设计

### 3.1 `src/hub-client.ts`（新增方法）

```ts
async modelInfoAck(requestId: string): Promise<void> {
  await this.request(`/api/v1/model-info-requests/${encodeURIComponent(requestId)}/ack`, { method: "POST", body: {} });
}
async modelInfoResult(requestId: string, body: { ok: true; result: ModelInfoResult }
  | { ok: false; error: { code: ModelInfoErrorCode; message: string } }): Promise<void> {
  await this.request(`/api/v1/model-info-requests/${encodeURIComponent(requestId)}/result`, { method: "POST", body });
}
```

### 3.2 `src/daemon.ts`（事件分支）

```ts
} else if (event.event === MODEL_INFO_REQUEST_EVENT) {
  await this.handleModelInfoRequest(data);
}
// ...
private async handleModelInfoRequest(data: Record<string, unknown>): Promise<void> {
  const requestId = typeof data.requestId === "string" ? data.requestId : "";
  const agentId = typeof data.agentId === "string" ? data.agentId : "";
  const nativeSessionId = typeof data.nativeSessionId === "string" ? data.nativeSessionId : "";
  if (!requestId || !agentId || !nativeSessionId) { warn; return; }
  const runtime = this.manager.list().find(c => c.agentId === agentId);
  if (!runtime) { await this.hub.modelInfoResult(requestId, { ok: false, error: { code: "agent_unsupported", message: "agent not found" } }); return; }
  try {
    await this.hub.modelInfoAck(requestId);
  } catch (e) { warn("model-info ack failed", { requestId }); }
  try {
    const result = await runtime.client.request<ModelInfoResult>("get_model_info", {
      instanceId: runtime.instanceId, nativeId: nativeSessionId,
    }, 30_000);
    await this.hub.modelInfoResult(requestId, { ok: true, result });
  } catch (error) {
    const code = toModelInfoErrorCode(error);   // agent_unsupported / not_found / agent_error
    await this.hub.modelInfoResult(requestId, { ok: false, error: { code, message: String(error) } });
  }
}
```

### 3.3 `src/model-info-cache.ts`（可选，先实现、默认开、不影响正确性）

```ts
export class ModelInfoCache {
  constructor(private ttlMs = 30_000) {}
  get(key: string): ModelInfoResult | undefined;      // 检查 fetchedAt 过期
  set(key: string, result: ModelInfoResult): void;
  clear(): void;
}
```
- key 由 daemon 在拿到 nativeId 后查该会话 cwd（必要时调 `list_sessions` 一次解析），
  `agentId + "\0" + cwd`。
- 命中缓存：跳过插件 RPC，直接 `modelInfoResult({ok:true, result: cached})`（仍 ack）。

## 4. 测试方案

- `__tests__/daemon-model-info.test.ts`：mock manager/hub/plugin runtime，断言 ack/result 调用与错误归一
  （成功 / agent 不存在 agent_unsupported / RPC 抛 agent_error）。
- `__tests__/model-info-cache.test.ts`：命中/过期/clear。

## 5. 上游/下游

- 上游：006-sync-model-info、106-service-sync-model-info（对端路由）。
- 下游：501/502/503 插件 `get_model_info`（daemon 只做路由）。
