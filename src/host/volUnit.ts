/**
 * 成交量**量纲**判定（v0.181.0）。
 *
 * 上游对 `vol` 的单位并不统一：东财 K 线 `f56` 是**手**、腾讯快照 `[36]` 在科创板/新股上实测是**股**、
 * 腾讯 `[37]` 是**万元**。任何一处按固定系数换算 ⇒ 量柱差 100 倍、详情头"290 亿股"。
 *
 * 判据只认**成交额**这个锚：`vol × price ≈ amount` 成立 ⇒ 股；`vol × 100 × price ≈ amount` 成立 ⇒ 手。
 * 两个都不成立 ⇒ 不猜（返回 `ok:false`），调用方按缺失处理，**不显示错值**。
 */

export type VolUnit = 'lot' | 'share'

export interface VolUnitCheck {
  /** 推断出的原始单位 */
  unit: VolUnit
  /** 与成交额是否自洽（误差 ≤5%） */
  ok: boolean
  /** 自洽误差（%）；无法判定时 Infinity */
  errPct: number
}

/** 允许的误差（与页面一致性校验同阈值） */
export const VOL_ERR_MAX_PCT = 5

export function volUnitOf(rawVol: number | null | undefined, price: number | null | undefined, amount: number | null | undefined): VolUnitCheck {
  if (rawVol === null || rawVol === undefined || price === null || price === undefined || amount === null || amount === undefined) {
    return { unit: 'lot', ok: false, errPct: Number.POSITIVE_INFINITY }
  }
  if (!(rawVol > 0) || !(price > 0) || !(amount > 0)) return { unit: 'lot', ok: false, errPct: Number.POSITIVE_INFINITY }
  const errShare = Math.abs(rawVol * price - amount) / amount * 100
  const errLot = Math.abs(rawVol * 100 * price - amount) / amount * 100
  if (errShare <= VOL_ERR_MAX_PCT) return { unit: 'share', ok: true, errPct: errShare }
  if (errLot <= VOL_ERR_MAX_PCT) return { unit: 'lot', ok: true, errPct: errLot }
  // 两个都不自洽：取更接近的那个（只用于"往哪个方向修"），但 ok=false ⇒ 界面标 —
  const unit: VolUnit = errShare <= errLot ? 'share' : 'lot'
  return { unit, ok: false, errPct: Math.min(errShare, errLot) }
}

/** 原始量 → 手（K 线柱统一单位） */
export function volToLots(rawVol: number, unit: VolUnit): number {
  return unit === 'share' ? Math.round(rawVol / 100) : Math.round(rawVol)
}

/** 原始量 → 股（详情头统一单位） */
export function volToShares(rawVol: number, unit: VolUnit): number {
  return unit === 'share' ? Math.round(rawVol) : Math.round(rawVol * 100)
}
