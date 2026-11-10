# overall-plan.md — 整体技术方案（As-Built）

> 属于：pi-agent-hub 规格文档（specs-as-built）
> 生成时间：2026-11-10
> 说明：记录当前脚手架**实际是如何构建的**（实现视角），与 constitution.md 对账，并指向各模块 plan.md。

---

## 1. 技术背景

| 项 | 值 |
|---|---|
| 运行时 | Node >=22.19（推荐 24 LTS）；ESM + TypeScript（strict） |
| 工程组织 | pnpm workspace，`packages/*` 单包单职责 |
| 服务端 | Express 5 + node:sqlite（`DatabaseSync`）+ 静态托管 |
| 端侧 | 纯 Node（内置 fetch / child_process / readline / zlib）|
| 插件 | 子进程 + JSON-RPC 2.0 over stdio（NDJSON）|
| 前端 | Vite + Vue 3 + Element Plus + markdown-it/DOMPurify |
| 托盘 | Tauri v2 + 原生 HTML |

## 2. Constitution 符合性检查

| 原则 | 状态 | 说明 |
|---|---|---|
| pnpm workspace 组织 · 单包单职责 | ✅ | packages/ 10 个包，职责清晰 |
| 严格类型（strict，无压制） | ✅ | tsconfig.base strict；未发现 any/ts-ignore |
| 插件子进程隔离 · 不直连 hub · 不改 native | ✅ | sync-plugin-sdk + plugin-manager；契约明确 |
| 统一 pi v3 canonical 契约 | ✅ | pi-session 校验/线性化被所有端复用 |
| API 前缀与幂等纪律 | ✅ | /api/v1（daemon）、/api/hub（console）；entryId 去重 |
| 安全底线（timingSafeEqual、CSRF、Cookie、CSP、DOMPurify） | ⚠️ 部分 | 已落地大部分；TLS 依赖反代；脱敏 TODO |
| 质量与验证（build/typecheck/test） | ⚠️ 部分 | build/typecheck 就绪；test 为占位 |
| 角色 admin/viewer（无 RBAC） | ✅ | auth 中间件按角色控制 |

## 3. 实现策略概览

### 3.1 契约先行（protocol + pi-session）
- `@pi-agent-hub/protocol` 定义全部共享类型（配置、manifest/sync DTO、能力位、transcript 块、JSON-RPC 参数）。
- `@pi-agent-hub/pi-session` 提供 pi v3 的解析/校验/线性化/编码/序列化，被 service、daemon、插件三方复用。

### 3.2 插件进程框架（sync-plugin-sdk）
- `server.ts` 提供 `runPluginServer`（读 stdin、分派 handler、写 stdout）；`client.ts` 提供 `RpcClient`
  （spawn 子进程、请求/超时/通知、退出处理）。
- 三个插件只实现 `PiPlugin/OpencodePlugin/DshPlugin` 的 handler，接入成本低。

### 3.3 端侧 daemon
- `PluginManager`：解析插件（本地路径 / pluginRoot / npm 动态安装）→ spawn → initialize → detect。
- `HubClient`：`fetch` 封装 REST + 手写 SSE 帧解析与断线重连（保存 `lastEventId`）。
- `Daemon`：30s 周期 `syncAll`（manifest → 差分 read_session → sync），SSE 事件循环分派 deliver/import/export_native。
- `control.ts`：本地控制 API（随机端口+token），供托盘/调试使用。

### 3.4 中心服务 hub-service
- `app.ts`：单文件 Express 应用，覆盖登录/鉴权/API/SSE/静态托管/错误处理。
- `db.ts`：`node:sqlite`（sessions、deliveries 表）。
- `session-store.ts`：hubSessionId 派生、sync 合并（full 原子替换 / delta 追加）、transcript 规范化、readEntry。
- `sse.ts`：每主机单连接、心跳、顶替、send。
- `auth.ts`：Cookie 会话 + CSRF + token 哈希/匹配。

### 3.5 前端 console
- 静态 SPA（`/hub/` base），Element Plus 全量引入，路由 /login /sessions /sessions/:id /hosts。
- `api.ts` 统一请求封装（CSRF、错误抛出）。
- 正文渲染按 block 分类，markdown-it(html:false)+DOMPurify。

### 3.6 托盘 tray
- Tauri v2：托盘菜单（Open settings / Quit）、WebView 配置窗口（静态 HTML）。
- Rust 命令：read_config / write_config / daemon_status / start_daemon / stop_daemon。

## 4. 横切关注点

### 4.1 错误处理
- hub：统一 `{ error: { code, message } }` 结构；顶部兜底 500；Express 5 async 自动捕获。
- daemon：sync 失败记日志不中断循环；SSE 断线重连；事件处理 try/catch 回失败 result。
- plugin：`PluginError` 归一为 JSON-RPC error `{code, message, data:{code,retryable}}`。

### 4.2 日志
- daemon：`Logger`（stderr + `logs/sync-daemon.log`）。
- hub：当前无结构化日志（仅进程 stderr 启动信息）。

### 4.3 安全
- 传输：TLS 由部署反代承担（Docker nginx 反代方案）。
- 凭据：token 哈希匹配；密码支持明文（dev）或 scrypt$ 哈希；Cookie HttpOnly/SameSite。
- 前端注入：markdown html:false + DOMPurify；托盘 WebView CSP。

### 4.4 身份与会话 ID（幂等基座）
- host = daemon token 的 `hostName`；agentId/hubSessionId 均 sha256 派生（确定性、命名空间隔离）。

## 5. 测试策略（当前）

| 层 | 内容 | 现状 |
|---|---|---|
| 单测 | 各包 `vitest run --passWithNoTests` | 占位 |
| 契约/一致性 | 插件 canonical 输出、merge、transcript | TODO |
| E2E | hub+daemon+console 联调 | TODO（可通过本地 examples 手测） |

## 6. 部署策略

- 本地开发：`pnpm dev:hub` + `pnpm dev:console` + `pnpm dev:daemon`（见 README）。
- Docker：`deploy/docker-compose.yml`（hub-service / hub-console / nginx 反代），见 `deploy/README.md`。
- 端侧：Windows/macOS 托盘（Tauri），Linux pm2（规划）。

## 7. 待办（TODO，源码/README 标注）

- hub-service 接入 pi SDK 只读解析（替换当前 pi-session 直读）。
- upload 流、import 全链路（bundle/native 中转/临时 blob）。
- FTS5 或 LIKE 全文搜索。
- SSE 事件持久化与 `Last-Event-ID` 重放、`reset` 兜底 REST pending。
- daemon 侧脱敏、spool 离线缓冲、完整重试/退避。
- console 分页/虚拟列表/多语言/下发/导入界面。
- 托盘：单实例锁、开机自启、退出语义、日志入口。
- 真实 vitest 测试与 CI。
