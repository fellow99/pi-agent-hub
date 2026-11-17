# 006-sync-model-info Technical Plan（实现方案）

> Corresponding spec: ./spec.md · 下游模块：106-service-sync-model-info / 406-sync-daemon-sync-model-info
> Last Updated: 2026-11-17

## 1. 技术上下文

- pi RPC 能力已确认（`pi/packages/coding-agent/src/modes/rpc/rpc-types.ts`）：
  `get_available_models` → `{ models: Model<any>[] }`；`get_available_thinking_levels` →
  `{ levels: ThinkingLevel[] }`；`get_state` → `{ model?: Model; thinkingLevel; ... }`；
  `set_model`/`set_thinking_level` 在 007 使用。
- opencode API（`opencode.ai/docs/api`）：`GET /api/model?types=chat`、`GET /api/model/default`、
  `POST /api/session/{id}/model`；模型引用 `Model.Ref = { id, providerID, variant?, settings? }`。
- dsh Remote（`deepseek-harness/packages/api/session-controller/src/types.ts`）：
  `session/modelCatalog` → `ModelCatalog{default: ModelSelection, groups: ModelProviderGroup[], ...}`，
  `ModelCatalogModel{id,name,description?,reasoning?}`，`ModelReasoning.efforts[].id`；
  `session/selectModel(ModelSelection{provider,model,reasoningEffort?})`；`session/prompt`。
- hub-service 双轨中间件已就绪（`/api/hub` admin+CSRF、`/api/v1` Bearer）；`SseHub.send(hostId,event,data)`
  可复用；SessionRow 含 `host_id/agent_id/native_id`。
- 005 FS Bridge 提供同构参考：内存态机、SSE 下发、1s 轮询、result 兜底校验模式可直接照搬。

## 2. Constitution 符合性

- ✅ 复用双轨鉴权与错误体 `{error:{code,message}}`，不新增中间件豁免。
- ✅ 无 DB 变更、无持久化（仅内存态机 + 短缓存）。
- ✅ 严格类型：DTO 全部来自 protocol；脱敏校验为独立纯函数，无 as any。
- ✅ 只读：本模块不产生任何推理/写操作；凭据绝不跨进程外泄。

## 3. 模块设计

### 3.1 protocol（`packages/protocol/src/index.ts`）

```ts
export const MODEL_INFO_REQUEST_EVENT = "model_info_request" as const;
export const THINKING_LEVELS = ["off","minimal","low","medium","high","xhigh","max"] as const;
export type ModelInfoRequestState = "dispatched" | "accepted" | "completed" | "failed" | "expired";
export interface ModelInfoEntry {
  provider: string; modelId: string; name: string;
  reasoning: boolean; input: string[]; thinkingLevels: string[];
}
export interface ModelInfoResult {
  agentId: string;
  models: ModelInfoEntry[];
  currentModel?: { provider: string; modelId: string } | null;
  currentThinkingLevel?: string | null;
}
export interface ModelInfoRequestRecord {
  requestId: string; hostId: string; agentId: string; sessionId: string;
  state: ModelInfoRequestState; createdAt: number; acceptedAt?: number;
  finishedAt?: number; result?: ModelInfoResult; error?: { code: ModelInfoErrorCode; message: string };
}
export interface ModelInfoRequestEvent { requestId: string; agentId: string; nativeSessionId: string; }
export type ModelInfoErrorCode = /* §6 总表 */ "forbidden_role" | "csrf_failed" | "invalid_request"
  | "session_not_found" | "session_incomplete" | "host_unknown" | "host_offline" | "not_found"
  | "expired" | "agent_unsupported" | "agent_error" | "invalid_result";
export const MODEL_INFO_LIMITS = {
  requestTtlMs: 60_000, resultRetentionMs: 5 * 60_000, maxOpenRecords: 10_000,
} as const;
```

### 3.2 hub-service（`106`，本 plan 仅列要点）

- `src/model-info-store.ts`（新增）：`ModelInfoStore` 纯内存态机，接口与 005 `FsRequestStore` 同形
  （create/get/ack/result + 归属校验 + 惰性 TTL + 终态清理）。`get` 惰性 expired/清理；`ack/result`
  校验 hostId 归属，跨 host 返回 `host_mismatch`。
- `src/model-info-allow.ts`（新增）：`sanitizeModelInfoResult(raw): { ok:true; result:ModelInfoResult }
  | { ok:false; error:{code:"invalid_result"; message:string} }`——白名单投影函数（纯函数，可单测）。
- `src/app.ts`：
  - `POST /api/hub/model-info-requests`：body 校验 → 会话解析（`store.getSession(sessionId)` →
    hostId/agentId/nativeId；缺字段 422）→ host 存在性（404 host_unknown）→ `sse.send` 失败 503
    （不建记录）→ 建态 + SSE `model_info_request` → 202；
  - `GET /api/hub/model-info-requests/:id`：404 / 200 全态；
  - `POST /api/v1/model-info-requests/:id/ack|result`：Bearer + host 归属；result 先
    `sanitizeModelInfoResult` 再落态（越界 → failed invalid_result）。

### 3.3 sync-daemon（`406`，本 plan 仅列要点）

- `src/hub-client.ts`：新增 `modelInfoAck(requestId)` / `modelInfoResult(requestId, body)`（走既有
  `request()`，URL `/api/v1/model-info-requests/...`）。
- `src/daemon.ts`：`handleEvent` 增 `else if (event.event === MODEL_INFO_REQUEST_EVENT)`：
  ack → 调 `runtime.client.request("get_model_info", { instanceId, nativeId })` → 成功后触发同步
  （manifest 单项）→ `modelInfoResult(ok:true, result)`；失败 → `ok:false error`（归一
  `invalid_request/not_found/agent_unsupported/agent_error`）。
- `src/model-info-cache.ts`（可选）：daemon 侧 `Map<agentId+"\0"+cwd, { result, fetchedAt }>` 30–60s TTL，
  `getModelInfoCached(runtime, session)` 命中直接返回；刷新由 daemon 启动参数/控制 API 强制。

### 3.4 sync-plugin-*（`get_model_info`，501/502/503）

- **pi（`sync-plugin-pi-agent/src/pi-rpc.ts`）**：`queryModelInfo({ command, sessionPath, agentDir })`：
  spawn rpc → 发 `get_available_models`、`get_available_thinking_levels`、`get_state`（带 id 关联）→
  对每模型 `getSupportedThinkingLevels(model)`（pi SDK `@earendil-works/pi-ai`）投影 `thinkingLevels` →
  close stdin 退出；超时 30s SIGTERM/SIGKILL。
- **opencode（`sync-plugin-opencode`）**：`get_model_info`：
  - 模型列表：`GET /api/model?types=chat` → `{ providerID → provider, id → modelId, name → name }`；
    需要 server 运行（沿用 000 §8.2 的 server 拉起策略）；
  - 当前模型/默认：`GET /api/model/default`；会话当前目标未提供精确端点 → 回退 default
    （⬜ 待验证）；
  - `reasoning`：按返回模型是否含 reasoning 能力；`thinkingLevels` → reasoning 开/关映射（⬜ 待验证）。
- **dsh（`sync-plugin-dsh`）**：`get_model_info`：
  - `session/modelCatalog` Remote：provider 分组 → `thinkingLevels = model.reasoning?.efforts.map(e=>e.id) ?? []`，
    `currentModel = modelCatalog.default`（含 `reasoningEffort` → `currentThinkingLevel`）→ 存在会话级
    当前选择端点时优先（⬜ 待确认）；
  - `session/prompt` 在 007 使用。

## 4. 测试方案

- 单测：`model-info-allow.test.ts`（脱敏投影：完整 Model → 仅白名单；越界字段丢弃；非法数组 → invalid_result）、
  `model-info-store.test.ts`（迁移/TTL/清理/跨 host 冒写）、pi `pi-rpc.test.ts`（mock 子进程输出）——
  与 005 单测布局一致。
- 集成：Docker hub + 本机 daemon + pi 插件（宿主 `laptop-win`），Playwright 验证模型下拉数据。

## 5. 任务分解计划

按 005 任务粒度拆分（Setup → 每个包的 foundation 任务 → Story → Polish 联调），详见 `tasks.md`。
