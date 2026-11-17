# 006-sync-model-info — 任务清单（tasks.md）

> 依赖有序：Setup → Foundation（protocol → hub-service → sync-daemon → 插件）→ Story（hub-console 数据源）
> → Polish 联调。阶段：Specification → Development → Code Review → Testing → Bug Fix → Regression。
> 关联：spec.md / plan.md / test-cases.md；模块细化见 106 / 406。

## Setup
- [ ] T001 开发日志目录 `logs/<YYYYMMDD>-<N>/` + DEV_CHECKLIST.md
- [ ] T002 基线确认：`pnpm typecheck` / `pnpm test` / `pnpm build` 现状；Docker hub（12380）、
      本机 daemon（host=`laptop-win`）与三台 debian 测试机可达性记录
- [ ] T003 固化联调样本：pi 主机 `~/.pi/agent/sessions` 会话 cwd；记录 model 下发的真实模型列表

## Foundation — protocol（FR-006-001~004）
- [ ] T004 `packages/protocol/src/index.ts`：新增 MODEL_INFO_REQUEST_EVENT、THINKING_LEVELS、
      ModelInfoRequestState/ErrorCode、ModelInfoEntry/Result/RequestRecord/RequestEvent、MODEL_INFO_LIMITS
      —— `packages/protocol/src/index.ts`
- [ ] T005 `pnpm --filter @pi-agent-hub/protocol build` 通过，下游类型可解析

## Foundation — hub-service（FR-006-005~008/009~010，模块 spec 106）
- [ ] T006 `src/model-info-store.ts`（新）：ModelInfoStore 内存态机（create/get 惰性 60s expired、终态 5min
      清理、软上限 10000、ack/result host 归属校验）
- [ ] T007 `src/model-info-allow.ts`（新）：sanitizeModelInfoResult 白名单投影纯函数
- [ ] T008 `src/app.ts` 注册 4 个路由（发起/轮询/ack/result；会话解析、host 在线、result 脱敏兜底）
- [ ] T009 vitest：model-info-store / model-info-allow 单测
- [ ] T010 `pnpm --filter @pi-agent-hub/hub-service test && typecheck` 全绿

## Foundation — sync-daemon（FR-006-011~013 路由层，模块 spec 406）
- [ ] T011 `src/hub-client.ts`：modelInfoAck / modelInfoResult
- [ ] T012 `src/daemon.ts`：handleEvent 增 model_info_request 分支（ack → 插件 get_model_info → result；
      失败归一 agent_unsupported/agent_error）
- [ ] T013 `src/model-info-cache.ts`（可选）：daemon 侧 agentId+cwd 30–60s 缓存 + 强制刷新

## Foundation — sync-plugin-*（get_model_info，差异适配与投影）
- [ ] T014 501 pi：pi-rpc.ts 增 queryModelInfo；plugin.ts 注册 get_model_info handler（get_available_models +
      get_available_thinking_levels + get_state → 最小投影）
- [ ] T015 502 opencode：get_model_info（GET /api/model?types=chat + /api/model/default；reasoning 开/关 ⬜）
- [ ] T016 503 dsh：get_model_info（session/modelCatalog → ModelInfoResult；reasoningEffort → thinkingLevels）
- [ ] T017 daemon 本地与本机 pi 插件联调：`node dist/main.js run --config examples/sync-daemon.json`，
      console 发起 model-info 得到 completed

## Story — hub-console（数据源消费，UI 主体在 207，本模块仅数据层）
- [ ] T018 `src/api.ts`：ModelInfo 类型镜像 + createModelInfoRequest/pollModelInfoRequest/getModelInfo
      （30s TTL 缓存、AbortSignal、终态/expired/超时/403 处理）
- [ ] T019 会话切换/卸载取消轮询；错误态（agent_unsupported 空态、503、404）映射

## Polish — 联调与回归
- [ ] T020 Playwright：pi 会话 model 下拉数据与 `pi get_available_models` 一致；viewer 403；
      daemon 离线 503；opencode/dsh 测试机接入后返回各自模型列表或 agent_unsupported 空态
- [ ] T021 全仓 `pnpm typecheck && pnpm test && pnpm build` 零新增错误；文档（001 协议规范补 Model Info
      章节）标注
