/**
 * 图表光标层（分时 / 五日 / 日周月年 K）——像素→数据点、卡片摆放、卡片内容。
 *
 * 全部是纯函数：能脱离 react 被 `node --test` 直接跑，也保证"图上画的"与"卡片写的"来自**同一份计算**
 * （MA/MACD 由调用方传进来，这里**不重算** —— 各算一套就会出现"图上 MA5=37.5、卡片写 38.1"）。
 *
 * 口径红线：缺失一律 `—`，**绝不**用 0 顶替（无昨收 ⇒ 涨跌幅不可算；均价不可用 ⇒ 不显示 0；
 * 成交额缺失 ⇒ `—`）。五日档的时间列**必须带日期**，否则 "09:35" 会被读成"今天"。
 */
import { fmtAmt, fmtBig, fmtPct, fmtPrice } from './format.ts'

export interface TipLine {
  label: string
  value: string
  /** 涨/跌着色（K 线卡片的收盘与涨跌幅用；不带则用默认色） */
  tone?: 'up' | 'down' | 'muted'
}

export interface TipPos {
  left: number
  top: number
  /** 是否翻了边（靠右 ⇒ 卡片放到光标左侧） */
  flipped: boolean
}

/**
 * 像素 x → 最近的数据点下标。
 *
 * `xs` 是**当前轴**的归一化坐标（0~1）：时段网格档给 `sessionAxis().xs`，压缩轴档给 `eff / span`，
 * K 线档给 `(i - 窗口起点) / 窗口长度` —— 两种轴（以及 K 线窗口）共用这一个实现。
 *
 * 约定：空数组（或图宽无效）⇒ `null`（调用方不显示卡片）；单点 ⇒ 恒 `0`；
 * 越界像素**夹到两端**（不返回 -1 / length 之类越界下标）。
 */
export function nearestIndex(px: number, xs: readonly number[], padX: number, innerW: number): number | null {
  if (xs.length === 0 || !Number.isFinite(innerW) || innerW <= 0 || !Number.isFinite(px)) return null
  const t = (px - padX) / innerW
  let best = 0
  let bestD = Number.POSITIVE_INFINITY
  for (let i = 0; i < xs.length; i += 1) {
    const x = xs[i]
    if (!Number.isFinite(x)) continue
    const d = Math.abs(x - t)
    if (d < bestD) {
      bestD = d
      best = i
    }
  }
  return best
}

/**
 * 卡片摆放：默认在光标**右侧**；右侧放不下就翻到左侧；上下越界收进图内。
 * 图比卡片还小的退化情形下夹到 `0`（宁可压住图，也不把卡片丢到图外看不见）。
 */
export function tipPlacement(
  cursorX: number,
  cursorY: number,
  plotW: number,
  plotH: number,
  tipW: number,
  tipH: number,
  gap = 12,
): TipPos {
  const flip = cursorX + gap + tipW > plotW
  const rawLeft = flip ? cursorX - gap - tipW : cursorX + gap
  const rawTop = cursorY - tipH / 2
  const maxLeft = Math.max(0, plotW - tipW)
  const maxTop = Math.max(0, plotH - tipH)
  return {
    left: Math.max(0, Math.min(maxLeft, rawLeft)),
    top: Math.max(0, Math.min(maxTop, rawTop)),
    flipped: flip,
  }
}

/** 时间列：五日档必须带日期（`MM-DD HH:mm`），单日档只要时刻（`HH:mm`） */
export function timeCell(label: string, multiDay: boolean): string {
  if (multiDay) return label.slice(5, 16) // YYYY-MM-DD HH:mm → MM-DD HH:mm
  return label.slice(11, 16)
}

export interface TrendPointLike {
  label: string
  price: number
  avg?: number | null
  vol?: number | null
  amount?: number | null
}

export interface MacdSeries {
  dif: readonly number[]
  dea: readonly number[]
  hist: readonly number[]
}

export interface TrendReadoutArgs {
  points: readonly TrendPointLike[]
  i: number
  /** 昨收（基准）；不可用时涨跌幅显示 `—`（不是 0.00%） */
  baseline?: number | null
  /** 五日/多日档：时间列带日期 */
  multiDay?: boolean
  /** MACD 系列：**必须**是图上画的那一份（同一份计算） */
  macd?: MacdSeries | null
}

const numOrDash = (v: number | null | undefined, digits = 2): string => {
  if (typeof v !== 'number' || !Number.isFinite(v)) return '—'
  return v.toFixed(digits)
}

const pctTone = (pct: number | null): 'up' | 'down' | undefined => {
  if (pct === null || pct === 0) return undefined
  return pct > 0 ? 'up' : 'down'
}

/** 分时 / 五日档的卡片内容（缺什么写 `—`） */
export function trendReadout(args: TrendReadoutArgs): TipLine[] {
  const { points, i } = args
  const p = points[i]
  if (p === undefined) return []
  const base = args.baseline
  const baseOk = typeof base === 'number' && Number.isFinite(base) && base > 0
  const pct = baseOk ? ((p.price - base) / base) * 100 : null
  const macd = args.macd ?? null
  const lines: TipLine[] = [
    { label: '时间', value: timeCell(p.label, args.multiDay === true), tone: 'muted' },
    { label: '价格', value: fmtPrice(p.price), tone: pctTone(pct) },
    { label: '涨跌幅', value: baseOk ? fmtPct(pct) : '—', tone: pctTone(pct) },
  ]
  if (macd !== null) {
    lines.push({ label: 'MACD', value: numOrDash(macd.hist[i], 4), tone: 'muted' })
    lines.push({ label: 'DIF', value: numOrDash(macd.dif[i], 4), tone: 'muted' })
    lines.push({ label: 'DEA', value: numOrDash(macd.dea[i], 4), tone: 'muted' })
  }
  lines.push({ label: '均价', value: typeof p.avg === 'number' && Number.isFinite(p.avg) && p.avg > 0 ? fmtPrice(p.avg) : '—' })
  lines.push({ label: '成交量', value: p.vol === null || p.vol === undefined ? '—' : fmtBig(p.vol) })
  lines.push({ label: '成交额', value: p.amount === null || p.amount === undefined ? '—' : fmtAmt(p.amount) })
  return lines
}

export interface KlineBarLike {
  date: string
  open: number
  close: number
  high: number
  low: number
  vol: number | null
  amount?: number | null
}

export interface KlineReadoutArgs {
  bars: readonly KlineBarLike[]
  i: number
  /** 图上的均线系列（含 period），取值一律来自这里 */
  mas?: ReadonlyArray<{ period: number; values: readonly (number | null)[] }>
  /** 图上的 MACD（同一份） */
  macd?: MacdSeries | null
}

/** 日/周/月/年 K 的卡片内容（MA/MACD 与图上同源；缺失写 `—`） */
export function klineReadout(args: KlineReadoutArgs): TipLine[] {
  const { bars, i } = args
  const b = bars[i]
  if (b === undefined) return []
  const prev = i > 0 ? bars[i - 1] : undefined
  const pct = prev !== undefined && prev.close > 0 ? ((b.close - prev.close) / prev.close) * 100 : null
  const tone = pct !== null && pct !== 0 ? (pct > 0 ? 'up' : 'down') : undefined
  const lines: TipLine[] = [
    { label: '时间', value: b.date, tone: 'muted' },
    { label: '收盘', value: fmtPrice(b.close), tone },
    { label: '涨跌幅', value: pct === null ? '—' : fmtPct(pct), tone },
    { label: '开盘', value: fmtPrice(b.open) },
    { label: '最高', value: fmtPrice(b.high) },
    { label: '最低', value: fmtPrice(b.low) },
  ]
  for (const ser of args.mas ?? []) {
    const v = ser.values[i]
    lines.push({ label: `MA${ser.period}`, value: typeof v === 'number' && Number.isFinite(v) ? fmtPrice(v) : '—' })
  }
  const macd = args.macd ?? null
  if (macd !== null) {
    lines.push({ label: 'DIF', value: numOrDash(macd.dif[i], 4) })
    lines.push({ label: 'DEA', value: numOrDash(macd.dea[i], 4) })
    lines.push({ label: 'MACD', value: numOrDash(macd.hist[i], 4) })
  }
  lines.push({ label: '成交量', value: b.vol === null || b.vol === undefined ? '—' : fmtBig(b.vol) })
  lines.push({ label: '成交额', value: b.amount === null || b.amount === undefined ? '—' : fmtAmt(b.amount) })
  return lines
}
