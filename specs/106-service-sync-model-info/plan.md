# 106-service-sync-model-info Technical Plan（hub-service 实现方案）

> Corresponding spec: ./spec.md · 上游：006-sync-model-info/plan.md
> Last Updated: 2026-11-17

## 1. 技术上下文

- Express 5 应用在 `src/app.ts` 的 `createApp()` 内装配；`/api/hub` 与 `/api/v1` 两轨中间件已注入
  `consoleUser` 与 `daemon`（DaemonTokenConfig，含 `name`=hostId）。
- 可复用：`SseHub.send(hostId,event,data):boolean`、`Store.getSession(id)`（SessionRow 含
  host_id/agent_id/native_id）、`randomUUID()`、005 `FsRequestStore` 的态机范式与 `app.ts` 5xx/错误体风格。
- 参考 005 `fs-payload.ts`（result 双形状校验）的实现位置与命名：新增 `model-info-allow.ts` 平行放置。

## 2. Constitution 符合性

- ✅ 复用双轨鉴权与错误体，不新增中间件豁免。
- ✅ 无 DB 变更、无持久化；内存态机生命周期自管。
- ✅ 严格类型：DTO 来自 protocol；脱敏为纯函数，无 as any。
- ✅ 只读转发 + 脱敏；本模块不发起任何 agent 侧调用。

## 3. 模块设计

### 3.1 `src/model-info-store.ts`（新增）

```ts
export class ModelInfoStore {
  createWithId(requestId: string, record: Omit<ModelInfoRequestRecord,"state"|"createdAt">): ModelInfoRequestRecord;
  get(id: string): ModelInfoRequestRecord | undefined;      // 惰性 expired/清理
  ack(id: string, hostId: string): "ok" | "not_found" | "host_mismatch";
  result(id: string, hostId: string, sanitized: { ok: true; result: ModelInfoResult }
    | { ok: false; error: { code: string; message: string } }): "ok" | "not_found" | "host_mismatch";
}
```
- 内部：`Map<string, ModelInfoRequestRecord>`；`get` 判定 expired/清理；软上限在 createWithId 淘汰最老
  非终态；ack/result 先 `record.hostId === hostId` 校验。

### 3.2 `src/model-info-allow.ts`（新增，纯函数）

```ts
export type SanitizedModelInfo = { ok: true; result: ModelInfoResult }
  | { ok: false; error: { code: "invalid_result"; message: string } };
export function sanitizeModelInfoResult(raw: unknown): SanitizedModelInfo;
export function sanitizeModelInfoEntry(raw: unknown): ModelInfoEntry | null;   // 内部辅助
```
- 实现：对象校验 + 白名单拷贝；任何结构不符 → `invalid_result`；字段级未知键丢弃。

### 3.3 `src/app.ts`（路由）

- console 轨（放在 `/api/hub/fs-requests` 附近）：
  - `POST /api/hub/model-info-requests` → 校验/解析/host/sse → 建态 202；
  - `GET /api/hub/model-info-requests/:id` → 404 / 200 全态 `{requestId,state,result?,error?}`。
- daemon 轨（放在 `/api/v1/fs-requests/:id/ack|result` 附近）：
  - `POST /api/v1/model-info-requests/:id/ack` → 200 `{ok:true}`；
  - `POST /api/v1/model-info-requests/:id/result` → 先 `sanitizeModelInfoResult(body?.result)`，
    按 `ok` → store.result → 200 `{ok:true}` / 失败 `{ok:false,error}`。

## 4. 测试方案

- `__tests__/model-info-store.test.ts`：迁移、TTL、终态清理、host_mismatch、软上限。
- `__tests__/model-info-allow.test.ts`：白名单投影、敏感字段丢弃、结构校验失败 → invalid_result、
  currentModel null 通过。

## 5. 上游/下游

- 上游：006-sync-model-info（数据契约/错误码）。
- 下游：406-sync-daemon-sync-model-info（SSE 事件与 ack/result 对端）、207-console（轮询消费）。
