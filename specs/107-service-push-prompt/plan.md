# 107-service-push-prompt Technical Plan（hub-service 实现方案）

> Corresponding spec: ./spec.md · 上游：007-push-prompt/plan.md
> Last Updated: 2026-11-17

## 1. 技术上下文

- 现状：`app.ts` 有 `const deliveries = new Map<string, {...}>()` + 3 个路由（POST /api/hub/deliveries、
  GET /api/hub/deliveries/:id、POST /api/v1/deliveries/:id/ack|result），无 DB 持久化。
- DB：`Store`（`src/db.ts`，node:sqlite）提供表访问；`deliveries` 表需建表/迁移（000 §5.6 草案）。
- `express.json` 当前 128mb；`randomUUID()` 已引入；`SseHub.send(hostId,event,data)` 可复用。
- `dataDir` 来自 config（`options.config.dataDir`），图片目录放 `<dataDir>/deliveries/`。

## 2. Constitution 符合性

- ✅ 复用双轨鉴权与错误体；force 走既有 admin + 审计（审计动作 `deliver.force`）。
- ✅ 严格类型（DTO 来自 protocol）；image-store/deliveries 为可测模块；无 as any。
- ✅ 兼容：ack/result 端点路径与方法不变，仅新增可选字段与重投语义。
- ✅ 安全：图片 mime 白名单 + 大小限额 + Bearer 下载 + GC 清理；日志不记 message 正文/图片 base64。

## 3. 模块设计

### 3.1 `src/image-store.ts`（新增）

```ts
export interface ImageStoreDeps { dataDir: string; }
export class ImageStore {
  constructor(private deps: ImageStoreDeps) {}
  deliveryDir(deliveryId: string): string;                 // <dataDir>/deliveries/<deliveryId>
  async saveImages(deliveryId: string, images: Array<{mime: string; dataBase64: string; name?: string}>):
    Promise<DeliverImageUrl[]>;                            // 校验+落盘+sha256/bytes+url
  async statImage(deliveryId: string, index: number): Promise<{size: number; mime: string} | null>;
  async readImage(deliveryId: string, index: number): Promise<Buffer>;
  async cleanupDelivery(deliveryId: string): Promise<void>; // GC 挂钩
}
```
- 校验常量：`DELIVERY_IMAGE_LIMITS = { singleBytes: 10*1024*1024, maxCount: 10, totalBytes: 32*1024*1024 }`（protocol 或本地镜像）。
- mime 只接受白名单；落盘用 `writeFile`（覆盖写），index 从 0 递增。

### 3.2 `src/deliveries.ts`（新增，DB 持久化 + 态机）

```ts
export type DeliveryDb = { row: unknown /* DeliveryRow */; };
export class Deliveries {
  constructor(private db: Store, private imageStore: ImageStore, private sse: SseHub) {}
  async create(req: CreateDeliveryInput): Promise<DeliveryRow>;       // 建 queued + SSE 下发
  async get(deliveryId): Promise<DeliveryRow | null>;
  async cancel(deliveryId): Promise<"ok" | "not_found" | "not_cancellable">;
  async ack(deliveryId, hostId): Promise<"ok"|"not_found"|"host_mismatch">;
  async result(deliveryId, hostId, body): Promise<"ok"|"not_found"|"host_mismatch">;
  async listPending(hostId): Promise<DeliveryRow[]>;                   // state=queued
  async reconcileExpired(): Promise<void>;                             // 惰性: 轮询时判定
  private async dispatch(deliveryId): Promise<boolean>;                // sse.send → dispatched / 保持 queued
}
```
- per-session 串行：`Map<sessionId, Promise<void>>` 链式 then 形成队列（无需真锁人）。
- 重投：ack 超 60s 且 attempt<5 → 更新 expiresAt=now+60s、attempt++、重新 `sse.send`；attempt≥5 → expired。

### 3.3 `src/app.ts`（路由调整）

- `POST /api/hub/deliveries`：校验（FR-107-001/002）→ `imageStore.saveImages` → `deliveries.create`
  （DB 记录 + SSE deliver，事件含图片 url）→ 202 `{deliveryId, state}`。
- `GET /api/hub/deliveries/:id`：`deliveries.get` → 404 / 200 全态。
- `POST /api/hub/deliveries/:id/cancel`：`deliveries.cancel` → 200 / 404。
- `GET /api/v1/deliveries`：`?state=pending` → `{items:[...], nextCursor:null}`。
- `GET /api/v1/deliveries/:deliveryId/images/:index`：Bearer + host 归属 → Range 支持 → mime 字节 /
  404 / 410 image_expired。
- `POST /api/v1/deliveries/:id/ack|result`：`deliveries.ack/result`；result 幂等。
- `express.json({ limit: "160mb" })`。

### 3.4 DB（db.ts / schema）

- 建表/迁移 `deliveries` 新增列（FR-107-005）；`idempotency_key` UNIQUE；`images_json` TEXT。

## 4. 测试方案

- `__tests__/image-store.test.ts`（tmpdir：mime/大小/张数/落盘/sha256/越界 index）。
- `__tests__/deliveries.test.ts`（mock db/sse：态机迁移、queued→dispatched、ack 超时 attempt++、cancel、
  串行队列、pending）。
- 路由集成由 Docker 联调覆盖（TC-010~013）。

## 5. 上游/下游

- 上游：007-push-prompt（契约/态机）；下游：407-sync-daemon-push-prompt（ack/result/图片下载对端）、
  207-console-push-prompt（发起/轮询消费）。
