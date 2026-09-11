/**
 * 抽屉用多窗格图表：
 *   TrendChart  — 分时 / 五日：主图（价格+均价线+昨收基准）+ 成交量 + MACD
 *   KlineChart  — 日/周/月/年K：蜡烛+MA5/10/30/60 + 成交量 + MACD + 日期宽度缩放窗
 * 两种图共用：纵轴刻度线、成交量柱、MACD（DIF/DEA/HIST）。
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { CandleMarker, SparkMarker } from './charts.tsx'
import { fmtAxis, ma, macd, niceTicks } from './indicators.ts'

const PAD_X = 8
const PAD_TOP = 8
const AXIS_H = 16
const GAP = 6

const MA_STYLE: Array<{ period: number; color: string }> = [
  { period: 5, color: '#e8a33d' },
  { period: 10, color: '#4d9cf6' },
  { period: 30, color: '#b06cf0' },
  { period: 60, color: '#8a919e' },
]

interface Point {
  t: number
  value: number
  vol: number | null
  avg: number | null
  label: string
}

/** 压缩时间轴：大于中位步长的跳空（午休/隔夜/周末）按中位步长折叠。 */
function compressedAxis(times: readonly number[]): { eff: number[]; span: number } {
  const deltas: number[] = []
  for (let i = 1; i < times.length; i += 1) {
    const d = times[i] - times[i - 1]
    if (d > 0) deltas.push(d)
  }
  deltas.sort((a, b) => a - b)
  const median = deltas.length > 0 ? deltas[Math.floor(deltas.length / 2)] : 60_000
  const eff: number[] = [0]
  for (let i = 1; i < times.length; i += 1) {
    const d = times[i] - times[i - 1]
    eff.push(eff[i - 1] + (d > 0 ? Math.min(d, median) : median))
  }
  return { eff, span: eff[eff.length - 1] > 0 ? eff[eff.length - 1] : 1 }
}

/** 纵轴刻度：横向网格线 + 右侧数值。 */
function yGrid(args: {
  top: number
  height: number
  lo: number
  hi: number
  padX: number
  innerW: number
  count?: number
  unit?: string
}): React.ReactNode[] {
  const { top, height, lo, hi, padX, innerW } = args
  const ticks = niceTicks(lo, hi, args.count ?? 4)
  const out: React.ReactNode[] = []
  for (const v of ticks) {
    const y = top + ((hi - v) / (hi - lo || 1)) * height
    out.push(React.createElement('line', {
      key: `g${v}`,
      x1: padX, y1: y, x2: padX + innerW, y2: y,
      style: { stroke: 'var(--tw-border)' }, strokeWidth: 1, strokeDasharray: '2 3', opacity: 0.9,
    }))
    out.push(React.createElement('text', {
      key: `gt${v}`,
      x: padX + innerW - 1, y: y - 2, textAnchor: 'end',
      style: { fill: 'var(--tw-muted)', fontSize: 9 },
    }, `${fmtAxis(v)}${args.unit ?? ''}`))
  }
  return out
}

/** 成交量窗格。 */
function volumePane(args: {
  top: number
  height: number
  vols: Array<number | null>
  up: boolean[]
  xAt: (i: number) => number
  barW: number
  padX: number
  innerW: number
}): React.ReactNode[] {
  const { top, height, vols, up, xAt, barW, padX, innerW } = args
  const max = Math.max(1, ...vols.map((v) => v ?? 0))
  const baseY = top + height
  const out: React.ReactNode[] = [
    React.createElement('line', { key: 'vb', x1: padX, y1: baseY, x2: padX + innerW, y2: baseY, style: { stroke: 'var(--tw-border)' }, strokeWidth: 1 }),
    React.createElement('text', { key: 'vt', x: padX, y: top + 9, style: { fill: 'var(--tw-muted)', fontSize: 9 } },
      `成交量 ${fmtAxis(max)}`),
  ]
  vols.forEach((v, i) => {
    if (v === null || v <= 0) return
    const h = Math.max(1, (v / max) * (height - 12))
    const color = up[i] ? 'var(--tw-up)' : 'var(--tw-down)'
    out.push(React.createElement('rect', {
      key: `v${i}`,
      x: xAt(i) - barW / 2,
      y: baseY - h,
      width: barW,
      height: h,
      style: { fill: color },
      opacity: 0.55,
    }))
  })
  return out
}

/** MACD 窗格：HIST 柱 + DIF/DEA 线 + 零轴。 */
function macdPane(args: {
  top: number
  height: number
  dif: Array<number | null>
  dea: Array<number | null>
  hist: Array<number | null>
  xAt: (i: number) => number
  barW: number
  padX: number
  innerW: number
  upColor: string
  downColor: string
}): React.ReactNode[] {
  const { top, height, dif, dea, hist, xAt, barW, padX, innerW, upColor, downColor } = args
  const vals = [...dif, ...dea, ...hist].filter((v): v is number => v !== null)
  if (vals.length === 0) {
    return [React.createElement('text', { key: 'mx', x: padX, y: top + 10, style: { fill: 'var(--tw-muted)', fontSize: 9 } }, 'MACD')]
  }
  const maxAbs = Math.max(...vals.map((v) => Math.abs(v)), 1e-9)
  const mid = top + height / 2
  const yOf = (v: number): number => mid - (v / maxAbs) * (height / 2 - 4)
  const out: React.ReactNode[] = [
    React.createElement('line', { key: 'zero', x1: padX, y1: mid, x2: padX + innerW, y2: mid, style: { stroke: 'var(--tw-border)' }, strokeWidth: 1 }),
    React.createElement('text', { key: 'mt', x: padX, y: top + 9, style: { fill: 'var(--tw-muted)', fontSize: 9 } }, 'MACD(12,26,9)'),
  ]
  hist.forEach((v, i) => {
    if (v === null) return
    const y = yOf(v)
    out.push(React.createElement('rect', {
      key: `h${i}`,
      x: xAt(i) - barW / 2,
      y: Math.min(y, mid),
      width: barW,
      height: Math.max(1, Math.abs(mid - y)),
      style: { fill: v >= 0 ? upColor : downColor },
      opacity: 0.6,
    }))
  })
  const path = (series: Array<number | null>, color: string, key: string): React.ReactNode => {
    let d = ''
    let open = false
    series.forEach((v, i) => {
      if (v === null) { open = false; return }
      d += `${open ? 'L' : 'M'}${xAt(i).toFixed(1)},${yOf(v).toFixed(1)} `
      open = true
    })
    return React.createElement('path', { key, d, fill: 'none', style: { stroke: color }, strokeWidth: 1.2 })
  }
  out.push(path(dif, '#4d9cf6', 'dif'))
  out.push(path(dea, '#e8a33d', 'dea'))
  return out
}

/** ───────────────────────── 分时 / 五日 ───────────────────────── */

export function TrendChart(props: {
  points: Point[]
  baseline?: number | null
  markers?: SparkMarker[]
  width: number
  redUp: boolean
  /** 五日：每个交易日起始索引（画分隔线 + 日期） */
  dayBreaks?: number[]
  mainH?: number
  volH?: number
  macdH?: number
}): React.ReactElement {
  const { points, width, redUp } = props
  const mainH = props.mainH ?? 200
  const volH = props.volH ?? 54
  const macdH = props.macdH ?? 64
  const height = PAD_TOP + mainH + GAP + volH + GAP + macdH + AXIS_H
  const innerW = width - PAD_X * 2

  const view = useMemo(() => {
    if (points.length < 2) return null
    const { eff, span } = compressedAxis(points.map((p) => p.t))
    const xAt = (i: number): number => PAD_X + (eff[i] / span) * innerW
    const values = points.map((p) => p.value)
    const avgs = points.map((p) => p.avg)
    const candidates = [...values, ...avgs.filter((v): v is number => v !== null)]
    if (props.baseline !== null && props.baseline !== undefined) candidates.push(props.baseline)
    let lo = Math.min(...candidates)
    let hi = Math.max(...candidates)
    const pad = (hi - lo) * 0.06 || 1
    lo -= pad
    hi += pad
    const yOf = (v: number): number => PAD_TOP + ((hi - v) / (hi - lo)) * mainH
    const m = macd(values)
    const up = values.map((v, i) => (i === 0 ? true : v >= values[i - 1]))
    const barW = Math.max(1, Math.min(6, (innerW / points.length) * 0.7))
    return { xAt, yOf, lo, hi, values, avgs, m, up, barW }
  }, [points, innerW, mainH, props.baseline])

  if (view === null) {
    return React.createElement('div', { className: 'tw-muted', style: { textAlign: 'center', padding: 40 } }, '暂无分时数据')
  }

  const { xAt, yOf, lo, hi, values, avgs, m, up, barW } = view
  const volTop = PAD_TOP + mainH + GAP
  const macdTop = volTop + volH + GAP
  const linePath = values.map((v, i) => `${i === 0 ? 'M' : 'L'}${xAt(i).toFixed(1)},${yOf(v).toFixed(1)}`).join(' ')
  const avgPath = ((): string => {
    let d = ''
    let open = false
    avgs.forEach((v, i) => {
      if (v === null) { open = false; return }
      d += `${open ? 'L' : 'M'}${xAt(i).toFixed(1)},${yOf(v).toFixed(1)} `
      open = true
    })
    return d
  })()
  const lastIndex = points.length - 1
  const lastUp = props.baseline !== null && props.baseline !== undefined
    ? values[lastIndex] >= props.baseline
    : values[lastIndex] >= values[0]
  const mainColor = lastUp === redUp ? 'var(--tw-up)' : 'var(--tw-down)'
  const area = `${linePath} L${xAt(lastIndex).toFixed(1)},${PAD_TOP + mainH} L${xAt(0).toFixed(1)},${PAD_TOP + mainH} Z`

  const children: React.ReactNode[] = []
  children.push(React.createElement('defs', { key: 'defs' },
    React.createElement('linearGradient', { id: 'tw-trend-fill', x1: '0', y1: '0', x2: '0', y2: '1' },
      React.createElement('stop', { offset: '0%', style: { stopColor: mainColor, stopOpacity: 0.28 } }),
      React.createElement('stop', { offset: '100%', style: { stopColor: mainColor, stopOpacity: 0.02 } }),
    ),
  ))
  children.push(...yGrid({ top: PAD_TOP, height: mainH, lo, hi, padX: PAD_X, innerW }))
  children.push(React.createElement('path', { key: 'area', d: area, fill: 'url(#tw-trend-fill)', style: { stroke: 'none' } }))
  if (props.baseline !== null && props.baseline !== undefined) {
    const y = yOf(props.baseline)
    children.push(React.createElement('line', {
      key: 'base', x1: PAD_X, y1: y, x2: PAD_X + innerW, y2: y,
      style: { stroke: 'var(--tw-muted)' }, strokeWidth: 1, strokeDasharray: '3 3', opacity: 0.75,
    }))
  }
  children.push(React.createElement('path', { key: 'line', d: linePath, fill: 'none', style: { stroke: mainColor }, strokeWidth: 1.4 }))
  if (avgPath !== '') {
    children.push(React.createElement('path', { key: 'avg', d: avgPath, fill: 'none', style: { stroke: '#e8a33d' }, strokeWidth: 1, opacity: 0.95 }))
  }
  children.push(React.createElement('circle', { key: 'last', cx: xAt(lastIndex), cy: yOf(values[lastIndex]), r: 2.6, style: { fill: mainColor, stroke: 'var(--tw-card)' }, strokeWidth: 1 }))

  // B/S 标记
  for (const [i, mk] of (props.markers ?? []).entries()) {
    let idx = 0
    for (let k = 0; k < points.length; k += 1) { if (points[k].t <= mk.t) idx = k; else break }
    const isBuy = mk.kind === 'buy'
    const color = isBuy ? (redUp ? 'var(--tw-up)' : 'var(--tw-down)') : (redUp ? 'var(--tw-down)' : 'var(--tw-up)')
    const mx = xAt(idx)
    const my = yOf(mk.value)
    const ty = isBuy ? Math.min(my + 14, PAD_TOP + mainH - 2) : Math.max(my - 6, PAD_TOP + 8)
    children.push(React.createElement('g', { key: `m${i}` },
      React.createElement('line', { x1: mx, y1: my, x2: mx, y2: ty, style: { stroke: color }, strokeWidth: 1, opacity: 0.7 }),
      React.createElement('circle', { cx: mx, cy: my, r: 3, style: { fill: color, stroke: 'var(--tw-card)' }, strokeWidth: 1 },
        mk.title !== undefined ? React.createElement('title', null, mk.title) : null),
      React.createElement('text', {
        x: mx, y: isBuy ? ty + 9 : ty - 2, textAnchor: 'middle',
        style: { fill: color, fontSize: 10, fontWeight: 700, paintOrder: 'stroke', stroke: 'var(--tw-card)', strokeWidth: 2.5 },
      }, isBuy ? 'B' : 'S'),
    ))
  }

  // 五日分隔线
  for (const brk of props.dayBreaks ?? []) {
    if (brk <= 0 || brk >= points.length) continue
    const x = xAt(brk)
    children.push(React.createElement('line', {
      key: `brk${brk}`, x1: x, y1: PAD_TOP, x2: x, y2: PAD_TOP + mainH,
      style: { stroke: 'var(--tw-border-strong)' }, strokeWidth: 1, strokeDasharray: '2 2', opacity: 0.8,
    }))
    children.push(React.createElement('text', {
      key: `brkt${brk}`, x: x + 3, y: PAD_TOP + 9, style: { fill: 'var(--tw-muted)', fontSize: 9 },
    }, points[brk].label.slice(5, 10)))
  }

  children.push(...volumePane({ top: volTop, height: volH, vols: points.map((p) => p.vol), up, xAt, barW, padX: PAD_X, innerW }))
  children.push(...macdPane({
    top: macdTop, height: macdH, dif: m.dif, dea: m.dea, hist: m.hist, xAt, barW, padX: PAD_X, innerW,
    upColor: redUp ? 'var(--tw-up)' : 'var(--tw-down)', downColor: redUp ? 'var(--tw-down)' : 'var(--tw-up)',
  }))
  children.push(React.createElement('text', {
    key: 'x0', x: PAD_X, y: height - 4, style: { fill: 'var(--tw-muted)', fontSize: 9 },
  }, points[0].label.slice(5)))
  children.push(React.createElement('text', {
    key: 'x1', x: PAD_X + innerW, y: height - 4, textAnchor: 'end', style: { fill: 'var(--tw-muted)', fontSize: 9 },
  }, points[lastIndex].label.slice(5, 16)))

  return React.createElement('svg', { width, height, viewBox: `0 0 ${width} ${height}`, style: { display: 'block' } }, children)
}

/** ───────────────────────── 日/周/月/年 K ───────────────────────── */

function defaultWindow(klt: 101 | 102 | 103 | 104): number {
  return klt === 101 ? 120 : klt === 102 ? 80 : klt === 103 ? 48 : 12
}

export function KlineChart(props: {
  bars: Array<{ date: string; open: number; close: number; high: number; low: number; vol: number | null }>
  markers?: CandleMarker[]
  width: number
  redUp: boolean
  klt: 101 | 102 | 103 | 104
  mainH?: number
  volH?: number
  macdH?: number
}): React.ReactElement {
  const { bars, width, redUp, klt } = props
  const mainH = props.mainH ?? 230
  const volH = props.volH ?? 54
  const macdH = props.macdH ?? 64
  const height = PAD_TOP + mainH + GAP + volH + GAP + macdH + AXIS_H
  const innerW = width - PAD_X * 2

  const signature = `${bars.length}|${bars[0]?.date ?? ''}|${bars[bars.length - 1]?.date ?? ''}|${klt}`
  const empty = bars.length === 0
  const [range, setRange] = useState<[number, number]>(() => [
    Math.max(0, bars.length - defaultWindow(klt)),
    bars.length,
  ])
  useEffect(() => {
    setRange([Math.max(0, bars.length - defaultWindow(klt)), bars.length])
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature])

  const closes = useMemo(() => bars.map((b) => b.close), [bars])
  const mas = useMemo(() => MA_STYLE.map((s) => ({ ...s, values: ma(closes, s.period) })), [closes])
  const m = useMemo(() => macd(closes), [closes])

  if (empty) {
    return React.createElement('div', { className: 'tw-muted', style: { textAlign: 'center', padding: 40 } }, '暂无K线数据')
  }
  const [s, e] = [Math.max(0, Math.min(range[0], bars.length - 2)), Math.min(Math.max(range[1], 2), bars.length)]
  const count = Math.max(1, e - s)
  const step = innerW / count
  const xAt = (i: number): number => PAD_X + (i - s) * step + step / 2
  const barW = Math.max(1.2, Math.min(11, step * 0.62))

  const visHigh = bars.slice(s, e).map((b) => b.high)
  const visLow = bars.slice(s, e).map((b) => b.low)
  const maVisible = mas.flatMap((ser) => ser.values.slice(s, e).filter((v): v is number => v !== null))
  const hi = Math.max(...visHigh, ...maVisible)
  const lo = Math.min(...visLow, ...maVisible)
  const pad = (hi - lo) * 0.05 || 1
  const yOf = (v: number): number => PAD_TOP + ((hi + pad - v) / (hi - lo + pad * 2)) * mainH

  const volTop = PAD_TOP + mainH + GAP
  const macdTop = volTop + volH + GAP

  const children: React.ReactNode[] = []
  children.push(...yGrid({ top: PAD_TOP, height: mainH, lo: lo - pad, hi: hi + pad, padX: PAD_X, innerW }))
  for (let i = s; i < e; i += 1) {
    const b = bars[i]
    const up = b.close >= b.open
    const color = up === redUp ? 'var(--tw-up)' : 'var(--tw-down)'
    const x = xAt(i)
    children.push(React.createElement('line', { key: `w${i}`, x1: x, y1: yOf(b.high), x2: x, y2: yOf(b.low), style: { stroke: color }, strokeWidth: 1 }))
    const yO = yOf(b.open)
    const yC = yOf(b.close)
    children.push(React.createElement('rect', {
      key: `b${i}`, x: x - barW / 2, y: Math.min(yO, yC), width: barW, height: Math.max(1, Math.abs(yC - yO)),
      style: { fill: color }, rx: 0.5,
    }))
  }
  for (const ser of mas) {
    let d = ''
    let open = false
    for (let i = s; i < e; i += 1) {
      const v = ser.values[i]
      if (v === null) { open = false; continue }
      d += `${open ? 'L' : 'M'}${xAt(i).toFixed(1)},${yOf(v).toFixed(1)} `
      open = true
    }
    if (d !== '') children.push(React.createElement('path', { key: `ma${ser.period}`, d, fill: 'none', style: { stroke: ser.color }, strokeWidth: 1.1, opacity: 0.95 }))
  }

  // B/S 标记（按日期归入所属 K 线）
  const idxOfDate = (date: string): number => {
    let lo2 = s
    let hi2 = e - 1
    if (date <= bars[lo2].date) return lo2
    if (date >= bars[hi2].date) return hi2
    while (lo2 < hi2) {
      const mid = (lo2 + hi2 + 1) >> 1
      if (bars[mid].date <= date) lo2 = mid
      else hi2 = mid - 1
    }
    return lo2
  }
  const grouped = new Map<number, { buy: number; sell: number }>()
  for (const mk of props.markers ?? []) {
    const i = idxOfDate(mk.date)
    const g = grouped.get(i) ?? { buy: 0, sell: 0 }
    if (mk.kind === 'buy') g.buy += 1
    else g.sell += 1
    grouped.set(i, g)
  }
  for (const [i, g] of grouped) {
    const b = bars[i]
    const x = xAt(i)
    if (g.buy > 0) {
      const my = Math.min(yOf(b.low) + 13, PAD_TOP + mainH - 1)
      children.push(React.createElement('g', { key: `mb${i}` },
        React.createElement('line', { x1: x, y1: yOf(b.low), x2: x, y2: my - 4, style: { stroke: redUp ? 'var(--tw-up)' : 'var(--tw-down)' }, strokeWidth: 1, opacity: 0.7 }),
        React.createElement('text', { x, y: my, textAnchor: 'middle', style: { fill: redUp ? 'var(--tw-up)' : 'var(--tw-down)', fontSize: 9.5, fontWeight: 700, paintOrder: 'stroke', stroke: 'var(--tw-card)', strokeWidth: 2.5 } }, g.buy > 1 ? `B${g.buy}` : 'B'),
      ))
    }
    if (g.sell > 0) {
      const my = Math.max(yOf(b.high) - 8, PAD_TOP + 8)
      children.push(React.createElement('g', { key: `ms${i}` },
        React.createElement('line', { x1: x, y1: yOf(b.high), x2: x, y2: my + 4, style: { stroke: redUp ? 'var(--tw-down)' : 'var(--tw-up)' }, strokeWidth: 1, opacity: 0.7 }),
        React.createElement('text', { x, y: my, textAnchor: 'middle', style: { fill: redUp ? 'var(--tw-down)' : 'var(--tw-up)', fontSize: 9.5, fontWeight: 700, paintOrder: 'stroke', stroke: 'var(--tw-card)', strokeWidth: 2.5 } }, g.sell > 1 ? `S${g.sell}` : 'S'),
      ))
    }
  }

  children.push(...volumePane({
    top: volTop, height: volH,
    vols: bars.slice(s, e).map((b) => b.vol),
    up: bars.slice(s, e).map((b) => b.close >= b.open),
    xAt: (i) => xAt(i + s), barW, padX: PAD_X, innerW,
  }))
  children.push(...macdPane({
    top: macdTop, height: macdH,
    dif: m.dif.slice(s, e), dea: m.dea.slice(s, e), hist: m.hist.slice(s, e),
    xAt: (i) => xAt(i + s), barW, padX: PAD_X, innerW,
    upColor: redUp ? 'var(--tw-up)' : 'var(--tw-down)', downColor: redUp ? 'var(--tw-down)' : 'var(--tw-up)',
  }))
  // 底部日期（首/中/尾）
  const labelIdx = [s, Math.floor((s + e - 1) / 2), e - 1]
  labelIdx.forEach((i, k) => {
    children.push(React.createElement('text', {
      key: `d${k}`,
      x: k === 0 ? PAD_X : k === 2 ? PAD_X + innerW : xAt(i),
      y: height - 4,
      textAnchor: k === 0 ? 'start' : k === 2 ? 'end' : 'middle',
      style: { fill: 'var(--tw-muted)', fontSize: 9 },
    }, bars[i].date))
  })
  const svg = React.createElement('svg', { width, height, viewBox: `0 0 ${width} ${height}`, style: { display: 'block' } }, children)

  const legend = React.createElement('div', { className: 'tw-ma-legend', style: { display: 'flex', gap: 10, flexWrap: 'wrap', fontSize: 10, fontFamily: 'var(--tw-mono)', margin: '4px 0 0' } },
    ...mas.map((ser) => {
      let lastV: number | null = null
      for (let i = e - 1; i >= s; i -= 1) { if (ser.values[i] !== null) { lastV = ser.values[i] as number; break } }
      return React.createElement('span', { key: `lg${ser.period}`, style: { color: ser.color } },
        `MA${ser.period} ${lastV === null ? '—' : fmtAxis(lastV)}`)
    }),
  )

  return React.createElement('div', { className: 'tw-kline' },
    React.createElement(WheelZoom, { bars, range: [s, e], width, onChange: setRange }, svg),
    legend,
    React.createElement(RangeSlider, { total: bars.length, range: [s, e], bars, onChange: setRange }),
  )
}

/** 滚轮缩放：以光标位置为中心缩放可视区间。 */
function WheelZoom(props: {
  bars: Array<{ date: string }>
  range: [number, number]
  width: number
  onChange: (r: [number, number]) => void
  children?: React.ReactNode
}): React.ReactElement {
  const ref = useRef<HTMLDivElement | null>(null)
  const onWheel = useCallback((ev: WheelEvent) => {
    const el = ref.current
    if (el === null) return
    ev.preventDefault()
    const rect = el.getBoundingClientRect()
    const ratio = Math.min(1, Math.max(0, (ev.clientX - rect.left) / Math.max(1, rect.width)))
    const [s, e] = props.range
    const count = e - s
    const factor = ev.deltaY > 0 ? 1.25 : 0.8
    const next = Math.max(8, Math.min(props.bars.length, Math.round(count * factor)))
    const anchor = s + Math.round(count * ratio)
    let ns = anchor - Math.round(next * ratio)
    ns = Math.max(0, Math.min(props.bars.length - next, ns))
    props.onChange([ns, ns + next])
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.range, props.bars.length, props.onChange])
  useEffect(() => {
    const el = ref.current
    if (el === null) return
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [onWheel])
  return React.createElement('div', { ref, style: { width: props.width, touchAction: 'none' } }, props.children)
}

/** 日期宽度缩放窗：双滑块 + 常用区间快捷键。 */
function RangeSlider(props: {
  total: number
  range: [number, number]
  bars: Array<{ date: string }>
  onChange: (r: [number, number]) => void
}): React.ReactElement | null {
  const { total, range, bars } = props
  const trackRef = useRef<HTMLDivElement | null>(null)
  const drag = useRef<null | 'start' | 'end' | 'mid'>(null)
  const [s, e] = range

  const indexAt = (clientX: number): number => {
    const el = trackRef.current
    if (el === null) return 0
    const rect = el.getBoundingClientRect()
    const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / Math.max(1, rect.width)))
    return Math.round(ratio * (total - 1))
  }

  useEffect(() => {
    const move = (ev: PointerEvent): void => {
      if (drag.current === null) return
      const idx = indexAt(ev.clientX)
      if (drag.current === 'start') props.onChange([Math.min(idx, e - 8), e])
      else if (drag.current === 'end') props.onChange([s, Math.max(idx, s + 8)])
      else {
        const width = e - s
        const ns = Math.max(0, Math.min(total - width, idx - Math.round(width / 2)))
        props.onChange([ns, ns + width])
      }
    }
    const up = (): void => { drag.current = null }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    return () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s, e, total])

  if (total < 12) return null
  const pct = (i: number): number => (i / Math.max(1, total - 1)) * 100

  const quick = (days: number | null): void => {
    if (days === null) { props.onChange([0, total]); return }
    const cutoff = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10)
    let idx = bars.findIndex((b) => b.date >= cutoff)
    if (idx < 0) idx = 0
    idx = Math.max(0, Math.min(idx, total - 8))
    props.onChange([idx, total])
  }

  const start = React.createElement('div', {
    key: 'start',
    className: 'tw-zoom-h',
    style: { left: `calc(${pct(s)}% - 6px)` },
    onPointerDown: (ev: React.PointerEvent) => { ev.preventDefault(); drag.current = 'start' },
  })
  const end = React.createElement('div', {
    key: 'end',
    className: 'tw-zoom-h',
    style: { left: `calc(${pct(e - 1)}% - 6px)` },
    onPointerDown: (ev: React.PointerEvent) => { ev.preventDefault(); drag.current = 'end' },
  })
  return React.createElement('div', { className: 'tw-zoom' },
    React.createElement('div', {
      className: 'tw-zoom-track',
      ref: trackRef,
      onPointerDown: (ev: React.PointerEvent) => { ev.preventDefault(); drag.current = 'mid' },
    },
      React.createElement('div', { className: 'tw-zoom-sel', style: { left: `${pct(s)}%`, width: `${Math.max(1, pct(e - 1) - pct(s))}%` } }),
      start,
      end,
    ),
    React.createElement('div', { className: 'tw-zoom-bar' },
      React.createElement('span', { className: 'tw-muted' }, `${bars[s]?.date ?? ''} ~ ${bars[e - 1]?.date ?? ''} · ${e - s}/${total} 根`),
      React.createElement('span', { style: { flex: 1 } }),
      ...[
        ['近1月', 30], ['近3月', 90], ['近6月', 182], ['近1年', 365], ['全部', null],
      ].map(([label, days]) =>
        React.createElement('button', { key: String(label), className: 'tw-btn', onClick: () => quick(days as number | null) }, label as string)),
    ),
  )
}
