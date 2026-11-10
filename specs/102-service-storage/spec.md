# 102-service-storage 功能规格（Specification）

> Module: 102-service-storage
> Status: Implemented (scaffold)
> Last Updated: 2026-11-10
> 源：`packages/hub-service/src/{db,session-store}.ts`

## 1. 模块概述

### 1.1 目的
hub-service 的**数据面**：`Store` 维护 SQLite 索引（`hub.db`），`SessionStore` 负责会话身份派生、
同步合并（镜像 JSONL）、正文规范化与索引维护。核心价值是「JSONL 是事实源，DB 是指引」。

### 1.2 解决的问题
- 稳定派生 hubSessionId（确定性、命名空间隔离）。
- 全量/增量合并时保持 pi v3 文件合法且不重复。
- 为查看 API 提供列表/元数据/正文分页/原文读取。

### 1.3 范围
- 包含：sessions/deliveries 表、hubSessionId、sync(合并)、summary、transcript、readEntry、搜索过滤。
- 不包含：HTTP 路由（101）、配置加载（103）、FTS5（TODO）。

## 2. 用户故事
- 作为 daemon，我上报 manifest 后能拿到水位并增量同步，hub 不会重复落盘同一 entry。
- 作为 console，我能列出会话、读取正文分页与单条原文。

## 3. 功能需求

### 3.1 身份派生
- FR-102-001: `hubSessionId` MUST = `hs_` + `base64url(sha256(hostId\0agentId\0nativeId))[:26].toLowerCase()`，
  对同一 native 会话恒等。
- FR-102-002: `agentId`（daemon 侧，见 410）MUST 与 host+kind+instance 绑定，稳定派生。

### 3.2 索引表
- FR-102-003: `sessions` 表 MUST 含 id/host_id/agent_id/native_id/cwd/title/时间戳/水位/计数/state/imported_from，且 `UNIQUE(agent_id,native_id)`。
- FR-102-004: `deliveries` 表 MUST 含 id/host_id/session_id/state/created_at/error。
- FR-102-005: 表结构 MUST 支持 `CREATE TABLE IF NOT EXISTS` 幂等建库。

### 3.3 合并语义
- FR-102-006: `sync` 的 `mode=full` MUST 校验全链（`validateEntries`）后写临时文件并 `rename` 原子替换。
- FR-102-007: `sync` 的 `mode=delta` MUST 按 entryId 去重（已存在跳过），无既有文件则建文件，否则追加。
- FR-102-008: 非法 timestamp、非法链 MUST 抛错（由 101 层转 422）。
- FR-102-009: 同步成功后 MUST 更新水位 `last_timestamp`/`last_entry_id` 与 `entry_count`/`bytes`。

### 3.4 读取
- FR-102-010: `summary` MUST 返回会话列表/详情所需字段。
- FR-102-011: `transcript` MUST 支持 `tail`（默认 100，cap 500）与 `before`（seq 排他）分页，返回 items/hasMore/oldestSeq/newestSeq/lastTimestamp。
- FR-102-012: `readEntry` MUST 按 seq 返回单条原条 entry（供 blocks raw）。
- FR-102-013: `listSessions` MUST 排除 `deleted` 并按 `updated_at DESC`。

### 3.5 搜索（当前最小实现）
- FR-102-014: 搜索 MUST 在 title/cwd 上做包含匹配；空 q MUST 由 101 层拒绝（400）。

## 4. 关键实体
| 实体 | 说明 |
|---|---|
| SessionRow | SQLite sessions 行 |
| SessionSummary | 对外摘要对象 |
| SessionStore | 身份/合并/读取门面 |

## 5. 验收场景
### 场景：全量原子替换
- Given 已有镜像文件
- When full 同步一批合法 entries
- Then 文件以临时文件+rename 替换，水位更新，无残留 `.tmp`。

### 场景：增量幂等
- Given 已落盘 entry A、B
- When 再次 delta 同步 [A,B,C]
- Then A/B 计入 skipped，仅追加 C。

### 场景：确定性 ID
- Given 相同 (host,agent,native)
- When 两次计算 hubSessionId
- Then 结果一致，且不同 native 不同。

## 6. 非功能需求
- JSONL 为事实源；`hub.db` 可重建（当前无 reindex 命令，TODO）。
- 单行 ≤ 8 MiB / 内联批 ≤ 16 MiB（101 层 JSON limit 配合）。

## 7. 假设与约束
- 单写者语义：hub 只写自己的镜像目录，不写 native（符合只读边界）。
- 无 FTS、无历史改写检测（`rewrite_detected` 未实现，当前同 id 不同内容会被当作重复跳过——已知简化）。

## 8. 依赖
- 上游：`@pi-agent-hub/protocol`、`@pi-agent-hub/pi-session`。
- 下游：101-service-http（消费 Store/SessionStore）。
