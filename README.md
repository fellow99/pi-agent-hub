# pi-agent-hub

多智能体会话汇总、只读查看与下发服务。

> 规划与契约文档在 [`docs/`](./docs/)：
> - [`000-工程规划.md`](./docs/000-工程规划.md)
> - [`001-协议规范.md`](./docs/001-协议规范.md)
> - [`002-插件开发指南.md`](./docs/002-插件开发指南.md)

## 结构（pnpm workspace）

```text
pi-agent-hub/
├── packages/
│   ├── protocol/                # @pi-agent-hub/protocol（API/transcript 类型）
│   ├── pi-session/              # @pi-agent-hub/pi-session（pi v3 解析/校验）
│   ├── sync-plugin-sdk/         # @pi-agent-hub/sync-plugin-sdk（JSON-RPC/stdio）
│   ├── sync-plugin-pi-agent/    # @pi-agent-hub/sync-plugin-pi-agent
│   ├── sync-plugin-opencode/    # @pi-agent-hub/sync-plugin-opencode
│   ├── sync-plugin-dsh/         # @pi-agent-hub/sync-plugin-dsh
│   ├── sync-daemon/             # @pi-agent-hub/sync-daemon
│   ├── hub-service/             # @pi-agent-hub/hub-service（Express + node:sqlite）
│   ├── hub-console/             # @pi-agent-hub/hub-console（Vue 3 + Element Plus）
│   └── sync-daemon-tray/        # @pi-agent-hub/sync-daemon-tray（Tauri + HTML）
├── examples/                    # 本地开发配置
└── docs/
```

## 快速开始

```bash
pnpm install
pnpm build

# 1) hub（默认读取 ~/.pi-agent-hub/hub-service.json，可用 HUB_CONFIG_FILE 覆盖）
HUB_CONFIG_FILE=./examples/hub-service.json pnpm dev:hub

# 2) console（开发模式，/api 代理到 127.0.0.1:8443）
pnpm dev:console

# 3) daemon（需要先安装插件包；开发时用本地路径）
pnpm --filter @pi-agent-hub/sync-daemon dev -- run --config ./examples/sync-daemon.json
```

## 当前状态（scaffold）

- 三个插件均可构建，已实现 JSON-RPC 子进程协议、canonical 输出、pi 直读/下发/导入/原生导出。
- hub-service 提供最小认证（admin/viewer + 多 token）、manifest/sync、SSE、会话列表/正文/搜索；使用 `node:sqlite`，尚未接入 pi SDK 的只读解析（当前用 `@pi-agent-hub/pi-session`）。
- hub-console 提供登录、会话列表、正文、Hosts 页面；正文渲染为最小实现。
- sync-daemon 已实现插件发现/动态 npm 安装、manifest 差分同步、SSE、deliver/import/export_native 转发、本地控制 API；大负载 upload 流（§4.5：创建→PUT 压缩 NDJSON→entriesRef 提交）已实现，完整重试仍为 TODO。
- `sync-daemon-tray` 是 Tauri v2 + 静态 HTML 骨架；构建需要 Rust/Cargo 与 `tauri-cli`，本仓库未附带 Rust 工具链。
- 未实现的点以 `TODO`/`not_implemented`/`unsupported` 明确标记。

## 脚本

| 命令 | 作用 |
|---|---|
| `pnpm build` | 递归构建所有 package |
| `pnpm typecheck` | 递归类型检查 |
| `pnpm test` | 递归测试（当前为占位） |
| `pnpm dev:hub` | 启动 hub-service |
| `pnpm dev:console` | 启动 console Vite |
| `pnpm dev:daemon` | 启动 sync-daemon |

## 说明

- 仓库使用 **pnpm**；运行时插件安装使用 **npm**（与文档一致）。
- Node 最低版本 **22.19**（pi SDK engines），推荐 Node 24 LTS。
- 文档中的 Tauri 托盘只做 daemon 守护 + 配置界面，不做业务。
