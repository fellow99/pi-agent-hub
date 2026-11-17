# 007-push-prompt 功能规格（Specification）

> Module: 007-push-prompt（下发聊天消息 · Chat Deliver 主设计）
> 需求编号：007-push-prompt · 需求名称：下发聊天消息
> Status: In-progress（设计待评审 → 本规格落地实现）
> Last Updated: 2026-11-17
> 关联文档：[docs/007-下发聊天消息.md](../../docs/007-下发聊天消息.md)（v0.1 设计源头）、docs/001-协议规范.md、
> docs/006-模型信息同步.md（模型/思考深度数据源）、模块规格 107-service-push-prompt / 207-console-push-prompt /
> 407-sync-daemon-push-prompt

## 1. 模块概述

### 1.1 目的

在 hub-console 会话主区底部提供聊天输入框（composer），向**指定主机、指定智能体、指定会话**下发一条
聊天提示词（文本 + 图片 + 可选模型/思考深度）。它是既有 `deliver` 能力（`000` §4.4/§7.5、`001` §5.3/§7.8）
的**增强与 UI 落地**：新增会话内输入框、图片中转、模型/思考深度选择、delivery 持久化与状态回显。

```text
hub-console（composer + 1s 轮询状态 + 完成后刷新正文）
  => POST /api/hub/deliveries          hub-service：admin+CSRF、参数/图片校验、图片落盘、DB 持久化、SSE 下发
  => SSE event: deliver                 sync-daemon：同 session 串行、幂等、冲突检查、图片下载、按 agent 路由
  => JSON-RPC deliver                   sync-plugin-*：pi RPC / opencode ACP/HTTP / dsh Remote 差异适配
  => POST /api/v1/deliveries/:id/ack|result
  => GET /api/hub/deliveries/:id        console 轮询终态 → 触发同步 → 刷新 transcript 尾部
```

### 1.2 解决的问题

- `000` §6.5 原本规定「下发是独立弹窗」，console 主区无会话内输入框；本需求把下发入口放到 transcript
  底部，体验与 pi-web `ChatInput` 对齐。
- 既有 `deliver` 为最小 scaffold：hub 侧仅内存 `Map`（无 DB/无 TTL/无重投/无审计），无图片、无模型、
  无思考深度、无法在发送后回显状态。
- 协议虽有 `images` 字段，但 console→hub→daemon→plugin 全链路未实现。

### 1.3 范围

- 包含：
  - protocol 扩展 `DeliverRequest`/`DeliverEvent`/`DeliveryRecord`（`model`/`thinkingLevel:string`/`images`）、
    `THINKING_LEVELS`（pi 参考）、图片与交付错误码联合；
  - hub-service deliveries 重构：校验、图片落盘、DB 持久化、态机（queued/dispatched/accepted/completed/
    failed/expired/canceled）、重投、pending 补齐、图片下载端点、完成后触发同步；
  - sync-daemon：同 session 串行锁 + 幂等表 + 图片下载 + `model/thinkingLevel/images` 转发 + 冲突检查 +
    result 后触发同步；
  - sync-plugin-pi-agent：`promptPiSession` 扩展（`get_state`→`set_model?`→`set_thinking_level?`→`prompt`+
    `images`）；opencode/dsh 差异适配；
  - hub-console：`ChatComposer.vue`（参考 pi-web ChatInput：文本/图片/模型/思考深度/策略/发送）、
    `ModelSelector`/`ThinkingLevelSelector`、api 客户端与发送后轮询、正文刷新；
  - vitest 单元测试与 Docker + 本机 daemon + Playwright 集成验证。
- 不包含（非目标，沿用设计文档 §1.3）：
  - 流式渲染（hub 是只读镜像 + 受控下发，完成后经一次同步回显完整消息）；
  - `managed-only` 策略（收敛为 `idle-only` + `force`）；
  - 模型/思考深度之外的 agent 配置管理；多级审批/队列 UI；
  - viewer 的下发能力（保持只读）。

## 2. 用户故事

- 作为 **admin 用户**，我在某会话底部输入文本（可加图片、切换模型/思考深度），发送后看到
  排队→已下发→已接受→完成/失败 状态流转；完成后正文尾部出现新 user message。
- 作为 **viewer 用户**，我看到 composer 但输入/按钮/发送禁用，提示「只读账号无法下发」。
- 作为 **hub-service**，我持久化每次下发并跟踪态机；图片先落盘、SSE 只带 `url`（避免大包）；
  daemon 离线时下发进 `queued` 等待重投。
- 作为 **sync-daemon**，我保证同一会话的 deliver 串行执行（C-1 单写者），本地幂等，非空闲且非 force
  回 `conflict`（不重试）。
- 作为 **sync-plugin-pi-agent**，我在 `prompt` 前按需 `set_model`/`set_thinking_level`，把图片转
  `ImageContent` 传给 pi。

## 3. 功能需求（跨模块总纲，模块级 FR 见各模块 spec）

### 3.1 协议契约（protocol 包，FR-007-001~003）

- FR-007-001: MUST 扩展 `DeliverRequest`（插件 JSON-RPC）增加可选 `model?`、`thinkingLevel?: string | null`、
  `images?: Array<{mime, dataBase64?, path?}>`；`policy` 收敛为 `"idle-only" | "force"`。
- FR-007-002: MUST 扩展 SSE `deliver` 事件 payload：增加可选 `model`、`thinkingLevel`、`images`（图片为
  `{mime, url, sha256, bytes}`，**不内联 base64**）。
- FR-007-003: MUST 新增 DB 持久化列与交付错误码联合（`conflict`/`model_not_found`/`unsupported`/
  `agent_error`/`image_expired`/`image_invalid`/`image_too_large` 等），不改既有字段（新增可选字段，
  老客户端不带 = 旧行为）。

### 3.2 上传与图片中转（FR-007-004~007）

- FR-007-004: console 提交 MUST 为**内联 base64**：`images: [{mime, dataBase64, name?}]`；
  单张解码后 ≤10MB、单次 ≤10 张；`text` 与 `images` 至少一项非空。
- FR-007-005: hub 收到后 MUST 校验 mime 白名单（png/jpeg/gif/webp/bmp）、单张大小与张数；
  校验通过后**落盘** `dataDir/deliveries/<deliveryId>/images/<index>`，计算 `sha256`/`bytes`；
  SSE 事件只带 `{mime, url, sha256, bytes}`。
- FR-007-006: hub MUST 将 `express.json` body limit 提升至 **≥160MB**（10×10MB base64 ≈ 133MB）并加
  总量/张数二次校验兜底。
- FR-007-007: daemon MUST 以 Bearer 下载 `GET /api/v1/deliveries/:deliveryId/images/:index` 为临时文件，
  插件侧 `DeliverRequest.images` 传 `{mime, path}`；图片 URL 有效期与 delivery 生命周期一致，
  终态/GC 后 410 `image_expired`。

### 3.3 模型与思考深度应用（FR-007-008~011）

- FR-007-008: 下发载荷 `model`/`thinkingLevel` 为**可选**；不传 = 不改，跟随会话当前（与 006 选项一致）。
- FR-007-009: pi 插件 MUST 以 `get_state` →（model 指定且 != 当前）`set_model` →（thinkingLevel 指定且 != 当前）
  `set_thinking_level` → `prompt` 顺序执行；`set_model` 失败 → 回 `model_not_found` 且不发送 `prompt`。
- FR-007-010: `thinkingLevel` 在协议层为 agent 特定 `string`；composer 下拉**只显示** 006 返回的所选模型
  `thinkingLevels` + 「跟随会话默认」（= 不传该字段）；hub 只校验「非空字符串」。
- FR-007-011: 三插件差异适配（`model`/`thinkingLevel`/`images`）：
  - pi：完整（RPC）；
  - opencode：ACP 优先，否则 `POST /api/session/{id}/prompt`；图片走 `PromptInput` 文件附件（base64+mime）；
    模型 `Model.Ref` 或先 `POST /api/session/{id}/model`；thinkingLevel → reasoning 开/关（⬜ 待验证）；
  - dsh：`session/prompt`（`PromptContentPart` 文本/image 块，image 内联 base64）；
    模型/思考深度先 `session/selectModel`（`ModelSelection{provider,model,reasoningEffort?}`）；
  - 某能力不支持 → 忽略该字段并在 result `warnings` 标注，不阻塞纯文本下发；仅基础文本失败才 `ok:false`。

### 3.4 delivery 态机与持久化（FR-007-012~018）

- FR-007-012: 态机 MUST 复用 `DeliveryState`：`queued → dispatched → accepted → completed|failed`，
  `expired`（ack/result 超时）、`canceled`（未 dispatched 可取消）；queued 在 host 离线时建立，
  恢复后经 pending 补齐重投（attempt++，ack 60s / result 10min / 最多 5 次）。
- FR-007-013: hub MUST 将 delivery 持久化到 `deliveries` 表（新增列：model_provider/model_id/thinking_level/
  images_json/policy/force/attempts/...），支持终态保留与 GC（按 retentionDays）。
- FR-007-014: 同一 session 的 deliver/import MUST 串行（per-session 写锁/队列）。
- FR-007-015: daemon 侧 MUST 本地幂等（已完成 deliveryId 保存 7 天，重复事件直接回原 result）；
  执行前空闲检查（非空闲且非 force → `conflict`，`retryable:false` 不重试）。
- FR-007-016: `force` MUST 仅 admin、前端二次确认、记录审计。
- FR-007-017: daemon result 前 MUST 触发该会话一次同步（manifest 单项 → 差分 → POST /sync），
  保证新消息随后出现在 hub 镜像。
- FR-007-018: console 收到 `completed` MUST 重新拉取 `GET /api/hub/sessions/:id/transcript` 尾部显示新消息。

### 3.5 console composer（FR-007-019~024，模块 spec 207）

- FR-007-019: `ChatComposer.vue`（新增）MUST 位于 `TranscriptPane.vue` 底部（滚动区之外）：
  textarea（Enter 发送/Shift+Enter 换行）、图片按钮（accept 白名单、本地 ≤10MB 校验、缩略图预览可移除、
  可选拖拽）、模型按钮、思考深度按钮、策略菜单（idle-only 默认 / force 二次确认）、发送。
- FR-007-020: viewer：composer 渲染但输入/按钮/发送禁用，显示「只读账号无法下发」；未选会话整体禁用。
- FR-007-021: 模型/思考深度按钮数据来自 `getModelInfo(sessionId)`（006）；加载失败/agent_unsupported
  显示禁用态不崩溃。
- FR-007-022: 发送后 1s 轮询 `GET /api/hub/deliveries/:id` 至终态，期间显示状态条；完成后清空输入/图片、
  刷新 transcript 尾部。
- FR-007-023: 会话切换时清空 composer 草稿/图片/模型选择（防串会话）。
- FR-007-024: 支持 `idempotencyKey`（≤128 字符，透传幂等），双击/重试不产生重复消息。

## 4. 数据流与接口契约

### 4.1 console → hub：发起（扩展）

```
POST /api/hub/deliveries   body:
{
  "sessionId": "hs_…", "text": "…",
  "images": [ { "mime": "image/png", "dataBase64": "…", "name": "a.png" } ],
  "model": { "provider": "anthropic", "modelId": "claude-sonnet-4-5" },
  "thinkingLevel": "high", "policy": "idle-only"|"force", "force": false,
  "idempotencyKey": "…"
}
=> 202 { "deliveryId": "dlv_<uuid>", "state": "dispatched" }
=> host 离线排队：{ "deliveryId": "dlv_…", "state": "queued" }
错误：400 invalid_request/image_invalid/image_too_large · 403 forbidden_role · 404 session_not_found ·
     404 host_unknown · 422 session_incomplete
```

### 4.2 console → hub：状态轮询 / 取消

```
GET  /api/hub/deliveries/:id             => 200 { deliveryId, state, ... } | 404 not_found
POST /api/hub/deliveries/:id/cancel      => 取消（仅未 dispatched 生效）
```

### 4.3 hub → daemon：SSE `deliver`（扩展）

```jsonc
{ "deliveryId": "dlv_…", "agentId": "a_…", "nativeSessionId": "019a…", "hubSessionId": "hs_…",
  "message": "…", "images": [ { "mime": "image/png", "url": "/api/v1/deliveries/dlv_…/images/0",
  "sha256": "hex", "bytes": 84213 } ],
  "model": { "provider": "anthropic", "modelId": "claude-sonnet-4-5" }, "thinkingLevel": "high",
  "policy": "idle-only", "force": false, "attempt": 1, "createdAt": …, "expiresAt": … }
```

### 4.4 daemon → hub：ack / result（沿用 001 §5.5，不新增端点）

```
POST /api/v1/deliveries/:id/ack
POST /api/v1/deliveries/:id/result   { "ok": true, "result": { "state":"completed", "nativeMessageId":"…", "warnings":[] } }
                                     { "ok": false, "error": { "code": "conflict|agent_error|model_not_found|…", "retryable": false } }
```

### 4.5 图片下载端点（daemon 用）

```
GET /api/v1/deliveries/:deliveryId/images/:index   （Bearer；Content-Type=mime；Cache-Control:no-store；支持 Range）
```

## 5. 错误码总表

| code | 产生方 | 含义 |
|---|---|---|
| `forbidden_role` / `csrf_failed` | hub | console 权限/CSRF |
| `invalid_request` | hub | 参数非法（含空消息、非空/非法 thinkingLevel） |
| `image_invalid` / `image_too_large` | hub | 图片 mime 不支持 / 超限 |
| `session_not_found` / `session_incomplete` | hub | 会话不存在 / 数据不全 |
| `host_unknown` | hub | hostId 无 daemon 配置 |
| `not_found` | hub/daemon | deliveryId 不存在 / 图片 index 越界 |
| `conflict` | daemon | 会话被外部改动/非空闲（不重试） |
| `model_not_found` | plugin | `set_model` 找不到目标模型 |
| `unsupported` | daemon/plugin | 目标 agent 不支持图片/模型/思考深度 |
| `agent_error` | daemon/plugin | 子进程/执行异常 |
| `expired` | hub | ack/result 超时 |
| `image_expired` | hub | 交付终态/GC 后图片不可下载 |

## 6. 鉴权与权限矩阵

| 动作 | console admin | console viewer | daemon（Bearer） |
|---|---|---|---|
| 发起 deliver（POST） | ✅ | ❌ 403 | — |
| 轮询/取消 | ✅ | ❌ | — |
| `force` | ✅（二次确认+审计） | ❌ | — |
| 下载交付图片 | — | — | ✅（host 归属校验） |
| SSE deliver / ack / result | — | — | ✅（token 绑定 host） |

## 7. 兼容性与迁移

- 路径不变（`POST /api/hub/deliveries`、`/api/v1/deliveries/:id/ack|result`），仅**新增可选字段**
  （`model`/`thinkingLevel`/`images`）；老客户端不带 = 旧行为。
- `deliveries` 表新增列（旧库可迁移）；图片目录 `dataDir/deliveries/*` 随 delivery GC 清理。
- `managed-only` 从 enum/UI 移除（设计决策，不影响既有持久化数据解释）。

## 8. 测试要点

- 单测：参数校验（空消息/非空 thinkingLevel/图片 mime/size/count）、态机（queued→dispatched→accepted→
  completed/failed、ack/result 超时、attempt 上限、cancel）、同 session 串行与 conflict、deliveryId 幂等、
  pi 插件 set_model 找不到 → model_not_found 且不发 prompt。
- 集成（Docker + 本机 daemon + Playwright）：admin 底部输入发送 → 状态流转 → 正文尾部出现新 user message；
  多图发送；模型+思考深度切换后镜像出现 model_change/thinking_level_change meta 标签；viewer 禁用；
  daemon 离线 queued 恢复重投；force 二次确认。

## 9. 依赖与关联

- 依赖：006-sync-model-info（模型/思考深度数据源）、protocol（003）、hub-service（103）、sync-daemon（401）、
  sync-plugin-*（501/502/503）。
- 被依赖：无（终端能力）。
