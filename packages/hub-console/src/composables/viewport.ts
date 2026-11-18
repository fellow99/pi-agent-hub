/**
 * 203：响应式断点常量与纯判定逻辑（无 window 依赖，可在 node 环境单测）。
 * 断点值与 styles.css 媒体查询同源，改动必须同步：
 * - compact：≤1023px，手机/平板竖屏等，三栏 Grid 不可用 → 侧栏 overlay 化、composer 浮层化
 * - narrow：≤480px，compact 子集，手机竖屏细节（85vw 抽屉、隐藏副标题）
 */
export const COMPACT_MAX_WIDTH = 1023;
export const NARROW_MAX_WIDTH = 480;

export interface ViewportClass {
  isCompact: boolean;
  isNarrow: boolean;
}

/** 唯一断点判定纯函数：composable 与单元测试共用，组件内禁止另写魔法数字。 */
export function classifyViewport(width: number): ViewportClass {
  return {
    isCompact: width <= COMPACT_MAX_WIDTH,
    isNarrow: width <= NARROW_MAX_WIDTH,
  };
}
