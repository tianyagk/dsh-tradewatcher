/**
 * 底部位置 / 日内形态 / 底部概率。
 *
 * 设计原则（避免伪精确）：
 *  1. **位置**（相对历史的便宜程度）与**量能**可从 500 根日线回算 → 可以给出
 *     **频率校准过的概率**：把当前状态与历史同类日（同分位区间 + 同量能档）类比，
 *     统计其后 1/3/5/10 日的表现。概率必须与**样本量 N** 和**无条件基线**一起展示，
 *     N 不足时明确标注，不给结论。
 *  2. **日内形态**（日内回升、下影线、破前低收回）没有可回算的历史分钟数据，
 *     因此它**不进入**那个概率，只作为实时修正分单独展示 —— 混进去就是伪精确。
 *  3. 概率是"历史上同类情形的频率"，不是预测；底部只能事后确认。
 */
import type { DailyBarLite, RescueBottomLane, RescueBottomView } from '../shared/model.ts'

/** 位置特征：相对历史的位置（越低越"便宜"） */
export interface PositionMetrics {
  /** 距 60 日最高价回撤（负数，如 -0.105 = 回撤 10.5%） */
  drawdown60: number | null
  /** 距 250 日最高价回撤 */
  drawdown250: number | null
  /** 距 60 日最低价的距离（正数，0.005 = 高于该低点 0.5%） */
  aboveLow60: number | null
  /** 近 60 日收盘分位（0–1，0 = 最低） */
  percentile60: number | null
  /** 连续下跌天数 */
  downStreak: number
  /** 当日是否创 60 日新低 */
  atNewLow60: boolean
}

/** 日内形态特征 */
export interface PatternMetrics {
  /** 现价相对当日最低的回升幅度（%） */
  bouncePct: number | null
  /** 下影线占当日振幅比例（0–1） */
  lowerShadow: number | null
  /** 当日最低点出现的时间戳 */
  lowAtTs: number | null
  /** 当日最低是否跌破前 20 日最低、且现价已收回该低点之上 */
  reclaimedPrevLow: boolean
  /** 是否创 60 日新低但收盘收回 */
  newLowReclaimed: boolean
}

const num = (v: number | null | undefined): v is number => typeof v === 'number' && Number.isFinite(v)

/** 单遍求极值（避免 Math.max(...arr) 的参数展开，且只接受有限数值） */
function extremes(bars: readonly DailyBarLite[]): { hi: number; lo: number; n: number } | null {
  let hi = -Infinity
  let lo = Infinity
  let n = 0
  for (const b of bars) {
    if (!num(b.high) || !num(b.low) || !num(b.close)) continue
    if (b.high > hi) hi = b.high
    if (b.low < lo) lo = b.low
    n += 1
  }
  return n > 0 && Number.isFinite(hi) && Number.isFinite(lo) ? { hi, lo, n } : null
}

/** 过滤掉含非有限数值的日线（一根 NaN 会一路污染到视图） */
export function sanitizeBars(bars: readonly DailyBarLite[]): DailyBarLite[] {
  return bars.filter((b) => num(b.open) && num(b.close) && num(b.high) && num(b.low) && num(b.vol) && b.vol > 0 && b.close > 0)
}

/** 位置特征（bars 为截至当日的历史，price 为现价或当日收盘） */
export function computePosition(bars: readonly DailyBarLite[], price: number): PositionMetrics {
  const empty: PositionMetrics = { drawdown60: null, drawdown250: null, aboveLow60: null, percentile60: null, downStreak: 0, atNewLow60: false }
  // 先在入口清洗：一根 NaN/0 成交量的日线会污染分位、极值与连跌计数（一路传到视图）
  const clean = sanitizeBars(bars)
  if (clean.length < 20 || !(price > 0)) return empty
  const win60 = clean.slice(-60)
  const win250 = clean.slice(-250)
  const ex60 = extremes(win60)
  const ex250 = extremes(win250)
  if (ex60 === null || ex250 === null) return empty
  const hi60 = ex60.hi
  const hi250 = ex250.hi
  const lo60 = ex60.lo
  const closes = win60.map((b) => b.close).sort((a, b) => a - b)
  const rank = closes.filter((c) => c <= price).length / closes.length
  let downStreak = 0
  for (let i = clean.length - 1; i > 0; i--) {
    if (clean[i].close < clean[i - 1].close) downStreak += 1
    else break
  }
  return {
    drawdown60: hi60 > 0 ? price / hi60 - 1 : null,
    drawdown250: hi250 > 0 ? price / hi250 - 1 : null,
    aboveLow60: lo60 > 0 ? price / lo60 - 1 : null,
    percentile60: rank,
    downStreak,
    atNewLow60: price <= lo60 * 1.002,
  }
}

/** 日内形态特征（用当日快照 + 分钟序列） */
export function computePattern(input: {
  price: number | null
  open: number | null
  high: number | null
  low: number | null
  /** 分钟序列（含价格），用于定位最低点出现的时段 */
  minutes?: readonly { ts: number; price?: number }[]
  /** 前 20 日最低（不含当日） */
  prevLow20: number | null
  atNewLow60: boolean
}): PatternMetrics {
  const { price, open, high, low, prevLow20 } = input
  const out: PatternMetrics = { bouncePct: null, lowerShadow: null, lowAtTs: null, reclaimedPrevLow: false, newLowReclaimed: false }
  if (!num(price) || !num(low) || low <= 0) return out
  out.bouncePct = (price / low - 1) * 100
  if (num(high) && num(open) && high > low) {
    out.lowerShadow = Math.max(0, (Math.min(open, price) - low) / (high - low))
  }
  if (num(prevLow20) && prevLow20 > 0 && low < prevLow20 && price > prevLow20) out.reclaimedPrevLow = true
  // 创 60 日新低但收盘已明显收回（>0.5%）
  if (input.atNewLow60 && price > low * 1.005) out.newLowReclaimed = true
  const minutes = input.minutes ?? []
  const withPrice = minutes.filter((m) => num(m.price) && (m.price as number) > 0)
  if (withPrice.length >= 10) {
    let lowest = withPrice[0]
    for (const m of withPrice) if ((m.price as number) < (lowest.price as number)) lowest = m
    out.lowAtTs = lowest.ts
  }
  return out
}

/** 位置分（0–100，越低的位置越高分）：分位为主，叠加回撤与连跌 */
export function positionScore(pos: PositionMetrics): number {
  if (!num(pos.percentile60)) return 0
  const byPercentile = (1 - pos.percentile60) * 70
  const dd = num(pos.drawdown60) ? Math.min(1, Math.abs(pos.drawdown60) / 0.2) * 20 : 0
  const streak = Math.min(1, pos.downStreak / 5) * 10
  return Math.round(Math.max(0, Math.min(100, byPercentile + dd + streak)))
}

/** 形态分（0–100）：日内回升幅度 + 下影线 + 收回前低 */
export function patternScore(p: PatternMetrics): number {
  let score = 0
  if (num(p.bouncePct)) score += Math.min(1, p.bouncePct / 1.5) * 50
  if (num(p.lowerShadow)) score += Math.min(1, p.lowerShadow / 0.4) * 30
  if (p.reclaimedPrevLow) score += 15
  if (p.newLowReclaimed) score += 5
  return Math.round(Math.max(0, Math.min(100, score)))
}

/** 历史同类日 → 前向表现（回测口径） */
export interface BottomCalibration {
  /** 类比条件说明 */
  rule: string
  /** 类比样本数（命中条件的「通道×日」） */
  n: number
  /** 无条件基线样本数 */
  baseN: number
  /** 参与合并的通道数 */
  lanes: number
  /** 多个目标涨幅下的概率与基线（避免只看一个阈值） */
  targets: Array<{ targetPct: number; prob: number | null; baseRate: number | null }>
  /** 前向窗口收盘收益中位数 */
  medianForward: number | null
  /** 前向窗口最大回撤中位数（负数） */
  medianDrawdown: number | null
  /** 前向窗口天数 */
  horizon: number
}

const medianOf = (arr: readonly number[]): number | null => {
  if (arr.length === 0) return null
  const s = [...arr].sort((a, b) => a - b)
  const mid = Math.floor(s.length / 2)
  return s.length % 2 === 1 ? s[mid] : (s[mid - 1] + s[mid]) / 2
}

export interface BottomOutcomeStats {
  /** 命中类比条件的样本：各目标涨幅是否达成 */
  hits: boolean[][]
  /** 无条件样本：各目标涨幅是否达成 */
  baseHits: boolean[][]
  forwards: number[]
  draws: number[]
  n: number
  baseN: number
}

/**
 * 单通道回算：只用截至当日的数据判定特征，前向收益也只取**该通道自己**的后续日线。
 * （踩过的坑：把多个通道的日线合并后再按日期排序，会让"前 60 根"跨品种、
 *  前向窗口落到别的品种上，得出 +105% 之类的荒唐中位数。）
 */
export function laneOutcomeStats(
  bars: readonly DailyBarLite[],
  opts: { percentileMax: number; volumeMin: number; horizon: number; targets: readonly number[] },
): BottomOutcomeStats {
  const { percentileMax, volumeMin, horizon, targets } = opts
  const stats: BottomOutcomeStats = {
    hits: targets.map(() => []), baseHits: targets.map(() => []), forwards: [], draws: [], n: 0, baseN: 0,
  }
  // 回测路径同样必须先清洗：分位/量能倍数/前向极值都建立在"每根日线都是有限正数"之上。
  // 此前只有展示路径（computePosition）清洗，回测路径直接用原始数组 —— 一根 NaN 会让
  // maxHigh/minLow 变成 NaN，进而让中位数、概率、回撤中位数全部变成 NaN 却被当成有效样本。
  const clean = sanitizeBars(bars)
  const amountOf = (b: DailyBarLite): number => b.vol * b.close
  for (let i = 60; i + horizon < clean.length; i++) {
    const today = clean[i]
    if (!(today.close > 0)) continue
    const win = clean.slice(i - 59, i + 1)
    const closes = [...win.map((b) => b.close)].sort((a, b) => a - b)
    const rank = closes.filter((c) => c <= today.close).length / closes.length
    const avg20 = clean.slice(i - 20, i).reduce((a, b) => a + amountOf(b), 0) / 20
    const volMult = avg20 > 0 ? amountOf(today) / avg20 : 0
    const fwd = clean.slice(i + 1, i + 1 + horizon)
    if (fwd.length < horizon) continue
    // 单遍求极值：避免 Math.max(...arr) 的参数展开，且对非有限值天然免疫
    const ex = extremes(fwd)
    if (ex === null) continue
    const maxHigh = ex.hi
    const lastClose = fwd[fwd.length - 1].close
    const minLow = ex.lo
    const matched = rank <= percentileMax && volMult >= volumeMin
    targets.forEach((t, ti) => {
      const hit = maxHigh >= today.close * (1 + t)
      stats.baseHits[ti].push(hit)
      if (matched) stats.hits[ti].push(hit)
    })
    stats.baseN += 1
    if (matched) {
      stats.n += 1
      stats.forwards.push(lastClose / today.close - 1)
      stats.draws.push(minLow / today.close - 1)
    }
  }
  return stats
}

/**
 * 跨通道合并校准：**逐通道**判定特征与前向收益，只把统计结果合并（样本更足且无跨品种污染）。
 */
export function calibratePooled(
  barsList: readonly (readonly DailyBarLite[])[],
  opts: { percentileMax?: number; volumeMin?: number; horizon?: number; targets?: readonly number[] } = {},
): BottomCalibration {
  const percentileMax = opts.percentileMax ?? 0.25
  const volumeMin = opts.volumeMin ?? 1.0
  const horizon = opts.horizon ?? 5
  const targets = [...(opts.targets ?? [0.01, 0.02])]
  const rule = `近 60 日收盘分位 ≤ ${Math.round(percentileMax * 100)}% 且 当日量能 ≥ 前 20 日均量 × ${volumeMin}（逐通道判定，跨通道合并统计）`
  const pooled: BottomOutcomeStats = { hits: targets.map(() => []), baseHits: targets.map(() => []), forwards: [], draws: [], n: 0, baseN: 0 }
  let used = 0
  for (const bars of barsList) {
    const clean = sanitizeBars(bars)
    if (clean.length < 80) continue
    used += 1
    const st = laneOutcomeStats(clean, { percentileMax, volumeMin, horizon, targets })
    st.hits.forEach((arr, i) => pooled.hits[i].push(...arr))
    st.baseHits.forEach((arr, i) => pooled.baseHits[i].push(...arr))
    pooled.forwards.push(...st.forwards)
    pooled.draws.push(...st.draws)
    pooled.n += st.n
    pooled.baseN += st.baseN
  }
  const rate = (arr: readonly boolean[]): number | null => (arr.length === 0 ? null : arr.filter(Boolean).length / arr.length)
  return {
    rule,
    n: pooled.n,
    baseN: pooled.baseN,
    lanes: used,
    targets: targets.map((t, i) => ({ targetPct: t, prob: rate(pooled.hits[i]), baseRate: rate(pooled.baseHits[i]) })),
    medianForward: medianOf(pooled.forwards),
    medianDrawdown: medianOf(pooled.draws),
    horizon,
  }
}

/**
 * 单通道校准（保留）：面板上若要显示"该通道自己的历史频率"可用。
 */
export function calibrateBottom(
  bars: readonly DailyBarLite[],
  opts: { percentileMax?: number; volumeMin?: number; horizon?: number; targets?: readonly number[] } = {},
): BottomCalibration {
  return calibratePooled([bars], opts)
}

/** 兼容旧调用名 */
export const calibrateAcross = calibratePooled

/** 组装某通道的底部视图 */
export function buildBottomLane(input: {
  secid: string
  name: string
  bars: readonly DailyBarLite[]
  price: number | null
  open: number | null
  high: number | null
  low: number | null
  minutes?: readonly { ts: number; price?: number }[]
  volumeRatio: number | null
  /** 多通道合并样本时传入共享校准结果 */
  calibration?: BottomCalibration
}): RescueBottomLane {
  const price = input.price ?? (input.bars.length > 0 ? input.bars[input.bars.length - 1].close : 0)
  const bars = sanitizeBars(input.bars)
  const pos = computePosition(bars, price)
  const prevLow20 = bars.length >= 20 ? (extremes(bars.slice(-20))?.lo ?? null) : null
  const pat = computePattern({ price: input.price, open: input.open, high: input.high, low: input.low, minutes: input.minutes, prevLow20, atNewLow60: pos.atNewLow60 })
  const cal = input.calibration ?? calibrateBottom(input.bars)
  return {
    secid: input.secid,
    name: input.name,
    price: input.price,
    position: pos,
    pattern: pat,
    volumeRatio: input.volumeRatio,
    positionScore: positionScore(pos),
    patternScore: patternScore(pat),
    calibration: cal,
  }
}

export type { RescueBottomView }
