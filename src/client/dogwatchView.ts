/**
 * 汪汪队跟踪：视图纯函数（复盘条 / 四指标 / 9 列表格 / 两张图的数据）。
 * 口径：金额一律由后端给的「元」换算成亿；**缺数据落 `—` + 短原因（title）**，绝不写 0。
 */
export const DW_COLUMNS = [
  'ETF', '跟踪指数', '规模(亿)', '成交额(亿)', '较20日均', '主动净买入(亿)', '涨跌', '份额(亿份)', '份额变化',
] as const

export const DW_FOOTNOTE = '份额来源：上交所 ETF 规模日报（日频）· 仅沪市 14 只 · 折算已剔除 · 主动净买入为逐笔方向推算'

const MINUS = '−'

/** 数字 → 文本；null/NaN/Infinity 一律 `—`（不写 0） */
export function dwNum(v: number | null | undefined, digits: number, suffix = '', signed = false): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—'
  const abs = Math.abs(v).toFixed(digits)
  const sign = v < 0 ? MINUS : signed && v > 0 ? '+' : ''
  return `${sign}${abs}${suffix}`
}

export interface DwSummary {
  totalAmount: number | null
  ratio: number | null
  netBuy: number | null
  weightedPct: number | null
  baseDate: string | null
  totalSharesYi: number | null
}

/** 复盘条：日期行 + 一句结论 + 大号倍数 */
export function dwReview(day: string, summary: DwSummary): { day: string; verdict: string; big: string; bigSub: string } {
  const ratio = summary.ratio
  const verdict = ratio === null || !Number.isFinite(ratio) ? '量能数据未就绪'
    : ratio >= 1.8 ? '量能放大，疑似上班' : '没看出上班迹象'
  return { day: `最近交易日复盘 · ${day}`, verdict, big: dwNum(ratio, 2, '×'), bigSub: '较 20 日均额' }
}

export interface DwKpi { label: string; value: string; unit: string; sub: string }

/** 四指标（每条都带副行） */
export function dwKpis(summary: DwSummary): DwKpi[] {
  const avg20 = summary.totalAmount !== null && summary.ratio !== null && summary.ratio > 0
    ? summary.totalAmount / summary.ratio : null
  return [
    { label: '汪汪队合计成交额', value: `${dwNum(summary.totalAmount === null ? null : summary.totalAmount / 1e8, 1)}亿`, unit: '', sub: `20 日均额 ${dwNum(avg20 === null ? null : avg20 / 1e8, 1)} 亿` },
    { label: '成交额放大倍数', value: `${dwNum(summary.ratio, 2)}×`, unit: '', sub: '阈值 1.8× 为强信号' },
    { label: '合计主动净买入', value: `${dwNum(summary.netBuy === null ? null : summary.netBuy / 1e8, 2)}亿`, unit: '', sub: '主动买卖口径推算' },
    { label: '池内加权涨跌', value: `${dwNum(summary.weightedPct, 2)}%`, unit: '', sub: '规模加权' },
  ]
}

export interface DwRow { secid: string; name: string; indexName: string; scale: number | null; amount: number | null; ratio20: number | null; netBuy: number | null; pct: number | null; sharesYi: number | null; sharesDelta: number | null }

export interface DwCells { key: string; cells: string[]; titles: Array<string | undefined>; signs: Array<'up' | 'down' | undefined>; missing: boolean }

/** 一行 → 9 个单元格（缺数据 `—` + title 原因；永不返回空串） */
export function dwCells(r: DwRow, sharesStale: boolean): DwCells {
  const staleReason = '份额源未日更'
  const deltaMissing = sharesStale || r.sharesDelta === null
  const cells = [
    r.name,
    r.indexName,
    dwNum(r.scale, 1),
    dwNum(r.amount === null ? null : r.amount / 1e8, 2),
    dwNum(r.ratio20, 2, '×'),
    dwNum(r.netBuy === null ? null : r.netBuy / 1e8, 2, '', true),
    dwNum(r.pct, 2, '%', true),
    dwNum(r.sharesYi, 1),
    deltaMissing ? '—' : dwNum(r.sharesDelta, 2, '', true),
  ]
  const titles: Array<string | undefined> = [
    undefined, undefined,
    r.scale === null ? '源未给规模' : undefined,
    r.amount === null ? '源未给成交额' : undefined,
    r.ratio20 === null ? '源未给 20 日均额' : undefined,
    r.netBuy === null ? '逐笔方向未覆盖' : undefined,
    r.pct === null ? '源未给涨跌' : undefined,
    r.sharesYi === null ? '份额源未日更' : undefined,
    deltaMissing ? staleReason : undefined,
  ]
  const signs: Array<'up' | 'down' | undefined> = cells.map((c, i) => (i === 6 || i === 8) && c !== '—' ? (c.startsWith('+') ? 'up' : c.startsWith('−') ? 'down' : undefined) : undefined)
  return { key: r.secid, cells, titles, signs, missing: deltaMissing }
}

/** 表格模型：按规模降序 + 末行合计（合计也永不空） */
export function dwTable(rows: readonly DwRow[], summary: DwSummary, sharesStale: boolean): { head: readonly string[]; rows: DwCells[] } {
  const sorted = [...rows].sort((a, b) => (b.scale ?? -1) - (a.scale ?? -1))
  const body = sorted.map((r) => dwCells(r, sharesStale))
  const scaleRows = sorted.filter((r) => r.scale !== null)
  const scaleSum = scaleRows.reduce((a, r) => a + (r.scale as number), 0)
  const scaleSkip = sorted.length - scaleRows.length
  const deltaRows = sorted.filter((r) => r.sharesDelta !== null)
  const deltaSum = deltaRows.reduce((a, r) => a + (r.sharesDelta as number), 0)
  const deltaSkip = sorted.length - deltaRows.length
  const cross = (mine: number | null, theirs: number | null, label: string): { text: string; title?: string } => {
    if (mine === null) return { text: '—', title: `${label}：前端无可用行` }
    if (theirs !== null && Math.abs(mine - theirs) > 0.005) return { text: '—', title: `${label} 与后端不一致：前端 ${mine.toFixed(2)} / 后端 ${theirs.toFixed(2)}` }
    return { text: mine.toFixed(2), title: undefined }
  }
  const total: DwCells = {
    key: 'total',
    cells: [
      '合计', '—',
      scaleRows.length === 0 ? '—' : cross(scaleSum, null, '规模合计').text,
      dwNum(summary.totalAmount === null ? null : summary.totalAmount / 1e8, 2),
      dwNum(summary.ratio, 2, '×'),
      dwNum(summary.netBuy === null ? null : summary.netBuy / 1e8, 2, '', true),
      dwNum(summary.weightedPct, 2, '%', true),
      dwNum(summary.totalSharesYi, 1),
      sharesStale || deltaRows.length === 0 ? '—' : cross(deltaSum, null, '份额变化合计').text,
    ],
    titles: [
      undefined, undefined,
      scaleSkip > 0 ? `跳过 ${scaleSkip} 行缺规模` : undefined,
      undefined, undefined, undefined, undefined, undefined,
      sharesStale ? '份额源未日更' : deltaSkip > 0 ? `跳过 ${deltaSkip} 行缺份额变化` : undefined,
    ],
    signs: [undefined, undefined, undefined, undefined, undefined, 'down', 'down', undefined, sharesStale ? undefined : deltaSum < 0 ? 'down' : 'up'],
    missing: sharesStale,
  }
  return { head: DW_COLUMNS, rows: [...body, total] }
}

/** 图数据：柱（每日份额变化）与线（加仓指数） */
/** 好看的整数刻度（步长 1/2/5×10ⁿ），≥3 档且包含 anchor */
export function niceTicksOf(min: number, max: number, anchor: number, minCount = 3): number[] {
  const lo = Math.min(min, anchor)
  const hi = Math.max(max, anchor)
  if (!(Number.isFinite(lo) && Number.isFinite(hi)) || hi === lo) return [lo, lo + 1, lo + 2]
  const target = Math.max(minCount, 4)
  const raw = (hi - lo) / (target - 1)
  const mag = 10 ** Math.floor(Math.log10(raw))
  const step = [1, 2, 5, 10].map((m) => m * mag).find((st) => st >= raw) ?? 10 * mag
  const start = Math.floor(lo / step) * step
  const out: number[] = []
  for (let v = start; v <= hi + step * 0.5; v += step) out.push(Number(v.toFixed(6)))
  if (!out.includes(anchor)) out.push(anchor)
  return out.sort((a, b) => a - b)
}

/** X 轴日期刻度：至少 5 个（首/中/尾均匀取），标签为 `MM-DD` */
export function xTicksOf(days: readonly string[], minCount = 5): Array<{ i: number; label: string }> {
  if (days.length === 0) return []
  const n = Math.min(days.length, Math.max(minCount, 5))
  const idx = new Set<number>()
  for (let k = 0; k < n; k += 1) idx.add(Math.round((k * (days.length - 1)) / (n - 1)))
  return [...idx].sort((a, b) => a - b).map((i) => ({ i, label: (days[i] ?? '').slice(5) }))
}

export function dwSeries(series: readonly { day: string; change: number; index: number }[]): {
  bars: number[]; line: number[]; days: string[]
  barPct: number[]; yTicksBar: number[]; yTicksLine: number[]; xTicks: Array<{ i: number; label: string }>
} {
  const bars = series.map((s) => (Number.isFinite(s.change) ? s.change : 0))
  const line = series.map((s) => (Number.isFinite(s.index) ? s.index : Number.NaN)).filter((v) => Number.isFinite(v))
  const days = series.map((s) => s.day)
  // 柱高按 |峰值|/|谷值| 归一：max(|change|) ⇒ 100%
  const peak = Math.max(0, ...bars)
  const valley = Math.min(0, ...bars)
  const scale = Math.max(Math.abs(peak), Math.abs(valley), 1e-9)
  const barPct = bars.map((v) => (Math.abs(v) / scale) * 100)
  const yTicksBar = niceTicksOf(valley, peak, 0, 3)
  const yTicksLine = niceTicksOf(Math.min(100, ...line), Math.max(100, ...line), 100, 3)
  return { bars, line, days, barPct, yTicksBar, yTicksLine, xTicks: xTicksOf(days) }
}
