/**
 * 面板"闲置（后台）"判定与订阅（v0.87.0，UI/UX 纪律的一部分）。
 *
 * 采纳竞品（爱盯盘）的 `.ap-idle` 约定：**页面切后台就暂停动画**（合成层不空跑、不烧电）。
 * 我们的实现不走"给每个动画加 class"，而是把状态写到根节点的 `data-idle` 上，
 * 由 CSS 一条规则统管（`styles.ts` 的 `.tw-root[data-idle=true] *{animation-play-state:paused}`）。
 *
 * 两个触发源：
 *   · `visible === false`：宿主把面板藏起来（页签切走）——宿主已有这个信号，直接复用；
 *   · `document.hidden`：整页切到后台（浏览器 `visibilitychange`）。
 * 两者都用纯函数判（`panelIdle`），订阅在 hook 里做（`usePageIdle.ts`）——
 * 纯函数可单测，订阅保持最薄；本文件**不许 import react**（那是"可被 node:test 导入"的前提）。
 */

/** 纯判定：只要"面板不可见"或"文档已隐藏"，就算闲置 */
export function panelIdle(visible: boolean, documentHidden: boolean): boolean {
  return !visible || documentHidden
}

/**
 * 纯判定：面板**是否真的可见**（P2-4）。
 *
 * 两个信号：
 *   · `documentHidden`：整页切后台；
 *   · `intersecting`：面板根节点这一轮是否与视口相交（`IntersectionObserver` 给）；
 *     `null` = 观察器不可用/还没回调 ⇒ **失败放行**（宁可按可见处理，也不要把数据停了）。
 *
 * 旧实现是 `const visible = true`（常量），上层的 `enabled` 参数全部形同虚设。
 */
export function panelVisibleOf(input: { documentHidden: boolean; intersecting: boolean | null }): boolean {
  if (input.documentHidden) return false
  return input.intersecting !== false
}

/** 读当前文档是否隐藏（无 `document` 的运行环境按"未隐藏"处理） */
export function documentHiddenNow(): boolean {
  try {
    return typeof document !== 'undefined' && document.visibilityState === 'hidden'
  } catch {
    return false
  }
}
