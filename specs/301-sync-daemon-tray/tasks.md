# 301-sync-daemon-tray — 任务清单（tasks.md）

> 依赖有序；按 Setup → Foundation → User Story → Polish 分层。
> 阶段：Specification → Development → Code Review → Testing → Bug Fix → Regression。
> 分支：main（不改动）。规格目录：specs/301-sync-daemon-tray/（由 301-tray-supervisor 更名）。

## Setup
- [ ] T001 规整开发日志目录 `logs/<YYYYMMDD>-<N>/` + DEV_CHECKLIST.md
- [ ] T002 构建基线确认：`pnpm build && pnpm typecheck` 全绿；`cargo check`（src-tauri）基线可编译
- [ ] T003 最小实验：`pnpm pack` 验证 workspace:* 依赖在 tgz 中被改写为真实版本（决定组装脚本方案）

## Foundation — 启动器（FR-301-001~005）
- [ ] T004 新增 `packages/sync-daemon-tray/sync-daemon-starter.js`：零依赖 ESM，三级解析（env/local/global）+ 原因码 + spawn 透传（stdio/信号/退出码）
- [ ] T005 本机验证 starter：env 指向 packages/sync-daemon、内置 node_modules、全局解析、全失败原因码四种路径

## User Story 1 — 托盘启动链与菜单（FR-301-006~016）
- [ ] T006 `Cargo.toml` 引入 tauri-plugin-autostart / single-instance / dialog
- [ ] T007 `lib.rs` 资源定位：resource_dir 内置 node 检测（node/node.exe、node/bin/node）+ 系统 node 回退 + starter 路径（env 覆盖）
- [ ] T008 `lib.rs` 启动链：starter spawn + 2s 失败判定 → npx -y @pi-agent-hub/sync-daemon 兜底（npx.cmd/npx 分平台）→ dialog 错误弹窗 + 托盘保活
- [ ] T009 `lib.rs` 菜单重构：配置 / 暂停同步·继续同步（动态文案，进程级 kill+wait / 重启）/ 退出（停 daemon 后 exit）；左键开窗保留
- [ ] T010 `daemon_status` 适配 starter 链并增加 mode 字段（starter|npx|null）；try_wait 意外退出检测保留
- [ ] T011 单实例插件注册（二次启动聚焦已有窗口）

## User Story 2 — 配置窗口与自启（FR-301-017~026）
- [ ] T012 `ui/index.html` 改造：textarea（整份 JSON）+ 开机自启 checkbox + 状态区 + 保存/重载/立即重启
- [ ] T013 `ui/app.js`：JSON.parse 前端校验（失败不落盘并提示）、write_config、get/set_autostart、restart_daemon、状态展示；非 Tauri 守卫保留
- [ ] T014 `lib.rs` 命令：`get_autostart/set_autostart`（AutoLaunchManager，LaunchAgent）、`restart_daemon`（stop+启动链）；write_config 保存语义保持
- [ ] T015 `capabilities/default.json` 增补 dialog 权限；CSP 保持不变

## User Story 3 — 资源组装与打包 CI（FR-301-027~033）
- [ ] T016 新增 `scripts/assemble-resources.mjs`：Node v26.13.0 下载 + SHASUMS256 校验 + 解压到 resources/node
- [ ] T017 组装脚本：pnpm pack 四包 → 临时 package.json(file:) → npm install --omit=dev 生成 resources/node_modules → 复制 starter → bundle-manifest.json
- [ ] T018 `tauri.conf.json` 配置 bundle.resources / targets（nsis、dmg）；.gitignore 忽略 resources 构建产物；macOS Info.plist LSUIElement 补丁步骤
- [ ] T019 新增 `.github/workflows/sync-daemon-tray.yml`：workflow_dispatch + 三矩阵（win-x64/macos-arm64/macos-x64），tag 触发注释预留，构建并 upload-artifact
- [ ] T020 本机试跑 assemble-resources（windows-x64）+ `tauri build` 产出 NSIS 安装包并核对包内容清单

## Polish
- [ ] T021 `cargo clippy` 无 warning；`pnpm build && pnpm typecheck` 回归全绿
- [ ] T022 同步索引文档：specs/README.md、SPECS_CHECKLIST.md、overall-test-cases.md（T-301 更名扩用例）、STRUCTURE.md
- [ ] T023 E2E：Docker hub-service + 安装包托盘启动 daemon + 真实 ~/.pi 数据同步闭环（对接 004）
