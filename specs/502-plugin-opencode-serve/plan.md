# 502-plugin-opencode-serve Technical Plan（As-Built → v2.3.0 Migration）

> Module: 502-plugin-opencode-serve
> Corresponding spec: [./spec.md](./spec.md)
> Last Updated: 2026-11-18
> 现状：1.x（1.19.6）实现已在 .109 验证；本计划描述 **opencode v2.3.0** 迁移。

## 1. 技术上下文
- 运行时：Node ESM；全局 fetch/AbortController；`node:fs/promises`、`node:path`。
- 目标 server：**opencode ≥2.3.0**（`D:/opencode-workspace/opencode/`，bun monorepo；
  `packages/cli` + `packages/server` + `packages/core/database`）。headless `opencode serve`
  默认监听 `127.0.0.1` + 空闲端口（≥4096），env `OPENCODE_PASSWORD`（兼容 `OPENCODE_SERVER_PASSWORD`）。
- 鉴权：HTTP Basic（username=`opencode`）、`?auth_token=` 或会话 cookie
  （`packages/server/src/middleware/authorization.ts:29`）。

## 2. Constitution 符合性
- ✅ **只读采集 / 不改 native**：collect/read 全走 server HTTP 只读端点；写入仅 workDir 临时区/导出副本。
- ✅ **归一 canonical**：readSession 输出合法 `message`（role user/assistant/system）+ parts，
  full 前 `validateEntries`。
- ✅ **不臆测未读代码**：端点/存储/鉴权均由 opencode v2.3.0 源码核对（packages/protocol/src/groups/*、
  packages/core/src/session/sql.ts、packages/server/src/handlers/*）。

## 3. 研究结论（v2.3.0）
- **headless 自动执行**：`session.prompt` 默认 `wake(sessionID)` 调度 agent-loop
  （`core/src/session/session.ts:187`）——**不再需要 1.x 的「客户端维持全局 SSE 才执行」**，SSE 仅作监视。
- **端点（effect-http REST）**：会话列表 `/api/session`；消息 `/api/session/:id/message`（分页 cursor、
  type 过滤，投影）；下发 `POST /api/session/:id/prompt`（扁平 PromptInput `{text,files,delivery,resume}`）；
  模型 `GET /api/model`、`GET /api/model/default`；切模型 `POST /api/session/:id/model` `{model:{id,providerID,variant?}}`；
  全局事件 `GET /api/event`（SSE）；导出 `GET /api/experimental/session/:id/export`。
- **PromptInput**（`schema/src/prompt-input.ts`）：`{ text, files?: [{ uri, source?, name? }], agents?, skills? }`；
  图片 `files[].uri` 支持 `data:<mime>;base64,...`（`core/src/session/prompt.ts:129` 解码 base64）。
- **存储**（`core/src/session/sql.ts`）：db `{data}/opencode.db`；
  `session_v2`（含 time_created/time_updated、model json、time_idle/busy）、
  `session_message`（id/session_id/type/seq/time_created/time_updated/data json；
  type ∈ user|assistant|system|synthetic|shell|skill|compaction|idle|agent-switched|model-switched|...）、
  `session_part`（assistant text/reasoning/tool 分部；默认 id 内联 data.content）、
  `session_inbox`（prompt 输入，替代 1.x `session_input`）。
- **事件体系重命名**：`session.next.prompted/message.delta/session.completed` → 
  `session.execution.started|succeeded|failed`、`session.step.*`、`session.text.*`、`session.reasoning.*`、
  `session.tool.called|success|failed`、`session.inbox.enqueued|delivered`（idle 是消息类型而非事件）。

## 4. 数据模型
- `OpencodeOptions`：`{ server?, password?, token? }`（不再需要 opencodeCommand / dbPath）。
- canonical 消息映射（readSession）：
  - `user` / `synthetic` / `system` → `{ type:"message", role:type, content:[{type:"text",text}] }`（system 可保留）。
  - `assistant` → `{ type:"message", role:"assistant", content: parts }`（data.content 或 session_part；
    text→text / reasoning→thinking / tool→toolCall）。
  - `idle` / `compaction` / `agent-switched` / `model-switched` / `shell` / `skill` → 过滤（非对话外显）。
- `updatedAt`：HTTP 会话 info 的 time_updated；差量 since 用消息 `seq/time_created`。

## 5. 接口契约
### 5.1 提供（RPC methods）
`initialize / detect / list_sessions / read_session / deliver / get_model_info / check_idle / import_session / export_native / ping / shutdown`

### 5.2 消费（opencode v2 HTTP）
| 方法 | PATH | 用途 |
|---|---|---|
| GET | `/api/session` | 会话列表（limit/order/search/...） |
| GET | `/api/session/:id/message` | 消息投影（page cursor、type 过滤、asc/desc） |
| GET | `/api/session/:id` | 会话 info（时间戳） |
| POST | `/api/session/:id/prompt` | 下发 `{text, files?, delivery?, resume?}`（自动执行） |
| POST | `/api/session/:id/model` | 切模型 `{model:{id,providerID,variant?}}` |
| GET | `/api/model` · `/api/model/default` | 模型列表 / 默认 |
| GET | `/api/event` | 全局事件 SSE（可选监视） |
| GET | `/api/experimental/session/:id/export` | 原生导出 |

### 5.3 事件协议
- v2 headless 自动执行：deliver 无需持事件流；如需完成感知可用 `/api/event` 或消息轮询（⬜ 按需接入）。

## 6. 实现策略
### 6.1 架构模式
- 保留 `OpencodePlugin` 单类，**移除 1.x 磁盘 schema 读取（native/v2/v2b）与新残留**，统一走
  `this.request(method, path, body?)`（auth + timeoutFetch）。
- list/read 以 server 为真；分页拉取保证完整性。

### 6.2 关键算法
- `listSessions`：`GET /api/session` → 会话列表；updatedAt 取 session time_updated。
- `readSession`：`GET /api/session/:id/message?type=user,assistant,system&limit=200` 循环翻页；
  组装 canonical（见 §4）；`since/lastEntryId` 增量过滤复用（full 校验）。
- `deliver`：可选 `POST /api/session/:id/model` → `POST /api/session/:id/prompt`
  `{ text, files: images.map(uri data-uri), delivery:"steer" }`。
- `getModelInfo`：`/api/model` + `/api/model/default`；无专属 thinking API → thinkingLevels 按推理能力（⬜ 真机定）。

### 6.3 错误处理
- `PluginError("unsupported", …)`：无 server / import。
- `PluginError("not_found", …)`：会话 404。
- `PluginError("agent_error", …)`：4xx/5xx / 超时（附状态与响应截断）。
- 鉴权失败（401）→ agent_error 含提示（检查 OPENCODE_PASSWORD）。

### 6.4 性能
- 分页+type 过滤控制拉取量；避免全量重复；HTTP 无状态请求，无长连接常驻。

## 7. 测试考虑
- **单元（vitest）**：options/auth headers；models 响应映射；prompt body 组装（files data-uri）；
  message 翻页组装 canonical；无 server unsupported。
- **真机（.109，v2）**：
  - 006 模型列表 completed；007 文本 deliver → 刷新 hub 出现 user+assistant；
  - 007 带图（1×1 PNG data-uri）→ completed、转录可见；
  - 007 选模型（session.switchModel）→ 006 复拉 current 变化；
  - 会话同步（全量+增量）；文件查看（走 daemon fs-bridge，不依赖插件）。
  - ⬜ thinkingLevel 映射、checkIdle 依据断言。

## 8. 文件清单（目标）
| 文件 | 用途 |
|---|---|
| src/main.ts | runPluginServer 装配 |
| src/plugin.ts | OpencodePlugin（HTTP v2 对接；约 300~380 行） |

## 9. 部署与迁移
- `.109`：`pm2 delete opencode-serve`（或清 1.x）→ 安装/构建 opencode v2 → `opencode serve`（pm2，
  `OPENCODE_PASSWORD`）→ 插件 `options.server` 指向 v2（默认 127.0.0.1:*空闲端口*）。
- daemon 配置 `agents.opencode.options.server` 更新为 v2 地址；`pm2 restart sd-…`。
- 用例回归：会话同步 / 文件查看 / 推送文本 / 推送带图 / 选择模型 / 选择思维强度。
