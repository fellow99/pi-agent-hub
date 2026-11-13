# 005-sync-workspace 功能规格（Specification）

> Module: 005-sync-workspace（项目目录同步 · FS Bridge 主设计）
> 需求编号：005-sync-workspace · 需求名称：项目目录同步
> Status: In-progress（设计待评审 → 本规格落地实现）
> Last Updated: 2026-11-13
> 关联文档：[docs/005-工程目录同步.md](../../docs/005-工程目录同步.md)（v0.1 设计源头）、docs/001-协议规范.md、
> 模块规格 105-service-sync-workspace / 201-console-sync-workspace / 401-sync-daemon-sync-workspace

## 1. 模块概述

### 1.1 目的

新增一条由主机上的 **sync-daemon 实际执行 `readdir`/`stat`/`readFile`** 的数据链路，让 hub-console
浏览**主机真实工程目录**并读取受限文件内容，取代 202 右栏从会话工具调用推导的虚拟文件树
（虚拟树接口保留不删，见 §8 兼容性）。

```text
hub-console（发起 + 1s 轮询）
  => POST /api/hub/fs-requests        hub-service：admin+CSRF 鉴权、第一道 cwd 白名单、建态、SSE 下发
  => SSE event: fs_request            sync-daemon：fsAllowedDirs 终判、readdir/stat/readFile、分类限额
  => POST /api/v1/fs-requests/:id/ack|result   daemon Bearer 回传
  => GET /api/hub/fs-requests/:id     console 轮询取终态结果并渲染
```

### 1.2 解决的问题

202 右栏虚拟文件树从 Read/Write/Edit/Bash 工具调用推导，实测 `D:\pi-workspace` 某 146 路径会话中
Bash 低置信提取产生 109 条噪音路径；虚拟视图既不完整（未触碰文件不出现）也不反映当前是否存在。
FS Bridge 以主机真实文件系统为唯一事实源，修复「文件树与真实目录对不上」的问题。

### 1.3 范围

- 包含：
  - protocol 新增 FS 请求 DTO、状态枚举、错误码联合、SSE 事件名；
  - hub-service 发起/轮询/ack/result 路由、纯内存请求态机与 TTL、会话 cwd 第一道白名单、SSE 下发；
  - sync-daemon `fsAllowedDirs` 配置与校验、`fs-bridge.ts`（白名单终判 + readdir/stat/readFile +
    分类限额 + base64）、SSE `fs_request` 分支与 HubClient 回传方法；
  - hub-console API 客户端与轮询封装、FileTreePanel 真实目录懒加载、多类型文件查看器、viewer 权限空状态；
  - vitest 单元测试与 Docker + 本机 daemon + Playwright 集成验证。
- 不包含（非目标，沿用设计文档 §1.3）：
  - 目录递归一次性拉取（仅单级懒加载）；
  - 任何写/删/改/上传/执行能力（全链路只读）；
  - 目录变更监听（watch）与主动推送；
  - 会话镜像虚拟文件树接口的删除（保留作历史取证/无 daemon 场景回退）。

## 2. 用户故事

- 作为 **admin 用户**，我在会话查看器选中某会话后，右栏自动以该会话 `cwd` 为根列出主机真实目录，
  逐级懒加载展开子目录、点击文件查看文本/图片/PDF 内容（只读）。
- 作为 **viewer 用户**，我在右栏看到「目录浏览需要管理员权限」空状态，不发起任何 FS 请求；
  若直接调用发起接口，hub 返回 403 `forbidden_role`。
- 作为 **hub-service**，我对每个 FS 请求先做会话 cwd 白名单校验与 host 在线检查，再经 SSE 下发，
  并以纯内存态机跟踪 dispatched→accepted→completed/failed/expired，供 console 轮询。
- 作为 **sync-daemon**，我独立按本机 `fsAllowedDirs` 做终判（即使 hub 被绕过也拒绝越界），
  执行单级 readdir 与分类限额 readFile，把结果或标准化错误码回传 hub。
- 作为 **运维者**，daemon 离线时 console 发起请求立即收到 503 `host_offline` 而无悬空记录；
  daemon 恢复后链路自动可用，无需重启 hub。

## 3. 功能需求（跨模块总纲，模块级 FR 见各模块 spec）

### 3.1 协议契约（protocol 包，FR-005-001~003）

- FR-005-001: MUST 新增 FS 请求状态枚举 `FsRequestState = "dispatched" | "accepted" | "completed" | "failed" | "expired"`
  与请求类型 `FsRequestKind = "list_dir" | "read_file"`。
- FR-005-002: MUST 新增 DTO：`CreateFsRequest`（hostId/kind/path）、`FsRequestRecord`（态机记录）、
  `DirListingResult`（path/entries[]/truncated）、`DirEntry`（name/isDir/size/mtimeMs）、
  `FileContentResult`（text 与二进制 dataUrl 判别联合）、`FsError`（code/message）、
  daemon 回传体 `FsResultPayload`（ok + result|error）。
- FR-005-003: MUST 新增 SSE 事件名常量 `FS_REQUEST_EVENT = "fs_request"` 与 FS 错误码联合类型
  `FsErrorCode`（§7 总表），不改既有类型字段。

### 3.2 链路与状态机（FR-005-004~007）

- FR-005-004: 通信模式 MUST 为异步轮询：console 发起得 202 `{requestId, state:"dispatched"}`，
  以 1s 间隔轮询 `GET /api/hub/fs-requests/:id` 直到终态；hub 不挂起 HTTP 请求。
- FR-005-005: 态机 MUST 为 `dispatched →（ack）accepted →（result ok）completed |（result !ok）failed`；
  自建记录起 60s 未达终态，轮询命中时惰性置 `expired`（无后台定时器）。
- FR-005-006: 终态记录（completed/failed/expired）MUST 在内存保留 5 分钟供轮询，之后惰性删除；
  未知/已清理 requestId 返回 404 `not_found`。纯内存 Map，hub 重启即失，前端按 not_found 重新发起。
- FR-005-007: daemon 回传 ack/result 时 hub MUST 校验 token 绑定 host 与记录 hostId 一致，
  跨 host 冒写拒绝（403/404，不落他人记录）。

### 3.3 双层白名单与路径安全（FR-005-008~011，核心）

- FR-005-008: 第一道（hub-service）：请求 `path` MUST 落在该 host **已知会话 cwd 集合**之内
  （按路径段边界），否则 403 `path_not_allowed` 且不下发。
- FR-005-009: 第二道（sync-daemon 终判）：按本机配置 `fsAllowedDirs` 判定，daemon 拥有最终否决权。
  - 显式数组：条目经 realpath 归一；`[]` 表示全禁（`denied_all`）；盘根条目（`D:\`、`/`）配置加载期报错；
  - `null`/缺省：回退「本 host 已知项目目录」规则——daemon 汇总各插件 list_sessions 的 cwd 去重集合
    （允许缓存并在每同步周期刷新），不在集合内拒绝（`denied`）。
- FR-005-010: 路径判定 MUST：折叠 `.`/`..`（hub 侧为平台无关的字符串栈式折叠，因 hub 运行于 Linux 容器
  而 cwd 为主机 Windows 路径，禁止直接用 node:path.resolve；daemon 侧在主机本机可用 path.resolve）；
  统一分隔符；Windows 盘符小写比较；按路径段边界前缀匹配（禁止字符串 includes，
  防 `D:\pi-workspace-evil` 误匹配）；拒绝含 NUL(`\0`) 路径。
- FR-005-011: 符号链接防护：readFile 前对 `fs.realpath` 真实路径再做一次白名单判定，
  拦截 symlink 逃逸；白名单条目在配置加载时 realpath 归一，比较双方均用真实路径。

### 3.4 文件分类与限额（FR-005-012~014）

- FR-005-012: daemon MUST 先 `stat` 取大小/类型再决定读取方式，分类表：

  | 类别 | 扩展名（小写） | 上限 | 处理 |
  |---|---|---|---|
  | 文本 | .ts .tsx .js .jsx .mjs .cjs .vue .json .json5 .md .txt .css .scss .html .xml .yaml .yml .ini .conf .sh .bat .ps1 .sql .csv .log .ets（去重） | 1 MB | UTF-8 原文，解码失败 `text_decode_failed` |
  | 图片 | .png .jpg .jpeg .gif .webp .svg .bmp .ico | 10 MB | base64 data URL + MIME |
  | 视频 | .mp4 .webm .mov .m4v | 10 MB | base64 data URL |
  | PDF | .pdf | 10 MB | base64 data URL（application/pdf） |
  | 其它 | 不在白名单 | — | 不读取，`binary_unsupported` |

- FR-005-013: list_dir MUST 仅返回直接子项（单级），目录在前文件在后、各自按名称排序；
  子项数超上限（**MAX_DIR_ENTRIES = 2000**，与既有 MAX_FILE_PATHS 同量级）置 `truncated=true`。
- FR-005-014: 超限返回 `file_too_large`（message 带实际/上限字节）；路径不存在 `not_found`；
  list_dir 目标非目录 `not_a_directory`；read_file 目标是目录 `not_a_file`；其它 fs 异常 `daemon_error`。
  base64 膨胀 4/3 后 10MB ≈ 13.3MB，低于既有 `express.json({limit:"128mb"})`，无需调整。

### 3.5 前端行为（FR-005-015~018，细化见 201 模块 spec）

- FR-005-015: FileTreePanel 数据源 MUST 从 `/sessions/:id/files` 切换为 FS Bridge：根节点=会话 `cwd`，
  首次进入自动 listDir；el-tree 懒加载，已加载目录组件内 LRU 缓存（沿用 30 项上限）；hostId 取自会话。
- FR-005-016: 文件查看器 MUST 按 type 渲染：text→MdPreview(markdown)/`<pre>`；image→`<img>`；
  video→`<video controls>`；pdf→`<iframe>`；错误态用 el-empty/el-alert 明确提示。
- FR-005-017: 轮询间隔 1s；前端整体超时 list_dir 30s、read_file 60s，超时停止轮询并提示
  「主机响应超时」；组件卸载/切换目录用 AbortController + 清 timer 取消轮询。
- FR-005-018: viewer 角色下右栏目录区 MUST 显示「目录浏览需要管理员权限」空状态且不发起请求
  （角色信息取自登录响应，本地持久化）。SubagentPanel 维持会话镜像数据不变。

## 4. 关键实体

| 实体 | 说明 | 定义位置 |
|---|---|---|
| FsRequestRecord | 纯内存请求态机记录：requestId/hostId/kind/path/state/时间戳/result/error | protocol + hub-service `fs-request-store.ts` |
| DirEntry | 单级目录项：name/isDir/size/mtimeMs | protocol |
| DirListingResult | list_dir 结果：path/entries[]/truncated | protocol |
| FileContentResult | read_file 判别联合：text{content,size} / binary{type,mimeType,dataUrl,size} | protocol |
| FsAllowedDirs | daemon 配置项 `string[] | null`：终判白名单（[]全禁，null 回退 cwd 集合） | SyncDaemonConfig 扩展 |
| KnownCwdSet | hub 侧由 sessions 表派生、daemon 侧由插件 list_sessions 汇总的 cwd 集合 | 两侧各自派生 |

## 5. 鉴权与权限矩阵

| 动作 | console admin | console viewer | daemon（Bearer） |
|---|---|---|---|
| `POST /api/hub/fs-requests`（发起） | ✅ | ❌ 403 `forbidden_role` | — |
| `GET /api/hub/fs-requests/:id`（轮询，只读） | ✅ | ✅（GET 不限制角色；仅能查已知 id） | — |
| SSE 接收 `fs_request` | — | — | ✅（按 token 绑定 host） |
| `POST /api/v1/fs-requests/:id/ack\|result` | — | — | ✅（校验 host 归属） |

发起为 POST，严格复用既有「非 GET 仅 admin + CSRF」中间件（app.ts `/api/hub` use），不新增豁免。

## 6. 验收场景

### 场景 1：admin 浏览真实工程目录
- Given Docker 栈 hub 在线、本机 daemon 与 host `laptop-win` 建立 SSE，且某会话 cwd=`D:\pi-workspace`
- When admin 选中该会话，右栏自动发起 list_dir 并逐级展开 `pi-agent-hub/packages`
- Then 目录项与本机 `ls` 一致（目录在前、含 size/mtime），虚拟树噪音路径问题消失；点击 README.md 渲染文本。

### 场景 2：viewer 权限隔离
- Given viewer 登录
- When 进入查看器右栏
- Then 显示管理员权限空状态、无 FS 请求发出；手工 curl POST 发起得 403 `forbidden_role`。

### 场景 3：双层白名单拦截
- Given daemon 配置 `fsAllowedDirs:[]`
- When hub 第一道放行（path 在 cwd 内）并下发 list_dir
- Then daemon 回传 ok:false / `denied_all`，hub 态机置 failed，前端明确提示；主机无任何 fs 读取发生。
- 另：对 `D:\pi-workspace-evil` 这类段边界外路径，hub 第一道即 403 `path_not_allowed`。

### 场景 4：daemon 离线与恢复
- Given 目标 host 无 SSE 连接
- When admin 发起请求
- Then 立即 503 `host_offline`，hub 不建请求记录；daemon 重连后再次发起正常完成。

### 场景 5：大文件与二进制
- When 读取 12MB 图片 / 无扩展名二进制 / 含 symlink 逃逸的路径
- Then 分别得到 `file_too_large`（带字节数）、`binary_unsupported`、`denied`，均不返回文件内容。

### 场景 6：TTL 与重启
- When 请求下发后 daemon 60s 不回传，console 持续轮询
- Then hub 在命中轮询时置 `expired`；hub 重启后旧 requestId 轮询得 404 `not_found`，前端可重新发起。

## 7. 错误码总表（FsErrorCode）

| code | 产生方 | 含义 |
|---|---|---|
| `forbidden_role` / `csrf_failed` | hub | console 权限/CSRF（复用既有） |
| `host_unknown` | hub | hostId 无 daemon token 配置 |
| `host_offline` | hub | 目标 host 无 SSE 连接，未下发、不建记录 |
| `path_not_allowed` | hub | 第一道白名单（会话 cwd）拒绝 |
| `invalid_request` | hub | 参数非法（path 非字符串/空、kind 非法） |
| `not_found` | hub/daemon | requestId 已清理 / 路径不存在 |
| `denied` | daemon | 第二道白名单拒绝（含 symlink 逃逸） |
| `denied_all` | daemon | `fsAllowedDirs=[]` 显式全禁 |
| `not_a_directory` / `not_a_file` | daemon | 类型不符 |
| `file_too_large` | daemon | 超类别大小上限 |
| `binary_unsupported` | daemon | 不支持的二进制类型 |
| `text_decode_failed` | daemon | 文本 UTF-8 解码失败 |
| `expired` | hub | 60s TTL 到期 |
| `daemon_error` | daemon | 其它 fs 异常（message 带原始错误，不额外泄露敏感信息） |

## 8. 非功能需求与兼容性

- **只读**：全链路不暴露任何写/删/执行接口；daemon fs-bridge 仅调用 readdir/stat/readFile/realpath。
- **无 schema 变更**：请求态纯内存，不新增 SQLite 表与持久化。
- **向后兼容**：`fsAllowedDirs` 为可选字段，老配置缺省即回退 cwd 集合规则；协议只新增类型不改既有字段；
  `/api/hub/sessions/:id/files` 等虚拟树接口保留。
- **性能**：单级 list_dir 上限 2000 项；轮询为轻量内存 Map 查询；10MB 文件 base64 后仍低于 128MB body 上限。
- **质量门禁**：`pnpm typecheck` 零新增错误、`pnpm test` 全绿、无 `as any`/`@ts-ignore`/空 catch。
- **回归**：既有 deliveries/import/export SSE 链路不受新事件分支影响；左树、transcript、SubagentPanel 功能不变。

## 9. 依赖与模块映射

| 工作项 | 模块规格 | 主要包 |
|---|---|---|
| FS DTO/枚举/错误码/SSE 常量 | 本 spec §3.1 | packages/protocol |
| 路由/态机/第一道白名单/SSE | 105-service-sync-workspace | packages/hub-service |
| 真实目录树/查看器/轮询/权限空状态 | 201-console-sync-workspace | packages/hub-console |
| fsAllowedDirs/fs-bridge/事件分支/回传 | 401-sync-daemon-sync-workspace | packages/sync-daemon |

外部依赖：Docker Desktop（hub 服务端）、本机 Node（daemon/插件调试）、本机 `~/.pi` 真实会话（提供 cwd 起点）。
