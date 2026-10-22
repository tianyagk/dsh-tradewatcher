/**
 * K 线区间买卖统计（纯函数，无 React —— 便于在 strip-types 下单测）。
 * 口径行、读屏摘要与图上的 B/S 标记共用同一份 bars + markers + range。
 */
import type { CandleMarker } from './charts.tsx'
import type { TradeMark } from '../shared/model.ts'
import { shDayText } from './marketTime.ts'

/** 区间买卖统计（口径行/读屏摘要共用；与图同一份 bars + markers + range） */
export interface RangeTradeStats {
  buyCount: number
  sellCount: number
  netQty: number
  buyAvg: number | null
  sellAvg: number | null
  outCount: number
}

/** 流水 → 图上 B/S 标记（按交易日归入所属 K 线；与原先在 `chartBody` 里内联的映射逐字一致） */
export function tradeMarkersOf(
  bars: ReadonlyArray<{ date: string }>,
  trades: readonly TradeMark[],
): CandleMarker[] {
  if (bars.length === 0) return []
  const firstTs = Date.parse(`${(bars[0] as { date: string }).date}T00:00:00`) - 86_400_000 * 8
  return trades
    .filter((tr) => tr.ts >= firstTs)
    .map((tr) => ({ date: shDayText(tr.ts), kind: tr.verb, qty: tr.qty, price: tr.price }))
}

/**
 * 区间统计：区间内 B/S 笔数、净买入、买入/卖出均价，以及区间外还剩多少笔。
 * 日期归属与图上标记同一口径（最后一根 `date <= 交易日` 的 bar）。
 */
export function tradeStatsOf(
  bars: ReadonlyArray<{ date: string }>,
  markers: readonly CandleMarker[],
  s: number,
  e: number,
): RangeTradeStats {
  const empty: RangeTradeStats = { buyCount: 0, sellCount: 0, netQty: 0, buyAvg: null, sellAvg: null, outCount: 0 }
  if (bars.length === 0) return { ...empty, outCount: markers.length }
  const last = bars.length - 1
  let buyQty = 0
  let sellQty = 0
  let buyAmt = 0
  let sellAmt = 0
  let buyCount = 0
  let sellCount = 0
  let outCount = 0
  for (const mk of markers) {
    const date = mk.date
    let lo = 0
    let hi = last
    if (date <= (bars[0] as { date: string }).date) lo = 0
    else if (date >= (bars[last] as { date: string }).date) lo = last
    else {
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1
        if ((bars[mid] as { date: string }).date <= date) lo = mid
        else hi = mid - 1
      }
    }
    if (lo < s || lo >= e) {
      outCount += 1
      continue
    }
    const qty = mk.qty ?? 0
    const amount = qty * (mk.price ?? 0)
    if (mk.kind === 'buy') {
      buyQty += qty; buyAmt += amount; buyCount += 1
    } else {
      sellQty += qty; sellAmt += amount; sellCount += 1
    }
  }
  return {
    buyCount,
    sellCount,
    netQty: Math.round((buyQty - sellQty) * 1e4) / 1e4,
    buyAvg: buyQty > 0 ? buyAmt / buyQty : null,
    sellAvg: sellQty > 0 ? sellAmt / sellQty : null,
    outCount,
  }
}

/** 口径行追加的区间统计（**不新增第二行**；无区间买卖 ⇒ `区间内无买卖点`） */
export function rangeStatsText(stats: RangeTradeStats | null): string {
  if (stats === null) return ''
  if (stats.buyCount + stats.sellCount === 0) return '区间内无买卖点'
  const parts = [
    `区间内 B ${stats.buyCount} 笔 / S ${stats.sellCount} 笔`,
    `净${stats.netQty >= 0 ? '买入' : '卖出'} ${Math.abs(stats.netQty)} 份/股`,
  ]
  if (stats.buyAvg !== null && stats.sellAvg !== null) {
    parts.push(`买入均价 ${stats.buyAvg.toFixed(3)} / 卖出均价 ${stats.sellAvg.toFixed(3)}`)
  }
  return parts.join(' · ')
}

/** 状态行 = 原口径 + ` · ` + 区间统计（始终一行；空值不加尾巴） */
export function caliberWithStats(base: string, stats: RangeTradeStats | null): string {
  const extra = rangeStatsText(stats)
  if (extra === '') return base
  return base === '' ? extra : `${base} · ${extra}`
}
