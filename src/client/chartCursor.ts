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
import type { SessionDef } from './sessionAxis.ts'

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

/**
 * 涨跌着色的**唯一**映射：`redUp` 决定红/绿谁是涨。
 *
 * 卡片此前把 tone 写死映射成 `tw-up`（红涨），于是在"绿涨红跌"档位下与全站**相反** ——
 * 同一个开关必须管到所有涨跌着色面（云图那个 bug 是同一类）。
 * `undefined` / `'muted'` ⇒ 中性；非涨跌行（MACD/DIF/DEA/量额）一律走中性。
 */
export function toneClass(tone: 'up' | 'down' | 'muted' | undefined, redUp: boolean): string {
  if (tone === 'up') return redUp ? 'tw-up' : 'tw-down'
  if (tone === 'down') return redUp ? 'tw-down' : 'tw-up'
  return 'tw-muted'
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
  /** 昨收（基准）；本卡片不再用它算涨跌幅，仅保留给调用方未来扩展 */
  baseline?: number | null
  /** 五日/多日档：时间列带日期 */
  multiDay?: boolean
  /** MACD 系列：**必须**是图上画的那一份（同一份计算） */
  macd?: MacdSeries | null
  /**
   * 该标的的交易时段表（`sessionOf(secid)`；无表的市场给 `null`）。
   * 只有"有时段表 **且** 序列首点正好落在该表开盘时刻"才敢说**距开盘** ——
   * 美股/国际指数/外盘商品/期货拉到的首点不是开盘（`122.XAU` 06:00、`100.SPX` 21:30）。
   */
  session?: SessionDef | null
  /** 调用方已知的当日开盘价（payload 的 `open`）；给了就优先用它 */
  open?: number | null
}

/**
 * 分时档涨跌幅的口径与行标签（**口径写在标签里，不靠读者猜**）：
 *
 * - 多日（五日）档：与**同一天的首点**比 ⇒ `涨跌(距当日开盘)`；
 * - 单日 + 有时段表且首点正是开盘时刻 ⇒ `涨跌(距开盘)`；
 * - 其余（无时段表 / 首点不在开盘）⇒ `涨跌(距首点)` —— 如实说明这是"首点"口径；
 * - 首点缺失或 ≤0 ⇒ 不可算（值为 `—`）。
 */
export function trendPctLine(
  points: readonly TrendPointLike[],
  i: number,
  opts: { multiDay?: boolean; session?: SessionDef | null; open?: number | null } = {},
): { label: string; pct: number | null } {
  const p = points[i]
  if (p === undefined) return { label: '涨跌(距首点)', pct: null }
  const first = points[0]
  const explicit = typeof opts.open === 'number' && Number.isFinite(opts.open) && opts.open > 0 ? opts.open : null
  let ref: number | null = explicit
  let label = '涨跌(距首点)'
  if (opts.multiDay === true) {
    // 五日档：与"同一天的首点"比（跨天比五天前没有意义）
    const day = p.label.slice(0, 10)
    let sameDayFirst: number | null = null
    for (const q of points) {
      if (q.label.slice(0, 10) !== day) continue
      sameDayFirst = Number.isFinite(q.price) ? q.price : null
      break
    }
    ref = explicit ?? sameDayFirst
    label = '涨跌(距当日开盘)'
  } else {
    const session = opts.session ?? null
    const openAtSessionOpen =
      session !== null &&
      first !== undefined &&
      (session.spans[0]?.start ?? '') !== '' &&
      first.label.slice(11, 16) === session.spans[0].start
    // 调用方给了真实开盘价 —— 那就是开盘，不必再看首点时间
    const openKnown = explicit !== null || openAtSessionOpen
    ref = explicit ?? (first !== undefined && Number.isFinite(first.price) ? first.price : null)
    label = openKnown ? '涨跌(距开盘)' : '涨跌(距首点)'
  }
  if (ref === null || !(ref > 0)) return { label, pct: null }
  return { label, pct: ((p.price - ref) / ref) * 100 }
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
  // 分时档：涨跌幅口径是"距开盘/距当日开盘/距首点"（见 trendPctLine，标签里写明）
  const pl = trendPctLine(points, i, { multiDay: args.multiDay, session: args.session, open: args.open })
  const pct = pl.pct
  const macd = args.macd ?? null
  const lines: TipLine[] = [
    { label: '时间', value: timeCell(p.label, args.multiDay === true), tone: 'muted' },
    { label: '价格', value: fmtPrice(p.price), tone: pctTone(pct) },
    { label: pl.label, value: pct === null ? '—' : fmtPct(pct), tone: pctTone(pct) },
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
