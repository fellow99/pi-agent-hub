# 502-plugin-opencode 功能规格（Specification）

> Module: 502-plugin-opencode
> Status: Implemented (scaffold)
> Last Updated: 2026-11-10
> 源：`packages/sync-plugin-opencode/src/plugin.ts`

## 1. 模块概述

### 1.1 目的
opencode 适配器插件：优先**直读 opencode SQLite（V2）**，把消息/part 归一为 canonical entries 上送；
提供原生导出。下发（deliver）与导入（import）当前**未接线**（返回 unsupported）。

### 1.2 解决的问题
- 在无 opencode server 进程的情况下直接读取会话存档（只读）。
- 版本识别：仅支持 V2（`session_v2`/`session_message`/`session_part`），否则报 `unsupported`。

### 1.3 范围
- 包含：initialize/detect、list_sessions、read_session（full/delta）、export_native、能力声明。
- 不包含：deliver（TODO）、import（capabilities=false）、watch、server API 回退（TODO）。

## 2. 用户故事
- 作为 daemon，我可以让 opencode 插件列出/读取本机 opencode 会话（无需起 server）。
- 作为运维，我通过 readStrategy=storage,api 得知插件期望优先直读。

## 3. 功能需求

### 3.1 初始化/版本
- FR-502-001: `initialize` MUST 解析 options（dataDir/dbPath/server/opencodeCommand）与平台默认 dataDir。
- FR-502-002: 默认 dataDir MUST 按平台：win=%LOCALAPPDATA%\opencode；mac=~/Library/Application Support/opencode；lin=$XDG_DATA_HOME/opencode。
- FR-502-003: `open` MUST 只读打开 DB，含 `session_v2` 与 `session_message` 判定为 V2，否则 `unsupported`。

### 3.2 读取
- FR-502-004: `listSessions` MUST 查 `session_v2`（按 time_updated DESC），返回 nativeId/title/cwd/updatedAt。
- FR-502-005: `readSession` MUST 按 messages+parts 组装 canonical message entries（单链）。
- FR-502-006: delta 过滤 `timestamp > since`；full 用 `validateEntries` + `linearize`。
- FR-502-007: part 文本 MUST 聚合为 message content（text part 优先；否则 data.content；否则 JSON 摘要 ≤2000 字）。

### 3.3 原生导出
- FR-502-008: `exportNative` MUST 导出 session + messages 的 JSON 到 workDir（format=opencode-export），返回 sha256/bytes。

### 3.4 能力与降级
- FR-502-009: `deliver`/`importSession` MUST 返回 `unsupported`（未接线）。
- FR-502-010: 能力位 MUST 声明 collect=true、deliver=true（声明但实际未接线）、import=false、readStrategy=["storage","api"]。

## 4. 关键实体
| 实体 | 说明 |
|---|---|
| OpencodePlugin | 插件实现 |
| SessionRow / MessageRow / PartRow | SQLite 行 |
| schema | "v2" | null |

## 5. 验收场景
### 场景：V1 数据库被拒
- Given DB 无 session_v2 表
- When open()
- Then 抛 `unsupported`（storage version not supported）。

### 场景：消息组装
- Given session + messages + parts
- When readSession
- Then 输出单链 message entries，part 文本聚合正确。

### 场景：原生导出
- Given 存在会话
- When exportNative
- Then 生成 opencode-export JSON + sha256。

## 6. 非功能需求
- SQLite 以只读模式打开；查询后 `finally close()`。
- 直读失败回退 server API（当前未实现，TODO）。

## 7. 假设与约束
- 仅支持 V2 schema；V1 兼容与 server API 为 TODO。
- deliver 声明能力与实际不符（`capabilities.deliver=true` 但未接线）——已知脚手架简化。

## 8. 依赖
- 上游：`@pi-agent-hub/protocol`、`@pi-agent-hub/pi-session`、`@pi-agent-hub/sync-plugin-sdk`。
- 外部：opencode 数据目录（SQLite）。
