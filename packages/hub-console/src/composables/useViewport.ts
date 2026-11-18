import { ref } from "vue";
import { COMPACT_MAX_WIDTH, NARROW_MAX_WIDTH, classifyViewport } from "./viewport.js";

/**
 * 203：视口断点 composable（模块级单例）。
 * 参考 pi-web hooks/useIsMobile.ts；本应用为纯 SPA，无 SSR 兜底需求。
 * 纯判定逻辑见 viewport.ts（node 环境可测），是本 composable 与单测共用的唯一判定入口。
 *
 * 双监听策略：
 * - matchMedia change：语义化断点事件（CSS 同源媒体查询）；
 * - window resize：兜底触发重读。部分 headless/嵌入式 webview 下 matchMedia change
 *   存在延迟或漏发，resize 事件保证旋转/拖窗后状态最终与视口一致。
 * 两类事件都只作触发源，实际状态统一由 classifyViewport(window.innerWidth) 派生（FR-203-002）。
 */
export { COMPACT_MAX_WIDTH, NARROW_MAX_WIDTH, classifyViewport } from "./viewport.js";
export type { ViewportClass } from "./viewport.js";

const compactQuery = window.matchMedia(`(max-width: ${COMPACT_MAX_WIDTH}px)`);
const narrowQuery = window.matchMedia(`(max-width: ${NARROW_MAX_WIDTH}px)`);

/** 模块级单例：整个 SPA 共享同一份视口状态，监听只注册一次。 */
const initial = classifyViewport(window.innerWidth);
const isCompact = ref(initial.isCompact);
const isNarrow = ref(initial.isNarrow);

/**
 * rAF 帧内去重：部分 headless/嵌入式 webview 会批量、延迟派发 resize/matchMedia
 * 事件，帧内多次触发只重算一次，且连续旋转/拖窗只写一次 ref。
 */
let frame = 0;
function syncFromViewport(): void {
  if (frame !== 0) return;
  frame = window.requestAnimationFrame(() => {
    frame = 0;
    const next = classifyViewport(window.innerWidth);
    isCompact.value = next.isCompact;
    isNarrow.value = next.isNarrow;
  });
}

compactQuery.addEventListener("change", syncFromViewport);
narrowQuery.addEventListener("change", syncFromViewport);
window.addEventListener("resize", syncFromViewport);

export function useViewport(): {
  isCompact: typeof isCompact;
  isNarrow: typeof isNarrow;
} {
  return { isCompact, isNarrow };
}
