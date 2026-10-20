/**
 * 工具②「杠杆温度计」的**视图模型**（纯函数，无 React 依赖 ⇒ `node:test` 可直接读）。
 *
 * 职责边界（与工具①同一套分工）：
 *   · 宿主负责口径与计算（温度分位、比例、净买入、序列）—— 客户端**不重算**任何指标；
 *   · 这里只把载荷渲染成页面模型（数字格式化、缺值 → `—`、绘图几何），页面只渲染模型；
 *   · 页面（`leveragePage.tsx`）里不算数、不造数、不写第二份占位文案。
 *
 * 用户口径（R2 修订后，逐条对应页面规格）：
 *   ① 大字 = 温度（1 位小数）+ `/ 100`；**页面上唯一的说明文字**是 `截至 YYYY-MM-DD`（来自 `asOf`；
 *      `asOf` 为空串 ⇒ **只给 `—`，连「截至」二字都不出现**）；
 *   ② 三张摘要卡：显性融资（`ratioPct`，2 位小数 %）、杠杆率（`ratioWithShortPct`，2 位小数 %）、
 *      当日融资净买入（`netBuy`，元 → 亿/万亿、2 位小数、带正负号）；**不要第四张**；
 *   ③ 主图：**双轴**（左 = 温度 0–100，右 = 比例 %）+ 两条线（温度 / 显性融资比例）
 *      + 阈值线 80 / 95（**右端彩色胶囊**只标数字，**不压左轴刻度**）
 *      + **水平网格线**（每 25 一个温度刻度、浅色虚线、不标文字）
 *      + **X 轴 ≥ 6 个等距刻度**（按窗口自动选月 / 季度 / 半年 / 年）+ **柱区独立小轴**；
 *   ④ 底部柱 = 当日融资净买入，正涨负跌（跟随既有涨跌 token，不硬编码色值），**缺值就不画柱**；
 *   ⑤ 悬停：**一个紧凑读数框**（该日 温度 / 显性融资比例 / 净买入 三个数），**没有十字光标、没有解释文字**；
 *   ⑥ 窗口三档 = `range=250 / 750 / all`，**只换查询参数**（不新增接口）；
 *   ⑦ 缺失一律 `—`（破折号）：不加文字、不进悬停、不写 0 顶替。
 *
 * 为什么绘图几何也放在这里：图的**结构**（哪条线是阈值、有没有网格、柱子的颜色、刻度有几个）是可断言的量。
 * 做成纯数据后，断言直接对模型跑判据（`leverageChartProblems` / `leveragePlotHeightProblems`），
 * 不必靠正则捞 JSX。
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

/**
 * 主图高度契约（R2 修订：用户口径"绘图区约占整页 55–60%"⇒ 从 `clamp(280px,26vh,380px)` 提到这一档）。
 *
 * 为什么**不**复用 `PLOT.heightCss`：那是工具箱通用详情页的契约（280–380px，`toolDetailTheme.test.ts`
 * 与 `toolsPage.test.ts` 都钉着它），改它会把蛋糕工具一起改掉。本工具的主图是**单图独占一屏**的形态，
 * 因此另立一条契约；判据见 `leveragePlotHeightProblems`（视口比例 ≥ 50vh、像素上限 ≥ 480px）。
 */
export const LEVERAGE_PLOT_HEIGHT = 'min(58vh, 520px)'

/** 主图在参考视口下的**有效高度下限**（px）：低于它就算"占屏比不够" */
export const LEVERAGE_HEIGHT_MIN_PX = 480

/** 判据用的参考视口高度（px）：1080p 屏减去浏览器 chrome 后的常见可视高度 */
export const LEVERAGE_REFERENCE_VIEWPORT_PX = 900

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

/** 唯一的说明文字前缀（**只写一次**：格式化与判据都从这里拼，避免"两处各写一遍"） */
const ASOF_PREFIX = '截至'

/**
 * `截至 YYYY-MM-DD`（**页面上唯一的说明文字**，现在显示在温度卡的小字里）。
 * ⚠ `asOf` 为空串 = 整块不可用（宿主约定）⇒ **只给 `—`**：一个没有日期的时间标记既不是读数也不是时间。
 */
export function leverageAsOfText(payload: LeveragePayloadDto | null): string {
  const day = payload === null ? '' : String(payload.asOf ?? '').trim()
  return day === '' ? DASH : `${ASOF_PREFIX} ${day}`
}

/**
 * 余额/市值类金额（元 → 亿 / 万亿，2 位小数，**不带正负号**）。
 * 余额与市值没有"方向"，加 `+` 反而会被读成涨跌；缺 ⇒ `—`。
 */
export function fmtAmountYi(v: number | null | undefined): string {
  if (!finite(v)) return DASH
  const unit = Math.abs(v) >= 1e12 ? { div: 1e12, name: '万亿' } : { div: 1e8, name: '亿' }
  return `${(v / unit.div).toFixed(2)} ${unit.name}`
}

/**
 * **窗口累计净买入**（元）：把当前窗口的 `net` 求和。
 *
 * ⚠ 口径（用户明确要求）：窗口内**只要有一个 `null` ⇒ 返回 `null`**（界面显示 `—`），
 * 绝不"跳过缺的那天照算" —— 静默少算会让"累计"变成一个无法解释的数。
 * 空窗口同样 `null`（不写 0）。
 */
export function windowNetSum(payload: LeveragePayloadDto | null): number | null {
  if (payload === null) return null
  const nets = payload.net ?? []
  if (nets.length === 0) return null
  let sum = 0
  for (const v of nets) {
    if (!finite(v)) return null
    sum += v
  }
  return sum
}

/**
 * 卡片模型（**两行 × 四列，共 8 张**，顺序即渲染顺序；值全部来自载荷，缺 ⇒ `—`）。
 *
 * 第一行：温度（原大字搬进卡片，带 `/ 100` 后缀与 `截至 …` 小字）/ 显性融资 / 杠杆率 / 当日融资净买入
 * 第二行：融资余额 / 融券余额 / 流通市值 / 窗口累计净买入
 *
 * `suffix` 与 `note` **只有温度卡有**：其余卡片的说明文字一律为空（页面规格：不加字）。
 */
/** 八张卡的键与标签（**唯一来源**：页面渲染与断言都从这里取；顺序 = 两行 × 四列的从左到右） */
export const LEVERAGE_CARD_KEYS = ['temperature', 'ratio', 'leverage', 'net', 'margin', 'short', 'float', 'windowNet'] as const
export const LEVERAGE_CARD_LABELS = ['温度', '显性融资', '杠杆率', '当日融资净买入', '融资余额', '融券余额', '流通市值', '窗口累计净买入'] as const

export interface LeverageCard {
  key: (typeof LEVERAGE_CARD_KEYS)[number]
  label: string
  value: string
  suffix?: string
  note?: string
}

export function leverageCards(payload: LeveragePayloadDto | null): LeverageCard[] {
  return [
    // 第一行
    { key: 'temperature', label: '温度', value: fmtTemperature(payload?.temperature ?? null), suffix: '/ 100', note: leverageAsOfText(payload) },
    { key: 'ratio', label: '显性融资', value: fmtRatioPct(payload?.ratioPct ?? null) },
    { key: 'leverage', label: '杠杆率', value: fmtRatioPct(payload?.ratioWithShortPct ?? null) },
    { key: 'net', label: '当日融资净买入', value: fmtNetYi(payload?.netBuy ?? null) },
    // 第二行
    { key: 'margin', label: '融资余额', value: fmtAmountYi(payload?.marginBalance ?? null) },
    { key: 'short', label: '融券余额', value: fmtAmountYi(payload?.shortBalance ?? null) },
    { key: 'float', label: '流通市值', value: fmtAmountYi(payload?.floatMv ?? null) },
    { key: 'windowNet', label: '窗口累计净买入', value: fmtNetYi(windowNetSum(payload)) },
  ]
}

/* ────────────────────────────── 2. 图例与配色 ────────────────────────────── */

export interface LeverageLegendItem {
  name: string
  color: string
}

/**
 * 三条序列的颜色（**唯一来源**：图例、画出来的线、悬停读数框的色标取同一份；全部走主题 token）。
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
 * 隐身视图会把两者都转灰阶）。具体色相由主题决定，本工具只认语义。
 */
export function netBarColor(v: number | null | undefined): string {
  if (!finite(v) || v === 0) return 'var(--tw-flat)'
  return v > 0 ? 'var(--tw-up)' : 'var(--tw-down)'
}

/** 阈值胶囊的填充色（两档阈值各一色，走语义色阶 token，**不跟涨跌翻转**） */
const THRESHOLD_FILL: readonly string[] = ['var(--tw-imp-2)', 'var(--tw-imp-3)']

/* ────────────────────────────── 3. 绘图区几何与模型 ────────────────────────────── */

/** 折线区占绘图区高度的比例（剩下的是底部柱图带） */
const LINE_SHARE = 0.78
/** 折线区与柱图带之间的空隙（px；落在 1px 刻度上） */
const BAND_GAP = 8
/** 柱宽下限 / 上限（px）：单日柱远小于 1px 时连成一片面积；窗口很短时也不许粗到失真 */
const BAR_MIN_W = 0.6
const BAR_MAX_W = 6
/**
 * 左内边距（px）：要同时放下温度刻度（0/50/100）与柱区独立轴（最长 `+1074.85 亿`）。
 * 12px 字号实测：`+1074.85 亿` ≈ 66px ⇒ 取 74 = 66px 文本 + 6px 间隙 + 2px 余量
 * （小字号下 `+1074.85 亿` 就是最长形态；再宽会被 SVG 视口裁掉左侧几个像素）。
 */
const AXIS_LEFT = 74
/** 阈值胶囊尺寸（px）与右端留白 */
const CAPSULE_W = 26
const CAPSULE_H = 16
const CAPSULE_INSET = 2
/** 水平网格线覆盖的温度刻度（每 25 一格；不标文字） */
const GRID_TEMPS: readonly number[] = [0, 25, 50, 75, 100]

/** 水平线：`grid`（浅色网格）/ `threshold`（阈值虚线）/ `zero`（柱图零轴） */
export interface LeverageChartLine {
  role: 'grid' | 'threshold' | 'zero'
  x1: number
  y1: number
  x2: number
  y2: number
  dash: boolean
  color: string
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

/** 阈值胶囊（右端彩色小药丸；线上那个数字就写在它里面） */
export interface LeverageChartCapsule {
  role: 'threshold-capsule'
  x: number
  y: number
  w: number
  h: number
  fill: string
}

/**
 * 图上文字（**只允许刻度/读数**，任何解释文案都会被判据拒掉）：
 *   · `left-tick` 温度刻度（0/50/100）· `right-tick` 比例刻度（x.xx%）
 *   · `threshold-label` 阈值数字（写在胶囊里）· `x-tick` 日期刻度（YYYY-MM）
 *   · `bar-max` / `bar-min` 柱区独立轴的上下界
 */
export interface LeverageChartText {
  role: 'left-tick' | 'right-tick' | 'threshold-label' | 'x-tick' | 'bar-max' | 'bar-min'
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
  capsules: LeverageChartCapsule[]
  texts: LeverageChartText[]
}

/** 阈值只标数字：整数直出，非整数给 1 位小数（`80` / `95`） */
function thresholdText(v: number): string {
  return Number.isInteger(v) ? String(v) : v.toFixed(1)
}

/** 日期 → 月份序号（`YYYY-MM` ⇒ y*12+m-1）；认不出 ⇒ null（不猜） */
function monthIndexOf(day: string): number | null {
  const m = /^(\d{4})-(\d{2})/.exec(String(day))
  if (m === null) return null
  return Number(m[1]) * 12 + (Number(m[2]) - 1)
}

/**
 * X 轴刻度的**个数**（图 1 的结构特征：≥ 6 个、视觉上严格等距）。
 *
 * 随窗口变：一年 7 个（≈ 两个月一格）/ 三年 8 个（≈ 一个季度一格）/ 全历史 9 个（≈ 两年一格）
 * —— "步长"因此自然落成 **月 / 季度 / 年**。刻度线位置在 `leverageChart` 里按 `left + j*inner/(n-1)`
 * **精确等分**（不吸附到数据点：轴标签不需要落在某一天的像素上，但要看起来等距）；
 * 每个刻度取**最近的那一天**做标签（`YYYY-MM`，月份精度，不写日）。
 */
export function xTickCount(count: number): number {
  if (count <= 0) return 0
  return Math.min(count, count <= 320 ? 7 : count <= 900 ? 8 : 9)
}

/** 第 i 天的 x（**唯一实现**：主图与悬停取点共用；`count === 1` 时贴左内边距） */
export function leverageXAt(i: number, count: number, width: number): number {
  const W = Math.max(240, Math.round(width))
  const left = AXIS_LEFT
  const right = W - PLOT.pad.right
  const inner = Math.max(1, right - left)
  return count <= 1 ? left : left + (i * inner) / (count - 1)
}

/**
 * 悬停取点（纯函数）：指针在卡片内的 x ⇒ 最近的数据点下标；**在有效绘图带之外返回 null**
 * （不硬凑一个点）。容差 20px（与既有折线图的 `hoverBand` 同量级）。
 */
export function leverageIndexAt(px: number, count: number, width: number): number | null {
  if (count <= 0) return null
  if (count === 1) return 0
  const W = Math.max(240, Math.round(width))
  const left = AXIS_LEFT
  const right = W - PLOT.pad.right
  if (right <= left) return null
  if (px < left - 20 || px > right + 20) return null
  const t = (px - left) / (right - left)
  return Math.min(count - 1, Math.max(0, Math.round(t * (count - 1))))
}

/**
 * 主图模型（**纯函数**：给定载荷与画布像素 ⇒ 要画的一切）。
 *
 * 几何：高度由页面按 `LEVERAGE_PLOT_HEIGHT` 量出来（实测像素），内边距沿用 `PLOT` 的上下右三项，
 * 左侧加宽到 `AXIS_LEFT`（温度刻度 + 柱区独立轴都要放得下）。
 *
 * 空数据（没有日期）⇒ 返回空模型：一个刻度、一条线都不画（**不写"未取到"之类的文字**）。
 */
export function leverageChart(payload: LeveragePayloadDto | null, width: number, height: number): LeverageChart {
  const W = Math.max(240, Math.round(width))
  const H = Math.max(320, Math.round(height))
  const left = AXIS_LEFT
  const right = W - PLOT.pad.right
  const top = PLOT.pad.top
  const bottom = H - PLOT.pad.bottom
  const empty: LeverageChart = { width: W, height: H, lines: [], paths: [], bars: [], capsules: [], texts: [] }
  const dates = payload?.dates ?? []
  const count = dates.length
  if (payload === null || count === 0 || right <= left) return empty

  const inner = right - left
  const bandH = Math.max(24, bottom - top)
  const lineH = Math.max(24, Math.round(bandH * LINE_SHARE))
  const lineBottom = top + lineH
  const barTop = Math.min(lineBottom + BAND_GAP, Math.max(top + 24, bottom - 12))
  const barH = Math.max(1, bottom - barTop)

  const xOf = (i: number): number => leverageXAt(i, count, W)
  /** 温度轴：**固定 0–100**（规格：左轴 0–100） */
  const yTemp = (v: number): number => top + (1 - Math.max(0, Math.min(100, v)) / 100) * lineH

  const lines: LeverageChartLine[] = []
  const paths: LeverageChartPath[] = []
  const bars: LeverageChartBar[] = []
  const capsules: LeverageChartCapsule[] = []
  const texts: LeverageChartText[] = []

  /* ── 水平网格线：每 25 一个温度刻度、浅色虚线、**不标文字** ───────────────── */
  for (const t of GRID_TEMPS) {
    const y = yTemp(t)
    lines.push({ role: 'grid', x1: left, y1: y, x2: right, y2: y, dash: true, color: 'var(--tw-border)' })
  }

  /* ── 两条线：温度（左轴）+ 显性融资比例（右轴）────────────────────────────── */
  const tempPath = pathOf(payload.temp ?? [], xOf, yTemp)
  if (tempPath !== '') paths.push({ role: 'temp', d: tempPath, color: SERIES_COLOR.temp })

  const ratioValues = payload.ratio ?? []
  const ratioVals = ratioValues.filter(finite)
  if (ratioVals.length > 0) {
    // 右轴取值域由数据决定（比例常年在 2–3%，从 0 起点会把整条线压成一条平线）；上下各留 12% 余量
    const mn = Math.min(...ratioVals)
    const mx = Math.max(...ratioVals)
    const span = mx - mn
    const pad = span > 0 ? span * 0.12 : Math.max(0.05, Math.abs(mx) * 0.05 || 0.05)
    // ⚠ 下限夹到 0：显性融资比例不可能是负数（`all` 窗口最小值是 2010 年的 0.00%，
    //   直接减余量会让右轴冒出 `-0.56%` 这种没有意义的刻度）
    const lo = Math.max(0, mn - pad)
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

  /* ── 底部柱：当日融资净买入（缺值不画柱）+ 自己的 ± 小轴 ──────────────────── */
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
    // 柱宽自适应：窗口长 ⇒ 细到亚像素（连成面积），窗口短 ⇒ 最粗 6px
    const bw = Math.min(BAR_MAX_W, Math.max(BAR_MIN_W, (inner / Math.max(1, count)) * 0.66))
    for (let i = 0; i < nets.length; i += 1) {
      const v = nets[i]
      if (!finite(v)) continue
      const cx = xOf(i)
      const x = Math.min(Math.max(left, cx - bw / 2), Math.max(left, right - bw))
      const yTop = Math.min(yZero, yNet(v))
      bars.push({ role: 'net', x, y: yTop, w: bw, h: Math.abs(yNet(v) - yZero), color: netBarColor(v) })
    }
    // 柱图零轴（唯一那条实线水平线）：有柱才画
    lines.push({ role: 'zero', x1: left, y1: yZero, x2: right, y2: yZero, dash: false, color: 'var(--tw-border-strong)' })
    // 柱区独立小轴：只在零轴两侧给最大 / 最小值（不画网格、不标刻度线）
    texts.push({ role: 'bar-max', x: left - 6, y: barTop + 10, text: fmtNetYi(netHi), anchor: 'end' })
    texts.push({ role: 'bar-min', x: left - 6, y: bottom - 1, text: fmtNetYi(netLo), anchor: 'end' })
  }

  /* ── 阈值线 80 / 95 + **右端彩色胶囊**（只标数字，不压左轴刻度）────────────── */
  const thresholds = [payload.thresholds?.p80 ?? null, payload.thresholds?.p95 ?? null].filter(finite)
  const seen = new Set<number>()
  let fillIndex = 0
  for (const t of thresholds) {
    if (seen.has(t)) continue // 两档阈值相等 ⇒ 只画一条（不叠线、不叠字）
    seen.add(t)
    const y = yTemp(t)
    const fill = THRESHOLD_FILL[fillIndex % THRESHOLD_FILL.length] as string
    fillIndex += 1
    lines.push({ role: 'threshold', x1: left, y1: y, x2: right, y2: y, dash: true, color: fill })
    const capX = right - CAPSULE_W - CAPSULE_INSET
    capsules.push({ role: 'threshold-capsule', x: capX, y: y - CAPSULE_H / 2, w: CAPSULE_W, h: CAPSULE_H, fill })
    texts.push({ role: 'threshold-label', x: capX + CAPSULE_W / 2, y: y + 3.5, text: thresholdText(t), anchor: 'middle' })
  }

  /* ── X 轴：≥ 6 个**精确等分**的刻度（标签取最近某一天的年月）──────────────── */
  const tickCount = xTickCount(count)
  for (let j = 0; j < tickCount; j += 1) {
    const x = tickCount <= 1 ? left : left + (j * inner) / (tickCount - 1)
    const idx = tickCount <= 1 ? 0 : Math.round((j * (count - 1)) / (tickCount - 1))
    const day = String(dates[Math.min(count - 1, Math.max(0, idx))] ?? '')
    const label = monthIndexOf(day) === null ? day : day.slice(0, 7)
    texts.push({
      role: 'x-tick',
      x,
      y: H - 6,
      text: label,
      anchor: j === 0 ? 'start' : j === tickCount - 1 ? 'end' : 'middle',
    })
  }

  return { width: W, height: H, lines, paths, bars, capsules, texts }
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

/* ────────────────────────────── 3b. 悬停读数框（图 1 左上角那个） ────────────────────────────── */

export interface LeverageReadoutRow {
  name: string
  text: string
  color: string
}

export interface LeverageReadout {
  day: string
  rows: LeverageReadoutRow[]
}

/**
 * 悬停读数（**紧凑**：该日的 温度 / 显性融资比例 / 净买入 三个数，行名取自图例 ⇒ 不新增文案）。
 *
 * 缺值仍是 `—`；`index` 越界则夹到端点。**没有**阈值差、没有解释句（用户口径：无解释文字）。
 */
export function leverageReadout(payload: LeveragePayloadDto | null, index: number): LeverageReadout | null {
  if (payload === null) return null
  const count = (payload.dates ?? []).length
  if (count === 0) return null
  const i = Math.max(0, Math.min(count - 1, Math.round(index)))
  const day = String(payload.dates[i] ?? '')
  if (day === '') return null
  return {
    day,
    rows: [
      { name: '温度', text: fmtTemperature(payload.temp?.[i] ?? null), color: SERIES_COLOR.temp },
      { name: '显性融资比例', text: fmtRatioPct(payload.ratio?.[i] ?? null), color: SERIES_COLOR.ratio },
      { name: '净买入', text: fmtNetYi(payload.net?.[i] ?? null), color: SERIES_COLOR.net },
    ],
  }
}

/* ────────────────────────────── 4. 结构判据（唯一实现） ────────────────────────────── */

/** 主图高度契约的解析结果（判据与断言共用） */
interface HeightContract {
  vh: number | null
  pxCap: number | null
  fixedPx: number | null
}

function parseHeightContract(css: unknown): HeightContract | null {
  const text = typeof css === 'string' ? css.trim() : ''
  if (text === '') return null
  const min = /^min\(\s*([\d.]+)vh\s*,\s*([\d.]+)px\s*\)$/.exec(text)
  if (min !== null) return { vh: Number(min[1]), pxCap: Number(min[2]), fixedPx: null }
  const clamp = /^clamp\(\s*([\d.]+)px\s*,\s*([\d.]+)vh\s*,\s*([\d.]+)px\s*\)$/.exec(text)
  if (clamp !== null) return { vh: Number(clamp[2]), pxCap: Number(clamp[3]), fixedPx: null }
  const fixed = /^([\d.]+)px$/.exec(text)
  if (fixed !== null) return { vh: null, pxCap: null, fixedPx: Number(fixed[1]) }
  return null
}

/**
 * 主图高度判据（R2 ①）：图 1 的绘图区约占整页 **55–60%** ⇒
 *   · 必须带**视口比例**（`vh`）且系数 ≥ 50；
 *   · 像素上限 ≥ `LEVERAGE_HEIGHT_MIN_PX`（480）；
 *   · 在参考视口（900px）下的**有效高度** ≥ 480px；
 *   · **写死像素**一律拒（既不随视口变化，也远低于口径）。
 */
export function leveragePlotHeightProblems(css: unknown, referenceViewport = LEVERAGE_REFERENCE_VIEWPORT_PX): string[] {
  const bad: string[] = []
  const c = parseHeightContract(css)
  if (c === null) {
    bad.push(`主图高度必须写成 min(<vh>vh, <px>px) 或 clamp(...)（实得 ${JSON.stringify(css)}）`)
    return bad
  }
  if (c.fixedPx !== null) {
    bad.push(`主图高度不许写死像素（实得 ${c.fixedPx}px）：不随视口变化，也达不到"占整页 55–60%"`)
    if (c.fixedPx < LEVERAGE_HEIGHT_MIN_PX) bad.push(`主图高度 ${c.fixedPx}px 低于下限 ${LEVERAGE_HEIGHT_MIN_PX}px`)
    return bad
  }
  const vh = c.vh ?? 0
  const cap = c.pxCap ?? 0
  if (!(vh >= 50)) bad.push(`主图高度的视口比例必须 ≥ 50vh（实得 ${vh}vh）`)
  if (!(cap >= LEVERAGE_HEIGHT_MIN_PX)) bad.push(`主图高度的像素上限必须 ≥ ${LEVERAGE_HEIGHT_MIN_PX}px（实得 ${cap}px）`)
  const effective = Math.min((vh / 100) * referenceViewport, cap)
  if (!(effective >= LEVERAGE_HEIGHT_MIN_PX)) {
    bad.push(`主图在 ${referenceViewport}px 高的视口下只有 ${Math.round(effective)}px，低于下限 ${LEVERAGE_HEIGHT_MIN_PX}px`)
  }
  return bad
}

/** 允许出现的水平线角色（网格 / 阈值 / 零轴 —— **没有"随便画一条"这一档**） */
const HORIZONTAL_LINE_ROLES: readonly string[] = ['grid', 'threshold', 'zero']
/** 柱子允许的颜色（既有涨跌 token + 中性） */
const NET_BAR_COLORS: readonly string[] = ['var(--tw-up)', 'var(--tw-down)', 'var(--tw-flat)']
/** 每个角色允许的文字形态（**任何解释文案都在这里被拒**） */
const TEXT_SHAPES: Record<LeverageChartText['role'], RegExp> = {
  'left-tick': /^\d+(?:\.\d+)?$/,
  'right-tick': /^\d+(?:\.\d+)?%$/,
  'threshold-label': /^\d+(?:\.\d+)?$/,
  'x-tick': /^[\d\-/]+$/,
  'bar-max': /^[+-]?\d+\.\d{2} (?:亿|万亿)$/,
  'bar-min': /^[+-]?\d+\.\d{2} (?:亿|万亿)$/,
}

/**
 * 主图的结构判据（**唯一实现**：断言直接跑它）。
 *
 * 七条对应 R2 修订后的用户口径：
 *   ① 水平网格线**必须在**（每 25 一个温度刻度、浅色虚线、**不标文字**）；
 *   ② 阈值线条数 = 上游给的阈值个数；每条**只标数字**，且数字写在**右端胶囊**里（胶囊必须在右缘、不许压左轴刻度）；
 *   ③ 图上文字只有刻度 / 读数六种角色，形态逐角色校验（解释文案一律拒）；
 *   ④ 双轴都在（左轴 0–100 标出 0 与 100；有比例线就必须有右轴百分比刻度）；
 *   ⑤ X 轴刻度 ≥ min(6, 数据天数)（图 1 的多刻度；只剩首末两个 ⇒ 违规）；
 *   ⑥ 柱数 = 有值的交易日数（**缺值不画柱、不写 0**）、颜色只走涨跌 token、有柱必有零轴 + 柱区独立小轴；
 *   ⑦ 坐标是有限数；温度线与比例线各只一条。
 */
export function leverageChartProblems(chart: LeverageChart, payload: LeveragePayloadDto | null): string[] {
  const bad: string[] = []
  // ⚠ 只兜底成空数组，绝不把「没有序列」读成数字 0：本文件的数值字段一律不许 0 顶替（判据见 leverageTool.test.ts ⑤）
  const dates = payload?.dates ?? []
  const count = dates.length
  const hasData = count > 0
  const W = Math.max(240, Math.round(chart.width))
  const left = AXIS_LEFT
  const right = W - PLOT.pad.right

  // ① 水平线角色 + 网格线必须在
  for (const line of chart.lines) {
    if (!HORIZONTAL_LINE_ROLES.includes(line.role)) {
      bad.push(`水平线只允许网格 / 阈值 / 零轴三种（实得 role=${JSON.stringify(line.role)}）`)
    }
    if (line.y1 !== line.y2) bad.push(`水平线两端的 y 必须相等（实得 ${line.y1} / ${line.y2}）`)
  }
  const gridLines = chart.lines.filter((l) => l.role === 'grid')
  if (hasData) {
    if (gridLines.length !== GRID_TEMPS.length) bad.push(`水平网格线必须每 25 一个温度刻度（期望 ${GRID_TEMPS.length} 条，实得 ${gridLines.length}）`)
    for (const g of gridLines) if (!g.dash) bad.push('水平网格线必须是浅色虚线')
  }

  // ② 阈值线 + 右端胶囊
  const thresholds = [payload?.thresholds?.p80 ?? null, payload?.thresholds?.p95 ?? null].filter(finite)
  const distinct = [...new Set(thresholds)]
  const thrLines = chart.lines.filter((l) => l.role === 'threshold')
  const thrLabels = chart.texts.filter((t) => t.role === 'threshold-label')
  const capsules = chart.capsules.filter((c) => c.role === 'threshold-capsule')
  if (hasData) {
    if (thrLines.length !== distinct.length) bad.push(`阈值线条数必须等于上游给出的阈值个数（期望 ${distinct.length}，实得 ${thrLines.length}）`)
    if (capsules.length !== thrLines.length) bad.push(`每条阈值线必须恰好一个胶囊（阈值线 ${thrLines.length} / 胶囊 ${capsules.length}）`)
    if (thrLabels.length !== thrLines.length) bad.push(`每条阈值线只带一个数字标签（阈值线 ${thrLines.length} / 标签 ${thrLabels.length}）`)
  }
  for (const cap of capsules) {
    if (!(cap.x + cap.w >= right - 4)) bad.push(`阈值胶囊必须贴在右端（右缘对齐绘图区；实得 x+w=${Math.round(cap.x + cap.w)} / 右缘=${right}）`)
    if (!(cap.x >= left + 100)) bad.push(`阈值胶囊不许贴在左轴旁（会与 0/50/100 刻度叠字；实得 x=${Math.round(cap.x)}）`)
    if (!THRESHOLD_FILL.includes(cap.fill)) bad.push(`阈值胶囊必须走语义色阶 token（实得 ${JSON.stringify(cap.fill)}）`)
    if (!(cap.w > 0) || !(cap.h > 0)) bad.push('阈值胶囊的宽高必须为正')
  }
  for (const label of thrLabels) {
    if (!/^\d+(?:\.\d+)?$/.test(label.text)) bad.push(`阈值线只许标数字（不许带文字）：${JSON.stringify(label.text)}`)
    const host = capsules.find((c) => label.y >= c.y && label.y <= c.y + c.h && label.x >= c.x && label.x <= c.x + c.w)
    if (host === undefined) bad.push(`阈值数字必须写在胶囊里（实得 label@${Math.round(label.x)},${Math.round(label.y)}）`)
  }
  // 阈值线的高度顺序 = 温度大小顺序（80 在 95 下方）
  if (thrLines.length === 2 && distinct.length === 2) {
    const [a, b] = thrLines
    if ((distinct[0] as number) < (distinct[1] as number) && !((a as LeverageChartLine).y1 > (b as LeverageChartLine).y1)) {
      bad.push('阈值线高度必须随温度上升（80 应在 95 下方）')
    }
  }

  // ③ 文字：六种角色 + 形态
  for (const text of chart.texts) {
    const shape = TEXT_SHAPES[text.role]
    if (shape === undefined) bad.push(`图上文字只允许刻度/读数六种角色（实得 ${JSON.stringify(text.role)}）`)
    else if (!shape.test(text.text)) bad.push(`图上不许出现解释文案（${text.role} 的形态不符）：${JSON.stringify(text.text)}`)
    if (!Number.isFinite(text.x) || !Number.isFinite(text.y)) bad.push(`文字坐标必须是有限数：${JSON.stringify(text)}`)
  }

  // ④ 双轴
  const hasRatio = chart.paths.some((p) => p.role === 'ratio')
  const rightTicks = chart.texts.filter((t) => t.role === 'right-tick')
  if (hasRatio && rightTicks.length === 0) bad.push('右轴（比例 %）刻度缺失 —— 双轴图必须两条轴都在')
  const hasTemp = chart.paths.some((p) => p.role === 'temp')
  if (hasTemp) {
    const leftTicks = chart.texts.filter((t) => t.role === 'left-tick')
    if (!leftTicks.some((t) => t.text === '0') || !leftTicks.some((t) => t.text === '100')) {
      bad.push(`左轴（温度）必须是 0–100 并标出 0 与 100（实得 ${leftTicks.map((t) => t.text).join(' / ')}）`)
    }
  }

  // ⑤ X 轴刻度数量
  const xTicks = chart.texts.filter((t) => t.role === 'x-tick')
  const wantX = Math.min(6, count)
  if (hasData && xTicks.length < wantX) bad.push(`X 轴刻度必须 ≥ ${wantX} 个（图 1 的结构特征；实得 ${xTicks.length}）`)
  if (xTicks.length > 10) bad.push(`X 轴刻度不许挤到 10 个以上（实得 ${xTicks.length}）`)
  for (let i = 1; i < xTicks.length; i += 1) {
    if (!((xTicks[i] as LeverageChartText).x > (xTicks[i - 1] as LeverageChartText).x)) bad.push('X 轴刻度必须按时间递增')
  }

  // ⑥ 柱：数量 / 颜色 / 零轴 / 独立小轴
  const netValues = (payload?.net ?? []).filter(finite)
  if (hasData && chart.bars.length !== netValues.length) {
    bad.push(`底部柱的数量必须等于「有值的交易日数」（缺值不画柱；期望 ${netValues.length}，实得 ${chart.bars.length}）`)
  }
  for (const bar of chart.bars) {
    if (bar.role !== 'net') bad.push(`柱图只画当日融资净买入（实得 role=${JSON.stringify(bar.role)}）`)
    if (!NET_BAR_COLORS.includes(bar.color)) bad.push(`柱色必须走既有涨跌 token（实得 ${JSON.stringify(bar.color)}）`)
    if (!(bar.w > 0) || !(bar.h >= 0)) bad.push(`柱的宽必须为正、高必须非负（实得 ${bar.w} / ${bar.h}）`)
    if (!(bar.w <= BAR_MAX_W + 0.01)) bad.push(`柱宽必须自适应（上限 ${BAR_MAX_W}px；实得 ${bar.w}）`)
    if (!Number.isFinite(bar.x) || !Number.isFinite(bar.y)) bad.push(`柱坐标必须是有限数：${JSON.stringify(bar)}`)
  }
  const zeroLines = chart.lines.filter((l) => l.role === 'zero')
  const barMax = chart.texts.filter((t) => t.role === 'bar-max')
  const barMin = chart.texts.filter((t) => t.role === 'bar-min')
  if (chart.bars.length > 0) {
    if (zeroLines.length !== 1) bad.push(`有柱时必须有且只有一条零轴（实得 ${zeroLines.length}）`)
    if (barMax.length !== 1 || barMin.length !== 1) bad.push(`柱区必须有独立的 ± 小轴（上下界各一个数字；实得 ${barMax.length}/${barMin.length}）`)
  } else {
    if (zeroLines.length > 0) bad.push('没有柱时不许画零轴（那一格没有数据）')
    if (barMax.length > 0 || barMin.length > 0) bad.push('没有柱时不许画柱区小轴')
  }

  // ⑦ 两条线各一条 + 线段坐标
  for (const role of ['temp', 'ratio'] as const) {
    if (chart.paths.filter((p) => p.role === role).length > 1) bad.push(`序列 ${role} 只允许一条线`)
  }
  for (const line of chart.lines) {
    if (![line.x1, line.y1, line.x2, line.y2].every((n) => Number.isFinite(n))) bad.push(`线段坐标必须是有限数：${JSON.stringify(line)}`)
  }
  return bad
}

/* ────────────────────────────── 4b. 卡片行判据（唯一实现） ────────────────────────────── */

/** 每个卡片槽位允许的**数值形态**（第 0 张温度、1–2 比例、3/7 带符号金额、4–6 金额） */
const CARD_VALUE_SHAPES: readonly RegExp[] = [
  /^(?:\d+\.\d|—)$/, // 0 温度：1 位小数
  /^(?:\d+\.\d{2}%|—)$/, // 1 显性融资
  /^(?:\d+\.\d{2}%|—)$/, // 2 杠杆率
  /^(?:[+-]?\d+\.\d{2} (?:亿|万亿)|—)$/, // 3 当日融资净买入（带符号）
  /^(?:\d+\.\d{2} (?:亿|万亿)|—)$/, // 4 融资余额
  /^(?:\d+\.\d{2} (?:亿|万亿)|—)$/, // 5 融券余额
  /^(?:\d+\.\d{2} (?:亿|万亿)|—)$/, // 6 流通市值
  /^(?:[+-]?\d+\.\d{2} (?:亿|万亿)|—)$/, // 7 窗口累计净买入（带符号）
]

/** 温度卡小字只允许「前缀 + YYYY-MM-DD」或 `—`（前缀从 `ASOF_PREFIX` 拼，不写第二份） */
const CARD_NOTE_SHAPE = new RegExp(`^(?:${ASOF_PREFIX} \\d{4}-\\d{2}-\\d{2}|—)$`)

/**
 * 卡片行判据（**唯一实现**）：两行 × 四列共 8 张、顺序与标签逐字、只有温度卡带后缀/小字、
 * 每个槽位的数值形态固定（任何解释文案都会被这里拒掉）。
 */
export function leverageCardsProblems(cards: readonly LeverageCard[]): string[] {
  const bad: string[] = []
  if (cards.length !== LEVERAGE_CARD_KEYS.length) {
    bad.push(`卡片必须恰好 ${LEVERAGE_CARD_KEYS.length} 张（两行 × 四列；实得 ${cards.length}）`)
  }
  cards.forEach((card, i) => {
    const key = LEVERAGE_CARD_KEYS[i]
    const label = LEVERAGE_CARD_LABELS[i]
    if (key === undefined || label === undefined) {
      bad.push(`第 ${i + 1} 张卡超出了布局契约（多出来的卡片必须删掉）`)
      return
    }
    if (card.key !== key) bad.push(`第 ${i + 1} 张卡必须是 ${key}（实得 ${card.key}）`)
    if (card.label !== label) bad.push(`第 ${i + 1} 张卡的标签必须逐字是「${label}」（实得 ${JSON.stringify(card.label)}）`)
    const shape = CARD_VALUE_SHAPES[i]
    if (shape !== undefined && !shape.test(card.value)) bad.push(`第 ${i + 1} 张卡的数值形态不符：${JSON.stringify(card.value)}`)
    if (i === 0) {
      if (card.suffix !== '/ 100') bad.push(`温度卡必须带后缀 / 100（实得 ${JSON.stringify(card.suffix)}）`)
      if (card.note === undefined || !CARD_NOTE_SHAPE.test(card.note)) bad.push(`温度卡小字只允许「${ASOF_PREFIX} YYYY-MM-DD」或 —（实得 ${JSON.stringify(card.note)}）`)
    } else {
      if (card.suffix !== undefined) bad.push(`第 ${i + 1} 张卡不许带后缀（除温度卡外不加字）`)
      if (card.note !== undefined) bad.push(`第 ${i + 1} 张卡不许带小字（除温度卡外不加字）`)
    }
  })
  return bad
}
