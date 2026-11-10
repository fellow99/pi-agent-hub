# STRUCTURE.md — 工程结构与模块地图

> 属于：pi-agent-hub 规格文档（specs-as-built）
> 生成时间：2026-11-10
> 说明：本文档记录 pi-agent-hub **当前脚手架真实落地**的目录与文件结构，供后续开发、审阅与导航使用。
> 依据真实源码生成，未做臆测。

---

## 1. 顶层结构

```text
pi-agent-hub/                          # pnpm monorepo 根（git 子模块）
├── package.json                       # workspace 根：build / typecheck / test / dev:* 脚本
├── pnpm-workspace.yaml                # packages 目录声明
├── pnpm-lock.yaml                     # 依赖锁定
├── tsconfig.base.json                 # 公共 TS 编译基线（strict + NodeNext）
├── .npmrc                             # pnpm 配置（strict-peer-dependencies=false）
├── .gitignore
├── LICENSE
├── README.md                          # 工程简介与快速开始
├── docs/                              # 规划与契约文档（规划 / 协议 / 插件指南）
│   ├── 000-工程规划.md
│   ├── 001-协议规范.md
│   └── 002-插件开发指南.md
├── examples/                          # 本地开发配置样例
│   ├── hub-service.json
│   └── sync-daemon.json
├── deploy/                            # 部署编排（docker-compose 等）
│   ├── docker-compose.yml
│   ├── .env
│   └── README.md
├── packages/                          # workspace 包（各子工程）
│   ├── protocol/                      # @pi-agent-hub/protocol
│   ├── pi-session/                    # @pi-agent-hub/pi-session
│   ├── sync-plugin-sdk/               # @pi-agent-hub/sync-plugin-sdk
│   ├── sync-plugin-pi-agent/          # @pi-agent-hub/sync-plugin-pi-agent
│   ├── sync-plugin-opencode/          # @pi-agent-hub/sync-plugin-opencode
│   ├── sync-plugin-dsh/               # @pi-agent-hub/sync-plugin-dsh
│   ├── sync-daemon/                   # @pi-agent-hub/sync-daemon
│   ├── hub-service/                   # @pi-agent-hub/hub-service
│   ├── hub-console/                   # @pi-agent-hub/hub-console
│   └── sync-daemon-tray/              # @pi-agent-hub/sync-daemon-tray
└── specs/                             # 本规格文档目录（本文档所在处）
```

---

## 2. packages 明细

### 2.1 公共包（供 service / daemon / plugin 共享）

```text
packages/protocol/                     # @pi-agent-hub/protocol —— 契约/类型唯一来源
└── src/index.ts                       # 全部类型与常量（协议版本、配置、DTO、transcript 块）

packages/pi-session/                   # @pi-agent-hub/pi-session —— pi session v3 读写/校验
└── src/index.ts                       # header/entry 校验、线性化、时间戳、目录/文件名编码、serialize

packages/sync-plugin-sdk/              # @pi-agent-hub/sync-plugin-sdk —— 插件进程框架
└── src/
    ├── index.ts                       # 汇总导出
    ├── jsonrpc.ts                     # JSON-RPC 2.0 消息类型与行编码
    ├── errors.ts                      # PluginError 与错误归一
    ├── server.ts                      # 插件侧 runPluginServer / sendNotification
    ├── client.ts                      # daemon 侧 RpcClient（子进程 stdio 客户端）
    └── fs.ts                          # expandHome / 读 JSON / sha256File 等工具
```

### 2.2 插件（子进程，每 agent 一个）

```text
packages/sync-plugin-pi-agent/         # @pi-agent-hub/sync-plugin-pi-agent（kind=pi）
├── src/main.ts                        # JSON-RPC server 装配
├── src/plugin.ts                      # PiPlugin：list/read/deliver/import/exportNative
└── src/pi-rpc.ts                      # promptPiSession：pi --mode rpc 会话下发
├── package.json                       # piAgentHub 元数据（kind=pi、能力、权限、超时）

packages/sync-plugin-opencode/         # @pi-agent-hub/sync-plugin-opencode（kind=opencode）
├── src/main.ts                        # JSON-RPC server 装配
└── src/plugin.ts                      # OpencodePlugin：直读 SQLite V2；deliver/import 未接线
├── package.json                       # piAgentHub 元数据（readStrategy=storage,api）

packages/sync-plugin-dsh/              # @pi-agent-hub/sync-plugin-dsh（kind=dsh）
├── src/main.ts                        # JSON-RPC server 装配
└── src/plugin.ts                      # DshPlugin：直读 session.vN.jsonl(.zstd)；deliver/import 未接线
├── package.json                       # piAgentHub 元数据（readStrategy=storage,api）
```

### 2.3 sync-daemon（端侧守护进程）

```text
packages/sync-daemon/                  # @pi-agent-hub/sync-daemon
├── src/main.ts                        # CLI 入口（run [--config] [--once]）
├── src/config.ts                      # 配置加载与强校验
├── src/daemon.ts                      # Daemon：周期同步、SSE 事件分派、退出编排
├── src/hub-client.ts                  # HubClient：REST 请求 + SSE 解析/重连
├── src/plugin-manager.ts              # PluginManager：解析/动态安装/子进程/初始化/detect
├── src/control.ts                     # 本地控制 HTTP：status/pause/resume/sync-now/logs/quit
└── src/logger.ts                      # 结构化日志（stderr + 文件）
```

### 2.4 hub-service（中心服务）

```text
packages/hub-service/                  # @pi-agent-hub/hub-service
├── src/main.ts                        # 引导：加载配置 → createApp → listen
├── src/config.ts                      # hub-service.json/.yml 加载校验
├── src/app.ts                         # Express 应用：全部路由与中间件
├── src/auth.ts                        # 用户会话/Cookie、CSRF、token 哈希/匹配
├── src/db.ts                          # Store：node:sqlite 表与查询
├── src/session-store.ts               # SessionStore：hubSessionId、sync/merge、transcript、readEntry
└── src/sse.ts                         # SseHub：每主机一条 SSE、心跳、顶替
```

### 2.5 hub-console（前端）

```text
packages/hub-console/                  # @pi-agent-hub/hub-console（Vite + Vue 3 + Element Plus）
├── index.html                         # SPA 入口（/hub/ base）
├── vite.config.ts                     # base=/hub/、/api 代理到 8443
├── tsconfig.json
└── src/
    ├── main.ts                        # createApp + ElementPlus + router
    ├── router.ts                      # 路由：/login /sessions /sessions/:id /hosts
    ├── App.vue                        # 布局壳：页头菜单 + 登录/登出
    ├── api.ts                         # API 客户端：CSRF、登录、会话列表/详情/正文
    ├── styles.css                     # 全局样式
    └── views/
        ├── Login.vue                  # 登录页
        ├── Sessions.vue               # 会话列表
        ├── SessionDetail.vue          # 会话正文（markdown-it + DOMPurify）
        └── Hosts.vue                  # 主机列表
```

### 2.6 sync-daemon-tray（Tauri 托盘）

```text
packages/sync-daemon-tray/             # @pi-agent-hub/sync-daemon-tray
├── src-tauri/
│   ├── Cargo.toml                     # Rust 依赖（tauri v2 + tray-icon）
│   ├── tauri.conf.json                # 桌面配置（CSP、托盘、窗口）
│   ├── capabilities/default.json      # 权限：core:default
│   ├── icons/                         # 托盘/应用图标
│   └── src/
│       ├── main.rs                    # 入口
│       └── lib.rs                     # 托盘菜单、daemon 守护命令、配置读写命令
└── ui/                                # 静态 HTML 配置界面（无框架）
    ├── index.html
    ├── app.js                         # invoke 封装：start/stop/status/config
    └── style.css
```

---

## 3. 页面 / 路由清单（hub-console）

| 路径（/hub/ 下） | 组件文件 | 说明 |
|---|---|---|
| `/login` | `src/views/Login.vue` | 用户名/密码登录，取 CSRF token |
| `/sessions` | `src/views/Sessions.vue` | 会话列表（主机/agent/项目/标题/条目数/最后时间） |
| `/sessions/:id` | `src/views/SessionDetail.vue` | 会话正文渲染（分块、markdown 净化） |
| `/hosts` | `src/views/Hosts.vue` | 主机列表（token 名 / host 名 / labels） |
| 其他 | 404 → 由 hub-service 回退 `index.html` | SPA 兜底 |

---

## 4. HTTP API 路由清单（hub-service）

| 前缀 | 使用者 | 形态 | 入口处理（app.ts） |
|---|---|---|---|
| `POST /api/hub/auth/login` | console | JSON | 登录、写入 Cookie |
| `POST /api/hub/auth/logout` | console | JSON | 注销 |
| `GET /api/v1/meta` | daemon | JSON | 版本探测 |
| `POST /api/v1/sync/manifest` | daemon | JSON | 会话清单与水位 |
| `POST /api/v1/sync/sessions/:id` | daemon | JSON | 会话同步/合并 |
| `GET /api/v1/events` | daemon | SSE | 下行通道（deliver） |
| `POST /api/v1/deliveries/:id/ack` | daemon | JSON | 下发 ack |
| `POST /api/v1/deliveries/:id/result` | daemon | JSON | 下发结果 |
| `POST /api/v1/imports/:id/result` | daemon | JSON | 导入结果（占位） |
| `POST /api/v1/exports/:id/result` | daemon | JSON | 原生导出结果（占位） |
| `GET /api/hub/health` | 运维 | JSON | 健康检查 |
| `GET /api/hub/hosts` | console | JSON | 主机列表 |
| `GET /api/hub/tokens` | console | JSON | token（脱敏） |
| `GET /api/hub/agents` | console | JSON | agent 列表（当前空） |
| `GET /api/hub/sessions` | console | JSON | 会话列表 |
| `GET /api/hub/sessions/:id` | console | JSON | 会话元数据 |
| `GET /api/hub/sessions/:id/transcript` | console | JSON | 正文分页 |
| `GET /api/hub/sessions/:id/blocks/:seq/raw` | console | JSON | 块原文 |
| `GET /api/hub/search` | console | JSON | 搜索（LIKE/title 过滤） |
| `POST /api/hub/deliveries` | console | JSON | 发起下发（SSE 推 daemon） |
| `GET /api/hub/deliveries/:id` | console | JSON | 下发状态 |
| `POST /api/hub/imports` | console | JSON | 导入（501 未接线） |
| `POST /api/hub/reload` | console | JSON | 配置重载（提示重启） |
| `/`、`/hub/*` | 浏览器 | 静态 | hub-console 构建产物 |

---

## 5. 关键配置文件位置

| 文件 | 归属 | 用途 |
|---|---|---|
| `~/.pi-agent-hub/hub-service.json`（或 `.yml`） | hub-service | 用户/角色、daemon token、端口、数据目录 |
| `~/.pi-agent-hub/sync-daemon.json`（Win: `%USERPROFILE%\.pi-agent-hub\`） | sync-daemon | hub 地址/token、host 名、插件声明、agent 实例 |
| `examples/hub-service.json` / `examples/sync-daemon.json` | 本地开发 | 便于 `dev:*` 直接使用 |
| `deploy/docker-compose.yml` + `deploy/.env` | 部署 | Docker 编排与环境变量 |

> 环境变量：`HUB_CONFIG_FILE`、`PI_AGENT_HUB_HOME`、`PORT`、`HUB_CONSOLE_DIR`（hub-service）
> 位置见 `packages/hub-service/src/config.ts` 与 `src/main.ts`。

---

## 6. 数据文件布局（运行时）

```text
~/.pi-agent-hub/                       # 默认根（PI_AGENT_HUB_HOME 覆盖）
├── hub-service.json                   # hub 配置
├── hub.db                             # SQLite 索引/控制态（当前已实现）
├── agent/sessions/**                  # pi v3 JSONL 镜像（当前已实现，write 路径）
├── plugins/                           # daemon 动态安装插件根（默认）
├── .work/<kind>/                      # 插件大包/原生临时文件
├── daemon-control.json                # 本地控制 API 的 port+token（0600）
└── logs/sync-daemon.log               # daemon 日志
```
