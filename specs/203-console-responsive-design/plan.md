# 203-console-responsive-design 技术方案（Plan）

> Module: 203-console-responsive-design
> Last Updated: 2026-11-18
> 依据：spec.md（同目录）、`packages/hub-console` 现状源码、pi-web `useIsMobile.ts` / `AppShell.tsx`
> 约束：纯前端改动；不新增依赖；分支 main 不变；仅改 `packages/hub-console` 与其规格/日志文档。

## 1. 总体设计

沿用 pi-web 的「JS 断点单例 + CSS 双模式 + 桌面/移动状态分离」思路，落到 Vue 3 组合式 API：

```text
composables/useViewport.ts          新增：matchMedia 单例 + classifyViewport 纯函数 + 断点常量
styles.css                          改造：Grid 宽屏模式（右栏零宽收起）+ compact 覆盖层体系
views/Viewer.vue                    改造：双模式容器、桌面/移动两套开合状态、浮动按钮、Esc/遮罩
components/TranscriptPane.vue       改造：窄屏 composer 浮层开关接线
components/ChatComposer.vue         改造：外壳浮层化（class 钩子 + 发送成功事件），内部功能不动
components/FileTreePanel.vue        小改：el-drawer size 随断点 90%/50%
App.vue                             小改：narrow 下隐藏副标题（纯 CSS 即可，无需脚本）
views/Login.vue                     不改脚本，CSS 适配（styles.css）
composables/viewport.ts             新增：断点常量 + classifyViewport 纯函数（无 window，node 可测）
__tests__/viewport.test.ts           新增：classifyViewport 单测 + CSS 媒体查询漂移防护
```

核心原则：**DOM 结构尽量不变，靠根 class 切换两套 CSS**。左右栏的面板组件
（SessionTreePanel / FileTreePanel / SubagentPanel）保持单实例，避免 v-if 重建导致
el-tree 重新拉数据；overlay 化通过同一节点在 compact class 下切换 `position: fixed` 实现。

## 2. useViewport composable（FR-203-001~003）

新建 `src/composables/useViewport.ts`：

```ts
export const COMPACT_MAX_WIDTH = 1023; // compact: max-width:1023px
export const NARROW_MAX_WIDTH = 480;   // narrow:  max-width:480px

export interface ViewportClass { isCompact: boolean; isNarrow: boolean; }

/** 唯一断点判定纯函数：composable 与单测共用，禁止组件内另写魔法数字。 */
export function classifyViewport(width: number): ViewportClass {
  return { isCompact: width <= COMPACT_MAX_WIDTH, isNarrow: width <= NARROW_MAX_WIDTH };
}

const compactMql = window.matchMedia(`(max-width: ${COMPACT_MAX_WIDTH}px)`);
const narrowMql  = window.matchMedia(`(max-width: ${NARROW_MAX_WIDTH}px)`);
const isCompact = ref(compactMql.matches);
const isNarrow  = ref(narrowMql.matches);
compactMql.addEventListener("change", (e) => { isCompact.value = e.matches; });
narrowMql.addEventListener("change",  (e) => { isNarrow.value  = e.matches; });

export function useViewport() { return { isCompact, isNarrow }; }
```

- 模块级单例，句柄与监听只注册一次（与 `useTheme.ts` 同构）。
- 纯 SPA 无 SSR，不需要 pi-web 的 server snapshot 兜底。
- 实际拆为 `viewport.ts`（常量 + 纯函数，无 window 依赖）与 `useViewport.ts`（事件接线）；
  运行时状态统一由 `classifyViewport(window.innerWidth)` 派生，MQL/resize 仅作触发源（FR-203-002）。
- 单测只测 `viewport.ts`（node 环境无 matchMedia），覆盖 480/1023/1024/1440 边界。

## 3. Viewer 状态模型与双模式（FR-203-004~016）

### 3.1 状态拆分（对照 pi-web desktopSidebarOpenRef）

```ts
const { isCompact, isNarrow } = useViewport();
const desktopRightCollapsed = ref(false);          // 宽屏偏好：替代现有 rightCollapsed
const leftDrawerOpen = ref(false);                 // 窄屏 overlay
const rightDrawerOpen = ref(false);
const rightTab = ref<"files" | "subagents">("files");   // 沿用
const jumpSubagentId = ref<string | null>(null);        // 沿用
const selectedSession = ref<SessionSummary | null>(null); // 沿用
```

联动规则（watch isCompact）：
- 进入 compact：`leftDrawerOpen = rightDrawerOpen = false`（FR-203-009/015）。
- 进入 wide：两个 drawer 强制 false，Grid 按 `desktopRightCollapsed` 渲染（FR-203-015）。
- 打开任一 drawer 时关闭另一个（FR-203-012）。
- `selectSession()`（左栏 session 点击）后：若 compact 则 `leftDrawerOpen = false`（FR-203-014），
  其余逻辑（rightTab 复位、jumpSubagentId 清空）保持现状。
- Esc 键：compact 下 `keydown` 监听，按打开优先级 right > left 关闭；组件卸载移除监听。

### 3.2 模板结构（单实例 + 根 class 切模式）

```html
<div class="viewer" :class="{
  'viewer--compact': isCompact,
  'viewer--narrow': isNarrow,
  'viewer--right-collapsed': !isCompact && desktopRightCollapsed,
}">
  <!-- 遮罩：仅 compact 且任一 drawer 打开时渲染 -->
  <div v-if="isCompact && (leftDrawerOpen || rightDrawerOpen)"
       class="viewer-overlay" aria-hidden="true" @click="closeDrawers" />

  <aside class="left-panel panel-drawer panel-drawer--left"
         :class="{ 'is-open': !isCompact || leftDrawerOpen }"
         role="dialog" aria-label="会话列表">
    <SessionTreePanel ... />
  </aside>

  <section class="center-panel"> ... TranscriptPane ... </section>

  <aside class="right-panel panel-drawer panel-drawer--right"
         :class="{ 'is-open': (!isCompact && !desktopRightCollapsed) || rightDrawerOpen }"
         role="dialog" aria-label="文件与子 agent">
    ...现有 right-header / right-body（v-if 收起判定改为按模式计算）...
  </aside>

  <!-- 浮动触发按钮：仅 compact 显示，打开时隐藏自身 -->
  <button class="fab fab--left"  v-if="isCompact && !leftDrawerOpen" ...>会话</button>
  <button class="fab fab--right" v-if="isCompact && !rightDrawerOpen" ...>
    <el-icon><Files /></el-icon>
  </button>
  <!-- 宽屏右栏收起后的浮动展开按钮 -->
  <button class="fab fab--right-restore"
          v-if="!isCompact && desktopRightCollapsed" @click="desktopRightCollapsed = false"
          aria-label="展开右栏"><el-icon><DArrowRight /></el-icon></button>
</div>
```

要点：
- 右栏头部现有收起按钮在 compact 下语义变为「关闭 overlay」（`rightDrawerOpen=false`），
  wide 下维持「折叠桌面右栏」（`desktopRightCollapsed=true`），用一个 handler 按模式分派。
- `right-header` 内 radio/tab 在 compact overlay 中保留；收起按钮图标方向按开合状态切换（沿用 DArrow*）。
- 浮动按钮用原生 `<button>` + EP 图标，避免 el-button 默认样式在 fixed 定位下的边距问题。

### 3.3 CSS 双模式（styles.css）

宽屏（默认，即现有规则的修正）：

```css
.viewer { grid-template-columns: 320px minmax(0,1fr) 380px; }
.viewer--right-collapsed { grid-template-columns: 320px minmax(0,1fr) 0; } /* 替换 40px */
.viewer--right-collapsed .right-panel { display: none; }
```

compact 覆盖（媒体查询与 composable 断点同值，注释互相引用）：

```css
@media (max-width: 1023px) {
  .viewer { grid-template-columns: minmax(0,1fr); }       /* 单栏 */
  .panel-drawer {
    position: fixed; top: 48px; bottom: 0; z-index: 901;
    width: 300px; background: var(--surface);
    transition: transform .25s ease; visibility: hidden;
  }
  .panel-drawer--left  { left: 0;  transform: translateX(-100%); }
  .panel-drawer--right { right: 0; width: 360px; transform: translateX(100%); }
  .panel-drawer.is-open { transform: translateX(0); visibility: visible; }
  .viewer-overlay { position: fixed; inset: 48px 0 0 0; z-index: 900;
                    background: rgb(0 0 0 / .45); }
  .fab { position: fixed; top: 50%; transform: translateY(-50%); z-index: 950; ... }
  .fab--left { left: 8px; } .fab--right { right: 8px; }
}
@media (max-width: 480px) {
  .panel-drawer { width: 85vw !important; }
  .topbar-sub { display: none; }
}
```

- `top: 48px` 锚定 topbar 高度（`.app-topbar` 现有 `flex: 0 0 48px`），遮罩与抽屉均不盖 topbar。
- `visibility:hidden` + transform 双保险：隐藏时不可点击且不占 Grid（compact 单列本就不含它们）。
- 深色皮肤遮罩/浮层全部走既有 `--surface`/`--border` 变量，不写死颜色（FR-203-026）。
- `prefers-reduced-motion` 下关闭 transform 过渡（跟随 pi-web 的可访问性惯例）。

## 4. ChatComposer 浮层化（FR-203-017~021）

状态归属 `TranscriptPane.vue`（composer 的直接父组件）：

```ts
const { isCompact } = useViewport();
const composerOpen = ref(false);
watch(isCompact, (v) => { if (v) composerOpen.value = false; });   // 进窄屏默认收起
watch(() => props.session?.id, () => { composerOpen.value = false; }); // 切会话复位（FR-203-020）
function onComposerSent() { composerOpen.value = false; void loadTail(); } // 发送成功收起（FR-203-019）
```

模板：

```html
<template v-if="session">
  ...scroll 区...
  <!-- 窄屏浮动入口 / 宽屏直接常驻 -->
  <button v-if="isCompact" class="fab fab--composer" aria-label="打开聊天输入">
    <el-icon><ChatDotRound /></el-icon>
  </button>
  <div v-if="isCompact && composerOpen" class="composer-backdrop" @click="composerOpen = false"></div>
  <ChatComposer
    :class="['composer-sheet', { 'composer-sheet--open': !isCompact || composerOpen }]"
    :session="session" @sent="onComposerSent" />
</template>
```

ChatComposer 内部改动最小化：
- 根节点 class 增加可被父级控制的钩子；现有 scoped 样式中 `position: sticky; bottom: 0`
  在 compact 被 `styles.css` 覆盖为 `position: fixed; left/right/bottom; z-index: 960`，
  配 `.composer-backdrop`（z 959）。
- 失败/超时不收起的行为天然成立：`sent` 事件只在 completed 分支 emit（现状代码已如此），
  父级据此自动满足 FR-203-019 的失败保持展开。
- viewer 只读：浮动按钮照常显示，展开后内部 `disabled` 与横幅逻辑原样保留。
- 宽屏下 `composerOpen` 不参与渲染（class 恒 open），现有常驻外观零变化。

## 5. 其余适配点

- **FileTreePanel el-drawer size（FR-203-024）**：注入 `useViewport()`，
  `:size="isCompact ? '90%' : '50%'"`；append-to-body 保持，z-index 由 EP 自身管理（2000+，
  天然高于自定义 9xx 层，满足 FR-203-021）。
- **登录页（FR-203-023）**：`styles.css` 增加 `@media (max-width:480px)` 下
  `.login { margin: 6vh 16px; padding: 20px; max-width: none; }`。
- **正文防横向滚动（FR-203-025）**：compact 下 `.transcript-meta` 允许折行（现已 flex-wrap）、
  `.turn` 内 pre 维持块内滚动；给 `.transcript-scroll` 补 `overflow-x: hidden` 兜底。
- **App.vue**：无需脚本改动，副标题隐藏走 CSS（`.viewer--narrow` 作用域在 Viewer 内，
  故 topbar 副标题用独立媒体查询 `@media (max-width:480px)`）。

## 6. 测试策略

1. **vitest 单测**（新增 `__tests__/viewport.test.ts`）：
   - `classifyViewport`：0/480/481/1023/1024/1440 宽度下 isCompact/isNarrow 真值表；
   - 断点常量与 CSS 媒体查询值一致性：readFileSync 读 styles.css，正则提取全部
     `@media (max-width: Npx)` 并断言 N 属于 viewport.ts 常量集合，防 JS/CSS 双写漂移。
2. **typecheck + build 门禁**：每轮改动后跑 `pnpm --filter @pi-agent-hub/hub-console typecheck`
   与 `build`，零新增 TS 错误、构建成功。
3. **Playwright（Docker 12380，重建 hub-console 镜像后）**：按 test-cases.md 执行，
   用 `browser_resize` 精确切换 390×844 / 844×390 / 768×1024 / 1024×768 / 1280×720 /
   1440×900 / 1920×1080，截图 + DOM 断言（getBoundingClientRect 宽度/占位、computed style、
   浮动按钮可见性）+ console 无错误；登录 admin/viewer 双角色。
4. **回归**：宽屏 1920/1280 下三栏外观与现状逐屏对比；主题三态在 compact/wide 各抽检。

## 7. 风险与对策

| 风险 | 对策 |
|---|---|
| fixed 面板在 iOS Safari 底部工具栏抖动 | 面板锚 `top:48px;bottom:0` 不依赖 100vh；Playwright 真机尺寸模拟 + 标注 iOS 待真机 |
| EP el-tree 在容器 display/transform 切换时懒加载异常 | 面板节点不 v-if、仅 transform 隐藏，组件始终挂载；沿用现有 lazy load 观察 |
| 遮罩拦截右栏内 el-drawer/弹层操作 | 自定义层 z-index 全部 ≤960，EP 弹层 2000+ 在上；文件抽屉 append-to-body |
| 断点 JS 与 CSS 漂移 | 断点常量单一来源；单测 readFileSync 解析 styles.css 媒体查询做集合断言 |
| 聊天浮层与软键盘遮挡 | bottom sheet 锚 bottom，textarea autosize；真机键盘行为标 ⬜ 待真机验证 |

## 8. 提交规划（Conventional Commits，仅暂存本会话文件）

1. `feat(hub-console): add responsive viewport composable and compact overlay layout`
2. `feat(hub-console): make chat composer collapsible floating sheet on compact viewports`
3. `test(hub-console): add viewport classifier unit tests`
4. 评审修复：`fix(hub-console): ...`（按实际项）
5. 规格/日志文档：`docs(hub-console): add 203 responsive design spec and phase logs`
