# 504-plugin-pi-web Technical Plan（As-Built）

> Module: 504-plugin-pi-web
> Corresponding spec: [./spec.md](./spec.md)
> Last Updated: 2026-11-18

## 1. 技术上下文
- 运行时：Node ESM（≥22.19）；全局 `fetch`/`AbortController`；`node:fs/promises`、`node:path`、`node:os`。
- 代码：`packages/sync-plugin-pi-web/src/{main,plugin}.ts`（26 + 344 行）。
- 插件形态：子进程 + JSON-RPC over stdio（`@pi-agent-hub/sync-plugin-sdk` 的 `runPluginServer`），
  由 sync-daemon 以 `command=process.execPath, args=[dist/main.js]` 拉起。
- 对接外部：独立部署的 pi-web（Next 16，HTTP server，进程内 bundle `@earendil-works/pi-coding-agent`）。

## 2. Constitution 符合性
- ✅ **只读采集 / 不改 native**：collect/read 仅读 `~/.pi/agent/sessions/**/*.jsonl`；写入只发生在 workDir 临时区（entriesPath / export 副本）。
- ✅ **归一 canonical**：readSession 输出合法 `message`（role user/assistant/system）+ text/thinking/image parts，
  通过 `validateEntries` 后才返送（对应「不要写入错误类型」的谨慎性）。
- ✅ **不臆测未读代码**：pi-web HTTP 契约全部经源码核对与 `.100` 真机验证后落地（见 §3）。

## 3. 研究结论
- **为何 Server API 形态**：pi 环境要与 opencode（`opencode serve:4096`）、dsh（`dsh web:8080`）统一为
  「常驻 Server + 插件 HTTP 对接」模式。pi-web 独立部署（Next 进程内自带 agent）可提供现成 HTTP API 面
  （`GET /api/sessions`、`GET /api/models?cwd=`、`POST /api/agent/[id]`、`GET /api/agent/[id]/events`）。
- **collect 走磁盘、deliver 走 HTTP 的切分**：pi-web 会话持久化在 `~/.pi/agent/sessions`（`getAgentDir` 同源），
  磁盘读取稳定且与 pi-web 运行期一致；模型/下发天然只有 server 才有 → 分轨（FR-504-003 ~ 012）。
- **真机验证结论**（.100，llm-router 4 模型）：
  - `GET /api/models?cwd=`：`modelList[]`（`{id,name,provider,providerName,input}`）+ `defaultModel{provider,modelId}` +
    `thinkingLevels`（`"provider:modelId": string[]` 映射）→ 插件按映射组装，non-empty provider/modelId 过滤（FR-504-008）。
  - `POST /api/agent/[id]`：`{type:"prompt",message}`、`{type:"set_model",provider,modelId}`、
    `{type:"set_thinking_level",level}` 均受理（`{"success":true}`）；图片 `{type:"image",data,mimeType}` 内联可行。
  - 带图 deliver completed：hub 早期把插件 warnings 写进 error（`code:"ok"`）→ 由 hub-service `deliveries.ts` 归一为 warnings 展示（spec §9）。

## 4. 数据模型
- `PiWebOptions`：`server?: string`、`cwd?: string`、`agentDir?: string`、`password?: string`。
- `instanceId`：`pi-web-<base64url(agentDir).slice(0,12)>`，agentDir 缺省 `~/.pi/agent`（FR-504-001）。
- `capabilities`：collect/deliver/exportNative=true，import=false，readStrategy=["api","storage"]，deliveryStrategy=["api"]，
  largeReadMode="temp-file"（FR-504-002）。
- `ModelInfoEntry` 映射：`{provider, modelId, name, reasoning:true, input: r.input ?? ["text"], thinkingLevels: map[`${provider}:${modelId}`] ?? []}`。

## 5. 接口契约
### 5.1 提供（RPC methods，经 runPluginServer）
`initialize / detect / list_sessions / read_session / deliver / get_model_info / check_idle / import_session / export_native / ping / shutdown`

### 5.2 消费（pi-web HTTP）
| 方法 | 路径 | 用途 |
|---|---|---|
| GET | `{server}/api/models?cwd=<cwd>` | 模型目录/defaultModel/thinkingLevels（60s 超时） |
| POST | `{server}/api/agent/{nativeId}` | set_model / set_thinking_level / prompt(+images)（60s 超时） |
| GET（⬜ 未用） | `{server}/api/agent/{n}/events` | SSE 运行态事件（checkIdle 待接依据） |

### 5.3 事件协议
- 无自建事件；对 pi-web 为同步 HTTP 请求-响应。

## 6. 实现策略
### 6.1 架构模式
- SDK `runPluginServer` 装配 main.ts（FR-504-016 之外的全部 RPC 配对）。
- 单类 `PiWebPlugin`：磁盘扫描（采集）+ HTTP 请求（模型/下发）双通道。

### 6.2 关键算法
- `listSessions`（FR-504-003）：两级 readdir（`sessions/<project>/*.jsonl`）→ `readSessionFile` 头部；updatedAt 用末条 ts/ mtime；倒序。
- `readSession`（FR-504-004）：复用 `pi-session` 的 `linearize/validateEntries/timestampMs`；
  增量链分支检测（`next.parentId !== leaf.id && ts(next)>since → full`）；
  大负载（>2000 条或 >4MB）写 `entriesPath` NDJSON（FR-504-006）。
- `getModelInfo`（FR-504-007~009）：`cwd = options.cwd ?? 首会话 cwd ?? homedir`；envelope 容错解析；空模型列表返回空(current=null)。
- `deliver`（FR-504-010~013）：若有 model/thinkingLevel 先一次性 set（幂等：每次下发前设置），再 prompt；
  图片 `path ? readFile→base64 : dataBase64`，`mime ?? "image/png"`。

### 6.3 错误处理
- `PluginError("unsupported", "pi-web … requires options.server …")`：无 server（FR-504-009/010）。
- `PluginError("not_found", "pi-web session not found: …")`：readSession/exportNative 找不到会话（FR-504-005）。
- `PluginError("agent_error", …)`：pi-web 4xx/5xx 或超时（附状态码与响应截断 300B）。
- `PluginError("invalid_output", …)`：full 校验失败。

### 6.4 性能
- 磁盘扫瞄仅 stat/read 头部+末条；大会话走 temp-file 避免内联体积（FR-504-006）。
- `timeoutFetch`：models 15s，agent 60s，全部 AbortController。

## 7. 测试考虑
- **真机已验**（.100 Docker hub + sync-daemon + pi-web）：
  - 006：models=4（llmrouter），current=deepseek-v4-flash，thinkingLevels=['off']（completed）。
  - 007：文本 / model=kimi-k3+thinkingLevel=off / 1×1 PNG 内联 → delivery 均 completed；transcript 尾部 user/assistant 出现、图片以 image 块入正文。
  - 未配 server → `unsupported` 降级文案。
- **可补单测（vitest）**：PiWebOptions 默认 agentDir instanceId 稳定性；models 响应解析（modelList/thinkingLevels map）；
  deliver 无 server 抛 unsupported；readSession 大负载走 entriesPath；exportNative 字段。
- **边界**：server 返回非 JSON / 非 2xx；image dataBase64 缺失兜底空串；会话 jsonl 损坏（readSessionFile 抛错 → 跳过采集）。

## 8. 文件清单
| 文件 | 用途 | 行数 |
|---|---|---|
| src/main.ts | runPluginServer 装配 | 26 |
| src/plugin.ts | PiWebPlugin（采集/模型/下发/导出） | 344 |

## 9. 部署与真机配置（as-built）
- `.100`（debian-pi）：独立部署 pi-web（Next server，`127.0.0.1:30142`，pm2 托管）；`.100` daemon 配置
  `plugins=["…/sync-plugin-pi-web"]`，`agents["pi-web"].options = { server: "http://127.0.0.1:30142" }`；
  `agentDir` 缺省 `~/.pi/agent`（与 pi-web 同源）。
- hub 依 006/007 调度：model-info → `get_model_info`；deliver → `deliver`（含 model/thinkingLevel/images）。
