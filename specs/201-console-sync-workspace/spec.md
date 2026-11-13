# 201-console-sync-workspace 功能规格（hub-console 部分）

> Module: 201-console-sync-workspace（项目目录同步：前端部分设计）
> 需求编号：005-sync-workspace（console 子需求）
> Status: In-progress
> Last Updated: 2026-11-13
> 关联：[005-sync-workspace/spec.md](../005-sync-workspace/spec.md)（主设计）、docs/005-工程目录同步.md §7、
> 既有 202-console-session-viewer（FileTreePanel 当前虚拟树实现）

## 1. 模块概述

### 1.1 目的

把右栏 `FileTreePanel.vue` 的数据源从会话推导虚拟树（`/sessions/:id/files`）切换为 FS Bridge 真实目录：
选中会话后以会话 `cwd` 为根懒加载主机真实目录，点击文件经 daemon 读取并按类型渲染；新增轮询封装、
角色权限空状态与请求生命周期管理。

### 1.2 范围

- 包含：`api.ts` FS 客户端与轮询封装、role 持久化、FileTreePanel 重写（懒加载树 + 多类型查看器 + 错误态）。
- 不包含：左栏会话树、主区 transcript、SubagentPanel（维持镜像数据不变）；虚拟树接口删除（保留）。

## 2. 用户故事

- 作为 admin，选中会话即在右栏看到其 cwd 的真实内容，逐级展开、点开文件只读查看，转圈→出内容交互顺畅。
- 作为 viewer，右栏文件 tab 看到「目录浏览需要管理员权限」空状态，界面不发出任何 FS 请求。
- 作为使用者，daemon 离线/白名单拒绝/文件超限等情况都有明确中文提示，切换会话后无后台请求堆积。

## 3. 功能需求

### 3.1 API 客户端（api.ts）

- FR-CFS-001: MUST 持久化登录角色：`login()` 响应的 `role` 存入 `localStorage`（键 `pi-agent-hub.role`），
  导出 `getRole(): "admin" | "viewer" | null`；登出与 401 跳登录时清除。
- FR-CFS-002: MUST 导出 FS 镜像类型（与 protocol 同形、console 本地声明，沿用既有 api.ts 不引 protocol 包的约定）：
  `FsRequestState`、`DirEntry`、`DirListingResult`、`FileContentResult`、`FsRequestRecord`。
- FR-CFS-003: MUST 实现 `createFsRequest(hostId, kind, path)`：POST `/api/hub/fs-requests`，
  返回 `{requestId}`；错误体透传（含 403/503 等 code，供界面区分提示）。
- FR-CFS-004: MUST 实现 `pollFsRequest(requestId, signal?)`：GET 轮询单次调用。
- FR-CFS-005: MUST 实现便捷封装 `listDir(hostId, path, signal?)` 与 `readFile(hostId, path, signal?)`：
  内部 create → 每 **1s** 轮询 → 终态返回；list_dir 整体超时 **30s**、read_file **60s**；
  超时抛错「主机响应超时」并停止轮询；收到 failed/expired 抛带 error.code 的错误；支持 AbortSignal 取消。

### 3.2 目录树（FileTreePanel.vue 重写）

- FR-CFS-006: 根节点 MUST 为当前会话 `cwd`（来自 `session.cwd`），hostId 取自 `session.hostId`；
  选中会话后自动对根发起 listDir；无会话时显示「请先选择会话」。
- FR-CFS-007: MUST 使用 el-tree 懒加载（`lazy` + `load(node, resolve)`）：目录节点展开时对其 path 调
  listDir，单级返回直接子项；**不做递归拉取**。
- FR-CFS-008: 已加载目录 MUST 做组件内 LRU 缓存（Map，上限 30，沿用现有 CACHE_LIMIT 风格），
  命中缓存不重复请求；切换会话时清空缓存与查看器状态。
- FR-CFS-009: 节点 MUST 展示真实 `isDir/size/mtimeMs`（目录 📁 / 文件 📄，文件显示可读体积），
  移除 touchedBy/confidence 等虚拟树字段；`truncated` 时节点区提示「子项过多，仅展示前 2000 项」。
- FR-CFS-010: 轮询/加载 MUST 可取消：组件卸载、切换会话、切换节点时 AbortController 中止在途请求与定时器，
  无悬空轮询（对应 TC-031/037）。

### 3.3 文件查看器

- FR-CFS-011: 点击文件 MUST 调 readFile 并按 `type` 渲染：
  - text：扩展名 `.md/.markdown` 用 `MdPreview`（md-editor-v3，与 BlockCard 同源）；其余文本用 `<pre>`
    复用现有代码块样式；头部显示路径与 size。
  - image：`<img :src="dataUrl">` 限宽自适应；video：`<video controls>`；pdf：`<iframe :src="dataUrl">`。
- FR-CFS-012: 错误态 MUST 明确提示并区分 code：`denied/denied_all/path_not_allowed`→「无访问权限」、
  `file_too_large`→「文件超过大小上限」、`binary_unsupported`→「不支持的二进制文件」、
  `host_offline`→「主机离线」、`expired`/超时→「主机响应超时，可重试」；用 el-alert/el-empty，不吞错。
- FR-CFS-013: 查看器 MUST 在切换会话/点击目录时清空内容；加载中 v-loading；dataUrl 大对象随切换可被 GC
  （不长期持有，仅缓存目录列表、不缓存文件内容）。

### 3.4 权限与衔接

- FR-CFS-014: viewer 角色下文件 tab MUST 渲染 el-empty 空状态「目录浏览需要管理员权限」，
  且不创建任何 FsRequest（网络面板零请求）；admin 才挂载懒加载树。
- FR-CFS-015: 与左栏衔接无需手输路径：会话节点的 cwd/hostId 直接作为根与目标主机；
  Viewer.vue 的 tab 结构（文件/子 agent）与 SubagentPanel 保持不变。

## 4. 关键实体（前端镜像类型）

| 实体 | 说明 |
|---|---|
| FsRequestRecord | 轮询响应：requestId/state/kind/result?/error? |
| DirListingResult | path/entries(DirEntry[])/truncated |
| FileContentResult | text{type:"text",content,size} 或 binary{type:image|video|pdf,mimeType,dataUrl,size} |
| 树节点视图模型 | {path,name,isDir,size?,mtimeMs?,loaded?}，由 DirEntry 加根节点合成 |

## 5. 验收场景

- **懒加载真实目录**：admin 选中 `D:\pi-workspace` 会话 → 根目录自动加载，展开 pi-agent-hub/packages
  逐级出现；与资源管理器内容一致；重复展开命中缓存。
- **文件查看**：README.md 走 markdown 预览；.ts 走 pre；图片直接显示；不支持类型显示对应提示。
- **viewer 隔离**：viewer 登录后右栏仅空状态，无网络 FS 请求。
- **生命周期**：快速切换会话后旧轮询全部中止；卸载组件无定时器告警与控制台错误。

## 6. 非功能需求

- 轮询间隔固定 1s；无递归、无全量拉取；文件内容不入 LRU（避免 dataUrl 内存膨胀）。
- 全部提示中文；错误不导致白屏，组件边界内消化。
- vue-tsc 严格类型零错误；不引入新依赖（md-editor-v3/element-plus 已具备）。

## 7. 依赖

- 上游 hub 路由（105）与 protocol DTO（T004）；既有 `api<T>()`（CSRF/401 处理）、MdPreview、el-tree/el-empty。
