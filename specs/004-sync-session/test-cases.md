# Test Cases: 004-sync-session（session 同步全流程）

> 覆盖：协议/数据面、hub API、daemon↔plugin、console 页面、端到端真实数据。

## 后端 API（curl 直测 hub-service）

### TC-001: manifest 新会话返回 lastTimestamp=null（new）
- **Priority**: P1 · **Type**: Functional
- **Precondition**: hub-service 运行于 127.0.0.1:8443；daemon token 有效；目标 nativeId 未入库
- **Steps**: `POST /api/v1/sync/manifest`（agent 含该 nativeId）
- **Expected**: 该 session `status=new` 且 `lastTimestamp=null`，`hubSessionId` 形如 `hs_...`（26 位 base32 小写）

### TC-002: full 同步后会话可读回（合并闭环）
- **Priority**: P1 · **Type**: Functional
- **Precondition**: TC-001 后拿到 hubSessionId
- **Steps**: `POST /api/v1/sync/sessions/{id}`（mode=full，entries 取自真实 `~/.pi` 会话 canonical 化）
- **Expected**: `status=ok`、`merged>0`、返回 lastTimestamp/lastEntryId/entryCount；随后 `GET /api/hub/sessions/{id}/transcript` items 非空

### TC-003: 增量同步幂等（同 entryId 跳过）
- **Priority**: P1 · **Type**: Edge Case
- **Precondition**: 会话已 full 同步
- **Steps**: 再次提交同一批 entries（mode=delta，since=旧水位）
- **Expected**: `skipped = 该批条目数`、`merged=0`，entryCount 不变

### TC-004: delta 携带 ts<since 的条目 → 422 entry_before_since
- **Priority**: P2 · **Type**: Edge Case
- **Precondition**: 会话已同步至水位 t
- **Steps**: mode=delta 提交 timestamp 早于 since 的条目
- **Expected**: HTTP 422，`error.code=entry_before_since`

### TC-005: 未知 token → 401 token_unknown
- **Priority**: P1 · **Type**: Security
- **Precondition**: —
- **Steps**: 用随机 Bearer 调 `/api/v1/meta`
- **Expected**: 401，`error.code=token_unknown`

### TC-006: agent 自动登记并可查询
- **Priority**: P1 · **Type**: Functional
- **Precondition**: daemon 已完成一次 manifest（agent 报文含 kind/version/homeDir）
- **Steps**: `GET /api/hub/agents`（登录 console 会话后）
- **Expected**: items 含该 (hostId,agentId)，字段齐全（kind/version/capabilities/homeDir/status）；再次 manifest 不重复建档（幂等）

### TC-007: viewer 调写接口 → 403
- **Priority**: P1 · **Type**: Security
- **Precondition**: viewer 登录（Cookie + CSRF）
- **Steps**: `POST /api/hub/deliveries`
- **Expected**: 403 forbidden_role

### TC-008: 会话列表按 updated_at DESC 且不含 deleted
- **Priority**: P2 · **Type**: Functional
- **Precondition**: 至少 1 个同步的会话
- **Steps**: `GET /api/hub/sessions`
- **Expected**: items 按 updated_at 降序，接口仅 GET（无写方法）

## 端到端（daemon + 插件 + 真实 ~/.pi）

### TC-009: pi 插件采集 ~/.pi 会话并归一（list/read）
- **Priority**: P1 · **Type**: Integration
- **Precondition**: 本机 `~/.pi/agent/sessions` 有真实 jsonl
- **Steps**: 起 sync-daemon `--once`，观察日志 list_sessions/read_session
- **Expected**: 成功列出 ≥1 会话，全量读取通过 `validateEntries`，无 invalid_output

### TC-010: daemon manifest→full→水位闭环
- **Priority**: P1 · **Type**: Integration
- **Precondition**: hub 运行，daemon 首次同步
- **Steps**: 观察 daemon 日志 + 查 hub sessions 行 last_timestamp
- **Expected**: 新会话 last_timestamp=null → full 同步 → last_timestamp 更新为非空、entry_count 与源一致

### TC-011: 二次运行差量（更新源后增量）
- **Priority**: P2 · **Type**: Integration
- **Precondition**: TC-010 完成
- **Steps**: 再次运行 daemon `--once`
- **Expected**: 已同步会话 status 非 skipped 时仅提交 ts>since 的新条目；重复同步不产生重复条目

## 前端 UI（console）

### TC-012: Agents 页浏览
- **Priority**: P1 · **Type**: Functional
- **Precondition**: admin 登录；已有 agent 数据
- **Steps**: 打开 `/hub/agents`
- **Expected**: 表格展示 host/kind/version/capabilities/homeDir/LastSeen

### TC-013: Sessions 页列表 + 打开正文
- **Priority**: P1 · **Type**: Functional
- **Precondition**: 已有同步会话
- **Steps**: 打开 `/hub/sessions` → 点击会话行
- **Expected**: 列表字段完整；详情页正文分块渲染、只读（无编辑/发送控件）

### TC-014: 登录/登出与导航
- **Priority**: P2 · **Type**: Functional
- **Precondition**: —
- **Steps**: 登录（admin）→ 顶栏含 Sessions/Agents/Hosts → 登出回 /login
- **Expected**: 步骤均符合预期；未登录访问受保护页跳登录

## 回归（构建质量）
### TC-015: build + typecheck 全绿
- **Priority**: P1 · **Type**: Quality
- **Steps**: `pnpm build && pnpm typecheck`
- **Expected**: 0 error
