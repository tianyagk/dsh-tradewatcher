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

/** 标签几何（左侧内侧）：`x = plotLeft + 6`、`text-anchor: start`、垂直居中 */
export interface TWindowLabel {
  key: string
  x: number
  y: number
  text: string
  width: number
}

/** 估算文本宽度（12px 等宽 + 11px 小数：按字符数 × 6.6px，含 4px 间隙） */
export function tWindowLabelWidthOf(text: string): number {
  return Math.ceil(text.length * 6.6)
}

/** 标签矩形（用于"不得与分时线重叠"的几何判据） */
export function tWindowLabelRect(label: TWindowLabel, h = 14): { x0: number; x1: number; y0: number; y1: number } {
  return { x0: label.x, x1: label.x + label.width, y0: label.y - h / 2, y1: label.y + h / 2 }
}

/** 两个矩形的交集面积（0 = 不重叠） */
export function rectOverlapArea(
  a: { x0: number; x1: number; y0: number; y1: number },
  b: { x0: number; x1: number; y0: number; y1: number },
): number {
  const w = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0)
  const h = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0)
  return w > 0 && h > 0 ? w * h : 0
}

/**
 * 做T 档位标签（**全部在绘图区左内侧**，用户 2026-10-26 反馈：原来压在右侧 Y 轴刻度上）。
 *
 * - `x = plotLeft + 6`，不超过 `plotLeft + 80`；
 * - 纵向按价格排布（与档位 y 对齐）；若该 x 区间内有折线/均价线经过（`pathYsAt` 给样本），
 *   上下轻推最多 6px，避免文字压在线上（配合 1px 白底描边 halo）。
 */
export function tWindowLabelsOf(args: {
  levels: ReadonlyArray<Pick<TWindowLevel, 'price' | 'devPct'>>
  yOf: (price: number) => number
  plotLeft: number
  pathYsAt?: (x0: number, x1: number) => readonly number[]
  plotTop?: number
  plotBottom?: number
}): TWindowLabel[] {
  const out: TWindowLabel[] = []
  const top = args.plotTop ?? -Infinity
  const bottom = args.plotBottom ?? Infinity
  for (const lv of args.levels) {
    const text = tWindowLabelOf(lv)
    const width = Math.min(80, tWindowLabelWidthOf(text) + 6)
    const x = args.plotLeft + 6
    const baseY = args.yOf(lv.price)
    if (!Number.isFinite(baseY)) continue
    let y = baseY
    const near = (args.pathYsAt?.(x, x + width) ?? []).filter((py) => Number.isFinite(py))
    for (const shift of [0, -8, 8, -12, 12]) {
      const cand = Math.max(top + 8, Math.min(bottom - 8, baseY + shift))
      if (!near.some((py) => Math.abs(py - cand) < 9)) { y = cand; break }
    }
    out.push({ key: `twl-${lv.devPct}`, x, y, text, width })
  }
  return out
}
