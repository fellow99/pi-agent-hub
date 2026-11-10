# 301-sync-daemon-tray 功能规格（Specification）

> Module: 301-sync-daemon-tray（原 301-tray-supervisor，更名并合并「session 同步全流程」托盘侧需求）
> 需求编号：301-sync-daemon-tray · 需求名称：session 同步全流程（托盘侧）
> Status: Implemented（2026-11-11；Windows 本机完成构建/安装/E2E 验证；macOS 产物以 CI 编译为准 ⬜ 待真机验证）
> Last Updated: 2026-11-10
> 源：`packages/sync-daemon-tray/`
> 关联文档：docs/000-工程规划.md §7.10–7.13、specs/004-sync-session/、specs/401-sync-daemon/

## 1. 模块概述

### 1.1 目的
sync-daemon-tray 是 **Windows/macOS 的系统托盘/菜单栏程序（Tauri v2 + 原生 HTML）**：
通过启动器 `sync-daemon-starter.js` 拉起并守护 `@pi-agent-hub/sync-daemon` 进程，
提供 sync-daemon 配置编辑界面与登录自启能力，并通过 GitHub Actions 产出
**内含 Node 运行时 + daemon + 插件 + node_modules 的单安装包**。
**只做守护与配置，不做采集/同步业务**（业务边界同 docs §7.12、C-10）。

### 1.2 解决的问题
- 让用户级 daemon 有系统托盘入口而非命令行，普通用户安装后零命令行即可持续同步（004 全流程的端侧入口）。
- 屏蔽「daemon 装在哪、用哪个 node、全局还是内置」的解析复杂度，统一收敛到 starter。
- 提供无需前端框架的轻量配置界面，直接编辑 `sync-daemon.json` 并安全保存（先校验后落盘、保存即重启）。
- 提供登录桌面后自动启动托盘（进而守护 daemon）的能力。
- 提供 Win/macOS 可分发安装包，终端机器无需自备 Node/npm。

### 1.3 范围
- 包含：
  - Node 启动器 `sync-daemon-starter.js`（daemon 入口解析 + npx 兜底）。
  - 托盘启动链：内置/系统 Node 选择 → starter 启动 → 失败 npx 兜底 → 全失败错误弹窗。
  - 托盘驻留与右键菜单（配置 / 暂停-继续同步（进程级启停）/ 退出）。
  - 配置窗口：textarea 编辑整份 `sync-daemon.json` + 开机自启 checkbox + JSON 校验保存 + 保存后重启 daemon。
  - 登录自启（Windows 注册表 / macOS 登录项）。
  - 单实例锁，避免双托盘与双 daemon。
  - GitHub Actions 手动触发的 Win/macOS 安装包构建（含 Node v26.13.0、daemon、sync-plugin-*、starter、node_modules）。
- 不包含：
  - daemon 内部控制面级 pause/resume（`/local/pause|resume` 仅暂停同步循环；本期托盘菜单做**进程级**启停，控制面语义后续另有作用，见 FR-301-013）。
  - Linux 托盘（Linux 走 node + pm2，docs §7.10）。
  - 代码签名 / macOS 公证（规划明确暂缓，docs §3.13 第 11 条）。
  - 插件管理 UI、日志页、健康红点（后续迭代；本期配置页仅 textarea + 自启）。
  - tag 触发打包（当前仅手动 `workflow_dispatch`，tag 触发在 workflow 中预留注释）。

### 1.4 与 scaffold（原 301-tray-supervisor）的关系
原 scaffold 已实现：托盘图标与 Open settings/Quit 菜单、左键开窗、`start/stop/daemon_status`、
`read_config/write_config`、四字段配置表单、`PI_AGENT_HUB_DAEMON`/`PI_AGENT_HUB_NODE` env 覆盖、
`windows_subsystem` 隐藏控制台。本需求在其上**演进而非重写**：启动改走 starter、菜单与配置页按本规格重构、
新增自启/单实例/打包 CI；旧 FR 编号在文末「附录 A」给出映射。

## 2. 用户故事
- 作为 Windows/macOS 用户，我安装托盘程序后登录桌面即可见托盘图标，daemon 被自动拉起，本机 `~/.pi` 会话按 004 流程持续同步到 hub。
- 作为用户，我无需关心 node/daemon 安装位置：托盘优先用内置 node 与 starter 启动；环境异常时自动尝试 `npx @pi-agent-hub/sync-daemon`；都失败时弹窗告知原因。
- 作为用户，我从托盘右键菜单可：打开配置页、暂停/继续同步（停止/启动 daemon 进程）、退出托盘（同时停止 daemon）。
- 作为用户，我在配置页用 textarea 直接编辑整份 `sync-daemon.json`，勾选是否开机自启；保存时先做 JSON 语法校验，合法才落盘并自动重启 daemon 生效。
- 作为维护者，我在 GitHub Actions 手动触发即可产出 Win（NSIS）与 macOS（dmg，x64/arm64）安装包，包内齐备 Node v26.13.0、daemon、三个 sync-plugin、starter 与完整 node_modules。
- 作为开发者，我可通过 env 将 starter 指向本仓库 `packages/sync-daemon` 工程做联调。

## 3. 功能需求

### 3.1 启动器 sync-daemon-starter.js（Node ESM 脚本）
- FR-301-001: 仓库内 MUST 提供 `packages/sync-daemon-tray/sync-daemon-starter.js`，用法
  `node sync-daemon-starter.js run --config <path> [--once]`，参数透传给 daemon 入口。
- FR-301-002: starter MUST 按以下顺序解析 daemon 入口（返回可执行的 JS 入口文件路径）：
  1. 环境变量 `PI_AGENT_HUB_DAEMON` 指向的入口（调试模式，可指向 `packages/sync-daemon/dist/main.js`）；
  2. 启动器自身所在目录 `node_modules/@pi-agent-hub/sync-daemon/dist/main.js`（安装包内置 / 本地 node_modules）；
  3. 全局 npm 安装的 `@pi-agent-hub/sync-daemon`（`createRequire(import.meta.url).resolve` 解析全局链路）。
- FR-301-003: starter 解析到入口后 MUST 以 `child_process.spawn` 拉起
  `process.execPath <daemonEntry> run --config <path> [--once]`，stdio 透传（inherit），并转发退出码；
  信号（SIGINT/SIGTERM）MUST 转发给子进程。
- FR-301-004: 三种解析均失败时 starter MUST 以非零码退出并向 stderr 打印结构化原因
  （区分 `env_not_found` / `local_not_found` / `global_not_found`），供 Rust 层判定进入 npx 兜底。
- FR-301-005: starter MUST 为纯 Node ESM、零第三方依赖（仅用 node: 内置模块），可被内置 node 直接执行。

### 3.2 托盘启动链与 Node 选择（Rust 侧）
- FR-301-006: 托盘启动时 MUST 检测应用资源目录是否存在**内置 node**
  （Windows `resources/node/node.exe`；macOS `resources/node/bin/node`）：
  有则用内置 node；无则回退系统 `node`（PATH 查找）。
- FR-301-007: 托盘 MUST 用选定 node 执行 `resources/sync-daemon-starter.js run --config <默认配置路径>`
  （默认配置 `~/.pi-agent-hub/sync-daemon.json`）。
- FR-301-008: starter 启动失败（进程无法 spawn 或退出码非零）时，Rust 层 MUST 尝试兜底命令
  `npx -y @pi-agent-hub/sync-daemon run --config <path>`（Windows 经 `npx.cmd`）。
- FR-301-009: 内置 node 启动与 npx 兜底均失败时，MUST 弹出原生错误对话框（`tauri::api`/插件 message dialog），
  展示最后一次错误摘要与配置文件路径，用户确认后托盘保持运行（不静默崩溃），可从菜单打开配置页修正。
- FR-301-010: `PI_AGENT_HUB_NODE` / `PI_AGENT_HUB_DAEMON` env 覆盖 MUST 继续生效（调试/联调优先于默认解析）。

### 3.3 托盘驻留与右键菜单
- FR-301-011: 托盘 MUST 在 Windows 系统托盘、macOS 菜单栏驻留并显示图标；Windows release 构建 MUST 隐藏控制台窗口（`windows_subsystem = "windows"`，scaffold 已具备）。
- FR-301-012: 右键菜单 MUST 提供三项：
  - **配置**：打开并聚焦配置窗口；
  - **暂停同步 / 继续同步**（同一菜单项按 daemon 运行态切换文案）：暂停 = kill daemon 子进程；继续 = 按 3.2 启动链重新拉起；
  - **退出**：先停止 daemon（kill + wait），再退出托盘应用。
- FR-301-013: 本期暂停/继续为**进程级**（停止/启动 daemon 进程）。daemon 已有的 `/local/pause|resume`
  （仅暂停同步循环、进程不退出）保留不动，供后续控制面语义使用，本期托盘不接入。
- FR-301-014: 左键点击托盘图标 MUST 打开并聚焦配置窗口（scaffold 已具备，保留）。
- FR-301-015: 退出托盘 MUST 保证 daemon 子进程被回收（kill + wait，不残留孤儿进程）。
- FR-301-016: 托盘 MUST 持有 daemon 子进程句柄，`daemon_status` 经 `try_wait` 检测意外退出并清空状态，
  菜单文案与状态展示随之刷新（scaffold 机制保留，命令适配 starter 启动链）。

### 3.4 配置窗口（ui/）
- FR-301-017: 配置窗口 MUST 提供一个 **textarea** 展示并编辑整份 `~/.pi-agent-hub/sync-daemon.json`
  （替换 scaffold 的 Hub URL/Token/Host/Plugin root 四字段表单）；文件缺失时以空 JSON 对象 `{}` 占位并提示。
- FR-301-018: 配置窗口 MUST 提供 **「开机自启」checkbox**，状态与系统实际自启项双向一致（打开窗口时读取当前状态）。
- FR-301-019: 点击保存时 MUST 先在前端做 `JSON.parse` 语法校验：语法错误则阻止保存并高亮提示错误位置/信息，不落盘。
- FR-301-020: 校验通过后 MUST 经 Rust 命令美化序列化写回原路径（自动创建父目录），并同步自启设置；
  保存成功后 MUST 自动重启 daemon（先 stop 再按 3.2 启动链 start）使配置生效。
- FR-301-021: 配置窗口 MUST 展示 daemon 当前状态（running/pid/node/daemon）与手动「立即重启 daemon」入口（调试用）。
- FR-301-022: 在普通浏览器外打开（无 `window.__TAURI__`）MUST 给出友好提示而不崩溃（scaffold 已具备，保留）。
- FR-301-023: WebView CSP MUST 维持
  `default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'`。

### 3.5 开机自启与单实例
- FR-301-024: 托盘 MUST 支持「用户登录桌面后自动启动」：
  Windows 写当前用户注册表 `HKCU\...\Run`；macOS 注册登录项（Login Items / LaunchAgent 用户级）。
  实现采用 Tauri v2 自启插件（`tauri-plugin-autostart`），不申请管理员/root 权限。
- FR-301-025: 自启开关状态 MUST 持久化并可由配置页 checkbox 与（后续）安装器控制；关闭自启 MUST 能彻底移除自启项。
- FR-301-026: 托盘 MUST 通过单实例插件（`tauri-plugin-single-instance`）保证同时只有一个托盘实例；
  二次启动时聚焦已有实例的配置窗口并退出新进程，避免双托盘/双 daemon。

### 3.6 GitHub Actions 打包 workflow
- FR-301-027: MUST 在 `.github/workflows/` 新增 sync-daemon-tray 打包 workflow，当前仅支持
  `workflow_dispatch` 手动触发；tag 触发（`on: push: tags: v*`）以注释形式预留，今后按 tag 发版。
- FR-301-028: job 矩阵 MUST 覆盖 `windows-latest`（x64，NSIS `.exe`）、`macos-14`（arm64，`.dmg`）、
  `macos-13`（x64，`.dmg`）。
- FR-301-029: 每个矩阵任务 MUST 完成：pnpm 安装与 `pnpm build`（构建 daemon/插件 dist）→
  下载并校验 **Node v26.13.0** 对应平台分发包（nodejs.org dist，SHA256 校验）→
  组装 Tauri resources（内置 node、starter、daemon、sync-plugin-pi-agent/opencode/dsh、完整 node_modules）→
  `tauri build` 产出安装包 → `actions/upload-artifact` 上传。
- FR-301-030: 安装包内 MUST 包含：
  1. sync-daemon-tray（Tauri 程序本体）；
  2. Node.js **v26.13.0**（平台对应架构，含 node 可执行文件；npm/npx 供兜底与动态装插件）；
  3. `@pi-agent-hub/sync-daemon` 与 `@pi-agent-hub/sync-plugin-*`（dist）；
  4. `sync-daemon-starter.js`（启动器）；
  5. `node_modules`（含 sync-daemon、sync-plugin-* 及其全部运行时依赖）。
- FR-301-031: 资源组装逻辑 MUST 沉淀为仓库内跨平台脚本（Node 脚本，放 `packages/sync-daemon-tray/scripts/`），
  使本地与 CI 组装方式一致、可复跑；不得把组装步骤只写在 workflow YAML 内联命令里。
- FR-301-032: workflow MUST NOT 执行签名/公证（本期暂缓）；产物为未签名包，命名含平台/架构与版本号。
- FR-301-033: 根 `pnpm build` MUST NOT 被 Rust 构建阻塞（scaffold 约定保留）；Tauri 构建只在 workflow 与显式 `tauri:build` 时发生。

## 4. 关键实体
| 实体 | 说明 |
|---|---|
| DaemonState | `Mutex<Option<Child>>`（守护的 daemon 子进程；经 starter 或 npx 拉起） |
| DaemonStatus | running/pid/node/daemon/mode（mode = starter \| npx）序列化 |
| StarterResolution | starter 的 daemon 入口解析结果（env/local/global 三来源 + 失败原因码） |
| BundledNode | resources 内内置 Node（版本固定 v26.13.0，平台/架构相关路径） |
| AutostartPreference | 开机自启开关（系统自启项 + 配置页 checkbox 双向同步） |
| BundleManifest | 打包清单：node 版本/校验和、daemon/插件版本、resources 布局 |

## 5. 验收场景

### 场景：starter 三级解析
- Given 内置 node_modules 含 sync-daemon
- When 执行 `node sync-daemon-starter.js run --config <cfg>`
- Then 解析到内置入口并 spawn daemon，退出码透传；删除内置包并设置 `PI_AGENT_HUB_DAEMON` 时改走 env 入口；均缺失时退出码非零且 stderr 含原因码。

### 场景：托盘启动链与兜底
- Given 一台未装系统 Node 但安装包内置 Node 的机器
- When 启动托盘
- Then 用内置 node 经 starter 拉起 daemon，状态 running 且 pid 有效；
  当 starter 失败时自动改走 `npx -y @pi-agent-hub/sync-daemon`；两者都失败时弹错误窗且托盘不崩溃。

### 场景：暂停/继续（进程级）
- Given daemon 由托盘守护运行中
- When 点「暂停同步」
- Then daemon 子进程被 kill + wait，状态 running=false；再点「继续同步」按启动链重新拉起，running=true 且为新 pid。

### 场景：退出即停
- Given daemon 运行中
- When 点托盘「退出」
- Then 托盘与 daemon 均退出，无残留 daemon 进程。

### 场景：配置校验保存与重启
- Given 配置窗口已加载 sync-daemon.json
- When 输入非法 JSON 点保存
- Then 提示语法错误、文件不落盘、daemon 不重启；
- When 修正为合法 JSON 并保存
- Then 文件美化写回、daemon 被重启（新 pid）、Reload 可读回新内容。

### 场景：开机自启
- Given 配置页勾选「开机自启」并保存
- When 注销后重新登录桌面
- Then 托盘自动启动并拉起 daemon；取消勾选后重新登录不再自启，且系统自启项已移除。

### 场景：单实例
- Given 托盘已在运行
- When 再次启动托盘程序
- Then 新进程退出，已有实例配置窗口被聚焦，系统中仅一个托盘与一个 daemon。

### 场景：CI 安装包内容
- Given workflow 手动触发完成
- When 下载 Windows/macOS 产物并安装
- Then 安装目录含 Tauri 程序、resources/node（v26.13.0）、starter、daemon 与三个插件 dist、完整 node_modules；
  离线（不依赖系统 Node）启动托盘可成功拉起 daemon。

## 6. 非功能需求
- **可移植**：仅 Windows/macOS；macOS 产 x64 + arm64 双架构；Linux 不构建托盘。
- **零特权**：用户级安装与运行，不注册系统服务、不要求管理员/root（docs §7.10、NFR-14）。
- **健壮性**：启动三级解析 + npx 兜底 + 错误弹窗；daemon 意外退出可被状态检测发现并可手动/自动恢复。
- **安全**：配置文件含 token，目录沿用 `~/.pi-agent-hub`（0600 约束由 daemon 侧文档约束）；CSP 收紧；自启仅当前用户。
- **可复现构建**：Node 版本固定 v26.13.0 并做 SHA256 校验；组装脚本化、产物命名含版本/平台/架构。
- **构建隔离**：Rust 不阻塞根 JS 构建（FR-301-033）。
- **类型/质量**：Rust `cargo check`/`clippy` 无 warning 级错误；JS 无 `as any`/`@ts-ignore`、无空 catch；改动后 `pnpm typecheck` 全绿。

## 7. 假设与约束
- 终端机器 WebView2（Windows 11/新 Win10 自带）/ WKWebView（macOS 自带）可用；老系统 WebView2 兜底 bootstrapper 本期不打入（规划列为发布期事项）。
- npx 兜底前提：`@pi-agent-hub/sync-daemon` 已发布到 npm 且网络可达；未发布前该路径在真机上预期失败，错误窗提示，CI 不依赖该路径（标 ⬜ 待 npm 发布后真机验证）。
- 本机为 Windows 开发环境：Windows 侧做完整构建/启动/菜单/配置/启停验证；macOS 产物以 CI 编译通过为准，**真机运行验证标 ⬜ 待验证**（无 macOS 设备）。
- 调试环境：Docker Desktop 跑 hub-service；本机 Node 跑 daemon/插件；直接采集真实 `~/.pi` 会话数据。
- 签名/公证、tag 触发、插件管理 UI、日志页、健康红点不在本期。

## 8. 依赖
- 上游：Tauri v2（`tauri` tray-icon、`tauri-plugin-autostart`、`tauri-plugin-single-instance`、dialog）、Rust 工具链（本机 cargo 1.94.1）。
- 守护对象：`@pi-agent-hub/sync-daemon`（外部 Node 进程，specs/401）及其插件 `sync-plugin-*`（specs/501–503）。
- 运行时：Node.js v26.13.0（CI 下载内置；开发机本机 Node 24.8.0 仅用于工程构建）。
- 协作：hub-service（Docker 调试）、004-sync-session 全链路。

## 附录 A：原 301-tray-supervisor FR 映射
| 原 FR | 处置 | 新 FR |
|---|---|---|
| FR-301-001 托盘图标与 Open settings/Quit 菜单 | 演进（菜单改三项） | FR-301-011/012 |
| FR-301-002 左键开窗聚焦 | 保留 | FR-301-014 |
| FR-301-003 windows_subsystem 隐藏控制台 | 保留 | FR-301-011 |
| FR-301-004 start_daemon 直接 spawn node daemon | 重构（改走 starter + npx 兜底） | FR-301-007/008 |
| FR-301-005 stop_daemon kill+wait | 保留 | FR-301-012/015 |
| FR-301-006 daemon_status try_wait | 保留适配 | FR-301-016 |
| FR-301-007 env 覆盖 node/daemon | 保留 | FR-301-010/002 |
| FR-301-008/009 read/write_config | 保留（write 增加保存后重启） | FR-301-017/020 |
| FR-301-010 状态 JSON 展示 | 保留 | FR-301-021 |
| FR-301-011 四字段表单 | 替换为 textarea | FR-301-017 |
| FR-301-012 非 Tauri 环境友好提示 | 保留 | FR-301-022 |
| —（新增）starter/启动链/自启/单实例/打包 CI | 新增 | FR-301-001~005、006~009、024~033 |
