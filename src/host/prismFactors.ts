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
  return {
    lastClose: last.close,
    atrPct: atrPctOf(use),
    atrRank120: atrRank120Of(use),
    amp20Pct: amp20PctOf(use),
    tickPct: tick === null || !(last.close > 0) ? null : (tick / last.close) * 100,
    bars: use.length,
  }
}
