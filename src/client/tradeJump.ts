/**
 * 「复盘页点某笔 ⇒ 切到持仓页 → 交易流水」的**内存态**跳转请求。
 *
 * 用户口径：状态只在内存 —— **不改 URL**（不写 `#hash`/`pushState`）、**不改偏好**
 * （不写 `prefs.json`）、不闪烁。所以这里既不是路由也不是持久化，只有一个模块级变量
 * 加一份订阅表：
 *   · `FupanPage` 点某笔 ⇒ `requestTradeJump({ ledgerId, day })`（顺手把页面喊过去）；
 *   · `index.tsx`（唯一页签容器）订阅它 ⇒ `goPage('portfolio')`；
 *   · `PortfolioPage` 挂载时 `takeTradeFocus()` **读一次并清空** ⇒ 开流水弹窗 + 静态高亮那一行。
 *
 * 为什么"读一次就清空"：切页会让 `PortfolioPage` 卸载（它不在 `KEEP_ALIVE` 里），
 * 若不清空，下次再进持仓页会莫名其妙又弹一次流水 —— 那正是"切页后高亮应当消失"的反面。
 */
export interface TradeFocus {
  /** 台账流水 id（宿主 `trades[].ledgerId`）：命中就静态高亮那一行；空串 = 只能跳、不能高亮 */
  ledgerId: string
  /** 点的是哪一天（不参与定位，只作为"这次跳转从哪来"的记忆） */
  day: string
}

let pending: TradeFocus | null = null
const listeners = new Set<() => void>()

/** 请求一次"跳到持仓页 → 交易流水"。只改内存，不碰 URL / 偏好 / 网络 */
export function requestTradeJump(focus: TradeFocus): void {
  pending = focus
  for (const fn of [...listeners]) fn()
}

/** 消费并清空（只读一次 ⇒ 切页后回来不会再弹一次） */
export function takeTradeFocus(): TradeFocus | null {
  const out = pending
  pending = null
  return out
}

/** 订阅"有人请求跳转"；返回退订函数。只有页签容器（`index.tsx`）在听 */
export function subscribeTradeJump(fn: () => void): () => void {
  listeners.add(fn)
  return () => {
    listeners.delete(fn)
  }
}
