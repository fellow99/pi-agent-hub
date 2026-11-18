# 203-console-responsive-design — 任务清单（tasks.md）

> 依赖有序；Setup → Foundation → Story 1（断点底座）→ Story 2（侧栏 overlay）→ Story 3（composer 浮层）
> → Story 4（窄屏细节）→ Polish。关联：spec.md / plan.md / test-cases.md（同目录）。
> 分支：main（不改动）。所有提交走 Conventional Commits，仅暂存本会话改动文件。

## Setup
- [x] T001 建日志目录 `logs/20261118-1/` 与 DEV_CHECKLIST.md；记录基线（typecheck/test 8 passed/build 均绿）
- [x] T002 记录 Docker 栈现状（pi-hub-nginx 12380、console、service healthy）与 Playwright MCP 能力

## Foundation — 断点底座（FR-203-001~003）
- [x] T003 新建 `src/composables/viewport.ts`（断点常量 1023/480 + `classifyViewport` 纯函数）与
      `src/composables/useViewport.ts`（模块级 matchMedia 单例 + resize 兜底 + rAF 去重，
      状态统一由 classifyViewport(innerWidth) 派生）
- [x] T004 新建 `src/__tests__/viewport.test.ts`：classifyViewport 真值表（0/480/481/1023/1024/1440）
      + 断点常量 + styles.css 媒体查询漂移防护；vitest 13 passed

## Story 1 — Viewer 双模式与侧栏 overlay（FR-203-004~016, 022, 025~027）
- [x] T005 `views/Viewer.vue`：状态拆分（desktopRightCollapsed / leftDrawerOpen / rightDrawerOpen）、
      isCompact/isNarrow watch 复位、互斥开合、Esc 监听、selectSession 窄屏自动关左栏、按模式分派的右栏开合 handler
- [x] T006 `views/Viewer.vue` 模板：遮罩、左右 aside 单实例 + `panel-drawer`/`is-open` class、
      左右浮动按钮（fab）、宽屏右栏零宽收起后的浮动展开按钮、aria 标注（role=dialog 仅 compact）
- [x] T007 `styles.css`：宽屏 Grid 右栏收起轨道改 0 + `.right-panel { display:none }`；
      compact 媒体查询（1023）单栏 Grid、fixed 抽屉/遮罩/fab、transform 过渡、reduced-motion 降级；
      narrow（480）抽屉 85vw；overlay 打开时隐藏其余 fab
- [x] T008 `App.vue`/`styles.css`：narrow 隐藏 `.topbar-sub`；transcript 防横向滚动兜底
- [x] T009 typecheck + build 通过；Playwright 宽屏回归（1920/1280 三栏与现状一致）+ 窄屏
      （390/768/800）overlay 开合初验

## Story 2 — ChatComposer 浮层化（FR-203-017~021）
- [x] T010 `components/TranscriptPane.vue`：composerOpen 状态、isCompact/session watch 复位、
      浮动按钮与 backdrop、sent 成功自动收起、Esc 关闭、role=dialog/aria-modal 接线
- [x] T011 `components/ChatComposer.vue` + `styles.css`：根节点浮层 class 钩子、compact 下
      fixed bottom sheet（z 960）/backdrop（z 959）样式；内部功能与 scoped 样式保持不动
- [x] T012 Playwright 验证 admin 浮层展开/控件齐全/发送按钮启用与 viewer 只读禁用态（真实发送在 Testing 阶段）

## Story 3 — 窄屏细节与适配（FR-203-023~024）
- [x] T013 `FileTreePanel.vue`：el-drawer size 接 useViewport（compact 90% / wide 50%）
- [x] T014 `styles.css`：登录页 narrow 边距适配；turn/meta/pre 窄屏排版复查
- [x] T015 横竖屏实时切换矩阵（390×844 ↔ 844×390、768×1024 ↔ 1024×768、800×600 ↔ 1280×720、
      1023/1024 边界）Playwright 验证，截图存档 logs/20261118-1/shots/

## Polish — 评审与全量验证
- [x] T016 全量 typecheck / vitest(13) / build 门禁
- [x] T017 重建 `hub-console` Docker 镜像并在 12380 完成 test-cases.md 全量用例：
      28 PASS / 0 FAIL / 2 待外部环境验证；产出 logs/20261118-1/TEST_REPORT.md（含真实发送联调）
- [x] T018 requesting-code-review 子代理评审 → REVIEW_REPORT.md → receiving-code-review 逐条处置
      （0 Critical；Important 4 项：#1 运行时接 classifyViewport、#2 composer a11y/Esc、
      #3 CSS 漂移测试、#4 Playwright 证据转 Testing 阶段；Minor 接受 #1/#2/#6，#3/#4/#5 记录）
- [x] T019 修复点独立回归（R1~R5 全 PASS、应用 console 零错误、门禁 13 tests/typecheck/build 全绿）；
      spec 状态更新 Implemented；SPECS_CHECKLIST 沿用现状不登记（202/207 同未登记）；文档提交
