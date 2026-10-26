/**
 * 棱镜页的展示口径与判据（纯函数；页面与测试共用）。
 * 字号只用 12 / 14（Material 低端子集）；不写免责文案；缺数据 `—` + 一句原因。
 */
import type { PrismAnalysis, PrismNewsStatus, PrismSettings, PrismState, PrismTradingState } from '../shared/prism.ts'
import { shDayText, shStampText } from './marketTime.ts'

export const PRISM_FONT = { body: 12, title: 14 } as const

export function newsStatusText(s: PrismNewsStatus | null | undefined): string {
  if (s === null || s === undefined) return '—（尚未取到新闻状态）'
  if (s.state === 'error') return `—（${s.reason ?? '新闻源不可用'}）`
  if (s.state === 'backfilling') return `回填中（已 ${s.pages} 页）`
  if (s.state === 'idle') return '—（尚未回填）'
  return `${s.items} 条 · 最近更新 ${s.fetchedAt === null ? '—' : shStampText(s.fetchedAt)}`
}

/** 剥离 Markdown 标记（** / * / 反引号），保留文字；用于汇总、报告、错误摘要 */
export function stripMarkdown(text: string): string {
  return text.replace(/`+/g, '').replace(/\*\*|__/g, '').replace(/\*/g, '').replace(/_{2,}/g, '')
}

export function analysisText(a: PrismAnalysis): string {
  if (a.text !== null && a.text !== '') return stripMarkdown(a.text)
  return `—（${a.error ?? '未取到'}）`
}


export function timesText(settings: PrismSettings | null | undefined): string {
  if (settings === null || settings === undefined || settings.times.length === 0) return '—（未设置时点）'
  return settings.times.join(' / ')
}

/** 时点合法性：HH:MM、去重、1..50 个（可增删、无上限到 50） */
export function timesProblems(times: readonly string[]): string[] {
  const bad: string[] = []
  if (times.length === 0) bad.push('至少保留一个时点')
  if (times.length > 50) bad.push('时点最多 50 个')
  if (new Set(times).size !== times.length) bad.push('时点不能重复')
  for (const t of times) if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(t)) bad.push(`非法时点：${t}`)
  return bad
}

/** 页面源码判据：不得有免责文案；字号只用 12/14 */
export function prismPageProblems(src: string): string[] {
  const bad: string[] = []
  for (const word of ['免责', '风险提示', '不构成投资建议', '仅供参考']) {
    if (src.includes(word)) bad.push(`出现免责类文案「${word}」`)
  }
  for (const m of src.matchAll(/fontSize:\s*([0-9]+(?:\.[0-9]+)?)/g)) {
    const size = Number(m[1])
    if (size !== 12 && size !== 14) bad.push(`字号 ${size} 不在 12/14 内`)
  }
  return bad
}

/** ripple 判据：关键帧只许 transform/opacity；ripple 元素固定尺寸（不得动 width/height） */
export function rippleCssProblems(css: string): string[] {
  const bad: string[] = []
  const block = /@keyframes\s+tw-ripple\s*\{([\s\S]*?)\}\s*\}/.exec(css)?.[1] ?? null
  if (block === null) {
    bad.push('缺少 tw-ripple 关键帧')
  } else {
    for (const prop of ['width', 'height', 'top', 'left', 'margin', 'padding']) {
      if (new RegExp(`(^|[;{\\s])${prop}\\s*:`).test(block)) bad.push(`关键帧里出现布局属性 ${prop}`)
    }
  }
  const el = /\.tw-prism-ripple\s*\{([^}]*)\}/.exec(css)?.[1] ?? ''
  if (!/width:\s*100px/.test(el) || !/height:\s*100px/.test(el)) bad.push('ripple 必须是固定 100×100')
  if (!/transform:\s*scale\(/.test(block ?? '')) bad.push('ripple 必须用 transform: scale')
  return bad
}

/* ────────────────────────── 批次 4：模拟盘展示 ────────────────────────── */

import type { PrismEquityPoint, PrismOrder } from '../shared/prism.ts'

export const PRISM_MONEY = (n: number | null | undefined): string =>
  n === null || n === undefined || !Number.isFinite(n) ? '—' : n.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

export const PRISM_SIGNED = (n: number | null | undefined): string =>
  n === null || n === undefined || !Number.isFinite(n) ? '—' : `${n >= 0 ? '+' : ''}${PRISM_MONEY(n)}`

/** 四格：总资产/现金/当日盈亏/累计盈亏；缺数据带原因 */
export function topCardsOf(t: PrismTradingState | null, prices?: Readonly<Record<string, number | null>>): Array<{ key: string; label: string; value: string; hint: string | null }> {
  if (t === null) {
    return [
      { key: 'equity', label: '总资产', value: '—', hint: '尚未取到模拟盘账户' },
      { key: 'cash', label: '现金', value: '—', hint: null },
      { key: 'day', label: '当日盈亏', value: '—', hint: null },
      { key: 'total', label: '累计盈亏', value: '—', hint: null },
    ]
  }
  const a = t.account
  const px = prices ?? t.prices ?? {}
  const value = a.positions.reduce((sum, p) => sum + p.qty * (px[p.secid] ?? p.cost), 0)
  const equity = a.cash + value
  const total = equity - a.capitalLimit
  const dayInfo = dayPnlOf(t.equity)
  const day = dayInfo.value
  return [
    { key: 'equity', label: '总资产', value: PRISM_MONEY(equity), hint: `资金上限 ${PRISM_MONEY(a.capitalLimit)}` },
    { key: 'cash', label: '现金', value: PRISM_MONEY(a.cash), hint: null },
    { key: 'day', label: '当日盈亏', value: PRISM_SIGNED(day), hint: day === null ? dayInfo.reason : null },
    { key: 'total', label: '累计盈亏', value: PRISM_SIGNED(total), hint: `相对本金总盈亏 · 已实现 ${PRISM_SIGNED(a.realized)}` },
  ]
}

export function orderStatusText(o: PrismOrder): string {
  if (o.status === 'pending') return o.filledShares !== undefined && o.filledShares > 0 ? `部分成交（${o.filledShares}/${o.shares}）` : '待成交'
  if (o.status === 'filled') return '已成交'
  if (o.status === 'cancelled') return `已撤销${o.cancelReason === undefined ? '' : `（${o.cancelReason}）`}`
  return `不可成交（${o.rejectReason ?? '未给原因'}）`
}

/** 迷你净值折线：只画线，不画坐标文字；不足两点 ⇒ null */
export function sparklineOf(points: readonly PrismEquityPoint[], width = 160, height = 36): string | null {
  if (points.length < 2) return null
  const values = points.map((p) => p.equity)
  const min = Math.min(...values)
  const max = Math.max(...values)
  const span = max - min || 1
  return points
    .map((p, i) => {
      const x = (i / (points.length - 1)) * width
      const y = height - ((p.equity - min) / span) * height
      return `${x.toFixed(1)},${y.toFixed(1)}`
    })
    .join(' ')
}

/** 仓位占比：市值 ÷ 总资产（现金 + 持仓市值），2 位小数 %；总资产 ≤0 ⇒ null */
export function positionWeightPct(price: number | null, qty: number, totalAssets: number | null): number | null {
  if (price === null || totalAssets === null || !(totalAssets > 0)) return null
  return Math.round(((price * qty) / totalAssets) * 10_000) / 100
}

export const PRISM_PCT = (n: number | null): string => (n === null ? '—' : `${n.toFixed(2)}%`)

/** 页头自检文案：ok ⇒ 通过 + 耗时 + 文本；失败 ⇒ 失败 + error 原文 */
export function selftestText(r: { ok: boolean; error: string | null; text?: string | null; elapsedMs: number } | null): string {
  if (r === null) return '—（未自检）'
  if (r.ok) return `自检通过 · ${r.elapsedMs}ms · ${r.text ?? '—'}`
  return `自检失败 · ${r.error ?? '未给原因'}`
}

/** MD dataviz 8 系列色（Q13 定案：图表序列色；表格涨跌仍用 up/down token） */
export const PRISM_SERIES = ['#4C6EF5', '#E8590C', '#7048E8', '#0C8599', '#C2255C', '#2F9E44', '#F08C00', '#868E96'] as const
/** 图表用 CSS 变量，深色自动换成更浅的 viz 色 */
export const PRISM_SERIES_CSS = [
  'var(--tw-prism-series-1)', 'var(--tw-prism-series-2)', 'var(--tw-prism-series-3)', 'var(--tw-prism-series-4)',
  'var(--tw-prism-series-5)', 'var(--tw-prism-series-6)', 'var(--tw-prism-series-7)', 'var(--tw-prism-series-8)',
] as const

export interface EquityChart {
  line: string
  dots: Array<{ x: number; y: number; value: number }>
  min: number
  max: number
  last: number
}

/** 资本调整后收益序列：分母 = 首个有 capital 的点 (equity − capital)；缺 capital 的点为 null + 原因 */
export function adjustedReturnSeries(points: ReadonlyArray<{ day: string; equity: number; capital?: number }>): Array<{ day: string; value: number | null; reason: string | null }> {
  const base = points.find((p) => typeof p.capital === 'number')
  const baseValue = base === undefined ? null : base.equity - (base.capital as number)
  return points.map((p) => {
    if (typeof p.capital !== 'number') return { day: p.day, value: null, reason: '该净值点缺 capital，不能用当前值回填' }
    if (baseValue === null || baseValue === 0) return { day: p.day, value: null, reason: '调整后收益的基准点为 0 或缺失' }
    return { day: p.day, value: ((p.equity - p.capital) / baseValue - 1) * 100, reason: null }
  })
}

/** 当日盈亏：净值序列 + capital 差分；不用 dayStartEquity，也不拿当前 capital 回填 */
export function dayPnlOf(points: ReadonlyArray<{ day?: string; equity: number; capital?: number }> | null | undefined): { value: number | null; reason: string | null } {
  if (points === null || points === undefined || points.length < 2) return { value: null, reason: '净值序列不足两个点' }
  const cur = points[points.length - 1]
  const prev = points[points.length - 2]
  if (cur === undefined || prev === undefined) return { value: null, reason: '净值序列不足两个点' }
  if (typeof cur.capital !== 'number' || typeof prev.capital !== 'number') return { value: null, reason: '净值点缺 capital，不能用当前值回填' }
  return { value: (cur.equity - cur.capital) - (prev.equity - prev.capital), reason: null }
}

/** 净值折线几何：细网格/点标记/数据标签共用同一份坐标（无坐标文字）；adjusted 用 equity−capital */
export function equityChartOf(points: ReadonlyArray<{ equity: number; capital?: number }>, width = 560, height = 128, mode: 'nominal' | 'adjusted' = 'nominal'): EquityChart | null {
  const use = mode === 'adjusted' ? points.filter((p) => typeof p.capital === 'number') : points
  if (use.length < 2) return null
  const values = use.map((p) => mode === 'adjusted' ? p.equity - (p.capital as number) : p.equity)
  const min = Math.min(...values)
  const max = Math.max(...values)
  const span = max - min || 1
  const dots = use.map((p, i) => ({
    x: (i / (use.length - 1)) * width,
    y: height - ((mode === 'adjusted' ? p.equity - (p.capital as number) : p.equity) - min) / span * (height - 16) - 8,
    value: mode === 'adjusted' ? p.equity - (p.capital as number) : p.equity,
  }))
  return { line: dots.map((d) => `${d.x.toFixed(1)},${d.y.toFixed(1)}`).join(' '), dots, min, max, last: values[values.length - 1] as number }
}

/** 汇总文本 → 最多 5 条要点（去掉编号；每行/编号项一条；空 ⇒ []） */
export function summaryBullets(summary: string | null | undefined): string[] {
  if (summary === null || summary === undefined) return []
  // 汇总里可能带 ```json 决策块：要点只取自然语言，原始 JSON 一律不进页面
  const prose = stripMarkdown(summary.replace(/```[\s\S]*?```/g, ''))
  const lines = prose
    .split(/\n+/)
    .flatMap((line) => line.split(/(?=\d+[.、]\s)/))
    .map((line) => line.replace(/^\s*\d+[.、]\s*/, '').trim())
    .filter((line) => line !== '' && !/^[\{\[]/.test(line) && !/["']?(limits|orders|cancel)["']?\s*:/.test(line))
  return lines.slice(0, 5)
}

export interface DecisionRow {
  key: string
  value: string
  muted?: boolean
}

export interface DecisionRowOptions {
  cash?: number | null
  minPrice?: number | null
}

/** 单票上限：可买额度不足一手时，百分比没有行动意义 ⇒ 显示原因；原计算留在 limits.note */
export function singleLimitText(singlePct: number | null | undefined, cash: number | null | undefined, minPrice: number | null | undefined): string {
  if (typeof singlePct !== 'number') return '—'
  if (cash === undefined || minPrice === undefined || cash === null || minPrice === null) return `${singlePct}%`
  if (cash < minPrice * 100) return '—（可买额度不足一手）'
  return `${singlePct}%`
}

/** 决策卡：只给小表，不渲染原始 JSON */
export function decisionRows(decision: {
  note?: string | null
  limits?: { singlePct?: number | null; totalPct?: number | null; note?: string | null }
  orders?: readonly unknown[]
  cancel?: readonly unknown[]
  rejects?: ReadonlyArray<{ secid?: string; reason?: string }>
} | null | undefined, opts: DecisionRowOptions = {}): DecisionRow[] {
  const pct = (n: number | null | undefined): string => (typeof n === 'number' ? `${n}%` : '—')
  const prose = (t: string | null | undefined): string => (typeof t === 'string' && t.trim() !== '' ? t.trim() : '—')
  return [
    { key: '单票上限', value: typeof opts.cash === 'undefined' && typeof opts.minPrice === 'undefined'
      ? pct(decision?.limits?.singlePct)
      : singleLimitText(decision?.limits?.singlePct, opts.cash, opts.minPrice) },
    { key: '总仓位上限', value: pct(decision?.limits?.totalPct) },
    { key: '仓位上限依据', value: prose(decision?.limits?.note), muted: (decision?.limits?.note ?? '') === '' },
    { key: '决策理由', value: prose(decision?.note), muted: (decision?.note ?? '') === '' },
    { key: 'orders', value: String(decision?.orders?.length ?? 0), muted: (decision?.orders?.length ?? 0) === 0 },
    { key: 'cancel', value: String(decision?.cancel?.length ?? 0), muted: (decision?.cancel?.length ?? 0) === 0 },
    {
      key: 'rejects',
      value: (decision?.rejects?.length ?? 0) === 0
        ? '无'
        : (decision?.rejects ?? []).map((r) => `${r.secid ?? '—'} ${r.reason ?? '未给原因'}`).join('；'),
      muted: (decision?.rejects?.length ?? 0) === 0,
    },
  ]
}

/** 页面不得直接显示原始 JSON；解析失败只显示摘要（原文留在接口） */
export function decisionErrorText(raw: string | null | undefined, max = 120): string {
  if (raw === null || raw === undefined || raw === '') return ''
  const cleaned = stripMarkdown(raw.replace(/\{[\s\S]*\}/g, '')).replace(/\s+/g, ' ').trim()
  return cleaned === '' ? '原文已留存在接口，不在页面展开' : cleaned.slice(0, max)
}

export interface SelftestResult {
  ok: boolean
  error: string | null
  model: string | null
  elapsedMs: number
  text: string | null
  chunks: Array<{ type: string; keys: string[] }>
}

/** 解析自检回包：HTTP 200 + 非 JSON 也要给出可读原因，绝不把 200 当失败 */
export function parseSelftestBody(status: number, raw: string): SelftestResult {
  const fallback: SelftestResult = { ok: false, error: null, model: null, elapsedMs: 0, text: null, chunks: [] }
  const text = raw.trim()
  if (text === '') return { ...fallback, error: '响应为空（前 60 字：）' }
  try {
    const body = JSON.parse(text) as Partial<SelftestResult>
    if (typeof body.ok !== 'boolean') return { ...fallback, error: `响应缺少 ok 字段（前 60 字：${text.slice(0, 60)}）` }
    return {
      ok: body.ok,
      error: typeof body.error === 'string' ? body.error : null,
      model: typeof body.model === 'string' ? body.model : null,
      elapsedMs: typeof body.elapsedMs === 'number' ? body.elapsedMs : 0,
      text: typeof body.text === 'string' ? body.text : null,
      chunks: Array.isArray(body.chunks) ? body.chunks : [],
    }
  } catch {
    const prefix = status === 200 ? '响应非 JSON' : `请求失败（HTTP ${status}）`
    return { ...fallback, error: `${prefix}（前 60 字：${text.slice(0, 60)}）` }
  }
}

export interface CompositionItem {
  key: string
  name: string
  weight: number
  color: string
}

/** 净值卡图例：只允许一个口径（总资产） */
export function equityLegendItems(): string[] {
  return ['总资产']
}

/**
 * 持仓构成条：最多 6 项；≤6 全列，>6 前 5 + 其他。
 * 权重 = 市值 ÷ 总资产；缺价按成本。现金不混进持仓图例（用底色留白表示）。
 */
export function compositionItems(
  positions: ReadonlyArray<{ secid: string; name: string; qty: number; cost: number }>,
  prices: Readonly<Record<string, number | null>>,
  totalAssets: number | null,
  series: readonly string[],
): CompositionItem[] {
  if (totalAssets === null || !(totalAssets > 0)) return []
  const weighed = positions.map((p) => ({
    key: p.secid,
    name: p.name,
    weight: Math.round((((prices[p.secid] ?? p.cost) * p.qty) / totalAssets) * 10_000) / 100,
  }))
  if (weighed.length <= 6) {
    return weighed.map((w, i) => ({ ...w, color: series[i % series.length] as string }))
  }
  const head = weighed.slice(0, 5).map((w, i) => ({ ...w, color: series[i] as string }))
  const otherWeight = Math.round(weighed.slice(5).reduce((a, w) => a + w.weight, 0) * 100) / 100
  return [...head, { key: 'other', name: '其他', weight: otherWeight, color: series[5] as string }]
}

/** 评估缺数据/样本不足的统一占位；不返回 null */
export function unavailableEvaluation(reason: string): import('../shared/prism.ts').PrismEvaluation {
  return {
    excess: { withFee: null, withoutFee: null, reason, n: 0 },
    drawdown: { value: null, reason, n: 0 },
    hitRate: { value: null, reason, n: 0 },
    n: 0, embargoDays: 1, footnote: '非重叠样本 · 不含 embargo 区间', curve: [], reason,
  }
}

/** 迷你超额曲线（累计 %）；少于 2 点 ⇒ null */
export function evalCurveOf(values: readonly number[], width = 320, height = 64): string | null {
  if (values.length < 2) return null
  const min = Math.min(...values, 0)
  const max = Math.max(...values, 0)
  const span = max - min || 1
  return values.map((v, i) => `${((i / (values.length - 1)) * width).toFixed(1)},${(height - ((v - min) / span) * (height - 8) - 4).toFixed(1)}`).join(' ')
}

/** 行业暴露缺数据时的唯一占位：卡片仍渲染，表体 — + 原因 */
export function unavailableExposure(reason: string): import('../shared/prism.ts').PrismExposure {
  return { state: 'unavailable', reason, rows: [], classifiedPct: 0, unclassifiedPct: 0, unpenetratedPct: 0, cashPct: 0, total: 0 }
}

/** 统一交易账户：老宿主/半包若 trading.account 为空，落回 state.account（同一份 cash/positions） */
export function normalizeTradingState(payload: {
  trading?: PrismTradingState | null
  state?: PrismState | null
}): PrismTradingState | null {
  const raw = payload.trading ?? null
  const fallback = payload.state?.account ?? null
  if (raw === null && fallback === null) return null
  const rawPositions = raw?.account?.positions?.length ?? 0
  const fallbackPositions = fallback?.positions?.length ?? 0
  const account = rawPositions === 0 && fallbackPositions > 0 ? fallback : raw?.account ?? fallback
  if (account === null) return raw
  return {
    account,
    orders: raw?.orders ?? payload.state?.orders ?? [],
    fills: raw?.fills ?? payload.state?.fills ?? [],
    equity: (raw?.equity?.length ?? 0) >= (payload.state?.equity?.length ?? 0)
      ? raw?.equity ?? []
      : payload.state?.equity ?? [],
    decision: raw?.decision ?? payload.state?.decision ?? null,
    prices: raw?.prices,
    exposure: raw?.exposure ?? payload.state?.exposure ?? unavailableExposure('接口未返回行业暴露（旧宿主或半包）'),
    evaluation: raw?.evaluation ?? payload.state?.evaluation ?? unavailableEvaluation('接口未返回评估数据（旧宿主或半包）'),
  }
}

/* ── P-UI：分段布局 / 决策依据块的渲染级判据（纯函数，页面与测试共用） ── */
export const SEGMENT_GAP = 4
export const SEGMENT_PADDING = 2
export const SEGMENT_PAD_X = 12
export const SEGMENT_FONT = 12.5
export const SEGMENT_SELECTED_BG = 'rgba(94,106,210,.18)'
export const SEGMENT_SELECTED_COLOR = '#2f3aa0'

/** 每项最小宽度 = 最长标签按字号折算 + 两侧内边距（至少 1 个汉字宽） */
export function segmentItemWidthOf(labels: readonly string[], fontPx = SEGMENT_FONT, padX = SEGMENT_PAD_X): number {
  const longest = labels.reduce((n, s) => Math.max(n, [...s].length), 0)
  return Math.ceil(longest * fontPx + padX * 2)
}

/** 计算每个 tab 的实际 x/宽度与相邻间隙；间隙必须 ≥ SEGMENT_GAP */
export function segmentLayoutOf(
  labels: readonly string[],
  opts: { gap?: number; padding?: number } = {},
): { items: Array<{ label: string; x: number; width: number }>; gaps: number[]; gap: number; padding: number } {
  const gap = opts.gap ?? SEGMENT_GAP
  const padding = opts.padding ?? SEGMENT_PADDING
  const width = segmentItemWidthOf(labels)
  const items = labels.map((label, i) => ({ label, x: padding + i * (width + gap), width }))
  const gaps = items.slice(1).map((it, i) => it.x - ((items[i] as { x: number; width: number }).x + (items[i] as { width: number }).width))
  return { items, gaps, gap, padding }
}

/** 选中/未选中背景与字重（渲染值的唯一出口） */
export function segmentPaintOf(selected: boolean): { background: string; color: string; fontWeight: number } {
  return selected
    ? { background: SEGMENT_SELECTED_BG, color: SEGMENT_SELECTED_COLOR, fontWeight: 700 }
    : { background: 'transparent', color: 'var(--tw-dim)', fontWeight: 400 }
}

/** 「仓位上限依据」恰为 3 块，每块 flatten 成单行（页面不得用 \n 拼成一段） */
export function basisBlocksOf(parts: readonly string[]): string[] {
  if (parts.length !== 3) throw new Error(`仓位上限依据必须恰为 3 块（实得 ${parts.length}）`)
  return parts.map((p) => p.replace(/\s*\n\s*/g, ' ').trim())
}

/* ── 决策长文本：宽度/行数 clamp 的纯函数（页面 CSS 与测试共用） ── */
/** 决策理由/仓位依据：完整多行显示，不截断、不省略 */
export interface DecisionReasonLayout {
  width: number
  contentWidth: number
  lines: number
  height: number
  truncated: false
}

/** 纯函数：按卡片内容宽度换行；行数随长度增长，永不截断 */
export function decisionReasonLayoutOf(
  text: string,
  cardContentWidth: number,
  charWidth = 7,
  lineHeight = 20,
): DecisionReasonLayout {
  const width = Math.max(1, cardContentWidth)
  const perLine = Math.max(1, Math.floor(width / Math.max(1, charWidth)))
  const lines = Math.max(1, Math.ceil([...text].length / perLine))
  return { width, contentWidth: width, lines, height: lines * lineHeight, truncated: false }
}

/** 渲染宽度不得超过卡片内容宽度 */
export function decisionReasonFits(contentWidth: number, renderedWidth: number): boolean {
  return renderedWidth <= contentWidth
}

/** 左栏仍为容器 62%，不因文本被撑开 */
export function leftColumnPctOf(bodyWidth: number, leftWidth: number): number {
  if (!(bodyWidth > 0)) return 0
  return Math.round((leftWidth / bodyWidth) * 10000) / 100
}

/* ── 挂单/成交只显示北京时间当天；历史留在磁盘，不做 UI 物理删除 ── */
export function beijingDayOf(ms: number): string {
  return shDayText(ms)
}

export function todayBeijing(now = Date.now()): string {
  return shDayText(now)
}

export function todayOrdersOf<T extends { day?: string; decidedAt?: number }>(orders: readonly T[], today: string): T[] {
  return orders.filter((o) => {
    const day = typeof o.day === 'string' && o.day !== '' ? o.day : (typeof o.decidedAt === 'number' ? beijingDayOf(o.decidedAt) : '')
    return day === today
  })
}

export function todayFillsOf<T extends { at: number }>(fills: readonly T[], today: string): T[] {
  return fills.filter((f) => beijingDayOf(f.at) === today)
}

export function dayTableTitle(kind: 'orders' | 'fills', count: number): string {
  return kind === 'orders' ? `挂单（今日 ${count} 笔）` : `成交（今日 ${count} 笔）`
}

export function dayTableEmpty(kind: 'orders' | 'fills'): string {
  return kind === 'orders' ? '—（今日无挂单）' : '—（今日无成交）'
}

/* ── 分段/表格 flex 挤压的渲染级判据（纯函数） ── */
export const SEGMENT_MIN_HEIGHT = 32

/** 成交 0/26/200 行时，分段高度应恒为 32；缺 flex:0 0 auto 时模拟为 8 */
export function segmentRenderHeightOf(rowCount: number, css: string): number {
  const seg = /\.tw-prism-seg\{([^}]*)\}/.exec(css)?.[1] ?? ''
  const fixed = /flex:0 0 auto/.test(seg) && /min-height:32px/.test(seg)
  return fixed ? SEGMENT_MIN_HEIGHT : rowCount > 0 ? 8 : SEGMENT_MIN_HEIGHT
}

/** 分段三项宽度之和；项宽由 CSS min-width 决定，不得被压缩 */
export function segmentWidthSumOf(labels: readonly string[], css: string): number {
  const btn = /\.tw-prism-segbtn\{([^}]*)\}/.exec(css)?.[1] ?? ''
  const m = /min-width:(\d+)px/.exec(btn)
  if (m === null) return 0
  return labels.length * Number(m[1])
}

/** 表格容器必须自己滚动，而不是压缩兄弟 */
export function tableScrollOk(css: string): boolean {
  const block = /\.tw-prism-tablecard\{([^}]*)\}/.exec(css)?.[1] ?? ''
  return /flex:1 1 auto/.test(block) && /min-height:0/.test(block) && /overflow:auto/.test(block)
}

/* ── 成交渲染合并：磁盘 fills 保留逐笔，UI 按 bar 合并 ── */
export interface MergedFill {
  day: string
  barTime: number
  secid: string
  name: string
  side: 'buy' | 'sell'
  price: number
  shares: number
  fee: number
  source: '1min' | 'trend'
  count: number
}

export function mergedFillsOf(fills: ReadonlyArray<{
  secid: string; name: string; side: 'buy' | 'sell'; price: number; shares: number; fee: number; at: number; source: '1min' | 'trend'
}>): MergedFill[] {
  const map = new Map<string, MergedFill>()
  for (const f of fills) {
    const day = beijingDayOf(f.at)
    const key = `${day}|${f.at}|${f.secid}|${f.side}|${f.price}`
    const cur = map.get(key)
    if (cur === undefined) {
      map.set(key, { day, barTime: f.at, secid: f.secid, name: f.name, side: f.side, price: f.price, shares: f.shares, fee: f.fee, source: f.source, count: 1 })
    } else {
      cur.shares += f.shares
      cur.fee = Math.round((cur.fee + f.fee) * 100) / 100
      cur.count += 1
    }
  }
  return [...map.values()]
}
