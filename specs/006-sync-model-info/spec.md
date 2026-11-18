# 006-sync-model-info 功能规格（Specification）

> Module: 006-sync-model-info（模型信息同步 · Model Info Bridge 主设计）
> 需求编号：006-sync-model-info · 需求名称：模型信息同步
> Status: In-progress（设计待评审 → 本规格落地实现）
> Last Updated: 2026-11-17
> 关联文档：[docs/006-模型信息同步.md](../../docs/006-模型信息同步.md)（v0.1 设计源头）、docs/001-协议规范.md、
> 模块规格 106-service-sync-model-info / 406-sync-daemon-sync-model-info、docs/007-下发聊天消息.md（消费方）

## 1. 模块概述

### 1.1 目的

新增一条由主机侧 agent 查询**可用模型清单、当前模型、当前思考深度**的只读数据链路，供 007 会话底部
聊天输入框的「模型切换/思考深度切换」按钮使用。hub 不持有、不应持有各 agent 的模型目录与凭据
（`000` §1），模型元数据必须按需实时向主机上的 agent 查询。

```text
hub-console（发起 + 1s 轮询）
  => POST /api/hub/model-info-requests   hub-service：admin+CSRF 鉴权、会话解析、建态、SSE 下发、结果脱敏兜底
  => SSE event: model_info_request        sync-daemon：按 agentId 路由到插件、回传、可选缓存
  => JSON-RPC get_model_info              sync-plugin-*：调 agent 原生接口（pi RPC / opencode HTTP / dsh Remote），最小投影
  => POST /api/v1/model-info-requests/:id/ack|result   daemon Bearer 回传
  => GET /api/hub/model-info-requests/:id  console 轮询取终态结果并渲染
```

### 1.2 解决的问题

- console 需要实时展示「该会话对应 agent 可用模型」与「当前模型支持的第思考深度档位」，但 hub 无静态
  模型清单、不保存 API Key；静态配置会与 agent 侧 `models.json` / `enabledModels` / 项目作用域脱节。
- 模型元数据涉及凭据（`headers/baseUrl/cost/api/...`），任何跨进程传递都必须最小投影 + 兜底白名单。

### 1.3 范围

- 包含：
  - protocol 新增 Model Info DTO、状态枚举、`THINKING_LEVELS`（仅 pi 参考）、SSE 事件名、错误码联合；
  - hub-service 发起/轮询/ack/result 路由、纯内存请求态机与 TTL、会话解析、result 兜底白名单校验；
  - sync-daemon `model_info_request` 事件分支、按 agentId 路由插件 `get_model_info`、HubClient 回传方法；
  - sync-plugin-*（pi/opencode/dsh）实现 `get_model_info` 并做差异适配与最小投影；
  - hub-console 模型/思考深度选择器数据源（选项消费，UI 主体在 207）；
  - vitest 单元测试与 Docker + 本机 daemon + Playwright 集成验证。
- 不包含（非目标，沿用设计文档 §1.3）：
  - 模型 CRUD / 模型配置管理；
  - 任何推理代理 / API Key 保存；
  - hub 持久化模型清单（纯查询态机 + 短缓存）；
  - 「切换模型」动作本身（在 007 下发的 `set_model`/`selectModel` 完成，见 007 spec）。

## 2. 用户故事

- 作为 **admin 用户**，我在某 pi 会话底部点开模型下拉，看到该会话对应 agent 的可用模型列表与当前模型；
  点开思考深度下拉，看到当前模型支持的档位（随模型过滤）。
- 作为 **viewer 用户**，我的模型信息发起 POST 被既有非 GET admin 中间件拒绝（403）；GET 轮询只读可用，
  但选中会话未获得模型信息时不发起请求（仅渲染禁用态）。
- 作为 **hub-service**，我对每个模型信息请求先做会话解析与 host 在线检查，再经 SSE 下发；对
  daemon 回传的 result 做**白名单兜底校验**，越界字段一律丢弃，绝不透传凭据。
- 作为 **sync-daemon**，我不感知具体 agent 差异，只按 `agentId` 路由到对应插件并回传 ack/result；
  `agent_unsupported`/`agent_error` 归一为标准错误码。
- 作为 **sync-plugin-pi-cli**，我拉起 `pi --mode rpc --session <path>` 查询模型/思考深度/当前状态，
  只把 `provider/modelId/name/input/reasoning/thinkingLevels/currentModel/currentThinkingLevel` 投影出去。

## 3. 功能需求（跨模块总纲，模块级 FR 见各模块 spec）

### 3.1 协议契约（protocol 包，FR-006-001~004）

- FR-006-001: MUST 新增状态枚举 `ModelInfoRequestState = "dispatched" | "accepted" | "completed" | "failed" | "expired"`
  （与 FS 同风格）。
- FR-006-002: MUST 新增 DTO：`ModelInfoEntry`（provider/modelId/name/reasoning/input/thinkingLevels）、
  `ModelInfoResult`（agentId/models[]/currentModel?/currentThinkingLevel?）、
  `ModelInfoRequestRecord`（态机记录）、`ModelInfoRequestEvent`（SSE payload）、`ModelInfoErrorCode` 联合。
- FR-006-003: MUST 新增 SSE 事件名常量 `MODEL_INFO_REQUEST_EVENT = "model_info_request"` 与
  思考深度参考常量 `THINKING_LEVELS = ["off","minimal","low","medium","high","xhigh","max"]`
  （**仅 pi 的固定档位**；opencode/dsh 为各自 agent 特定字符串，见 3.4）。不改既有类型字段。
- FR-006-004: `thinkingLevel`/`thinkingLevels` 在协议层为 **`string`/`string[]`**，
  hub 不做跨 agent 枚举校验，只校验非空字符串；具体值由插件/agent 校验。

### 3.2 链路与状态机（FR-006-005~008）

- FR-006-005: 通信模式 MUST 为异步轮询：console 发起得 202 `{requestId, state:"dispatched"}`，1s 间隔轮询
  `GET /api/hub/model-info-requests/:id` 直至终态；hub 不挂起 HTTP 请求。
- FR-006-006: 态机 MUST 为 `dispatched →（ack）accepted →（result ok）completed |（result !ok）failed`；
  自建记录起 60s 未达终态，轮询命中时惰性置 `expired`（无后台定时器）。
- FR-006-007: 终态记录 MUST 在内存保留 5 分钟供轮询后惰性删除；未知/已清理 requestId 返回 404 `not_found`。
- FR-006-008: 发起 MUST 为按 **session 粒度**（模型作用域依赖项目 cwd）：console 只传 `sessionId`，
  hub 解析出 `hostId/agentId/nativeId`；SSE 事件携带 `agentId + nativeSessionId`。

### 3.3 数据脱敏（FR-006-009~010）

- FR-006-009: 插件 MUST 只投影 §3.1 的 ModelInfo 字段，`headers/baseUrl/api/cost/samplingParams/
  samplingParamsByThinkingLevel/compat/promptCache/maxTokens/contextWindow` 等一律丢弃。
- FR-006-010: hub-service MUST 对 daemon 回传 result 做兜底白名单校验：顶层仅允许
  `agentId/models/currentModel/currentThinkingLevel`，`models[]` 每项仅允许
  `provider/modelId/name/reasoning/input/thinkingLevels`；越界字段丢弃，`input[]`/`thinkingLevels[]`
  非字符串数组 → 该请求置 `failed`（code `invalid_result`）。

### 3.4 多 agent 差异适配（FR-006-011~013）

- FR-006-011: `get_model_info` MUST 为三插件同一份 JSON-RPC 契约；daemon 不感知 agent 差异。
- FR-006-012: pi 插件 MUST 用子进程 RPC `get_available_models` + `get_available_thinking_levels` +
  `get_state` 查询，`thinkingLevels` 用 `getSupportedThinkingLevels(model)` 投影（pi SDK 语义）。
- FR-006-013: opencode/dsh 插件 MUST 按各自原生接口适配并返回同形 DTO：
  - opencode：HTTP `GET /api/model?types=chat`（模型列表）、`GET /api/model/default`（默认模型）；
    `thinkingLevels` 为 reasoning 开/关（⬜ 精确映射待验证）；
  - dsh：Remote `session/modelCatalog`（provider 分组 + `default` + 每模型 `reasoning.efforts`）；
    `thinkingLevels` = `ModelReasoning.efforts[].id`；
  - 对「模型列表」无能力 → `models:[]` 且 `ok:false error.code="agent_unsupported"`；
    对「当前模型/思考深度」无能力 → `currentModel:null, currentThinkingLevel:null`。

## 4. 数据流与接口契约

### 4.1 console → hub：发起（202）

```
POST /api/hub/model-info-requests   body: { "sessionId": "hs_7f3k..." }
=> 202 { "requestId": "mri_<uuid>", "state": "dispatched" }
错误：400 invalid_request · 404 session_not_found/not_found · 422 session_incomplete ·
     404 host_unknown · 503 host_offline · 403 forbidden_role/csrf_failed
```

### 4.2 console → hub：轮询

```
GET /api/hub/model-info-requests/:requestId
=> 200 { requestId, state, result?|error? }   （failed/expired 亦 200，错误在体内）
=> 404 not_found（未知/已清理）
```

### 4.3 hub → daemon：SSE

```
SSE event: model_info_request
{ "requestId": "mri_…", "agentId": "a_…", "nativeSessionId": "019a…" }
```

### 4.4 daemon → hub：ack / result（Bearer）

```
POST /api/v1/model-info-requests/:id/ack       -> 200 { ok: true }
POST /api/v1/model-info-requests/:id/result
  { "ok": true,  "result": { /* ModelInfoResult */ } }
  { "ok": false, "error": { "code": "agent_unsupported|agent_error|invalid_result", "message": "…" } }
```

### 4.5 插件 JSON-RPC：`get_model_info`

```
request:  { "instanceId": "pi-…", "nativeId": "019a…" }
result:   ModelInfoResult（§3.1）
```

## 5. 缓存与性能

- FR-006-014: hub-service 无状态缓存（状态机纯内存，重启即失）。
- FR-006-015: sync-daemon MAY 按 `agentId + cwd` 缓存 `get_model_info` 结果 **30–60s**（降低 pi 子进程
  拉起频率）；缓存仅作性能优化，任何请求可强制刷新。
- FR-006-016: console 按 `sessionId` 做 **30s TTL** 内存缓存，会话切换即失效；组件卸载/切换会话取消轮询
  （AbortController + 清 timer）；前端整体超时 30s。

## 6. 错误码总表

| code | 产生方 | 含义 |
|---|---|---|
| `forbidden_role` / `csrf_failed` | hub | console 权限/CSRF |
| `invalid_request` | hub | 参数非法 |
| `session_not_found` | hub | 会话不存在 |
| `session_incomplete` | hub | 会话缺 hostId/agentId/nativeId |
| `host_unknown` | hub | hostId 无 daemon 配置 |
| `host_offline` | hub | 目标 host 无 SSE 连接，未下发 |
| `not_found` | hub | requestId 已清理 |
| `expired` | hub | 60s TTL 到期 |
| `agent_unsupported` | daemon/plugin | 该 agent kind 未实现模型查询 |
| `agent_error` | daemon/plugin | 插件执行/超时/子进程异常 |
| `invalid_result` | hub | result 兜底白名单校验失败 |

## 7. 鉴权与权限矩阵

| 动作 | console admin | console viewer | daemon（Bearer） |
|---|---|---|---|
| 发起 model-info-request（POST） | ✅ | ❌ 403 | — |
| 轮询（GET，只读） | ✅ | ✅（仅查自己发起的 id） | — |
| SSE 接收 model_info_request | — | — | ✅（token 绑定 host） |
| ack/result 回传 | — | — | ✅（host 归属校验） |

## 8. 兼容性与迁移

- **新增能力，不破坏既有接口**：仅新增 `model_info_request` SSE 事件与 4 个 model-info-requests 端点。
- 协议包只新增类型/常量，不改既有字段；无 DB schema 变更；daemon 无新增配置；插件按需实现（未实现归
  `agent_unsupported`，不影响既有 collect/deliver）。

## 9. 测试要点

- 单测：DTO 投影（完整 Model → ModelInfoEntry 仅白名单字段）、hub 兜底校验、状态机迁移/TTL/清理/跨 host
  冒写、console 分组/筛选。
- 集成（Docker + 本机 daemon + Playwright）：pi 会话模型列表与 `pi get_available_models` 一致；cwd 切换
  作用域变化；viewer 403；daemon 离线 503；opencode/dsh 返回各自模型列表或 `agent_unsupported` 空态。

## 10. 依赖与关联

- 依赖：protocol（003）、hub-service（103 base）、sync-daemon（401 base）、sync-plugin-*（501/502/503）。
- 被依赖：007-push-prompt（composer 模型/思考深度数据源）。
