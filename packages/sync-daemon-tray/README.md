# @pi-agent-hub/sync-daemon-tray

Tauri v2 + 静态 HTML 的系统托盘/菜单栏程序：守护 `@pi-agent-hub/sync-daemon` + 配置界面。仅 Windows/macOS。

## 功能（301-sync-daemon-tray）

- **启动链**：托盘启动时优先用内置 Node（`resources/node`）执行 `sync-daemon-starter.js`
  → 失败则尝试 `npx -y @pi-agent-hub/sync-daemon run ...` → 全部失败弹错误窗并保持托盘驻留。
- **托盘菜单**：配置 / 暂停同步（进程级停止 daemon）/ 继续同步（重新拉起）/ 退出（停止 daemon 后退出）。
- **配置页**：textarea 编辑整份 `~/.pi-agent-hub/sync-daemon.json`（保存前 JSON 校验，合法才落盘并重启 daemon）；
  开机自启 checkbox（用户级，Windows HKCU Run / macOS LaunchAgent）。
- **单实例**：重复启动只聚焦已有窗口，避免双托盘/双 daemon。

## 本地开发 / 联调

```bash
# 工程构建（JS 侧；根 pnpm build 不触发 Rust）
pnpm install && pnpm build

# 组装安装包资源（下载 Node v26.13.0 + 复制 daemon/插件/node_modules 到 src-tauri/resources）
node packages/sync-daemon-tray/scripts/assemble-resources.mjs --target win-x64

# 编译/运行 Tauri（需 Rust + 平台 WebView2）
pnpm --filter @pi-agent-hub/sync-daemon-tray tauri:dev
pnpm --filter @pi-agent-hub/sync-daemon-tray tauri:build
```

调试模式（本地仓库联调，不经内置 node_modules）用环境变量指到本仓库：

| 变量 | 说明 |
|---|---|
| `PI_AGENT_HUB_NODE` | 指定 node 可执行文件（默认内置 node，否则系统 node） |
| `PI_AGENT_HUB_DAEMON` | 指定 daemon 入口（默认 starter 三级解析：内置 node_modules → 全局 npm） |
| `PI_AGENT_HUB_STARTER` | 指定 starter 路径（默认 `resources/sync-daemon-starter.js`） |

例（开发期 dev 模式，dev 下 resource_dir 无内置资源，需显式指定）：

```bash
set PI_AGENT_HUB_NODE=node
set PI_AGENT_HUB_STARTER=D:\pi-workspace\pi-agent-hub\packages\sync-daemon-tray\sync-daemon-starter.js
set PI_AGENT_HUB_DAEMON=D:\pi-workspace\pi-agent-hub\packages\sync-daemon\dist\main.js
pnpm --filter @pi-agent-hub/sync-daemon-tray tauri:dev
```

## 打包

GitHub Actions：`.github/workflows/sync-daemon-tray.yml`，手动触发三矩阵（win-x64 / macos-arm64 / macos-x64），
产 NSIS `.exe`（Windows）与 `.dmg`（macOS x2）。安装包内含：托盘程序、Node v26.13.0、`@pi-agent-hub/*` 全部运行时包、
`sync-daemon-starter.js` 与 `node_modules`。当前不签名/不公证（规划暂缓项）。

> 需 Rust/Cargo、Tauri CLI、平台 WebView2（Windows）/Xcode 工具链（macOS）。
> 根 `pnpm build` 不构建 Rust，避免缺少 Cargo 时阻塞 JS 侧。
