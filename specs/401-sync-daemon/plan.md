# 401-sync-daemon Technical Plan（As-Built）

> Module: 401-sync-daemon
> Corresponding spec: ./spec.md
> Last Updated: 2026-11-10

## 1. 技术上下文
- 运行时：Node ESM；`node:child_process`（spawn/execFile）、内置 `fetch`。
- 代码：`packages/sync-daemon/src/{main,config,daemon,hub-client,plugin-manager,control,logger}.ts`。

## 2. Constitution 符合性
- ✅ 插件子进程边界（PluginManager 负责 spawn，对应宪法 §4）。
- ✅ 插件不直连 hub（REST/SSE 全由 HubClient 承担）。

## 3. 研究结论
- **同步循环**：`Daemon.syncAll` 对每个 runtime `list_sessions` → `hubClient.manifest` → 对非
  skipped/quota/error 项 `read_session` / `sync`；30s `setInterval`（paused 时跳过）。
- **SSE**：`HubClient.connectEvents` 手写帧解析（`\n\n` 分帧，`id:`/`event:`/`data:`），保存 `lastEventId`
  供重连带 `Last-Event-ID`；断线由 `Daemon.runEvents` 捕获后 3s 重连。
- **插件**：`PluginManager.resolve` 按「本地路径 → pluginRoot → npm install」解析；`stableAgentId` 用
  sha256(host\0kind\0instance)（对应 FR-401-005）；initialize/detect 各 20s 超时。
- **控制 API**：`startControlServer` `server.listen(0)` 随机端口，写 `daemon-control.json`(0600)。

## 4. 文件清单
| 文件 | 用途 | 行数 |
|---|---|---|
| src/main.ts | CLI 入口 run [--config] [--once] | 21 |
| src/config.ts | 配置加载校验 | 29 |
| src/daemon.ts | Daemon 协调 | 270 |
| src/hub-client.ts | REST + SSE 客户端 | 117 |
| src/plugin-manager.ts | 插件解析/安装/子进程 | 209 |
| src/control.ts | 本地控制 HTTP | 76 |
| src/logger.ts | 日志 | 35 |

## 5. 关键实现（对照 spec）
- `runDaemon`：加载配置 → `new Daemon` → SIGINT/SIGTERM → `start(once)`（FR-401-001/002/017/018）。
- `syncOne`：`read_session` 返回 entries 或 entriesPath；entriesPath 经 `readEntriesFile` 读文件（FR-401-008）。
- `handleDeliver`：`hub.ack` → `plugin.deliver`（15min 超时）→ `deliveryResult`；异常回 `agent_error`（FR-401-012）。
- `handleImport`/`handleExportNative`：调对应插件方法并回 result，异常回 `unsupported`（FR-401-013）。
- `PluginManager.install`：`npm install --prefix pluginRoot --save-exact --ignore-scripts --no-audit --no-fund`（FR-401-003）。

## 6. 测试考虑
- vitest：配置校验、stableAgentId 确定性、控制 API 鉴权（overall-test-cases T-401-001~007）。
- 集成：本地 examples 起 hub + daemon + 本地插件做 manifest→sync 冒烟。
