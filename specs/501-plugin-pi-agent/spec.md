# 501-plugin-pi-agent 功能规格（Specification）

> Module: 501-plugin-pi-agent
> Status: Implemented (scaffold)
> Last Updated: 2026-11-10
> 源：`packages/sync-plugin-pi-agent/`（plugin.ts + pi-rpc.ts）

## 1. 模块概述

### 1.1 目的
pi 适配器插件：把本机 pi 的 session 存档（`<agentDir>/sessions/**/*.jsonl`）读取为 canonical entries 上送，
并支持通过 pi RPC（`--mode rpc`）向既有会话下发消息、导入新会话与原生导出。

### 1.2 解决的问题
- pi 原生即 canonical v3：读取时几乎无损透传 + 补链。
- 复用 `pi` CLI 的 RPC 接口触发会话执行，而非直改存档（符合单写者约束）。

### 1.3 范围
- 包含：list/read（增量/全量/大包）、deliver（RPC prompt）、import_session、export_native、能力声明。
- 不包含：watch（未用）、pi SDK v1/v2 升级、脱敏（daemon 侧 TODO）。

## 2. 用户故事
- 作为 daemon，我可以让 pi 插件列出/读取本机所有 pi 会话。
- 作为 hub，我下发的消息可经 pi 插件 RPC 送进目标会话。

## 3. 功能需求

### 3.1 初始化/探测
- FR-501-001: `initialize` MUST 解析 options（agentDir、piCommand）与实例（默认 `~/.pi/agent`），返回能力位。
- FR-501-002: `detect` MUST 返回实例（id 由 homeDir 稳定派生 `pi-<base64url(homeDir)[:12]>`）。

### 3.2 读取
- FR-501-003: `listSessions` MUST 扫描 `sessions/*/*.jsonl`（含符号链接目录），返回 nativeId/nativePath/updatedAt/title/cwd/entryCount。
- FR-501-004: title MUST 取 `session_info.name`，否则首条 user message 前 80 字符。
- FR-501-005: `readSession` MUST 支持 full（since 缺省）与 delta（timestamp>since + lastEntryId 定位）。
- FR-501-006: >2000 条或 >4MiB 序列化 MUST 走大包（entriesPath + sha256 + count）。
- FR-501-007: full 模式 MUST `validateEntries`，失败抛 `invalid_output`。

### 3.3 下发
- FR-501-008: `deliver` MUST 用 `pi --mode rpc --session <path>` 启动，`get_state` 校验后 `prompt`，等待 `agent_settled`。
- FR-501-009: 会话未找到 MUST 抛 `not_found`；prompt 失败/超时 MUST 归为 `agent_error`/`timeout`。
- FR-501-010: 超时（默认 10min）MUST kill 子进程并抛错。

### 3.4 导入
- FR-501-011: `importSession` MUST 读 bundle，校验 `canonical.entries` 单链。
- FR-501-012: MUST 生成新 UUID id + 新 header（cwd=targetCwd），写入 `<agentDir>/sessions/<dir>/<file>`，不覆盖现有。

### 3.5 原生导出
- FR-501-013: `exportNative` MUST 复制**原始** JSONL（含 header）到 workDir 并返回 sha256/bytes。

## 4. 关键实体
| 实体 | 说明 |
|---|---|
| PiPlugin | 插件实现 |
| PiInstance | instanceId/displayName/homeDir |
| PiPromptOptions | RPC 下发参数 |

## 5. 验收场景
### 场景：增量读取边界
- Given 会话已同步到水位 t
- When read_session(since=t, lastEntryId)
- Then 只返回 timestamp>t 或位于 lastEntryId 之后的条目。

### 场景：RPC 下发
- Given 本机已装 pi
- When deliver
- Then `get_state`→`prompt`→`agent_settled`，返回 completed。

### 场景：导入不覆盖
- Given 目标 cwd 已有会话
- When importSession
- Then 新建不同 id 的文件，原文件不变。

## 6. 非功能需求
- 子进程（JSON-RPC）运行；stdout 只放协议。
- 能力位：collect/deliver/import/losslessImport/exportNative = true；controlInterface=native-api；largeReadMode=temp-file。

## 7. 假设与约束
- 依赖本机 `pi` CLI（piCommand 可配置）；single-writer 语义由 daemon 的策略层（idle-only 等）约束（当前未实现）。

## 8. 依赖
- 上游：`@pi-agent-hub/protocol`、`@pi-agent-hub/pi-session`、`@pi-agent-hub/sync-plugin-sdk`。
- 外部：`pi` CLI（RPC）。
