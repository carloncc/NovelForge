/**
 * 动效可访问性工具（#1482）。
 *
 * 背景：styles.css 用 `@media (prefers-reduced-motion: reduce)` 把 CSS 动画/过渡压到 0.01ms，
 * 但**管不到 JS 触发的滚动**——代码里多处 `window.scrollTo({ behavior: "smooth" })` /
 * `scrollIntoView({ behavior: "smooth" })` 仍会播放一段平滑滚动动画。对前庭敏感用户来说，
 * 这正是 reduce-motion 想要消除的那类位移。故 JS 侧统一从这里取行为值。
 */

/** 用户是否要求减少动效（无 matchMedia/无 window 时按"否"处理，绝不抛错） */
function prefersReducedMotion(): boolean {
  try {
    return (
      typeof window !== "undefined" &&
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches
    );
  } catch {
    return false;
  }
}

/** 滚动行为：尊重 reduce-motion（开启时用 instant，避免强制动画） */
function scrollBehavior(): ScrollBehavior {
  return prefersReducedMotion() ? ("instant" as ScrollBehavior) : "smooth";
}

/** 回到顶部（尊重 reduce-motion） */
export function scrollToTop(): void {
  try {
    window.scrollTo({ top: 0, behavior: scrollBehavior() });
  } catch {
    /* 无 window（测试/SSR）或浏览器不支持：忽略 */
  }
}

/** 滚动到元素（尊重 reduce-motion） */
export function scrollIntoView(el: Element | null | undefined): void {
  if (!el || typeof el.scrollIntoView !== "function") return;
  try {
    el.scrollIntoView({ block: "start", behavior: scrollBehavior() });
  } catch {
    /* 忽略 */
  }
}
