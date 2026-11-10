# 503-plugin-dsh 功能规格（Specification）

> Module: 503-plugin-dsh
> Status: Implemented (scaffold)
> Last Updated: 2026-11-10
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
