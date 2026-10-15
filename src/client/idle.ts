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

/** 读当前文档是否隐藏（无 `document` 的运行环境按"未隐藏"处理） */
export function documentHiddenNow(): boolean {
  try {
    return typeof document !== 'undefined' && document.visibilityState === 'hidden'
  } catch {
    return false
  }
}
