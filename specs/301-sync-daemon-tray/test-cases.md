# Test Cases: 301-sync-daemon-tray（session 同步全流程 · 托盘侧）

> 覆盖：starter 解析、托盘启动链/兜底、菜单与生命周期、配置窗口、自启/单实例、资源组装与 CI、E2E 同步闭环。
> 环境：Windows 本机完整验证；macOS 以 CI 编译为准，真机运行标 ⬜ 待验证。

## A. 启动器 sync-daemon-starter.js

### TC-301-001: env 入口优先（调试模式）
- **Priority**: P1 · **Type**: Functional
- **Precondition**: 本机已 `pnpm build`，`packages/sync-daemon/dist/main.js` 存在
- **Steps**: 设置 `PI_AGENT_HUB_DAEMON=<仓库>/packages/sync-daemon/dist/main.js`，执行 `node sync-daemon-starter.js run --config examples/sync-daemon.json --once`
- **Expected**: 走 env 入口成功启动 daemon 并完成一次同步后退出，退出码与 daemon 一致

### TC-301-002: 本地 node_modules 解析
- **Priority**: P1 · **Type**: Functional
- **Precondition**: starter 同级 `node_modules/@pi-agent-hub/sync-daemon/dist/main.js` 存在（组装产物或本地链接），不设 env
- **Steps**: `node sync-daemon-starter.js run --config <cfg> --once`
- **Expected**: 解析到本地 node_modules 入口并启动

### TC-301-003: 全局 npm 解析
- **Priority**: P2 · **Type**: Functional
- **Precondition**: 全局安装 `@pi-agent-hub/sync-daemon`（npm i -g 或 link），env 与本地 node_modules 均缺失
- **Steps**: 运行 starter
- **Expected**: 经 createRequire 全局链路解析到入口并启动

### TC-301-004: 三级解析全失败 → 非零退出 + 原因码
- **Priority**: P1 · **Type**: Edge Case
- **Precondition**: env 指向不存在路径；starter 同级无 node_modules；全局未安装
- **Steps**: 运行 starter
- **Expected**: 退出码非 0；stderr 含 `starter_resolve_failed` 与 reason（env_not_found/local_not_found/global_not_found）

### TC-301-005: 信号与退出码透传
- **Priority**: P2 · **Type**: Functional
- **Precondition**: starter 已拉起常驻 daemon
- **Steps**: 向 starter 进程发送 SIGTERM（Win: taskkill 等效）
- **Expected**: 子进程收到信号并退出，starter 退出码等于子进程退出码，无孤儿进程

## B. 托盘启动链与兜底（Rust）

### TC-301-006: 内置 node 优先于系统 node
- **Priority**: P1 · **Type**: Functional
- **Precondition**: resources/node 存在内置 node（v26.13.0）
- **Steps**: 启动托盘，查看 daemon_status
- **Expected**: status.node 指向 resources 内 node 可执行文件；daemon 经 starter 启动，mode=starter，running=true 且 pid 有效

### TC-301-007: 无内置 node 回退系统 node
- **Priority**: P2 · **Type**: Functional
- **Precondition**: 移除/重命名 resources/node；系统 PATH 含 node
- **Steps**: 启动托盘
- **Expected**: 使用系统 node 经 starter 启动成功

### TC-301-008: starter 失败 → npx 兜底
- **Priority**: P1 · **Type**: Functional
- **Precondition**: 制造 starter 解析失败（临时改名 resources/node_modules），网络可达 npm
- **Steps**: 启动托盘
- **Expected**: 检测到 starter 即时退出后执行 `npx -y @pi-agent-hub/sync-daemon run --config <path>`（Win 为 npx.cmd），daemon 运行且 mode=npx
- **备注**: 依赖 npm 包已发布；未发布时验证「失败后进入 TC-301-009」分支

### TC-301-009: 全部启动失败 → 错误弹窗且托盘保活
- **Priority**: P1 · **Type**: Edge Case
- **Precondition**: 无内置/系统 node 或 starter 与 npx 均失败（断网 + 无包）
- **Steps**: 启动托盘
- **Expected**: 弹出原生错误对话框（含最后错误摘要与配置路径）；关闭弹窗后托盘仍驻留，可从菜单打开配置页

### TC-301-010: daemon 意外退出被状态检测发现
- **Priority**: P2 · **Type**: Functional
- **Precondition**: daemon 由托盘守护运行
- **Steps**: 外部 kill daemon 进程后调用 daemon_status / 刷新状态
- **Expected**: try_wait 检测到退出，running=false、pid 清空、菜单回到「继续同步」文案

## C. 菜单与生命周期

### TC-301-011: 暂停/继续（进程级启停）
- **Priority**: P1 · **Type**: Functional
- **Precondition**: daemon 运行中
- **Steps**: 点「暂停同步」→ 查状态；再点「继续同步」→ 查状态
- **Expected**: 暂停后 daemon 进程消失（running=false）；继续后按启动链重新拉起，running=true 且为新 pid；菜单文案随状态切换

### TC-301-012: 退出托盘同时停止 daemon
- **Priority**: P1 · **Type**: Functional
- **Precondition**: daemon 运行中
- **Steps**: 点「退出」
- **Expected**: 托盘与 daemon 均退出；任务管理器/ps 无残留 daemon 与 node 子进程

### TC-301-013: 左键与「配置」菜单打开窗口
- **Priority**: P2 · **Type**: Functional
- **Steps**: 左键托盘图标；窗口隐藏时右键→配置
- **Expected**: 两种方式均 show + focus 配置窗口

### TC-301-014: 单实例
- **Priority**: P2 · **Type**: Functional
- **Precondition**: 托盘已运行
- **Steps**: 再次启动同一程序
- **Expected**: 新进程退出；已有实例配置窗口聚焦；始终只有一个托盘图标与一个 daemon

## D. 配置窗口

### TC-301-015: textarea 加载与缺失文件占位
- **Priority**: P1 · **Type**: Functional
- **Precondition**: 分别在配置存在/不存在两种状态
- **Steps**: 打开配置窗口
- **Expected**: 存在时 textarea 展示完整 sync-daemon.json；缺失时预填 `{}` 并提示文件缺失

### TC-301-016: 非法 JSON 阻止保存
- **Priority**: P1 · **Type**: Edge Case
- **Steps**: textarea 输入语法错误 JSON 点保存
- **Expected**: 前端 JSON.parse 报错并展示错误信息；文件不落盘、daemon 不重启、自启不变更

### TC-301-017: 合法 JSON 保存 + 美化落盘 + 重启 daemon
- **Priority**: P1 · **Type**: Functional
- **Steps**: 合法修改后保存
- **Expected**: sync-daemon.json 美化写回（父目录自动创建）；daemon 被重启（pid 变化）；Reload 读回新内容

### TC-301-018: 开机自启 checkbox 双向同步
- **Priority**: P1 · **Type**: Functional
- **Steps**: 开窗读取当前自启态 → 勾选保存 → 检查系统自启项（Win HKCU Run / macOS LaunchAgent）→ 取消保存再检查
- **Expected**: 勾选后写入当前用户自启项；取消后彻底移除；重开窗口 checkbox 与系统状态一致；全程无 UAC/提权

### TC-301-019: 非 Tauri 环境友好降级
- **Priority**: P3 · **Type**: Edge Case
- **Steps**: 浏览器直接打开 ui/index.html
- **Expected**: 显示 Tauri API unavailable 提示，无脚本异常

### TC-301-020: CSP 保持收紧
- **Priority**: P3 · **Type**: Security
- **Steps**: 检查 tauri.conf.json
- **Expected**: CSP 为 `default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'`

## E. 资源组装与打包

### TC-301-021: 组装脚本下载并校验 Node v26.13.0
- **Priority**: P1 · **Type**: Build
- **Steps**: 本机运行 `node scripts/assemble-resources.mjs --target windows-x64`
- **Expected**: resources/node 出现 node.exe（版本 v26.13.0）；SHA256 与 SHASUMS256.txt 一致；校验失败时脚本非零退出且不留半成品

### TC-301-022: node_modules 组装完整
- **Priority**: P1 · **Type**: Build
- **Steps**: 检查组装产物
- **Expected**: resources/node_modules/@pi-agent-hub 含 sync-daemon 与三个 sync-plugin 的 dist 及全部运行时依赖；bundle-manifest.json 记录版本与校验和

### TC-301-023: starter 与 manifest 入包
- **Priority**: P2 · **Type**: Build
- **Steps**: 检查 resources
- **Expected**: 含 sync-daemon-starter.js 与 bundle-manifest.json

### TC-301-024: Windows NSIS 安装包内容核对
- **Priority**: P1 · **Type**: Build
- **Steps**: 本机 `tauri build` 后安装，列安装目录
- **Expected**: 含 Tauri 程序、resources/node（v26.13.0）、starter、daemon+插件 dist、完整 node_modules；卸载后用户数据 `~/.pi-agent-hub` 保留

### TC-301-025: 安装包离线启动（不依赖系统 Node）
- **Priority**: P1 · **Type**: Integration
- **Precondition**: 干净用户环境（PATH 无 node），使用 TC-301-024 安装包
- **Steps**: 启动托盘
- **Expected**: 经内置 node + starter 成功拉起 daemon（不触发 npx）

### TC-301-026: GitHub Actions 三矩阵构建
- **Priority**: P1 · **Type**: CI
- **Steps**: 手动触发 workflow（windows-latest / macos-14 arm64 / macos-13 x64）
- **Expected**: 三任务均成功，产出 NSIS exe 与两个 dmg  artifact，命名含版本/平台/架构；无签名步骤；tag 触发仅以注释预留
- **备注**: macOS 产物真机运行 ⬜ 待验证（无 macOS 设备），CI 编译通过为准

### TC-301-027: 根构建不被 Rust 阻塞
- **Priority**: P2 · **Type**: Quality
- **Steps**: 根目录 `pnpm build && pnpm typecheck`
- **Expected**: 全绿且不触发 cargo 构建

## F. E2E（对接 004-sync-session 全链路）

### TC-301-028: 托盘守护下的真实 ~/.pi 同步闭环
- **Priority**: P1 · **Type**: Integration
- **Precondition**: Docker Desktop 启动 hub-service（deploy/docker-compose）；本机 `~/.pi` 有真实会话；sync-daemon.json 指向本地 hub
- **Steps**: 启动托盘（自动拉起 daemon）→ 等待一个同步周期 → hub-console 查看
- **Expected**: hub 出现本机 host/agent 与会话，正文可读（与 004 的 TC-009~011 等价闭环）；托盘暂停后同步停止、继续后恢复

## 回归（构建质量）
### TC-301-029: Rust 静态检查与全仓类型检查
- **Priority**: P1 · **Type**: Quality
- **Steps**: `cargo clippy`（src-tauri）+ `pnpm build && pnpm typecheck`
- **Expected**: 0 error、无 warning 级告警；无 as any/@ts-ignore/空 catch 新增
