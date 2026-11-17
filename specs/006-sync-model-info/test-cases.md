# Test Cases: 006-sync-model-info（模型信息同步 Model Info Bridge）

> 覆盖：协议类型、hub 态机/脱敏、daemon 路由、插件差异适配（pi/opencode/dsh）、console 数据源、安全与回归。
> 环境：Docker 栈 `http://localhost:12380`；本机 Node 跑 sync-daemon（host=`laptop-win`）连 pi 插件；
> 三台 debian 测试机（pi .100 / opencode .109 / dsh .112）用于插件差异回归。
> 单测 vitest；UI 用 Playwright（Chromium）；凭据：admin/viewer（1q2w3e4r / 1q2w3e4r），daemon token 见 deploy/data/hub-service.json。

## 一、单元测试（vitest，P1 为主）

### TC-001: 脱敏投影（P1，Security）
- **Precondition**: sanitizeModelInfoResult；输入含 `headers/baseUrl/api/cost/samplingParams` 的完整 Model 对象
- **Steps**: 传入含敏感字段的 models 数组
- **Expected**: 仅保留 provider/modelId/name/reasoning/input/thinkingLevels；敏感字段全部丢弃

### TC-002: 兜底校验——非法类型（P1，Security）
- **Steps**: `input` 或 `thinkingLevels` 传非字符串数组；result 顶层含未知字段
- **Expected**: 返回 `invalid_result`（不落 completed）；未知顶层/模型字段被丢弃

### TC-003: 态机正常迁移（P1，Functional）
- **Steps**: create → ack(同 host) → result(ok:true)
- **Expected**: dispatched → accepted → completed，result 落记录、时间戳齐全

### TC-004: result 失败迁移（P1，Functional）
- **Steps**: result(ok:false, {code:"agent_unsupported"})
- **Expected**: state=failed，error 结构完整

### TC-005: TTL 惰性 expired + 终态清理（P1/P2，Edge）
- **Steps**: >60s 未终态 get → expired；completed >5min get → undefined；未知 id → undefined
- **Expected**: 符合语义；无后台定时器

### TC-006: 跨 host 冒写拒绝（P1，Security）
- **Steps**: token A 的 daemon 往 host B 的 requestId 回 ack/result
- **Expected**: 拒绝（host_mismatch），状态不变

### TC-007: pi queryModelInfo 投影（P1，Functional）
- **Precondition**: mock `pi --mode rpc` 子进程输出
- **Steps**: 模拟 get_available_models/get_available_thinking_levels/get_state 响应
- **Expected**: 映射正确；thinkingLevels 与 getSupportedThinkingLevels 一致；超时归 agent_error

## 二、集成测试（Docker + daemon + Playwright，P1 为主）

### TC-008: pi 会话模型列表（P1，Functional）
- **Steps**: admin 登录 → 选 pi 会话 → 发起 model-info
- **Expected**: models 与 `pi get_available_models` 一致；currentModel 非空；30s 内 completed

### TC-009: cwd 作用域随会话变化（P2，Functional）
- **Steps**: 分别选两个不同 cwd 的 pi 会话发起
- **Expected**: 模型列表随项目作用域变化（验证按 session 粒度）

### TC-010: viewer 403 / daemon 离线 503 / 会话不存在 404（P1，Security/Error）
- **Steps**: viewer POST 发起；停 daemon 后发起；乱 sessionId
- **Expected**: 403 / 503（无悬空记录）/ 404；恢复后链路正常

### TC-011: opencode / dsh 差异（P2，Functional）
- **Steps**: 在 .109（opencode）/.112（dsh）daemon 接入后选对应会话发起
- **Expected**: opencode 返回 `GET /api/model` 模型列表（或 agent_unsupported 空态）；dsh 返回
  `session/modelCatalog` 模型目录（provider 分组 + reasoning efforts）；选择器渲染不崩溃

## 三、回归

- 既有 fs_request/deliver/import/export SSE 链路不受新事件分支影响；右栏文件树/子 agent/正文不变；
  全仓 typecheck 零新增错误。
