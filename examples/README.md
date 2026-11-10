# pi-agent-hub 本机联调示例（004-sync-session）

本目录提供**本机开发/联调**用的配置，打通「`~/.pi` 会话 → hub 镜像 → console 浏览」全流程。

> 部署用配置见 [`../deploy/`](../deploy/README.md)（Docker 三服务 + 合规）。

## 配置文件

| 文件 | 用途 |
|---|---|
| `hub-service.json` | hub 服务端（127.0.0.1:8443），含 admin/viewer 用户与 daemon token |
| `sync-daemon.json` | 设备端 daemon，采集本机 `~/.pi/agent` 会话并做 manifest/差分同步；含 pi/opencode/dsh 三插件 |
| `../packages/hub-console/` | 前端 SPA（`pnpm dev:console` 或由 hub 托管构建产物） |

## 快速启动（三窗口）

```bash
# 0) 安装与构建
pnpm install && pnpm build

# 1) hub-service（读取本示例配置，端口 8443）
HUB_CONFIG_FILE=./examples/hub-service.json pnpm dev:hub
#   → 同时托管已构建的 console：http://127.0.0.1:8443/hub/

# 2) hub-console（可选，Vite 热更，/api 代理到 8443）
pnpm dev:console
#   → http://127.0.0.1:5173/hub/（与上面二选一）

# 3) sync-daemon（持续同步 + SSE）
pnpm --filter @pi-agent-hub/sync-daemon dev -- run --config ./examples/sync-daemon.json
#   首次 --once 快速验证：在 run 后追加 --once
```

## 登录与访问

| 项 | 值 |
|---|---|
| console 地址 | `http://127.0.0.1:8443/hub/` |
| 管理员 | `admin` / `change-me` |
| 只读用户 | `viewer` / `change-me-too` |
| daemon token | `phk_dev_laptop_win`（hostName `laptop-win`） |

## 数据与水位

- 会话镜像落盘到 `~/.pi-agent-hub/agent/sessions/**/*.jsonl`（JSONL 为事实源），索引在 `~/.pi-agent-hub/hub.db`。
- daemon 每 30s 上报 manifest；新会话 `lastTimestamp=null`→full 同步，后续按 `since` 差分增量。
- opencode/dsh 插件在本机无对应数据时 `list_sessions` 失败只会记日志跳过，不影响整体同步（单点容错）。

## 排障

- 修改 `examples/hub-service.json` 认证后重启 hub（内存会话，重启需重新登录）。
- `pnpm --filter @pi-agent-hub/sync-daemon dev -- run --config ./examples/sync-daemon.json` 加 `--once`
  便于观察单轮 manifest→sync 日志。
