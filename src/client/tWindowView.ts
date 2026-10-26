/**
 * 「做T窗口」的**纯规则**（用户定稿，客户端与测试共用；无 React、无 IO）。
 *
 * 规则（逐条对应施工单）：
 *   ① 开关按标的记忆（prefs.tWindow[secid]），关闭 ⇒ 整组 `display:none`（不渲染任何节点）；
 *   ② 基准 = **当日均价**（分时序列的 avg 线），随行情刷新重算；
 *   ③ 间距 = `ATR% ÷ 4`，`ATR% = ATR14 ÷ 收盘 × 100`（ATR 取不到 ⇒ 整组不显示 + 原因，**不用默认 2%**）；
 *   ④ 档数：`ATR% ≤ 2%` ⇒ 4；`2% < ATR% ≤ 3.5%` ⇒ 6；`> 3.5%` ⇒ 8；上下对称、半跨度 = 间距 × 档数/2；
 *   ⑤ 不可手动调整（本模块没有任何"档数/间距"入参，只有 ATR 与均价）；
 *   ⑥ 不画成交点、不出现棱镜/挂单内容；
 *   ⑦ 标签 = `价格 + 偏离均价%`；买区蓝 / 卖区橙。
 */

/** 间距 = ATR% ÷ 4（用户定稿；写成固定 0.5% 就是错的） */
export const T_WINDOW_SPACING_DIVISOR = 4

/** 档数分档（上界含等号：2.0 ⇒ 4 档；3.5 ⇒ 6 档） */
export const T_WINDOW_BANDS = { tight: 2, loose: 3.5 } as const

/** 买/卖两色的唯一来源（与用户给定色值逐字一致） */
export const T_WINDOW_COLORS = { buy: '#4C6EF5', sell: '#E8590C' } as const

export type TWindowSide = 'buy' | 'sell'

export interface TWindowLevel {
  /** 该档的价格（元） */
  price: number
  /** 相对均价的偏离（%，带符号） */
  devPct: number
  /** 低于均价 = buy（蓝），高于 = sell（橙） */
  side: TWindowSide
}

export interface TWindow {
  /** ATR%（原值，供排查） */
  atrPct: number
  /** 间距（%）= atrPct / 4 */
  spacingPct: number
  /** 4 / 6 / 8 */
  bands: number
  /** 半跨度（%）= spacingPct × bands / 2 */
  halfSpanPct: number
  /** 基准（当日均价） */
  avg: number
  /** 各档（买区在下、卖区在上，按价格升序） */
  levels: TWindowLevel[]
}

/** 档数：`≤2%` ⇒ 4；`≤3.5%` ⇒ 6；`>3.5%` ⇒ 8（边界**含等号**，2.0/3.5 都落在低一档） */
export function tWindowBandsOf(atrPct: number): 4 | 6 | 8 {
  if (!Number.isFinite(atrPct) || atrPct <= 0) return 4
  if (atrPct <= T_WINDOW_BANDS.tight) return 4
  if (atrPct <= T_WINDOW_BANDS.loose) return 6
  return 8
}

/**
 * 一整套网格。`atrPct <= 0` / 非有限值 / 均价不可得 ⇒ 返回 `{ reason }`（调用方整组不渲染）。
 *
 * 注意：**没有**任何"档数/间距"入参 —— 不可手动调整是结构性的（用户第 5 条）。
 */
export function tWindowOf(input: { atrPct: number | null | undefined; avg: number | null | undefined }): TWindow | { reason: string } {
  const avg = input.avg
  if (typeof avg !== 'number' || !Number.isFinite(avg) || !(avg > 0)) return { reason: '当日均价未取到（分时序列没有均价线）' }
  const atrPct = input.atrPct
  if (typeof atrPct !== 'number' || !Number.isFinite(atrPct) || !(atrPct > 0)) return { reason: 'ATR14 未取到（日K 不足或上游不可用）⇒ 不用默认值顶替' }
  const spacingPct = atrPct / T_WINDOW_SPACING_DIVISOR
  const bands = tWindowBandsOf(atrPct)
  const halfSpanPct = (spacingPct * bands) / 2
  const levels: TWindowLevel[] = []
  for (let k = -bands / 2; k <= bands / 2; k += 1) {
    if (k === 0) continue // 0 档就是均价线本身，不画虚线（它与均价线重合）
    const devPct = k * spacingPct
    levels.push({
      price: round2(avg * (1 + devPct / 100)),
      devPct: round2(devPct),
      side: devPct < 0 ? 'buy' : 'sell',
    })
  }
  return { atrPct, spacingPct, bands, halfSpanPct, avg, levels }
}

/** 标签：`17.05 +0.62%`（数字 + 空格 + 正负号百分比；负号来自数值本身） */
export function tWindowLabelOf(level: Pick<TWindowLevel, 'price' | 'devPct'>): string {
  const sign = level.devPct >= 0 ? '+' : ''
  return `${level.price.toFixed(2)} ${sign}${level.devPct.toFixed(2)}%`
}

/** 开关：按标的记忆（键含 secid；缺省 = 关） */
export function tWindowOnOf(prefs: { tWindow?: Record<string, boolean> } | null | undefined, secid: string): boolean {
  const key = secid.trim().toUpperCase()
  return prefs?.tWindow?.[key] === true
}

/** 开关写回：只改这一个标的的键（其余原样保留） */
export function tWindowPatchOf(prefs: { tWindow?: Record<string, boolean> } | null | undefined, secid: string, on: boolean): Record<string, boolean> {
  const key = secid.trim().toUpperCase()
  const next: Record<string, boolean> = { ...(prefs?.tWindow ?? {}) }
  if (on) next[key] = true
  else delete next[key]
  return next
}

function round2(v: number): number {
  return Math.round(v * 100) / 100
}
