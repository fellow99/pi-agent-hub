# 207-console-push-prompt Technical Plan（hub-console 实现方案）

> Corresponding spec: ./spec.md · 上游：007-push-prompt/plan.md · 依赖：006-sync-model-info（getModelInfo）
> Last Updated: 2026-11-17

## 1. 技术上下文

- 技术栈 Vue 3 + Element Plus（`@element-plus/icons-vue` 已用）；`TranscriptPane.vue` 现有 scrollEl/
  sortedItems/loadTail()。
- `api.ts` 现有 `api<T>()` 封装（自动注入 CSRF、401 跳登录）、`getRole()`（005 加了 role 持久化）、
  `getTranscript`。
- 006 提供 `getModelInfo(sessionId)`（30s 缓存）+ `ModelInfoResult` 类型；ImagePreview 参照 pi-web 思路用
  Element Plus `el-image` 预览实现。
- `/api/hub/deliveries` 服务端契约见 107。

## 2. Constitution 符合性

- ✅ viewer 禁用下发（只读语义）；force 二次确认 + 仅 admin 显示。
- ✅ 严格类型（本地镜像类型，不引 protocol 包）；无 as any。
- ✅ 不破坏只读查看：composer 独立组件，正文仍只读。

## 3. 模块设计

### 3.1 `src/api.ts`（新增）

```ts
export type DeliveryState = "queued" | "dispatched" | "accepted" | "running" | "completed" | "failed" | "expired" | "canceled";
export interface DeliverImageUrl { mime: string; url: string; sha256: string; bytes: number; }
export interface DeliveryRecord {
  deliveryId: string; state: DeliveryState; sessionId: string;
  error?: { code: string; message: string }; warnings?: string[];
}
export async function sendDelivery(payload: {
  sessionId: string; text: string;
  images?: { mime: string; dataBase64: string; name?: string }[];
  model?: { provider: string; modelId: string } | null;
  thinkingLevel?: string | null;
  policy?: "idle-only" | "force"; force?: boolean; idempotencyKey?: string;
}): Promise<{ deliveryId: string; state: DeliveryState }>;
export async function pollDelivery(deliveryId: string, signal?: AbortSignal): Promise<DeliveryRecord>;
export async function cancelDelivery(deliveryId: string): Promise<void>;
```

### 3.2 `src/components/ChatComposer.vue`（新增）

- props：`session: SessionSummary | null`；emit：`sent: []`。
- 模板结构（sticky 底部条）：
  1. 图片预览行（`el-image` 缩略图 + 每张移除按钮）；
  2. 工具行：图片按钮（`<input type=file multiple accept="image/png,image/jpeg,image/gif,image/webp,image/bmp" hidden>`
     + 触发 / 拖拽 drop）、`ModelSelector`、`ThinkingLevelSelector`、策略 `el-dropdown`（idle-only / force）；
  3. textarea（`el-input type=textarea :autosize`）；
  4. 发送按钮（`el-button type=primary :disabled`）+ 状态条。
- 逻辑：`readImagesToBase64(files)`（FileReader，本地 ≤10MB、≤10 张校验）；`send()` 校验后调
  `sendDelivery`（`idempotencyKey = crypto.randomUUID()`），随后 `pollDelivery` 1s 轮询至终态；
  completed → emit('sent') 且调用父 `loadTail()`。
- 权限：`getRole() !== "admin"` → 全禁用 + 提示。
- 会话切换：`watch(() => props.session?.id)` 清草稿；`onBeforeUnmount` 中止轮询。

### 3.3 `src/components/ModelSelector.vue` / `ThinkingLevelSelector.vue`（新增）

- `ModelSelector.vue`：props `{ models?: ModelInfoEntry[] | null; current?: {provider,modelId} | null; loading; error; disabled }`，
  emit `select(model | null)`；按 provider 分组（groupModelOptions 思路）；>8 项显示过滤 `el-input`；
  顶部「跟随会话当前」= null；current 高亮；error/agent_unsupported → 禁用态空文案。
- `ThinkingLevelSelector.vue`：props `{ levels?: string[] | null; current?: string | null; disabled }`，
  emit `select(level | null)`；顶部「跟随会话默认」= null；levels 为空 → 仅跟随项。
- 二者共享 006 `getModelInfo(sessionId)` 的 30s 缓存（组件内 ref 缓存）。

### 3.4 `src/components/TranscriptPane.vue`（接入）

- 模板末尾（`.transcript-scroll` 之外）加：
  `<ChatComposer :session="session" @sent="onComposerSent" />`；
- `onComposerSent()` → `loadTail()` 重新拉取尾部（.transcript-scroll.scrollTop = scrollHeight 定位到底部）。

## 4. 测试方案

- 组件单测（vitest + @vue/test-utils，首个：`__tests__/`）：图片本地校验、viewer 禁用、会话切换清空、
  sendDelivery 轮询状态迁移 mock。
- 集成（Playwright）：TC-010（文本全流程）、TC-011（多图）、TC-012（模型+思考深度）、TC-013（viewer/queued/force）。

## 5. 上游/下游

- 上游：006（getModelInfo）、TranscriptPane（loadTail）；下游：服务端 107（发起/轮询对端）。
