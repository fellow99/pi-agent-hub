# 004-sync-session — 任务清单（tasks.md）

> 依赖有序；按 P（用户故事优先级）与 Setup→Foundation→Story→Polish 分层。
> 阶段：Specification → Development → Code Review → Testing → Bug Fix → Regression。

## Setup
- [ ] T001 规整开发日志目录 `logs/<YYYYMMDD>-<N>/` + DEV_CHECKLIST.md
- [ ] T002 确认构建基线：`pnpm build && pnpm typecheck` 全绿（已完成，Step 0）

## Foundational（协议与数据面）
- [ ] T003 `protocol`：ManifestAgent 增加可选 `homeDir?`、`displayName?`（version/capabilities 已有）
      —— `packages/protocol/src/index.ts`
- [ ] T004 `hub-service/db.ts`：新增 `agents` 表 + `upsertAgent` / `listAgents(hostId?)`
- [ ] T005 `sync-daemon/daemon.ts`：manifest agent 报文补充 version/homeDir/displayName
- [ ] T006 `hub-service/app.ts`：manifest 处理中登记 agent（upsertAgent，幂等）
- [ ] T007 `hub-service/app.ts`：实现 `GET /api/hub/agents`（host/kind/version/capabilities/homeDir/status/lastSeenAt）

## User Story 1 — console 智能体列表浏览
- [ ] T008 `hub-console/api.ts`：`listAgents()`
- [ ] T009 `hub-console/views/Agents.vue`：表格（host/kind/agentId/displayName/version/capabilities/homeDir/状态/LastSeen）
- [ ] T010 `hub-console/router.ts` + `App.vue`：注册 /agents 路由与导航入口

## User Story 2 — 端到端 session 同步闭环验证
- [ ] T011 本机起 hub-service（examples 配置, 127.0.0.1:8443）
- [ ] T012 本机起 sync-daemon `--once`（examples 配置, 本地插件路径），采集真实 `~/.pi` 会话
- [ ] T013 curl 验证：manifest→full 水位、增量同步、`/api/hub/sessions`、`/api/hub/agents`、`/transcript`
- [ ] T014 console 登录后浏览 Agent/Sessions/Detail 三页

## Polish（基础同步闭环）
- [x] T015 `pnpm build && pnpm typecheck` 回归全绿（2026-11-10 基线）
- [ ] T016 更新 specs/README.md 索引表（如必要）

---

# 附属文件落盘转存（对应 spec §8 / plan §7，2026-11-18 追加）

## A-Foundational（协议与存储）
- [x] T101 `protocol/src/index.ts`：`SYNC_ATTACHMENT_LIMITS`（10MB/10/100MB + mime 白名单）、`SyncAttachmentErrorCode`、TranscriptBlock 增加 attachment 成员
- [x] T102 `hub-service/sync-attachment-store.ts`（新）：save（校验+sha256+原子写+去重+回滚）/ read（hash 白名单）/ cleanupSession / SyncAttachmentError
- [x] T103 `__tests__/sync-attachment-store.test.ts`（新）：合法落盘、去重、mime 拒绝、超限拒绝、坏 base64、回滚不留残、hash 穿越拒绝、cleanup 幂等

## A-hub 接入
- [x] T104 `session-store.ts`：构造注入 SyncAttachmentStore；sync() 写镜像前提取 image/attachment 内联 part → save → 改写 part（删 dataBase64/data、写 url），full/delta/entriesRef 全覆盖
- [x] T105 `session-store.ts`：toTranscriptItem 三级出图（url → 存量 data-uri → 占位）+ attachment block；registeredAttachment() 注册表反查
- [x] T106 `app.ts`：装配 store；`GET /api/hub/sessions/:id/attachments/:hash`（400/404/注册表/immutable 缓存头/nosniff）；sync 路由映射 SyncAttachmentError → 422 稳定 code
- [x] T107 同步修正 SessionStore 既有测试实例化（构造参数变更）

## A-console
- [x] T108 `hub-console/src/api.ts`：TranscriptBlock 补 attachment 联合成员
- [x] T109 `BlockCard.vue`：image 改 el-image（preview-src-list + @error 占位兜底）；attachment 最小 el-link 下载分支

## A-dsh 插件
- [x] T110 `sync-plugin-dsh/plugin.ts`：toHubParts 解析 `attachment.attachmentId` → 读 `~/.dsh/attachments/v1/objects/<h2>/<hash>` → dataBase64；读不到降级占位；options.attachmentRoot 可覆盖

## A-质量门
- [x] T111 `pnpm build && pnpm typecheck && pnpm test` 全绿（138 tests，2026-11-18）

## A-评审跟进项（2026-11-18 代码评审后追加，本期不实现）
- [ ] T116 daemon 对 `attachment_too_large`/`attachment_mime_denied` 的纯文本降级重试（剥离附件 part 重放，响应/日志可追溯），消除「单坏条目冻结会话同步」（评审 I2）
- [ ] T117 dsh 插件附件 stat 预检：超 SYNC_ATTACHMENT_LIMITS.singleBytes 的对象不读盘/不上行，直接降级占位（评审 Minor 7，与 T116 联动）

## A-真机联调（Docker + 三端侧，详见 test-cases.md TC-101 起）
- [x] T112 重建本机 Docker stack（nginx 升 160m），端侧三机 renew/PM2 重启至 f75f03a
- [x] T113 opencode(3图)/pi(7图)/dsh(2图) 带图会话同步 → 落盘 + console el-image 出图（shots/ 4 张）
- [x] T114 存量 data-uri 9 block 兼容、同内容去重、安全矩阵 401/400/404、既有 block 回归无 console error
- [x] T115 TEST_REPORT 归档 logs/20261118-2/；0 失败用例，无 Bug Fix 阶段缺陷
