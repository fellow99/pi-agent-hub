# 106-service-sync-model-info 功能规格（hub-service 部分）

> Module: 106-service-sync-model-info（模型信息同步：服务部分设计）
> 需求编号：006-sync-model-info（服务端子需求）
> Status: In-progress
> Last Updated: 2026-11-17
> 关联：[006-sync-model-info/spec.md](../006-sync-model-info/spec.md)（主设计）、docs/006-模型信息同步.md §3/§5/§7

## 1. 模块概述

### 1.1 目的

在 hub-service 内实现 Model Info Bridge 的中心环节：console 请求鉴权与**会话解析**、请求态机（纯内存）、
经既有 SseHub 向目标 host 下发 `model_info_request`、接收 daemon 的 ack/result 并校验 host 归属、对
result 做**白名单兜底脱敏**、向 console 提供轮询。

### 1.2 范围

- 包含：2 个 console 路由 + 2 个 daemon 路由、`model-info-store.ts` 态机、`model-info-allow.ts` 脱敏
  纯函数、SSE 事件下发、vitest 单测。
- 不包含：agent 侧模型查询（daemon/插件）、前端渲染（207）、DB schema 变更（本需求无持久化）。

## 2. 用户故事

- 作为 admin，我 POST 发起 Model Info 请求后立即拿到 requestId，并通过 GET 轮询获得 completed/failed 结果。
- 作为 viewer，我的 POST 被既有非 GET admin 中间件拒绝（403），GET 轮询只读可用。
- 作为 hub，我只把请求下发给在线且配置存在的 host，并保证 daemon 回写不会跨 host 串记录；任何回传
  结果先经脱敏，越界字段一律丢弃。

## 3. 功能需求

### 3.1 会话解析（app.ts 复用 session-store）

- FR-106-001: `createModelInfoRequest(sessionId)` 前置 MUST 按顺序校验：
  1. `sessionId` 非字符串/为空 → 400 `invalid_request`；
  2. `store.getSession(sessionId)` 不存在 → 404 `session_not_found`；
  3. 行缺 `host_id/agent_id/native_id` 任一 → 422 `session_incomplete`；
  4. `daemonTokens` 中无该 host name → 404 `host_unknown`；
  5. `sse.send(hostId, MODEL_INFO_REQUEST_EVENT, event)` 失败 → 503 `host_offline`（不建记录）。
- FR-106-002: 通过后 MUST 生成 `mri_<uuid>`，以 `ModelInfoStore.createWithId` 建态并返回
  202 `{requestId, state:"dispatched"}`。

### 3.2 请求态机（model-info-store.ts）

- FR-106-003: `ModelInfoStore` MUST 维护 `Map<requestId, ModelInfoRequestRecord>`，字段与主 spec §3.1
  一致（requestId/hostId/agentId/sessionId/state/createdAt/acceptedAt?/finishedAt?/result?/error?）。
- FR-106-004: `get(id)` MUST 惰性生命周期判定（同 005 FsRequestStore）：
  - 非终态且 `now - createdAt > 60_000` → 置 `expired`、记 finishedAt；
  - 终态且 `now - finishedAt > 300_000` → 删除并返回 undefined；
  - 打开态记录超 `maxOpenRecords=10000` 时淘汰最老非终态（防护性软上限）。
- FR-106-005: `ack(id, hostId)` MUST：不存在 → `not_found`；hostId 不匹配 → `host_mismatch`；
  仅 dispatched 可迁移 accepted（重复 ack 幂等成功，不回退状态）。
- FR-106-006: `result(id, hostId, payload)` MUST：归属校验同 ack；**先经 §3.3 脱敏**再迁移——
  白名单通过且 `payload.ok` → completed（存 result）；白名单失败或 `payload.ok=false` → failed（存 error）；
  终态后重复 result 幂等忽略。

### 3.3 脱敏兜底（model-info-allow.ts）

- FR-106-007: `sanitizeModelInfoResult(raw: unknown)` MUST 为白名单**纯函数**：
  - 顶层仅允许 `agentId/models/currentModel/currentThinkingLevel`；
  - `models[]` 每项仅允许 `provider/modelId/name/reasoning/input/thinkingLevels`；
  - `provider/modelId/name` 必须为非空字符串、`reasoning` 必须 boolean、`input`/`thinkingLevels`
    必须字符串数组；否则整请求置 `invalid_result`；
  - 越界字段一律丢弃（不报错），未通过结构校验 → `invalid_result`。
- FR-106-008: `currentModel` MUST 限定为 `{ provider:string, modelId:string }`（可 null）；
  `currentThinkingLevel` MUST 为 string（可 null）。

### 3.4 HTTP 路由（app.ts）

- FR-106-009: `POST /api/hub/model-info-requests`（admin+CSRF）与 `POST /api/v1/model-info-requests/:id/ack|result`
  （Bearer + host 归属）按 3.1/3.2 实现；`GET /api/hub/model-info-requests/:id` 不限角色（仅查自己发起的 id）。

## 4. 错误码（服务端产生）

`invalid_request` / `session_not_found` / `session_incomplete` / `host_unknown` / `host_offline` /
`not_found` / `expired` / `invalid_result` / `host_mismatch`（内部，不回传）——见主 spec §6。

## 5. 测试要点

- 单测：`model-info-store.test.ts`（迁移/TTL/清理/跨 host 冒写/软上限）、`model-info-allow.test.ts`
  （脱敏投影/结构校验/invalid_result）。
- 集成：admin 发起 → 轮询 completed；viewer 403；daemon 离线 503 无悬空记录；越界 result 被脱敏。
