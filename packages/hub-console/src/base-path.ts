/**
 * 运行时部署路径推导（反向代理子路径自适应）
 *
 * 同一份构建产物需要同时支持两种部署形态：
 *   1. 直连（容器内 nginx）：页面位于 /hub/<route>，外部前缀为空
 *   2. 子路径反代（如网关 /hub-service => 上游 /）：页面位于 /hub-service/hub/<route>
 *
 * 思路：以当前文档 URL 的最后一段 `/hub` 为锚点，锚点之前即外部前缀，
 * 锚点之后（含）为应用 base。任何部署前缀都无需重新构建。
 */

/** hub-console 在容器内 nginx 下的固定应用段名。 */
export const APP_SEGMENT = "/hub";

/**
 * 根据文档绝对路径推导应用 base（以 `/` 结尾）。
 *
 * 例：
 *   "/hub/"                 -> "/hub/"
 *   "/hub/login"            -> "/hub/"
 *   "/hub-service/hub/"     -> "/hub-service/hub/"
 *   "/hub-service/hub/login" -> "/hub-service/hub/"
 */
export function deriveAppBase(pathname: string): string {
  const idx = pathname.lastIndexOf(`${APP_SEGMENT}/`);
  if (idx >= 0) return `${pathname.slice(0, idx)}${APP_SEGMENT}/`;
  // 无尾斜杠的应用根（如 "/hub"）也视为命中。
  if (pathname.endsWith(APP_SEGMENT)) return `${pathname.slice(0, -APP_SEGMENT.length)}${APP_SEGMENT}/`;
  // 兜底：无法识别锚点时回落到容器内默认形态（直连部署）。
  return `${APP_SEGMENT}/`;
}

/**
 * 由应用 base 推导 daemon/控制台 API 基址（以 `/` 结尾）。
 * 约定 API 与页面同源、同外部前缀：<前缀>/api/...
 *
 * 例：
 *   "/hub/"                 -> "/api/"
 *   "/hub-service/hub/"     -> "/hub-service/api/"
 */
export function deriveApiBase(appBase: string): string {
  const prefix = appBase.slice(0, -`${APP_SEGMENT}/`.length);
  return `${prefix}/api/`;
}

declare global {
  interface Window {
    /** 由 index.html 内联引导脚本在模块加载前写入的应用 base。 */
    __APP_BASE__?: string;
  }
}

/** 当前生效的应用 base（优先使用引导脚本写入值，缺失时现场推导，保证非浏览器入口可测）。 */
export function currentAppBase(): string {
  if (typeof window !== "undefined" && typeof window.__APP_BASE__ === "string" && window.__APP_BASE__) {
    return window.__APP_BASE__;
  }
  if (typeof window !== "undefined" && window.location) return deriveAppBase(window.location.pathname);
  return `${APP_SEGMENT}/`;
}

/** 当前生效的 API 基址（以 `/` 结尾）。 */
export function currentApiBase(): string {
  return deriveApiBase(currentAppBase());
}
