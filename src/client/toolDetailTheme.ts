/**
 * 工具箱**详情页**的排版 / 间距 / 表面 / 绘图区 / 动效令牌 + 判据（纯模块：只有类型导入 ⇒ node:test 可直接读）。
 *
 * 为什么要单独一个模块（而不是写内联字面量或 CSS 类）：
 *   · 用户这一批的要求是**可检查的量**（"标题 ≥ 40px 且字重 ≥ 700"、"标签与数值字号差 ≥ 18"、
 *     "图例在图表上方居中"、"绘图区有高度契约、不许塌陷"、"切换档位 150–250ms 过渡"）；
 *   · 写在 JSX 内联样式里 ⇒ 断言只能正则捞源码（脆、易漏，AUDIT-IMPL43 §3 的教训）；
 *     写进 CSS ⇒ JS 侧读不到，只能对字符串做检查。
 *   ⇒ 下沉成常量 + 判据：页面用**同一批对象**，断言对这些对象跑判据（锚真实现，不是抄一份期望值）。
 *
 * 规格文档：`docs/DESIGN-TOOL-PAGE-ALIGN.md`（§2 令牌表、§3 组件规格、§8 绘图区、§9 动效）。
 * 红线：这里的每个值只影响**呈现**，不影响任何数字、来源、缺失与否（见该文档 §5）。
 */
import type { CSSProperties } from 'react'

/* ────────────────────────────── 1. 文字令牌 ────────────────────────────── */

export interface TypeSpec {
  fontSize: number
  fontWeight?: number
  lineHeight?: number | string
  letterSpacing?: string
  textTransform?: 'none' | 'uppercase'
  color?: string
  /** 以下三项用于 kicker 的"不是胶囊"判据 */
  border?: string
  background?: string
  borderRadius?: number | string
  maxWidth?: string
}

/** Hero 大字排版（参考版：kicker 大写宽字距 → 超大标题 → 松行高说明段） */
export const HERO_TYPE: { kicker: TypeSpec; title: TypeSpec; note: TypeSpec } = {
  kicker: { fontSize: 12, fontWeight: 600, lineHeight: 1.2, letterSpacing: '0.14em', textTransform: 'uppercase', color: 'var(--tw-muted)' },
  title: { fontSize: 46, fontWeight: 800, lineHeight: 1.06, letterSpacing: '-0.02em', color: 'var(--tw-text)' },
  note: { fontSize: 15, fontWeight: 400, lineHeight: 1.7, color: 'var(--tw-dim)', maxWidth: '68ch' },
}

/** 摘要卡层级（参考版：小号标签在上 → 大号数值在下 → 小号状态词） */
export const SUMMARY_TYPE: { label: TypeSpec; value: TypeSpec; note: TypeSpec } = {
  label: { fontSize: 12.5, fontWeight: 500, lineHeight: 1.3, color: 'var(--tw-muted)' },
  value: { fontSize: 34, fontWeight: 700, lineHeight: 1.1, letterSpacing: '-0.02em', color: 'var(--tw-text)' },
  note: { fontSize: 12, fontWeight: 400, lineHeight: 1.45, color: 'var(--tw-muted)' },
}

/** 图表卡内部：卡标题 / 右上 AS OF / 磁贴三行 / 图例名称 */
export const CHART_TYPE: { cardTitle: TypeSpec; asOf: TypeSpec; tileLabel: TypeSpec; tileValue: TypeSpec; tileDelta: TypeSpec; legend: TypeSpec } = {
  cardTitle: { fontSize: 17, fontWeight: 700, lineHeight: 1.3, color: 'var(--tw-text)' },
  asOf: { fontSize: 11.5, fontWeight: 500, letterSpacing: '0.08em', color: 'var(--tw-muted)' },
  tileLabel: { fontSize: 12, fontWeight: 400, lineHeight: 1.3, color: 'var(--tw-muted)' },
  tileValue: { fontSize: 20, fontWeight: 700, lineHeight: 1.2, color: 'var(--tw-text)' },
  tileDelta: { fontSize: 11.5, fontWeight: 400, color: 'var(--tw-muted)' },
  legend: { fontSize: 12, fontWeight: 400, color: 'var(--tw-dim)' },
}

/** 时间范围分段控件的档位文字 */
export const RANGE_TYPE: TypeSpec = { fontSize: 12.5, fontWeight: 500 }

/* ────────────────────────────── 2. 间距令牌 ────────────────────────────── */

/** 纵向节奏（参考版：区块间距大、内边距 16–20） */
export const TOOL_SPACE = {
  /** 详情页区块间距（px） */
  sectionGap: 22,
  /** 卡片内边距（px） */
  cardPad: 18,
  /** 卡片头与内容之间（px） */
  cardHeadGap: 12,
  /** 磁贴内边距（px） */
  tilePadY: 10,
  tilePadX: 12,
  /** 磁贴间距 / Hero 间距（px） */
  tileGap: 10,
  heroGap: 16,
  /** Hero 内部（kicker → 标题 → 说明）间距（px） */
  heroInnerGap: 10,
} as const

/* ────────────────────────────── 3. 表面令牌（边框分层，不靠重阴影） ────────────────────────────── */

/** 卡片：细边框 + 大圆角 + 无阴影（暗底靠边框分层） */
export const CARD_SURFACE: CSSProperties = {
  border: '1px solid var(--tw-border-strong)',
  borderRadius: 14,
  background: 'var(--tw-card)',
  boxShadow: 'none',
  padding: `${TOOL_SPACE.cardPad}px`,
}

/** 磁贴：比卡片弱一档的边框与圆角 */
export const TILE_SURFACE: CSSProperties = {
  border: '1px solid var(--tw-border)',
  borderRadius: 10,
  background: 'var(--tw-card2)',
  padding: `${TOOL_SPACE.tilePadY}px ${TOOL_SPACE.tilePadX}px`,
  minWidth: 0,
}

/** 磁贴左上角的**色标方块**（颜色由页面按序列序号给；无对应序列 ⇒ `--tw-muted` 中性） */
export const SWATCH: CSSProperties = { width: 8, height: 8, borderRadius: 2, flexShrink: 0, background: 'var(--tw-muted)' }

/** 图例容器：**居中**；图例色标：**圆点**（不是小矩形） */
export const LEGEND_ROW: CSSProperties = { display: 'flex', justifyContent: 'center', alignItems: 'center', gap: 14, flexWrap: 'wrap' }
export const LEGEND_DOT: CSSProperties = { width: 8, height: 8, borderRadius: '50%', flexShrink: 0 }

/**
 * 图表卡内部自下而上的**渲染顺序**（唯一来源）：图例在上、画布在下。
 *
 * 为什么要把顺序做成常量：用户的口径是"图例居中在图表**上方**"，而"上方"在 React 里就是
 * **children 的先后**——写成字面量时只能靠正则比源码位置（脆）。做成数组后，断言直接比数组顺序，
 * 页面也照着它渲染（`CHART_STACK.map(...)`），改顺序 = 改一处常量，断言必红。
 */
export const CHART_STACK = ['legend', 'plot'] as const

/** 图例在画布上方的判据（唯一实现） */
export function chartStackProblems(stack: readonly string[]): string[] {
  const bad: string[] = []
  const legend = stack.indexOf('legend')
  const plot = stack.indexOf('plot')
  if (legend < 0 || plot < 0) bad.push(`图表卡必须同时渲染图例与画布（实得 ${JSON.stringify(stack)}）`)
  else if (legend > plot) bad.push(`图例必须排在画布上方（顺序 legend → plot；实得 ${JSON.stringify(stack)}）`)
  return bad
}

/** 范围控件：容器凹陷；**选中档 = 浅底圆角块** */
export const RANGE_BOX: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 2,
  padding: 2,
  border: '1px solid var(--tw-border)',
  borderRadius: 10,
  background: 'var(--tw-bg2)',
  flexShrink: 0,
}
export const RANGE_ON: CSSProperties = { background: 'var(--tw-card)', border: '1px solid var(--tw-border-strong)', borderRadius: 8, color: 'var(--tw-text)', fontWeight: 600 }
export const RANGE_OFF: CSSProperties = { background: 'transparent', border: '1px solid transparent', borderRadius: 8, color: 'var(--tw-muted)', fontWeight: 400 }

/* ────────────────────────────── 4. 绘图区令牌 ────────────────────────────── */

/**
 * 绘图区（**有界高度**：`clamp(280px, 26vh, 380px)`）。
 *
 * 演进（两次教训都写在这里，免得第三个人再踩）：
 *  ① `.tw-chips-plot` 只写 `flex:1` ⇒ 塌成 1px ⇒ 必须有**高度下限**；
 *  ② 上一版用 `aspect-ratio: 16 / 7` ⇒ 在整卡宽度（约 2000px）下算出约 875px 高 ⇒ **图过高、把饼图挤到下方**
 *     ⇒ **高度不许再由卡片宽度单独决定**，必须有上下界。
 * ⇒ 现在：`clamp()` 同时给出下限与上限（用户口径 [280, 420]，取 280 / 380），
 *    两列布局的左列宽度只影响**画布宽度**（ResizeObserver 量真实像素），不再影响高度。
 */
export const PLOT = {
  /** 高度契约（CSS）：下限 280、上限 380（都落在用户给的 [280,420] 内） */
  heightCss: 'clamp(280px, 26vh, 380px)',
  /** 判定用的上下界（与 heightCss 必须一致，`plotHeightProblems` 会核对） */
  heightMin: 280,
  heightMax: 380,
  /** 测量失败/未挂载时的回退画布（保证首帧就有合理画布，不塌成 0） */
  fallbackWidth: 960,
  fallbackHeight: 320,
  /** 内边距（px）：右侧留给纵轴刻度 */
  pad: { left: 12, right: 58, top: 16, bottom: 26 },
  /** 悬停取点带宽（px）：命中该列即选中该点 */
  hoverBand: 20,
} as const

/** 解析 `clamp(min, …, max)` / `Npx` / `N` 得到 [下限, 上限]（纯函数，判据与断言共用） */
export function heightBoundsOf(value: unknown): { lo: number; hi: number } | null {
  if (typeof value === 'number' && Number.isFinite(value)) return { lo: value, hi: value }
  if (typeof value !== 'string') return null
  const text = value.trim()
  const clamp = /^clamp\(\s*([\d.]+)px\s*,[^,]+,\s*([\d.]+)px\s*\)$/.exec(text)
  if (clamp !== null) {
    const lo = Number.parseFloat(clamp[1])
    const hi = Number.parseFloat(clamp[2])
    return Number.isFinite(lo) && Number.isFinite(hi) ? { lo, hi } : null
  }
  const px = /^([\d.]+)px$/.exec(text)
  if (px !== null) {
    const v = Number.parseFloat(px[1])
    return Number.isFinite(v) ? { lo: v, hi: v } : null
  }
  return null
}

/**
 * 绘图区横坐标（纯函数）：第 i 个点在这块画布上的 x（像素）。
 * `count <= 1` 时贴左内边距（单点画不出线，但仍然要落在正确位置）。
 */
export function plotX(i: number, count: number, w: number): number {
  const inner = Math.max(1, w - PLOT.pad.left - PLOT.pad.right)
  if (count <= 1) return PLOT.pad.left
  return PLOT.pad.left + (i * inner) / (count - 1)
}

/**
 * 悬停取点（纯函数）：指针 x ⇒ 最近的点下标；**在有效绘图带之外返回 null**（不硬凑一个点）。
 *
 * 为什么要有"带外 null"：鼠标划过卡片左右留白（纵轴标签区）时会按下标取到端点 ⇒ 提示框显示一个
 * 用户并没有真正指向的值。`hoverBand` 给出允许超出绘图区的容差（px）。
 */
export function nearestIndex(px: number, count: number, w: number): number | null {
  if (count <= 0) return null
  if (count === 1) return 0
  const left = PLOT.pad.left - PLOT.hoverBand
  const right = w - PLOT.pad.right + PLOT.hoverBand
  if (px < left || px > right) return null
  const inner = Math.max(1, w - PLOT.pad.left - PLOT.pad.right)
  const t = (px - PLOT.pad.left) / inner
  return Math.min(count - 1, Math.max(0, Math.round(t * (count - 1))))
}

/**
 * 绘图区高度判据（唯一实现）：**高度必须是有界的**，且落在用户口径 [280, 420] 内。
 *
 * 三种必须被拒的形态（各自都是踩过的坑）：
 *   · 只写 `flex: 1`（历史事故 `.tw-chips-plot` ⇒ 塌成 1px）；
 *   · 只用 `aspect-ratio`（上一版：整卡 2000px 宽 ⇒ 约 875px 高，图过高、饼图被挤下去）；
 *   · 写死一个越界的 px（如 160px 太小、600px 太高）。
 */
export function plotHeightProblems(box: { height?: unknown; minHeight?: unknown; maxHeight?: unknown; aspectRatio?: unknown; flex?: unknown }): string[] {
  const bad: string[] = []
  const hasHeight = box.height !== undefined && box.height !== null && box.height !== 'auto' && box.height !== 0
  const hasAspect = typeof box.aspectRatio === 'string' && box.aspectRatio.trim() !== ''
  if (!hasHeight) {
    if (hasAspect) bad.push('绘图区高度不许由 aspect-ratio 单独决定（整卡宽度会把它算得过高：上一版 16/7 在 2000px 宽下约 875px）')
    else bad.push('绘图区必须有高度契约（height: clamp(...)）—— 只写 flex:1 会塌成 1px（历史事故 .tw-chips-plot）')
  }
  const bounds = hasHeight ? heightBoundsOf(box.height) : null
  if (hasHeight && bounds === null) bad.push(`绘图区高度契约无法解析（只认 clamp(min,…,max) 或 Npx；实得 ${JSON.stringify(box.height)}）`)
  if (bounds !== null) {
    if (bounds.lo < 280) bad.push(`绘图区高度下限必须 ≥ 280px（实得 ${bounds.lo}）`)
    if (bounds.hi > 420) bad.push(`绘图区高度上限必须 ≤ 420px（实得 ${bounds.hi}）`)
    if (bounds.lo > bounds.hi) bad.push(`绘图区高度上下界颠倒（实得 ${JSON.stringify(bounds)}）`)
  }
  // 与 PLOT.heightCss 自洽（防止有人只改常量里的注释/数字之一）
  if (hasHeight && box.height === PLOT.heightCss) {
    if (PLOT.heightMin < 280 || PLOT.heightMax > 420 || PLOT.heightMin > PLOT.heightMax) {
      bad.push(`PLOT.heightMin/heightMax 越界（实得 ${PLOT.heightMin}/${PLOT.heightMax}，口径 [280,420]）`)
    }
  }
  return bad
}

/* ────────────────────────────── 4b. 两列布局与饼图令牌（用户第四批：尺寸对齐） ────────────────────────────── */

/**
 * 图表卡内的**两列**：左 = 折线图，右 = 饼图 + 回放滑块（参考版口径）。
 * 与 `CHART_STACK` 同理：顺序即渲染顺序，做成常量后断言直接比数组。
 */
export const CHART_SPLIT = ['plot', 'pie'] as const

/** 两列顺序判据（唯一实现）：折线在左、饼图在右 */
export function chartSplitProblems(split: readonly string[]): string[] {
  const bad: string[] = []
  const plot = split.indexOf('plot')
  const pie = split.indexOf('pie')
  if (plot < 0 || pie < 0) bad.push(`图表卡必须同时渲染折线图与饼图两列（实得 ${JSON.stringify(split)}）`)
  else if (plot > pie) bad.push(`折线图必须在左、饼图在右（实得 ${JSON.stringify(split)}）`)
  return bad
}

/**
 * 饼图（右列）：直径 `clamp(220px, 22vh, 320px)`、居中；图例在饼**下方**（色标与折线图一致）。
 *
 * `radiusRatio` 是饼在 100×100 viewBox 里的半径比例 ⇒ **画面直径 = 尺寸契约 × 2 × radiusRatio**，
 * 因此"实际画出来的饼"也在 [202, 294] 内（参考版的 260–300 量级）。
 */
export const PIE = {
  sizeCss: 'clamp(220px, 22vh, 320px)',
  sizeMin: 220,
  sizeMax: 320,
  radiusRatio: 0.46,
  fallbackSize: 260,
  /**
   * **实心饼**（用户口径）：扇形从圆心起画（`M CX CY L …A… Z`），中心不再挖孔放日期
   * —— 日期改到饼上方的小字（`tool-pie-day`），信息不丢但不吃直径。
   */
  solid: true,
} as const

/** 饼图尺寸判据（唯一实现）：直径在 [220, 320]，不许撑满整列、不许无界 */
export function pieProblems(style: { width?: unknown; height?: unknown }): string[] {
  const bad: string[] = []
  const bounds = heightBoundsOf(style.width)
  if (bounds === null) bad.push(`饼图尺寸必须是有界契约（clamp(min,…,max) 或 Npx；实得 ${JSON.stringify(style.width)}）`)
  else {
    if (bounds.lo < 220) bad.push(`饼图直径下限必须 ≥ 220px（实得 ${bounds.lo}）`)
    if (bounds.hi > 320) bad.push(`饼图直径上限必须 ≤ 320px（实得 ${bounds.hi}）`)
    const drawn = { lo: bounds.lo * 2 * PIE.radiusRatio, hi: bounds.hi * 2 * PIE.radiusRatio }
    if (drawn.lo < 200 || drawn.hi > 320) bad.push(`实际画面直径（尺寸 × 2 × radiusRatio）必须落在 [200,320]（实得 ${drawn.lo.toFixed(1)}–${drawn.hi.toFixed(1)}）`)
  }
  if (style.height !== style.width) bad.push(`饼图必须是正方形（宽高同一条契约；实得 ${JSON.stringify([style.width, style.height])}）`)
  if (PIE.sizeMin < 220 || PIE.sizeMax > 320) bad.push(`PIE.sizeMin/sizeMax 越界（实得 ${PIE.sizeMin}/${PIE.sizeMax}）`)
  return bad
}

/**
 * 市场**横条**（用户口径：五个市场各一条横条）。
 *
 * 条色用**单一强调色**（不按升/降温改条色）：红绿在本插件里是涨跌语义，横条画的是"份额大小"，
 * 用它做红绿会被读成涨跌；升/降温只由右端那句文字的颜色表达（`warm`/`cool`/`flat`）。
 */
export const BAR = {
  trackHeight: 10,
  radius: 5,
  fill: 'var(--tw-accent)',
  track: 'var(--tw-bg2)',
  warm: 'var(--tw-up)',
  cool: 'var(--tw-down)',
  flat: 'var(--tw-muted)',
  /** 行与行之间（px） */
  rowGap: 12,
  /** 行内：市场名那一行 */
  headGap: 4,
  /** 行内：长条 + 右端「近5日」那一行 */
  barGap: 10,
} as const

/** 横条判据（唯一实现）：条高/圆角/颜色/行距都得成立 */
export function barProblems(bar: { trackHeight?: unknown; radius?: unknown; fill?: unknown; track?: unknown; rowGap?: unknown; headGap?: unknown; barGap?: unknown }): string[] {
  const bad: string[] = []
  const h = num(bar.trackHeight)
  if (h === null || h < 8) bad.push(`横条高度必须 ≥ 8px（实得 ${JSON.stringify(bar.trackHeight)}）`)
  if (h !== null && h > 14) bad.push(`横条高度必须 ≤ 14px（实得 ${h}）`)
  const r = num(bar.radius)
  if (r === null || r < 4) bad.push(`横条圆角必须 ≥ 4px（实得 ${JSON.stringify(bar.radius)}）`)
  if (r !== null && h !== null && r > h) bad.push(`横条圆角不许超过条高（圆角 ${r} > 条高 ${h}）`)
  for (const [k, v] of [['fill', bar.fill], ['track', bar.track]] as const) {
    if (typeof v !== 'string' || !v.startsWith('var(--tw-')) bad.push(`横条颜色 ${k} 必须走主题 token（实得 ${JSON.stringify(v)}）`)
  }
  // 条色**单色**：用涨跌色画"份额大小"会被读成涨跌（升/降温只由右端文字表达）
  if (bar.fill === 'var(--tw-up)' || bar.fill === 'var(--tw-down)') {
    bad.push(`横条填充色不许用涨跌色（fill = ${String(bar.fill)}）；升温/降温只由右端文字表达`)
  }
  const gaps: Array<[string, unknown, number, number]> = [
    ['行距 rowGap', bar.rowGap, 8, 16],
    ['行内 headGap', bar.headGap, 4, 12],
    ['行内 barGap', bar.barGap, 4, 12],
  ]
  for (const [label, v, lo, hi] of gaps) {
    const n = num(v)
    if (n === null || n < lo || n > hi) bad.push(`${label} 必须在 [${lo}, ${hi}]px（实得 ${JSON.stringify(v)}）`)
  }
  return bad
}

/** 回放（播放/暂停）：自动步进间隔（ms） */
export const REPLAY = { tickMs: 700 } as const

/** 统计区间里的步数文案（`N/30`）：页面与断言共用同一个格式 */
export function replayCountText(step: number, maxStep: number): string {
  return `${Math.max(0, step) + 1}/${Math.max(1, maxStep + 1)}`
}

/* ────────────────────────────── 5. 动效令牌 ────────────────────────────── */

/**
 * 动效（用户 B 组要求）：切档过渡 150–250ms；回放拖动平滑跟随；悬停十字线；
 * **只用 CSS transition / SVG 属性动画**（不引依赖）；**尊重 reduced-motion**。
 *
 * `reducedMotion: 'css-media'` 表示：用 `@media (prefers-reduced-motion: reduce)` + 页面上的
 * `data-anim="off"` 开关双保险（开关由 `matchMedia` 驱动，见 `toolsPage.test.ts` 的接线断言）。
 */
export const MOTION = {
  /** 切换 90/180/365 档位时的过渡时长（ms） */
  rangeMs: 200,
  /** 回放滑块拖动时线条跟随的过渡时长（ms） */
  replayMs: 180,
  /** 淡入关键帧名（定义在 `styles.ts`，时长由内联 animation 给 ⇒ 数字只有这一份来源） */
  fadeKeyframes: 'tw-tool-in',
  /** 尊重 reduced-motion 的实现方式 */
  reducedMotion: 'css-media' as const,
} as const

/** 内联的过渡/动画字符串（页面直接用；数字只在 MOTION 里写一次） */
export const MOTION_STYLE = {
  line: { transition: `d ${MOTION.replayMs}ms linear, opacity ${MOTION.replayMs}ms linear, cx ${MOTION.replayMs}ms linear, cy ${MOTION.replayMs}ms linear` } as CSSProperties,
  fadeIn: { animation: `${MOTION.fadeKeyframes} ${MOTION.rangeMs}ms ease-out` } as CSSProperties,
}

/**
 * 把折线路径同时交给**属性**与**CSS**：
 *   · 属性 `d` = 兼容路径（所有浏览器都按它画）；
 *   · CSS `d: path(...)` = 支持 CSS `d` 的浏览器（Chrome / Firefox 97+）据此做 `transition: d`，
 *     回放拖动时线条**平滑跟随**而不是逐帧跳变；不支持的浏览器忽略这条 ⇒ 行为与今天完全一致。
 * 因此没有降级风险：不支持 = 不动画，而不是画不出来。
 */
export function pathStyle(d: string): CSSProperties {
  return { ...MOTION_STYLE.line, d: `path("${d}")` } as unknown as CSSProperties
}

/** 动效判据（唯一实现） */
export function motionProblems(m: { rangeMs: number; replayMs: number; reducedMotion: string; hasMediaQuery: boolean; hasOffSwitch: boolean }): string[] {
  const bad: string[] = []
  if (!(m.rangeMs >= 150 && m.rangeMs <= 250)) bad.push(`切档过渡必须在 150–250ms（实得 ${m.rangeMs}）`)
  if (!(m.replayMs >= 120 && m.replayMs <= 250)) bad.push(`回放跟随必须在 120–250ms（实得 ${m.replayMs}）`)
  if (m.reducedMotion === 'none') bad.push('必须有 reduced-motion 降级（系统偏好或插件开关）')
  if (!m.hasMediaQuery) bad.push('缺少 @media (prefers-reduced-motion: reduce) 规则')
  if (!m.hasOffSwitch) bad.push('缺少 data-anim="off" 的降级开关规则（页面据 matchMedia 切换）')
  return bad
}

/* ────────────────────────────── 6. 判据：文字层级 / 表面 ────────────────────────────── */

function num(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string') {
    const n = Number.parseFloat(value)
    return Number.isFinite(n) ? n : null
  }
  return null
}

/** Hero 排版判据：标题够大够粗、kicker 是大写宽字距的纯文字（不是胶囊）、说明段 14–16 且行高松 */
export function heroTypeProblems(t: { kicker: TypeSpec; title: TypeSpec; note: TypeSpec }): string[] {
  const bad: string[] = []
  const title = num(t.title.fontSize)
  if (title === null || title < 40 || title > 60) bad.push(`Hero 标题字号必须 40–60px（实得 ${JSON.stringify(t.title.fontSize)}）`)
  const weight = num(t.title.fontWeight)
  if (weight === null || weight < 700) bad.push(`Hero 标题字重必须 ≥ 700（实得 ${JSON.stringify(t.title.fontWeight)}）`)
  const kicker = num(t.kicker.fontSize)
  if (kicker === null || kicker < 11 || kicker > 13) bad.push(`kicker 字号必须 11–13px（实得 ${JSON.stringify(t.kicker.fontSize)}）`)
  const track = t.kicker.letterSpacing ?? ''
  const em = /^([\d.]+)em$/.exec(track.trim())
  if (em === null || Number.parseFloat(em[1]) < 0.1) bad.push(`kicker 字距必须 ≥ 0.10em（实得 ${JSON.stringify(track)}）`)
  if (t.kicker.textTransform !== 'uppercase') bad.push(`kicker 必须大写（text-transform: uppercase；实得 ${JSON.stringify(t.kicker.textTransform)}）`)
  if (t.kicker.border !== undefined || t.kicker.background !== undefined || t.kicker.borderRadius !== undefined) bad.push('kicker 不许是胶囊标签（不许有 border/background/borderRadius）')
  const note = num(t.note.fontSize)
  if (note === null || note < 14 || note > 16) bad.push(`Hero 说明段字号必须 14–16px（实得 ${JSON.stringify(t.note.fontSize)}）`)
  const lh = num(t.note.lineHeight)
  if (lh === null || lh < 1.5) bad.push(`Hero 说明段行高必须 ≥ 1.5（实得 ${JSON.stringify(t.note.lineHeight)}）`)
  return bad
}

/** 摘要卡层级判据：标签小、数值大且粗，两者字号差 ≥ 18 */
export function summaryHierarchyProblems(t: { label: TypeSpec; value: TypeSpec; note: TypeSpec }): string[] {
  const bad: string[] = []
  const label = num(t.label.fontSize)
  const value = num(t.value.fontSize)
  if (label === null || label < 12 || label > 13) bad.push(`摘要卡标签字号必须 12–13px（实得 ${JSON.stringify(t.label.fontSize)}）`)
  if (value === null || value < 32 || value > 40) bad.push(`摘要卡数值字号必须 32–40px（实得 ${JSON.stringify(t.value.fontSize)}）`)
  if (label !== null && value !== null && value - label < 18) bad.push(`摘要卡标签与数值的字号差必须 ≥ 18px（实得 ${value - label}）`)
  const weight = num(t.value.fontWeight)
  if (weight === null || weight < 700) bad.push(`摘要卡数值字重必须 ≥ 700（实得 ${JSON.stringify(t.value.fontWeight)}）`)
  const note = num(t.note.fontSize)
  if (note !== null && note > 13) bad.push(`摘要卡状态词必须 ≤ 13px（实得 ${note}）`)
  return bad
}

/** 卡片表面判据：细边框（1px）+ 大圆角（≥12）+ 无重阴影 + 内边距 16–20 */
export function cardSurfaceProblems(s: { border?: unknown; borderRadius?: unknown; boxShadow?: unknown; padding?: unknown; background?: unknown }): string[] {
  const bad: string[] = []
  const border = typeof s.border === 'string' ? s.border.trim() : ''
  if (!/^1px solid var\(--tw-[a-z-]+\)$/.test(border)) bad.push(`卡片必须是 1px 实线边框（主题 token；实得 ${JSON.stringify(s.border)}）`)
  const radius = num(s.borderRadius)
  if (radius === null || radius < 12) bad.push(`卡片圆角必须 ≥ 12px（实得 ${JSON.stringify(s.borderRadius)}）`)
  const shadow = typeof s.boxShadow === 'string' ? s.boxShadow.trim().toLowerCase() : ''
  if (shadow !== 'none' && shadow !== '') bad.push(`卡片不许用重阴影分层（box-shadow 必须为 none；实得 ${JSON.stringify(s.boxShadow)}）`)
  const pad = num(String(s.padding ?? '').split(/\s+/)[0])
  if (pad === null || pad < 16 || pad > 20) bad.push(`卡片内边距必须 16–20px（实得 ${JSON.stringify(s.padding)}）`)
  if (typeof s.background !== 'string' || !s.background.startsWith('var(--tw-')) bad.push(`卡片底色必须走主题 token（实得 ${JSON.stringify(s.background)}）`)
  return bad
}

/** 磁贴判据：色标存在（≥6px、有圆角、颜色为 token）+ 磁贴本身细边框/圆角/内边距达标 */
export function tileProblems(tile: { border?: unknown; borderRadius?: unknown; padding?: unknown; background?: unknown }, swatch: { width?: unknown; height?: unknown; borderRadius?: unknown; background?: unknown }): string[] {
  const bad: string[] = []
  const radius = num(tile.borderRadius)
  if (radius === null || radius < 8) bad.push(`磁贴圆角必须 ≥ 8px（实得 ${JSON.stringify(tile.borderRadius)}）`)
  if (typeof tile.border !== 'string' || !/^1px solid var\(--tw-/.test(tile.border)) bad.push(`磁贴必须有 1px 主题边框（实得 ${JSON.stringify(tile.border)}）`)
  const padY = num(String(tile.padding ?? '').split(/\s+/)[0])
  if (padY === null || padY < 10 || padY > 14) bad.push(`磁贴内边距必须 10–14px（实得 ${JSON.stringify(tile.padding)}）`)
  const w = num(swatch.width)
  const h = num(swatch.height)
  if (w === null || w < 6 || h === null || h < 6) bad.push(`磁贴色标必须 ≥ 6×6px（实得 ${JSON.stringify([swatch.width, swatch.height])}）`)
  if (num(swatch.borderRadius) === null) bad.push('磁贴色标必须有圆角（小方块）')
  if (typeof swatch.background !== 'string' || !swatch.background.startsWith('var(--tw-')) bad.push(`磁贴色标颜色必须走主题 token（实得 ${JSON.stringify(swatch.background)}）`)
  return bad
}

/** 图例判据：居中 + 圆点（宽高相等、50% 圆角）+ 名称字号 11–13 */
export function legendProblems(row: { justifyContent?: unknown }, dot: { width?: unknown; height?: unknown; borderRadius?: unknown }, label: TypeSpec): string[] {
  const bad: string[] = []
  if (row.justifyContent !== 'center') bad.push(`图例必须居中（justifyContent: center；实得 ${JSON.stringify(row.justifyContent)}）`)
  const w = num(dot.width)
  const h = num(dot.height)
  if (w === null || w < 6 || h === null || h < 6) bad.push(`图例色标必须 ≥ 6px（实得 ${JSON.stringify([dot.width, dot.height])}）`)
  if (w !== null && h !== null && w !== h) bad.push('图例色标必须是正方形/正圆（宽高相等）')
  if (String(dot.borderRadius) !== '50%') bad.push(`图例色标必须是圆点（borderRadius: 50%；实得 ${JSON.stringify(dot.borderRadius)}）`)
  const size = num(label.fontSize)
  if (size === null || size < 11 || size > 13) bad.push(`图例名称字号必须 11–13px（实得 ${JSON.stringify(label.fontSize)}）`)
  return bad
}

/** 范围控件判据：三档存在 + 选中档是浅底圆角块 */
export function rangeProblems(options: readonly number[], on: { background?: unknown; borderRadius?: unknown; border?: unknown; fontWeight?: unknown }): string[] {
  const bad: string[] = []
  if (options.length !== 3) bad.push(`范围控件必须有三档（实得 ${JSON.stringify(options)}）`)
  if (typeof on.background !== 'string' || !on.background.startsWith('var(--tw-')) bad.push(`选中档必须有浅底（主题 token；实得 ${JSON.stringify(on.background)}）`)
  const radius = num(on.borderRadius)
  if (radius === null || radius < 6) bad.push(`选中档必须是圆角块（≥6px；实得 ${JSON.stringify(on.borderRadius)}）`)
  if (typeof on.border !== 'string' || on.border === '') bad.push('选中档必须有边框（浅底 + 细边框 = 块感）')
  const weight = num(on.fontWeight)
  if (weight === null || weight < 600) bad.push(`选中档字重必须 ≥ 600（实得 ${JSON.stringify(on.fontWeight)}）`)
  return bad
}
