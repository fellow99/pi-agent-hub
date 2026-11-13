# 005-sync-workspace — 任务清单（tasks.md）

> 依赖有序；按 Setup → Foundation（protocol → hub-service → sync-daemon）→ Story（hub-console）→ Polish 分层。
> 阶段：Specification → Development → Code Review → Testing → Bug Fix → Regression。
> 关联：spec.md / plan.md / test-cases.md（同目录）；模块细化见 105 / 201 / 401 目录。

## Setup
- [ ] T001 开发日志目录 `logs/20261113-1/` + DEV_CHECKLIST.md（规格阶段已建目录）
- [ ] T002 基线确认：`pnpm typecheck` 全绿、`pnpm test` 通过、`pnpm build` 成功；记录 Docker/Node/daemon 环境现状
- [ ] T003 固化联调样本：确认 `~/.pi` 6 个真实会话的 cwd（`D:\pi-workspace`）；记录 host `laptop-win` token 与 SSE 现状

## Foundation — protocol（FR-005-001~003）
- [ ] T004 `packages/protocol/src/index.ts`：新增 FsRequestKind/FsRequestState/FsErrorCode 联合、
      CreateFsRequest/FsRequestRecord/DirEntry/DirListingResult/TextFileContent/BinaryFileContent/
      FileContentResult/FsResultPayload/FsRequestEvent DTO、FS_REQUEST_EVENT 常量、FS_LIMITS 限额常量；
      SyncDaemonConfig 增 `fsAllowedDirs?: string[] | null`
      —— `packages/protocol/src/index.ts`
- [ ] T005 `pnpm --filter @pi-agent-hub/protocol build` 通过，下游包类型可解析

## Foundation — hub-service（FR-005-004~010，模块 spec 105）
- [ ] T006 `src/fs-paths.ts`（新）：normalizePath（resolve/分隔符/盘符小写/NUL 拒绝）、
      isPathWithin（段边界前缀）、collectHostCwds（sessions 行 → host 去重 cwd 集合）纯函数
- [ ] T007 `src/fs-request-store.ts`（新）：FsRequestStore 内存态机——create/get（惰性 60s expired、
      终态 5min 清理、软上限 10000 淘汰）、ack（host 归属校验）、result（ok→completed / !ok→failed，host 校验）
- [ ] T008 `src/app.ts` 注册 4 个路由：
      - `POST /api/hub/fs-requests`：参数 400 → host_unknown 404 → cwd 白名单 403 path_not_allowed →
        sse.send 失败 503 host_offline（不建记录）→ 建记录 + SSE fs_request → 202
      - `GET /api/hub/fs-requests/:id`：404 not_found / 200 全态记录（failed 也用 200）
      - `POST /api/v1/fs-requests/:id/ack`、`POST /api/v1/fs-requests/:id/result`：Bearer + host 归属
- [ ] T009 vitest：`__tests__/fs-paths.test.ts`（段边界、`..` 折叠、盘符大小写、NUL、cwd 收集）、
      `__tests__/fs-request-store.test.ts`（状态迁移、TTL、终态清理、跨 host 冒写拒绝）
- [ ] T010 `pnpm --filter @pi-agent-hub/hub-service test` 全绿；typecheck 零错误

## Foundation — sync-daemon（FR-005-009~014，模块 spec 401）
- [ ] T011 `src/config.ts`：校验 fsAllowedDirs（数组/null、条目为字符串、盘根拒绝、realpath 归一）；
      错误配置抛出明确异常
- [ ] T012 `src/fs-bridge.ts`（新）：FsBridge 类
      - 白名单终判（显式数组/[]全禁 denied_all/null 回退 knownCwds、段边界、realpath 二次判定）
      - listDir（readdir + stat、目录在前文件在后排序、2000 上限 truncated、not_a_directory）
      - readFile（stat 分类、1MB/10MB 限额、UTF-8 文本、base64 data URL、binary_unsupported/file_too_large）
      - 错误码归一（not_found/not_a_file/text_decode_failed/daemon_error）
- [ ] T013 `src/daemon.ts`：syncAll 刷新 knownCwds 快照；handleEvent 增 fs_request 分支
      （ack → FsBridge 执行 → fsResult 回传，异常也回 ok:false）；构造注入 FsBridge
- [ ] T014 `src/hub-client.ts`：fsAck / fsResult 方法（走既有 request()）
- [ ] T015 vitest：`__tests__/fs-bridge.test.ts`（tmpdir 造目录树：放行/拒绝/全禁/段边界/symlink 逃逸/
      文本/图片/二进制/超限/目录类型错误）；全绿
- [ ] T016 配置示例：examples/sync-daemon.json 增 fsAllowedDirs（本机 `D:\\pi-workspace`）；
      deploy/sync-daemon.json 增同字段示例值

## Story — hub-console 真实目录浏览（FR-005-015~018，模块 spec 201）
- [ ] T017 `src/api.ts`：登录持久化 role（getRole/清理）；FS 镜像类型；createFsRequest/pollFsRequest；
      listDir/readFile 便捷封装（1s 轮询、30s/60s 超时、AbortSignal、终态/expired/not_found 处理）
- [ ] T018 `src/components/FileTreePanel.vue` 重写：
      - 根节点=会话 cwd、el-tree lazy 单级懒加载、目录 LRU 30 项、节点展示 isDir/size/mtime（去 touchedBy）
      - viewer 角色空状态「目录浏览需要管理员权限」、host 离线/错误 el-alert、卸载与切换会话取消轮询
- [ ] T019 文件查看器（同组件或 FileViewerPane.vue）：text（.md→MdPreview，其余 pre）、image img、
      video controls、pdf iframe；denied/too_large/binary_unsupported/超时错误态
- [ ] T020 `pnpm --filter @pi-agent-hub/hub-console typecheck && build` 通过；vue-tsc 零错误

## Polish — 联调与回归
- [ ] T021 全仓 `pnpm typecheck && pnpm test && pnpm build` 全绿（零新增错误）
- [ ] T022 Docker 栈重建 + 本机 daemon 联调：curl 全后端用例（见 test-cases.md P1/P2）
- [ ] T023 Playwright 端到端：admin 懒加载/文件渲染/错误态、viewer 空状态、daemon 离线 503、截图入日志目录
- [ ] T024 回归：deliveries/import/export SSE 链路、左树/transcript/SubagentPanel、虚拟树接口仍可用
- [ ] T025 文档收尾：specs/README.md 增 005/105/201/401 索引；docs/001 协议规范补 FS Bridge 章节；
      202 spec 标注右栏数据源切换（如评审要求）
