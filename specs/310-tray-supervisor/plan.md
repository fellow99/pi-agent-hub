# 310-tray-supervisor Technical Plan（As-Built）

> Module: 310-tray-supervisor
> Corresponding spec: ./spec.md
> Last Updated: 2026-11-10

## 1. 技术上下文
- Rust crate：`pi-agent-hub-tray`，依赖 `tauri = {version="2", features=["tray-icon"]}`、`serde`、`serde_json`；edition 2021。
- 前端：`ui/` 静态 HTML/CSS/JS（无框架），经 `frontendDist: "../ui"` 打包。
- 代码：`packages/sync-daemon-tray/src-tauri/src/lib.rs`（172 行）。

## 2. Constitution 符合性
- ✅ 托盘只做守护与配置（不采集、不直连 hub），符合职责边界。

## 3. 研究结论
- 用 `Mutex<Option<Child>>` 持有 daemon 子进程；`try_wait` 检测退出（非阻塞轮询）。
- daemon 入口默认 `sync-daemon/dist/main.js`（相对运行目录），可用 env 覆盖（对打包/联调友好）。
- 托盘事件：`on_menu_event`（show/quit）+ `on_tray_icon_event`（左键点击打开窗口）。
- CSP 收紧为 `self` + inline style，规避标准 Tauri dev 配置。

## 4. 文件清单
| 文件 | 用途 |
|---|---|
| src-tauri/Cargo.toml | Rust 依赖 |
| src-tauri/tauri.conf.json | 窗口/托盘/CSP/打包 |
| src-tauri/capabilities/default.json | 权限 core:default |
| src-tauri/build.rs / main.rs | 构建/入口 |
| src-tauri/src/lib.rs | 托盘 + 守护命令 + 配置命令 |
| ui/index.html / app.js / style.css | 配置界面 |

## 5. 关键实现（对照 spec）
- `start_daemon`：`Command::new(node).arg(path).arg("run").arg("--config").arg(config)`（对应 FR-310-004）。
- `daemon_status`：`child.try_wait()` `Ok(None)` → pid，否则清空 `*guard=None`（对应 FR-310-006）。
- `write_config`：`create_dir_all(parent)` + `serde_json::to_string_pretty`（对应 FR-310-009）。
- `ui/app.js`：`window.__TAURI__?.core?.invoke` 守卫，非 Tauri 环境提示（对应 FR-310-012）。

## 6. 测试考虑
- 需 Rust 环境；建议集成：先启动 daemon 配置，调 start/stop/status 断言进程生命周期（overall-test-cases T-310-001/002）。
