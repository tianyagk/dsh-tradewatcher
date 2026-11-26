/**
 * 棱镜因子：从日 K 计算「做T 可执行性」需要的 5 个值。
 *
 * 红线：
 * - 只用**已完成** bar（调用方负责剔除当日未完成 bar，或传 cutoff）；
 * - 收益/波动一律用前复权序列；执行价/涨跌停另用不复权；
 * - 缺数返回 null，不用 0 / 默认 2% 冒充。
 */
import type { DayBar } from '../shared/model.ts'

export type AssetType = 'stock' | 'etf' | 'index'

export interface FactorMetrics {
  /** 最后一根已完成 bar 的收盘价 */
  lastClose: number
  /** ATR14 ÷ close × 100 */
  atrPct: number | null
  /** 当前 ATR% 在自身最近 120 个 ATR% 中的分位（0–100） */
  atrRank120: number | null
  /** 日均振幅：mean((high−low)/prevClose) × 100，20 根 */
  amp20Pct: number | null
  /** 一跳 / 现价 × 100 */
  tickPct: number | null
  /** 区间收益（%） */
  ret5?: number | null
  ret20?: number | null
  ret60?: number | null
  /** 均线与偏离（%） */
  ma20?: number | null
  ma60?: number | null
  distMa20Pct?: number | null
  distMa60Pct?: number | null
  /** RSI14（0–100） */
  rsi14?: number | null
  /** 20 日区间位置（0–100，0=最低，100=最高） */
  pos20?: number | null
  /** 20 日趋势效率（0–100，越高越单边） */
  eff20?: number | null
  /** 20 日均成交额（元；按 close×vol×100 估算，vol 为手） */
  adv20?: number | null
  /** 隔夜波动贡献（0–100） */
  onshare20?: number | null
  /** 距涨停/跌停（%；仅股票按 10%，ETF/指数 null） */
  distLimitUpPct?: number | null
  distLimitDownPct?: number | null
  /** 实际使用的已完成 bar 数 */
  bars: number
}

export const MIN_ATR_BARS = 15
export const AMP_WINDOW = 20
export const RANK_WINDOW = 120

/** 从 bar 序列算真实波幅（TR），返回与 bars 等长的数组，首根为 null */
function trueRanges(bars: readonly DayBar[]): Array<number | null> {
  return bars.map((b, i) => {
    const prev = bars[i - 1]
    if (prev === undefined) return null
    if (!(b.high >= b.low) || !(prev.close > 0)) return null
    return Math.max(b.high - b.low, Math.abs(b.high - prev.close), Math.abs(b.low - prev.close))
  })
}

/** ATR14（简单平均，与 atr.ts 口径一致） */
export function atrPctOf(bars: readonly DayBar[], days = 14): number | null {
  if (bars.length < days + 1) return null
  const trs = trueRanges(bars).slice(-days)
  if (trs.some((v) => v === null)) return null
  const atr = (trs as number[]).reduce((a, b) => a + b, 0) / days
  const close = bars[bars.length - 1]?.close ?? 0
  return close > 0 ? (atr / close) * 100 : null
}

/** 日均振幅 AMP20：mean((high−low)/prevClose) × 100（20 根已完成 bar） */
export function amp20PctOf(bars: readonly DayBar[]): number | null {
  if (bars.length < AMP_WINDOW + 1) return null
  const win = bars.slice(-(AMP_WINDOW + 1))
  const vals: number[] = []
  for (let i = 1; i < win.length; i += 1) {
    const prev = win[i - 1]
    const cur = win[i]
    if (prev === undefined || cur === undefined || !(prev.close > 0)) return null
    vals.push((cur.high - cur.low) / prev.close)
  }
  return (vals.reduce((a, b) => a + b, 0) / vals.length) * 100
}

/** 当前 ATR% 在最近 120 个交易日 ATR% 中的分位（0–100） */
export function atrRank120Of(bars: readonly DayBar[]): number | null {
  if (bars.length < MIN_ATR_BARS + 5) return null
  const series: number[] = []
  for (let end = MIN_ATR_BARS; end <= bars.length; end += 1) {
    const pct = atrPctOf(bars.slice(0, end))
    if (pct !== null) series.push(pct)
  }
  const win = series.slice(-RANK_WINDOW)
  const cur = win[win.length - 1]
  if (cur === undefined || win.length < 20) return null
  const below = win.filter((v) => v <= cur).length
  return Math.round((below / win.length) * 1000) / 10
}

/** A股股票 0.01；ETF 0.001；指数无 tick */
export function tickSizeOf(assetType: AssetType): number | null {
  if (assetType === 'stock') return 0.01
  if (assetType === 'etf') return 0.001
  return null
}

const retOf = (bars: readonly DayBar[], n: number): number | null => {
  if (bars.length <= n) return null
  const last = bars[bars.length - 1]!
  const base = bars[bars.length - 1 - n]!
  return base.close > 0 ? (last.close / base.close - 1) * 100 : null
}

const maOf = (bars: readonly DayBar[], n: number): number | null => {
  if (bars.length < n) return null
  const win = bars.slice(-n)
  return win.reduce((a, b) => a + b.close, 0) / n
}

const rsiOf = (bars: readonly DayBar[], n = 14): number | null => {
  if (bars.length <= n) return null
  let gain = 0
  let loss = 0
  for (let i = bars.length - n; i < bars.length; i += 1) {
    const d = bars[i]!.close - bars[i - 1]!.close
    if (d > 0) gain += d
    else loss -= d
  }
  if (gain + loss === 0) return 50
  return (gain / (gain + loss)) * 100
}

/** ADV20：20 日均成交额（close×vol×100，vol 按手） */
export function adv20Of(bars: readonly DayBar[]): number | null {
  const win = bars.slice(-20).filter((b) => b.vol !== null && b.vol > 0 && b.close > 0)
  if (win.length < 20) return null
  return win.reduce((a, b) => a + b.close * (b.vol as number) * 100, 0) / win.length
}

/** 隔夜波动贡献：Var(ln(open/prevClose)) / Var(ln(close/prevClose)) × 100，20 日 */
export function onshare20Of(bars: readonly DayBar[]): number | null {
  if (bars.length < 21) return null
  const win = bars.slice(-21)
  const on: number[] = []
  const all: number[] = []
  for (let i = 1; i < win.length; i += 1) {
    const prev = win[i - 1]!
    const cur = win[i]!
    if (!(prev.close > 0) || !(cur.open > 0) || !(cur.close > 0)) continue
    on.push(Math.log(cur.open / prev.close))
    all.push(Math.log(cur.close / prev.close))
  }
  if (on.length < 15) return null
  const variance = (xs: number[]): number => {
    const m = xs.reduce((a, b) => a + b, 0) / xs.length
    return xs.reduce((a, b) => a + (b - m) ** 2, 0) / xs.length
  }
  const vAll = variance(all)
  if (!(vAll > 0)) return null
  return Math.max(0, Math.min(100, (variance(on) / vAll) * 100))
}

/** 只保留 date <= cutoff 的 bar（回测/PIT 用；cutoff 为空则全量） */
export function barsAt(bars: readonly DayBar[], cutoff?: string): DayBar[] {
  if (cutoff === undefined) return [...bars]
  return bars.filter((b) => b.date <= cutoff)
}

/** 一次算齐 5 个值；数据不足的字段为 null，并保留实际 bar 数 */
export function factorMetricsOf(bars: readonly DayBar[], assetType: AssetType, cutoff?: string): FactorMetrics | null {
  const use = barsAt(bars, cutoff)
  const last = use[use.length - 1]
  if (last === undefined) return null
  const tick = tickSizeOf(assetType)
  const ma20 = maOf(use, 20)
  const ma60 = maOf(use, 60)
  const win20 = use.slice(-20)
  const hi20 = win20.length === 20 ? Math.max(...win20.map((b) => b.high)) : null
  const lo20 = win20.length === 20 ? Math.min(...win20.map((b) => b.low)) : null
  const pos20 = hi20 !== null && lo20 !== null && hi20 > lo20 ? ((last.close - lo20) / (hi20 - lo20)) * 100 : null
  const changes = use.slice(-21).map((b, i, arr) => (i === 0 ? 0 : Math.abs(b.close - arr[i - 1]!.close)))
  const path = changes.reduce((a, b) => a + b, 0)
  const eff20 = use.length >= 21 && path > 0 ? (Math.abs(last.close - use[use.length - 21]!.close) / path) * 100 : null
  const prevClose = use[use.length - 2]?.close ?? null
  const distLimitUpPct = assetType === 'stock' && prevClose !== null && prevClose > 0 && last.close > 0 ? ((prevClose * 1.1) / last.close - 1) * 100 : null
  const distLimitDownPct = assetType === 'stock' && prevClose !== null && prevClose > 0 && last.close > 0 ? ((last.close - prevClose * 0.9) / last.close) * 100 : null
  return {
    lastClose: last.close,
    atrPct: atrPctOf(use),
    atrRank120: atrRank120Of(use),
    amp20Pct: amp20PctOf(use),
    tickPct: tick === null || !(last.close > 0) ? null : (tick / last.close) * 100,
    ret5: retOf(use, 5),
    ret20: retOf(use, 20),
    ret60: retOf(use, 60),
    ma20,
    ma60,
    distMa20Pct: ma20 !== null && ma20 > 0 ? (last.close / ma20 - 1) * 100 : null,
    distMa60Pct: ma60 !== null && ma60 > 0 ? (last.close / ma60 - 1) * 100 : null,
    rsi14: rsiOf(use),
    pos20,
    eff20,
    adv20: adv20Of(use),
    onshare20: onshare20Of(use),
    distLimitUpPct,
    distLimitDownPct,
    bars: use.length,
  }
}
