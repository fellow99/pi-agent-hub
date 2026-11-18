# 502-plugin-opencode-serve 功能规格（Specification）

> Module: 502-plugin-opencode-serve（**Server API 形态**：HTTP 对接 `opencode serve` 常驻 server）
> Status: Implemented（v1.19 已上线）→ 正在迁移 **opencode v2.3.0**
> Last Updated: 2026-11-19
> 源：`packages/sync-plugin-opencode-serve/src/{main,plugin}.ts`
> 所属需求：004-sync-session · 006-sync-model-info · 007-push-prompt

## 1. 模块概述

### 1.1 目的
**opencode 适配器插件（Server API 形态）**：以 HTTP Server API 方式对接本机运行的 **opencode server**（`opencode serve` 常驻），
完成 opencode 会话向 hub 的同步（collect）、模型信息查询（006）、消息下发（007，含图片与模型/推理强度），
并支持原生导出。与 505 sync-plugin-opencode-cli（CLI 调用形态）共同构成同一宿主的两套接入实现。

### 1.2 解决的问题
- 让 opencode 环境与 pi（pi-web）、dsh（dsh web）统一为「常驻 Server + 插件 HTTP 对接」模式。
- 随 opencode 主版本升级：**v2.3.0 大幅重构**（effect-http 端点、`session_v2/session_message/session_part` 存储、
  prompt 扁平化、headless 自动执行、事件体系重命名）。

### 1.3 范围
- 包含：initialize/detect、listSessions（HTTP session 列表）、readSession（HTTP message 分页组装 canonical）、
  getModelInfo（HTTP 模型列表/默认）、deliver（HTTP prompt / model / images files）、exportNative。
- **不再支持 opencode 1.x**：v2 迁移后移除旧 schema（native / v2 / v2b 磁盘读取）路径与 1.x 适配代码。
- 不包含：importSession（`unsupported`）；opencode v2 的推理强度（thinking）无专属 API（经 model variant，
  ⬜ 待真机确认映射）。

## 2. 用户故事
- 作为 hub 用户，我可以在 opencode 会话上选择模型、发送文本 / 图片消息，并刷新看到 user 消息与 agent 回应。
- 作为 daemon，我可以让 opencode 插件以 HTTP 方式列会话、读消息、下发 prompt。
- 作为运维，我可以看到 opencode 会话与本地 server 数据实时一致（会话列表/转录均以 server 为真）。

## 3. 功能需求

### 3.1 对接目标（版本与环境）
- FR-502-001: 插件 MUST 面向 **opencode ≥2.3.0** 的 server（`opencode serve`）提供 HTTP 对接；对 1.x 兼容代码 MUST 移除。

### 3.2 采集（HTTP，对应 004）
- FR-502-002: `listSessions` MUST 请求 `GET /api/session`，把会话列表映射为 NativeSessionMeta
  （nativeId / title / cwd / updatedAt/ state），updatedAt 取 server 侧会话时间戳。
- FR-502-003: `readSession` MUST 请求 `GET /api/session/{id}/message`（分页，按需翻页），
  按消息 type 组装 canonical：`user/synthetic/system` → `message`（role=type），
  `assistant` → `message`（role=assistant，content 取 `session_part` 或 data.content 内联分区，
  text→text / reasoning→thinking / tool→toolCall）；`idle/compaction/agent-switched/model-switched/...` 非对话消息 MUST 过滤。
- FR-502-004: 差量同步 MUST 用消息 `seq`/时间戳，支持 `since` / `lastEntryId` 增量过滤（full 校验 + linearize）。

### 3.3 服务端（HTTP）与鉴权
- FR-502-005: 服务端见 options.server；鉴权 MUST 支持 `OPENCODE_PASSWORD`（兼容 `OPENCODE_SERVER_PASSWORD`），
  HTTP Basic（username `opencode`）或 `?auth_token=`。
- FR-502-006: 无 server 配置时 deliver / getModelInfo MUST 返回 `unsupported`（与其它插件同构降级）。

### 3.4 模型信息（HTTP，对应 006）
- FR-502-007: `getModelInfo` MUST 请求 `GET /api/model`（列表）与 `GET /api/model/default`（当前），
  映射为 ModelInfoEntry（provider/modelId/name/reasoning/input/thinkingLevels）。
- FR-502-008: thinkingLevels 按模型推理能力表达（v2 无专属 thinking API，经 model variant ⬜ 待真机确认后固化）。

### 3.5 下发（HTTP，对应 007）
- FR-502-009: `deliver` MUST 请求 `POST /api/session/{id}/prompt`，body 为扁平 `PromptInput`：`{ text, files?, delivery?, resume? }`；
  opencode v2 **headless 自动执行**（server 调度 agent-loop），无需客户端维持事件连接。
- FR-502-010: 若带 `model`，MUST 先 `POST /api/session/{id}/model` `{ model: { id, providerID, variant? } }`。
- FR-502-011: 图片 MUST 转为 PromptInput `files[].uri` 的 **data URI**（`data:<mime>;base64,...`）随 prompt 上送。
- FR-502-012: 成功后 MUST 返回 ok + completed；完成态可用 `GET /api/session/{id}/message` 或事件流核对。

### 3.6 空闲与导出
- FR-502-013: `checkIdle` MUST 依据 server 会话运行状态（`GET /api/session/active` ⬜）或默认 `{idle:true}`。
- FR-502-014: `exportNative` MUST 拉取 `GET /api/experimental/session/{id}/export`（或本地存储投影）落盘 + sha256/bytes。
- FR-502-015: `importSession` MUST 返回 `unsupported`。

## 4. 关键实体
| 实体 | 说明 |
|---|---|
| OpencodeOptions | server/password/token；openCommand 不再需要（纯 HTTP） |
| NativeSessionMeta | nativeId/nativePath?/updatedAt/title/cwd/state |
| ModelInfoEntry | provider/modelId/name/reasoning/input/thinkingLevels |
| SessionMessage 类型 | user/assistant/system/synthetic/shell/skill/compaction/idle/agent-switched/model-switched/... |

## 5. 验收场景
### 场景：opencode v2 会话同步（.109 真机）
- Given opencode v2 server 运行、本地已有会话
- When listSessions / readSession
- Then hub 显示会话列表与可读 transcript（user/assistant 内容，idle/compaction 不外显）。

### 场景：消息下发（文本 / 图片 / 模型）
- Given v2 server 运行（已配模型）
- When deliver（文本；或带 model；或 1×1 PNG → files data-uri）
- Then delivery completed，刷新会话后 user 消息与 assistant 回应出现在 hub transcript。

### 场景：未配 server 降级
- Given options 未配置 server
- When deliver / getModelInfo
- Then 返回 `unsupported`。

## 6. 非功能需求
- 采集以 server 为真（HTTP 直读），只读不改 native。
- HTTP 调用带超时（prompt 60s / 列表 15s）；Basic 鉴权可选。
- 差量同步避免全量重放（分页 + since）。

## 7. 假设与约束
- opencode v2 以 `opencode serve` headless 常驻（pm2）；默认监听 127.0.0.1 + 空闲端口（≥4096）。
- v2 会话/消息均落 `{data}/opencode.db`（`session_v2/session_message/session_part/session_inbox`）——同步优先 HTTP，
  db 为备用参考。
- ⬜ 待真机：thinkingLevels 映射（model variant vs 无专属 API）、checkIdle（session/active）、
  图片多文件 PromptInput 实际行为。

## 8. 依赖
- 上游：`@pi-agent-hub/protocol`、`@pi-agent-hub/sync-plugin-sdk`。
- 内置：`node:fs/promises`、`node:path`、全局 fetch。
- 外部：opencode v2 server（HTTP）。

## 9. 版本与迁移记录
### v2.3.0（2026-11-18）migration（本模块本次目标）
- 移除 1.x 支持（磁盘 `session/message/part`、`session_v2`、`session_v2` 旧 schema 读取与旧事件）。
- 对接面改为：`GET /api/session`、`GET /api/session/:id/message`、`POST /api/session/:id/prompt`（扁平 body、
  `files` data-uri）、`POST /api/session/:id/model`、`GET /api/model[+/default]`、`GET /api/event`。
- 存储对照：`session_input` → `session_inbox`；assistant 内容 `data.content` / `session_part`。

### 1.x（历史）实现摘要
- 1.x 采用「全局 SSE 常驻 + 磁盘 `session_message`(v2b) 读取」；v2 起 headless 自动执行、改用 HTTP 直读，SSE 常驻不再必需。
