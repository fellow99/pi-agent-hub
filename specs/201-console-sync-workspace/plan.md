# 201-console-sync-workspace Technical Plan（hub-console 实现方案）

> Corresponding spec: ./spec.md · 上游：005-sync-workspace/plan.md
> Last Updated: 2026-11-13

## 1. 技术上下文

- Vue 3 `<script setup>` + Element Plus + Vite；现有 `api.ts` 提供带 CSRF 与 401 跳转的 `api<T>()`，
  类型采用本地镜像声明（console 包不依赖 protocol workspace 包，见 package.json）。
- `FileTreePanel.vue` 当前消费 `getSessionFiles/getFileContent`（虚拟树），含会话级 LRU（Map，限 30）可借鉴。
- `Viewer.vue` 通过 `selectedSession`（SessionSummary，含 hostId/cwd）向 FileTreePanel 传 prop；
  `BlockCard.vue` 已有 MdPreview 引入范例（`md-editor-v3` + `lib/preview.css`）。
- 登录响应 `{username, role, csrfToken}` 已返回 role，但当前 login() 未保存。

## 2. Constitution 符合性

- ✅ 只读：仅 GET 轮询与一次 POST 发起，无任何写操作 UI。
- ✅ 严格类型：镜像 DTO 显式 interface，判别联合收窄 FileContentResult，不用 as any。
- ✅ 不新增依赖；markdown 仍走 md-editor-v3 内置净化（html:false 系默认安全姿态，与 BlockCard 一致）。
- ✅ 最小改动：Viewer/router 不动；虚拟树 API 函数保留（接口仍在），仅 FileTreePanel 切换数据源。

## 3. 模块设计

### 3.1 api.ts 增强

```ts
// role 持久化
const roleKey = "pi-agent-hub.role";
export function getRole(): "admin" | "viewer" | null;
// login() 内 setRole(result.role)；logout()/handleUnauthorized() 清除

// FS 镜像类型 + 客户端
export interface DirEntry { name: string; isDir: boolean; size: number; mtimeMs: number }
export interface DirListingResult { path: string; entries: DirEntry[]; truncated: boolean }
export type FileContentResult =
  | { type: "text"; path: string; content: string; size: number }
  | { type: "image" | "video" | "pdf"; path: string; mimeType: string; dataUrl: string; size: number };
export interface FsRequestRecord { requestId: string; state: FsRequestState; kind: string; result?: unknown; error?: { code: string; message: string } }

export async function createFsRequest(hostId: string, kind: FsRequestKind, path: string): Promise<{ requestId: string }>;
export async function pollFsRequest(requestId: string): Promise<FsRequestRecord>;
export async function listDir(hostId: string, path: string, signal?: AbortSignal): Promise<DirListingResult>;
export async function readFile(hostId: string, path: string, signal?: AbortSignal): Promise<FileContentResult>;
```

轮询封装要点（`waitFsResult` 内部函数）：
- create 后循环：`await sleep(1000, signal)` → poll；state 为 completed 时校验 result 形状并返回；
  failed/expired 抛 `Error(code)`（保留 code 属性供 UI 映射）；未知 id（404 not_found）视为终态错误抛出。
- 超时：起始记 `deadline = now + (kind==="list_dir" ? 30_000 : 60_000)`，轮询前检查。
- 取消：sleep 可被 AbortSignal 打断（reject 静默退出，不弹错误）；fetch 透传 signal（api() 的 RequestInit 已支持）。
- 503 host_offline 来自 create 阶段，直接抛错，不进入轮询。

### 3.2 FileTreePanel.vue 重写

组件状态：
```ts
const props = defineProps<{ session: SessionSummary | null }>();
const role = computed(() => getRole());
const dirCache = new Map<string, DirListingResult>();   // LRU 30，仅缓存目录列表
const treeData = ref<FsTreeNode[]>([]);                 // el-tree 数据
const currentFile = ref<{ path: string; loading: boolean; content: FileContentResult | null; error: string }>(...);
let abortController: AbortController | undefined;      // 会话级在途请求句柄
```

- 根节点：watch session.id（immediate）时重置状态，以 `{ path: session.cwd, name: session.cwd, isDir: true }`
  为根并触发首次 listDir；el-tree 用 `lazy + load`，根节点通过预置数据 + `loaded=false` 方式驱动首次 load，
  或手工加载根后把 entries 作为根的 children（实现时择一，保持 el-tree 受控）。
- load(node)：先查 dirCache；未命中则 `listDir(hostId, node.path, signal)`，映射 entries → 子节点
  （目录节点带 isLeaf:false），写 LRU；失败把错误上抛给 el-tree 的 reject 并在树区显示 el-alert。
- 节点点击：目录由 el-tree 展开处理；文件 → abort 旧 readFile → 新建 AbortController → readFile → 渲染。
- onUnmounted 与 watch 重置中统一 `abortController?.abort()` 并清 timer（timer 只存在于 api 层 promise 链，
  组件不自己 setInterval）。
- 权限：`role !== "admin"` 时整个树/查看器替换为 el-empty「目录浏览需要管理员权限」，不调任何 FS 函数。
- 体积展示：加 `formatSize(bytes)` 小工具；mtime 用 `new Date(mtimeMs).toLocaleString()`。

### 3.3 文件查看器分发

内联在 FileTreePanel 下半区（保持现有 file-viewer 两栏布局与样式类，减少 styles.css 改动）：
- v-if text：`.md` 判定 → `<MdPreview :modelValue="content.content" />`；否则 `<pre class="file-viewer__pre">`。
- image：`<img class="file-viewer__media" :src="dataUrl">`；video：`<video controls :src>`；
  pdf：`<iframe class="file-viewer__pdf" :src>`。
- 错误映射函数 `fsErrorMessage(code): string` 集中管理 FR-CFS-012 的 code→中文文案。

## 4. 文件清单

| 文件 | 动作 | 内容 |
|---|---|---|
| `packages/hub-console/src/api.ts` | 修改 | role 存取、FS 类型与 4 个函数、可中止 sleep/轮询 |
| `packages/hub-console/src/components/FileTreePanel.vue` | 重写 | 懒加载真实目录树 + 查看器 + 权限/错误/取消 |
| `packages/hub-console/src/styles.css` | 小幅修改（如需） | media/iframe 限宽样式，复用现有 file-viewer 类 |

不新增组件文件（查看器内联）；若重写后单文件超过 ~350 行再拆 `FileViewerPane.vue`（tasks T019 已预留）。

## 5. 测试方案

- 类型与构建：`vue-tsc --noEmit` + `vite build` 零错误。
- 手动/Playwright（TC-030~037）：Docker 栈 + 本机 daemon；重点验证懒加载网络请求形态
  （每目录一次 create+若干 poll）、viewer 零请求、切换会话后 Network 无新增轮询。
- 错误码映射用纯函数导出，便于在 Playwright 之外做轻量校验（不为前端单测引入新框架，保持仓库现状）。

## 6. 风险

| 风险 | 对策 |
|---|---|
| el-tree lazy 根节点加载时机 | 以手工加载根列表 + 子级 lazy 的混合方式；在 DEV_CHECKLIST 记录实测行为 |
| 轮询 promise 在组件销毁后 resolve 改状态 | 所有异步入口持 AbortSignal；abort 后直接 return，不写 ref |
| 大 dataUrl 渲染卡顿 | 不缓存文件内容；切换即释放；10MB 上限已在 daemon 侧保证 |
| role 被本地篡改提权 | 仅用于 UI 空状态；服务端 POST 仍强制 admin+CSRF（FR-105），纵深防御 |
