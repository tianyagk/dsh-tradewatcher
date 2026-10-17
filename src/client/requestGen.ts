/**
 * 请求代号（P2-2）：用来**丢弃旧代响应**。
 *
 * 症状：`useQuotes` 的旧请求在 key 变化后落地时仍会 `setQuotes/setTs/setMissing/...`。
 * 组件层 `alive` 标志救不了它 —— 新 effect 一进来就把 `alive.current = true` 了，
 * 于是旧响应照样被当成"这一次的结果"写进去（跨页切 tab 时表现为"某行显示 — 但既没有
 * 「无行情源」也没有「未取到」标注"：缺失集合来自旧 id 集）。
 *
 * 修法：每次取数领一个**代次**，落地时对一次当前代次；不是当代就整体丢弃（含错误）。
 * 纯函数式（可单测），不依赖 react。
 */
export interface RequestGen {
  /** 开新一代（新的 key/刷新轮次），返回代次 */
  next: () => number
  /** 当前代次 */
  current: () => number
  /** `gen` 这一代是否已过期 */
  stale: (gen: number) => boolean
}

export function createRequestGen(): RequestGen {
  let cur = 0
  return {
    next: () => {
      cur += 1
      return cur
    },
    current: () => cur,
    stale: (gen) => gen !== cur,
  }
}
