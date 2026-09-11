/**
 * Tiny dependency-free SVG charts: area + line with an optional baseline
 * (prev close / settlement). Used by the hover popup (intraday or 5-day
 * fallback) and the stock-detail card.
 */
import React from 'react'

export interface SparkPoint {
  t: number
  value: number
  label?: string
}

function polylinePath(points: Array<[number, number]>): string {
  if (points.length === 0) return ''
  return points.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`).join(' ')
}

/** 图上的一笔买卖（B/S 标记） */
export interface SparkMarker {
  t: number
  value: number
  kind: 'buy' | 'sell'
  title?: string
}

export interface SparklineProps {
  points: SparkPoint[]
  markers?: SparkMarker[]
  /** baseline value (dashed line); pass null to hide */
  baseline?: number | null
  width: number
  height: number
  /** stroke/area color decision helper */
  up: boolean
  upColor: string
  downColor: string
  /** time labels every N-th point under the axis */
  timeLabels?: boolean
}

export function Sparkline(props: SparklineProps): React.ReactElement {
  const { points, width, height, up, upColor, downColor, timeLabels } = props
  const padX = 2
  const padTop = 6
  const padBottom = timeLabels === true ? 14 : 4
  const innerW = width - padX * 2
  const innerH = height - padTop - padBottom
  if (points.length < 2 || innerH <= 2) {
    return React.createElement('svg', { width, height }, null)
  }
  const values = points.map((p) => p.value)
  let min = Math.min(...values)
  let max = Math.max(...values)
  const baseline = props.baseline
  if (baseline !== null && baseline !== undefined && Number.isFinite(baseline)) {
    min = Math.min(min, baseline)
    max = Math.max(max, baseline)
  }
  const span = max - min
  const lo = span > 0 ? min - span * 0.06 : min - 1
  const hi = span > 0 ? max + span * 0.06 : max + 1
  const range = hi - lo
  // 压缩时间轴：午休/隔夜/周末等跳空按"中位步长"折叠，避免被拉成一条长直线。
  // 分时数据里常见 1 分钟步长 + 90 分钟午休跳空；日线回退里是 1 天步长 + 周末跳空。
  const deltas: number[] = []
  for (let i = 1; i < points.length; i += 1) {
    const d = points[i].t - points[i - 1].t
    if (d > 0) deltas.push(d)
  }
  deltas.sort((a, b) => a - b)
  const median = deltas.length > 0 ? deltas[Math.floor(deltas.length / 2)] : 60_000
  const eff: number[] = [0]
  for (let i = 1; i < points.length; i += 1) {
    const d = points[i].t - points[i - 1].t
    eff.push(eff[i - 1] + (d > 0 ? Math.min(d, median) : median))
  }
  const effSpan = eff[eff.length - 1] > 0 ? eff[eff.length - 1] : 1
  const xy = points.map((p, i): [number, number] => [
    padX + (eff[i] / effSpan) * innerW,
    padTop + ((hi - p.value) / range) * innerH,
  ])
  const color = up ? upColor : downColor
  const area = `${polylinePath(xy)} L${xy[xy.length - 1][0].toFixed(1)},${(padTop + innerH).toFixed(1)} L${xy[0][0].toFixed(1)},${(padTop + innerH).toFixed(1)} Z`
  const last = xy[xy.length - 1]
  const linePath = polylinePath(xy)
  const baselineY =
    baseline !== null && baseline !== undefined && Number.isFinite(baseline)
      ? padTop + ((hi - baseline) / range) * innerH
      : null
  return React.createElement(
    'svg',
    { width, height, viewBox: `0 0 ${width} ${height}`, style: { display: 'block' } },
    React.createElement('defs', null,
      React.createElement('linearGradient', { id: `twg-${up ? 'u' : 'd'}-${width}`, x1: '0', y1: '0', x2: '0', y2: '1' },
        React.createElement('stop', { offset: '0%', style: { stopColor: color, stopOpacity: 0.32 } }),
        React.createElement('stop', { offset: '100%', style: { stopColor: color, stopOpacity: 0.02 } }),
      ),
    ),
    React.createElement('path', { d: area, fill: `url(#twg-${up ? 'u' : 'd'}-${width})`, style: { stroke: 'none' } }),
    React.createElement('path', { d: linePath, fill: 'none', style: { stroke: color }, strokeWidth: 1.5, strokeLinejoin: 'round', strokeLinecap: 'round' }),
    baselineY !== null
      ? React.createElement('line', {
          x1: padX,
          y1: baselineY,
          x2: width - padX,
          y2: baselineY,
          style: { stroke: 'var(--tw-muted)' },
          strokeWidth: 1,
          strokeDasharray: '3 3',
          opacity: 0.7,
        })
      : null,
    React.createElement('circle', { cx: last[0], cy: last[1], r: 2.6, style: { fill: color, stroke: 'var(--tw-card)' }, strokeWidth: 1 }),
    // B/S 标记：按压缩后的时间轴定位（与价格线同一坐标系）
    ...(props.markers ?? []).map((m, i) => {
      const idx = ((): number => {
        const n = points.length
        if (n === 0) return 0
        if (m.t <= points[0].t) return 0
        if (m.t >= points[n - 1].t) return n - 1
        let lo = 0
        let hi = n - 1
        while (lo < hi) {
          const mid = (lo + hi + 1) >> 1
          if (points[mid].t <= m.t) lo = mid
          else hi = mid - 1
        }
        return lo
      })()
      const mx = padX + (eff[idx] / effSpan) * innerW
      const my = padTop + ((hi - m.value) / range) * innerH
      const isBuy = m.kind === 'buy'
      const mc = isBuy ? upColor : downColor
      const label = isBuy ? 'B' : 'S'
      const ty = isBuy ? Math.min(my + 16, padTop + innerH - 2) : Math.max(my - 7, padTop + 8)
      return React.createElement('g', { key: `m${i}` },
        React.createElement('line', { x1: mx, y1: my, x2: mx, y2: ty, style: { stroke: mc }, strokeWidth: 1, opacity: 0.7 }),
        React.createElement('circle', { cx: mx, cy: my, r: 3, style: { fill: mc, stroke: 'var(--tw-card)' }, strokeWidth: 1 },
          m.title !== undefined ? React.createElement('title', null, m.title) : null,
        ),
        React.createElement('text', {
          x: mx,
          y: isBuy ? ty + 9 : ty - 2,
          textAnchor: 'middle',
          style: { fill: mc, fontSize: 10, fontWeight: 700, paintOrder: 'stroke', stroke: 'var(--tw-card)', strokeWidth: 2.5 },
        }, label),
      )
    }),
    timeLabels === true && points.length >= 2
      ? React.createElement('g', { style: { fontSize: 9 } },
          ...[0, 1].map((k) => {
            const idx = k === 0 ? 0 : points.length - 1
            const label = points[idx].label ?? ''
            const x = k === 0 ? padX : Math.max(width - padX - label.length * 5.4, padX)
            return React.createElement(
              'text',
              { key: k, x, y: height - 2, style: { fill: 'var(--tw-muted)' }, textAnchor: k === 0 ? 'start' : 'end' },
              label,
            )
          }),
        )
      : null,
  )
}

/** Bar-colored price text row helper for detail cards. */
export function PriceText(props: {
  value: number | null
  className: string
  style?: React.CSSProperties
}): React.ReactElement {
  return React.createElement('span', { className: props.className, style: props.style }, String(props.value ?? '—'))
}

/** ─── row-level mini sparkline (tiny polyline only) ─────────────────────── */

export function MiniTrend(props: {
  values: number[]
  width?: number
  height?: number
  /** color the line by the day direction when provided */
  up?: boolean | null
  redUp?: boolean
}): React.ReactElement {
  const { values, width = 64, height = 24, up, redUp = true } = props
  if (values.length < 2) {
    return React.createElement('svg', { width, height }, null)
  }
  const min = Math.min(...values)
  const max = Math.max(...values)
  const span = max - min
  const lo = span > 0 ? min - span * 0.12 : min - 1
  const hi = span > 0 ? max + span * 0.12 : max + 1
  const pad = 1.5
  const innerW = width - pad * 2
  const innerH = height - pad * 2
  const step = innerW / (values.length - 1)
  const points = values.map((v, i) => `${(pad + step * i).toFixed(1)},${(pad + ((hi - v) / (hi - lo)) * innerH).toFixed(1)}`)
  const dir = up === null || up === undefined ? null : (up === redUp ? 'var(--tw-up)' : 'var(--tw-down)')
  return React.createElement(
    'svg',
    { width, height, viewBox: `0 0 ${width} ${height}`, style: { display: 'block' } },
    React.createElement('path', {
      d: `M${points.join(' L')}`,
      fill: 'none',
      style: { stroke: dir ?? 'var(--tw-dim)' },
      strokeWidth: 1.3,
      strokeLinejoin: 'round',
      strokeLinecap: 'round',
      opacity: dir === null ? 0.85 : 1,
    }),
  )
}

/** ─── five-day intraday overlay (one polyline per session) ──────────────── */

export function MultiDayTrend(props: {
  days: Array<{ label: string; values: number[] }>
  width: number
  height: number
  redUp: boolean
}): React.ReactElement {
  const { width, height, redUp } = props
  const all = props.days.flatMap((d) => d.values)
  if (all.length < 4) {
    return React.createElement('div', { className: 'tw-muted', style: { textAlign: 'center', padding: 60 } }, '暂无五日分时数据')
  }
  const min = Math.min(...all)
  const max = Math.max(...all)
  const span = max - min
  const lo = span > 0 ? min - span * 0.06 : min - 1
  const hi = span > 0 ? max + span * 0.06 : max + 1
  const padX = 8
  const padTop = 8
  const padBottom = 18
  const innerW = width - padX * 2
  const innerH = height - padTop - padBottom
  const y = (v: number): number => padTop + ((hi - v) / (hi - lo)) * innerH
  const children: React.ReactNode[] = []
  props.days.forEach((day, di) => {
    const step = innerW / day.values.length
    const path = day.values.map((v, i) => `${(padX + step * i).toFixed(1)},${y(v).toFixed(1)}`).join(' ')
    const isLast = di === props.days.length - 1
    const dirUp = day.values[day.values.length - 1] >= day.values[0]
    const stroke = isLast
      ? (dirUp === redUp ? 'var(--tw-up)' : 'var(--tw-down)')
      : 'var(--tw-muted)'
    children.push(React.createElement('path', {
      key: day.label,
      d: `M${path}`,
      fill: 'none',
      style: { stroke },
      strokeWidth: isLast ? 1.6 : 1,
      strokeLinejoin: 'round',
      strokeLinecap: 'round',
      opacity: isLast ? 1 : 0.55,
    }))
    children.push(React.createElement('text', {
      key: `t${day.label}`,
      x: di === 0 ? padX : width - padX,
      y: height - 4,
      style: { fill: isLast ? 'var(--tw-text)' : 'var(--tw-muted)', fontSize: 9.5 },
      textAnchor: di === 0 ? 'start' : 'end',
    }, day.label.slice(5)))
  })
  return React.createElement(
    'svg',
    { width, height, viewBox: `0 0 ${width} ${height}`, style: { display: 'block' } },
    children,
  )
}

/** ─── candlestick chart for 日K/周K/月K/年K ─────────────────────────────── */

export interface CandleBar {
  date: string
  open: number
  close: number
  high: number
  low: number
}

export interface CandleMarker {
  date: string
  kind: 'buy' | 'sell'
  qty?: number
  price?: number
}

export function CandleChart(props: {
  bars: CandleBar[]
  width: number
  height: number
  redUp: boolean
  markers?: CandleMarker[]
}): React.ReactElement {
  const { width, height, redUp } = props
  const bars = props.bars
  if (bars.length < 1) {
    return React.createElement('div', { className: 'tw-muted', style: { textAlign: 'center', padding: 60 } }, '暂无K线数据')
  }
  const values = bars.flatMap((b) => [b.high, b.low, b.open, b.close])
  const min = Math.min(...values)
  const max = Math.max(...values)
  const span = max - min
  const lo = span > 0 ? min - span * 0.04 : min - 1
  const hi = span > 0 ? max + span * 0.04 : max + 1
  const padX = 8
  const padTop = 8
  const padBottom = 18
  const innerW = width - padX * 2
  const innerH = height - padTop - padBottom
  const step = innerW / bars.length
  const bodyW = Math.max(1.5, Math.min(9, step * 0.62))
  const y = (v: number): number => padTop + ((hi - v) / (hi - lo)) * innerH
  const children: React.ReactNode[] = []
  bars.forEach((b, i) => {
    const x = padX + step * i + step / 2
    const up = b.close >= b.open
    const color = up === redUp ? 'var(--tw-up)' : 'var(--tw-down)'
    const yHigh = y(b.high)
    const yLow = y(b.low)
    const yO = y(b.open)
    const yC = y(b.close)
    const top = Math.min(yO, yC)
    const h = Math.max(1, Math.abs(yC - yO))
    children.push(React.createElement('line', { key: `w${i}`, x1: x, y1: yHigh, x2: x, y2: yLow, style: { stroke: color }, strokeWidth: 1 }))
    children.push(React.createElement('rect', {
      key: `b${i}`,
      x: x - bodyW / 2,
      y: top,
      width: bodyW,
      height: h,
      style: { fill: color },
      rx: 0.6,
    }))
  })
  // B/S 标记：按日期归入所属 K 线（周/月/年 K 自动落到该周期的那根）
  const barIndex = (date: string): number => {
    if (date <= bars[0].date) return 0
    if (date >= bars[bars.length - 1].date) return bars.length - 1
    let lo = 0
    let hi = bars.length - 1
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if (bars[mid].date <= date) lo = mid
      else hi = mid - 1
    }
    return lo
  }
  const grouped = new Map<number, { buy: number; sell: number }>()
  for (const m of props.markers ?? []) {
    const i = barIndex(m.date)
    const g = grouped.get(i) ?? { buy: 0, sell: 0 }
    if (m.kind === 'buy') g.buy += 1
    else g.sell += 1
    grouped.set(i, g)
  }
  for (const [i, g] of grouped) {
    const b = bars[i]
    const x = padX + step * i + step / 2
    const label = (n: number, kind: string): string => (n > 1 ? `${kind}${n}` : kind)
    if (g.buy > 0) {
      const my = Math.min(y(b.low) + 13, padTop + innerH - 1)
      children.push(React.createElement('g', { key: `mb${i}` },
        React.createElement('line', { x1: x, y1: y(b.low), x2: x, y2: my - 4, style: { stroke: redUp ? 'var(--tw-up)' : 'var(--tw-down)' }, strokeWidth: 1, opacity: 0.7 }),
        React.createElement('text', {
          x, y: my, textAnchor: 'middle',
          style: { fill: redUp ? 'var(--tw-up)' : 'var(--tw-down)', fontSize: 9.5, fontWeight: 700, paintOrder: 'stroke', stroke: 'var(--tw-card)', strokeWidth: 2.5 },
        }, label(g.buy, 'B')),
      ))
    }
    if (g.sell > 0) {
      const my = Math.max(y(b.high) - 8, padTop + 8)
      children.push(React.createElement('g', { key: `ms${i}` },
        React.createElement('line', { x1: x, y1: y(b.high), x2: x, y2: my + 4, style: { stroke: redUp ? 'var(--tw-down)' : 'var(--tw-up)' }, strokeWidth: 1, opacity: 0.7 }),
        React.createElement('text', {
          x, y: my, textAnchor: 'middle',
          style: { fill: redUp ? 'var(--tw-down)' : 'var(--tw-up)', fontSize: 9.5, fontWeight: 700, paintOrder: 'stroke', stroke: 'var(--tw-card)', strokeWidth: 2.5 },
        }, label(g.sell, 'S')),
      ))
    }
  }

  const first = bars[0]
  const last = bars[bars.length - 1]
  const hiText = `高 ${hi >= 1e4 ? hi.toFixed(0) : hi.toFixed(2)}`
  const loText = `低 ${lo >= 1e4 ? lo.toFixed(0) : lo.toFixed(2)}`
  children.push(React.createElement('text', { key: 'hf', x: padX, y: padTop + 7, style: { fill: 'var(--tw-muted)', fontSize: 9 } }, hiText))
  children.push(React.createElement('text', { key: 'lf', x: width - padX, y: padTop + 7, style: { fill: 'var(--tw-muted)', fontSize: 9, textAnchor: 'end' } }, loText))
  children.push(React.createElement('text', { key: 'd0', x: padX, y: height - 4, style: { fill: 'var(--tw-muted)', fontSize: 9 } }, first.date))
  children.push(React.createElement('text', { key: 'd1', x: width - padX, y: height - 4, style: { fill: 'var(--tw-muted)', fontSize: 9, textAnchor: 'end' } }, last.date))
  return React.createElement(
    'svg',
    { width, height, viewBox: `0 0 ${width} ${height}`, style: { display: 'block' } },
    children,
  )
}
