# 401-sync-daemon 功能规格（Specification）

> Module: 401-sync-daemon
> Status: Implemented (scaffold)
> Last Updated: 2026-11-10
> 源：`packages/sync-daemon/src/*`

## 1. 模块概述

### 1.1 目的
sync-daemon 是**端侧守护进程**：发现并管理插件子进程，周期性做 manifest→差分→同步（上行 REST），
维持 SSE 长连接并处理 deliver/import/export_native 事件（下行），同时提供本地控制 API。

### 1.2 解决的问题
- 把「每台机器的 agent 会话」持续汇总到 hub。
- 把「hub 下发的命令」路由到对应插件执行。
- 为托盘/运维提供本地控制面。

### 1.3 范围
- 包含：配置校验、插件发现/动态安装/子进程管理、manifest 同步循环、SSE 事件循环与分派、本地控制 API、日志。
- 不包含：上传流、spool 离线缓冲、脱敏、完整重试退避（TODO）。

## 2. 用户故事
- 作为 daemon，我在后台持续把本机各 agent 的会话清单与增量同步到 hub。
- 作为 hub，我通过 SSE 把 deliver/import 推给 daemon，daemon 分派给插件执行并回执。
- 作为运维，我可通过本地 API 查看/暂停/触发同步/取日志/退出。

## 3. 功能需求

### 3.1 配置
- FR-401-001: 配置默认路径 MUST 为 `~/.pi-agent-hub/sync-daemon.json`（`--config` 可覆盖）。
- FR-401-002: MUST 校验 `hub.url`/`hub.token`/`host.name`/非空 `plugins`，缺失即启动失败。

### 3.2 插件管理
- FR-401-003: 插件解析 MUST 支持本地路径 / pluginRoot / npm 动态安装（allowlist 校验）。
- FR-401-004: 每个插件 MUST spawn 子进程（`process.execPath [bin]`），initialize 握手 + detect 探测实例。
- FR-401-005: 同一个 (host,kind,instance) MUST 派生稳定 `agentId`。

### 3.3 汇总同步
- FR-401-006: 启动与每 30s（可 pause 跳过）MUST 对全部插件 `list_sessions` 组 manifest 并上报。
- FR-401-007: 对非 `skipped/quota/error` 会话 MUST 调 `read_session(since,lastEntryId)` 并 `sync` 到 hub。
- FR-401-008: 大包（`entriesPath`）MUST 由 daemon 读取文件后传输。
- FR-401-009: 会话级同步失败 MUST 记日志，不中断整体循环。

### 3.4 SSE 下行
- FR-401-010: MUST 连接 `/api/v1/events`（Bearer + Accept SSE），解析帧并维护 `lastEventId`。
- FR-401-011: 断线 MUST 指数/固定（3s）重连；`abort` 时退出循环。
- FR-401-012: `deliver` 事件 MUST 先 ack，再调插件 `deliver`，最后回 result；异常回 `agent_error` result。
- FR-401-013: `import` / `export_native` 事件 MUST 调插件对应方法并回 result；异常回 `unsupported` result。

### 3.5 本地控制 API
- FR-401-014: MUST 提供 `GET /local/status`、`POST /local/pause`、`/local/resume`、`/local/sync-now`、`GET /local/logs`、`POST /local/quit`（`127.0.0.1` 随机端口）。
- FR-401-015: 控制 API MUST 用随机 token，写入 `daemon-control.json`（0600）。
- FR-401-016: 非 Bearer 请求 MUST 返回 401。

### 3.6 运行模式
- FR-401-017: `--once` 模式 MUST 同步一次后退出（调试）。
- FR-401-018: SIGINT/SIGTERM MUST 触发优雅停止（停插件、关控制端口）。

## 4. 关键实体
| 实体 | 说明 |
|---|---|
| Daemon | 主协调者 |
| PluginManager | 插件解析/子进程/运行时 |
| HubClient | REST + SSE 客户端 |
| ControlState | 本地控制状态（paused/status/syncNow/logs/quit） |

## 5. 验收场景
### 场景：缺配置拒绝启动
- Given 配置缺 hub.token
- When loadConfig
- Then 抛「requires hub.url and hub.token」。

### 场景：manifest→同步闭环
- Given 插件可列出会话
- When syncAll
- Then 上报 manifest，非 skipped 项读到并 sync。

### 场景：deliver 分派
- Given hub 推送 deliver（agentId 匹配）
- When handleEvent
- Then ack → 插件 deliver → result。

## 6. 非功能需求
- 单进程纯 Node（fetch/child_process/readline 内置）。
- 日志：stderr + `logs/sync-daemon.log`；`--once` 便于调试。

## 7. 假设与约束
- 当前无 spool：离线时数据会丢失/待 hub 水位重放（TODO）。
- 插件监督（退避/重启/限内存）未完整实现（TODO）。

## 8. 依赖
- 上游：`@pi-agent-hub/protocol`、`@pi-agent-hub/sync-plugin-sdk`。
- 协作：hub-service（REST/SSE）、sync-plugin-*（子进程）、control 消费方（托盘/脚本）。
