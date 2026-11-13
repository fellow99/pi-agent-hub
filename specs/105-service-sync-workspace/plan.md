# 105-service-sync-workspace Technical Plan（hub-service 实现方案）

> Corresponding spec: ./spec.md · 上游：005-sync-workspace/plan.md
> Last Updated: 2026-11-13

## 1. 技术上下文

- Express 5 应用在 `src/app.ts` 的 `createApp()` 内装配；`/api/hub` 与 `/api/v1` 两轨中间件已分别注入
  `consoleUser` 与 `daemon`（DaemonTokenConfig，含 `name`=hostId）。
- 可直接复用：`SseHub.send(hostId,event,data):boolean`、`Store.listSessions()`（SessionRow 含 host_id/cwd）、
  `randomUUID()`（app.ts 已引入 node:crypto）、既有 deliveries Map 的路由范式。
- 路由注册位置：daemon 轨 ack/result 放在现有 `/api/v1/deliveries/:id/ack|result` 附近；
  console 轨发起/轮询放在 `/api/hub/deliveries` 路由附近，保持同类聚集。

## 2. Constitution 符合性

- ✅ 复用双轨鉴权与错误体 `{error:{code,message}}`，不新增中间件豁免。
- ✅ 无 DB 变更、无持久化；内存态机生命周期自管。
- ✅ 严格类型：DTO 全部来自 protocol；fs-paths/store 为可纯测模块，无 as any。
- ✅ 只读：本模块不产生任何主机 fs 操作，只做转发与态机。

## 3. 模块设计

### 3.1 `src/fs-paths.ts`（新增纯函数）

```ts
export function normalizeFsPath(input: string): string;   // 平台无关归一，见下；NUL 抛错
export function isPathWithin(path: string, root: string): boolean;  // 段边界
export function isAllowedByCwds(path: string, cwds: readonly string[]): boolean;
export function collectHostCwds(rows: readonly SessionRow[], hostId: string): string[];
```

**平台无关约束（关键）**：hub-service 运行在 Linux 容器，而会话 cwd 为主机 Windows 路径
（如 `D:\pi-workspace`）。因此**不能使用 node:path 的 `resolve/normalize`**（posix 语义会把 `D:\foo`
当成单段文件名），fs-paths 采用自实现的字符串级归一：
- 分隔符统一：`/` 与 `\` 全部替换为 `/`；连续分隔符合并；trim 尾部分隔符（盘根 `D:` 除外）。
- 盘符：匹配 `^[A-Za-z]:` 时盘符字母转小写。
- `.`/`..` 段折叠：按 `/` split 后用栈处理（`..` 弹栈、`.` 跳过），不触碰真实文件系统。
- 比较双方走同一归一；段边界判定 `target === root || target.startsWith(root + "/")`。
- NUL：`input.includes("\0")` 直接抛 Error，由路由转 400 invalid_request。
- 纯函数不访问 fs（realpath 是 daemon 侧职责；hub 只做字符串级第一道判定）。
- posix 风格路径（macOS/Linux 主机的 cwd）天然兼容：无盘符时折叠规则同样适用。

### 3.2 `src/fs-request-store.ts`（新增）

```ts
export class FsRequestStore {
  create(input: { hostId: string; kind: FsRequestKind; path: string }): FsRequestRecord;
  get(id: string): FsRequestRecord | undefined;                 // 内含惰性 TTL
  ack(id: string, hostId: string): "ok" | "not_found" | "host_mismatch";
  result(id: string, hostId: string, payload: FsResultPayload): "ok" | "not_found" | "host_mismatch";
}
```

- 时间注入：内部方法接受可选 `now: number`（默认 Date.now()），单测可推进虚拟时间，不依赖 fake timer。
- 常量：`FS_TTL_MS = 60_000`、`FS_RESULT_RETENTION_MS = 300_000`、`MAX_OPEN_RECORDS = 10_000`。
- 软上限淘汰：只统计非终态记录，超限时删 Map 中最老的非终态项（Map 迭代序=插入序）。
- 幂等：重复 ack 在 accepted/completed/failed 下返回 ok 不改状态；终态后 result 忽略。

### 3.3 app.ts 接线

新增实例（与 deliveries/sse 同作用域）：`const fsRequests = new FsRequestStore();`

四个路由的响应码与 code 严格按 spec FR-105-010~013。要点：
- 发起路由先做全部前置校验，最后一步才 `sse.send`；send 失败直接 503 返回，确保「不建记录」。
- 顺序细节：先建记录还是先 send？——**先 send 成功再 create**（send false 时无残留），create 后立即返回 202；
  理论上 send 与 create 之间 daemon 已回 ack 的竞态：Node 单线程内两个同步调用之间无 await，不存在交错。
- daemon result 路由需校验 body 形状（ok 布尔；ok:true 必须带 result，ok:false 必须带 error{code,message}），
  非法 → 400 invalid_request。
- 类型收窄用判别联合与显式 guard，不用 as any。

### 3.4 与既有代码的边界

- 不改 sse.ts（通用 send 已满足）、不改 db.ts（无表）、不改 auth.ts。
- deliveries 的内存 Map 维持现状，不借机抽象（最小改动原则）。

## 4. 文件清单

| 文件 | 动作 | 内容 |
|---|---|---|
| `packages/hub-service/src/fs-paths.ts` | 新增 | 白名单/归一纯函数 |
| `packages/hub-service/src/fs-request-store.ts` | 新增 | 内存态机 + TTL + 归属校验 |
| `packages/hub-service/src/app.ts` | 修改 | 实例化 store + 4 路由 |
| `packages/hub-service/src/__tests__/fs-paths.test.ts` | 新增 | TC-001~003 对应单测 |
| `packages/hub-service/src/__tests__/fs-request-store.test.ts` | 新增 | TC-004~008 对应单测 |

## 5. 测试方案

- vitest 同目录既有用法（describe/it/expect，无额外配置）。
- fs-paths：Windows 风格路径为主（CI 若为 posix 环境，resolve 语义差异用例聚焦归一/段边界逻辑本身，
  以字符串构造避免依赖平台根）；覆盖 `pi-workspace` vs `pi-workspace-evil`、`..`、盘符大小写、NUL。
- store：注入虚拟 now 验证 60s/5min 两个阈值与幂等/归属；不启动 Express。
- 路由级联调留集成阶段（TC-019~029）经 Docker + 真 daemon 验证。

## 6. 风险

| 风险 | 对策 |
|---|---|
| listSessions 全表扫描随发起频次放大 | 发起是低频人工操作；单测确认无 N+1；如后续成热点再加缓存，本期限不做 |
| 平台路径差异（容器内 Linux vs 会话 cwd 为 Windows 路径） | fs-paths 自实现字符串归一（分隔符/盘符/栈式 `..` 折叠），不调用 node:path、不访问 fs；
  用 Windows 与 posix 两类用例在 vitest 锁定行为 |
