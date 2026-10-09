/**
 */

/** 数字去掉浮点毛刺（数量口径：4 位小数，与宿主一致） */
function round4(n: number): number {
  return Math.round(n * 1e4) / 1e4
}

/** 不可卖数量（今日买入的部分）；A股 T+1 才有意义，T+0 恒为 0 */
export function lockedQty(qty: number, availableQty: number): number {
  if (!Number.isFinite(qty) || !Number.isFinite(availableQty)) return 0
  return Math.max(0, round4(qty - availableQty))
}

/** M1：仅当"今日买入确实不可卖"时给一句（≤14 字）；否则返回 null（整条不渲染） */
export function availableLockNote(qty: number, availableQty: number): string | null {
  const locked = lockedQty(qty, availableQty)
  return locked > 1e-9 ? `今日买入 ${locked} 份不可卖` : null
}

/** M4：`fees > 0` 且占比可算时给 `占成交额 X%`；未录费用（0）时整条不出 */
export function feeShareNote(fees: number, feeShare: number | null): string | null {
  if (!(fees > 0) || feeShare === null || !Number.isFinite(feeShare)) return null
  return `占成交额 ${feeShare.toFixed(3)}%`
}

/** M2：只有"年内上市、基准是上市首日"才常显基准（防高估）；常态基准返回 null */
export function ytdBaseNote(baseDate: string | null | undefined, baseKind: string | null | undefined): string | null {
  if (baseDate === null || baseDate === undefined || baseDate === '') return null
  if (baseKind !== 'listing') return null
  return `上市首日 ${baseDate}`
}
