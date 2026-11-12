# Test Cases: 202-console-session-viewer（session 上下文查看器）

> 覆盖：transcript 映射修复、新增 hub API、三栏 UI、安全与回归。
> 环境：Docker Desktop 栈 `http://localhost:12380`（重建镜像后），curl 用 Cookie 会话；
> UI 用 Playwright（Chromium）。登录凭据以 deploy/.env 与容器内 hub-service.json 为准。

## 后端 API（curl / vitest）

### TC-001: toolCall 参数兼容 arguments 字段（回归修复，P1，Functional）
- **Precondition**: 库中存在含 pi v3 `arguments` 工具调用的会话（如 hs_rnozyygxkby…）
- **Steps**: `GET /api/hub/sessions/:id/transcript?tail=100`
- **Expected**: 每个 toolCall 块含非空 `input`（值等于原 `arguments`）；修复前为 undefined

### TC-002: toolResult 结构化输出（P1，Functional）
- **Steps**: 同 TC-001，检查 toolResult 角色条目
- **Expected**: 块 kind=toolResult，含 name（=toolName）、callId（=toolCallId）、ok（isError 取反）、非空 preview 字符串

### TC-003: subagentMarker 块识别（P1，Functional）
- **Precondition**: 会话含 `pi-desktop-import:subagent` 标记（如 hs_p9haaezkdg7…，136 marker）
- **Steps**: 拉取该会话 transcript
- **Expected**: 出现 kind=subagentMarker 块，字段 agentName/parentToolCallId/aMessageId 与镜像 JSONL 一致；其余 custom 仍输出 meta 块且 label 带 customType

### TC-004: 分页契约不变（P1，Regression）
- **Steps**: 连续两次请求 `tail=50` 与 `before=<oldestSeq>`
- **Expected**: 字段 items/hasMore/oldestSeq/newestSeq 结构不变；seq 连续不重叠；尾页 hasMore 与条目数符合 store 逻辑

### TC-005: session-tree 三级结构（P1，Functional）
- **Steps**: `GET /api/hub/session-tree`
- **Expected**: projects[].agents[].sessions[] 三级；project.key 为归一化 cwd、label 为原文；
  agent 节点 key=`<hostId>|<agentId>` 且 kind 关联 agents 表（无登记时 null）；会话字段同 SessionSummary

### TC-006: session-tree 排序与计数（P2，Functional）
- **Expected**: 项目按组内最大 updatedAt 降序；agent 节点按 hostId/agentId 升序；会话按 updatedAt 降序；
  各级 sessionCount 与实际会话数一致

### TC-007: session-tree 关键字过滤（P2，Functional）
- **Steps**: `GET /api/hub/session-tree?q=pi-workspace`
- **Expected**: 仅返回 cwd/title/agentId/hostId 命中的会话所在分支，计数随过滤结果变化

### TC-008: 虚拟文件树提取（P1，Functional）
- **Precondition**: 会话含 read/write/edit/glob/grep/bash 工具调用
- **Steps**: `GET /api/hub/sessions/:id/files`
- **Expected**: 树含对应目录/文件节点；文件节点 touchedBy 含工具名；相对路径基于 cwd；
  `\`/`/` 混用与盘符大小写正确归一；绝对路径越界项在 `_outside/`

### TC-009: 文件树上限截断（P2，Edge Case）
- **Steps**: 对工具路径极多的会话请求 /files（vitest 构造合成条目更稳定）
- **Expected**: 路径键达 2000 后停止累积，响应 truncated=true，接口正常返回不超时

### TC-010: 文件内容 — write 输入优先（P1，Functional）
- **Steps**: 选一个被 write 触碰的文件，`GET .../files/content?path=<相对路径>`
- **Expected**: available=true、source=write_input、content 等于该工具 input.content、toolName/entrySeq 有值

### TC-011: 文件内容 — read 结果回退（P1，Functional）
- **Steps**: 选仅被 read 触碰的文件请求 content
- **Expected**: source=read_result，content 为对应 toolResult preview；超 256KB 时 truncated=true

### TC-012: 文件内容 — 无镜像内容（P2，Functional）
- **Steps**: 请求仅被 bash 低置信提及、无 read/write 内容的路径
- **Expected**: HTTP 200，available=false、reason=no_mirror_content

### TC-013: 文件内容 — 未跟踪路径 404（P2，Edge Case）
- **Steps**: path 传一个文件树中不存在的键（含 `..` 越界构造）
- **Expected**: 404，error.code=file_not_tracked；不返回 cwd 之外任何数据

### TC-014: 子 agent 列表聚合（P1，Functional）
- **Steps**: `GET /api/hub/sessions/:id/subagents`（嵌套标记会话）
- **Expected**: 按 parentToolCallId 聚合，含 agentName/markerCount/firstTs/lastTs；
  description 取自 Task 工具 input.description（无则 null）

### TC-015: 子 agent transcript 段归属与嵌套去重（P1，Functional）
- **Steps**: 分别请求两个区间交叠的 subagentId 的 transcript
- **Expected**: 各自只含归属消息段、不含 marker 条目；同一条目不重复；两个子 agent 输出可独立解释；
  items 按 seq 升序
- **Steps**: 请求不存在的 subagentId
- **Expected**: 404 subagent_not_found

### TC-016: 无 marker 会话的子 agent 接口（P2，Edge Case）
- **Expected**: /subagents 返回 `{items:[]}`；不报错

### TC-017: 镜像缺失的容错（P2，Edge Case）
- **Steps**: 对 native_path 文件缺失的会话请求 files/subagents/transcript
- **Expected**: 404 content_unavailable（与既有 transcript 行为一致），不出现 500

### TC-018: 鉴权与只读（P1，Security）
- **Steps**: 未带 Cookie 调用五个新接口 → 401；viewer 登录后 GET 全部 200；
  确认新接口无 POST/PUT/DELETE 方法
- **Expected**: 全部符合；viewer 无 403

### TC-019: LRU 缓存一致性（P3，Functional）
- **Steps**: 同一会话连续两次请求 /files（响应一致）；模拟 updatedAt 变化后再次请求
- **Expected**: 同 updatedAt 命中缓存（可通过日志/耗时观察），updatedAt 变化后返回新索引

## 前端 UI（Playwright）

### TC-101: 登录进入单页查看器（P1，Functional）
- **Steps**: 打开 /hub/，未登录跳转 /login；admin 登录
- **Expected**: 进入三栏查看器；顶部无 Sessions/Agents/Hosts 菜单；左栏渲染三级树

### TC-102: 三级树导航（P1，Functional）
- **Steps**: 展开项目 → host|agent → 点击会话
- **Expected**: 项目节点含会话数；agent 节点显示 `<host>|<agent>` 与 kind 标签；
  会话节点显示标题/相对时间；选中高亮，主区加载该会话尾页

### TC-103: 树过滤与刷新（P2，Functional）
- **Steps**: 搜索框输入关键字（debounce 后）→ 树只剩匹配分支；点 Refresh
- **Expected**: 过滤生效；刷新后恢复全量且当前选中会话保持高亮

### TC-104: 主区 markdown 渲染（P1，Functional）
- **Expected**: text 块经 MdPreview 渲染（标题/列表/代码块样式正确）；thinking 默认折叠；
  toolCall 卡片显示工具名与参数 JSON；bash 块显示命令与输出

### TC-105: 滚动动态加载（P1，Functional）
- **Precondition**: 选 entryCount>100 且 hasMore=true 的会话
- **Steps**: 滚动主区到顶部，等待加载，重复至 hasMore=false
- **Expected**: 旧页前置拼接、滚动位置不跳动、无重复条目、无并发重复请求（Network 面板核对）；
  终态显示「已到最早记录」

### TC-106: 切换会话状态重置（P1，Functional）
- **Steps**: A 会话滚动加载多页后切到 B 会话再切回 A
- **Expected**: 切 B 时显示 B 尾页且分页状态重置；切回 A 重新首屏加载，不串数据

### TC-107: 右栏文件树与文件查看器（P1，Functional）
- **Steps**: 打开文件 tab → 展开目录 → 点击有内容文件 → 点击无镜像内容文件
- **Expected**: 前者展示文本内容与来源元信息；后者显示「镜像中无完整内容」提示；touchedBy 标签可见

### TC-108: 子 agent tab（P1，Functional）
- **Steps**: 对含 marker 的会话打开子 agent tab → 点选调用 → 返回列表 → 点主区 marker 的跳转按钮
- **Expected**: 列表字段完整；子上下文仅含该调用消息段；返回正常；跳转按钮定位到对应子 agent

### TC-109: XSS 安全渲染（P1，Security）
- **Precondition**: 选含 `<script>alert(1)</script>` 文本的会话（无则用同步的测试会话构造）
- **Expected**: 脚本不执行（无 dialog、DOM 中无活动 script），以文本呈现

### TC-110: 只读约束（P1，Security）
- **Steps**: 遍历三栏所有可见控件
- **Expected**: 无编辑/发送/删除/下发类控件；Network 中除登录/登出外无 POST 请求

### TC-111: 旧路由兜底（P2，Regression）
- **Steps**: 浏览器直接访问 /hub/sessions、/hub/hosts、/hub/agents
- **Expected**: 重定向到查看器，不白屏、不 404

### TC-112: 错误与空状态（P2，Edge Case）
- **Steps**: 打开一个镜像缺失会话；断网后点刷新
- **Expected**: 分别显示 content_unavailable 空状态与 el-alert 错误条，页面不崩溃

### TC-113: 登出（P2，Regression）
- **Steps**: 点 Sign out 后访问 /api/hub/session-tree
- **Expected**: 回到 /login；接口 401

## 构建与回归
### TC-201: 全仓 typecheck/build（P1，Regression）
- **Expected**: `pnpm typecheck` 与 `pnpm build` 零错误；hub-console 构建成功且 gzip 增量 <400KB

### TC-202: 旧 API 兼容（P2，Regression）
- **Expected**: `/api/hub/agents`、`/api/hub/hosts`、`/api/hub/sessions` 行为不变且 200；
  旧 transcript 消费方字段（seq/entryId/type/ts/role/blocks）保持兼容
