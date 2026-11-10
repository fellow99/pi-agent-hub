# 310-tray-supervisor 功能规格（Specification）

> Module: 310-tray-supervisor
> Status: Implemented (scaffold)
> Last Updated: 2026-11-10
> 源：`packages/sync-daemon-tray/`

## 1. 模块概述

### 1.1 目的
sync-daemon-tray 是 **Windows/macOS 的托盘/菜单栏程序（Tauri v2 + 原生 HTML）**：守护 sync-daemon 进程（start/stop/status），
并提供最小配置界面读写 `sync-daemon.json`。**只做守护与配置，不做业务**。

### 1.2 解决的问题
- 让用户级 daemon 有系统托盘入口而非命令行。
- 提供无需前端框架的轻量配置界面。

### 1.3 范围
- 包含：托盘菜单（Open settings/Quit）、WebView 配置窗口、daemon start/stop/status 命令、配置读写命令。
- 不包含：单实例锁、开机自启、退出语义、日志页面（TODO）。

## 2. 用户故事
- 作为 Windows/macOS 用户，我点托盘图标可打开配置窗口，Start/Stop 守护本机 daemon。
- 作为用户，我可以编辑 Hub URL/Token/Host/Plugin root 并保存到 `sync-daemon.json`。

## 3. 功能需求

### 3.1 托盘
- FR-310-001: MUST 提供托盘图标与菜单（Open settings / Quit）。
- FR-310-002: 左键点击托盘图标 MUST 显示并聚焦 `config` 窗口。
- FR-310-003: Win 子系统（非 debug）MUST 隐藏控制台窗口（`windows_subsystem`）。

### 3.2 daemon 守护
- FR-310-004: `start_daemon` MUST spawn `node <daemon> run --config <path>`（配置路径 `~/.pi-agent-hub/sync-daemon.json`），已在运行则返回现状。
- FR-310-005: `stop_daemon` MUST kill 并 wait 子进程。
- FR-310-006: `daemon_status` MUST 返回 running/pid/node/daemon，并用 `try_wait` 检测已退出并清空状态。
- FR-310-007: daemon 路径/Node 二进制 MUST 可用环境变量 `PI_AGENT_HUB_DAEMON` / `PI_AGENT_HUB_NODE` 覆盖。

### 3.3 配置读写
- FR-310-008: `read_config` MUST 读取 `~/.pi-agent-hub/sync-daemon.json`（缺失时经前端容错）。
- FR-310-009: `write_config` MUST 创建父目录、美化序列化写入。

### 3.4 配置界面（ui/）
- FR-310-010: 界面 MUST 展示 daemon 状态 JSON（Start/Stop/Refresh）。
- FR-310-011: 界面 MUST 提供 Hub URL / Token / Host name / Plugin root 编辑与 Save/Reload。
- FR-310-012: 浏览器外打开（无 `window.__TAURI__`）MUST 给出友好提示不崩溃。

## 4. 关键实体
| 实体 | 说明 |
|---|---|
| DaemonState | Mutex<Option<Child>>（守护的 daemon 子进程） |
| DaemonStatus | running/pid/node/daemon 序列化 |

## 5. 验收场景
### 场景：Start 后状态
- Given 未运行
- When `start_daemon`
- Then 返回 running=true + pid 且子进程存活。

### 场景：Stop 清理
- Given daemon 运行中
- When `stop_daemon`
- Then running=false、pid 清空。

### 场景：配置往返
- Given 界面修改字段
- When Save
- Then `sync-daemon.json` 更新；Reload 可读回。

## 6. 非功能需求
- WebView CSP：`default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'`（tauri.conf.json）。
- 根 `pnpm build` 不构建 Rust（避免缺 Cargo 阻塞）。

## 7. 假设与约束
- 仅 Win/macOS；Linux 不用托盘（pm2 方案）。
- 无 npm 运行时打包（未来内嵌 Node TODO）。

## 8. 依赖
- 上游：Tauri v2（`tauri`/`@tauri-apps/cli`）、Rust 工具链。
- 守护对象：`@pi-agent-hub/sync-daemon`（外部进程）。
