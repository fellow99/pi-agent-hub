# 202-console-session-viewer 技术方案（Plan）

> Module: 202-console-session-viewer
> Last Updated: 2026-11-12
> 依据：spec.md（同目录）、specs/101-service-http、specs/102-service-storage、specs/201-console-shell
> 数据源事实：Docker 测试库 1860 会话 / 205,110 条 message / 13,202 条 subagent marker（2026-11-12 实测）

## 1. 总体设计

保持既有分层：`hub-service` 提供只读 GET API（Express 路由 + SessionStore 镜像扫描），
`hub-console` 纯前端渲染（Vue 3 + Element Plus + md-editor-v3），不引入新表、不改同步链路。

```text
hub-service（新增/修改）
  protocol/src/index.ts          TranscriptBlock 增加 subagentMarker；新增响应 DTO 类型
  session-store.ts               toTranscriptItem 修复（arguments/toolResult/custom）
                                 + 新增 scanFileTree() / readFileContent() /
                                   listSubagents() / subagentTranscript()
  app.ts                         新增 4 个 GET 路由 + session-tree 路由；LRU 缓存
hub-console（重构）
  api.ts                         新接口客户端与类型
  router.ts / App.vue            单页三栏，移除旧栏目
  views/Viewer.vue               三栏容器
  components/SessionTreePanel.vue   左栏三级 el-tree
  components/TranscriptPane.vue     主区滚动分页 + MdPreview
  components/BlockCard.vue          非 markdown 块卡片
  components/FileTreePanel.vue      右栏文件树
  components/FileViewerPane.vue     文件查看器
  components/SubagentPanel.vue      子 agent 列表 + 子上下文
```

## 2. hub-service 详细设计

### 2.1 transcript 映射修复（session-store.ts，最小改动）

现状（已用容器数据证实的缺陷）：
- pi v3 toolCall part 结构为 `{ type:"toolCall", id, name, arguments }`，现有代码读
  `part.input` → 参数恒为 `undefined`。
- `role:"toolResult"` 消息被提前 return，只产出 text 块，丢失 toolName/callId/isError。
- `type:"custom"` 条目落到尾部兜底，输出 `{kind:"meta",label:"custom"}`，subagent 标记丢失。

改动点（`toTranscriptItem` 单函数内，保持 seq/分页契约不变 = FR-202-004）：
1. toolCall part：`input: part.input ?? part.arguments ?? null`。
2. toolResult 消息：遍历 content 取文本拼为 preview，输出
   `{ kind:"toolResult", callId: message.toolCallId, name: message.toolName ?? "",
      ok: !message.isError, preview, bytes: Buffer.byteLength(preview), truncated:false }`。
3. custom 条目：
   - `entry.type==="custom" && entry.customType==="pi-desktop-import:subagent"` 且 data 为 record
     → `{ kind:"subagentMarker", agentName:String(data.agentName??""),
          parentToolCallId:String(data.parentToolCallId??""), aMessageId:String(data.aMessageId??"") }`；
   - 其余 custom → 维持 meta 块，label 改用 `entry.customType ?? "custom"`（信息更明确，兼容现状）。

protocol 包 TranscriptBlock 联合类型追加：
```ts
| { kind: "subagentMarker"; agentName: string; parentToolCallId: string; aMessageId: string }
```

### 2.2 三级会话树（FR-202-005~007）

`GET /api/hub/session-tree?q=`
- 数据来自 `store.listSessions()`（已排除 deleted）+ `store.listAgents()` 建
  `(hostId,agentId)→kind` 映射。
- project key 归一化：`cwd.trim().replace(/\\/g,"/").replace(/\/+$/,"")`，再
  `toLocaleLowerCase()` 作为**键**；label 保留首个出现的 cwd 原文。
- 分组：`Map<projectKey, Map<nodeKey, SessionSummary[]>>`，nodeKey=`${hostId}|${agentId}`。
- 排序：project 按组内最大 updatedAt 降序；agentNode 按 hostId/agentId 升序；
  session 按 updatedAt 降序（listSessions 本身已 DESC，组内保持稳定）。
- `q` 过滤在分组前对 title/cwd/agentId/hostId includes（小写比较）。
- 响应：
```ts
interface SessionTreeResponse {
  projects: Array<{
    key: string; label: string; sessionCount: number;
    agents: Array<{ key: string; hostId: string; agentId: string; kind: string | null;
      sessionCount: number; sessions: SessionSummary[] }>;
  }>;
}
```

### 2.3 虚拟文件树（FR-202-008~010）

`GET /api/hub/sessions/:id/files`
- 复用 `readSessionFile(row.native_path)` 读取全部条目（线性镜像，单链）。
- 路径提取器（纯函数，便于单测）：
  - 结构化工具：part.type==="toolCall"，name 小写后命中
    `read/write/edit/apply_patch/glob/grep`；参数字段按优先级取
    `path → file_path → filePath`；edit 的 `edits[]/ops` 内 path 一并收集；
    glob/grep 的 `pattern` 仅当含 `/` 或 `\` 时取其 dirname。
  - bash：对 `command` 字符串跑正则提取引号内/空白间含路径分隔符的 token，
    标记 `confidence:"low"`，仅用于文件叶子补全，不创建目录断言之外的结构。
- 路径解析：含盘符或前导 `/`/`\` 视为绝对路径；相对路径 `join(cwd, p)`；
  统一 `replace(/\\/g,"/")`、去 `./`、折叠重复分隔符；以归一化 cwd 为根计算相对路径；
  `..` 越界者挂 `_outside/<保序编码后的原路径>`。
- 构建 `Map<pathKey, VirtualFileNode>`：遇目录段补 isDir 节点；叶子记录
  `touchedBy:Set<toolName>`、`hasContent`（write 工具或对应 toolResult 有文本时 true）。
- 上限：路径键 > 2000 停止累积并 `truncated:true`。
- 输出树状嵌套结构（children 按目录优先、名字典序）。

### 2.4 文件内容（FR-202-011~012）

`GET /api/hub/sessions/:id/files/content?path=`
- 入参 path 做与 2.3 相同的归一化得到 pathKey；先跑（或读缓存的）文件树索引校验键存在，
  不存在 → 404 `{error:{code:"file_not_tracked"}}`。
- 扫描条目（倒序，取最近）：
  1. 命中该 pathKey 的 write/Write toolCall → `source:"write_input"`，
      content 取 `input.content`（write 参数的文件正文）。
  2. 否则找 read/Read 的 toolCall，再按 callId 找对应 toolResult 文本 →
      `source:"read_result"`。
- content 超 256KB 截断，`truncated:true`；两者皆无 →
  `{ available:false, reason:"no_mirror_content" }`（HTTP 200）。
- 响应统一 `{ available, source, toolName, entrySeq, content, truncated, path }`。

### 2.5 子 agent（FR-202-013~016）

线性镜像中的实测结构（2026-11-12 对 hs_p9ha… 实测）：
- marker（custom 条目）紧邻其 `aMessageId` 消息之后；同一 `parentToolCallId` 的 marker
  界定该次委托的消息段；不同 parentToolCallId 的区间可以**嵌套**。

`GET /api/hub/sessions/:id/subagents`
- 线性扫描条目，收集 subagentMarker 块（经 2.1 修复后可直接识别，也可直接读 custom 条目），
  按 parentToolCallId 聚合：markerCount、firstTs/lastTs、agentName（取首个）。
- description：找同会话内 id 命中任一 marker.parentToolCallId 的 Task/task/subagent
  toolCall，取其 `input.description`（缺 null）。

`GET /api/hub/sessions/:id/subagents/:subagentId/transcript`
- subagentId 即 parentToolCallId；未知 → 404 `subagent_not_found`。
- 段归属算法（线性数组 entries，下标 i）：
  1. 收集全部 marker 下标及归属调用，得到 `markerPos: number[]`（升序）。
  2. 本调用 marker 集合 M；对每个 marker 位置 m，段区间为 `(m, nextMarkerPos)`，
     其中 nextMarkerPos 是**全局** markerPos 中 m 的下一个（不论归属）——这天然处理嵌套：
     内层 marker 切走自己的段，外层段被切分为多片，合并时去重。
  3. 收集区间内条目（排除 marker 自身），按原 seq 升序、按 entryId 去重，
     复用 `toTranscriptItem` 映射输出 `{ items, count }`。
- 无 marker 会话：列表返回 `{items:[]}`。

### 2.6 LRU 缓存与路由挂载（app.ts）

- 进程内 `Map` 实现简易 LRU（key=`${sessionId}:${row.updatedAt}`，容量 100），
  缓存文件树索引与 subagent 聚合；updatedAt 变化即缓存失效，无需失效广播。
- 新路由全部挂在现有 `/api/hub` 鉴权中间件之后、仅 GET：
  `GET /api/hub/session-tree`、`GET /api/hub/sessions/:id/files`、
  `GET /api/hub/sessions/:id/files/content`、
  `GET /api/hub/sessions/:id/subagents`、
  `GET /api/hub/sessions/:id/subagents/:subagentId/transcript`。
- 注意路由声明顺序：`:id` 系列与 `session-tree` 不冲突（字面量路径优先注册即可）。
- 错误风格沿用 `{error:{code,message}}`；镜像缺失复用 content_unavailable 语义（404）。

## 3. hub-console 详细设计

### 3.1 依赖与全局
- 新增 `md-editor-v3`（^7.x，Vue 3）；只用 `MdPreview` 组件，配置
  `:previewOnly`、关闭代码行号等编辑能力；其内部经 `xss` 包净化，满足 FR-202-030；
  全局引入其样式（`md-editor-v3/lib/preview.css` 或包入口 css）。
- 移除对 `markdown-it`/`dompurify` 的直接使用（MdPreview 接管），依赖可保留或移除
  （实现时确认无其他引用后从 package.json 删除，避免幽灵依赖）。

### 3.2 路由与壳
- `router.ts`：仅保留 `/login` 与 `/`（Viewer）；`/:pathMatch(.*)*` 重定向 `/`
  （FR 旧链接兜底）；登录后跳转 `/`。
- `App.vue`：登录页外不再渲染顶部 el-menu；保留品牌区与 Sign out；
  `<router-view/>` 全高铺满。删除 `views/Sessions.vue`、`Agents.vue`、`Hosts.vue`。

### 3.3 左栏 SessionTreePanel.vue
- onMounted 拉 `/api/hub/session-tree`；el-tree `:props="{label:'label',children:'children'}"`，
  三级节点用不同图标与插槽（project / host|agent+el-tag(kind) / session 标题+相对时间）。
- 节点 id：project 用 `p:${key}`、agent 用 `a:${key}`、session 用 `s:${session.id}`；
  当前选中 id 存于 Viewer，点击 session 节点 emit 切换。
- 顶部输入框绑定 `q`（300ms debounce 重新请求）+ Refresh 按钮；默认展开第一个 project。
- 1860 会话场景：el-tree 全量渲染 DOM 偏重，默认 project 折叠，仅渲染展开节点子树
  （先以 el-tree 原生能力实现；若实测卡顿再引入虚拟树，列入测试观察项）。

### 3.4 主区 TranscriptPane.vue
- props: `session: SessionSummary`；watch session.id 重置状态。
- 状态：`items(升序展示)`、`oldestSeq`、`hasMore`、`loading`、`error`。
- 首屏 tail=100；顶部哨兵 div + IntersectionObserver（root 为滚动容器）触发
  `loadOlder()`：守卫 `loading || !hasMore || cursor===oldestSeq`；请求后前置拼接，
  用加载前 DOM 高度差调 `scrollTop += delta`（在 nextTick 后）保持视觉位置。
- BlockCard.vue 按 kind 分发：
  - text → MdPreview（同一会话内 MdPreview 实例复用，markdown 配置统一）。
  - thinking → 折叠面板（el-collapse，默认折叠）。
  - toolCall → 卡片：工具名 el-tag + 参数 `<pre>` JSON（含修复后的 input）。
  - toolResult → 卡片：name、ok/error 状态色、preview `<pre>`。
  - bash → `$ command` + output 等宽块、exitCode。
  - subagentMarker → 信息条 + 「查看子 agent」按钮（切换右栏到对应 subagent）。
  - summary/meta/unknown → 弱化样式文本/kind 标签。
- 404 content_unavailable 与空 items 分别给空状态；错误 el-alert。

### 3.5 右栏
- `FileTreePanel.vue`：选中会话后拉 `/files`，el-tree 目录/文件图标（复用 Element 图标），
  叶子显示 touchedBy 小标签；点击叶子 → FileViewerPane 拉 `/files/content?path=`；
  `available:false` 显示提示卡片（工具名/entrySeq）；文本用 `<pre>` 等宽展示，
  截断时提示 truncated。
- `SubagentPanel.vue`：拉 `/subagents` 展示列表（agentName、description、markerCount、
  时间范围）；点击进入子上下文视图（BlockCard 复用，分页一次全量返回，超长则内部滚动），
  顶部返回按钮；主区 subagentMarker 的跳转按钮通过 Viewer 事件总线定位到具体调用。
- tab 切换 + 右栏折叠按钮；各面板数据以 sessionId 为键缓存于组件 Map（FR-202-028）。

### 3.6 api.ts
- 保留登录/CSRF/鉴权封装不变；新增 `getSessionTree(q?)`、`getSessionFiles(id)`、
  `getFileContent(id,path)`、`listSubagents(id)`、`getSubagentTranscript(id,subId)`；
  `getTranscript` 签名不变（tail/before 已有）。类型与 protocol DTO 对齐（前端本地声明，
  与现有 SessionSummary 写法一致，不引 protocol 包到前端）。

## 4. 接口契约清单（新增）

| 方法 | 路径 | 主要参数 | 响应（摘要） | 错误 |
|---|---|---|---|---|
| GET | /api/hub/session-tree | q? | `{projects:[{key,label,sessionCount,agents:[…sessions]}]}` | 401 |
| GET | /api/hub/sessions/:id/files | — | `{root, nodes/tree, truncated}` | 404 content_unavailable |
| GET | /api/hub/sessions/:id/files/content | path | `{available,source?,toolName?,entrySeq?,content?,truncated}` | 404 file_not_tracked |
| GET | /api/hub/subagents 见下 | — | — | — |
| GET | /api/hub/sessions/:id/subagents | — | `{items:[SubagentSummary]}` | 404 content_unavailable |
| GET | /api/hub/sessions/:id/subagents/:sid/transcript | — | `{items:TranscriptItem[],count}` | 404 subagent_not_found |

## 5. 测试设计（摘要，详见 test-cases.md）
- 后端：curl 直测 Docker 栈（12380）+ 纯函数级 vitest（路径提取/归一化、subagent 段归属）。
  仓库当前 test 为占位，本需求为 session-store 的纯解析逻辑补 vitest 用例（不引入 HTTP 测试框架）。
- 前端：Playwright MCP 对接 http://localhost:12380/hub/（Docker 栈重建后）或
  `pnpm dev:console`（5173 代理 8443 本地 hub）；覆盖登录、三级树、滚动分页、文件树、
  子 agent、XSS 文本、只读约束。
- 回归：`pnpm typecheck`、`pnpm build` 全绿；旧接口 `/api/hub/agents`、`/hosts` 仍 200。

## 6. 风险与对策
| 风险 | 对策 |
|---|---|
| 1860 会话全量树渲染卡顿 | 项目默认折叠 + 实测；必要时 el-tree-v2 虚拟列表（预案，不预先实现） |
| bash 路径误报污染文件树 | 低置信度标记、仅补叶子；结构化工具路径为权威来源 |
| 线性镜像丢失原始父子关系 | 子 agent 段归属基于 marker 线性位置而非 parentId，已用嵌套实测数据验证可行性 |
| MdPreview 包体积 | 仅引入 preview 组件与 css，构建后检查 chunk 体积（NFR 阈值 gzip <400KB 增量） |
| Docker 栈跑旧镜像 | 测试前本地 `docker compose up --build -d` 重建；数据卷保留真实数据 |

## 7. 宪法合规检查
- strict TS、NodeNext、ESM；无 `as any`/`@ts-ignore`/空 catch；错误走稳定 code 枚举。
- 新接口仅 GET、viewer 可读、无写库/无 FS 写入，遵守 hub-service 只写自身数据目录原则。
- 契约类型在 protocol 包扩展，前端本地镜像类型与现有风格一致。
- 最小改动修复 transcript 映射，不顺手重构无关代码。
