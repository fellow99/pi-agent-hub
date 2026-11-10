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

## Polish
- [ ] T015 `pnpm build && pnpm typecheck` 回归全绿
- [ ] T016 更新 specs/README.md 索引表（如必要）
