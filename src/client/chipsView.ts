/**
 * 筹码区块的**纯**视图逻辑（不 import react ⇒ 能在 node 里断言）。
 */
export interface ChipsViewState {
  data: unknown
  error: string | null
  loading: boolean
}

/**
 * 日期滑杆索引的边界收敛：0 / N−1 / 越界都收敛到 `[0, N−1]`；空序列 ⇒ −1（界面据此不渲染滑杆）。
 */
export function clampIndex(index: number, length: number): number {
  if (length <= 0) return -1
  if (!Number.isFinite(index)) return length - 1
  return Math.min(length - 1, Math.max(0, Math.round(index)))
}
