# 407-sync-daemon-push-prompt 功能规格（sync-daemon 部分）

> Module: 407-sync-daemon-push-prompt（下发聊天消息：同步程序部分设计）
> 需求编号：007-push-prompt（daemon 子需求）
> Status: In-progress
> Last Updated: 2026-11-17
> 关联：[007-push-prompt/spec.md](../007-push-prompt/spec.md)（主设计）、docs/007-下发聊天消息.md §3/§4/§5、
> 既有 401-sync-daemon（handleDeliver 现有实现）

## 1. 模块概述

### 1.1 目的

在 sync-daemon 内把 `handleDeliver` 从「转发文本」提升为完整执行端：同 session 串行、本地幂等、空闲检查/
冲突（C-1 单写者）、下载交付图片、携带 `model`/`thinkingLevel`/`images` 调插件 `deliver`、ack/result、
成功后触发该会话同步。

### 1.2 范围

- 包含：`handleDeliver` 扩展（串行锁/幂等表/图片下载/字段转发/同步触发）、`hub-client.ts` 图片下载方法、
  错误归一、vitest 单测。
- 不包含：agent 具体执行（插件侧，见 501/502/503）、job 调度/审计（hub 侧 107）。

## 2. 用户故事

- 作为 daemon，我对同一 native session 的 deliver 串行执行；本地已完成表命中重复事件直接回原结果；
  会话被外部占用且非 force 时回 `conflict`（不重试）。
- 作为运维者，daemon 重启后幂等表从磁盘加载，避免重复投递；图片下载失败/白名单异常回 `agent_error`。

## 3. 功能需求

### 3.1 串行与幂等（daemon.ts）

- FR-407-001: MUST 以 `Map<key, Promise<void>>`（key = `agentId + "\0" + nativeId`）链式串行化同一目标
  session 的 deliver，避免并发写（C-1 单写者）；不同 session 可并发。
- FR-407-002: MUST 维护本地幂等表（`<dataDir>/deliveries-done.json`，建议 7 天保留）：收到已完成的
  deliveryId → 直接回原 result 成功；启动时从磁盘加载。
- FR-407-003: 空闲/冲突检查 MUST（pi：取得会话文件 mtime 更新（近 120s 有写）或 `get_state` 判定；
  其它 agent 用插件能力或回退）——非空闲且非 `force` → 回 `conflict`（`retryable:false`，不重试）。

### 3.2 图片下载与字段转发（hub-client.ts + handleDeliver）

- FR-407-004: MUST 新增 `downloadDeliveryImage(deliveryId, index, destPath)`：`GET /api/v1/deliveries/:id/images/:index`
  （Bearer），下载到 `<pluginRoot>/.work/<kind>/deliveries/<deliveryId>/img/<index>`，校验 sha256。
- FR-407-005: `handleDeliver` MUST 解析事件新增字段 `model`、`thinkingLevel`、`images[{mime,url,sha256,bytes}]`，
  下载后转插件 `DeliverRequest.images = [{mime, path}]` 并透传 `model`/`thinkingLevel`/`policy`/`force`。
- FR-407-006: 插件调用超时 MUST 沿用 15min（现 `handleDeliver` 常量）；超时/异常 → `agent_error`。

### 3.3 ack/result 与同步触发

- FR-407-007: 执行顺序 MUST：ack →（保证顺序）串行执行 → result；result 携带 `warnings`（能力降级标注）。
- FR-407-008: 镜像幂等：result 幂等（同一 deliveryId 重复 → 原结果）；result 前后端成功即调用
  manifest 单项同步（该 agent 的 manifest → 差分 → POST /sync），使新消息尽快出现在 hub 镜像。

### 3.4 错误归一

- FR-407-009: 插件错误归一：`conflict`（空闲冲突，daemon 判定）→ `conflict`；`set_model` 失败 →
  `model_not_found`；能力缺失 → `unsupported`（warnings）；其它 → `agent_error`。

## 4. 错误码（daemon 产生）

`conflict` / `model_not_found` / `unsupported` / `agent_error` / `not_found`（会话/插件未找到）。

## 5. 测试要点

- 单测：`handleDeliver` 串行锁（并发两条同 session 排队）、幂等表（重复 id、磁盘加载）、冲突（非空闲 →
  conflict 且不重试）、图片下载失败归 agent_error、字段转发（mock runtime client 断言收参）。
- 集成：本机 pi 发送 → completed + 镜像出现新 user message；opencode/dsh 差异见主 spec TC-014。
