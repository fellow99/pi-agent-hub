# 007-push-prompt Technical Plan（实现方案）

> Corresponding spec: ./spec.md · 下游模块：107-service-push-prompt / 207-console-push-prompt /
> 407-sync-daemon-push-prompt
> Last Updated: 2026-11-17

## 1. 技术上下文

- pi RPC prompt 能力已确认（`rpc-types.ts`）：`prompt {message, images?: ImageContent[]}`；
  `ImageContent = {type:"image", data: base64, mimeType}`；`get_state` 读 current model/thinkingLevel。
- 既有 scaffold：`app.ts` 有 `deliveries` 内存 Map + `POST /api/hub/deliveries` + `POST /api/v1/deliveries/:id/ack|result`
  （最小实现）；daemon `handleDeliver` 已路由到插件 `deliver`；插件 `promptPiSession` 已实现
  get_state→prompt→agent_settled（无 images/model）。
- DB：`node:sqlite`，`Store` 提供表访问；`deliveries` 表在 000 §5.6 有草案，需落地建表/迁移。
- 005/006 提供态机、错误体、SSE 下发、轮询的成熟范式；006 提供模型/思考深度数据源。

## 2. Constitution 符合性

- ✅ 复用双轨鉴权与错误体；force 走既有 admin 判定 + 审计。
- ✅ 严格类型：DTO 来自 protocol；图片落盘/下载为独立模块可测；无 as any。
- ✅ 最小改动：重构 deliveries 时保留 ack/result 端点路径兼容；新字段全可选。
- ✅ 安全：图片 mime 白名单、大小限额、Bearer 下载、目录随 delivery GC 清理；日志不记 message 正文/图片内容。

## 3. 模块设计

### 3.1 protocol（`packages/protocol/src/index.ts`）

```ts
export type DeliveryPolicy = "idle-only" | "force";
export interface DeliverImageUrl { mime: string; url: string; sha256: string; bytes: number; }
// DeliverRequest 扩展：
export interface DeliverRequest {
  deliveryId: string; instanceId: string; nativeId: string;
  message: string;
  images?: Array<{ mime: string; dataBase64?: string; path?: string }>;
  model?: { provider: string; modelId: string } | null;
  thinkingLevel?: string | null;
  policy?: DeliveryPolicy; force?: boolean;
}
// SSE 事件与 Record 扩展同 §3.1；新增 DELIVERY_IMAGE_LIMITS（单张 bytes / 张数 / 总 bytes）。
export const DELIVERY_IMAGE_LIMITS = { singleBytes: 10*1024*1024, maxCount: 10 } as const;
```

### 3.2 hub-service（`107`，本 plan 仅列要点）

- `src/deliveries.ts`（新增模块，取代 app.ts 内联 Map）：DB 持久化 + 内存辅助 + 态机迁移 + per-session
  队列 + pending 补齐 + 图片清单管理。
- `src/image-store.ts`（新增）：`saveImages(deliveryId, images[]): Promise<DeliverImageUrl[]>`
  （base64 解码 → 校验 mime/大小 → 落盘 `dataDir/deliveries/<id>/images/<i>` → sha256/bytes，
  返回 url 相对路径）；`deliveryImagesDir(deliveryId)`；GC 由 delivery 清理触发。
- `app.ts` 路由：
  - `POST /api/hub/deliveries`（扩展）：校验 → 图片落盘 → DB 建记录（queued）→ `sse.send(deliver, {...图片 url})`
    → 202（send 失败保持 queued 等待重投）；
  - `GET /api/hub/deliveries/:id`、`POST /api/hub/deliveries/:id/cancel`；
  - `GET /api/v1/deliveries/:deliveryId/images/:index`（Bearer + host 归属 + Range）；改造成
    **多事件重投**：ack 60s 超时 attempts++ 重投（最多 5）、result 10min 超时 expired；
    `GET /api/v1/deliveries?state=pending` 补齐。
- `express.json({ limit: "160mb" })` 提升 + 图片二次校验。

### 3.3 sync-daemon（`407`，本 plan 仅列要点）

- `src/daemon.ts` `handleDeliver` 扩展：同 session 串行锁（`Map<agentId+nativeId, Mutex>`）、本地幂等表
  （`dataDir/deliveries-done.json`，7 天）、空闲检查（pi：文件 mtime/`get_state`；非空闲且非 force →
  `conflict`）、下载图片到临时文件 → 插件 `deliver {model, thinkingLevel, images:[{mime,path}]}` →
  ack/result → 成功后触发该会话同步。
- `src/hub-client.ts`：`downloadDeliveryImage(deliveryId, index, destPath)`（Bearer + 校验 sha256）。

### 3.4 sync-plugin-*（`deliver` 扩展）

- **pi**：`promptPiSession` 扩展为 `deliver({ message, images, model, thinkingLevel })`：
  get_state →（model != 当前）set_model（失败 → model_not_found 且不发 prompt）→
  （thinkingLevel != 当前）set_thinking_level → prompt({message, images: ImageContent[]})→ agent_settled。
- **opencode**：ACP 优先（`opencode acp`）→ `session/prompt`；图片 `PromptInput` 文件附件（base64+mime）；
  模型先 `POST /api/session/{id}/model`（Model.Ref）；thinkingLevel → reasoning 开/关（⬜）。
- **dsh**：`session/prompt`（`PromptContentPart` text/image，image 内联 base64）；模型/思考深度先
  `session/selectModel`；mode=`queue`。

### 3.5 hub-console（`207`，本 plan 仅列要点）

- `ChatComposer.vue`：布局（工具行 + 图片预览 + textarea + 状态条），参考 pi-web `ChatInput`.
- `ModelSelector.vue`/`ThinkingLevelSelector.vue`（复用 006 数据源）。
- `api.ts`：sendDelivery/pollDelivery/cancelDelivery；发送后状态轮询 + 完成后调用 `getTranscript` 刷新。
- 会话切换清空 composer；图片本地校验（FileReader → base64 ≤10MB）。

## 4. 测试方案

- 单测：image-store（mime/大小/张数/落盘/sha256）、deliveries 态机与重投/cancel/串行、daemon 幂等/冲突、
  pi promptPiSession 扩展（set_model 失败不发 prompt）、console api。
- 集成：Docker hub + 本机 daemon + pi 插件：文本/多图/模型+思考深度发送全流程；三台 debian 测试机
  （.100 pi / .109 opencode / .112 dsh）deploy daemon + 插件后压测差异适配。

## 5. 任务分解计划

详见 `tasks.md`（Setup → protocol → hub-service → daemon → 插件 → console → 联调 → 三机部署）。
