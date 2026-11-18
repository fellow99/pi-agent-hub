# 003-common-plugin-sdk 功能规格（Specification）

> Module: 003-common-plugin-sdk
> Status: Implemented（scaffold + 2026-11-19 CLI 工具扩展）
> Last Updated: 2026-11-19
> 源：`packages/sync-plugin-sdk/src/*`

## 1. 模块概述

### 1.1 目的
为「插件 = 独立 Node 子进程 + JSON-RPC over stdio」的架构提供**双侧框架**：
- 插件侧：`runPluginServer`（读 stdin、分派 handler、写 stdout）与 `sendNotification`；
- daemon 侧：`RpcClient`（spawn 子进程、请求/超时/通知/推出处理）；
- 公共：JSON-RPC 2.0 行编码、`PluginError` 错误归一、文件工具、**CLI 调用工具（`runCli`，面向基于 CLI 调用的插件）**。

### 1.2 解决的问题
- 统一插件生命周期的进程边界的样板代码，将其从多个插件中抽出。
- 确保「stdout 只放协议、stderr 放日志」的纪律被框架强制执行。
- 提供崩溃/退出时对 in-flight 请求的确定性拒绝处理。
- 提供「两种对接方式」的公共底座：**基于 CLI 调用**（spawn agent CLI，如 `pi run` / `opencode run`）与
  **基于服务 API**（HTTP 对接常驻 server，如 `opencode serve` / `dsh web` / pi-web）——框架均不感知具体方式，仅提供进程边界与工具。

### 1.3 范围
- 包含：jsonrpc、errors、server、client、fs、cli 六个模块。
- 不包含：各 agent 的读取/下发逻辑、daemon 监督（重试/退避在 daemon 侧）。

## 2. 用户故事
- 作为插件作者，我可以只写 handler 函数即可获得一个符合规范的 JSON-RPC 插件进程。
- 作为 daemon 开发者，我可以 start 一个 RpcClient 并 `request`/`notify`，无需手工 spawn/readline。

## 3. 功能需求

### 3.1 JSON-RPC 编解码
- FR-003-001: `encodeLine` MUST 输出 JSON+`\n`（NDJSON 帧）。
- FR-003-002: `isRequest` / `isResponse` MUST 正确判别消息类型（jsonrpc=2.0）。

### 3.2 错误归一
- FR-003-003: `toPluginError` MUST 将任意 throw 归一为带 `code` 的 `PluginError`（默认 `internal`）。

### 3.3 插件侧 server
- FR-003-004: `runPluginServer` MUST 逐行读 stdin，调用 handler，向 stdout 写 result/error。
- FR-003-005: 未知 method MUST 返回 `-32601 method not found`。
- FR-003-006: handler 抛错 MUST 返回 `-32000` error 且 `data.code` 取 PluginError.code、`retryable` 仅 `timeout` 为真。
- FR-003-007: `shutdown` 成功响应 MUST 触发进程退出。
- FR-003-008: `sendNotification` MUST 发送无 id 的通知帧。

### 3.4 daemon 侧 client
- FR-003-009: `RpcClient.start` MUST spawn `command args`（stdio pipe、windowsHide）。
- FR-003-010: `request` MUST 支持超时（默认 30s），超时以 `code:"timeout"` 拒绝。
- FR-003-011: 子进程退出 MUST 拒绝所有 pending 请求。
- FR-003-012: stdout 非 JSON 行 MUST 走 onLog，不崩溃。
- FR-003-013: `notify` MUST 发送通知；`close` MUST 先 shutdown 再 kill。

### 3.5 文件工具
- FR-003-014: `expandHome`/`ensureDir`/`ensureParent`/`readJsonFile`/`sha256File` MUST 供插件与 daemon 共用。

### 3.6 CLI 工具（基于 CLI 调用的插件）
- FR-003-015: `runCli(command, args, options)` MUST spawn CLI 并收集 stdout/stderr，返回 exitCode/signal/stdout/stderr/truncated。
- FR-003-016: 超时（默认 30s）MUST kill 子进程并以 `code:"timeout"` 拒绝；非 0 退出由调用方按 `agent_error` 归一（本工具不自动抛错）。
- FR-003-017: stdout/stderr 收集 MUST 有上限（默认 16 MiB），超出截断并以 `truncated` 标记，避免内存爆涨。
- FR-003-018: spawn ENOENT MUST 以 `agent_error` 拒绝（宿主未装 agent CLI）。
- FR-003-019: 供 `sync-plugin-pi-cli` / `sync-plugin-opencode-cli` 复用（对接形态：基于 CLI 调用）。

## 4. 关键实体
| 实体 | 说明 |
|---|---|
| JsonRpcRequest/Success/Failure | 协议消息 |
| RpcClient | daemon 侧子进程客户端 |
| MethodHandler | 插件侧 handler 签名 |
| PluginError | 带 code 的错误 |
| CliResult / RunCliOptions | CLI 工具返回结构 / 选项（CLI 形态插件） |

## 5. 验收场景
### 场景：超时拒绝
- Given handler 挂起
- When `request(..., 100ms)` 
- Then 以 `code="timeout"` 拒绝且 pending 清理。

### 场景：崩溃清理
- Given 插件进程被杀
- When 存在 in-flight 请求
- Then 全部以「plugin exited」拒绝。

### 场景：shutdown 退出
- Given daemon 调 `shutdown`
- When server 响应后
- Then 进程在下一 tick `process.exit(0)`。

### 场景：CLI 采集超时
- Given 宿主 opencode/pi CLI 挂起
- When `runCli(..., 100ms)`
- Then kill 子进程，以 `code="timeout"` 拒绝。

### 场景：CLI stdin 关闭
- Given spawn 的 CLI 写完 stdout 即退出
- When close 事件到达
- Then 返回收集结果；非 0 退出由插件归为 `agent_error`。

## 6. 非功能需求
- 不依赖第三方库（node:readline / node:child_process 内置）。
- stdout 协议纯净性由框架保证（handler 返回值而非打印）。
- runCli 对插件是纯工具：不隐式吞错、不隐式改环境、stdout/stderr 有界收集。

## 7. 假设与约束
- 单行 ≤ 8 MiB（协议约定）；大包走临时文件（插件自行实现）。
- CLI 调用形态插件（505 opencode-cli 以 `controlInterface:"cli"`、`readStrategy/deliveryStrategy` 含 `"cli"` 声明能力位；
  501 pi-cli 因保有基于 mtime 的 `check_idle`（C-1 单写者判定）与 import 能力，`controlInterface` 保留 `"native-api"`、
  `readStrategy=["storage"]`）；服务 API 形态插件（502/503/504）以 `"api"/"storage"` 声明。

## 8. 依赖
- 上游：`@pi-agent-hub/protocol`（含 `readStrategy/deliveryStrategy` 扩展 `"cli"`）、`@pi-agent-hub/pi-session`。
- 下游：五个插件（501 pi-cli / 502 opencode-serve / 503 dsh / 504 pi-web / 505 opencode-cli）、sync-daemon。
