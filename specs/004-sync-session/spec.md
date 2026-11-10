# 004-sync-session 功能规格（Specification）

> Module: 004-sync-session（session 同步全流程）
> 需求编号：004-sync-session · 需求名称：session 同步全流程
> Status: In-progress（基于 scaffold 完成全链路闭环）
> Last Updated: 2026-11-10
> 关联文档：docs/001-协议规范.md（同步协议）、docs/000-工程规划.md、整体规格 overall-spec.md

## 1. 模块概述

### 1.1 目的
打通「本机 pi 会话 → hub 镜像 → console 浏览」的**端到端同步全流程**，落实以下闭环：

```text
sync-daemon
  => 调用 sync-plugin-pi-agent（采集 ~/.pi 会话）
  => 提交 manifest 到 hub-service
     => hub 返回各 session 的最后时间戳（null 需完整同步）
  => daemon 依据时间戳调用 sync-plugin-pi-agent 提取增量上下文
  => 同步到 hub-service
=> hub-service 合并 session 上下文内容（JSONL 镜像 + SQLite 索引）
=> hub-console 浏览智能体列表 / session 列表 / session 会话内容
```

### 1.2 解决的问题
- 让「端侧采集 → 差分上行 → 服务端合并 → 前端浏览」不再只是各模块脚手架，而是**可联调、可验证**的完整链路。
- 补齐 scaffold 缺失的「智能体实例」登记与浏览（manifest 自动登记 agent，console 增加 Agents 页面）。
- 以本机真实 `~/.pi` 会话数据为样本做端到端验证。

### 1.3 范围
- 包含：sync-plugin-pi-agent 采集/归一化、sync-daemon 对接 hub 与插件（manifest/差分/同步）、
  hub-service 同步接口与查询接口、hub-service agent 实例登记、hub-console 智能体列表浏览。
- 不包含：upload 流转发、下行 deliver/import 全链路重试、脱敏、FTS5 全文搜索（各模块既有 TODO）。

## 2. 用户故事
- 作为 daemon，我周期性地让 pi 插件读取 `~/.pi` 会话清单并上报 manifest，再从 hub 拿到水位，按需增量提取并同步。
- 作为 hub，我把各主机上报的 session 合并为 pi v3 镜像，并随 manifest 自动登记 agent 实例供查询。
- 作为登录用户，我可在 console 浏览智能体列表、会话列表，并打开某会话阅读正文（只读）。

## 3. 功能需求

### 3.1 sync-plugin-pi-agent（采集与归一化）
- FR-004-001: MUST 扫描 `~/.pi/agent/sessions/**/*.jsonl`（默认 agentDir `~/.pi/agent`），返回
  nativeId/nativePath/updatedAt/title/cwd/entryCount（FR-501-003 已实现）。
- FR-004-002: MUST 把 pi 原生 v3 会话归一为 canonical entries（线性化单链、id/parentId/timestamp），
  全量走 `validateEntries`（FR-501-005~007，已实现）。
- FR-004-003: MUST 支持 `since`+`lastEntryId` 差分读取与 `entriesPath` 大包（已实现）。

### 3.2 sync-daemon（对接 hub 与插件）
- FR-004-004: MUST 调用插件 `list_sessions` 组 manifest 并 POST `/api/v1/sync/manifest`（已实现）。
- FR-004-005: MUST 依据 manifest 响应按会话处理：`new/full` → 完整同步；`ok` → 以
  `lastTimestamp/lastEntryId` 为水位调 `read_session` 增量同步（已实现）。
- FR-004-006: MUST 通过 `POST /api/v1/sync/sessions/{id}`（mode=delta/full）把 entries 提交 hub（已实现）。
- FR-004-007: manifest 提交 MUST 携带 agentId/kind/version/capabilities，供 hub 自动登记 agent（当前已上报字段，hub 侧登记见 3.3）。

### 3.3 hub-service（同步/查询接口 + agent 登记）
- FR-004-008: MUST 提供 `POST /api/v1/sync/manifest`：按 (agentId,nativeId) 判 new/ok/skipped 并返回水位（已实现）。
- FR-004-009: MUST 提供 `POST /api/v1/sync/sessions/{id}`：full 原子替换 / delta 追加合并，更新水位（已实现，见 102）。
- FR-004-010: MUST 随 manifest **自动登记 agent 实例**：以 (hostId, agentId) 建档，记录
  kind/version/capabilities/homeDir/displayName、lastSeen，重复上报幂等更新（本需求新增，替换恒空 `agents` 端点）。
- FR-004-011: MUST 提供 `GET /api/hub/agents`（可按 host 过滤）返回 agent 列表；viewer 只读可访问（本需求新增完整实现）。
- FR-004-012: MUST 提供会话列表/详情/正文/搜索查询接口（`/api/hub/sessions*`、`/transcript`、`/search`，已实现）。

### 3.4 hub-console（浏览）
- FR-004-013: MUST 提供会话列表页（host/agent/cwd/title/entries/时间，已实现 Session 页）。
- FR-004-014: MUST 提供会话内容页（只读正文分块渲染 + markdown 净化，已实现 SessionDetail）。
- FR-004-015: MUST 提供**智能体列表页**：展示 host / agent kind / agentId / 版本 / 能力位 / homeDir / 最后在线（本需求新增 Agents 页）。
- FR-004-016: 顶部导航 MUST 包含 Sessions / Agents / Hosts 三个入口（本需求新增 Agents 入口）。

## 4. 关键实体
| 实体 | 说明 |
|---|---|
| AgentInstance | hub 登记的 agent：agentId/hostId/kind/version/displayName/homeDir/capabilities/status/lastSeenAt |
| NativeSessionMeta | 插件 list_sessions 返回的原生会话元信息 |
| ManifestResponse | hub 回传水位（lastTimestamp/lastEntryId/status） |
| CanonicalEntry | pi v3 entry（同步的最小单元） |

## 5. 验收场景
### 场景：完整同步新会话
- Given `~/.pi` 有真实会话且 hub 无记录
- When daemon 上报 manifest 并同步（mode=full）
- Then hub 返回 lastTimestamp=null（new），同步后 console 会话列表出现该会话、正文可读。

### 场景：增量同步
- Given 会话已同步
- When 再次 manifest（updatedAt 变化）→ 差分 read_session（ts>since）
- Then 仅追加新条目，重复同步幂等（同 entryId 跳过）。

### 场景：agent 自动登记与浏览
- Given daemon 上报含 agent 信息
- When 拉取 `/api/hub/agents`
- Then 返回该 agent（kind/version/capabilities），console Agents 页可浏览。

### 场景：只读
- Given console 详情页
- When 查找编辑/删除/发送控件
- Then 不存在（只读）。

## 6. 非功能需求
- 同步失败不中断整体循环（daemon 会话级 catch）。
- 查询接口 GET only；viewer 不得写（403）。
- 性能：manifest 单请求 ≤5000 会话、增量按水位切割（协议 limits）。

## 7. 依赖
- 上游包：`@pi-agent-hub/protocol`、`@pi-agent-hub/pi-session`、`@pi-agent-hub/sync-plugin-sdk`。
- 工程：hub-service（101/102/103）、sync-daemon（401）、sync-plugin-pi-agent（501）、hub-console（201）。
- 外部：本机 `~/.pi` 会话、pi CLI（可选）、Docker（hub 测试环境）。
