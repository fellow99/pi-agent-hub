# 406-sync-daemon-sync-model-info 功能规格（sync-daemon 部分）

> Module: 406-sync-daemon-sync-model-info（模型信息同步：同步程序部分设计）
> 需求编号：006-sync-model-info（daemon 子需求）
> Status: In-progress
> Last Updated: 2026-11-17
> 关联：[006-sync-model-info/spec.md](../006-sync-model-info/spec.md)（主设计）、docs/006-模型信息同步.md §3/§5、
> 既有 401-sync-daemon（daemon 基座）、501/502/503 插件

## 1. 模块概述

### 1.1 目的

在 sync-daemon 内实现 Model Info Bridge 的主机执行端：接收 hub 经 SSE 下发的 `model_info_request`，
按 `agentId` 路由到对应插件执行 `get_model_info`（**不感知 agent 差异**），回传 ack/result；
可选按 `agentId + cwd` 做短缓存降低 pi 子进程拉起频率。

### 1.2 范围

- 包含：`hub-client.ts` 增加 `modelInfoAck/modelInfoResult`、daemon 事件分支、`model-info-cache.ts`
  （可选缓存）、错误归一、vitest 单测。
- 不包含：模型查询的 agent 具体实现（插件侧，见 501/502/503）、脱敏兜底（hub 侧 106）。

## 2. 用户故事

- 作为 daemon，我收到 model_info_request 后先 ack，再按 agentId 找对应插件 RPC；插件未实现时回
  `agent_unsupported`，执行失败回 `agent_error`，结果与错误都归一回传。
- 作为运维者，多处会话反复切模型下拉时，短缓存让大部分查询命中，不反复拉起 pi 子进程；缓存可强制刷新。

## 3. 功能需求

### 3.1 HubClient 回传（hub-client.ts）

- FR-406-001: MUST 新增 `modelInfoAck(requestId)`：`POST /api/v1/model-info-requests/:id/ack`（body `{}`）。
- FR-406-002: MUST 新增 `modelInfoResult(requestId, body)`：`POST /api/v1/model-info-requests/:id/result`，
  body 为 `{ok:true, result}` 或 `{ok:false, error}`。

### 3.2 事件处理（daemon.ts）

- FR-406-003: MUST 在 `handleEvent` 新增 `else if (event.event === MODEL_INFO_REQUEST_EVENT)` 分支：
  1. 解析 requestId/agentId/nativeSessionId，缺失记录并忽略（warn）；
  2. `this.manager.list().find(a => a.agentId === agentId)` 找不到 → 回
     `{ok:false, error:{code:"agent_unsupported"}}`；
  3. 先 `hub.modelInfoAck`（失败仅 warn 不中断）；
  4. `runtime.client.request("get_model_info", { instanceId, nativeId }, 30_000)`；
  5. 成功 → `hub.modelInfoResult(requestId, {ok:true, result})`；
     失败 → 归一错误码回 `{ok:false, error}`。
- FR-406-004: 异常归一 MUST：插件 RPC 错误映射 `agent_error`（timeout 等）；`not_found`（会话/插件未找到）
  → `not_found`；能力缺失 → `agent_unsupported`；未知 → `agent_error`。

### 3.3 可选缓存（model-info-cache.ts）

- FR-406-005: MAY 提供 `ModelInfoCache`：`Map<key, {result, fetchedAt}>`，key = `agentId + "\0" + cwd`
  （cwd 取自该 nativeId 的会话元数据，经 listSessions 解析）；TTL 默认 30s（可配置 30–60s）。
- FR-406-006: 命中缓存直接回传（避免拉起 pi 子进程）；缓存 MAY 由 daemon 控制 API 增
  `POST /local/model-info-cache/clear`（非本期强制，MAY）。
- FR-406-007: 缓存 MUST 不影响正确性：任何请求可强制刷新（如 console 端 30s TTL 过期后再次发起即刷新聚合）。

## 4. 错误码（daemon/proxy 产生）

`agent_unsupported` / `agent_error` / `not_found` / `invalid_request`（事件缺字段仅 warn 不回报）。

## 5. 测试要点

- 单测：`daemon.test.ts` 增 get_model_info 分支（mock runtime client：成功 / agent_unsupported /
  agent_error / 超时）、hub-client URL 断言。
- 集成：本机 daemon + pi 插件发起 model-info → completed；停插件 → agent_error；不复用 mock 直测缓存命中与否。
