# pi-agent-hub 部署指南（Docker Compose）

本目录提供 **pi-agent-hub 的 Docker 部署环境**，共三个服务：

| 服务 | 镜像 | 职责 | 数据 |
|---|---|---|---|
| `hub-service` | `node:24-alpine`（自建 Dockerfile） | Express + node:sqlite 中心服务：同步 API、SSE、控制台 API | `./data` → `/root/.pi-agent-hub` |
| `hub-console` | `nginx:latest`（编译阶段 `node:24-alpine`） | 托管 Vite( Vue3 ) 构建产物（`/hub/`） | 无 |
| `nginx` | `nginx:latest` | 对外反代：`/api/*`→hub-service，`/hub/*`→hub-console | 仅配置 |

## 目录结构

```text
deploy/
├── docker-compose.yml            # 编排（3 服务 + 自建网络）
├── .env                          # HUB_HTTP_PORT 对外端口
├── README.md                     # 本文
├── sync-daemon.json              # 设备端 daemon 示例（连对本部署 hub）
├── data/                         # 数据卷：./data -> /root/.pi-agent-hub
│   ├── hub-service.json          # hub 配置（注意修改默认口令/token）
│   └── hub.db / agent/ / logs/   # （运行时生成，不入库）
├── hub-service/
│   └── Dockerfile                # node:24-alpine
├── hub-console/
│   ├── Dockerfile                # 多阶段：node:24-alpine 编译 → nginx 托管
│   └── nginx.conf                # 静态服务器（SPA 回退）
└── nginx/
    └── nginx.conf                # 反向代理（含 SSE 缓冲设置）
```

## 快速开始

```bash
# 1. 准备配置（务必修改默认口令与 daemon token）
#    编辑 deploy/data/hub-service.json，替换 admin/viewer 密码与 daemonTokens 的 token

# 2. 构建并启动（构建上下文为仓库根，需能访问 npm registry）
docker compose -f deploy/docker-compose.yml up --build -d

# 3. 查看
#    console：http://<host>:8080/hub/
#    daemon 接入：hub.url = http://<host>:8080，hub.token = 你在配置里填的 token

# 4. 设备端采集（可选）：在每台要采集的机器上配置 deploy/sync-daemon.json 后启动
#    node packages/sync-daemon/dist/main.js run --config deploy/sync-daemon.json
#    （或按 004-sync-session 本地示例：pnpm dev:daemon -- --config ./examples/sync-daemon.json）

# 5. 停止
docker compose -f deploy/docker-compose.yml down
```

## 路由

| 路径 | 去向 | 说明 |
|---|---|---|
| `/` | 302 → `/hub/` | |
| `/hub/*` | hub-console（nginx 静态） | Vue3 SPA（base=/hub/） |
| `/api/v1/*` | hub-service:8443 | daemon 同步 REST + SSE |
| `/api/hub/*` | hub-service:8443 | console 控制台 API |

> **SSE**：`/api/v1/events` 已在前置 nginx 关闭响应缓冲/压缩（`proxy_buffering off`、
> `X-Accel-Buffering: no`、读超时 3600s），符合协议对反代的要求。

## 版本升级 / 重新构建

```bash
git -C .. pull                                # 拉取更新
docker compose -f deploy/docker-compose.yml build --pull
docker compose -f deploy/docker-compose.yml up -d
```

## 说明与注意

- **构建上下文**：两个 Dockerfile 都以仓库根（`..`）为构建上下文，以包含 pnpm workspace 与 `pnpm-lock.yaml`；
  需在具有 npm 网络的环境构建。
- **数据持久化**：会话镜像（`agent/`）、索引（`hub.db`）、日志（`logs/`）全部落在宿主机 `deploy/data/`；
  升级不丢数据。
- **安全**：默认配置含明文占位口令/token，首次部署必须修改；生产建议改用 `passwordHash`/`tokenHash`
  并置于 TLS 终止（反代）之后。
- **Hub 本机采集**：在 hub 所在主机另跑一个 `sync-daemon`，连 `http://127.0.0.1:8080` 即可采集本机会话。
