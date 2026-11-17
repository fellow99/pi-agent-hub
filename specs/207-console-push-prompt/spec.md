# 207-console-push-prompt 功能规格（hub-console 部分）

> Module: 207-console-push-prompt（下发聊天消息：前端部分设计）
> 需求编号：007-push-prompt（console 子需求）
> Status: In-progress
> Last Updated: 2026-11-17
> 关联：[007-push-prompt/spec.md](../007-push-prompt/spec.md)（主设计）、docs/007-下发聊天消息.md §6、
> docs/006-模型信息同步.md §6（选择器数据源）

## 1. 模块概述

### 1.1 目的

在会话主区底部新增 `ChatComposer.vue` 聊天输入框，参考 pi-web `ChatInput`：文本 + 图片（预览/移除/可选
拖拽）+ 模型切换 + 思考深度切换 + 策略（idle-only/force）+ 发送后状态轮询与正文刷新；viewer 与未选会话
禁用。

### 1.2 范围

- 包含：`api.ts` Delivery 客户端与轮询封装、`ChatComposer.vue`、`ModelSelector.vue`/
  `ThinkingLevelSelector.vue`（消费 006）、`TranscriptPane.vue` 底部接入、会话切换清空。
- 不包含：模型信息查询链路本身（006）、正文渲染（既有 TranscriptPane）、发送后服务端态机（107）。

## 2. 用户故事

- 作为 admin，我在会话底部输入文本/加图/切模型/切思考深度发送，看到 排队→已下发→已接受→完成/失败 状态条，
  完成后正文尾部出现新消息。
- 作为 viewer，我看到 composer 但全部禁用，提示「只读账号无法下发」。
- 作为使用者，切换会话后草稿/图片/模型选择清空，不串会话；双击/重试由 idempotencyKey 兜底不重复。

## 3. 功能需求

### 3.1 API 客户端（api.ts）

- FR-207-001: MUST 导出 Delivery 镜像类型（与 protocol 同形）：`DeliveryState`、`DeliverImageUrl`、
  `DeliveryRecord`（含 state/error/warnings）。
- FR-207-002: MUST 实现 `sendDelivery(payload)`：POST `/api/hub/deliveries`，
  body `{sessionId, text, images?:[{mime,dataBase64,name?}], model?, thinkingLevel?, policy, force, idempotencyKey?}`，
  错误体透传（含 400/403 等 code）；返回 `{deliveryId, state}`。
- FR-207-003: MUST 实现 `pollDelivery(deliveryId, signal?)` 与 `cancelDelivery(deliveryId)`。
- FR-207-004: MUST 实现发送后 1s 轮询至终态（completed/failed/expired），AbortSignal 取消；
  终态后调用 `getTranscript(sessionId)` 刷新正文（组件内完成，见 3.3）。

### 3.2 图片处理（本地上传，不进服务器前先校验）

- FR-207-005: 图片选择/拖拽 MUST `accept` 白名单（png/jpeg/gif/webp/bmp）；经 `FileReader` 读 base64，
  本地按 ≤10MB 校验（超限 el-message 拒绝）；单次 ≤10 张；缩略图 `ImagePreview` 预览可移除。
- FR-207-006: 纯图片消息（text 空 + 图片非空）MUST 可发送。

### 3.3 ChatComposer（TranscriptPane 底部）

- FR-207-007: `ChatComposer.vue` MUST 渲染于 `TranscriptPane.vue` 滚动区底部之外（sticky 于主区底部）；
  props `{ session: SessionSummary | null }`；发送完成后 emit `sent`，父组件调 `loadTail()`。
- FR-207-008: 文本框 `el-input type=textarea` 自动增高；Enter 发送 / Shift+Enter 换行；
  发送时校验 session 非空 + 有文本或图片 + 非发送中。
- FR-207-009: 模型按钮：展示 `ModelInfoResult.currentModel` 名；下拉选项 = `models`（006 getModelInfo）；
  选中记入组件状态（默认不传 = 不改）；加载中 skeleton；`agent_unsupported`/加载失败显示禁用态。
- FR-207-010: 思考深度按钮：下拉 = 所选模型的 `thinkingLevels` + 顶部「跟随会话默认」（= 不传）；
  `value` = 当前档位；选项随所选模型过滤。
- FR-207-011: 策略菜单：`idle-only`（默认）/ `force`；选择 force MUST `el-message-box` 二次确认
  （仅 admin 显示 force 项）。
- FR-207-012: 发送后状态条：排队→已下发→已接受→完成/失败 + 错误提示（含 conflict 等 code 中文映射）；
  完成后清空输入与图片并刷新正文。
- FR-207-013: 会话切换时 MUST 清空 text/images/model/thinkingLevel 草稿；组件卸载取消在途轮询。

### 3.4 权限与空态

- FR-207-014: viewer：composer 渲染但输入/按钮/发送禁用，提示「只读账号无法下发」；
  `getRole() !== "admin"` 时满足；未选会话整体禁用。

## 4. 错误码与状态映射（前端）

服务端 code → 中文提示：`conflict`→「会话正忙/被占用，可强制」、`model_not_found`→「模型不存在」、
`host_offline`→「主机离线，已排队」、`image_too_large`→「图片过大」、`expired`→「下发超时」等。

## 5. 测试要点

- 组件/单测：模型下拉过滤、思考深度随模型过滤、图片本地校验、viewer/未选禁用、会话切换清空、发送后
  轮询状态迁移与正文刷新回调。
- 集成（Playwright）：TC-010~013 全流程；多图；force 二次确认；queued 重投显示。
