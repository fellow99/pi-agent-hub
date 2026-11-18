# Test Cases: 203-console-responsive-design（hub-console 响应式设计）

> 环境：Docker Desktop 栈 `http://localhost:12380/hub/`（重建 hub-console 镜像后）；
> UI 用 Playwright MCP（Chromium），`browser_resize` 精确切尺寸；账号 admin / viewer（deploy/data/hub-service.json）。
> 尺寸约定：手机竖屏 390×844、手机横屏 844×390、平板竖屏 768×1024、平板横屏 1024×768、
> 小窗口 800×600、桌面 1280×720 / 1440×900 / 1920×1080。

## A. 单元测试（vitest）

### TC-001: classifyViewport 断点真值表（P1，Functional）
- **Steps**: vitest 运行 use-viewport.test.ts，对宽度 0/480/481/1023/1024/1440 调用 classifyViewport
- **Expected**: ≤480 → compact=true,narrow=true；481~1023 → compact=true,narrow=false；
  ≥1024 → 两者皆 false；1023/1024 边界精确

### TC-002: 断点常量与 CSS 媒体查询一致（P2，Regression）
- **Steps**: 单测快照 COMPACT_MAX_WIDTH=1023、NARROW_MAX_WIDTH=480；grep styles.css 媒体查询同值
- **Expected**: 常量与 `@media (max-width:1023px)` / `(max-width:480px)` 完全一致

## B. 窄屏默认布局（compact）

### TC-010: 手机竖屏默认单栏、侧栏零占位（P1，Functional）
- **Precondition**: admin 已登录
- **Steps**: resize 390×844 打开 `/hub/`
- **Expected**: 仅中心主区可见；`.left-panel`/`.right-panel` boundingClientRect 宽度为 0 或不可见且不占布局；
  左右缘浮动按钮各 1 个可见；topbar 无副标题文字

### TC-011: 平板竖屏同样进入 compact（P1，Functional）
- **Steps**: resize 768×1024 刷新
- **Expected**: 同 TC-010（768 ≤ 1023）；抽屉宽度为 300/360px（非 85vw）

### TC-012: 极窄抽屉宽度 85vw（P2，Functional）
- **Steps**: 390×844 打开左栏 overlay
- **Expected**: 左栏面板宽度 ≈ 0.85×390（容差 ±2px）

## C. Overlay 交互

### TC-020: 左栏滑入、遮罩、点遮罩关闭（P1，Functional）
- **Steps**: 390×844 点左缘 fab → 断言面板可见、遮罩存在、左 fab 隐藏 → 点遮罩
- **Expected**: 面板 transform 归位隐藏、fab 恢复；无 console 错误

### TC-021: Esc 关闭 overlay（P1，Functional）
- **Steps**: 打开右栏 overlay → 按 Escape
- **Expected**: 右栏关闭、遮罩消失

### TC-022: 左右 overlay 互斥（P2，Functional）
- **Steps**: 打开左栏后点右缘 fab
- **Expected**: 左栏关闭、右栏打开，DOM 中遮罩仅 1 个

### TC-023: 选中会话自动关左栏并加载正文（P1，Functional）
- **Steps**: 左栏展开 → 点任一 session 节点
- **Expected**: 左栏自动关闭；主区出现该会话 transcript 标题与内容

### TC-024: 右栏文件/子 agent tab 在 overlay 内可用（P2，Functional）
- **Steps**: 打开右栏 → 切「子 agent」tab → 切回「文件」
- **Expected**: tab 切换正常，文件树懒加载/空态与宽屏行为一致

## D. 横竖屏 / 断点实时切换

### TC-030: 旋转不刷新即自适应（P1，Functional）
- **Steps**: 390×844 打开右栏 → resize 844×390
- **Expected**: 无刷新；overlay 复位关闭、无残留遮罩；浮动按钮位置按新高度垂直居中

### TC-031: compact → wide 三栏恢复且桌面偏好保留（P1，Functional）
- **Steps**: 1440×900 手动收起右栏 → resize 800×600（确认 compact）→ resize 回 1440×900
- **Expected**: 回宽屏后右栏仍为收起零宽态（desktopRightCollapsed 未被 compact 操作改写）

### TC-032: wide → compact 浮动体系出现（P1，Functional）
- **Steps**: 1280×720 三栏可见 → resize 768×1024
- **Expected**: 单栏 + 三个浮动按钮（左/右/聊天），无遮罩残留

### TC-033: 断点边界 1023/1024（P2，Edge Case）
- **Steps**: 分别 resize 1023×768 与 1024×768
- **Expected**: 1023 为 compact 单栏；1024 为 wide 三栏 Grid

## E. 宽屏右栏零宽收起

### TC-040: 收起后第三列零宽度（P1，Functional / 回归原 BUG）
- **Steps**: 1440×900 点右栏头部收起按钮
- **Expected**: `.viewer` computed grid-template-columns 第三段为 `0px`；右栏 boundingClientRect 宽度 0；
  主区右缘抵达视口右缘（扣除 1px 间隙）

### TC-041: 浮动展开按钮恢复 380px（P1，Functional）
- **Steps**: TC-040 后点右缘浮动展开按钮
- **Expected**: Grid 第三列恢复 380px，右栏内容（tab/body）原样显示

### TC-042: 宽屏桌面布局整体无回归（P1，Regression）
- **Steps**: 1920×1080 与 1280×720 截图对照改造前
- **Expected**: 三栏宽度、topbar、transcript、composer 常驻外观与改造前一致

## F. ChatComposer 浮层

### TC-050: 窄屏 composer 默认收起、不占空间（P1，Functional）
- **Steps**: 390×844 选中会话
- **Expected**: 底部无常驻 composer；右下角浮动按钮可见；transcript 滚动区延伸到底部

### TC-051: 浮层展开保留全部功能（P1，Functional）
- **Steps**: 点聊天 fab
- **Expected**: bottom sheet 浮层 + 遮罩；图片/模型/思考深度/策略/输入/发送控件齐全且启用（admin）

### TC-052: 发送成功自动收起并刷新正文（P1，Integration）
- **Steps**: 输入文本发送（对接测试库真实会话）
- **Expected**: 浮层内状态走到「已完成」后自动关闭；正文尾部出现新 turn；浮层再打开为清空态

### TC-053: 发送失败保持展开（P2，Edge Case）
- **Steps**: 模拟失败（如离线 host 会话或强制下发失效场景）
- **Expected**: 浮层不收起，错误信息可见

### TC-054: viewer 只读语义（P2，Security）
- **Steps**: viewer 登录 → compact 展开 composer
- **Expected**: 「只读账号无法下发」横幅存在，控件禁用，发送按钮不可点

### TC-055: 切会话浮层复位（P2，Functional）
- **Steps**: 展开 composer 未发送 → 左栏选另一个会话
- **Expected**: composer 浮层收起，草稿清空逻辑与现状一致

### TC-056: 宽屏 composer 常驻不变（P1，Regression）
- **Steps**: 1440×900 选中会话
- **Expected**: composer 直接显示在 transcript 底部，无浮动按钮/遮罩

## G. 细节与主题

### TC-060: 文件抽屉宽度随断点（P2，Functional）
- **Steps**: compact 右栏打开文件 → 点文本文件；wide 重复
- **Expected**: el-drawer compact 宽度 90%、wide 50%；且抽屉盖在所有自定义浮层之上可正常阅读关闭

### TC-061: 登录页窄屏不溢出（P2，Functional）
- **Steps**: 未登录态 390×844 访问 `/hub/login`
- **Expected**: 卡片左右 ≥16px 边距，无横向滚动条

### TC-062: 窄屏正文无横向滚动（P2，Functional）
- **Steps**: compact 打开含长代码块/长路径的会话
- **Expected**: 页面无横向滚动条；代码块在块内滚动；元信息换行不溢出

### TC-063: 浅深主题全断点回归（P1，Regression）
- **Steps**: 分别在 390/768/1440 宽度切换 light/dark/system，并模拟系统 prefers-color-scheme 变化
- **Expected**: 浮层、遮罩、fab、composer、抽屉配色均跟随；无低对比/白底白字

### TC-064: 双部署路径行为一致（P2，Regression）
- **Steps**: 12380 直连 `/hub/` 与反代前缀路径（如外部映射的 `/hub-service/hub/`）各验一次 compact 开合
- **Expected**: 资源 base 正常、响应式行为一致（本机以 `/hub/` 为准，反代路径若无环境则标 ⬜ 待验证）

### TC-065: console 无错误（P2，Regression）
- **Steps**: 全流程（登录→切尺寸→开合三浮层→发送→切主题）收集 browser console
- **Expected**: 无 error 级别日志（warning 记录但不阻断）
