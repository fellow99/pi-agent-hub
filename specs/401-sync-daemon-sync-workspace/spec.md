# 401-sync-daemon-sync-workspace 功能规格（sync-daemon 部分）

> Module: 401-sync-daemon-sync-workspace（项目目录同步：同步程序部分设计）
> 需求编号：005-sync-workspace（daemon 子需求）
> Status: In-progress
> Last Updated: 2026-11-13
> 关联：[005-sync-workspace/spec.md](../005-sync-workspace/spec.md)（主设计）、docs/005-工程目录同步.md §4/§5、
> 既有 401-sync-daemon（daemon 基座）

## 1. 模块概述

### 1.1 目的

在 sync-daemon 内实现 FS Bridge 的主机执行端：接收 hub 经 SSE 下发的 `fs_request`，先做本机白名单终判
（`fsAllowedDirs`，拥有最终否决权），再执行只读 `readdir/stat/readFile/realpath`，按分类限额编码结果，
经 Bearer REST 回传 ack/result。

### 1.2 范围

- 包含：config 新增 `fsAllowedDirs` 校验、`fs-bridge.ts`（白名单/文件操作/分类/错误归一）、
  daemon 事件分支与 knownCwds 快照、HubClient 两个回传方法、vitest 单测。
- 不包含：新增插件 RPC 方法（cwd 复用既有 list_sessions 结果）、任何写操作、watch 推送。

## 2. 用户故事

- 作为 daemon，我收到 fs_request 后先 ack，再独立判定路径是否在本机允许范围，越界即回 denied 而不碰文件系统。
- 作为运维者，我在配置中显式给出允许的项目目录；配置错误（盘根）时 daemon 启动即失败暴露问题；
  缺省配置下自动回退「会话 cwd 集合」规则。
- 作为 hub/console，我收到的每个结果都带稳定错误码，可直接映射为用户提示。

## 3. 功能需求

### 3.1 配置（config.ts + protocol 类型）

- FR-DFS-001: `SyncDaemonConfig` MUST 新增可选 `fsAllowedDirs?: string[] | null`（protocol T004 定义）。
- FR-DFS-002: loadConfig MUST 校验：值为 undefined/null/数组以外 → 抛配置错误；数组条目必须为非空字符串；
  条目经 realpath 归一，路径不存在时**启动期报错**（显式配置指向不存在目录属于配置失误）。
- FR-DFS-003: 盘根条目（Windows `D:\`、posix `/`）MUST 在加载期拒绝并抛错，防止全盘暴露。
- FR-DFS-004: `[]` 为合法值，语义=全禁（运行期任何请求回 `denied_all`）。

### 3.2 白名单终判（fs-bridge.ts）

- FR-DFS-005: FsBridge 构造接收 `getAllowedRoots(): string[]`（配置 realpath 集合）与
  `getKnownCwds(): string[]`（null 回退集合快照）。
- FR-DFS-006: `assertAllowed(inputPath)` 判定规则：
  1. 拒绝含 NUL 路径；`path.resolve` 折叠 `.`/`..`（daemon 在主机本机运行，可用 node:path）；
  2. 显式数组模式：长度 0 → `denied_all`；否则 `realpath`（存在时）后按段边界匹配 roots，失败 → `denied`；
  3. null 模式：对 knownCwds（同样 realpath 归一）做段边界匹配，失败 → `denied`；集合为空亦 denied。
- FR-DFS-007: 段边界匹配 MUST 与 hub 侧同语义（归一后相等或 root + 分隔符前缀），Windows 盘符小写比较。
- FR-DFS-008: readFile 场景 MUST 在打开前对目标 realpath 二次白名单判定，拦截 symlink 指向白名单外
  （TC-013）；readdir 不跟随目录 symlink 到外部（lstat 判定项类型，symlink 项按 lstat 结果展示且读取时再判）。

### 3.3 listDir（FR-DFS-009~011）

- FR-DFS-009: 先 assertAllowed，再 `readdir(path, { withFileTypes: true })`；对每项 `lstat` 取
  size/mtimeMs；目录在前文件在后、各组按 name 升序（locale 排序保持确定性）。
- FR-DFS-010: 子项数达 `FS_LIMITS.maxDirEntries`(2000) 停止并置 `truncated=true`。
- FR-DFS-011: 目标不存在 → `not_found`；目标不是目录 → `not_a_directory`；其它异常 → `daemon_error`。

### 3.4 readFile 与分类限额（FR-DFS-012~015）

- FR-DFS-012: 先 `stat`：不存在 `not_found`；是目录 `not_a_file`；symlink 经 realpath + assertAllowed 二次判定。
- FR-DFS-013: 分类纯函数 `classifyFile(name): {kind, mime?, maxBytes}`：
  - 文本扩展名集合（spec 主表，去重）上限 1MB；图片 8 种上限 10MB；视频 4 种、pdf 各 10MB；
  - 不在表内 → 不读取，`binary_unsupported`。
- FR-DFS-014: 读取规则：
  - 文本：`readFile(path)` 后以 `TextDecoder("utf8", {fatal:true})` 解码，失败 → `text_decode_failed`；
    成功返回 `{type:"text", content, size}`；
  - 二进制：读 Buffer 转 base64，返回 `{type, mimeType, dataUrl: \`data:\${mime};base64,\${...}\`, size}`；
  - stat.size 超类别上限 → 不读取，`file_too_large`（message 含实际/上限字节数）。
- FR-DFS-015: 任何未预期异常归一为 `daemon_error`（message 为原始错误字符串，不附带 token 等敏感信息）。

### 3.5 事件接线（daemon.ts + hub-client.ts）

- FR-DFS-016: daemon MUST 维护 `knownCwds: Set<string>`：每次 `syncAll()` 汇总各 runtime list_sessions
  返回的 cwd，去重 realpath 后刷新快照（首次同步前为空集合）。
- FR-DFS-017: `handleEvent` MUST 新增 `fs_request` 分支（与 deliver/import/export_native 并列）：
  校验 payload 形状（requestId/kind/path 字符串）→ `hub.fsAck(requestId)` → FsBridge 执行 →
  `hub.fsResult(requestId, {ok:true,result}|{ok:false,error})`；分支内 try/catch 兜底，
  异常也回 ok:false/daemon_error，避免 SSE 循环中断。
- FR-DFS-018: HubClient MUST 新增 `fsAck(id)` → POST `/api/v1/fs-requests/:id/ack`、
  `fsResult(id, payload)` → POST `/api/v1/fs-requests/:id/result`，复用既有 `request()`（Bearer 注入）。
- FR-DFS-019: 未知/畸形事件 MUST 被忽略并记 warn 日志，不影响其它事件分支。

## 4. 关键实体

| 实体 | 说明 |
|---|---|
| FsBridge | 无状态工具类（ roots/knownCwds 以 getter 注入），方法 listDir/readFile，全部返回判别结果或抛 FsError |
| FsError | `{code: FsErrorCode, message: string}`，daemon 捕获后转 ok:false 回传 |
| knownCwds 快照 | Set<string>，syncAll 每周期刷新，null 模式白名单数据源 |

## 5. 验收场景

- **正常列目录/读文件**：配置 `fsAllowedDirs:["D:\\pi-workspace"]`，对 cwd 内 list_dir/read_file 成功，
  结果与本机 ls/文件内容一致。
- **全禁与越界**：`[]` → 任意请求 denied_all；去掉配置（null）且 cwd 集合外路径 → denied；
  symlink 逃逸 → denied。
- **分类限额**：tmpdir 构造文本/图片/二进制/超限文件，错误码与主 spec §7 总表逐一吻合。
- **事件健壮性**：畸形 fs_request 不影响同连接后续 deliver 事件；执行异常回 failed 而非断连。

## 6. 非功能需求

- 只读：仅 import node:fs 的 readdir/readFile/realpath/lstat/stat；禁止任何 write/rm/exec API。
- 单次调用内存上限受 10MB 读取边界约束；base64 结果 <14MB，hub 128mb body 与内网链路可容纳。
- 不新增依赖；严格类型无 as any；`pnpm test` 新增 fs-bridge 用例全绿。
- 日志：记录 requestId/kind/结果 code，不记录文件内容与 token。

## 7. 依赖

- protocol（FS_LIMITS/DTO/错误码/SyncDaemonConfig.fsAllowedDirs）、HubClient、PluginManager
  （list_sessions 既有能力）、node:fs/promises + node:path。测试用 node:os tmpdir + node:fs 造样本。
