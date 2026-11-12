# 202-console-session-viewer 功能规格（Specification）

> Module: 202-console-session-viewer（session 上下文查看器重构）
> 需求编号：202-console-session-viewer · 需求名称：session 上下文查看器
> Status: In-progress
> Last Updated: 2026-11-12
> 关联文档：specs/201-console-shell（被本需求重构取代其页面形态）、specs/004-sync-session、specs/101-service-http、specs/102-service-storage、参考工程 `../pi-web`

## 1. 模块概述

### 1.1 目的
把 hub-console 从「Sessions / Agents / Hosts 多页表格 + 简易正文」的 MVP，重构为参考
pi-web 的**单页三栏 session 上下文查看器**：

```text
┌──────────────┬────────────────────────────┬──────────────────────┐
│ 左栏          │ 主区                        │ 右栏                  │
│ 项目/会话树   │ 会话上下文（markdown 渲染）  │ 文件树/文件查看器/    │
│ （三级）      │ 向上滚动动态加载历史         │ 子 agent 上下文       │
└──────────────┴────────────────────────────┴──────────────────────┘
```

- 左栏三级树：一级 **项目（cwd 归一化分组）** → 二级 **`<host>|<agent>`** → 三级 **会话**。
- 主区：只读会话上下文，使用 **md-editor-v3（MdPreview）** 渲染 markdown，滚动到顶部时
  按游标分页动态加载更早的历史。
- 右栏：项目**虚拟文件树**（从会话工具活动推导，hub 无主机文件系统访问权）、
  **文件查看器**（展示镜像中留存的工具结果内容）、**子 agent 上下文**（从会话内嵌的
  subagent 标记与消息段提取）。

### 1.2 解决的问题
- MVP 的正文渲染为 `markdown-it + v-html` 最小实现，且工具调用参数在服务端归一化时丢失
  （pi v3 原生字段为 `arguments`，`toTranscriptItem` 只读 `input`），无法展示工具细节。
- 会话以平铺表格呈现，缺少 pi-web 的项目/主机/agent 层级导航与上下文关联视图。
- 子 agent 执行记录（库内实测 13202 条 `pi-desktop-import:subagent` 标记）当前被降级为
  `meta` 文本块，无法按子 agent 维度阅读。
- 右栏文件视角缺失：用户无法从会话快速定位被读取/修改的文件及其镜像内容。

### 1.3 范围
- 包含：
  - hub-service：修复 transcript 块映射（toolCall 参数、custom 标记结构化）；
    新增只读接口：项目会话树、虚拟文件树、文件内容、子 agent 列表与子 agent transcript。
  - hub-console：移除 Sessions/Agents/Hosts 栏目与路由，新增三栏查看器布局、三级树、
    滚动分页、md-editor-v3 渲染、右栏文件树/文件查看器/子 agent 面板。
- 不包含：
  - 主机真实文件系统访问（不做 daemon 文件代理/下发，文件树仅为会话推导的虚拟视图）。
  - 会话编辑/发送/删除/下发等写操作（保持只读定位；既有 deliveries API 不在 UI 暴露）。
  - 虚拟滚动（采用分页加载 + 普通渲染；万级条目性能优化留 TODO）。
  - i18n、主题切换、FTS5 搜索页（既有 TODO 不在本需求范围）。

## 2. 用户故事
- 作为登录用户，我打开 console 即看到按「项目 → host|agent → 会话」组织的三级树，
  点击会话即可在主区阅读其上下文，无需在多个表格页之间切换。
- 作为登录用户，我在主区向上滚动时自动加载更早的历史条目，长会话可连续阅读且首屏快速呈现。
- 作为登录用户，我看到的 markdown（含代码块、列表、表格）由 md-editor-v3 正确渲染，
  会话中的脚本内容不被执行（XSS 安全）。
- 作为登录用户，我在右栏看到该会话所属项目被工具触碰过的文件树，点击文件可查看镜像中
  留存的内容片段；镜像无完整内容时得到明确提示而非空白。
- 作为登录用户，我在右栏看到会话产生的子 agent 调用列表，点击某个子 agent 可阅读其
  独立上下文（该次委托期间的消息段）。
- 作为 viewer，我拥有与 admin 相同的只读浏览体验；所有新增接口均为 GET，不引入写权限。

## 3. 功能需求

### 3.1 hub-service：transcript 映射修复（Bug 修复，前置）
- FR-202-001: `toTranscriptItem` 生成 toolCall 块时 MUST 兼容 pi v3 原生 `arguments`
  与既有 `input` 两种参数字段（`part.arguments ?? part.input`），输出块统一携带 `input`。
- FR-202-002: toolResult 消息 MUST 输出 `toolResult` 块（含 `name`（取 `toolName`）、
  `ok`（取 `isError` 取反）、`preview`（文本 content 拼接）、`callId`（取 `toolCallId`）），
  不再被折叠为普通 text 块。
- FR-202-003: `custom` 条目 MUST 按 `customType` 结构化输出：
  - `pi-desktop-import:subagent` → 新块 `{ kind:"subagentMarker", agentName, parentToolCallId, aMessageId }`；
  - 其余 custom → 保留现有 `meta` 块降级行为（label 带 customType）。
- FR-202-004: 修复 MUST NOT 改变既有 `transcript` 接口的分页契约（`tail/before/hasMore/
  oldestSeq/newestSeq`）与条目 seq 编号；仅丰富 blocks 内容。

### 3.2 hub-service：项目会话树接口
- FR-202-005: MUST 提供 `GET /api/hub/session-tree`，返回三级树：
  - 一级 project：以会话 `cwd` 归一化（大小写/斜杠归一，不去重语义路径）为分组键，
    节点含 `key`、`label`（cwd 原文）、`sessionCount`。
  - 二级 agentNode：key 为 `<hostId>|<agentId>`，含 `hostId`、`agentId`、`kind`
    （由 agents 表关联，缺失时为 `null`）、`sessionCount`。
  - 三级 session：复用 `SessionSummary` 字段。
- FR-202-006: 排序 MUST 确定：项目按最近会话 `updatedAt` 降序；agentNode 按 hostId、
  agentId 升序；会话按 `updatedAt` 降序。
- FR-202-007: 支持可选查询参数 `?q=<关键字>`，对 title/cwd/agentId/hostId 做
  includes 过滤（与现有 `/search` 的 LIKE 行为一致，不引入 FTS）。

### 3.3 hub-service：虚拟文件树接口
- FR-202-008: MUST 提供 `GET /api/hub/sessions/:id/files`，扫描该会话镜像 JSONL 中
  工具调用的路径参数，推导文件/目录树：
  - 识别工具：`read/write/edit/apply_patch/glob/grep`（含大写变体 `Read/Write/Edit/Grep/Glob`）；
    路径字段：`path`、`file_path`、`filePath`；`glob/grep` 的 `pattern` 含路径分隔符时
    取其目录部分；`bash/Bash` 命令行中的路径做尽力提取（正则，标记 `confidence:"low"`）。
  - 相对路径以会话 `cwd` 为基准解析；无法解析或越出 cwd 的路径归入节点
    `_outside/`（保留原路径显示，不参与目录展开）。
  - 节点含 `name`、`path`（相对 cwd 的 POSIX 风格路径）、`isDir`、`touchedBy`
    （去重工具名列表）、`hasContent`（是否存在可展示的镜像内容）。
- FR-202-009: 路径归一 MUST 兼容 `\` 与 `/` 混用、Windows 盘符大小写；目录层级按
  POSIX `/` 切分构建；同名文件/目录冲突时目录优先合并。
- FR-202-010: 接口 MUST 为纯只读、有界：单会话提取路径数设上限（默认 2000，超出截断并在
  响应中返回 `truncated:true`），避免异常大会话导致内存膨胀。

### 3.4 hub-service：文件内容接口
- FR-202-011: MUST 提供
  `GET /api/hub/sessions/:id/files/content?path=<相对路径>`：
  - 优先返回该文件最近一次 `write/Write` 工具调用的完整输入内容（取自 toolCall 参数）。
  - 其次返回最近一次 `read/Read` 关联 toolResult 的 preview 文本。
  - 均不存在时返回 200 + `{ available:false, reason:"no_mirror_content" }`，
    前端据此显示「镜像中无完整内容」提示，不返回伪造空文件。
  - 响应含 `source`（`write_input` / `read_result` / `none`）、`toolName`、`entrySeq`、
    `content`、`truncated`（内容超过 256KB 时截断并置 true）。
- FR-202-012: path 参数 MUST 做归一化与边界校验：禁止 `..` 越出会话 cwd 视图
  （虚拟视图无真实 FS 访问，校验针对路径键匹配），未匹配到节点返回 404 `file_not_tracked`。

### 3.5 hub-service：子 agent 接口
- FR-202-013: MUST 提供 `GET /api/hub/sessions/:id/subagents`，从镜像条目中识别
  `pi-desktop-import:subagent` 标记，按 `parentToolCallId` 聚合为子 agent 调用，返回：
  `subagentId`（parentToolCallId）、`agentName`、`markerCount`、`firstTs`、`lastTs`、
  `description`（首次 Task 工具调用参数中的 `description`，缺失为 null）。
- FR-202-014: MUST 提供
  `GET /api/hub/sessions/:id/subagents/:subagentId/transcript`：
  - 依据该调用名下全部 marker 的线性位置，取每个 marker 到下一个 marker 之间的消息段
    （marker 本身不输出），合并后复用 `toTranscriptItem` 映射，按 seq 升序返回
    `{ items, count }`。
  - 支持嵌套：marker 区间交叠时以 marker 自身位置为准做区间归属（消息段属于其前方最近的
    marker），同一条目不重复输出。
- FR-202-015: 无 marker 的会话调用上述接口 MUST 返回空列表/空 items（200），不报错。
- FR-202-016: 未知 `subagentId` 返回 404 `subagent_not_found`。

### 3.6 hub-console：布局与导航重构
- FR-202-017: MUST 移除顶部 Sessions/Agents/Hosts 菜单及对应路由/视图文件
  （Sessions.vue、Agents.vue、Hosts.vue）；登录后默认进入单页查看器（`/` → 查看器）。
- FR-202-018: 查看器 MUST 为三栏布局：左栏可折叠的三级 el-tree；主区上下文；右栏含
  「文件 / 子 agent」两个 tab（文件 tab 内上下分：文件树 + 文件查看器）。窄屏下右栏
  可折叠为抽屉（最小实现：CSS 折叠按钮，不做移动端专门适配）。
- FR-202-019: 左栏树 MUST 按 FR-202-005 结构渲染：项目节点显示名称 + 会话数；
  agentNode 显示 `<host>|<agent>` 与 kind 标签；会话节点显示 title（无 title 时取
  id 前 8 位）与相对时间。当前选中会话高亮；刷新按钮重新拉取树并保持选中。
- FR-202-020: 树节点 MUST 支持关键字过滤（对接 `?q=`）与默认展开首个项目节点；
  会话总量大时项目节点默认折叠（点击展开时再渲染其子树，el-tree lazy 非必须）。

### 3.7 hub-console：主区上下文与滚动加载
- FR-202-021: 主区 MUST 使用 `md-editor-v3` 的 `MdPreview` 渲染 text/markdown 块；
  thinking/toolCall/toolResult/bash/summary/subagentMarker 等块以定制卡片渲染
  （工具名、参数 JSON、命令、输出、子 agent 跳转按钮），未知 kind 显示 kind 标签。
- FR-202-022: 首屏加载尾部一页（tail=100）；主区滚动到顶部哨兵（IntersectionObserver）
  时以 `before=oldestSeq` 拉取上一页并**前置拼接**，保持滚动位置不跳动；
  `hasMore=false` 后哨兵显示「已到最早记录」。
- FR-202-023: 同一会话的分页请求 MUST 串行去重（in-flight 游标守卫），禁止并发重复拉取；
  切换会话时重置分页状态与滚动位置。
- FR-202-024: 镜像缺失（transcript 返回 404 content_unavailable）MUST 显示明确的
  空状态提示；网络错误显示 el-alert，不白屏。
- FR-202-025: 主区 MUST 只读：不存在编辑/发送/删除控件。

### 3.8 hub-console：右栏文件与子 agent
- FR-202-026: 文件树 MUST 在选中会话后按 FR-202-008 拉取并渲染（目录/文件图标、
  touchedBy 工具标签）；点击文件调用 FR-202-011 内容接口，在文件查看器中展示：
  代码/文本按纯文本预置高亮样式展示（不引入额外重型高亮库），
  `available:false` 时展示提示与已知元信息（触碰工具、entrySeq）。
- FR-202-027: 子 agent tab MUST 按 FR-202-013 列出调用（agentName、描述、消息数、时间）；
  点击后在右侧/抽屉内嵌打开该子 agent 的 transcript（复用主区块渲染组件），
  并提供返回调用列表的入口。
- FR-202-028: 文件树与子 agent 数据按会话缓存（会话 id 为键），切换会话不串数据；
  重新选中同一会话不重复请求（保留手动刷新）。

### 3.9 安全与兼容
- FR-202-029: 所有新增接口 MUST 位于 `/api/hub/*` 鉴权中间件之后，仅 GET，
  viewer 可访问；不新增任何写接口与 CSRF 需求。
- FR-202-030: markdown 渲染 MUST 禁用原始 HTML（md-editor-v3 配置 `html:false` 或等效
  净化链路），会话内 `<script>` 等内容以文本呈现不执行；保留 201 规格的 XSS 验收场景。
- FR-202-031: 保留 base 路径 `/hub/`、Vite `/api` 代理、Cookie+CSRF 客户端约定；
  hub-service 静态托管与 SPA fallback 行为不变。
- FR-202-032: 移除 Hosts/Agents 页后，`GET /api/hub/hosts`、`/api/hub/agents` 服务端接口
  MUST 保留（session-tree 内部复用 agents 关联，且不破坏既有 API 兼容）。

## 4. 关键实体
| 实体 | 说明 |
|---|---|
| ProjectNode | 虚拟项目节点：key（归一化 cwd）、label（cwd 原文）、sessionCount |
| AgentNode | 二级节点：hostId、agentId、kind、sessionCount |
| VirtualFileNode | 推导文件节点：name/path/isDir/touchedBy/hasContent/confidence |
| FileContentResponse | source/content/toolName/entrySeq/truncated/available |
| SubagentSummary | parentToolCallId 聚合的子 agent 调用：agentName/markerCount/时间范围/description |
| SubagentMarkerBlock | transcript 新块：subagentMarker（agentName/parentToolCallId/aMessageId） |

## 5. 验收场景
### 场景：三级树导航
- Given hub 已同步 ≥2 个项目、≥2 个 host|agent 的会话
- When 用户登录进入查看器
- Then 左栏呈现 项目 → host|agent → 会话 三级树，默认展开首个项目；点击会话后主区加载其尾部上下文。

### 场景：滚动动态加载
- Given 选中会话条目数 > 100 且 hasMore=true
- When 用户滚动主区到顶部
- Then 自动拉取上一页并前置，滚动位置不跳动；hasMore=false 后显示「已到最早记录」，无重复请求。

### 场景：工具参数不再丢失
- Given 会话含 pi v3 原生 `arguments` 字段的 toolCall
- When 渲染该会话 transcript
- Then 工具卡片展示完整参数（含 write/read 的 path 等），与镜像 JSONL 原文一致。

### 场景：markdown 安全渲染
- Given 会话文本含 `<script>alert(1)</script>`
- When MdPreview 渲染
- Then 脚本不执行，以文本/净化后形式呈现。

### 场景：虚拟文件树与文件查看
- Given 会话中存在 write/read 工具调用
- When 打开右栏文件 tab
- Then 文件树列出对应文件且 touchedBy 标注工具；点击文件展示镜像内容；
  对仅有工具触碰、无内容留存的文件显示「镜像中无完整内容」。

### 场景：子 agent 上下文
- Given 会话含 `pi-desktop-import:subagent` 标记（含嵌套调用）
- When 打开子 agent tab 并选择某次调用
- Then 展示该调用归属的消息段且无重复条目；嵌套调用各自可独立打开。

### 场景：只读与权限
- Given viewer 登录
- When 浏览全部新视图与接口
- Then 均可读；界面无任何写操作控件；写接口（如 deliveries）不在 UI 暴露。

### 场景：栏目移除不破坏旧链接兼容
- Given 用户浏览器历史中存有 `/hub/sessions`、`/hub/hosts`
- When 访问旧路径
- Then 路由 fallback 到查看器（重定向 `/`），不出现 404 白屏。

## 6. 非功能需求
- 首屏：session-tree 接口在 1860 会话量级下 P95 < 300ms（本机 Docker 数据实测基准）；
  单会话 transcript 尾页接口 P95 < 200ms。
- 文件树/子 agent 提取为每会话一次的有界扫描（FR-202-010），结果可在进程内按
  session id+updatedAt 做 LRU 缓存（上限 100 会话），不写库、不改同步链路。
- 前端构建：`pnpm --filter @pi-agent-hub/hub-console build` 成功；
  全仓 `pnpm typecheck` 零新增错误；严禁 `as any`/`@ts-ignore`/空 catch。
- md-editor-v3 按需引入 MdPreview，bundle 增量控制在合理范围（gzip 后新增 < 400KB）。
- 浏览器基线：Chromium 内核（Playwright 测试使用 Chromium）。

## 7. 假设与约束
- hub 不具备主机文件系统访问权；「文件树」是会话推导的虚拟视图，不承诺与真实目录完全一致。
- 子 agent 识别依赖迁移数据中的 `pi-desktop-import:subagent` 标记；原生 pi 子进程会话
  若以独立会话同步，则作为普通会话出现在树中（后续可扩展 parent 关联，本需求不做）。
- 参考工程 pi-web 为 React/Next 实现，本需求只借鉴**界面结构与交互范式**，技术栈保持
  Vue 3 + Element Plus，不复制其代码。
- 调试/测试环境：本机 Docker Desktop（compose 栈，端口 12380）+ Playwright。

## 8. 依赖
- 上游包：`@pi-agent-hub/protocol`（新增块类型）、`@pi-agent-hub/pi-session`（只读复用）。
- 工程：hub-service（101/102）、hub-console（201 重构）。
- 新增前端依赖：`md-editor-v3`（Vue 3 版，内置 xss 净化）。
- 外部：Docker Desktop、Playwright（MCP）。
