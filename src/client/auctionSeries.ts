/**
 * 【竞价参考价曲线】的纯几何（无 React，便于单测）。
 *
 * 一条线 = `ref`（虚拟参考价）；下部细柱 = `matched`（匹配量）。
 * 高度固定 44（≤48），**没有坐标轴文字、没有网格、没有浮框**。
 */
import type { AuctionPoint } from '../shared/model.ts'

export const AUCTION_SPARK_HEIGHT = 44
export const AUCTION_SPARK_WIDTH = 180

export interface AuctionSparkBar {
  x: number
  y: number
  w: number
  h: number
}

export interface AuctionSparkGeometry {
  width: number
  height: number
  /** 折线 path（M/L） */
  line: string
  /** 量柱（正柱，贴底） */
  bars: AuctionSparkBar[]
  stats: { max: number; min: number }
}

const usable = (series: readonly AuctionPoint[]): AuctionPoint[] =>
  series
    .filter((p) => Number.isFinite(p.t) && Number.isFinite(p.ref) && p.ref > 0 && Number.isFinite(p.matched) && p.matched > 0)
    .slice()
    .sort((a, b) => a.t - b.t)

/** 当日参考价区间（两个数用 ` · ` 分隔；没有点 ⇒ `—`） */
export function auctionSeriesText(series: readonly AuctionPoint[]): string {
  const stats = auctionSparkStats(series)
  if (stats === null) return '—'
  return `${stats.max.toFixed(2)} · ${stats.min.toFixed(2)}`
}

export function auctionSparkStats(series: readonly AuctionPoint[]): { max: number; min: number } | null {
  const pts = usable(series)
  if (pts.length === 0) return null
  const refs = pts.map((p) => p.ref)
  return { max: Math.max(...refs), min: Math.min(...refs) }
}

/** 几何：空序列 ⇒ null（界面显示 `—`，不画空图） */
export function auctionSparkGeometry(
  series: readonly AuctionPoint[],
  width = AUCTION_SPARK_WIDTH,
  height = AUCTION_SPARK_HEIGHT,
): AuctionSparkGeometry | null {
  const pts = usable(series)
  if (pts.length === 0 || width <= 4 || height <= 8) return null
  const padX = 2
  const padTop = 3
  const barZone = Math.min(8, Math.max(4, height * 0.18))
  const lineH = height - padTop - barZone - 2
  const innerW = width - padX * 2
  const t0 = pts[0]?.t as number
  const t1 = (pts[pts.length - 1]?.t as number)
  const tSpan = t1 - t0
  const refs = pts.map((p) => p.ref)
  const lo = Math.min(...refs)
  const hi = Math.max(...refs)
  const refSpan = hi - lo
  const xOf = (t: number): number => (tSpan > 0 ? padX + ((t - t0) / tSpan) * innerW : padX + innerW / 2)
  const yOf = (ref: number): number => (refSpan > 0 ? padTop + ((hi - ref) / refSpan) * lineH : padTop + lineH / 2)
  const line = pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${xOf(p.t).toFixed(1)},${yOf(p.ref).toFixed(1)}`).join(' ')
  const maxMatched = Math.max(...pts.map((p) => p.matched))
  const barW = Math.max(1, (innerW / pts.length) * 0.45)
  const bars = pts.map((p) => {
    const h = Math.max(1, (p.matched / maxMatched) * barZone)
    return { x: xOf(p.t) - barW / 2, y: height - h, w: barW, h }
  })
  return { width, height, line, bars, stats: { max: hi, min: lo } }
}

/**
 * 断言 ⑤ 的源码判据：迷你图里**不得**有坐标轴文字/网格/浮框，高度 ≤48。
 * 只看代码形状（不看注释里的中文说明）。注入：加一个 `text` 元素 ⇒ 非空。
 */
export function auctionSparkProblems(src: string): string[] {
  const bad: string[] = []
  if (/createElement\(\s*'text'/.test(src) || /<text[\s>]/.test(src)) bad.push('曲线出现坐标轴文字')
  if (/createElement\(\s*'title'/.test(src) || /\btitle\s*=/.test(src)) bad.push('曲线出现浮框/标题')
  if (/\bgrid\b|strokeDasharray/.test(src)) bad.push('曲线出现网格')
  if (!src.includes('Math.min(48')) bad.push('高度必须 ≤48')
  return bad
}
