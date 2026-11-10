# ARCHITECTURE.md — 整体架构

> 属于：pi-agent-hub 规格文档（specs-as-built）
> 生成时间：2026-11-10
> 说明：记录**当前脚手架真实架构**（以源码为准），并与规划（docs/000）中的目标架构对照标注差异。

---

## 1. 架构总览

```text
┌──────────────────────── 主机（Windows / macOS / Linux）─────────────────────────┐
│                                                                                │
│  pi (agentDir/sessions)   opencode (opencode.db)   dsh (session.vN.jsonl[.zstd]) │
│        │  JSONL                 │ SQLite(V2)           │ JSONL/zstd             │
│        ▼                        ▼                      ▼                       │
│  sync-plugin-pi-agent ◄─JSON-RPC/stdio─► sync-daemon ◄─JSON-RPC/stdio─► sync-plugin-opencode │
│                                        sync-plugin-dsh                        │
│        │ 采集(manifest/read_session)      │ REST 上行(manifest/sync/ack/result) │
│        └────────────► hub-service ◄───────┘  SSE 下行(deliver)                 │
│                       (Express5 + node:sqlite + pi v3 JSONL)                  │
│                             │  /api/hub/*  (读取+控制)                        │
│                             ▼                                                  │
│                       hub-console (Vue3 SPA, /hub/)                           │
│  sync-daemon-tray (Tauri, Win/macOS)◄─local API─► sync-daemon (守护+配置界面)    │
└───────────────────────────────────────────────────────────────────────────────┘
```

**一句话**：各 agent 由独立 Node 子进程（插件）读取存档并归一为 canonical（pi v3 entries）；
`sync-daemon` 负责清单差分同步上行（REST）与接收下行（SSE）；`hub-service` 负责鉴权、镜像落盘、读取与控制 API、
静态托管 console；`hub-console` 提供只读会话查看与控制；`sync-daemon-tray`（Tauri）只做守护与配置界面。

---

## 2. 分层模型

| 层 | 组成 | 职责 | 边界（不做什么） |
|---|---|---|---|
| 展示层 | `hub-console`（Vue3 SPA）；`sync-daemon-tray/ui`（静态 HTML） | 会话查看/登录/主机列表；托盘守护与配置界面 | 不直接连 daemon/agent；不写会话内容 |
| HTTP 边缘层 | `hub-service/src/app.ts`（Express） | 路由、中间件（JSON 限制、Cookie/Bearer 鉴权、CSRF、角色）、静态托管 | 不解析 agent 存档、不渲染 |
| 业务/核心层 | `hub-service`：`session-store.ts`（同步/镜像/transcript）、`sse.ts`（下行） | 会话合并落盘、正文规范化、SSE 推送 | 不上传；不做上传流（TODO） |
| 数据层 | `hub-service/src/db.ts`（node:sqlite `hub.db` + `agent/sessions/**` JSONL） | 会话记录索引、entries 镜像 | 仅作为索引/镜像；可从 JSONL 重建 |
| 端侧采集/执行层 | `sync-daemon` + `sync-plugin-*` 子进程 | 采集、归一、差分、同步、SSE、下发/导入执行 | 插件不直连 hub；daemon 不解析 agent 格式 |
| 平台守护层 | `sync-daemon-tray`（Tauri） | 托盘、daemon 生命周期、配置读写 | 不做业务、不采集 |

---

## 3. 运行时进程

| 进程 | 包 | 生命周期 | 端口/协议 |
|---|---|---|---|
| `hub-service` | `@pi-agent-hub/hub-service` | 常驻（容器/进程） | HTTP `127.0.0.1:8443`（默认） |
| `hub-console` | `@pi-agent-hub/hub-console` | Vite dev / 静态产物 | dev `5173`（代理 /api→8443）；产物由 hub-service 托管 |
| `sync-daemon` | `@pi-agent-hub/sync-daemon` | 常驻 / `--once` | 本地控制 API（随机端口，`daemon-control.json` 通告） |
| `sync-plugin-*` | 三个插件 | 由 daemon 拉起（每 agent 一个子进程） | stdio JSON-RPC |
| `sync-daemon-tray` | `@pi-agent-hub/sync-daemon-tray` | 用户会话（Win/macOS） | Tauri 托盘 + 本地 WebView |

> 目标架构中的「hub-service 直接使用 pi SDK 只读 API」**尚未落地**：当前用 `@pi-agent-hub/pi-session`
> 解析 JSONL（详见差异表 §7）。

---

## 4. 数据流

### 4.1 上行：session 汇总（manifest → 差分 → 同步）
```text
sync-daemon（30s 周期 / sync-now）
  ├─ 每个插件 list_sessions → ManifestAgent{sessions[]}
  ├─ POST /api/v1/sync/manifest          → hub 返回每会话 lastTimestamp / status
  ├─ 非 skipped/quota/error 项：
  │   └─ read_session(since,lastEntryId) → entries（内联或 entriesPath 大包）
  │       └─ POST /api/v1/sync/sessions/{hubSessionId}（mode=delta|full）
  │           └─ SessionStore.sync：校验 → 去重 → 追加/整文件替换 → 更新水位
  └─ 大包 entriesPath → readEntriesFile 读取后 sync
```

### 4.2 下行：会话下发（SSE）
```text
hub-console POST /api/hub/deliveries{sessionId,text,policy}
  → app.ts 校验会话 → deliveries Map 记录 queued
  → SseHub.send(hostId,"deliver",{deliveryId,...})（有活跃 SSE 则 dispatched）
  → sync-daemon HubClient 解析事件 → handleDeliver → plugin.deliver → hub ack/result
```

### 4.3 只读查看
```text
hub-console GET /api/hub/sessions → Store.listSessions → SessionStore.summary
hub-console GET /api/hub/sessions/:id/transcript → SessionStore.transcript（读 JSONL → 分块）
hub-console GET .../blocks/:seq/raw → SessionStore.readEntry（JSON 原文）
```

---

## 5. 部署拓扑

| 形态 | 描述 |
|---|---|
| 本地开发 | `HUB_CONFIG_FILE=examples/hub-service.json pnpm dev:hub` + `pnpm dev:console` + `pnpm dev:daemon` |
| Docker（目标） | `deploy/docker-compose.yml`：hub-service（node:24-alpine）、hub-console（nginx）、nginx 反代（详见 deploy/README.md） |
| 端侧守护 | 托盘（Win/macOS）或 pm2（Linux）守护 sync-daemon（当前仅骨架） |

---

## 6. 关键机制说明

### 6.1 幂等与会话身份
- `hubSessionId = "hs_" + base64url(sha256(hostId\0agentId\0nativeId))[0..26].toLowerCase()`（`session-store.ts`）。
- daemon 侧 `agentId = "a_" + base64url(sha256(hostId\0kind\0instanceName))[0..26].toLowerCase()`（`plugin-manager.ts`）。
- manifest 幂等：`(agentId, nativeId)` 唯一键 upsert（`db.ts` UNIQUE）。

### 6.2 合并语义（当前落地）
- `mode=full`：`validateEntries` 全链校验 → 写临时文件 → rename 原子替换。
- `mode=delta`：按 entryId 去重（已存在跳过）→ 无既有文件则新建，否则追加。
- 水位：`last_timestamp = 末条 entry timestamp`、`last_entry_id = 末条 id`。

### 6.3 鉴权分轨
- daemon：`Authorization: Bearer`，token 用 sha256 哈希后匹配 `daemonTokens[]`（`app.ts` + `auth.ts`）。
- console：Cookie（`hub_session`，HttpOnly+SameSite=Lax）+ CSRF（`X-CSRF-Token`）；写接口需 admin 角色。

### 6.4 SSE
- 每主机 1 条活跃连接，新连接顶替旧（旧流收 `reset`）。
- 15s 心跳注释；`retry: 3000`；响应头关缓冲（`X-Accel-Buffering: no`）。
- 事件 `id` 使用 `Date.now()`（非持久化事件表，当前无重放）。

### 6.5 插件子进程
- `RpcClient`（spawn `process.execPath [bin]`, stdio pipe）→ 行协议 JSON-RPC。
- 初始化握手 + `detect`，能力取自 `piAgentHub` 元数据。
- 缺包时按 allowlist 动态 `npm install` 到 pluginRoot。

---

## 7. 规划 vs 落地差异（以源码为准）

| 规划目标（docs/000） | 当前落地 | 备注 |
|---|---|---|
| hub-service 用 pi SDK 只读 API 解析 | 用 `@pi-agent-hub/pi-session` 解析 | README TODO：接入 pi SDK |
| upload 流（`/api/v1/uploads`） | 未实现；`capabilities.uploads:false` | TODO |
| 导入 bundle / native 中转 | `/api/hub/imports` 返回 501；daemon 有转发的处理壳 | TODO |
| 搜索 FTS5/LIKE 回退 | 仅 title/cwd `includes` 过滤 | 最小实现 |
| transcript 分页 `before` 游标 | 已实现（seq 过滤） | — |
| SSE 重放 `Last-Event-ID` + `sse_events` 表 | daemon 保留 `lastEventId` 请求头；hub 侧无持久化重放 | 部分 |
| 完整错误重试/退避 | 部分（SSE 断线重启、sync 失败记日志） | TODO |
| 多主机 agent 表 / 会话状态机 | hosts 来自配置 token；agents 空数组；sessions 有状态字段 | 最小 |
| 托盘完整生命周期 | 守护 start/stop/status + 配置读写；无单实例锁/自启 | 骨架 |

> 所有 TODO 均以 README/源码注释标注；本文档如实描述当前状态，不做前置承诺。
