/**
 * 抽屉用多窗格图表：
 *   TrendChart  — 分时 / 五日：主图（价格+均价线+昨收基准）+ 成交量 + MACD
 *   KlineChart  — 日/周/月/年K：蜡烛+MA5/10/30/60 + 成交量 + MACD + 日期宽度缩放窗
 * 两种图共用：纵轴刻度线、成交量柱、MACD（DIF/DEA/HIST）。
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { CandleMarker, SparkMarker } from './charts.tsx'
import { fmtAxis, ma, macd, niceTicks } from './indicators.ts'
import { hasVolumeSeries, isUsableAvg, isUsableBaseline, plausibleAvgs, trendDayAxis, trendScale } from './trendView.ts'
import { sessionAxis, type SessionDef } from './sessionAxis.ts'
import { klineReadout, nearestIndex, tipPlacement, toneClass, trendReadout, upDownColors, type TipLine } from './chartCursor.ts'
import { trendDayCount } from '../shared/model.ts'

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
  /** 成交额（卡片要显示；缺失 ⇒ 卡片写 —） */
  amount?: number | null
}

/** 卡片宽度（CSS 里也是这个值；摆放计算要提前知道尺寸，故写常量并断言） */
const TIP_W = 152
/** 卡片高度估算：标题行 + 每行 16px + 内边距（与 CSS 的 line-height 对齐） */
function tipHeightOf(lines: readonly TipLine[]): number {
  return 14 + lines.length * 16
}

/** 半透明细节卡（DOM 覆盖层，`position:absolute` 由调用方容器承载） */
function TipCard(lines: readonly TipLine[], pos: { left: number; top: number }, redUp: boolean): React.ReactElement {
  return React.createElement('div', {
    className: 'tw-chart-tip',
    style: { left: pos.left, top: pos.top, width: TIP_W },
    role: 'status',
    'aria-live': 'off',
  },
    ...lines.map((l, i) => React.createElement('div', {
      key: `t${i}`, className: 'tw-chart-tip-row',
      // M5：没有 role 的 aria-label 读屏**不读** —— 必须显式 role
      role: 'note',
      // 口径的长解释不占正文：进 title + aria-label（读屏也读得到）
      title: l.hint,
      'aria-label': l.hint === undefined ? undefined : `${l.label} ${l.value} —— ${l.hint}`,
    },
      React.createElement('span', { className: 'tw-chart-tip-k' }, l.label),
      React.createElement('span', {
        // 涨跌着色**必须**跟随 redUp（写死映射会在"绿涨红跌"档位与全站相反）
        className: `tw-chart-tip-v ${toneClass(l.tone, redUp)}`,
      }, l.value),
    )),
  )
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
  /** 昨收：给了就在右列画 **±%**（与左侧价格刻度同源、以昨收为 0.00%，券商 App 口径） */
  baseline?: number | null
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
    if (args.baseline !== null && args.baseline !== undefined && args.baseline !== 0) {
      const pct = ((v - args.baseline) / args.baseline) * 100
      out.push(React.createElement('text', {
        key: `gp${v}`,
        x: padX + innerW + 3, y: y - 2, textAnchor: 'start',
        className: 'tw-chart-pct',
        style: { fill: pct >= 0 ? 'var(--tw-up)' : 'var(--tw-down)', fontSize: 9 },
      }, `${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%`))
    }
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
  // 有无成交量是**整条序列**的属性：全无 ⇒ 该源不提供，明说而不是拿 `max` 兜底成 1 印个假数
  const hasVol = hasVolumeSeries(vols)
  const max = hasVol ? Math.max(...vols.map((v) => (v ?? 0))) : 1
  const baseY = top + height
  const out: React.ReactNode[] = [
    React.createElement('line', { key: 'vb', x1: padX, y1: baseY, x2: padX + innerW, y2: baseY, style: { stroke: 'var(--tw-border)' }, strokeWidth: 1 }),
    React.createElement('text', { key: 'vt', x: padX, y: top + 9, style: { fill: 'var(--tw-muted)', fontSize: 9 } },
      hasVol ? `成交量 ${fmtAxis(max)}` : '该市场不提供成交量'),
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
  /**
   * 该标的的交易时段表（`sessionOf(secid)`；无时段表的市场给 `null`）。
   * 有表 ⇒ 横轴固定为完整时段（午休零宽度、部分数据右侧留白）；无表 ⇒ 回落压缩轴。
   */
  session?: SessionDef | null
  mainH?: number
  volH?: number
  macdH?: number
}): React.ReactElement {
  const { points, width, redUp } = props
  const mainH = props.mainH ?? 200
  const volH = props.volH ?? 54
  const macdH = props.macdH ?? 64
  const height = PAD_TOP + mainH + GAP + volH + GAP + macdH + AXIS_H
  /** 分时（有昨收基准 + 有时段表）时右侧多留一列 ±% 刻度；其它档保持原边距 */
  const pctScale = isUsableBaseline(props.baseline) && (props.session ?? null) !== null
  const innerW = width - PAD_X - (pctScale ? 44 : PAD_X)
  /** 光标所在数据点（null = 不显示）。鼠标移动只改这一个 state，不重建图的数据。 */
  const [cursor, setCursor] = useState<number | null>(null)
  /** 涨跌色唯一来源（S5） */
  const { up: UP_COLOR, down: DOWN_COLOR } = upDownColors(redUp)
  const multiDay = props.points.length > 1 && trendDayCount(props.points) > 1

  const view = useMemo(() => {
    if (points.length < 2) return null
    // 有交易时段表 ⇒ 横轴**固定为完整时段**（券商 App 口径）：`x = 时段内已过分钟 / 时段总分钟`，
    // 午休零宽度、部分数据右侧留白；没有时段表的市场回落压缩轴（美股/商品/期货时段会漂移，不硬编码）。
    const ax = sessionAxis(points.map((p) => ({ label: p.label })), props.session ?? null)
    if (ax !== null) {
      const xAt0 = (i: number): number => PAD_X + ax.xs[i] * innerW
      const values0 = points.map((p) => p.value)
      // 均价先过"必须落在当日价格区间内"的判据：非价格量（指数分时那个字段）会把域拉坏
      const avgs0 = plausibleAvgs(values0, points.map((p) => p.avg))
      const { lo: lo0, hi: hi0 } = trendScale(values0, avgs0, props.baseline)
      const yOf0 = (v: number): number => PAD_TOP + ((hi0 - v) / (hi0 - lo0)) * mainH
      const m0 = macd(values0)
      const up0 = values0.map((v, i) => (i === 0 ? true : v >= values0[i - 1]))
      const barW0 = Math.max(1, Math.min(6, (innerW / points.length) * 0.7))
      return { xAt: xAt0, yOf: yOf0, lo: lo0, hi: hi0, values: values0, avgs: avgs0, m: m0, up: up0, barW: barW0, ax, xs: ax.xs }
    }
    const { eff, span } = compressedAxis(points.map((p) => p.t))
    const xAt = (i: number): number => PAD_X + (eff[i] / span) * innerW
    const values = points.map((p) => p.value)
    // 域与均线折线**共用**同一份过滤结果（只修域会让线画到图外/贴底）
    const avgs = plausibleAvgs(values, points.map((p) => p.avg))
    // 域只由有效价格 + 可信均价（+昨收基准）决定：均价都不可信时域就等于价格域
    // （`avg: 0` 与"越界的非价格量"都会把域拉成 0~4303 / 15~3824 那种"平线"）
    const { lo, hi } = trendScale(values, avgs, props.baseline)
    const yOf = (v: number): number => PAD_TOP + ((hi - v) / (hi - lo)) * mainH
    const m = macd(values)
    const up = values.map((v, i) => (i === 0 ? true : v >= values[i - 1]))
    const barW = Math.max(1, Math.min(6, (innerW / points.length) * 0.7))
    return { xAt, yOf, lo, hi, values, avgs, m, up, barW, ax: null, xs: eff.map((v) => v / span) }
  }, [points, innerW, mainH, props.baseline, props.session])

  if (view === null) {
    return React.createElement('div', { className: 'tw-muted', style: { textAlign: 'center', padding: 40 } }, '暂无分时数据')
  }

  const { xAt, yOf, lo, hi, values, avgs, m, up, barW, ax } = view
  const volTop = PAD_TOP + mainH + GAP
  const macdTop = volTop + volH + GAP
  const linePath = values.map((v, i) => `${i === 0 ? 'M' : 'L'}${xAt(i).toFixed(1)},${yOf(v).toFixed(1)}`).join(' ')
  const avgPath = ((): string => {
    let d = ''
    let open = false
    avgs.forEach((v, i) => {
      // `null` 与 `≤0` 都不是有效 VWAP（老宿主可能回 0）：断线，不能画到 0 去
      if (!isUsableAvg(v)) { open = false; return }
      d += `${open ? 'L' : 'M'}${xAt(i).toFixed(1)},${yOf(v).toFixed(1)} `
      open = true
    })
    return d
  })()
  const lastIndex = points.length - 1
  const lastUp = isUsableBaseline(props.baseline)
    ? values[lastIndex] >= props.baseline
    : values[lastIndex] >= values[0]
  const mainColor = lastUp === redUp ? UP_COLOR : DOWN_COLOR
  const area = `${linePath} L${xAt(lastIndex).toFixed(1)},${PAD_TOP + mainH} L${xAt(0).toFixed(1)},${PAD_TOP + mainH} Z`

  const children: React.ReactNode[] = []
  children.push(React.createElement('defs', { key: 'defs' },
    React.createElement('linearGradient', { id: 'tw-trend-fill', x1: '0', y1: '0', x2: '0', y2: '1' },
      React.createElement('stop', { offset: '0%', style: { stopColor: mainColor, stopOpacity: 0.28 } }),
      React.createElement('stop', { offset: '100%', style: { stopColor: mainColor, stopOpacity: 0.02 } }),
    ),
  ))
  children.push(...yGrid({ top: PAD_TOP, height: mainH, lo, hi, padX: PAD_X, innerW, baseline: pctScale ? (props.baseline ?? null) : null }))
  children.push(React.createElement('path', { key: 'area', d: area, fill: 'url(#tw-trend-fill)', style: { stroke: 'none' } }))
  if (isUsableBaseline(props.baseline)) {
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
    const color = isBuy ? (UP_COLOR) : (DOWN_COLOR)
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

  children.push(...volumePane({ top: volTop, height: volH, vols: points.map((p) => p.vol), up, xAt, barW, padX: PAD_X, innerW }))
  children.push(...macdPane({
    top: macdTop, height: macdH, dif: m.dif, dea: m.dea, hist: m.hist, xAt, barW, padX: PAD_X, innerW,
    upColor: UP_COLOR, downColor: DOWN_COLOR,
  }))
  /**
   * 多日（五日）的**按天**底部轴：每天一个标签、居各自区段中间，日分隔线从主图延伸到底部轴。
   *
   * 此前只在**内部**日边界画虚线 + 图内左上角 9px 小字，且 `brk <= 0` 被跳过 ⇒ 第一天没有标签、
   * 底部只有首末两个时间戳，用户读不出"哪一段是哪一天"（实测 1.510300 覆盖 5 天却看不出来）。
   * 标签文本一律来自点里的 `label`（`trendDayAxis` 保证），天数多时均匀抽样、首末必留。
   * 单日分时保持原样：仍是最左/最右两个时间戳。
   */
  const axisLabelY = height - 4
  // ── 交易时段网格（有表时）：竖格线按"每时段中点"等分，午休一条线；单日档同时承担底部刻度 ──
  if (ax !== null) {
    const lines = ax.daySlots === 1
      ? ax.gridLines
      : ax.gridLines.filter((g) => g.noon).map((g, i) => ({ at: (i + g.at) / ax.daySlots, label: '', noon: true }))
    for (const g of lines) {
      const x = PAD_X + g.at * innerW
      children.push(React.createElement('line', {
        key: `sg${g.at.toFixed(4)}${g.label}`, x1: x, y1: PAD_TOP, x2: x, y2: axisLabelY - 10,
        style: { stroke: g.noon ? 'var(--tw-border-strong)' : 'var(--tw-border)' },
        strokeWidth: 1, strokeDasharray: g.noon ? '2 2' : '1 3', opacity: g.noon ? 0.85 : 0.7,
      }))
      if (g.label !== '') {
        children.push(React.createElement('text', {
          key: `sl${g.at.toFixed(4)}${g.label}`, x, y: axisLabelY, textAnchor: 'middle',
          style: { fill: 'var(--tw-muted)', fontSize: 9 },
        }, g.label))
      }
    }
    if (ax.daySlots === 1) {
      // 首末标开盘/收盘时刻（与内部分隔线同一套刻度：整段固定宽度，未到的时段留白）
      const open = props.session?.spans[0]?.start ?? ''
      const spans = props.session?.spans ?? []
      const close = spans.length > 0 ? spans[spans.length - 1].end : ''
      if (open !== '') children.push(React.createElement('text', {
        key: 'sopen', x: PAD_X, y: axisLabelY, style: { fill: 'var(--tw-muted)', fontSize: 9 },
      }, open))
      if (close !== '') children.push(React.createElement('text', {
        key: 'sclose', x: PAD_X + innerW, y: axisLabelY, textAnchor: 'end', style: { fill: 'var(--tw-muted)', fontSize: 9 },
      }, close))
    }
  }
  const dayMaxLabels = Math.max(2, Math.min(8, Math.floor(innerW / 56)))
  const { segments: daySegments, labels: dayLabels } = trendDayAxis(points.map((p) => ({ label: p.label })), dayMaxLabels)
  for (const seg of daySegments) {
    if (seg.startIndex <= 0 || seg.startIndex >= points.length) continue
    const x = xAt(seg.startIndex)
    children.push(React.createElement('line', {
      key: `brk${seg.startIndex}`, x1: x, y1: PAD_TOP, x2: x, y2: axisLabelY - 10,
      style: { stroke: 'var(--tw-border-strong)' }, strokeWidth: 1, strokeDasharray: '2 2', opacity: 0.8,
    }))
  }
  if (dayLabels.length > 0) {
    for (const seg of dayLabels) {
      // 居中：取该天首末两点横坐标的中点（时间轴被压缩过，用索引中点会偏）
      const x = (xAt(seg.startIndex) + xAt(seg.endIndex)) / 2
      children.push(React.createElement('text', {
        key: `day${seg.startIndex}`, x, y: axisLabelY, textAnchor: 'middle',
        style: { fill: 'var(--tw-muted)', fontSize: 9 },
      }, seg.text))
    }
  } else if (ax === null) {
    children.push(React.createElement('text', {
      key: 'x0', x: PAD_X, y: axisLabelY, style: { fill: 'var(--tw-muted)', fontSize: 9 },
    }, points[0].label.slice(5)))
    children.push(React.createElement('text', {
      key: 'x1', x: PAD_X + innerW, y: axisLabelY, textAnchor: 'end', style: { fill: 'var(--tw-muted)', fontSize: 9 },
    }, points[lastIndex].label.slice(5, 16)))
  }

  // 十字光标：竖虚线 + 当前点小圆点（画在最后 ⇒ 压在最上层）
  const cx = cursor !== null && cursor >= 0 && cursor < points.length ? xAt(cursor) : null
  const cy = cursor !== null && cursor >= 0 && cursor < points.length ? yOf(values[cursor]) : null
  if (cx !== null && cy !== null) {
    children.push(React.createElement('line', {
      key: 'cursor', x1: cx, y1: PAD_TOP, x2: cx, y2: height - AXIS_H,
      style: { stroke: 'var(--tw-muted)' }, strokeWidth: 1, strokeDasharray: '2 2', opacity: 0.9,
    }))
    children.push(React.createElement('circle', {
      key: 'cursorDot', cx, cy, r: 2.6, style: { fill: mainColor, stroke: 'var(--tw-card)' }, strokeWidth: 1,
    }))
  }

  const svg = React.createElement('svg', {
    width, height, viewBox: `0 0 ${width} ${height}`,
    style: { display: 'block' },
    tabIndex: 0,
    role: 'img',
    'aria-label': cursor === null ? '分时图' : '分时图（已选中某一点，详见卡片）',
    onMouseMove: (ev: React.MouseEvent<SVGSVGElement>) => {
      const rect = ev.currentTarget.getBoundingClientRect()
      setCursor(nearestIndex(ev.clientX - rect.left, view.xs, PAD_X, innerW))
    },
    onMouseLeave: () => setCursor(null),
    onKeyDown: (ev: React.KeyboardEvent) => {
      if (ev.key === 'Escape') { setCursor(null); return }
      const start = cursor !== null ? cursor : lastIndex
      if (ev.key === 'ArrowLeft' || ev.key === 'ArrowRight') {
        ev.preventDefault()
        const next = Math.max(0, Math.min(points.length - 1, start + (ev.key === 'ArrowLeft' ? -1 : 1)))
        setCursor(next)
      } else if (ev.key === 'Enter' || ev.key === ' ') {
        ev.preventDefault()
        setCursor(start)
      }
    },
  }, children)

  const tipLeft = cx ?? 0
  const tipTop = cy ?? 0
  const lines = cursor === null ? [] : trendReadout({
    points: points.map((p) => ({ label: p.label, price: p.value, avg: p.avg, vol: p.vol, amount: p.amount })),
    i: cursor,
    baseline: props.baseline,
    multiDay,
    macd: m,
    // 有没有时段表决定标签是"距开盘"还是"距首点"（无表的市场首点不是开盘）
    session: props.session ?? null,
  })
  const pos = cursor === null || cx === null ? null : tipPlacement(tipLeft, tipTop, width, height, TIP_W, tipHeightOf(lines))
  return React.createElement('div', { className: 'tw-cursorwrap' }, svg, pos === null ? null : TipCard(lines, pos, redUp))
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
  /** 光标数据点（null = 不显示卡片）；鼠标移动只改它，不重建图 */
  const [cursor, setCursor] = useState<number | null>(null)
  /** 涨跌色唯一来源（S5） */
  const { up: UP_COLOR, down: DOWN_COLOR } = upDownColors(redUp)
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
    const color = up === redUp ? UP_COLOR : DOWN_COLOR
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
  /**
   * 买卖点去噪 + 明细（P1-2）。
   *
   * 同一根 bar 上的多笔必须**合并成一个标记**（`B×3`），否则密集交易的日子里
   * 满屏 B/S、"点位看着多、其实只有两笔"。合并后仍要能追到明细，因此这里保留
   * 每笔的数量/价格，供悬停时给出"共 N 笔 · 合计 X 股 · 均价 Y"。
   */
  type TradeDetail = { qty: number | null; price: number | null }
  const grouped = new Map<number, { buys: TradeDetail[]; sells: TradeDetail[] }>()
  for (const mk of props.markers ?? []) {
    const i = idxOfDate(mk.date)
    const g = grouped.get(i) ?? { buys: [], sells: [] }
    const detail: TradeDetail = { qty: mk.qty ?? null, price: mk.price ?? null }
    if (mk.kind === 'buy') g.buys.push(detail)
    else g.sells.push(detail)
    grouped.set(i, g)
  }
  /** 一笔/一日的小结文本：笔数 + 合计数量 + 成交均价（缺字段时不编数） */
  const detailText = (label: string, list: readonly TradeDetail[], date: string): string => {
    const qty = list.reduce((a, t) => a + (t.qty ?? 0), 0)
    const amount = list.reduce((a, t) => a + (t.qty ?? 0) * (t.price ?? 0), 0)
    const vwap = qty > 0 ? amount / qty : null
    const parts = [`${date} ${label} ${list.length} 笔`]
    // E14：同一标的在持仓页按「份」、这里按「股」会让人对不上券商流水 ⇒ 标签写明两种
    if (qty > 0) parts.push(`合计 ${Math.round(qty * 1e4) / 1e4} 份/股`)
    if (vwap !== null) parts.push(`均价 ${vwap.toFixed(3)}`)
    return parts.join(' · ')
  }
  for (const [i, g] of grouped) {
    const b = bars[i]
    const x = xAt(i)
    if (g.buys.length > 0) {
      const my = Math.min(yOf(b.low) + 13, PAD_TOP + mainH - 1)
      children.push(React.createElement('g', { key: `mb${i}` },
        React.createElement('title', null, detailText('买入', g.buys, b.date)),
        React.createElement('line', { x1: x, y1: yOf(b.low), x2: x, y2: my - 4, style: { stroke: UP_COLOR }, strokeWidth: 1, opacity: 0.7 }),
        React.createElement('text', { x, y: my, textAnchor: 'middle', style: { fill: UP_COLOR, fontSize: 9.5, fontWeight: 700, paintOrder: 'stroke', stroke: 'var(--tw-card)', strokeWidth: 2.5 } }, g.buys.length > 1 ? `B${g.buys.length}` : 'B'),
      ))
    }
    if (g.sells.length > 0) {
      const my = Math.max(yOf(b.high) - 8, PAD_TOP + 8)
      children.push(React.createElement('g', { key: `ms${i}` },
        React.createElement('title', null, detailText('卖出', g.sells, b.date)),
        React.createElement('line', { x1: x, y1: yOf(b.high), x2: x, y2: my + 4, style: { stroke: DOWN_COLOR }, strokeWidth: 1, opacity: 0.7 }),
        React.createElement('text', { x, y: my, textAnchor: 'middle', style: { fill: DOWN_COLOR, fontSize: 9.5, fontWeight: 700, paintOrder: 'stroke', stroke: 'var(--tw-card)', strokeWidth: 2.5 } }, g.sells.length > 1 ? `S${g.sells.length}` : 'S'),
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
    upColor: UP_COLOR, downColor: DOWN_COLOR,
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
  // 十字光标：竖虚线 + 收盘处小圆点（画在最后 ⇒ 压在最上层）
  const cursorInWindow = cursor !== null && cursor >= s && cursor < e
  if (cursorInWindow) {
    const cxi = xAt(cursor)
    children.push(React.createElement('line', {
      key: 'cursor', x1: cxi, y1: PAD_TOP, x2: cxi, y2: height - AXIS_H,
      style: { stroke: 'var(--tw-muted)' }, strokeWidth: 1, strokeDasharray: '2 2', opacity: 0.9,
    }))
    children.push(React.createElement('circle', {
      key: 'cursorDot', cx: cxi, cy: yOf(bars[cursor].close), r: 2.8,
      style: { fill: 'var(--tw-card)', stroke: 'var(--tw-muted)' }, strokeWidth: 1.2,
    }))
  }
  /** 可见窗口内每根柱的归一化中心（nearestIndex 用；与时段网格/压缩轴同一口径） */
  const xsInWindow = Array.from({ length: count }, (_, k) => (k + 0.5) / count)
  const svg = React.createElement('svg', {
    width, height, viewBox: `0 0 ${width} ${height}`, style: { display: 'block' },
    onMouseMove: (ev: React.MouseEvent<SVGSVGElement>) => {
      const rect = ev.currentTarget.getBoundingClientRect()
      const k = nearestIndex(ev.clientX - rect.left, xsInWindow, PAD_X, innerW)
      if (k === null) return
      setCursor(Math.min(bars.length - 1, s + k))
    },
    onMouseLeave: () => setCursor(null),
  }, children)
  const tipLines = cursor === null ? [] : klineReadout({ bars, i: cursor, mas, macd: m })
  const tipPos = cursorInWindow
    ? tipPlacement(xAt(cursor), yOf(bars[cursor].close), width, height, TIP_W, tipHeightOf(tipLines))
    : null

  const legend = React.createElement('div', { className: 'tw-ma-legend', style: { display: 'flex', gap: 10, flexWrap: 'wrap', fontSize: 10, fontFamily: 'var(--tw-mono)', margin: '4px 0 0' } },
    ...mas.map((ser) => {
      let lastV: number | null = null
      for (let i = e - 1; i >= s; i -= 1) { if (ser.values[i] !== null) { lastV = ser.values[i] as number; break } }
      return React.createElement('span', { key: `lg${ser.period}`, style: { color: ser.color } },
        `MA${ser.period} ${lastV === null ? '—' : fmtAxis(lastV)}`)
    }),
  )

  /**
   * 区间买卖图例（P1-2）。
   *
   * 缩放后区间里可能一笔交易都没有（而图上一条 B/S 也看不到），但**区间外**可能有好几笔 ——
   * 不说出来，用户会把"看不到"读成"没有交易"。因此这里同时报出：
   *   区间内 B/S 笔数、净买入数量、成本变化方向，以及区间外还剩多少笔。
   */
  const inRange = [...grouped.entries()].filter(([i]) => i >= s && i < e)
  const outCount = [...grouped.entries()].filter(([i]) => i < s || i >= e).reduce((a, [, g]) => a + g.buys.length + g.sells.length, 0)
  const sum = (list: TradeDetail[]): { qty: number; amount: number } =>
    list.reduce((a, t) => ({ qty: a.qty + (t.qty ?? 0), amount: a.amount + (t.qty ?? 0) * (t.price ?? 0) }), { qty: 0, amount: 0 })
  let buyQty = 0
  let sellQty = 0
  let buyAmt = 0
  let sellAmt = 0
  let buyCount = 0
  let sellCount = 0
  for (const [, g] of inRange) {
    const b = sum(g.buys)
    const sl = sum(g.sells)
    buyQty += b.qty; buyAmt += b.amount; buyCount += g.buys.length
    sellQty += sl.qty; sellAmt += sl.amount; sellCount += g.sells.length
  }
  const netQty = Math.round((buyQty - sellQty) * 1e4) / 1e4
  const bsLegend = buyCount + sellCount > 0 || outCount > 0
    ? React.createElement('div', { className: 'tw-ma-legend', style: { display: 'flex', gap: 10, flexWrap: 'wrap', fontSize: 10, fontFamily: 'var(--tw-mono)', margin: '2px 0 0' } },
        buyCount + sellCount > 0
          ? React.createElement('span', { style: { color: UP_COLOR } },
              `区间内 B ${buyCount} 笔 / S ${sellCount} 笔`)
          : React.createElement('span', { className: 'tw-muted' }, '区间内无买卖点'),
        buyCount + sellCount > 0
          ? React.createElement('span', { className: netQty >= 0 ? (redUp ? 'tw-up' : 'tw-down') : (redUp ? 'tw-down' : 'tw-up') },
              `净${netQty >= 0 ? '买入' : '卖出'} ${Math.abs(netQty)} 份/股`)
          : null,
        buyCount + sellCount > 0 && buyQty > 0 && sellQty > 0
          ? React.createElement('span', { className: 'tw-muted' },
              `买入均价 ${(buyAmt / buyQty).toFixed(3)} / 卖出均价 ${(sellAmt / sellQty).toFixed(3)}`)
          : null,
        outCount > 0
          ? React.createElement('span', { className: 'tw-muted', title: '缩放区间外仍有买卖记录；缩小日期范围即可看到' },
              `（区间外另有 ${outCount} 笔）`)
          : null,
      )
    : null

  /**
   * 读屏摘要（P2-3）。SVG 本身对读屏软件是黑箱，因此把"这张图说了什么"写成文本：
   * 区间、首末收盘、区间涨跌幅、最高最低、买卖点笔数。**与图同源**（同一份 bars/markers/range），
   * 因此不会出现"摘要说涨、图上在跌"。
   *
   * 键盘：图表可聚焦，←/→ 平移（Shift 加速 10 根）、+/- 缩放、Home/End 到两端。
   */
  const visBars = bars.slice(s, e)
  const first = visBars[0]
  const last = visBars[visBars.length - 1]
  const visHi = visBars.length > 0 ? Math.max(...visBars.map((b) => b.high)) : null
  const visLo = visBars.length > 0 ? Math.min(...visBars.map((b) => b.low)) : null
  const chgPct = first !== undefined && last !== undefined && first.close > 0
    ? ((last.close - first.close) / first.close) * 100
    : null
  const summary =
    `${TAB_LABEL_FOR_SUMMARY(klt)}，共 ${bars.length} 根，当前显示 ${visBars.length} 根` +
    (first !== undefined && last !== undefined
      ? `（${first.date} 至 ${last.date}）：首收盘 ${fmtAxis(first.close)}，末收盘 ${fmtAxis(last.close)}` +
        (chgPct === null ? '' : `，区间${chgPct >= 0 ? '涨' : '跌'} ${Math.abs(chgPct).toFixed(2)}%`) +
        `，区间最高 ${visHi === null ? '—' : fmtAxis(visHi)}，最低 ${visLo === null ? '—' : fmtAxis(visLo)}`
      : '（区间内没有数据）') +
    (buyCount + sellCount > 0 ? `；区间内买入 ${buyCount} 笔、卖出 ${sellCount} 笔，净${netQty >= 0 ? '买入' : '卖出'} ${Math.abs(netQty)} 股` : '；区间内没有买卖点') +
    (outCount > 0 ? `；区间外另有 ${outCount} 笔买卖记录` : '')

  const chartKey = (ev: React.KeyboardEvent): void => {
    const step = ev.shiftKey ? 10 : 1
    const width = e - s
    // 卡片显示时：←/→ 移动**光标**（窗口随之滚动，保证光标始终可见）
    if (ev.key === 'Escape') {
      setCursor(null)
      return
    }
    if (ev.key === 'Enter' || ev.key === ' ') {
      ev.preventDefault()
      if (cursor === null) setCursor(e - 1)
      return
    }
    if ((ev.key === 'ArrowLeft' || ev.key === 'ArrowRight') && cursor !== null) {
      ev.preventDefault()
      const next = Math.max(0, Math.min(bars.length - 1, cursor + (ev.key === 'ArrowLeft' ? -step : step)))
      setCursor(next)
      if (next < s) setRange([Math.max(0, next), Math.max(0, next) + width])
      else if (next >= e) {
        const ns = Math.min(Math.max(0, bars.length - width), next - width + 1)
        setRange([ns, ns + width])
      }
      return
    }
    if (ev.key === 'ArrowLeft') {
      ev.preventDefault()
      const ns = Math.max(0, s - step)
      setRange([ns, ns + width])
    } else if (ev.key === 'ArrowRight') {
      ev.preventDefault()
      const ns = Math.min(bars.length - width, s + step)
      setRange([ns, ns + width])
    } else if (ev.key === '+' || ev.key === '=') {
      ev.preventDefault()
      const w2 = Math.max(8, width - step * 2)
      setRange([Math.min(s, bars.length - w2), Math.min(bars.length, Math.min(s, bars.length - w2) + w2)])
    } else if (ev.key === '-' || ev.key === '_') {
      ev.preventDefault()
      const w2 = Math.min(bars.length, width + step * 2)
      const ns = Math.max(0, Math.min(bars.length - w2, s - step))
      setRange([ns, ns + w2])
    } else if (ev.key === 'Home') {
      ev.preventDefault()
      setRange([0, width])
    } else if (ev.key === 'End') {
      ev.preventDefault()
      setRange([bars.length - width, bars.length])
    }
  }

  return React.createElement('div', { className: 'tw-kline' },
    React.createElement('div', {
      tabIndex: 0,
      role: 'img',
      'aria-label': summary,
      title: '键盘：←/→ 平移（未显示卡片时）／移动光标并显示细节卡（Shift 加速），Enter 显示，Esc 隐藏，+/- 缩放，Home/End 到两端',
      style: { outlineOffset: 2, position: 'relative' },
      onKeyDown: chartKey,
    },
      React.createElement(WheelZoom, { bars, range: [s, e], width, onChange: setRange }, svg),
      tipPos === null ? null : TipCard(tipLines, tipPos, redUp),
    ),
    // 读屏专用：完整摘要（含买卖点明细），视觉上不可见但可被朗读
    React.createElement('div', { className: 'tw-sr' }, summary),
    legend,
    bsLegend,
    React.createElement(RangeSlider, { total: bars.length, range: [s, e], bars, onChange: setRange }),
  )
}

/** 周期号 → 摘要里的中文（与图表 tab 文案保持一致的语义） */
function TAB_LABEL_FOR_SUMMARY(klt: 101 | 102 | 103 | 104): string {
  return klt === 101 ? '日K线' : klt === 102 ? '周K线' : klt === 103 ? '月K线' : '年K线'
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

  /**
   * 键盘操作（P2-3）：三处手柄都是 slider 语义，方向键微调、Shift+方向键粗调、Home/End 到底。
   * 拖拽能用不代表键盘能用 —— 只用指针的图表对键盘用户等于不可操作。
   */
  const nudge = (which: 'start' | 'end' | 'mid', delta: number): void => {
    if (which === 'start') props.onChange([Math.max(0, Math.min(s + delta, e - 8)), e])
    else if (which === 'end') props.onChange([s, Math.min(total, Math.max(e + delta, s + 8))])
    else {
      const width = e - s
      const ns = Math.max(0, Math.min(total - width, s + delta))
      props.onChange([ns, ns + width])
    }
  }
  const keyOf = (which: 'start' | 'end' | 'mid') => (ev: React.KeyboardEvent): void => {
    const step = ev.shiftKey ? 10 : 1
    if (ev.key === 'ArrowLeft') { ev.preventDefault(); nudge(which, -step) }
    else if (ev.key === 'ArrowRight') { ev.preventDefault(); nudge(which, step) }
    else if (ev.key === 'Home') { ev.preventDefault(); nudge(which, -total) }
    else if (ev.key === 'End') { ev.preventDefault(); nudge(which, total) }
  }
  const handleProps = (which: 'start' | 'end'): Record<string, unknown> => ({
    className: 'tw-zoom-h',
    role: 'slider',
    tabIndex: 0,
    'aria-label': which === 'start' ? '区间起点' : '区间终点',
    'aria-valuemin': 0,
    'aria-valuemax': total,
    'aria-valuenow': which === 'start' ? s : e,
    'aria-valuetext': `${bars[which === 'start' ? s : e - 1]?.date ?? ''}（第 ${which === 'start' ? s : e} 根，共 ${total} 根）`,
    onPointerDown: (ev: React.PointerEvent) => { ev.preventDefault(); drag.current = which },
    onKeyDown: keyOf(which),
  })
  const start = React.createElement('div', {
    key: 'start',
    ...handleProps('start'),
    style: { left: `calc(${pct(s)}% - 6px)` },
  })
  const end = React.createElement('div', {
    key: 'end',
    ...handleProps('end'),
    style: { left: `calc(${pct(e - 1)}% - 6px)` },
  })
  return React.createElement('div', { className: 'tw-zoom' },
    React.createElement('div', {
      className: 'tw-zoom-track',
      ref: trackRef,
      role: 'slider',
      tabIndex: 0,
      'aria-label': '可视区间（方向键平移，Shift 加速）',
      'aria-valuemin': 0,
      'aria-valuemax': total,
      'aria-valuenow': s,
      'aria-valuetext': `${bars[s]?.date ?? ''} ~ ${bars[e - 1]?.date ?? ''}，共 ${e - s} 根`,
      onKeyDown: keyOf('mid'),
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
