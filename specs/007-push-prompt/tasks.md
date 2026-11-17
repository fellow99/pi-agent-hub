# 007-push-prompt — 任务清单（tasks.md）

> 依赖有序：Setup → Foundation（protocol → hub-service → sync-daemon → 插件）→ Story（hub-console composer）
> → 三机部署与联调 → Polish。阶段：Specification → Development → Code Review → Testing → Bug Fix → Regression。
> 关联：spec.md / plan.md / test-cases.md；模块细化见 107 / 207 / 407。
> 前置依赖：006-sync-model-info（模型/思考深度数据源，建议先完成再进入 007 console 部分）。

## Setup
- [ ] T001 开发日志目录 `logs/<YYYYMMDD>-<N>/` + DEV_CHECKLIST.md
- [ ] T002 基线确认：typecheck/test/build 现状；Docker hub（12380）、本机 daemon（laptop-win）、
      三台 debian 测试机可达性
- [ ] T003 固化样本：pi 会话 cwd 与 nativeId；`pi get_available_models` 真实列表（供 006/007 断言）

## Foundation — protocol（FR-007-001~003）
- [ ] T004 `packages/protocol/src/index.ts`：DeliverRequest/DeliverEvent 扩展（model/thinkingLevel/images）、
      DeliveryPolicy、DELIVERY_IMAGE_LIMITS、交付错误码联合、DeliveryRecord 扩展
- [ ] T005 `pnpm --filter @pi-agent-hub/protocol build` 通过

## Foundation — hub-service（FR-007-004~018，模块 spec 107）
- [ ] T006 `src/image-store.ts`（新）：saveImages（base64 → mime/大小/张数校验 → 落盘 → sha256/bytes）、
      deliveryImagesDir、GC 挂钩
- [ ] T007 `src/deliveries.ts`（新，取代 app.ts 内联 Map）：DB 持久化（建表/迁移新增列）、态机迁移、
      per-session 串行队列、图片清单、pending 补齐
- [ ] T008 `src/app.ts`：`POST /api/hub/deliveries` 扩展（图片落盘 + model/thinkingLevel + 202/queued）；
      `GET /api/hub/deliveries/:id`、`POST /api/hub/deliveries/:id/cancel`；
      `GET /api/v1/deliveries/:deliveryId/images/:index`（Bearer + host 归属 + Range）；
      ack/result 重投（ack 60s/result 10min/attempt 5）；`GET /api/v1/deliveries?state=pending`；
      `express.json({limit:"160mb"})`
- [ ] T009 vitest：image-store / deliveries 态机（迁移/重投/cancel/串行/幂等）
- [ ] T010 `pnpm --filter @pi-agent-hub/hub-service test && typecheck` 全绿

## Foundation — sync-daemon（FR-007-014~017，模块 spec 407）
- [ ] T011 `src/daemon.ts` handleDeliver 扩展：同 session 串行锁、本地幂等表（7 天）、空闲检查/conflict、
      图片下载到临时文件、model/thinkingLevel/images 转发、result 后触发该会话同步
- [ ] T012 `src/hub-client.ts`：downloadDeliveryImage（Bearer + sha256 校验）、pending 列出
- [ ] T013 vitest：串行/幂等/conflict 单测；停机重启幂等表加载

## Foundation — sync-plugin-*（deliver 差异适配）
- [ ] T014 501 pi：promptPiSession 扩展（get_state → set_model? → set_thinking_level? → prompt + images：
      ImageContent 转换；set_model 失败 → model_not_found 且不发 prompt）
- [ ] T015 502 opencode：deliver（ACP 优先 → POST /api/session/{id}/prompt；图片文件附件；模型 Model.Ref；
      thinkingLevel reasoning 开/关 ⬜）
- [ ] T016 503 dsh：deliver（session/prompt PromptContentPart；selectModel 前置；mode=queue）
- [ ] T017 本机 daemon + pi 插件联调：文本/多图/模型/思考深度发送全流程 completed

## Story — hub-console（FR-007-019~024，模块 spec 207）
- [ ] T018 `src/api.ts`：Delivery 类型 + sendDelivery/pollDelivery/cancelDelivery（1s 轮询至终态、
      AbortSignal、completed 回调）
- [ ] T019 `src/components/ChatComposer.vue`（新）：textarea/图片按钮与预览/模型按钮/思考深度按钮/策略菜单
      （idle-only|force 二次确认）/发送/状态条；viewer 禁用态；会话切换清空
- [ ] T020 `src/components/ModelSelector.vue` / `ThinkingLevelSelector.vue`（消费 006 getModelInfo）
- [ ] T021 `TranscriptPane.vue` 底部接入 ChatComposer；完成后调用 loadTail() 刷新正文
- [ ] T022 `pnpm --filter @pi-agent-hub/hub-console typecheck && build` 通过

## Deploy — 三台 debian 测试机 + Docker 配置收敛
- [ ] T023 Docker `deploy/data/hub-service.json`：删除 default/ser9/laptop-win 之外 daemonTokens，配置
      三台测试机（pi .100 / opencode .109 / dsh .112）连通
- [ ] T024 .100 部署 sync-daemon + pi 插件（连接 hub 12380），会话同步正常
- [ ] T025 .109 部署 sync-daemon + opencode 插件；.112 部署 sync-daemon + dsh 插件
- [ ] T026 三机 deliver 差异适配实测（文本；opencode/dsh 图片/模型能力标注）

## Polish — 联调与回归
- [ ] T027 Playwright：admin 发送全流程；viewer 禁用；多图/模型/思考深度；queued 重投；force 二次确认
- [ ] T028 全仓 `pnpm typecheck && pnpm test && pnpm build` 零新增错误；文档（001 补 Chat Deliver 章节、
      docs 006/007 状态更新）
