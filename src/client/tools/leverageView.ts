/**
 * 工具②「杠杆温度计」的**视图模型**（纯函数，无 React 依赖 ⇒ `node:test` 可直接读）。
 *
 * 职责边界（与工具①同一套分工）：
 *   · 宿主负责口径与计算（温度分位、比例、净买入、序列）—— 客户端**不重算**任何指标；
 *   · 这里只把载荷渲染成页面模型（数字格式化、缺值 → `—`、绘图几何），页面只渲染模型；
 *   · 页面（`leveragePage.tsx`）里不算数、不造数、不写第二份占位文案。
 *
 * 用户口径（逐条对应任务书的页面规格，多一个字都不要）：
 *   ① 大字 = 温度（1 位小数）+ `/ 100`；**页面上唯一的说明文字**是 `截至 YYYY-MM-DD`（来自 `asOf`）；
 *   ② 三张摘要卡：显性融资（`ratioPct`，2 位小数 %）、杠杆率（`ratioWithShortPct`，2 位小数 %）、
 *      当日融资净买入（`netBuy`，元 → 亿/万亿、2 位小数、带正负号）；**不要第四张**；
 *   ③ 主图：**双轴**（左 = 温度 0–100，右 = 比例 %）+ 两条线（温度 / 显性融资比例）
 *      + 阈值线 80 / 95 画在温度轴上、**只标数字**；
 *   ④ 底部柱 = 当日融资净买入，正红负蓝（跟随既有涨跌 token，不硬编码色值），**缺值就不画柱**；
 *   ⑤ 窗口三档 = `range=250 / 750 / all`，**只换查询参数**（不新增接口）；
 *   ⑥ 奥卡姆剃刀：**没有**水平网格线、**没有**浮框/十字光标；保留图例、右轴刻度、柱图零轴；
 *   ⑦ 缺失一律 `—`（破折号）：不加文字、不进悬停、不写 0 顶替。
 *
 * 为什么绘图几何也放在这里：图的**结构**（哪条线是阈值、有没有网格、柱子的颜色）是可断言的量。
 * 做成纯数据后，`leverageTool.test.ts` 直接对模型跑判据（`leverageChartProblems`），不必靠正则捞 JSX。
 */
import type { LeveragePayloadDto, LeverageRange } from '../api.ts'
import { PLOT } from '../toolDetailTheme.ts'

/* ────────────────────────────── 1. 文案与格式化 ────────────────────────────── */

/** 缺值占位（**唯一来源**）：任何数值缺失一律显示它，不加一个字 */
export const DASH = '—'

export interface LeverageRangeOption {
  range: LeverageRange
  label: string
}

/**
 * 窗口三档（用户口径的标签逐字：`1 年` / `3 年` / `全历史`）。
 * ⚠ 三档共用**同一个**接口，只有查询参数变（判据见 `leverageTool.test.ts` ⑥）。
 */
export const LEVERAGE_RANGES: readonly LeverageRangeOption[] = [
  { range: '250', label: '1 年' },
  { range: '750', label: '3 年' },
  { range: 'all', label: '全历史' },
]

/** 默认档 = 3 年（750，用户口径） */
export const LEVERAGE_DEFAULT_RANGE: LeverageRange = '750'

function finite(v: number | null | undefined): v is number {
  return typeof v === 'number' && Number.isFinite(v)
}

/** 温度：`91.2`（1 位小数）；缺 ⇒ `—` */
export function fmtTemperature(v: number | null | undefined): string {
  return finite(v) ? v.toFixed(1) : DASH
}

/** 比例（%）：`2.65%`（2 位小数）；缺 ⇒ `—` */
export function fmtRatioPct(v: number | null | undefined): string {
  return finite(v) ? `${v.toFixed(2)}%` : DASH
}

/**
 * 金额（元 → 亿 / 万亿）：2 位小数 + 显式正负号（用户口径）。
 *
 *   · `-6331355686` ⇒ `-63.31 亿`
 *   · `1500000000000` ⇒ `+1.50 万亿`
 *   · 四舍五入到 2 位后为 0 ⇒ 去掉符号（避免 `-0.00 亿` 这种看起来像错值的负零）
 *   · 缺 ⇒ `—`（**不用 0 顶替**）
 */
export function fmtNetYi(v: number | null | undefined): string {
  if (!finite(v)) return DASH
  const unit = Math.abs(v) >= 1e12 ? { div: 1e12, name: '万亿' } : { div: 1e8, name: '亿' }
  const scaled = v / unit.div
  const zeroed = Math.abs(scaled) < 0.005 ? 0 : scaled
  const sign = zeroed > 0 ? '+' : zeroed < 0 ? '-' : ''
  return `${sign}${Math.abs(zeroed).toFixed(2)} ${unit.name}`
}

/** `截至 YYYY-MM-DD`（**页面上唯一的说明文字**）；`asOf` 为空串/缺 ⇒ **只给 `—`**（不出现「截至」二字） */
export function leverageAsOfText(payload: LeveragePayloadDto | null): string {
  const day = payload === null ? '' : String(payload.asOf ?? '').trim()
  // ⚠ `asOf` 为空串 = 整块不可用（宿主约定）⇒ **只给 `—`，不渲染「截至 」**：
  //   一个没有日期的「截至」既不是读数也不是时间，属于用户口径里"缺失不加文字"的范畴。
  return day === '' ? DASH : `截至 ${day}`
}

/** 三张摘要卡（**只有三张**，顺序即渲染顺序；值全部来自载荷，缺 ⇒ `—`） */
export interface LeverageCard {
  key: 'ratio' | 'leverage' | 'net'
  label: string
  value: string
}

export function leverageCards(payload: LeveragePayloadDto | null): LeverageCard[] {
  return [
    { key: 'ratio', label: '显性融资', value: fmtRatioPct(payload?.ratioPct ?? null) },
    { key: 'leverage', label: '杠杆率', value: fmtRatioPct(payload?.ratioWithShortPct ?? null) },
    { key: 'net', label: '当日融资净买入', value: fmtNetYi(payload?.netBuy ?? null) },
  ]
}

/* ────────────────────────────── 2. 图例与配色 ────────────────────────────── */

export interface LeverageLegendItem {
  name: string
  color: string
}

/**
 * 三条序列的颜色（**唯一来源**：图例与画出来的线取同一份，颜色全走主题 token、不硬编码）。
 * 净买入那一格是图例色标，柱子本身按正负取涨跌 token（`netBarColor`）。
 */
const SERIES_COLOR = {
  temp: 'var(--tw-accent)',
  ratio: 'var(--tw-chip-avg)',
  net: 'var(--tw-chip-profile)',
} as const

export const LEVERAGE_LEGEND: readonly LeverageLegendItem[] = [
  { name: '温度', color: SERIES_COLOR.temp },
  { name: '显性融资比例', color: SERIES_COLOR.ratio },
  { name: '净买入', color: SERIES_COLOR.net },
]

/**
 * 柱色：正 = 涨（`--tw-up`）、负 = 跌（`--tw-down`）、恰好 0 / 缺 ⇒ 中性。
 *
 * ⚠ 不硬编码色值：`--tw-up` / `--tw-down` 是仓库里既有的涨跌语义 token（深/浅两档主题各有一份，
 * 隐身视图会把两者都转灰阶）。"红涨蓝跌"这类具体色相由主题决定，本工具只认语义。
 */
export function netBarColor(v: number | null | undefined): string {
  if (!finite(v) || v === 0) return 'var(--tw-flat)'
  return v > 0 ? 'var(--tw-up)' : 'var(--tw-down)'
}

/* ────────────────────────────── 3. 绘图区几何与模型 ────────────────────────────── */

/** 折线区占绘图区高度的比例（剩下的是底部柱图带） */
const LINE_SHARE = 0.72
/** 折线区与柱图带之间的空隙（px；落在 1px 刻度上） */
const BAND_GAP = 8
/** 柱宽下限（px）：750/4018 个交易日的单日柱远小于 1px ⇒ 密集时连成一片面积，仍然"每天一根" */
const BAR_MIN_W = 0.6
/** 左轴（温度 0 / 50 / 100）要比折线图多占的宽度（px） */
const AXIS_LEFT = 34

/** 水平线：只允许「阈值线」与「柱图零轴」两种角色（**没有**网格线这一档） */
export interface LeverageChartLine {
  role: 'threshold' | 'zero'
  x1: number
  y1: number
  x2: number
  y2: number
  dash: boolean
}

/** 折线：温度 / 显性融资比例各一条（缺值的点断开，不插值、不补 0） */
export interface LeverageChartPath {
  role: 'temp' | 'ratio'
  d: string
  color: string
}

/** 底部柱：当日融资净买入（**该日缺值就没有这一根**） */
export interface LeverageChartBar {
  role: 'net'
  x: number
  y: number
  w: number
  h: number
  color: string
}

/** 图上文字：只允许刻度数字、阈值数字、首末日期（不许出现解释文案） */
export interface LeverageChartText {
  role: 'left-tick' | 'right-tick' | 'threshold-label' | 'x-first' | 'x-last'
  x: number
  y: number
  text: string
  anchor: 'start' | 'middle' | 'end'
}

export interface LeverageChart {
  width: number
  height: number
  lines: LeverageChartLine[]
  paths: LeverageChartPath[]
  bars: LeverageChartBar[]
  texts: LeverageChartText[]
}

/** 阈值只标数字：整数直出，非整数给 1 位小数（`80` / `95`） */
function thresholdText(v: number): string {
  return Number.isInteger(v) ? String(v) : v.toFixed(1)
}

/**
 * 主图模型（**纯函数**：给定载荷与画布像素 ⇒ 要画的一切）。
 *
 * 几何复用详情页的 `PLOT` 令牌：高度契约 `PLOT.heightCss`（clamp 280–380）、右内边距留给右轴刻度、
 * 上下内边距与折线图同款；**左**内边距加宽到 `AXIS_LEFT`（左轴要放 0 / 50 / 100）。
 *
 * 空数据（没有日期）⇒ 返回空模型：一个刻度、一条线都不画（**不写"未取到"之类的文字**）。
 */
export function leverageChart(payload: LeveragePayloadDto | null, width: number, height: number): LeverageChart {
  const W = Math.max(240, Math.round(width))
  const H = Math.max(PLOT.heightMin, Math.round(height))
  const left = AXIS_LEFT
  const right = W - PLOT.pad.right
  const top = PLOT.pad.top
  const bottom = H - PLOT.pad.bottom
  const empty: LeverageChart = { width: W, height: H, lines: [], paths: [], bars: [], texts: [] }
  const dates = payload?.dates ?? []
  const count = dates.length
  if (payload === null || count === 0 || right <= left) return empty

  const inner = right - left
  const bandH = Math.max(24, bottom - top)
  const lineH = Math.max(24, Math.round(bandH * LINE_SHARE))
  const lineBottom = top + lineH
  const barTop = Math.min(lineBottom + BAND_GAP, Math.max(top + 24, bottom - 4))
  const barH = Math.max(1, bottom - barTop)

  /** 第 i 天的 x（`count === 1` 时贴左内边距：单点画不出线，但仍要落在正确位置） */
  const xOf = (i: number): number => (count <= 1 ? left : left + (i * inner) / (count - 1))
  /** 温度轴：**固定 0–100**（规格：左轴 0–100） */
  const yTemp = (v: number): number => top + (1 - Math.max(0, Math.min(100, v)) / 100) * lineH

  const lines: LeverageChartLine[] = []
  const paths: LeverageChartPath[] = []
  const bars: LeverageChartBar[] = []
  const texts: LeverageChartText[] = []

  /* ── 两条线：温度（左轴）+ 显性融资比例（右轴）────────────────────────────── */
  const tempValues = payload.temp ?? []
  const ratioValues = payload.ratio ?? []
  const tempPath = pathOf(tempValues, xOf, yTemp)
  if (tempPath !== '') paths.push({ role: 'temp', d: tempPath, color: SERIES_COLOR.temp })

  const ratioVals = ratioValues.filter(finite)
  if (ratioVals.length > 0) {
    // 右轴取值域由数据决定（比例常年在 2–3%，从 0 起点会把整条线压成一条平线）；上下各留 12% 余量
    const mn = Math.min(...ratioVals)
    const mx = Math.max(...ratioVals)
    const span = mx - mn
    const pad = span > 0 ? span * 0.12 : Math.max(0.05, Math.abs(mx) * 0.05 || 0.05)
    const lo = mn - pad
    const hi = mx + pad
    const yRatio = (v: number): number => top + (1 - (v - lo) / (hi - lo)) * lineH
    const ratioPath = pathOf(ratioValues, xOf, yRatio)
    if (ratioPath !== '') paths.push({ role: 'ratio', d: ratioPath, color: SERIES_COLOR.ratio })
    for (const t of [lo, (lo + hi) / 2, hi]) {
      texts.push({ role: 'right-tick', x: right + 6, y: yRatio(t) + 3.5, text: `${t.toFixed(2)}%`, anchor: 'start' })
    }
  }

  /* ── 左轴刻度：0 / 50 / 100（固定域）──────────────────────────────────────── */
  for (const t of [0, 50, 100]) {
    texts.push({ role: 'left-tick', x: left - 6, y: yTemp(t) + 3.5, text: String(t), anchor: 'end' })
  }

  /* ── 底部柱：当日融资净买入（缺值不画柱）────────────────────────────────── */
  const nets = payload.net ?? []
  let netLo = 0
  let netHi = 0
  let netCount = 0
  for (const v of nets) {
    if (!finite(v)) continue
    netCount += 1
    if (v < netLo) netLo = v
    if (v > netHi) netHi = v
  }
  if (netCount > 0) {
    // 取值域一定含 0（初值就是 0）⇒ 零轴永远落在柱带内；全零（netSpan === 0）时退化为柱带底边
    const netSpan = netHi - netLo
    const yNet = (v: number): number => (netSpan === 0 ? bottom : barTop + (1 - (v - netLo) / netSpan) * barH)
    const yZero = yNet(0)
    const bw = Math.max(BAR_MIN_W, (inner / Math.max(1, count)) * 0.7)
    for (let i = 0; i < nets.length; i += 1) {
      const v = nets[i]
      if (!finite(v)) continue
      const cx = xOf(i)
      const x = Math.min(Math.max(left, cx - bw / 2), Math.max(left, right - bw))
      const yTop = Math.min(yZero, yNet(v))
      bars.push({ role: 'net', x, y: yTop, w: bw, h: Math.abs(yNet(v) - yZero), color: netBarColor(v) })
    }
    // 柱图零轴（规格 7 保留的那一条水平线）：有柱才画
    lines.push({ role: 'zero', x1: left, y1: yZero, x2: right, y2: yZero, dash: false })
  }

  /* ── 阈值线 80 / 95：画在温度轴上，只标数字，不带文字 ────────────────────── */
  const thresholds = [payload.thresholds?.p80 ?? null, payload.thresholds?.p95 ?? null].filter(finite)
  const seen = new Set<number>()
  for (const t of thresholds) {
    if (seen.has(t)) continue // 两档阈值相等 ⇒ 只画一条（不叠线、不叠字）
    seen.add(t)
    const y = yTemp(t)
    pushThreshold(lines, texts, left, right, y, t)
  }

  /* ── 首末日期（与折线图同款的最小时间参照；不是说明文字）─────────────────── */
  texts.push({ role: 'x-first', x: left, y: H - 6, text: String(dates[0]), anchor: 'start' })
  if (count > 1) texts.push({ role: 'x-last', x: right, y: H - 6, text: String(dates[count - 1]), anchor: 'end' })

  return { width: W, height: H, lines, paths, bars, texts }
}

/** 一条阈值线 + 它唯一的数字标签（抽出来只为让"只标数字"这条规则只有一处实现） */
function pushThreshold(lines: LeverageChartLine[], texts: LeverageChartText[], left: number, right: number, y: number, value: number): void {
  lines.push({ role: 'threshold', x1: left, y1: y, x2: right, y2: y, dash: true })
  texts.push({ role: 'threshold-label', x: left + 4, y: y - 4, text: thresholdText(value), anchor: 'start' })
}

/** 折线路径：缺值的点**断开**（`M` 重新起笔），不插值、不补 0 */
function pathOf(values: ReadonlyArray<number | null>, xOf: (i: number) => number, yOf: (v: number) => number): string {
  let d = ''
  let open = false
  for (let i = 0; i < values.length; i += 1) {
    const v = values[i]
    if (!finite(v)) {
      open = false
      continue
    }
    d += `${open ? 'L' : 'M'}${xOf(i).toFixed(1)} ${yOf(v).toFixed(1)} `
    open = true
  }
  return d.trim()
}

/* ────────────────────────────── 4. 结构判据（唯一实现） ────────────────────────────── */

/** 允许出现的水平线角色（**网格线不在这张表里**：规格要求删掉水平网格线） */
const HORIZONTAL_LINE_ROLES: readonly string[] = ['threshold', 'zero']
/** 柱子允许的颜色（既有涨跌 token + 中性） */
const NET_BAR_COLORS: readonly string[] = ['var(--tw-up)', 'var(--tw-down)', 'var(--tw-flat)']
/** 图上文字只允许：数字 / 小数点 / 百分号 / 日期分隔符（任何解释文案都会在这里被抓住） */
const CHART_TEXT_SHAPE = /^[\d.:%\-/]+$/

/**
 * 主图的结构判据（**唯一实现**：页面自检与断言共用）。
 *
 * 七条对应用户口径：
 *   ① 水平网格线必须删除（只允许阈值线与柱图零轴）；
 *   ② 阈值线条数 = 上游给的阈值个数，且每条**只标数字**（带文字 ⇒ 违规）；
 *   ③ 图上任何文字都不许是解释文案（只能是数字 / 百分比 / 日期）；
 *   ④ 双轴都在（左轴 0–100 标出 0 与 100；有比例线就必须有右轴百分比刻度）；
 *   ⑤ 温度线与比例线各只一条；
 *   ⑥ 柱数 = 有值的交易日数（**缺值不画柱、不写 0**）、颜色只走涨跌 token、有柱必有零轴；
 *   ⑦ 坐标是有限数。
 */
export function leverageChartProblems(chart: LeverageChart, payload: LeveragePayloadDto | null): string[] {
  const bad: string[] = []
  // ⚠ 只兜底成空数组，绝不把「没有序列」读成数字 0：本文件的数值字段一律不许 0 顶替（判据见 leverageTool.test.ts ⑤）
  const hasData = (payload?.dates ?? []).length > 0

  // ① 水平网格线
  for (const line of chart.lines) {
    if (!HORIZONTAL_LINE_ROLES.includes(line.role)) {
      bad.push(`水平网格线必须删除（只允许阈值线与柱图零轴；实得 role=${JSON.stringify(line.role)}）`)
    }
    if (line.y1 !== line.y2) bad.push(`水平线两端的 y 必须相等（实得 ${line.y1} / ${line.y2}）`)
  }

  // ② 阈值线 + 只标数字
  const thresholds = [payload?.thresholds?.p80 ?? null, payload?.thresholds?.p95 ?? null].filter(finite)
  const thrLines = chart.lines.filter((l) => l.role === 'threshold')
  const thrLabels = chart.texts.filter((t) => t.role === 'threshold-label')
  if (hasData) {
    const distinct = new Set(thresholds).size
    if (thrLines.length !== distinct) bad.push(`阈值线条数必须等于上游给出的阈值个数（期望 ${distinct}，实得 ${thrLines.length}）`)
    if (thrLines.length !== thrLabels.length) bad.push(`每条阈值线只带一个标签（阈值线 ${thrLines.length} / 标签 ${thrLabels.length}）`)
    const leftTicks = chart.texts.filter((t) => t.role === 'left-tick')
    if (!leftTicks.some((t) => t.text === '0') || !leftTicks.some((t) => t.text === '100')) {
      bad.push(`左轴（温度）必须是 0–100 并标出 0 与 100（实得 ${leftTicks.map((t) => t.text).join(' / ')}）`)
    }
    // 阈值线的高度顺序 = 温度大小顺序（80 在 95 下方）
    if (thrLines.length === 2 && distinct === 2) {
      const [a, b] = thrLines
      if (thresholds[0] < thresholds[1] && !(a.y1 > b.y1)) bad.push('阈值线高度必须随温度上升（80 应在 95 下方）')
    }
  }
  for (const label of thrLabels) {
    if (!/^\d+(?:\.\d+)?$/.test(label.text)) bad.push(`阈值线只许标数字（不许带文字）：${JSON.stringify(label.text)}`)
  }

  // ③ 图上文字不许是解释文案
  for (const text of chart.texts) {
    if (!CHART_TEXT_SHAPE.test(text.text)) bad.push(`图上不许出现解释文案（只允许数字 / 百分比 / 日期）：${JSON.stringify(text.text)}`)
    if (!Number.isFinite(text.x) || !Number.isFinite(text.y)) bad.push(`文字坐标必须是有限数：${JSON.stringify(text)}`)
  }

  // ④ 双轴
  const hasRatio = chart.paths.some((p) => p.role === 'ratio')
  const rightTicks = chart.texts.filter((t) => t.role === 'right-tick')
  if (hasRatio && rightTicks.length === 0) bad.push('右轴（比例 %）刻度缺失 —— 双轴图必须两条轴都在')
  for (const tick of rightTicks) {
    if (!/^\d+(?:\.\d+)?%$/.test(tick.text)) bad.push(`右轴刻度必须是百分比：${JSON.stringify(tick.text)}`)
  }
  const hasTemp = chart.paths.some((p) => p.role === 'temp')
  if (hasTemp) {
    const leftTicks = chart.texts.filter((t) => t.role === 'left-tick')
    if (leftTicks.length === 0) bad.push('左轴（温度）刻度缺失')
  }

  // ⑤ 两条线各一条
  for (const role of ['temp', 'ratio'] as const) {
    if (chart.paths.filter((p) => p.role === role).length > 1) bad.push(`序列 ${role} 只允许一条线`)
  }

  // ⑥ 柱：数量与颜色与零轴
  const netValues = (payload?.net ?? []).filter(finite)
  if (hasData && chart.bars.length !== netValues.length) {
    bad.push(`底部柱的数量必须等于「有值的交易日数」（缺值不画柱；期望 ${netValues.length}，实得 ${chart.bars.length}）`)
  }
  for (const bar of chart.bars) {
    if (bar.role !== 'net') bad.push(`柱图只画当日融资净买入（实得 role=${JSON.stringify(bar.role)}）`)
    if (!NET_BAR_COLORS.includes(bar.color)) bad.push(`柱色必须走既有涨跌 token（实得 ${JSON.stringify(bar.color)}）`)
    if (!(bar.w > 0) || !(bar.h >= 0)) bad.push(`柱的宽必须为正、高必须非负（实得 ${bar.w} / ${bar.h}）`)
    if (!Number.isFinite(bar.x) || !Number.isFinite(bar.y)) bad.push(`柱坐标必须是有限数：${JSON.stringify(bar)}`)
  }
  const zeroLines = chart.lines.filter((l) => l.role === 'zero')
  if (chart.bars.length > 0 && zeroLines.length !== 1) bad.push(`有柱时必须有且只有一条零轴（实得 ${zeroLines.length}）`)
  if (chart.bars.length === 0 && zeroLines.length > 0) bad.push('没有柱时不许画零轴（那一格没有数据）')

  // ⑦ 线段坐标
  for (const line of chart.lines) {
    if (![line.x1, line.y1, line.x2, line.y2].every((n) => Number.isFinite(n))) bad.push(`线段坐标必须是有限数：${JSON.stringify(line)}`)
  }
  return bad
}
