# 203-console-responsive-design 功能规格（Specification）

> Module: 203-console-responsive-design
> Status: In-progress
> Last Updated: 2026-11-18
> 涉及工程：`pi-agent-hub` / `packages/hub-console`（纯前端，无服务端改动）
> 参考实现：`pi-web`（`hooks/useIsMobile.ts` + `components/AppShell.tsx` 的 overlay drawer 模式）

## 1. 模块概述

### 1.1 目的

hub-console 公网页面（如 `https://fellow99.xicp.net/hub-service/hub/`）当前仅按桌面宽屏三栏
Grid 布局（`320px | 1fr | 380px`），在手机/平板等移动设备、横竖屏切换与多种分辨率下不可用或
空间被严重挤占。本需求为 hub-console 增加响应式布局能力，且不改动既有深浅皮肤（已支持跟随系统）。

### 1.2 解决的问题

- 移动端（手机竖/横屏、平板竖屏）空间不足，三栏并排无法使用。
- 横竖屏旋转 / 窗口尺寸变化时布局不能实时自适应。
- 右栏手动收起后 Grid 第三列仍占 `40px` 轨道（`styles.css` 中
  `.viewer--right-collapsed { grid-template-columns: 320px minmax(0,1fr) 40px }`），收起不彻底。
- 底部 `ChatComposer` 常驻，窄屏下挤压正文阅读区。

### 1.3 范围

- 包含：
  - 视口断点 composable（`matchMedia` 单例，模块级状态，与 `useTheme` 同风格）。
  - `Viewer.vue` 双模式布局：宽屏 Grid（现状改进）/ 窄屏 overlay 浮动抽屉（左右栏不占布局空间）。
  - 浮动触发按钮、遮罩、Esc/点遮罩关闭、选中会话后左栏自动收起。
  - 宽屏右栏收起改为零宽度 + 浮动展开按钮。
  - `ChatComposer` 窄屏默认收起为浮动按钮，点击上浮展开；宽屏维持常驻。
  - 窄屏细节：topbar 副标题隐藏、登录页边距适配、文件内容抽屉宽度适配。
- 不包含：
  - 主题机制改造（`useTheme` 已实现 system/light/dark 实时跟随，保持不动）。
  - 服务端 / API / 协议任何改动。
  - 新增第三方依赖（不引入 UI 框架，纯 CSS + Vue 组合式 API + 既有 Element Plus）。
  - 桌面宽屏下的左栏手动收起（现状左栏本就不可收起，不新增未要求的行为）。

## 2. 用户故事

- 作为手机用户，我竖屏打开 hub-console 时看到完整的正文主区，两侧栏与聊天栏默认收起为浮动按钮，
  点击按钮才浮出对应面板，面板不挤占正文空间。
- 作为平板/手机用户，我在横屏与竖屏之间旋转设备时，布局实时切换且无需刷新；切回宽屏后我之前的
  桌面端右栏开合偏好仍然保留。
- 作为桌面用户，我手动收起右栏后它不再占据任何宽度，需要时通过边缘浮动按钮一键展开，其余体验
  与现状完全一致。
- 作为 admin，我在窄屏下通过浮动按钮展开聊天栏、输入并发送消息，发送成功后聊天栏自动收起；
  作为 viewer，浮动入口仍在但展开后为禁用态与「只读账号无法下发」提示（与现状权限语义一致）。
- 作为任意用户，我在浮动面板打开时点击半透明遮罩或按 Esc 即可关闭；在左栏选中某个会话后左栏
  自动收起，直接露出该会话正文。

## 3. 断点与布局模式

| 模式 | 媒体查询 | 典型设备 | 布局 |
|---|---|---|---|
| 宽屏 wide | `(min-width: 1024px)` | 桌面、平板横屏 | 三栏 Grid（同现状结构，右栏收起轨道宽度改为 0） |
| 窄屏 compact | `(max-width: 1023px)` | 手机竖/横屏、平板竖屏 | 单栏主区；左右栏均为 `position: fixed` overlay 抽屉，默认关闭，不占布局；聊天栏默认收起 |
| 极窄 narrow（compact 子集） | `(max-width: 480px)` | 手机竖屏 | 抽屉宽度收窄为 85vw；topbar 隐藏副标题；登录页减小边距 |

断点依据：pi-web 移动断点为 640px，但本应用为三栏（左 320 + 右 380 = 700px 固定侧栏），
低于 1024px 时三栏并排主区已不足 320px，不可用，故 compact 上界取 1023px；480px 与 pi-web
narrow 断点对齐。断点常量由 composable 与 CSS 共享同一定义，禁止两边各写魔法数字。

## 4. 功能需求

### 4.1 视口状态 composable

- FR-203-001: MUST 新增 `src/composables/useViewport.ts`，导出模块级单例 `isCompact`
  （`max-width: 1023px`）与 `isNarrow`（`max-width: 480px`）两个 `Ref<boolean>`，
  基于 `window.matchMedia` 监听 `change` 事件实时更新（旋转/拖窗即触发，不依赖 orientation 事件）。
- FR-203-002: MUST 导出纯函数 `classifyViewport(width: number): { isCompact: boolean; isNarrow: boolean }`
  作为唯一断点判定逻辑，composable 与单元测试共用；断点常量命名导出。
- FR-203-003: 监听器 MUST 在 SPA 生命周期内只注册一次（模块级 `matchMedia` 句柄复用，与
  `useTheme.ts` 的模块级单例风格一致），不得在每个组件实例上重复注册。

### 4.2 宽屏模式（≥1024px）

- FR-203-004: 三栏 Grid 默认表现 MUST 与现状一致（`320px | 1fr | 380px`，1px 间隙，主题变量不变）。
- FR-203-005: 右栏手动收起后第三列轨道宽度 MUST 为 0（替换现有 40px 轨道），右栏不占据任何
  可视宽度；主区获得全部剩余空间。
- FR-203-006: 右栏收起状态下 MUST 在视口右缘提供一个浮动展开小按钮（垂直居中、带 aria-label），
  点击恢复 380px 右栏；按钮在右栏展开时不出现。
- FR-203-007: 宽屏下的右栏开合状态（桌面偏好）MUST 与窄屏 overlay 开关状态相互独立；
  在窄屏开合抽屉不得改变宽屏偏好，跨断点往返后宽屏偏好保持（参考 pi-web `desktopSidebarOpenRef`）。
- FR-203-008: 左栏在宽屏下保持常驻（维持现状），不新增手动收起入口。

### 4.3 窄屏模式（≤1023px）

- FR-203-009: 进入窄屏时左右栏 overlay MUST 默认关闭，主区（正文/空态）占满整个 `.app-body`。
- FR-203-010: 左栏 overlay：左侧滑入浮动面板（宽 300px，narrow 时 85vw），含既有
  `SessionTreePanel` 全部功能；视口左缘显示浮动「会话」触发按钮，打开时按钮隐藏。
- FR-203-011: 右栏 overlay：右侧滑入浮动面板（宽 360px，narrow 时 85vw），含既有
  文件/子 agent 两个 tab 与头部收起按钮；视口右缘显示浮动触发按钮，打开时按钮隐藏。
- FR-203-012: overlay 打开时 MUST 显示半透明遮罩；点击遮罩或按 Esc MUST 关闭当前 overlay；
  左右 overlay 同一时刻最多打开一个（打开其一时另一个自动关闭）。
- FR-203-013: overlay 面板 MUST `position: fixed` 且不参与 Grid 布局（收起时不占任何宽度，
  含 `display:none`/transform 隐藏，不可见且不可点击）。
- FR-203-014: 在左栏选中会话（session 级节点点击）后 MUST 自动关闭左栏 overlay，主区展示
  新选中会话；右栏的选中/打开行为不自动关闭（文件树交互需连续操作）。
- FR-203-015: 从窄屏跨入宽屏时，所有 overlay MUST 关闭并按宽屏偏好渲染三栏；从宽屏跨入窄屏时
  overlay 默认关闭（FR-203-009），无残留遮罩/面板。
- FR-203-016: 浮动按钮与遮罩 MUST 带 `aria-label`；遮罩 `aria-hidden="true"`；面板带
  `role="dialog"` 与可读名称，保证基本可访问性。

### 4.4 聊天栏响应式

- FR-203-017: 窄屏下 `ChatComposer` MUST 默认收起（不渲染常驻底部条，不占正文空间），
  右下角显示浮动触发按钮；宽屏下维持现状常驻 `TranscriptPane` 底部。
- FR-203-018: 窄屏点击浮动按钮后，composer MUST 以底部浮层（bottom sheet，含独立遮罩）展开，
  完整保留既有功能：图片选择/预览/拖拽、模型与思考深度选择、策略、发送、状态轮询、只读禁用与
  「只读账号无法下发」横幅。
- FR-203-019: 窄屏发送成功（delivery 到达 completed）后 composer 浮层 MUST 自动收起；
  发送失败/超时时保持展开并展示错误；未选会话时浮动按钮不出现。
- FR-203-020: 切换会话时窄屏 composer MUST 回到默认收起态，草稿/图片等既有清空逻辑不变。
- FR-203-021: composer 浮层与侧栏 overlay 的遮罩/层级 MUST 互不遮挡失效：文件内容 el-drawer
  （EP 默认 z-index 2000+）始终在最上层；自定义层采用 backdrop 900 / 侧栏 901 /
  composer 遮罩 959 / composer 浮层 960 / 浮动按钮 950 的固定层级。

### 4.5 窄屏细节适配

- FR-203-022: topbar 在 narrow（≤480px）下 MUST 隐藏 `.topbar-sub` 副标题，品牌与操作按钮保留。
- FR-203-023: 登录页在窄屏下 MUST 保留可用边距（左右各 ≥16px），表单控件不溢出视口。
- FR-203-024: `FileTreePanel` 的文件内容 el-drawer 在 compact 下 size MUST 为 `90%`
  （宽屏维持 `50%`），由 composable 驱动计算，不写死两套组件。
- FR-203-025: 正文 transcript 的元信息行、turn 卡片、代码块在窄屏下 MUST 不出现横向滚动条
  （代码块保持块内滚动），长路径/长标题继续省略号或换行。

### 4.6 主题与兼容

- FR-203-026: 浅/深两套皮肤在所有断点与 overlay/composer 浮层下 MUST 均正确（浮层背景、边框、
  遮罩颜色随主题变量），跟随系统切换实时生效（既有能力，回归验证即可）。
- FR-203-027: 部署形态不变：相对 base 构建、`/hub/` 与 `/hub-service/hub/` 两种路径下
  响应式行为一致；不新增构建依赖。

## 5. 关键实体 / 状态

| 状态 | 所在 | 说明 |
|---|---|---|
| `isCompact` / `isNarrow` | useViewport 单例 | 视口断点实时状态 |
| `desktopRightCollapsed` | Viewer | 宽屏右栏偏好，跨断点保持，替代现有 `rightCollapsed` |
| `leftDrawerOpen` / `rightDrawerOpen` | Viewer | 窄屏 overlay 开关，进入 compact 复位为 false |
| `composerOpen` | TranscriptPane | 窄屏 composer 浮层开关，默认 false，切会话/发送成功复位 |
| `rightTab` / `jumpSubagentId` | Viewer | 沿用现状，右栏 overlay 内继续生效 |

无新增服务端实体、无 localStorage 新键（桌面偏好不持久化，与现状 `rightCollapsed` 一致）。

## 6. 验收场景

### 场景 1：手机竖屏默认布局
- Given 视口 390×844（compact+narrow）且已登录
- When 打开查看器
- Then 主区占满 body；左右栏不可见且不占宽度；左右缘各有一个浮动按钮；右下角有聊天浮动按钮；
  topbar 无副标题。

### 场景 2：overlay 开合与关闭手势
- Given 手机竖屏布局
- When 点击左缘浮动按钮
- Then 左栏 85vw 浮层滑入、遮罩出现、左按钮隐藏；点遮罩后浮层关闭、按钮恢复；
  再打开后按 Esc 同样关闭。

### 场景 3：选中会话自动收起左栏
- Given 左栏 overlay 打开
- When 点击某个 session 节点
- Then 左栏自动关闭，主区加载该会话正文；右栏 overlay 未被打开。

### 场景 4：横竖屏实时切换
- Given 390×844 竖屏且右栏 overlay 曾打开过
- When 旋转为 844×390（仍 compact）
- Then 布局不刷新即自适应，overlay 复位为关闭；再调整窗口到 1280×720（wide）
- Then 三栏 Grid 出现并按宽屏偏好渲染，无残留遮罩；拖回 800×600 后又回到单栏 + 浮动按钮。

### 场景 5：宽屏右栏零宽度收起
- Given 视口 1440×900
- When 点击右栏头部收起按钮
- Then 第三列宽度为 0，主区扩展到右缘；视口右缘出现浮动展开按钮；点击后右栏恢复 380px。

### 场景 6：窄屏聊天发送闭环
- Given admin 已在 compact 模式选中会话
- When 点聊天浮动按钮 → 输入文本 → 发送
- Then 浮层内展示排队/执行状态，completed 后浮层自动收起、正文尾部刷新出新消息；
  viewer 账号同一入口展开后控件禁用并显示只读横幅。

### 场景 7：主题回归
- Given 任一断点布局
- When 系统在浅/深色间切换（或手动切 mode）
- Then 浮层、遮罩、浮动按钮、composer 配色全部跟随，无白底白字等不可读组合。

### 场景 8：文件抽屉层级
- Given compact 模式右栏 overlay 打开
- When 点击文件树中的文本文件
- Then el-drawer 以 90% 宽度盖在所有自定义浮层之上，内容可读、可关闭。

## 7. 非功能需求

- 性能：断点监听 O(1)；overlay 用 CSS transform/opacity 过渡，不引起整页重排风暴；
  不新增运行时依赖，产物体积增量仅本包源码。
- 兼容性：目标 Chromium/Edge/Safari 近年版本（matchMedia、position:fixed、CSS Grid 均为基线能力）。
- 质量门禁：`pnpm --filter @pi-agent-hub/hub-console typecheck` 零错误、vitest 全绿（含新增
  useViewport 单测）、`build` 成功；Playwright 在 1920/1280/1024/800/768/480/390 等宽度与
  横竖屏组合下完成 test-cases.md 全部 P1 用例。

## 8. 假设与约束

- 仅改造 `packages/hub-console`，通过重建 `hub-console` Docker 镜像在 12380 环境验证，
  不动 nginx/服务端编排。
- 断点 1024/480 为本需求新立约定，如后续 pi-web 调整不强制联动（仅参考其模式）。
- 不做触摸手势滑动（swipe）开关抽屉，仅按钮 + 遮罩 + Esc（YAGNI，需求未要求）。
