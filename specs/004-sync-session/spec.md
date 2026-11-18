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
  => 调用 sync-plugin-pi-cli（采集 ~/.pi 会话）
  => 提交 manifest 到 hub-service
     => hub 返回各 session 的最后时间戳（null 需完整同步）
  => daemon 依据时间戳调用 sync-plugin-pi-cli 提取增量上下文
  => 同步到 hub-service
=> hub-service 合并 session 上下文内容（JSONL 镜像 + SQLite 索引）
=> hub-console 浏览智能体列表 / session 列表 / session 会话内容
```

### 1.2 解决的问题
- 让「端侧采集 → 差分上行 → 服务端合并 → 前端浏览」不再只是各模块脚手架，而是**可联调、可验证**的完整链路。
- 补齐 scaffold 缺失的「智能体实例」登记与浏览（manifest 自动登记 agent，console 增加 Agents 页面）。
- 以本机真实 `~/.pi` 会话数据为样本做端到端验证。

### 1.3 范围
- 包含：sync-plugin-pi-cli 采集/归一化、sync-daemon 对接 hub 与插件（manifest/差分/同步）、
  hub-service 同步接口与查询接口、hub-service agent 实例登记、hub-console 智能体列表浏览。
- 不包含：upload 流转发、下行 deliver/import 全链路重试、脱敏、FTS5 全文搜索（各模块既有 TODO）。

## 2. 用户故事
- 作为 daemon，我周期性地让 pi 插件读取 `~/.pi` 会话清单并上报 manifest，再从 hub 拿到水位，按需增量提取并同步。
- 作为 hub，我把各主机上报的 session 合并为 pi v3 镜像，并随 manifest 自动登记 agent 实例供查询。
- 作为登录用户，我可在 console 浏览智能体列表、会话列表，并打开某会话阅读正文（只读）。

## 3. 功能需求

### 3.1 sync-plugin-pi-cli（采集与归一化）
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
- 工程：hub-service（101/102/103）、sync-daemon（401）、sync-plugin-pi-cli（501）、hub-console（201）。
- 外部：本机 `~/.pi` 会话、pi CLI（可选）、Docker（hub 测试环境）。

---

# 8. 附属需求：会话同步-附属文件（图像与附件落盘转存）

> 设计文档：[`docs/004-会话同步-附属文件.md`](../../docs/004-会话同步-附属文件.md)（方案 B：hub 同步落盘转存，v0.1）
> 状态：In-progress（2026-11-18 启动）· 本期落地范围 = **image 端到端**；`attachment` 通用 part 协议面先行，video/audio/pdf 渲染标 ⬜ 后续迭代。

## 8.1 背景与问题
三环境（pi / opencode / dsh）会话同步后，聊天上下文图片因 transcript image block `url` 恒为空，
前端只能渲染 `image: <mime>` 占位标签。根因：hub 无同步侧附件转存，`toTranscriptItem()` 组装 image block 时丢弃一切二进制。

- opencode v2：插件已把 `message.files[].data`（base64）作 `dataBase64` 上传（数据已可得）。
- pi（pi-web）：会话文件 part 为 `{type:"image", data: base64, mimeType}`，镜像已含数据，hub 组装时丢弃 `part.data`。
- dsh：会话里是 `attachmentId: "sha256:<hash>"` 引用，插件读侧只传 mimeType、未读 `~/.dsh/attachments/v1/objects/` 对象库。

## 8.2 方案要点（决策记录 D1–D7 见设计文档 §12）
- 方案 B：附件数据不内联进 transcript，**落盘 + 只传 url 引用**；落盘根 `${dataDir}/sync/`，与 `deliveries/` 平级。
- 单文件路径 `${dataDir}/sync/<host>/<agent>/<hubSessionId>/<sha256hex>`；内容寻址，同会话自动去重。
- 落盘时机：`sessions.sync()` **写镜像前**；落盘后 part 改写为 `{type, mimeType, url}`，删除 `dataBase64/data`（镜像只存引用）。
- 读取面：浏览器经 `/api/hub`（session cookie + GET 免 CSRF）读取，hash 白名单 + block url 注册表双重校验。
- 存量镜像**不迁移、不重写**：读取侧对仍带内联 base64 的 part 即时转 data-uri 出图。

## 8.3 功能需求

### 8.3.1 协议与限额（protocol）
- FR-004-A01: MUST 导出 `SYNC_ATTACHMENT_LIMITS`：`singleBytes=10MB`、`maxCount=10`（单条消息）、`totalBytes=100MB`（单次同步）、mime 白名单 `image/*`、`video/*`、`audio/*`、`application/pdf`。
- FR-004-A02: canonical image/attachment part 类型文档化：image 读入统一 `dataBase64 = part.dataBase64 ?? part.data`；新增 `{type:"attachment", mimeType, dataBase64, name?, width?, height?}` 形态，落盘后改写为 `{type, mimeType, url, name?}`。

### 8.3.2 hub-service 落盘（SyncAttachmentStore）
- FR-004-A03: MUST 新增 `src/sync-attachment-store.ts`：`save(host, agent, sessionId, parts)` 逐条校验（mime 白名单 / 单文件 10MB / 单消息 10 个 / 单批 100MB）→ sha256 内容寻址 → 临时文件 + 原子 rename 落盘；同 hash 已存在即跳过（幂等去重）。
- FR-004-A04: 任一部分校验/写入失败 MUST 回滚本轮新增文件并抛 `SyncAttachmentError`（带稳定 error code），使整批同步失败、不污染镜像；daemon 可安全重试。
- FR-004-A05: MUST 提供 `read(host, agent, sessionId, hash)`（hash 强制 `^[0-9a-f]{64}$`）与 `cleanupSession(host, agent, sessionId)`（幂等 rm -rf 会话附件目录，供会话删除/GC 钩子调用）。

### 8.3.3 hub-service 同步接入与读取兼容
- FR-004-A06: `SessionStore.sync()` MUST 在写镜像前提取本批 entries 全部含内联数据的 image/attachment part，落盘并把原 part 改写为 url 引用（删除 base64 字段）；full/delta 两模式均生效，上传（entriesRef）路径同样覆盖。
- FR-004-A07: `toTranscriptItem()` image 分支 MUST 按 `part.url`（新同步落盘引用）→ `part.dataBase64 ?? part.data` 即时 data-uri（存量内联兼容，不落盘不改写）→ 空占位 三级出图；attachment part 产出 `kind:"attachment"` block（含 mime/url/name）。
- FR-004-A08: MUST 注册 `GET /api/hub/sessions/:hubId/attachments/:hash`：cookie 鉴权（GET 免 CSRF）；hash 格式非法→400；会话不存在→404；仅当该会话镜像某 block 的 url 等于请求 URL 才放行（注册表校验，防任意文件暴露）；文件缺失→404。
- FR-004-A09: 附件响应 MUST 带 `Content-Type`（取自注册 block 的 mime，不从内容推断）、`Cache-Control: public, max-age=31536000, immutable`、`ETag: "<hash>"`、`X-Content-Type-Options: nosniff`。

### 8.3.4 hub-console 渲染
- FR-004-A10: `BlockCard.vue` image 分支：`url` 非空 MUST 渲染 `<el-image>`（支持点击预览 `preview-src-list`）+ 加载失败占位兜底；`url` 空保留 `image: <mime>` 占位。attachment 的 video/audio/pdf 分发渲染标 ⬜ 后续，本期最小降级为下载链接。

### 8.3.5 插件适配
- FR-004-A11: opencode / pi-web 插件 MUST 零改动（hub 统一读 `dataBase64 ?? data`，真机回归验证）。
- FR-004-A12: `sync-plugin-dsh` readSession 读侧 MUST 解析 image part 的 `attachment.attachmentId`（`sha256:<hash>`），从 `~/.dsh/attachments/v1/objects/<hash前2位>/<hash>` 读对象转 base64，产出 `{type:"image", mimeType: mediaType, dataBase64, name?}`；对象读不到时降级为仅 mimeType 占位，不阻断同步。

## 8.4 关键实体
| 实体 | 说明 |
|---|---|
| SyncAttachmentInput | 落盘入参 `{mime, dataBase64, name?}` |
| SyncAttachmentRef | 落盘引用 `{mime, url, sha256, bytes}` |
| 镜像 image/attachment part | 落盘后脱敏形态 `{type, mimeType, url, name?}`，url = `/api/hub/sessions/<hs>/attachments/<hash>` |

## 8.5 验收场景
- **场景 A：新同步带图落盘**：opencode/pi/dsh 任一环境带图会话同步后，transcript image block `url` 非空；dataDir 落盘 sha256 文件；console `<el-image>` 可见。
- **场景 B：存量兼容**：上线前已同步的含内联 base64 镜像，不迁移不改写，读取以 data-uri 出图，镜像文件字节不变。
- **场景 C：幂等去重**：同会话同图重复同步，落盘仅 1 份文件，db 条目幂等。
- **场景 D：安全**：无 cookie→401；伪造 hash（非 64 位 hex / `../`）→400；未注册 hash→404；越界附件（>10MB / >10 张 / 非白名单 mime）整批拒绝。
- **场景 E：回归**：text/thinking/toolCall/toolResult/bash 等既有 block 渲染与同步不受影响；`pnpm build && pnpm typecheck` 全绿。

## 8.6 非功能需求
- 安全：路径穿越防护（hash 白名单 + 目录段只取自 SessionRow，不可由 URL 构造）；未授权读取防护（cookie + 注册表）；nosniff。
- 性能：sha256 内容寻址天然长缓存；附件不进 transcript 响应，首屏不携带二进制。
- 可靠：落盘失败整批回滚、同步失败可重试；db 失败残留文件由 GC 兜底（`gcSyncAttachments` 手工命令 ⬜ 后续）。
- 严格类型：无 `any`/`@ts-ignore`；改动后 `pnpm typecheck` 全绿。
