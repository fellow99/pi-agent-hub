# 020-common-pi-session 功能规格（Specification）

> Module: 020-common-pi-session
> Status: Implemented (scaffold)
> Last Updated: 2026-11-10
> 源：`packages/pi-session/src/index.ts`

## 1. 模块概述

### 1.1 目的
提供 **pi session format v3** 的解析、校验、线性化、时间戳、目录/文件名编码与序列化能力，
作为 hub-service、sync-daemon 与全部插件共用的「pi 会话格式基座」。

### 1.2 解决的问题
- 统一 pi v3 JSONL 的结构（header + entries）与读写规则。
- 在数据进入 hub 前/后施加单链、id 唯一、timestamp 合法等硬校验。
- 为跨 agent 归一提供确定性 id 派生、路径编码与文件命名。

### 1.3 范围
- 包含：解析、校验、线性化、时间戳、编码、序列化、文件路径推导、sha256。
- 不包含：pi SDK 只读 API 接入（TODO，规划要求）、UI、网络。

## 2. 用户故事
- 作为插件，我可以读取 pi JSONL 得到 header + entries，并校验输出的 canonical 是否合法。
- 作为 hub-service，我可以按确定性规则生成 session 文件名/目录，并把 entries 序列化为合法 v3 文件。
- 作为 daemon，我可以对异构 entries 做线性化（拉平单链）后上传。

## 3. 功能需求

### 3.1 解析
- FR-020-001: `readSessionFile` MUST 解析文件得到 `header` + `entries`；无合法 header MUST 抛错。
- FR-020-002: `parseJsonLines` MUST 忽略坏行/空行（容错尾部半行）。

### 3.2 校验
- FR-020-003: `validateEntries` MUST 检查：id 唯一、首条 parentId=null、第 i 条 parentId=第 i-1 条 id、timestamp 可解析。
- FR-020-004: 校验失败 MUST 返回错误数组（多条），由调用方决定处置。

### 3.3 线性化
- FR-020-005: `linearize` MUST 将任意顺序 entries 重写为单链（首条 parentId=null，其后指向前一条 id）。

### 3.4 编码与路径
- FR-020-006: `encodeSessionDir` MUST 按 pi 规则对 cwd 编码为 `--...--` 目录名。
- FR-020-007: `sessionFileName` MUST 生成 `<ts>_<id>.jsonl`（`[:.]` → `-`）。
- FR-020-008: `sessionFilePath` MUST 拼接 agentDir/sessions/<dir>/<file>。

### 3.5 序列化与元数据
- FR-020-009: `serializeSession` MUST 输出 header + entries 的 NDJSON 文本。
- FR-020-010: `createSessionHeader` MUST 生成 v3 header（type=session, version=3）。
- FR-020-011: `metaFromHeader` MUST 从 header 推导 SessionMeta。

## 4. 关键实体
| 实体 | 说明 |
|---|---|
| SessionHeader | type/version/id/timestamp/cwd/parentSession |
| ParsedSession | header + entries |
| CanonicalEntry | pi v3 entry（来自 protocol） |

## 5. 验收场景
### 场景：非法链被拒
- Given entries 首条 parentId 非 null
- When `validateEntries`
- Then 返回「first entry parentId must be null」错误。

### 场景：编码稳定
- Given cwd = `D:\work\app`
- When `encodeSessionDir` + `sessionFileName`
- Then 输出与 pi 同构的目录/文件名（确定性）。

### 场景：序列化往返
- Given header + entries
- When `serializeSession` → `parseJsonLines`
- Then header/entries 数量与内容一致。

## 6. 非功能需求
- 纯函数、无副作用（I/O 仅在 read 文件时）。
- 与 pi 上游目录编码规则保持一致（参照 docs/000 §5.1）。

## 7. 假设与约束
- 仅处理 v3；v1/v2 升级为 TODO（docs/000 §8.6 提及 pi SDK 升级）。
- 单链语义由本模块统一保证。

## 8. 依赖
- 上游：`@pi-agent-hub/protocol`（类型）。
- 下游：`sync-plugin-sdk`、`hub-service`、`sync-daemon`、`sync-plugin-*`。
