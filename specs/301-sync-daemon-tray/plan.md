# 301-sync-daemon-tray Technical Plan（实现方案）

> Module: 301-sync-daemon-tray（原 301-tray-supervisor 更名合并）
> Corresponding spec: ./spec.md
> Last Updated: 2026-11-10
> 状态：scaffold 已落地（Tauri v2 + 静态 HTML），本方案描述增量演进

## 1. 技术上下文
- Rust crate：`pi-agent-hub-tray`，现依赖 `tauri = {version="2", features=["tray-icon"]}`、`serde`、`serde_json`；edition 2021；本机 cargo 1.94.1 可真编译。
- 前端：`ui/` 静态 HTML/CSS/JS（无框架），`withGlobalTauri: true`，经 `frontendDist: "../ui"` 打包；CSP 已收紧。
- 现有代码：`src-tauri/src/lib.rs`（172 行）持有 `Mutex<Option<Child>>`，直接 `Command::new(node).arg(daemon_entry())` 启动；
  命令 `read_config/write_config/daemon_status/start_daemon/stop_daemon`；菜单 Open settings/Quit；env `PI_AGENT_HUB_NODE`/`PI_AGENT_HUB_DAEMON`。
- daemon 侧事实（specs/401）：入口 `packages/sync-daemon/dist/main.js`，CLI `run --config <path> [--once]`；
  本地控制 API（`control.ts`）含 `/local/pause|resume`，本期托盘**不接入**（FR-301-013）。
- 插件事实：daemon 经 `createRequire(pluginRoot/package.json)` 与本地/全局 node_modules 解析插件（`plugin-manager.ts`），
  故安装包内置 `node_modules` 放在 starter 同级即可被「starter 同级 node_modules」解析链覆盖。
- CI：仓库无 `.github/workflows/`，新建；Node 固定 **v26.13.0**（nodejs.org/dist 实测可达，含 SHASUMS256.txt）。

## 2. Constitution 符合性
- ✅ 托盘只做守护 + 配置 + 状态展示，不采集、不直连 hub（docs §7.12 职责边界）。
- ✅ 用户级运行，不注册系统服务、不要求 root（NFR-14、C-10：退出托盘即停 daemon）。
- ✅ 纯 Node ESM starter 零第三方依赖，可被内置 node 直接执行。
- ✅ 严格类型纪律：Rust 无 warning 级告警；JS 无 `as any`/`@ts-ignore`/空 catch；改动后 `pnpm typecheck` 全绿。
- ✅ 根 `pnpm build` 不被 Rust 阻塞（FR-301-033，scaffold 约定保留）。
- ✅ 构建产物可复现：Node 版本固定 + SHA256 校验 + 组装脚本化。

## 3. 研究结论与关键决策

### 3.1 启动链分层：starter（JS）负责「解析」，Rust 负责「选 node + 兜底 + 弹窗」
- 解析逻辑放 JS 而非 Rust：npm 包解析（local/global、scope 包、npm 布局）用 Node `createRequire` 天然正确，
  Rust 重写易错；Rust 只做进程编排与平台 UI。
- starter 三级解析（FR-301-002）：
  1. `PI_AGENT_HUB_DAEMON`（调试，指向 `packages/sync-daemon/dist/main.js`）；
  2. `<starter 目录>/node_modules/@pi-agent-hub/sync-daemon/dist/main.js`（安装包内置 / 本地联调）；
  3. `createRequire(<starter>/package.json).resolve("@pi-agent-hub/sync-daemon/dist/main.js")`（全局 npm 链路）。
- 失败时 stderr 输出单行 JSON `{ "error": "starter_resolve_failed", "reason": "env_not_found|local_not_found|global_not_found" }` 并退出码 1。
- starter spawn 时 `stdio: "inherit"`、`process.execPath` 作为可执行文件；转发 SIGINT/SIGTERM 与子进程退出码。

### 3.2 Rust 启动与失败判定（FR-301-006~009）
- 内置 node 路径：`app.path().resource_dir()?` 下
  Win `node/node.exe`、macOS `node/bin/node`；存在则用内置，否则 `Command::new("node")` 走系统 PATH。
- starter 路径：`resource_dir()/sync-daemon-starter.js`（dev 调试时 env `PI_AGENT_HUB_STARTER` 可覆盖，指向仓库源文件）。
- **失败判定启发式**：spawn 后 2 s 内 `try_wait` 轮询；进程仍存活 = 启动成功；已退出且非零 = 启动失败 → npx 兜底
  （Win 用 `npx.cmd`，*nix 用 `npx`，参数 `-y @pi-agent-hub/sync-daemon run --config <path>`）。
  npx 同样适用 2 s 判定；全失败 → `tauri-plugin-dialog` 阻塞错误弹窗（含最后错误与配置路径），托盘保活。
- 选择 2 s 启发式而非 ready 握手：starter/daemon 均为既有 CLI，不改协议；daemon 正常为长驻进程，2 s 足够覆盖解析失败的即时退出。

### 3.3 菜单与生命周期
- 菜单三项（FR-301-012）：`配置` / `暂停同步|继续同步`（动态重建菜单切换文案）/ `退出`。
- 暂停 = 现有 `stop_daemon`（kill + wait）；继续 = 3.2 完整启动链；退出 = 先 stop 再 `app.exit(0)`（FR-301-015）。
- 左键点击与「配置」均 show + focus 配置窗口。
- `DaemonStatus` 增加 `mode: "starter" | "npx" | null`，前端展示实际启动方式。

### 3.4 配置窗口改造（FR-301-017~023）
- `index.html`：移除四字段表单，改为 **textarea（整份 JSON）+ 开机自启 checkbox + 状态区 + 保存/重载/立即重启**。
- 保存链（`app.js`）：
  1. 前端 `JSON.parse(textarea)` 失败 → 展示错误（含行列），不调用任何写命令；
  2. 通过 → `invoke("write_config", { value })`（Rust 端 `to_string_pretty` 落盘，建父目录）；
  3. `invoke("set_autostart", { enabled })`；
  4. `invoke("restart_daemon")`（stop → 3.2 启动链），刷新状态。
- 窗口加载时 `invoke("get_autostart")` 回填 checkbox；`read_config` 失败（文件缺失）→ textarea 预填 `{}` 并提示。
- 非 Tauri 环境守卫保留（FR-301-022）；CSP 不变（FR-301-023）。

### 3.5 自启与单实例（FR-301-024~026）
- 新增 Rust 依赖：`tauri-plugin-autostart = "2"`、`tauri-plugin-single-instance = "2"`、`tauri-plugin-dialog = "2"`。
- 自启：`AutoLaunchManager::new(MacosLauncher::LaunchAgent)`；暴露命令 `get_autostart/set_autostart`；
  仅当前用户（HKCU Run / 用户 LaunchAgent），不申请特权。
- 单实例：`tauri_plugin_single_instance::init` 回调中 show + focus 配置窗口；插件必须在 Builder 最早注册。
- macOS 菜单栏形态（LSUIElement，dock 不显示图标）：Tauri v2 无直接配置项，方案为 CI 打包后对 Info.plist 补
  `LSUIElement=true`（组装脚本中用 plutil 补丁，标 ⬜ 待真机验证）；不阻塞主流程。

### 3.6 资源组装与 Tauri resources 布局
```text
src-tauri/resources/（构建期生成，不入库；.gitignore 忽略）
├── node/                         # 内置 Node v26.13.0（平台相关，CI 下载解压）
│   ├── node.exe（Win）/ bin/node（macOS）
│   └── npm/npx（随 node 分发包，供 npx 兜底与动态装插件）
├── sync-daemon-starter.js        # 复制自包根
├── bundle-manifest.json          # node 版本/sha256、各包版本、组装时间
└── node_modules/
    └── @pi-agent-hub/{sync-daemon,sync-plugin-pi-agent,sync-plugin-opencode,sync-plugin-dsh} + 传递依赖
```
- `tauri.conf.json` 增加 `bundle.resources` 映射上述条目；运行时经 `resource_dir()` 定位。
- node_modules 组装（脚本化，FR-301-031）：
  1. 对 daemon 与三个插件执行 `pnpm pack`（pnpm 会把 `workspace:*` 依赖改写为真实版本号，产出 tgz）；
  2. 临时 bundle 目录写 `package.json`，依赖指向四个 tgz 的 `file:` 路径；
  3. `npm install --omit=dev --no-audit --no-fund`（独立目录，不触发 pnpm workspace 链接）得到扁平 node_modules；
  4. 生成 `bundle-manifest.json`。
- Node 下载：`https://nodejs.org/dist/v26.13.0/node-v26.13.0-<plat>-<arch>.<ext>`，
  校验 `SHASUMS256.txt` 中对应条目（Win zip / macOS tar.gz）。

### 3.7 GitHub Actions（FR-301-027~033）
- 新建 `.github/workflows/sync-daemon-tray.yml`：
  - `on: workflow_dispatch`（手动）；tag 触发以注释块预留（`push: tags: ['v*']`）。
  - matrix：`windows-latest/x64`、`macos-14/arm64`、`macos-13/x64`。
  - 步骤：checkout（含 submodules）→ pnpm/action-setup + actions/setup-node（Node 24 用于工程构建）→
    `pnpm install --frozen-lockfile` → `pnpm build` →
    `node packages/sync-daemon-tray/scripts/assemble-resources.mjs --target <triple>` →
    `pnpm --filter @pi-agent-hub/sync-daemon-tray tauri:build` →
    `actions/upload-artifact`（NSIS exe / dmg，命名含平台架构与版本）。
- 不签名、不公证（FR-301-032）；tauri-action 不采用（直接 CLI + artifact，避免隐式发布）。

## 4. 文件清单（计划改动）
| 文件 | 改动 |
|---|---|
| `packages/sync-daemon-tray/sync-daemon-starter.js` | **新增**：零依赖 ESM 启动器（三级解析 + spawn + 信号/退出码透传） |
| `packages/sync-daemon-tray/src-tauri/Cargo.toml` | 新增 autostart/single-instance/dialog 三个 tauri 插件依赖 |
| `packages/sync-daemon-tray/src-tauri/src/lib.rs` | 启动链（内置/系统 node→starter→npx→弹窗）、三项菜单、自启命令、restart_daemon、status 增 mode |
| `packages/sync-daemon-tray/src-tauri/tauri.conf.json` | bundle.resources、bundle targets（nsis/dmg）、版本 |
| `packages/sync-daemon-tray/src-tauri/capabilities/default.json` | 增补 dialog 权限（autostart/single-instance 仅 Rust 侧使用，无需前端权限） |
| `packages/sync-daemon-tray/ui/index.html` | textarea + 自启 checkbox + 状态/重启区 |
| `packages/sync-daemon-tray/ui/app.js` | JSON 校验保存链、自启读写、restart、状态 mode 展示 |
| `packages/sync-daemon-tray/ui/style.css` | textarea/checkbox 样式微调 |
| `packages/sync-daemon-tray/scripts/assemble-resources.mjs` | **新增**：跨平台资源组装（Node 下载校验 + pnpm pack + npm install + manifest） |
| `packages/sync-daemon-tray/.gitignore`（或根 .gitignore） | 忽略 `src-tauri/resources/` 构建产物 |
| `.github/workflows/sync-daemon-tray.yml` | **新增**：三矩阵手动触发打包 workflow |
| `specs/301-sync-daemon-tray/{spec,plan,tasks,test-cases}.md` | 本需求规格四件套 |
| `specs/{README,SPECS_CHECKLIST,overall-test-cases,STRUCTURE}.md` | 301 更名与新需求索引同步 |

## 5. 实现顺序（与 tasks.md 对齐）
1. starter 脚本 + 本机 node 直接验证三级解析。
2. Rust 启动链重构（选 node/starter/npx/弹窗）+ 菜单三项 + 退出语义。
3. 配置窗口改造 + 自启 checkbox（autostart 插件）+ 单实例插件。
4. `cargo check`/`cargo clippy` + 本机 `tauri dev`/`tauri build`（Windows）真实验证。
5. assemble-resources.mjs + 本机试跑组装（windows-x64）。
6. GitHub Actions workflow（本地用 `act` 不做硬性要求；以 YAML 语法与步骤可审查为准，CI 真机运行留触发后验证）。
7. 索引文档同步 + 全量 `pnpm build && pnpm typecheck` 回归。

## 6. 测试考虑
- starter：本机 Node 跑三级解析矩阵（env/本地/全局/全失败原因码）、退出码与信号透传。
- Rust：`cargo test`（可纯函数化的解析/判定逻辑单测）+ `cargo clippy`；Windows 真机 `tauri build` 后安装包级验证。
- UI：DevTools 手动验证非法 JSON 拦截、合法保存重启、自启 checkbox 双向同步。
- E2E（对接 004 链路）：Docker Desktop 起 hub-service → 托盘安装包启动 daemon → 采集真实 `~/.pi` 会话 → hub 可见。
- macOS：CI 矩阵编译通过为准，真机运行 ⬜ 待验证。
- 详细用例见 `test-cases.md`。

## 7. 风险与处置
| 风险 | 处置 |
|---|---|
| npx 兜底依赖 npm 包未发布 | spec 已标 ⬜；CI/安装包主路径不依赖 npx，仅断网/安装损坏时兜底，失败有错误窗 |
| 2 s 启动失败判定误判（慢机器） | 判定只用于「即时退出」识别；存活即成功，慢启动不受影响；阈值集中常量便于调整 |
| `pnpm pack`  workspace 协议改写 | 先用最小实验确认 tgz 内依赖版本已实例化，再写进组装脚本（开发期第一步验证） |
| macOS LSUIElement/双架构/签名 | plist 补丁脚本化并标 ⬜ 待真机；签名公证本期明确不做 |
| Tauri resources 在 Win/macOS 布局差异 | 统一经 `resource_dir()` 解析，路径分支集中在单个 Rust 函数 |
| CI 无法在本机完整复现 | 组装脚本本机可跑；workflow 步骤与本地命令保持一一对应 |
