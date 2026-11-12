# 202-console-session-viewer — 任务清单（tasks.md）

> 依赖有序；按 Setup → Foundation（服务端）→ Story（前端）→ Polish 分层。
> 阶段：Specification → Development → Code Review → Testing → Bug Fix → Regression。
> 关联：spec.md / plan.md / test-cases.md（同目录）。

## Setup
- [ ] T001 规整开发日志目录 `logs/20261112-1/` + DEV_CHECKLIST.md
- [ ] T002 确认基线：`pnpm typecheck` 全绿（Step 0 已验证）；记录 Docker 栈现状（12380，1860 会话）
- [ ] T003 用容器真实数据固化三个证据样本：arguments 丢失、subagent marker 结构、嵌套 marker 区间（已在规格阶段完成，结论写入 DEV_CHECKLIST）

## Foundation — hub-service（FR-202-001~016）
- [ ] T004 `protocol/src/index.ts`：TranscriptBlock 联合类型新增 `subagentMarker` 块；新增
      SessionTreeResponse / VirtualFileNode / FileContentResponse / SubagentSummary DTO 类型
      —— `packages/protocol/src/index.ts`
- [ ] T005 `session-store.ts`：修复 `toTranscriptItem`
      - toolCall 参数字段兼容 `arguments ?? input`（FR-202-001）
      - toolResult 消息输出结构化 toolResult 块（FR-202-002）
      - custom 条目识别 `pi-desktop-import:subagent` → subagentMarker，其余 meta 带 customType（FR-202-003）
- [ ] T006 `session-store.ts`：新增纯函数路径提取/归一化模块（同文件内私有函数或 `file-tree.ts`）：
      结构化工具路径提取、bash 低置信提取、cwd 相对化、`_outside` 处理、2000 上限（FR-202-008~010）
- [ ] T007 `session-store.ts`：`scanFileTree(sessionId)` 与 `readFileContent(sessionId, path)`
      （write_input → read_result → none 三级回退、256KB 截断）（FR-202-011/012）
- [ ] T008 `session-store.ts`：`listSubagents(sessionId)` 与
      `subagentTranscript(sessionId, parentToolCallId)`（marker 线性区间归属、嵌套去重）（FR-202-013~016）
- [ ] T009 `app.ts`：注册 5 个 GET 路由（session-tree、files、files/content、subagents、
      subagents/:id/transcript），错误 code 枚举（file_not_tracked/subagent_not_found/content_unavailable），
      LRU 缓存（key 含 updatedAt，容量 100）（FR-202-005~007/029）
- [ ] T010 vitest 用例：路径归一化/提取、文件树截断、subagent 段归属（含嵌套）、toTranscriptItem 修复点
      —— `packages/hub-service/src/__tests__/`（新建，vitest 已在根 devDependencies）
- [ ] T011 curl 联调 Docker 重建后的 hub：五接口在真实会话（含 hs_p9ha… 嵌套子 agent 会话）上返回正确

## Story 1 — 前端壳与三级树（FR-202-017~020）
- [ ] T012 安装依赖：`pnpm --filter @pi-agent-hub/hub-console add md-editor-v3`；
      确认 markdown-it/dompurify 无其他引用后移除
- [ ] T013 `router.ts` 精简为 `/login` + `/`（Viewer）+ 通配重定向；删除
      views/Sessions.vue、Agents.vue、Hosts.vue；App.vue 去菜单、保留品牌与登出
- [ ] T014 `api.ts`：新增 session-tree/files/file-content/subagents/subagent-transcript 客户端与类型
- [ ] T015 `views/Viewer.vue` 三栏容器（可折叠侧栏 + 右栏 tab/抽屉、会话选中状态、事件总线）
- [ ] T016 `components/SessionTreePanel.vue`：三级 el-tree、图标/kind 标签/相对时间、
      q 过滤（debounce）、刷新、默认展开首项目、选中保持

## Story 2 — 主区上下文（FR-202-021~025）
- [ ] T017 `components/BlockCard.vue`：六种块 + subagentMarker 跳转按钮的分发渲染
- [ ] T018 `components/TranscriptPane.vue`：tail/before 分页状态机、IntersectionObserver 哨兵、
      in-flight 游标守卫、前置拼接与滚动位置保持、hasMore 终态、404/空/错误状态
- [ ] T019 接入 MdPreview（previewOnly、html 禁用、样式引入），替换 markdown-it+v-html

## Story 3 — 右栏文件与子 agent（FR-202-026~028）
- [ ] T020 `components/FileTreePanel.vue`：文件树渲染、touchedBy 标签、truncated 提示、会话级缓存
- [ ] T021 `components/FileViewerPane.vue`：content 接口对接、no_mirror_content 提示、truncated 提示
- [ ] T022 `components/SubagentPanel.vue`：子 agent 列表 + 子上下文视图（复用 BlockCard）+
      返回导航 + 主区 marker 跳转联动

## Polish
- [ ] T023 `pnpm typecheck && pnpm build` 全绿；检查 console chunk 体积（NFR：gzip 增量 <400KB）
- [ ] T024 Playwright 端到端走查（登录/三栏/滚动/文件/子 agent/XSS/只读），截图入日志目录
- [ ] T025 更新 specs/README.md 模块索引（202 条目）与 STRUCTURE.md 页面/路由/API 清单（如评审要求）
