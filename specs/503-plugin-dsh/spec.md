# 503-plugin-dsh 功能规格（Specification）

> Module: 503-plugin-dsh
> Status: Implemented (scaffold)
> Last Updated: 2026-11-12
> 源：`packages/sync-plugin-dsh/src/plugin.ts`

## 1. 模块概述

### 1.1 目的
deepseek-harness（dsh）适配器插件：直接读取本地 dsh 会话存档
（`<sessionRoot>/<project>/<session>/session.vN.jsonl[.zstd]`），归一为 canonical 上送；支持原生导出。
下发与导入不支持（`unsupported`）。

### 1.2 解决的问题
- 直读 zstd/raw 两种编码的 dsh 会话文件。
- 把 dsh 事件记录映射为 canonical（当前统一映射为 `custom` 类型 dsh.event，待真实样本校准）。

### 1.3 范围
- 包含：initialize/detect、list_sessions、read_session（full/delta）、export_native。
- 不包含：deliver、import（capabilities=false）、host API 回退（TODO）、事件字段细粒度映射（⬜ 待真实样本）。

## 2. 用户故事
- 作为 daemon，我可以让 dsh 插件列出/读取本机 dsh 会话（含 zstd 压缩）。
- 作为运维，我通过能力位得知 dsh 仅支持采集与原生导出。

## 3. 功能需求

### 3.1 初始化/扫描
- FR-503-001: `initialize` MUST 解析 options（sessionRoot/host/token）与实例（默认 `~/.dsh/sessions`）。
- FR-503-002: `scan` MUST 递归 `root/<project>/<session>/`，选取 `session.vN.jsonl[.zstd]` 中版本最大的文件。
- FR-503-003: cwd MUST 由项目目录名反解码（`--x-y--` → `x/y`）。

### 3.2 读取
- FR-503-004: `readRecords` MUST 对 `.zstd` 用 `zstdDecompressSync` 解码，否则 UTF-8；逐行 JSON 解析（容错坏行）。
- FR-503-005: `readSession` MUST 把每条记录映射为 `custom` entry（`customType:"dsh.event"`），id 稳定（有 id 用之，否则 `<nativeId>-<index>`）。
  - 链式 `parentId` MUST 指向前一条记录的实际 id（前一记录有真实 `id` 用之，否则 `<nativeId>-<index-1>`），
    确保 partial 记录有真实 id、部分走合成 id 时 validateEntries 不断链（见问题记录-2026-11-12）。
- FR-503-006: delta 过滤 `timestamp > since`；full 用 validateEntries + linearize。
- FR-503-007: 会话未找到 MUST 抛 `not_found`。

### 3.3 能力与降级
- FR-503-008: `deliver`/`importSession` MUST 返回 `unsupported`（import 语义上不支持）。
- FR-503-009: `exportNative` MUST 复制原文件（保留 .zstd 后缀）到 workDir + sha256/bytes。

## 4. 关键实体
| 实体 | 说明 |
|---|---|
| DshPlugin | 插件实现 |
| SessionFile | nativeId/path/updatedAt/cwd |
| DshOptions | sessionRoot/host/token |

## 5. 验收场景
### 场景：zstd 解码
- Given `.jsonl.zstd` 会话
- When readRecords
- Then 解码为可解析的行。

### 场景：版本选取
- Given session 目录含 v1 与 v2 文件
- When scan
- Then 选取 v2（字典序最大）。

### 场景：不支持导入
- Given import_session 请求
- Then 返回 unsupported（dsh import is not supported）。

## 6. 非功能需求
- 读取为只读；不升级/改写源文件。
- 能力位：collect=true, deliver=true(未接线), import=false, exportNative=true, readStrategy=["storage","api"]。

## 7. 假设与约束
- dsh 事件字段映射为真实 canonical 消息类型仍为 ⬜ 待验证（当前用 custom 占位，见 docs/000 V8）。
- deliver 能力位与实现不一致为已知脚手架简化。

## 8. 依赖
- 上游：`@pi-agent-hub/protocol`、`@pi-agent-hub/pi-session`、`@pi-agent-hub/sync-plugin-sdk`。
- 内置：`node:zlib`（zstdDecompressSync）。
- 外部：dsh 会话目录。

## 9. 问题记录（Issue Log）

### 2026-11-12 · dsh 会话同步断链（broken chain）

**现象**：真实 dsh 会话（`session.v4.jsonl.zstd`，含 5 条记录：session 头 + permission/preset + sandbox/mode + approval/policy + session/end-seed）
在 `read_session` 时抛 `invalid_output: broken chain at <nativeId>-1`，整个会话被跳过、无法同步到 hub。

**根因**：`readSession` 中 entry 的 `id` 用记录**真实** `id`（仅 session 头有），而 `parentId` 固定用合成 `<nativeId>-<index-1>`：
`entries[1].parentId = <nativeId>-0` ≠ `entries[0].id = session头真实id`，validateEntries 断链。

**复现要点（与 Node 版本相关）**：
- 自带打包运行时 **Node v26.13.0**：`node:zlib.zstdDecompressSync` 解出**全部 5 条**记录 → 触发断链。
- 系统 **Node v24.8.0**：`zstdDecompressSync` 只解出**第 1 条**（session 头），validateEntries 恰好通过（数据被截断但不报错）→ 掩盖了链 bug。
因此该问题仅在真实运行环境（内置 Node v26）暴露；用系统 Node v24 跑 daemon 时 dsh 数据会不完整（截断），需统一用内置 Node。

**修复**（`packages/sync-plugin-dsh/src/plugin.ts`）：parentId 改为指向前一条记录的**实际 id**
（`isRecord(prev) && typeof prev.id === "string" ? prev.id : <nativeId>-<index-1>`），与 entry id 保持同源同构。
修复后 dsh 会话条目数为 5，与源记录一致，validateEntries 通过。
