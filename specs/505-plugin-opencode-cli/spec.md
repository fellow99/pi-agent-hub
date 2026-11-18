# 505-plugin-opencode-cli 功能规格（Specification）

> Module: 505-plugin-opencode-cli（**CLI 调用形态**：spawn `opencode` CLI）
> Status: Implemented（v0.1.0 scaffold）
> Last Updated: 2026-11-19
> 源：`packages/sync-plugin-opencode-cli/src/{main,plugin}.ts`
> 所属需求：004-sync-session · 006-sync-model-info · 007-push-prompt

## 1. 模块概述

### 1.1 目的
**opencode 适配器插件（CLI 调用形态）**：以「逐次 spawn `opencode` CLI 命令」的方式对接本机 opencode v2（≥2.3.0），
完成会话向 hub 的同步（collect）、模型信息查询（006）、消息下发（007，含图片与模型），并支持原生导出。
与 502 sync-plugin-opencode-serve（Server API 形态：HTTP 对接常驻 server）共同构成同一宿主的两套接入实现。

### 1.2 解决的问题
- 面向**不常驻 server** 的轻量接入：每次调用由 opencode CLI 自行决定连接后台 service 或拉起一次性 standalone，
  插件不持有 HTTP 端点、不配置 server 地址。
- 通过 CLI 子进程收敛 opencode 会话的内聚边界，隔离宿主版本差异（CLI 自带版本解析）。

### 1.3 范围
- 包含：initialize/detect、listSessions（`session list`）、readSession（`session export` 组装 canonical）、
  getModelInfo（`models` 投影）、deliver（`run`）、exportNative（`session export` 落盘）。
- 不包含：importSession（`unsupported`）、watch、常驻 server 对接（见 502）。
- kind：`opencode-cli`（与 502 的 `opencode` 区分，daemon 可同时加载两套）。

## 2. 用户故事
- 作为 hub 用户，我可以在 opencode 会话上选择模型、发送文本 / 图片消息，并刷新看到 user 消息与 agent 回应。
- 作为 daemon，我可以让 opencode-cli 插件以 spawn `opencode` 命令的方式列会话、读会话、下发 prompt，
  无需预先维护 opencode server 进程。

## 3. 功能需求

### 3.1 初始化/探测
- FR-505-001: `initialize` MUST 解析 options（openCommand 默认 `opencode`、cwd、timeoutMs）并返回能力位。
- FR-505-002: `detect` MUST 返回实例（id 由 cwd 稳定派生 `opencode-cli-<base64url(cwd)[:12]>`）。

### 3.2 采集（CLI，对应 004）
- FR-505-003: `listSessions` MUST 执行 `opencode session list --format json`（JSON 数组），
  映射为 NativeSessionMeta（nativeId/title/cwd/updatedAt/state）；同 id 多行按 updatedAt 保留最新。
- FR-505-004: `readSession` MUST 执行 `opencode session export <nativeId>`（单 JSON `{info,messages}`），
  按消息 type 组装 canonical：`user/synthetic` → message(role=user)、`assistant` → message(role=assistant，
  content 内 text→text / reasoning→thinking / tool→toolCall)、`system` → message(role=system)、
  其余类型（idle/compaction/agent-switched/model-switched/skill/shell）MUST 过滤。
- FR-505-005: 用户消息的 files（dataURI base64）MUST 转为 image part（`{type:"image",mimeType,dataBase64}`）。
- FR-505-006: 差量同步 MUST 支持 `since`（按 timestamp 过滤），full 前 `validateEntries` + `linearize`。

### 3.3 模型信息（CLI，对应 006）
- FR-505-007: `getModelInfo` MUST 执行 `opencode models`（纯文本每行 `providerID/model`），投影为
  ModelInfoEntry；因 CLI 无 reasoning/input/thinkingLevels 元数据，保守投影 reasoning=false、
  input=["text"]、thinkingLevels=["off"]（⬜ 待真机改进）。
- FR-505-008: 无会话专属 current 概念（models 为全局列表），currentModel/currentThinkingLevel 返回 null。

### 3.4 下发（CLI，对应 007）
- FR-505-009: `deliver` MUST 执行 `opencode run --session <nativeId> --format json --thinking [--model provider/model] [--file <path>] -- <message>`；
  消息 MUST 作为 `--` 之后的**单个 argv**（argv 直传无 shell 注入面，保留换行/缩进/代码块）；图片经 `--file` 传本地临时文件路径；指定 model 时用 `--model`。
- FR-505-010: 成功（exit 0）MUST 返回 ok+completed；非 0 退出 / 超时 MUST 归为 `agent_error`/`timeout`。
- FR-505-011: thinkingLevel 在 opencode v2 无专属 CLI 参数（经 model variant），MUST 忽略并不作为失败。

### 3.5 空闲与导出
- FR-505-012: `checkIdle` MUST 返回 `{idle:true}`（CLI 形态 deliver 为同步阻塞 run，无常驻态可查）。
- FR-505-013: `exportNative` MUST 执行 `opencode session export <nativeId>`，落盘 workDir/native/<id>.json + sha256/bytes。
- FR-505-014: `importSession` MUST 返回 `unsupported`。

## 4. 关键实体
| 实体 | 说明 |
|---|---|
| OpencodeCliOptions | openCommand/cwd/timeoutMs |
| OpencodeCliPlugin | CLI 形态插件实现 |
| CliResult | runCli 结果（exitCode/stdout/stderr/truncated） |

## 5. 验收场景
### 场景：CLI 会话同步（本地单元 / .109 真机）
- Given 本机有 opencode v2 会话
- When listSessions / readSession
- Then hub 显示会话列表与可读 transcript（user/assistant），idle/compaction 不外显。

### 场景：CLI 消息下发（文本 / 图片 / 模型）
- Given opencode CLI 可用（已配模型）
- When deliver（文本；或带 model；或 1×1 PNG --file）
- Then delivery completed，刷新会话后 user 消息与 assistant 回应出现在 hub transcript。

### 场景：未装 opencode 降级
- Given 本机 opencode CLI 不存在
- When 任一 RPC
- Then 抛 `agent_error`（spawn ENOENT）。

## 6. 非功能需求
- 采集/下发以 spawn CLI 为桥，只读不改 native；仅写 workDir/native 导出副本。
- CLI 调用带超时（list 30s / read 60s / deliver 10min / models 30s）；stdout 收集有上限防爆内存。
- 大包（largeReadMode=temp-file）在 readSession 内按序列化体积降级（⚠ 当前实现统一 60s 内流式，不做大包分片）。

## 7. 假设与约束
- 依赖本机 `opencode` CLI（openCommand 可配置），版本 ≥2.3.0（session list/export/run 命令契约对齐 v2）。
- opencode CLI 可能自行拉起后台 service（生成一次性 standalone / 复用已有）——插件不感知、不清理，
  由 opencode CLI 自行管理；多次轻量调用可接受其冷启动开销。
- ⬜ 待真机：`opencode models` 无 reasoning/thinking 元数据 → 006 模型能力投影是保守默认；thinkingLevels 映射经 model variant。

## 8. 依赖
- 上游：`@pi-agent-hub/protocol`、`@pi-agent-hub/pi-session`、`@pi-agent-hub/sync-plugin-sdk`（含 `runCli`）。
- 外部：`opencode` CLI（spawn）。
