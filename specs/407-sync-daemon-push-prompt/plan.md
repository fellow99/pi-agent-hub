# 407-sync-daemon-push-prompt Technical Plan（sync-daemon 实现方案）

> Corresponding spec: ./spec.md · 上游：007-push-prompt/plan.md
> Last Updated: 2026-11-17

## 1. 技术上下文

- 现状 `handleDeliver`（`src/daemon.ts`）：ack → `runtime.client.request("deliver", {deliveryId, instanceId,
  nativeId, message, images:[], policy, force})` → deliveryResult。已透传 `images`（空数组），未下载图片、
  未带 model/thinkingLevel、无串行锁/幂等表、无空闲检查。
- `HubClient.request()` 已封装 Bearer；`this.manager.list()` 返回 AgentRuntime（kind 可判别。
- pi 会话路径通过插件 `list_sessions` 可查（nativeId → nativePath）；空闲判断用文件 mtime 或 `get_state`
  （pi RPC 已支持）。

## 2. Constitution 符合性

- ✅ 串行锁保证 C-1 单写者；幂等表落盘非密钥；conflict 不重试。
- ✅ 严格类型；图片临时文件归类（.work/<kind>/deliveries/…），不污染数据目录。
- ✅ 不做 agent 特判的「硬编码」：空闲/能力差异尽量收敛到插件能力声明与 warnings；pi 的 get_state 空闲
  判定作为 501 插件能力提供。

## 3. 模块设计

### 3.1 串行锁与幂等（`src/deliver-executor.ts`，新增，从 handleDeliver 抽取）

```ts
export class DeliverExecutor {
  private chains = new Map<string, Promise<void>>();
  private done = new Map<string, { result: unknown; at: number }>();  // 幂等表，<dataDir>/deliveries-done.json
  constructor(private deps: { dataDir: string; hub: HubClient; manager: AgentManager; logger: Logger }) {}
  async init(): Promise<void>;                                        // 加载幂等表
  execute(event: DeliverEvent): Promise<void>;                        // find runtime → ack → 幂等命中? → 串行链 → doDeliver
  private doDeliver(...): Promise<void>;                              // 空闲检查 → 下载图片 → client.request → result → 同步
  private snapshot(): Promise<void>;                                  // 幂等表落盘
}
```
- key = `agentId + "\0" + nativeId`；链式 `chains.set(key, (chains.get(key) ?? Promise.resolve()).then(run))`，
  完成后删除 key。
- 幂等：`done.has(deliveryId)` → 直接 `deliveryResult(deliveryId, {ok:true, result: cached.result})`。

### 3.2 `src/hub-client.ts`（新增图片下载）

```ts
async downloadDeliveryImage(deliveryId: string, index: number, destPath: string, sha256?: string): Promise<void> {
  const url = `/api/v1/deliveries/${encodeURIComponent(deliveryId)}/images/${index}`;
  await this.downloadToFile(url, destPath);   // 走 request 的 Bearer 头；校验 sha256（若给）
}
```

### 3.3 空闲/冲突判定（501 pi 插件能力 `check_idle`，MAY）

- daemon 调用插件 `check_idle({nativeId})`（pi：`get_state` 或文件 mtime 近 120s）；
  非空闲且非 `force` → `conflict`。opencode/dsh：插件提供 `check_idle` 或 daemon 回退「不拦截」+ warnings
  （⬜ 待真机验证）。为最小实现，首版 daemon 侧以 pi 文件 mtime 为本机判定，其它 kind 直接执行并标注。

### 3.4 触发同步

- result ok 后：`manifestOne(agentId)`（现有 syncAll 的单项简化版）→ 差分 → `POST /api/v1/sync/sessions/{id}`；
  失败不致命（下轮同步周期兜底），仅 warn。

## 4. 测试方案

- `__tests__/deliver-executor.test.ts`：串行（并发两条同 session 排队顺序执行）、幂等（命中→直接 result、
  磁盘加载）、冲突（mock check_idle 非空闲 → conflict 且 doDeliver 不执行）、图片下载失败 → agent_error。
- `__tests__/hub-client.test.ts`：downloadDeliveryImage URL/头/文件写入。

## 5. 上游/下游

- 上游：107-service-push-prompt（事件/图片 URL/result 对端）；下游：501/502/503 插件 `deliver` 扩展
  （`model`/`thinkingLevel`/`images` 接收）。
