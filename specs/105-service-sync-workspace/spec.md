# 105-service-sync-workspace 功能规格（hub-service 部分）

> Module: 105-service-sync-workspace（项目目录同步：服务部分设计）
> 需求编号：005-sync-workspace（服务端子需求）
> Status: In-progress
> Last Updated: 2026-11-13
> 关联：[005-sync-workspace/spec.md](../005-sync-workspace/spec.md)（主设计）、docs/005-工程目录同步.md §3/§6/§8/§9

## 1. 模块概述

### 1.1 目的

在 hub-service 内实现 FS Bridge 的中心环节：console 请求鉴权与第一道 cwd 白名单、请求态机（纯内存）、
经既有 SseHub 向目标 host 下发 `fs_request`、接收 daemon 的 ack/result 并校验 host 归属、向 console 提供轮询。

### 1.2 范围

- 包含：2 个 console 路由 + 2 个 daemon 路由、`fs-request-store.ts` 态机、`fs-paths.ts` 白名单纯函数、
  SSE 事件下发、vitest 单测。
- 不包含：真实文件系统操作（daemon 侧 401）、前端渲染（201）、DB schema 变更（本需求无持久化）。

## 2. 用户故事

- 作为 admin，我 POST 发起 FS 请求后立即拿到 requestId，并通过 GET 轮询获得 completed/failed 结果。
- 作为 viewer，我的 POST 被既有非 GET admin 中间件拒绝（403），GET 轮询只读可用。
- 作为 hub，我只把请求下发给在线且配置存在的 host，并保证 daemon 回写不会跨 host 串记录。

## 3. 功能需求

### 3.1 路径白名单纯函数（fs-paths.ts）

- FR-105-001: MUST 提供平台无关的 `normalizeFsPath(p: string): string`（hub 运行于 Linux 容器、
  cwd 为主机 Windows 路径，**禁止 node:path.resolve**）：自实现字符串归一——`/` 与 `\\` 统一为 `/`、
  合并连续分隔符、Windows 盘符转小写、栈式折叠 `.`/`..`；含 NUL(`\0`) 抛 `invalid_request` 级错误。
- FR-105-002: MUST 提供 `isPathWithin(path, root): boolean`：段边界前缀匹配——
  归一后二者相等，或 path 以 `root + 分隔符` 开头；禁止字符串 includes。
- FR-105-003: MUST 提供 `isAllowedByCwds(path, cwds: string[]): boolean`：任一 cwd 命中即放行。
- FR-105-004: MUST 提供 `collectHostCwds(rows: SessionRow[], hostId: string): string[]`：
  从 sessions 行筛选 host 并对 cwd 去重（归一后比较，保留首个原文）。

### 3.2 请求态机（fs-request-store.ts）

- FR-105-005: MUST 维护 `Map<requestId, FsRequestRecord>`，记录字段与主 spec §4 实体一致
  （requestId/hostId/kind/path/state/createdAt/acceptedAt?/finishedAt?/result?/error?）。
- FR-105-006: `create(record)` MUST 生成 `fsr_<uuid>`；打开态记录超 `MAX_OPEN_RECORDS=10000` 时
  淘汰最老非终态记录（防护性软上限）。
- FR-105-007: `get(id)` MUST 惰性生命周期判定：
  - 非终态且 `now - createdAt > 60_000` → 置 `expired`、记 finishedAt；
  - 终态且 `now - finishedAt > 300_000` → 删除并返回 undefined；
  - 其余返回当前记录。
- FR-105-008: `ack(id, hostId)` MUST：记录不存在返回 `not_found`；hostId 不匹配返回 `host_mismatch`；
  仅 dispatched 可迁移 accepted（重复 ack 幂等成功，不回退状态）。
- FR-105-009: `result(id, hostId, payload)` MUST：归属校验同 ack；按 `payload.ok` 迁移
  completed（存 result）/failed（存 error），记 finishedAt；终态后重复 result 幂等忽略。

### 3.3 HTTP 路由（app.ts）

- FR-105-010: `POST /api/hub/fs-requests`（admin+CSRF 由既有中间件保证）处理顺序与错误码：
  1. body 校验：hostId/kind/path 类型与 kind 枚举，非法 → 400 `invalid_request`；
  2. host 存在性：`daemonTokens` 中无同名 name → 404 `host_unknown`；
  3. 白名单：`store.listSessions()` 取该 host cwd 集合，`isAllowedByCwds` 失败 → 403 `path_not_allowed`；
  4. 在线性：`sse.send(hostId, FS_REQUEST_EVENT, payload)` 返回 false → 503 `host_offline`，**不建记录**；
  5. 通过后 create 记录并返回 **202** `{requestId, state:"dispatched"}`。
- FR-105-011: `GET /api/hub/fs-requests/:requestId`：store.get 命中 → 200 返回完整记录
  （failed/expired 均 200，错误在体内）；未命中 → 404 `not_found`。GET 不限制角色。
- FR-105-012: `POST /api/v1/fs-requests/:requestId/ack`：从 `req.daemon.name` 取 hostId 调 store.ack；
  记录不存在或 host 不匹配均返回 **404 `not_found`**（不向陌生 host 泄露 id 是否存在）；成功 200 `{ok:true}`。
- FR-105-013: `POST /api/v1/fs-requests/:requestId/result`：同样 host 归属校验；
  body 为 `FsResultPayload`；成功 200 `{ok:true}`；非法 body → 400 `invalid_request`。
- FR-105-014: 路由 MUST 复用既有双轨中间件，不新增鉴权豁免；响应错误体统一 `{error:{code,message}}`。

### 3.4 SSE 下发

- FR-105-015: 下发 payload MUST 为 `{requestId, kind, path}`（FsRequestEvent），事件名取自 protocol
  常量 `FS_REQUEST_EVENT`，不在 app.ts 写字面量。

## 4. 关键实体

| 实体 | 说明 |
|---|---|
| FsRequestRecord | 见 protocol 定义；hub 侧态机记录，不持久化 |
| HostCwdSet | 由 sessions 表 host_id/cwd 派生的归一化白名单 |

## 5. 验收场景

- **正常链路**：admin 发起 list_dir → 202 dispatched；daemon ack → 轮询 accepted；result ok → completed 含 entries。
- **离线**：daemon 断开时发起 → 503 host_offline，store 中无该 id（随后 GET 404）。
- **串写防护**：host B token ack/result host A 的 id → 404 且 A 记录状态不变。
- **TTL**：构造 61s 前记录，GET → expired；再推进 5min → 404。

## 6. 非功能需求

- 纯内存、同步 Map 操作（Node 单线程无竞态）；轮询接口不得触达 DB 重查询（记录内自带结果）。
- 白名单收集每次发起时从 `store.listSessions()` 派生（会话量级 ≤5000，可接受；必要时复用调用点已取行）。
- 错误 message 不拼接敏感配置（token 等）；日志只记 requestId/hostId/kind/错误码。
- 严格类型与既有代码风格（无 as any、错误处理显式）。

## 7. 依赖

- `@pi-agent-hub/protocol`（FS DTO/常量，T004 先行）、既有 `Store`（db.ts）、`SseHub`（sse.ts）、
  Express 双轨中间件。测试依赖 vitest。
