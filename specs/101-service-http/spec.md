# 101-service-http 功能规格（Specification）

> Module: 101-service-http
> Status: Implemented (scaffold)
> Last Updated: 2026-11-10
> 源：`packages/hub-service/src/{app,auth,sse}.ts`

## 1. 模块概述

### 1.1 目的
hub-service 的 **HTTP 边缘层**：Express 应用（`app.ts`）、console 用户会话与 token 鉴权（`auth.ts`）、
SSE 下行通道（`sse.ts`）。对 daemon 提供 `/api/v1/*`，对 console 提供 `/api/hub/*` 与静态托管。

### 1.2 解决的问题
- 在单进程内同时服务 daemon REST/SSE、console API 与前端静态资源。
- 实现「分轨鉴权」：daemon 用 Bearer token、console 用 Cookie + CSRF + 角色。
- 提供每主机一条 SSE 的下行通道（含顶替与心跳）。

### 1.3 范围
- 包含：全部路由、中间件、鉴权、SSE、静态托管、错误处理。
- 不包含：镜像落盘/合并逻辑（见 102-service-storage）、配置加载（见 103-service-bootstrap）。

## 2. 用户故事
- 作为 daemon，我用 token 调用 `/api/v1/*` 完成 manifest/sync/ack/result 并保持 SSE。
- 作为 admin，我登录后能查看主机/会话并发起下发。
- 作为 viewer，我只能查看，写操作被拒（403）。

## 3. 功能需求

### 3.1 鉴权
- FR-101-001: `/api/v1/*` MUST 校验 `Authorization: Bearer`，未知/缺失 → 401 `token_unknown`。
- FR-101-002: daemon token MUST 支持明文或 `sha256:` 哈希匹配（`auth.hashToken`/`tokenMatches`）。
- FR-101-003: `/api/hub/*` MUST 校验 Cookie 会话，未登录 → 401 `unauthorized`。
- FR-101-004: 写请求 MUST 校验 `X-CSRF-Token`，失败 → 403 `csrf_failed`。
- FR-101-005: 非 GET 请求 MUST 要求 `admin` 角色，否则 403 `forbidden_role`。
- FR-101-006: 登录 MUST 校验用户（支持明文或 `scrypt$` 哈希），失败 → 401 `invalid_credentials`。

### 3.2 Daemon API
- FR-101-007: `GET /api/v1/meta` MUST 返回 apiVersion/minDaemonVersion/capabilities/limits。
- FR-101-008: `POST /api/v1/sync/manifest` MUST 按 (agentId,nativeId) 判断 new/ok/skipped 并返回水位。
- FR-101-009: `POST /api/v1/sync/sessions/:id` MUST 校验 `entry_before_since`（422）并委托合并（见 102）。
- FR-101-010: `GET /api/v1/events` MUST 返回 SSE 流（关缓冲头 + `retry:3000` + 注册 SseHub）。
- FR-101-011: `ack`/`result`（deliveries）、`result`（imports/exports）MUST 更新状态并返回 `{ok:true}`。

### 3.3 Console API
- FR-101-012: MUST 提供 `health`/`hosts`/`tokens`（脱敏）/`agents`/`sessions`/`sessions/:id`/`transcript`/`blocks/:seq/raw`/`search`。
- FR-101-013: `/api/hub/search` MUST 要求 `q`，空 → 400 `invalid_query`。
- FR-101-014: 发起下发 `/api/hub/deliveries` MUST 校验 session 存在并经 SSE 推送，返回 deliveryId/state。
- FR-101-015: `/api/hub/imports` MUST 返回 501 `not_implemented`（当前未接线）。

### 3.4 静态托管
- FR-101-016: 配置了 consoleDir 时 MUST 提供 `/`（redirect `/hub/`）与 `/hub`、`/hub/assets`、SPA 回退。

### 3.5 SSE
- FR-101-017: SseHub MUST 每主机仅 1 条连接，新连接顶替旧连接（旧流收 `event: reset`）。
- FR-101-018: 心跳注释 `: hb <ts>` 每 15s；`send` 指定 host 推送 `id/event/data`。

## 4. 关键实体
| 实体 | 说明 |
|---|---|
| ConsoleUser | username + role（admin/viewer），内存 Map 会话 |
| AuthedRequest | 携带 consoleUser 或 daemon 的 Express 请求 |
| SseHub.Client | hostId + Response |

## 5. 验收场景
### 场景：viewer 调写入被拒
- Given viewer 已登录且带正确 CSRF
- When 调 `POST /api/hub/deliveries`
- Then 403 `forbidden_role`。

### 场景：同主机 SSE 顶替
- Given 主机 A 已有 1 条活跃 SSE
- When A 再次连 `/api/v1/events`
- Then 旧连接收到 `event:reset reason:superseded` 后关闭。

### 场景：下发推送到 daemon
- Given 主机存在活跃 SSE 且会话存在
- When `POST /api/hub/deliveries`
- Then 返回 `dispatched`，daemon SSE 收到 `event:deliver`。

## 6. 非功能需求
- Express JSON body 限制 16mb；错误统一 `{error:{code,message}}`。
- Cookie：HttpOnly + SameSite=Lax；无 Secure（dev 环境，TLS 由反代）。

## 7. 假设与约束
- 会话存储是内存 Map（无持久化/过期清理）——较生产场景简化，属符合 scaffold 定位的已知简化。

## 8. 依赖
- 上游：`@pi-agent-hub/protocol`、`@pi-agent-hub/sync-plugin-sdk`（expandHome）。
- 下游：102-service-storage（SessionStore/Store）、103-service-bootstrap（createApp 入参）。
