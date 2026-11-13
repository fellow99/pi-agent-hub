# 005-sync-workspace Technical Plan（跨模块实现方案）

> Module: 005-sync-workspace（主设计）
> Corresponding spec: ./spec.md
> Last Updated: 2026-11-13
> 模块细化方案：105-service-sync-workspace/plan.md、201-console-sync-workspace/plan.md、401-sync-daemon-sync-workspace/plan.md

## 1. 技术上下文

- 运行时：Node ESM（≥22.19，本机 v24.8.0）；hub=Express 5 + node:sqlite；daemon=纯 Node + 子进程插件 JSON-RPC；
  console=Vue 3 + Element Plus + Vite。
- 复用的既有骨架（源码已核实）：
  - `hub-service/src/sse.ts`：`SseHub.send(hostId, event, data): boolean`（返回是否有在线连接），每 host 一条 SSE。
  - `hub-service/src/app.ts`：`/api/hub`（Cookie+CSRF，非 GET 仅 admin）与 `/api/v1`（Bearer，注入 `daemon` token 配置）
    双轨中间件；内存 `deliveries Map` 与 delivery ack/result 路由即本需求的同构范式。
  - `sync-daemon/src/daemon.ts`：`handleEvent` 分派 deliver/import/export_native；`syncAll` 已周期性
    `list_sessions` 取得每个会话 cwd（daemon 侧 cwd 集合的数据来源）。
  - `sync-daemon/src/hub-client.ts`：REST `request()` + SSE `connectEvents()` 帧解析。
  - `hub-console/src/api.ts`：CSRF 注入、401 跳登录的 `api<T>()`；`FileTreePanel.vue` 现为虚拟树数据源。
- 测试基线：vitest 2.1.8（根 devDependencies），hub-service 已有 `src/__tests__/` 两个测试文件；
  无 vitest 配置文件时默认匹配 `**/*.test.ts`。

## 2. Constitution 符合性

- ✅ 包边界：protocol 为唯一契约源，service/daemon/console 以 `workspace:*` 消费类型；daemon 不解析 agent 格式，
  cwd 集合仅取自既有 list_sessions 结果，不新增插件协议方法。
- ✅ API 前缀纪律：console `/api/hub/fs-requests*`（Cookie+CSRF），daemon `/api/v1/fs-requests/*`（Bearer）。
- ✅ 安全底线：非 GET 仅 admin；daemon token 绑定 host 防冒写；双层白名单 + realpath + 段边界匹配；全链路只读。
- ✅ 严格类型：禁用 as any/ts-ignore/空 catch；完成后 `pnpm typecheck` 全绿。
- ✅ 向后兼容：协议只增不改；配置字段可选；无 DB schema 变更；虚拟树接口保留。

## 3. 关键设计决策

### 3.1 异步轮询而非同步等待

与 deliveries 同构：hub 不挂起 HTTP，daemon 离线/慢/重连不占连接。console 1s 轮询，list_dir 30s /
read_file 60s 前端超时。SSE 下发失败直接 503 且不建记录，避免悬空态。

### 3.2 纯内存态机 + 惰性 TTL

新增 `hub-service/src/fs-request-store.ts`（不进 db.ts，因无持久化需求）：
- `Map<requestId, FsRequestRecord>`；读取时惰性判定：超过 60s 未终态 → `expired`；终态记录超 5 分钟 → 删除。
- 不设定时器（与设计文档 §6.1 一致），Map 容量安全：单请求体极小，正常轮询节奏下无内存膨胀风险；
  额外加软上限 `MAX_OPEN_RECORDS = 10000`，超出时淘汰最老非终态记录并记日志（防护性，不影响正常路径）。
- requestId 格式 `fsr_<uuid>`（randomUUID，与 `dlv_` 风格一致）。

### 3.3 第一道白名单的数据来源（hub 侧）

`sessions` 表已有全部已同步会话的 `host_id` + `cwd`。新增纯函数模块 `hub-service/src/fs-paths.ts`：
- `isPathWithin(path, root)`：`path.resolve` 折叠 + 分隔符归一 + Windows 盘符小写 + 段边界比较；
- `collectAllowedRoots(rows)`：按 host 取 cwd 去重；
- 判定：目标 path 等于某个 cwd 或位于其目录段下方即放行。
该模块同时承载 NUL 字符拒绝等纯逻辑，便于 vitest 全覆盖。

### 3.4 daemon 终判与 cwd 集合缓存

新增 `sync-daemon/src/fs-bridge.ts`（无外部依赖，node:fs/promises + node:path）：
- 配置加载（config.ts）校验 `fsAllowedDirs`：必须为字符串数组或 null；逐条 realpath 归一；
  盘根条目抛错终止启动（能力禁用而非整个 daemon 崩溃的取舍：**采取启动报错**，与设计「拒绝启动该能力」
  的严格解释一致——配置错误应显式暴露）。
- `null` 回退集合：Daemon 类维护 `knownCwds: Set<string>`，在每次 `syncAll()` 成功汇总 list_sessions 后刷新；
  fs-bridge 读取该快照判定，避免每个 FS 请求触发插件 RPC。
- readFile 防 symlink：`realpath` 后对白名单 realpath 集合再判一次。
- 分类/限额/ MIME 表集中为常量与纯函数 `classifyFile(name)`，可单测。

### 3.5 前端角色与轮询封装

- 登录响应已含 `role` 但当前未持久化：`api.ts login()` 增存 `localStorage` 键 `pi-agent-hub.role`，
  登出/401 清理；新增 `getRole()` 导出。
- `api.ts` 新增 `createFsRequest/pollFsRequest` 与便捷 `listDir/readFile`（内部 create→1s 轮询→终态/超时，
  接收 AbortSignal）。
- FileTreePanel 重写为 el-tree 懒加载（`lazy` + `load`），根节点手工构造成会话 cwd；目录结果 LRU（30 项）；
  文件查看器内联在同组件（保持现有两栏布局），按 type 分发渲染；viewer 显示权限空状态。

## 4. 分层实现方案

### 4.1 protocol（`packages/protocol/src/index.ts`，仅新增）

- 类型：`FsRequestKind`、`FsRequestState`、`FsErrorCode`（字符串字面量联合）、`CreateFsRequest`、
  `FsRequestRecord`、`DirEntry`、`DirListingResult`、`TextFileContent`、`BinaryFileContent`、
  `FileContentResult`（判别联合）、`FsResultPayload`、`FsRequestEvent`（SSE payload）。
- 常量：`FS_REQUEST_EVENT = "fs_request"`；扩展 `SyncDaemonConfig` 增 `fsAllowedDirs?: string[] | null`。
- 限额常量（daemon 与测试共用）：`FS_LIMITS = { textBytes: 1<<20, binaryBytes: 10<<20, maxDirEntries: 2000 }`。

### 4.2 hub-service

| 文件 | 改动 |
|---|---|
| `src/fs-paths.ts`（新） | normalize/段边界判定/root 收集/NUL 检查纯函数 |
| `src/fs-request-store.ts`（新） | 内存态机：create/get/ack/result、惰性 TTL、host 归属校验 |
| `src/app.ts` | 3 个路由：POST `/api/hub/fs-requests`、GET `/api/hub/fs-requests/:id`、POST `/api/v1/fs-requests/:id/ack`、POST `/api/v1/fs-requests/:id/result`；SSE 下发复用 SseHub |
| `src/__tests__/fs-paths.test.ts`（新） | 白名单边界/`..`/盘符大小写/NUL |
| `src/__tests__/fs-request-store.test.ts`（新） | 态机迁移、TTL expired、5min 清理、跨 host 拒绝 |

POST 发起处理顺序：参数校验(400) → host token 配置存在性(404 host_unknown) → cwd 白名单(403) →
`sse.send` 在线检查（false→503 不建记录）→ 建记录并下发 → 202。

### 4.3 sync-daemon

| 文件 | 改动 |
|---|---|
| `src/config.ts` | 校验 `fsAllowedDirs`（数组/null、字符串条目、盘根拒绝；realpath 归一失败处理） |
| `src/fs-bridge.ts`（新） | `FsBridge` 类：白名单终判、listDir/readFile、stat 分类限额、base64 data URL、错误码归一 |
| `src/daemon.ts` | `handleEvent` 增 `fs_request` 分支；维护 knownCwds 快照（syncAll 刷新）；ack→执行→result |
| `src/hub-client.ts` | `fsAck(requestId)` / `fsResult(requestId, payload)` |
| `src/__tests__/fs-bridge.test.ts`（新） | 用 os.tmpdir 造临时目录树：白名单/全禁/段边界/symlink 逃逸/分类/超限/类型错误 |

### 4.4 hub-console

| 文件 | 改动 |
|---|---|
| `src/api.ts` | role 持久化；FS 类型（从 protocol 镜像同形，console 不依赖 protocol 包的既有约定）、createFsRequest/pollFsRequest/listDir/readFile（含 AbortSignal + 超时） |
| `src/components/FileTreePanel.vue` | 重写：真实目录 el-tree 懒加载、LRU、文件查看器（text/image/video/pdf/错误态）、viewer 空状态、轮询取消 |
| （可选）`src/components/FileViewerPane.vue` | 若单文件过大则拆出查看器；默认内联 |

### 4.5 配置与部署

- `examples/sync-daemon.json` 与 `deploy/sync-daemon.json` 增 `fsAllowedDirs` 示例（本机调试值
  `["D:\\pi-workspace"]`；deploy 示例保持注释说明，不写死个人路径）。
- 不改 docker-compose/nginx（新路由仍走既有 `/api/` 反代，SSE 缓冲已关闭）。

## 5. 端到端联调方案

1. `pnpm install && pnpm build && pnpm typecheck` 基线全绿。
2. Docker：`docker compose -f deploy/docker-compose.yml up --build -d`（override 挂载既有数据集），
   控制台 http://localhost:12380/hub/。
3. 本机 daemon：`pnpm --filter @pi-agent-hub/sync-daemon dev -- run --config ./examples/sync-daemon.json`
   （插件本地路径、`pluginInstall:false`），采集 `~/.pi` 6 个真实会话上报，制造 cwd 白名单数据。
4. curl 链路：admin 登录拿 Cookie/CSRF → POST fs-requests（list_dir `D:\pi-workspace`）→ 轮询至 completed →
   与本机 `ls` 比对；再验 read_file 文本/图片、viewer 403、host_offline、denied_all、越界 403。
5. Playwright：登录 admin/viewer 分别走查右栏懒加载、文件渲染、错误态、超时与卸载取消，截图入 `logs/20261113-1/`。

## 6. 文件清单总览

| 包 | 新增 | 修改 |
|---|---|---|
| protocol | — | src/index.ts |
| hub-service | src/fs-paths.ts、src/fs-request-store.ts、__tests__/fs-paths.test.ts、__tests__/fs-request-store.test.ts | src/app.ts |
| sync-daemon | src/fs-bridge.ts、src/__tests__/fs-bridge.test.ts | src/config.ts、src/daemon.ts、src/hub-client.ts |
| hub-console | （可能 FileViewerPane.vue） | src/api.ts、src/components/FileTreePanel.vue |
| 配置 | — | examples/sync-daemon.json、deploy/sync-daemon.json |
| 规格 | 005/105/201/401 四目录各 spec/plan（005 另含 tasks/test-cases） | specs/README.md 索引 |

## 7. 风险与对策

| 风险 | 对策 |
|---|---|
| Windows 路径大小写/分隔符/中文路径 | fs-paths 与 fs-bridge 共用归一逻辑思路；用真实 `D:\pi-workspace` 与 tmpdir 中文目录双环境测试 |
| symlink 逃逸 | realpath 后二次白名单判定，单测构造 tmpdir 内 symlink 指向白名单外 |
| daemon 重启后 knownCwds 为空（null 回退） | 首次 syncAll 完成前请求被 denied 并给出明确 message；文档说明 fsAllowedDirs 显式配置为推荐方式 |
| 轮询堆积/组件泄漏 | AbortSignal + 清 timer，统一在 watch 清理与 onUnmounted 释放 |
| base64 大负载 | 10MB 上限 + 128MB express body 上限已核算；nginx client_max_body_size 16m 仅影响入口请求，
  FS 回传走 daemon→hub 内网不经宿主 nginx |
