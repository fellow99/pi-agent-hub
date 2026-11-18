# 505-plugin-opencode-cli Technical Plan（As-Built）

> Module: 505-plugin-opencode-cli（**CLI 调用形态**：spawn `opencode` CLI）
> Corresponding spec: [./spec.md](./spec.md)
> Last Updated: 2026-11-19

## 1. 技术上下文
- 运行时：Node ESM；内置 `node:child_process`、`node:fs/promises`、`node:crypto`。
- CLI 契约：opencode v2（≥2.3.0）——`session list --format json`、`session export <id>`（位置参数）、
  `run --session <id> --format json --thinking [--model] [--file] -- <message>`、`models`。
  （参考 `D:/opencode-workspace/opencode/`：`packages/cli/src/commands/{commands,handlers}/*`。）

## 2. Constitution 符合性
- ✅ 只读采集 / 不改 native：全部经 CLI 只读命令（list/export/models）；写入仅 workDir 导出副本。
- ✅ 归一 canonical：readSession 输出合法 `message`（role user/assistant/system）+ parts，full 前 validateEntries。
- ✅ CLI 形态用 `runCli`（SDK 003 公共工具），复用超时/退出码约定，不重复模板。

## 3. 研究结论
- 与 502（HTTP serve）的差异：**插件不持有 server 端点**，每次 RPC 由 CLI 自连（复用后台 service 或拉起 standalone）。
- `session list/report/models` 默认会拉起后台 service（除非 `--server`/`--standalone`）；`run` 默认复用或一次性。
  → 插件不传 `--server`，接受 CLI 自管（轻量形态开销由宿主接受）。
- `session export` 的会话 id 是**位置参数**（非 `--session`）；`run` 的会话 id 是 `--session <id>`。
- `run --format json` 输出 NDJSON 流（text/reasoning/tool_use/step_*/error），本插件只依据退出码判定成败，
  不解析流水（转录后续由 readSession 从 export 拉取）。

## 4. 数据模型
- `OpencodeCliOptions`：`{ openCommand?, cwd?, timeoutMs? }`。
- canonical 映射（readSession）：
  - `user`/`synthetic` → `{ type:"message", role:"user", content:[text(, image from files)] }`。
  - `assistant` → `{ type:"message", role:"assistant", content: parts }`（text/reasoning/tool）。
  - `system` → `{ type:"message", role:"system", content:[{type:"text",text}] }`。
  - 其余 type 过滤；parentId=上一条 message 的 id；timestamp=消息 time.created（ms）。

## 5. 接口契约
### 5.1 提供（RPC methods）
`initialize / detect / list_sessions / read_session / deliver / get_model_info / check_idle / import_session / export_native / ping / shutdown`

### 5.2 消费（spawn opencode CLI）
| 动作 | 命令 | 用途 |
|---|---|---|
| 列会话 | `opencode session list --format json` | JSON 数组（id/title/updated/created/projectId/directory） |
| 读会话 | `opencode session export <id>` | 单 JSON {info,messages} |
| 列模型 | `opencode models` | 文本行 `providerID/model` |
| 下发 | `opencode run --session <id> --format json --thinking [--model p/m] [--file p] -- <msg...>` | 同步执行，exit 0=成功 |
| 导出 | `opencode session export <id>` | 原生副本 |

## 6. 实现策略
### 6.1 架构模式
- `OpencodeCliPlugin` 单类 + SDK `runCli`（spawn、超时、stdout/stderr 上限收集）。
- 所有 CLI 调用的 `cwd` 用 options.cwd 或 daemon workDir；`command` 默认 `opencode`。

### 6.2 关键算法
- `listSessions`：解析 JSON 数组 → NativeSessionMeta；同 id 多行按 updatedAt 去重留最新。
- `readSession`：`session export` → 线性遍历 messages 组装 canonical（full），since 过滤后 linearize+validate。
- `deliver`：组装 run args（--session/--model/--file×n/--thinking/--），超时 10min，exit 0 → completed。
- `getModelInfo`：`models` 文本行拆分 `provider/model` → 保守投影（reasoning=false, input=["text"], thinkingLevels=["off"]）。

### 6.3 错误处理
- 非 0 退出：`PluginError("agent_error", <stderr 截断>)`。
- spawn ENOENT：`agent_error`（宿主未装 opencode）。
- 超时：`runCli` 以 `code:"timeout"` 拒绝 → toPluginError 归一。
- `unsupported`：import_session。

### 6.4 性能
- CLI 自连 service（轻量形态，接受冷启动）；deliver 单并发（maxConcurrency=1）。

## 7. 测试考虑
- **单元（vitest）**：session list JSON 解析；export 组装 canonical（user/assistant/system 映射、
  files→image、since 过滤、linearize/validate）；run args 组装（--model/--file/--thinking/消息分词）；
  models 文本投影；ENOENT / 非 0 / 超时错误归一路径。
- **真机（.109，opencode CLI）**：
  - 006 模型列表投影 completed（reasoning/thinkingLevels 保守默认，⬜ 待真机定）。
  - 007 文本 deliver → 刷新 hub 出现 user+assistant；
  - 007 带图（临时 PNG --file）→ completed、转录可见；
  - 007 选模型（--model provider/model）→ 006 复拉不变（current 恒 null）；
  - 会话同步（全量+增量）+ 文件查看（走 daemon fs-bridge，与插件无关）。
  - ⬜ thinkingLevel（opencode v2 无 CLI 档位，经 model variant）——与 serve 同约束。

## 8. 文件清单
| 文件 | 用途 | 行数 |
|---|---|---|
| src/main.ts | runPluginServer 装配 | 24 |
| src/plugin.ts | OpencodeCliPlugin（CLI 调用） | 约 300 |

## 9. 部署与迁移
- 端侧配置 `agents["opencode-cli"].options`（可选 openCommand/cwd）；daemon `plugins` 加入
  `@pi-agent-hub/sync-plugin-opencode-cli`。
- 与 502 serve 可并存（kind 区分 `opencode-cli` / `opencode`）；共享同一 `opencode` CLI 可执行文件。
- 用例回归：会话同步 / 文件查看 / 推送文本 / 推送带图 / 选择模型 / 选择思维强度（思维强度按 v2 约束）。
