# 504-plugin-pi-web 功能规格（Specification）

> Module: 504-plugin-pi-web
> Status: Implemented
> Last Updated: 2026-11-18
> 源：`packages/sync-plugin-pi-web/src/{main,plugin}.ts`
> 所属需求：006-sync-model-info · 007-push-prompt（以 Server API 方式对接独立部署的 pi-web）

## 1. 模块概述

### 1.1 目的
**pi 适配器插件的 Server API 形态**：以 HTTP 方式对接独立部署的 **pi-web**（Next HTTP server，
进程内自带 agent），供 hub 经 sync-daemon 对 pi-web 上既有会话做模型信息同步（006）与消息下发（007），
并把 pi 会话同步到 hub 镜像。与 501-plugin-pi-cli（spawn CLI 的进程式插件）形成同一宿主（pi）的两套接入实现。

- **collect / read**：走磁盘（pi-web 已与会话共享 `~/.pi/agent/sessions` 的同源 jsonl）。
- **deliver / model-info / idle**：走 pi-web HTTP API（`POST /api/agent/[id]`、`GET /api/models?cwd=`）。

### 1.2 解决的问题
- 让 pi 环境与其他两块测试环境（opencode `opencode serve`、dsh `dsh web`）保持**同一「常驻 Server + 插件 HTTP 对接」模式**。
- 通过 pi-web 服务端进程内 agent 完成真实下发（文本/模型切换/思维强度/图片内联 base64）。
- 复用 pi 会话磁盘存储，采集与 pi-web 运行期数据天然同源、无重复维护。

### 1.3 范围
- 包含：initialize/detect、listSessions（磁盘）、readSession（full/delta）、getModelInfo（HTTP）、
  deliver（HTTP：set_model / set_thinking_level / prompt + images）、checkIdle、exportNative（磁盘）。
- 不包含：importSession（`unsupported`）；pi-web 会话运行态读取（checkIdle 默认空闲，⬜ 待接 `/api/sessions` active 字段）。

## 2. 用户故事
- 作为 hub 控制台用户，我可以在 pi-web 会话上选择模型、选择思维强度并发送文本/图片消息。
- 作为 daemon，我可以让 pi-web 插件列出/读取本机 pi 会话（磁盘）并把模型目录与下发动作走 HTTP 交给 pi-web。
- 作为运维，我通过能力位得知 pi-web 插件支持 collect/deliver/exportNative，不支持 import。

## 3. 功能需求

### 3.1 初始化/配置
- FR-504-001: `initialize` MUST 解析 options（`server`/`cwd`/`agentDir`/`password`）与实例；
  `agentDir` 缺省为 `~/.pi/agent`；`instanceId` MUST 为稳定字符串 `pi-web-<hash(agentDir)>`。
- FR-504-002: 能力位 MUST 声明 collect=true、deliver=true、exportNative=true、import=false、
  readStrategy=["api","storage"]、deliveryStrategy=["api"]。

### 3.2 采集（磁盘，与 pi-web 同源会话）
- FR-504-003: `listSessions` MUST 扫描 `<agentDir>/sessions/<project>/*.jsonl`，读取文件头解析
  `nativeId/cwd`，`updatedAt` 取最后一条 entry 时间戳（无则 mtime），返回按 updatedAt 倒序；不可读文件 MUST 跳过。
- FR-504-004: `readSession` MUST 支持 full/delta：`since` 缺省 full（validate + linearize），
  带 `since`/`lastEntryId` 时做增量过滤，并在增量链不再续接上一层 leaf（发生分支续写）时**回退 full**。
- FR-504-005: 会话未找到 MUST 抛 `not_found`（`pi-web session not found`）。
- FR-504-006: 超大会话（>2000 条或串行化 >4MB）MUST 写临时 `entriesPath`（NDJSON）并以 `entriesPath/count` 返回。

### 3.3 模型信息（HTTP，对应 006）
- FR-504-007: `getModelInfo` MUST 请求 `GET {server}/api/models?cwd=<cwd>`，cwd 缺省取首个会话 cwd（再缺省 home）。
- FR-504-008: 模型列表 MUST 取自响应的 `modelList[]`（`provider`+`modelId`），
  `thinkingLevels` MUST 取自 `{ "provider:modelId": string[] }` 映射（取不到则空数组）；
  当前模型 MUST 取自 `defaultModel`（无则列表首个）；非空 provider/modelId 过滤后返回。
- FR-504-009: 无 `server` 配置时 `getModelInfo` MUST 抛 `unsupported`（与 opencode/dsh 插件同构降级）。

### 3.4 下发（HTTP，对应 007）
- FR-504-010: `deliver` MUST 在无 `server` 时抛 `unsupported`。
- FR-504-011: 若带 `model`，MUST 先调 `POST /api/agent/[nativeId]` `{type:"set_model", provider, modelId}`；
  若带 `thinkingLevel`，MUST 先调 `{type:"set_thinking_level", level}`（均失败抛 `agent_error`）。
- FR-504-012: 正文下发 MUST 调 `{type:"prompt", message}`；带图时把图片（dataBase64 或本地 path 读入）转
  `{type:"image", data, mimeType}` 内联 base64 随 prompt 上送。
- FR-504-013: 成功后 MUST 返回 ok + state=completed；带图时 warnings 注明「图片已送达服务端」。

### 3.5 空闲与原生导出
- FR-504-014: `checkIdle` MUST 返回 `{idle:true}`（会话运行态读取 ⬜ 待接 pi-web `/api/sessions` active）。
- FR-504-015: `exportNative` MUST 复制原 jsonl 到 workDir，返回 `format:"pi-jsonl-v3"` + sha256 + bytes。
- FR-504-016: `importSession` MUST 返回 `unsupported`（语义上不支持）。

## 4. 关键实体
| 实体 | 说明 |
|---|---|
| PiWebPlugin | 插件实现（PiWebOptions: server/cwd/agentDir/password） |
| PiWebOptions | options：server 基址、cwd 缺省查询目录、agentDir、可选 Basic 口令 |
| NativeSessionMeta | nativeId/nativePath/updatedAt/title/cwd/state/entryCount |
| ModelInfoEntry | provider/modelId/name/reasoning/input/thinkingLevels |
| DeliverResult | ok/state/completed + warnings |

## 5. 验收场景
### 场景：模型列表（.100 真机已测）
- Given pi-web server 运行（llm-router 配置 4 模型）
- When getModelInfo
- Then 返回 4 个 `llmrouter/*` 模型、current=`llmrouter/deepseek-v4-flash`、thinkingLevels 正确。

### 场景：文本/模型/思维/带图下发（.100 真机已测）
- Given 会话 `hs_yoebid…`
- When deliver（文本；或 model=kimi-k3+thinkingLevel=off；或 1×1 PNG 内联）
- Then delivery completed，hub transcript 尾部出现对应 user/assistant entry（图片以 image 块入正文）。

### 场景：未配 server 降级
- Given options 未配置 server
- When deliver / getModelInfo
- Then 返回 `unsupported`（`pi-web … requires options.server`）。

### 场景：大会话走临时文件
- Given 会话条目 >2000 或串行化 >4MB
- When readSession
- Then 返回 entriesPath（NDJSON）与 count，而非内联 entries。

## 6. 非功能需求
- 采集为只读；不升级/改写源会话文件。
- HTTP 调用必须带超时（deliver/agent 60s，models 15s），AbortController 中止。
- 可选 Basic 鉴权（`pi:<password>`）；网段默认 127.0.0.1/localhost（权限声明）。
- 并发受限：timeouts.list/read/deliver 与 maxConcurrency=2 声明于包元数据。

## 7. 假设与约束
- 依赖 pi-web server 运行（独立部署，见 docs/deploy README「测试环境」）。
- 磁盘会话与 pi-web 运行时共享同一 `~/.pi/agent`（需同机或共享 agentDir）。
- pi-web `/api/agent/[id]` 对磁盘既有会话可受理（真机已验证）；运行态任务完成信号走 `Get /api/agent/[id]/events`（SSE）⬜ 未用。
- `checkIdle` 恒为空闲属脚手架简化；`option.cwd` 用于限定模型查询目录。

## 8. 依赖
- 上游：`@pi-agent-hub/protocol`、`@pi-agent-hub/pi-session`（readSessionFile/linearize/validateEntries）、
  `@pi-agent-hub/sync-plugin-sdk`（runPluginServer/PluginError/ensureDir/expandHome/sha256File）。
- 内置：`node:fs/promises`、`node:path`、`node:os`、全局 `fetch`/`AbortController`。
- 外部：独立部署的 pi-web（HTTP server，进程内 coding-agent SDK）。

## 9. 问题记录（Issue Log）

### 2026-11-18 · pi-web 模型列表与 thinkingLevels 语义校准
- `/api/models` 的 `thinkingLevels` 为 `{ "provider:modelId": string[] }` 映射而非数组 → 插件按映射读取（FR-504-008）。
- modelList 条目字段为 `id/name/provider/providerName/input` → 以 `provider`+`id` 组装（FR-504-008）。

### 2026-11-18 · 完成态 warnings 不应视为失败
- pi-web 带图 deliver 完成时插件返回 warnings（「图片已送达」），hub 早期把它写入 delivery.error（`code:"ok"`）。
- 已由 hub-service `deliveries.ts` 归一：completed 时 `code==="ok"` 的 error 归为 `warnings` 展示、不视为失败。
