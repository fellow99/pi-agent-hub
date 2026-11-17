# Test Cases: 007-push-prompt（下发聊天消息 Chat Deliver）

> 覆盖：协议扩展、hub 图片/态机/持久化、daemon 串行/幂等/冲突、插件差异（pi/opencode/dsh）、console composer、
> 安全与回归。环境：Docker 栈 `http://localhost:12380`；本机 daemon（laptop-win）+ pi 插件；
> 三台 debian 测试机（pi .100 / opencode .109 / dsh .112）。单测 vitest；UI Playwright；
> 凭据：admin/viewer（1q2w3e4r / 1q2w3e4r），daemon token 见 deploy/data/hub-service.json。

## 一、单元测试（vitest，P1 为主）

### TC-001: 空消息与纯图片校验（P1，Functional）
- **Steps**: text 空且 images 空 → 400；text 空但 images 非空 → 通过（纯图片消息）；text/others 非法类型 → 400
- **Expected**: 符合「text 与 images 至少一项非空」

### TC-002: thinkingLevel 校验（P1，Functional）
- **Steps**: 非空字符串通过；空串/非字符串 → 400 invalid_request
- **Expected**: hub 只做「非空字符串」校验，不做跨 agent 枚举校验

### TC-003: 图片 mime/大小/张数（P1，Security）
- **Steps**: 非法 mime；单张 >10MB；>10 张；base64 解码失败
- **Expected**: image_invalid / image_too_large；张数超限拒绝；不落盘

### TC-004: 图片落盘与 SSE URL（P1，Functional）
- **Steps**: 2 张合法图片 → POST /deliveries
- **Expected**: 落盘 `dataDir/deliveries/<id>/images/0|1`，sha256/bytes 正确；SSE 只带 url（无 base64）

### TC-005: 态机迁移与 cancel（P1，Functional）
- **Steps**: queued→dispatched→accepted→completed；accepted 后再 cancel → 无效（仅未 dispatched 生效）
- **Expected**: 状态符合 FR-007-012；cancel 幂等

### TC-006: ack/result 超时重投与 expired（P1，Edge）
- **Steps**: ack 超 60s → attempt++ 重投（≤5）；result 超 10min → expired
- **Expected**: attempts/expiresAt 更新；attempt>5 → expired 不再重投

### TC-007: per-session 串行 + conflict（P1，Security/Functional）
- **Steps**: 同 session 并发两条 deliver；串行锁排队；空闲检查:非空闲且非 force → conflict
- **Expected**: 串行执行；conflict retryable:false、不重试

### TC-008: deliveryId 幂等（P1，Security）
- **Steps**: 同 deliveryId 重复 result / daemon 本地已完成表命中
- **Expected**: 幂等返回原结果

### TC-009: pi 插件 set_model / set_thinking_level / images（P1，Functional）
- **Steps**: queryModel 指定不存在模型；指定 thinkingLevel；带 1 图（path）
- **Expected**: set_model 失败 → model_not_found 且不发 prompt；set_thinking_level 仅在 != 当前时发送；
  ImageContent base64 正确

## 二、集成测试（Docker + daemon + Playwright，P1 为主）

### TC-010: admin 文本发送全流程（P1，Functional）
- **Steps**: 选 pi 会话 → 底部输入「继续把测试补上」→ 发送 → 轮询状态
- **Expected**: 排队→下发→接受→完成；完成后 transcript 尾部出现新 user message（经同步回显）

### TC-011: 多图发送（P1，Functional）
- **Steps**: 上传 2 张 → 发送
- **Expected**: daemon 下载图片、pi 收到 images 并完成；超限/非图片被 400

### TC-012: 模型+思考深度切换（P2，Functional）
- **Steps**: 模型/思考深度按钮选择后发送
- **Expected**: 会话镜像出现 model_change / thinking_level_change meta 标签（随同步出现）

### TC-013: viewer 禁用 / 未选会话禁用 / daemon 离线 queued 重投 / force（P1/P2，Functional/Error）
- **Steps**: viewer 看 composer 禁用；未选会话禁用；停 daemon 发消息 → queued；作 force → 二次确认弹窗
- **Expected**: viewer POST 被 403；daemon 恢复后 queued 自动 dispatch；force 仅 admin 生效

### TC-014: 三机差异适配（P2，Functional）
- **Steps**: .109（opencode）、.112（dsh）、.100（pi）分别从会话发文本
- **Expected**: pi 全能力；opencode 走 ACP/HTTP 文本（图片/模型能力按标注）；dsh 走 session/prompt；
  不支持项 warnings 标注不阻塞

## 三、回归

- 既有 fs_request/model_info/import/export 不受影响；只读查看、搜索、右栏文件树/子 agent 不变；
  全仓 typecheck 零新增错误。
