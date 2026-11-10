# 003-common-plugin-sdk Technical Plan（As-Built）

> Module: 003-common-plugin-sdk
> Corresponding spec: ./spec.md
> Last Updated: 2026-11-10

## 1. 技术上下文
- 运行时：Node ESM + TypeScript。
- 内置 API：`node:child_process`（spawn）、`node:readline`（createInterface）、`node:crypto`、`node:fs`。
- 代码：`packages/sync-plugin-sdk/src/{client,server,jsonrpc,errors,fs,index}.ts`。

## 2. Constitution 符合性
- ✅ 插件子进程边界由本模块框架强制（对应 constitution §4 架构边界）。
- ✅ 错误用稳定 code（`PluginError`），不吞异常。

## 3. 研究结论
- 采用 **NDJSON 行协议**（每行一个 JSON），简化 readline 解析；stdout 只写协议帧，日志写 stderr（docs/002 §3）。
- `RpcClient` 用 `nextId` 自增 + `pending Map` 管理 in-flight；退出时统一 reject（保证无悬挂 Promise）。
- `shutdown` 在响应后 `setTimeout(exit, 0)`，给 stdout flush 留出时机。

## 4. 文件清单
| 文件 | 用途 | 行数 |
|---|---|---|
| src/jsonrpc.ts | 消息类型 + 判别 + 编码 | 36 |
| src/errors.ts | PluginError + toPluginError | 18 |
| src/server.ts | runPluginServer / sendNotification | 71 |
| src/client.ts | RpcClient（daemon 侧） | 118 |
| src/fs.ts | 文件/路径工具 | 35 |
| src/index.ts | 汇总导出 | 6 |

## 5. 关键实现（对照 spec）
- `runPluginServer`：`rl.on("line")` → parse → isRequest 过滤 → handler → 响应/错误（对应 FR-003-004~007）。
- `RpcClient.request`：超时后 `pending.delete(id)` + reject `code:"timeout"`（对应 FR-003-010）。
- `RpcClient` 的 `exit` 监听：遍历 pending reject（对应 FR-003-011）。
- `toPluginError`：`PluginError` 直通，`Error.code` 透传，否则 `internal`（对应 FR-003-003）。

## 6. 测试考虑
- vitest：帧编码往返、toPluginError 归一路径、client/server 端到端（spawn fixture 脚本）近超时（overall-test-cases T-001-005/006）。
