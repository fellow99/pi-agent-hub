# 107-service-push-prompt 功能规格（hub-service 部分）

> Module: 107-service-push-prompt（下发聊天消息：服务部分设计）
> 需求编号：007-push-prompt（服务端子需求）
> Status: In-progress
> Last Updated: 2026-11-17
> 关联：[007-push-prompt/spec.md](../007-push-prompt/spec.md)（主设计）、docs/007-下发聊天消息.md §3/§5/§8

## 1. 模块概述

### 1.1 目的

在 hub-service 内把既有 `deliveries` 最小 scaffold 重构为可用的下发中心：参数与图片校验、图片落盘中转、
DB 持久化、完整态机（queued/dispatched/accepted/completed/failed/expired/canceled）、ack/result 重投、
pending 补齐、图片下载端点（daemon 用）。

### 1.2 范围

- 包含：`image-store.ts`（图片落盘）、`deliveries.ts`（DB 持久化 + 态机 + 队列）、app.ts 路由调整
  （发起/轮询/取消/pending/图片下载）、body limit 提升、vitest 单测。
- 不包含：agent 侧执行（daemon/插件）、前端 composer（207）、DB schema 的其他表变更。

## 2. 用户故事

- 作为 admin，我发送后立即拿到 deliveryId，可轮询状态并可取消（未 dispatched）。
- 作为 hub，daemon 离线时下发进 queued 等待重投；ack/result 超时有 attempt 计数与 expired 收敛；
  每会话串行，图片只落盘不入 SSE 大包。
- 作为 daemon，我以 Bearer 下载交付图片并校验 sha256，回传 ack/result 幂等。

## 3. 功能需求

### 3.1 发起校验与图片落盘（app.ts + image-store.ts）

- FR-107-001: `POST /api/hub/deliveries` 前置 MUST 按顺序校验：sessionId 存在（404 session_not_found /
  数据不全 422）；`text` 与 `images` 至少一项非空（400 invalid_request）；`thinkingLevel` 若传入必须为非空
  字符串（400）；`model` 若传入必须为 `{provider:string, modelId:string}`（400）；`policy` ∈
  `idle-only|force`（400）；`force` 与 `policy=force` 仅 admin（403）。
- FR-107-002: 图片 MUST 校验 mime ∈ `image/png|image/jpeg|image/gif|image/webp|image/bmp`、
  单张 base64 解码后 ≤10MB、单次 ≤10 张、总计 ≤32MB（400 `image_invalid`/`image_too_large`）。
- FR-107-003: 校验通过后 MUST 落盘 `dataDir/deliveries/<deliveryId>/images/<index>`（base64 解码），
  计算 sha256/bytes，得到 `DeliverImageUrl[]`；落盘失败 → 500 `internal_error`（不建记录）。
- FR-107-004: `express.json` body limit MUST 提升至 **160mb**（10×10MB base64 ≈ 133MB），并保留
  图片二次校验兜底（防超大 body 传满）。

### 3.2 delivery 持久化与态机（deliveries.ts）

- FR-107-005: `deliveries` 表 MUST 建表/迁移新增列：`model_provider`、`model_id`、`thinking_level`、
  `images_json`（DeliverImageUrl[]）、`policy`、`force`、`attempts`、`native_message_id`、`error`、
  `idempotency_key UNIQUE`（既有列保留：host_id/agent_id/session_id/text/state/时间戳）。
- FR-107-006: 态机 MUST 为 `queued → dispatched → accepted → completed|failed`，
  超时：ack 60s（attempt++ 重投，≤5 次，超则 expired）、result 10min（expired）；
  `canceled` 仅 queued/dispatched 可迁移。
- FR-107-007: 同 session 的 deliver/import MUST 经 per-session 串行队列执行（写锁/异步队列）。
- FR-107-008: `idempotencyKey` MUST 记录 `UNIQUE`，同 key 同 body 返回原 deliveryId；
  冲突 409 `idempotency_conflict`。

### 3.3 HTTP 路由

- FR-107-009: `GET /api/hub/deliveries/:id` → 200 全态（failed 亦 200）/ 404 not_found。
- FR-107-010: `POST /api/hub/deliveries/:id/cancel`（admin+CSRF）→ 200；仅 queued/dispatched 生效，
  其余幂等 200。
- FR-107-011: `GET /api/v1/deliveries?state=pending&limit=`（Bearer）→ pending 补齐（同构数组）。
- FR-107-012: `GET /api/v1/deliveries/:deliveryId/images/:index`（Bearer + host 归属）→ mime 字节；
  支持 Range；`Cache-Control: no-store`；越界/终态后 GC → 404/410 `image_expired`。
- FR-107-013: `POST /api/v1/deliveries/:id/ack|result`（Bearer + host 归属）幂等；result 支持
  `warnings[]`（能力降级标注）。

### 3.4 生命周期与 GC

- FR-107-014: 交付图片目录 MUST 随 delivery 终态后的 GC（retentionDays）一并清理；终态保留供前端
  查询展示，按 retention 策略过期。

## 4. 错误码（服务端产生）

`invalid_request` / `image_invalid` / `image_too_large` / `forbidden_role` / `session_not_found` /
`session_incomplete` / `not_found` / `idempotency_conflict` / `expired` / `image_expired` / `internal_error`。

## 5. 测试要点

- 单测：校验矩阵（空消息/thinkingLevel/model/policy/图片）、image-store（mime/大小/张数/落盘/sha256）、
  deliveries 态机（迁移/重投/cancel/串行/幂等键）。
- 集成：发送多图 → SSE 只带 url → daemon 下载成功 → result 幂等；queued 离线重投；cancel 语义。
