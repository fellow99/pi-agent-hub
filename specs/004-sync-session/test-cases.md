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

---

# 附属文件落盘转存测试用例（对应 spec §8 / plan §7，2026-11-18 追加）

> 环境：本机 Docker Desktop（hub stack，127.0.0.1:12380）+ 三台 debian 端侧（pi .100 / opencode .109 / dsh .112）。
> 证据：curl 请求/响应、dataDir/sync 落盘清单、console Playwright 截图，归档 `logs/20261118-2/`。

## A. 单元测试（vitest，sync-attachment-store.test.ts）

### TC-101: 合法附件落盘并返回引用
- **Priority**: P1 · **Type**: Functional
- **Steps**: save 1 个合法 PNG（base64）
- **Expected**: 返回 `{mime, url:/api/hub/sessions/<hs>/attachments/<64hex>, sha256(64), bytes}`；文件落在 `sync/<host>/<agent>/<hs>/<sha256>`，内容字节与解码一致

### TC-102: 同内容去重（幂等）
- **Priority**: P1 · **Type**: Edge Case
- **Steps**: 同会话两次 save 同一 base64
- **Expected**: 目录仅 1 个文件；两次 ref 一致；不报错

### TC-103: mime 白名单
- **Priority**: P1 · **Type**: Security
- **Steps**: 分别提交 `image/png`（允）、`video/mp4`（允）、`audio/mpeg`（允）、`application/pdf`（允）、`application/x-exec`（拒）、`text/html`（拒）
- **Expected**: 拒绝项抛 SyncAttachmentError(code=attachment_mime_denied)，允许项落盘

### TC-104: 大小/数量/总量限额
- **Priority**: P1 · **Type**: Edge Case
- **Steps**: 构造 >10MB 单文件、单 entry 11 个附件、单批总量 >100MB
- **Expected**: 分别抛 attachment_too_large；整批拒绝且无文件残留

### TC-105: 坏 base64 / 空数据拒绝
- **Priority**: P2 · **Type**: Edge Case
- **Expected**: SyncAttachmentError(attachment_invalid)，无残留

### TC-106: 失败回滚不污染
- **Priority**: P1 · **Type**: Edge Case
- **Steps**: 一批中混入 1 个非法 mime
- **Expected**: 本轮新建文件全部回滚（先前已存在的去重文件保留），抛错

### TC-107: read 与路径穿越防护
- **Priority**: P1 · **Type**: Security
- **Steps**: read 合法 hash 命中；read `../x`、非 64hex、大写 hex
- **Expected**: 非法格式返回 null（路由映射 400/404）；合法返回 buffer

### TC-108: cleanupSession 幂等
- **Priority**: P2 · **Type**: Functional
- **Expected**: 删除会话附件目录；重复调用不抛错

## B. hub API（curl 直测，cookie/Bearer）

### TC-109: 同步带图会话 → 镜像脱敏 + 落盘
- **Priority**: P1 · **Type**: Integration
- **Precondition**: daemon token；构造含 `{type:"image", mimeType:"image/png", dataBase64}` 的 full 同步
- **Steps**: POST /api/v1/sync/sessions/:id 后查镜像 jsonl 与 dataDir/sync
- **Expected**: 同步 200；镜像 part 无 dataBase64/data、含 url；sync 目录有 1 个 sha256 文件

### TC-110: pi 形态 `data` 字段统一读入
- **Priority**: P1 · **Type**: Integration
- **Steps**: part 用 `{type:"image", data:<base64>, mimeType}`（无 dataBase64）同步
- **Expected**: 同等落盘出 url（hub 统一 `dataBase64 ?? data`）

### TC-111: 附件读取端点 200 + 缓存头
- **Priority**: P1 · **Type**: Functional
- **Steps**: 登录 console 取 cookie，GET /api/hub/sessions/:id/attachments/:hash
- **Expected**: 200，Content-Type=注册 mime、Cache-Control 含 immutable、ETag=`"<hash>"`、X-Content-Type-Options=nosniff，body 与源文件一致

### TC-112: 安全矩阵
- **Priority**: P1 · **Type**: Security
- **Steps**: a) 无 cookie GET →401；b) hash 非 64hex（含 `..`、`aa/bb`）→400；c) 会话不存在 →404；d) 合法 hash 但该会话镜像未注册（换另一会话 id 拼 URL）→404；e) 文件被删后 GET →404
- **Expected**: 全部符合，不泄露文件存在性与目录结构

### TC-113: 存量内联镜像 data-uri 兼容（不迁移）
- **Priority**: P1 · **Type**: Compatibility
- **Precondition**: 保留/构造含内联 base64 image part 的旧镜像（上线前数据）
- **Steps**: GET transcript；对比镜像文件前后字节
- **Expected**: image block url 为 `data:image/png;base64,…` 且可渲染；镜像文件零改写

### TC-114: 超限同步整批 422
- **Priority**: P2 · **Type**: Edge Case
- **Expected**: 错误体 code 为 attachment_* 稳定枚举；daemon 重试同内容可成功（幂等）

## C. 端侧真机（三环境，Docker stack + rx.py 部署）

### TC-115: opencode（.109）带图会话同步出图
- **Priority**: P1 · **Type**: E2E
- **Steps**: renew 部署后 daemon 同步含 files[].data 的会话；console 打开
- **Expected**: el-image 可见、可点击预览；dataDir 落盘；对应设计验收 #1

### TC-116: pi（.100）带图会话（part.data）同步出图
- **Priority**: P1 · **Type**: E2E
- **Expected**: 7 条历史带图会话可读（新增走落盘 url、存量走 data-uri）；验收 #2/#3

### TC-117: dsh（.112）附件对象读取链路
- **Priority**: P1 · **Type**: E2E
- **Precondition**: 真机 `~/.dsh/attachments/v1/objects/` 有对象（已取证 f9/…、35/…）
- **Steps**: 插件 readSession 解析 attachmentId → 同步 → console 出图
- **Expected**: dataBase64 齐整、落盘可见（验收 #4）；模拟对象缺失时降级占位不阻断同步

### TC-118: 重复同步去重
- **Priority**: P2 · **Type**: E2E
- **Expected**: 同图重复同步后会话目录文件数不增；db entryCount 幂等（验收 #5）

### TC-119: 三环境 block 渲染回归
- **Priority**: P1 · **Type**: Regression
- **Expected**: text/thinking/toolCall/toolResult/bash/subagent 渲染不受影响；无 console 报错（验收 #8）

## D. 前端 UI（Playwright）

### TC-120: BlockCard image/attachment 渲染
- **Priority**: P1 · **Type**: UI
- **Steps**: 打开含图会话详情；截图；点击图片预览；构造 404 url 观察兜底
- **Expected**: el-image 正常显示/预览；失败显示占位而非破图；无 url 仍显示 `image: <mime>` 标签；attachment 显示下载链接

### TC-121: 全量质量门
- **Priority**: P1 · **Type**: Quality
- **Steps**: `pnpm build && pnpm typecheck && pnpm test`
- **Expected**: 0 error，新单测全绿
