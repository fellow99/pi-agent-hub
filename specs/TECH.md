# TECH.md — 技术选型

> 属于：pi-agent-hub 规格文档（specs-as-built）
> 生成时间：2026-11-10
> 说明：依据 `package.json` 依赖清单与源码实际使用整理；「已落地」指当前已成为仓库代码事实。

---

## 1. 工程级

| 类别 | 技术 | 版本 | 说明（依据） |
|---|---|---|---|
| 包管理器 | **pnpm workspace** | pnpm@11.7.0 | `package.json` packageManager；`pnpm-workspace.yaml` 声明 `packages/*` |
| 语言/运行时 | **Node.js** | >=22.19（引擎声明） | `engines`，推荐 Node 24 LTS；使用 `node:sqlite`、`node:zlib`、`fetch` 等内置能力 |
| 模块体系 | ESM + TS | — | 根 `"type":"module"`；`tsconfig.base.json` 为 `NodeNext` + `strict` |
| 构建 | tsc（各包 `tsc -p`）+ Vite（console） | — | 根脚本 `pnpm build` = `pnpm -r run build` |
| 测试 | vitest | ^2.1.8（workspace devDep） | 各包 `test` 均为 `vitest run --passWithNoTests`（当前占位） |
| TypeScript 工具 | tsx / typescript / @types/node | ^4.19.2 / ^5.7.3 / ^22.10.5 | 根 devDependencies |

---

## 2. 各子工程

### 2.1 `@pi-agent-hub/protocol`（公共契约）

| 类别 | 技术 | 说明 |
|---|---|---|
| 组成 | 纯 TS 类型 + 常量 | 无运行时依赖，`private: true` |

### 2.2 `@pi-agent-hub/pi-session`（pi session 处理）

| 类别 | 技术 | 说明 |
|---|---|---|
| 依赖 | `@pi-agent-hub/protocol`（workspace:*） | 仅类型 |
| 内置 API | `node:crypto`、`node:fs/promises`、`node:path` | sha256、文件读取、路径/编码 |

### 2.3 `@pi-agent-hub/sync-plugin-sdk`（插件进程框架）

| 类别 | 技术 | 说明 |
|---|---|---|
| 依赖 | `pi-session`、`protocol`（workspace:*） | |
| 内置 API | `node:child_process`、`node:readline` | 子进程 + 行协议（JSON-RPC over stdio） |

### 2.4 `@pi-agent-hub/hub-service`（中心服务）

| 类别 | 技术 | 说明 |
|---|---|---|
| Web 框架 | **Express** | ^5.3.0（async 错误被 Express 5 自动捕获） |
| YAML 配置 | **yaml** | ^2.7.0（`hub-service.yml` 支持） |
| 数据库 | **node:sqlite**（`DatabaseSync`） | Node 内置同步 SQLite；当前 `hub.db`（sessions/deliveries 表） |
| 内置 API | `node:path`、`node:crypto`、`node:fs/promises` | 静态托管、token 哈希、原子写 |
| 静态托管 | express.static + sendFile | 托管 hub-console 构建产物（`/hub/*`） |
| 端依赖 | `@pi-agent-hub/pi-session`、`@pi-agent-hub/protocol`、`@pi-agent-hub/sync-plugin-sdk`（workspace:*） | |

> 注：仓库规划方案曾评审 better-sqlite3 vs node:sqlite（000 §14.5）；当前落地为 **node:sqlite**。

### 2.5 `@pi-agent-hub/hub-console`（前端）

| 类别 | 技术 | 说明 |
|---|---|---|
| 构建 | **Vite** | ^6.0.7；`base: "/hub/"`；`/api` 代理到 `127.0.0.1:8443` |
| 框架 | **Vue 3** | ^3.5.13，`<script setup>` + Composition API |
| 路由 | **vue-router** | ^4.5.0（`createWebHistory("/hub/")`） |
| 组件库 | **Element Plus** | ^2.9.3 + `@element-plus/icons-vue` ^2.3.1（全量引入） |
| Markdown | **markdown-it** ^14.1.0 + **dompurify** ^3.2.3 | 正文渲染 + 净化（`html:false`） |
| 类型检查 | vue-tsc | ^2.2.0（`vue-tsc --noEmit`） |
| 插件 | @vitejs/plugin-vue | ^5.2.1 |

> 相对于规划（000 §11.7）中的 `@tanstack/vue-query`、`vue-virtual`、`shiki`、`diff2html`、`vue-i18n`：当前 scaffold **尚未引入**。

### 2.6 `@pi-agent-hub/sync-daemon`（端侧守护）

| 类别 | 技术 | 说明 |
|---|---|---|
| 依赖 | `pi-session`、`protocol`、`sync-plugin-sdk`（workspace:*） | |
| HTTP | **内置 fetch** | 上行 REST（manifest/sync/ack/result）与 SSE 读取（无第三方 HTTP 库） |
| 子进程 | `node:child_process`（execFile / spawn） | 插件动态安装（npm）与插件进程拉起 |
| 配置 | JSON（`~/.pi-agent-hub/sync-daemon.json`） | 强校验 |

### 2.7 `@pi-agent-hub/sync-plugin-*`（三个插件）

| 类别 | 技术 | 说明 |
|---|---|---|
| 依赖 | `pi-session`、`protocol`、`sync-plugin-sdk`（workspace:*） | |
| pi 会话读取 | `@pi-agent-hub/pi-session` 解析 JSONL | |
| opencode 读取 | **node:sqlite** `DatabaseSync`（readOnly） | 直读 SQLite V2（`session_v2`/`session_message`/`session_part`） |
| dsh 读取 | **node:zlib** `zstdDecompressSync` | 直读 `.jsonl[.zstd]` |

### 2.8 `@pi-agent-hub/sync-daemon-tray`（Tauri 托盘）

| 类别 | 技术 | 说明 |
|---|---|---|
| 桌面壳 | **Tauri v2** | `@tauri-apps/cli` ^2.2.5（devDep） |
| Rust | `tauri = { version = "2", features = ["tray-icon"] }` | 托盘菜单/守护命令/配置读写 |
| 前端 | 静态 HTML/CSS/JS（无框架） | `ui/` 目录，无构建链 |
| CSP | `default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'` | tauri.conf.json |

> Rust 工具链构建需 Cargo；根 `pnpm build` 不构建 Rust（避免缺 Cargo 阻塞 JS 侧）。

---

## 3. 关键架构选型要点

| 决策 | 落地状态 | 说明 |
|---|---|---|
| 插件子进程 + JSON-RPC(stdio) | ✅ 已落地 | `sync-plugin-sdk` 的 server/client 对；`plugin-manager` 拉起 |
| 插件动态 npm 安装 | ✅ 已落地 | `PluginManager.install`（`npm install --save-exact --ignore-scripts`） |
| 统一存储 pi v3 JSONL | ✅ 已落地（写路径） | `session-store.sync` 用 pi-session serialize/追加方式落盘 |
| 数据库 node:sqlite | ✅ 已落地 | `db.ts` `DatabaseSync` |
| SSE 下行 / REST 上行 | ✅ 已落地 | `sse.ts` + `hub-client.connectEvents` |
| 本地控制 API | ✅ 已落地 | `control.ts`（默认随机端口 + token 文件） |
| pi SDK 只读解析 | ❌ 未接入 | README 标注 TODO；当前用 `@pi-agent-hub/pi-session` 解析 |
| 上传流 / 导入 native 中转 / 完整重试 | ❌ TODO | README 标注；`/api/v1/uploads` 未实现 |
| 动态运行平台守护（pm2 / 托盘完整链路） | 🔶 部分 | Linux 需外部 pm2；托盘仅守护 skeleton 与配置界面 |

---

## 4. 版本与兼容性约束

- Node 运行时下限 **22.19.0**（pi SDK engines 基线要求，见根 `engines`）。
- 协议版本：`PROTOCOL_VERSION = "1.0"`、`PLUGIN_PROTOCOL_VERSION = "1.0"`（`protocol/src`）。
- daemon API 前缀 `/api/v1`，capabilities 中 `uploads: false`（当前）。
- 各包 `private: true`（暂未发布 npm）。
