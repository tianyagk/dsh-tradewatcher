/**
 * 持仓行内文案的**判定与取值**（纯函数，不 import react）。
 *
 * 三条都是审计清单 `docs/AUDIT-COPY.md` 的必修项（R3 不写废话 / R4 空值不占位）：
 *  - M1 可用数量：只有"今日买入确实不可卖"（`availableQty < qty`）时才有话说。
 *    此前 T+0/T+1 两个分支**每只持仓都写一行**，且今日无买入时
 *    `今日买入 0 份…故可用少于持仓` 是**假话**（恒假句，R3）。口径本身进 `title`。
 *  - M4 费用占比：`fees = 0`（未录费用）时整条不出 —— 值列已经有 `0.00`；
 *    `fees > 0` 时压成 `占成交额 X%`（"累计"与成交额列重复）。
 *  - M2 YTD 基准：只有 `baseKind === 'listing'`（年内上市，基准是**上市首日**，
 *    不标注就会被读成"年初至今"而高估）才常显；常态基准与原因进已有的行级 tooltip。
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
