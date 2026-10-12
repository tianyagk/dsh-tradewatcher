/**
 * 抽屉上下分区的分割线（纯函数：夹取、拖拽预览、动态图表高度）。
 *
 * 为什么高度必须**重算**而不是 CSS 拉伸：图表的比例尺/轴刻度/横条位置都按像素高度算出来的，
 * 用 `transform: scaleY()` 会把文字与线宽一起拉变形 ⇒ 宁可重绘。
 *
 * 高度怎么分：图表的"固定开销"（上下留白与两块之间的间隙）保持**常量**（8+6+6+16 = 36px），
 * 只有**绘图区**跟着变 ⇒ 这本身就说明它不是等比缩放（等比缩放会连间隙一起放大）。
 */

/** 上窗（分时/K线）占可用高度的比例：默认值 = 当前观感（上窗为主） */
export const SPLIT_DEFAULT = 0.62
export const SPLIT_MIN = 0.25
export const SPLIT_MAX = 0.75
/** 两区最小高度（px）：越界夹住，不报错 */
export const SPLIT_MIN_TOP = 160
export const SPLIT_MIN_BOTTOM = 120
/**
 * 图表的固定开销（不随高度缩放的间隙/留白）：8+6+6+16 = 36px。
 *
 * ⚠ 这是 **SVG 内部**的开销（上下留白与两块之间的间隙）。它**不包含** SVG 之下的
 * 控件块（均线图例 / 买卖点图例 / **日期范围缩放轴**）—— 那部分见 `CHART_CONTROLS_PX`。
 * v0.48.0 把上窗改成定高 + `overflow:hidden` 后，只按 36px 排高度 ⇒ SVG 正好填满上窗，
 * 下面的缩放轴被**整体裁掉**（用户报"日K 图丢失了日期范围缩放轴"）。几何见 `chartGeomOf`。
 */
export const CHART_CHROME = 8 + 6 + 6 + 16

/**
 * SVG **之下**的控件块高度（px）。逐段与**实测**同源（Chromium 量真组件标记 + 真 CSS：
 * `svg 底 → .tw-zoom 底 = 84.75px`，向上取整 85；每段都能对到 `styles.ts` / `kline.tsx` 的一行）：
 *
 * | 段 | 来源 | 公式 | px |
 * |---|---|---|---|
 * | SVG → 均线图例 | `.tw-kline{gap:2px}` + `kline.tsx` 内联 `margin:'4px 0 0'` | 2+4 | 6 |
 * | 均线图例一块 | 内联 `fontSize:10` 实测 15px | 15 | 15 |
 * | 均线图例 → 缩放轴 | `.tw-kline{gap:2px}` | 2 | 2 |
 * | 缩放轴自己 | 外距 `.tw-zoom{margin-top:6px}` + 轨道 16（含边框，`.tw-root *{box-sizing:border-box}`）+ 内间隙 5 + 文案行 15.75⇒16 | 6+16+5+16 | 43 |
 * | | | **合计** | **66** |
 *
 * 上表把"缩放轴"整块算进来了：v0.48.0 的回归正是**漏了这几十 px**，
 * 于是 SVG 占满上窗（`klineHeightsOf` 只扣了 36+24）、缩放轴被上窗的 `overflow:hidden` 整体裁掉。
 *
 * ⚠ v0.55.0：区间买卖图例（15px 一块 + 4px 间距）**已按用户要求删除**（改成悬停提示）⇒ 本常量 85 → 66；
 * 无标记与有标记两种情况的实测值现在都是 65.75px（不再有"有流水才出现"的最坏情况）。
 */
export const CHART_CONTROLS_PX = 6 + 15 + 2 + 43

/**
 * 控件块的逐段分项（与上表**同序**，不重不漏；`CONTROL_PARTS_PX` 必须等于 `CHART_CONTROLS_PX`，
 * 否则模块一加载就抛 —— 谁改了表里的数而没改分项，立刻会被抓住）。
 * 每段的实测值来自 Chromium（真组件标记 + 真 CSS）：`svg 底 → .tw-zoom 底` 逐段量到
 * 6 / 15 / 2 / 36.75，合计 **65.75px** ⇒ 预留时向上取整 66（v0.55.0 删掉买卖点图例后重测）。
 */
const SEG_SVG_TO_LEGEND = 6 // `.tw-kline{gap:2px}` + 图例 `margin-top:4px`
const SEG_LEGEND = 15
const SEG_BS = 0 // v0.55.0：区间买卖图例已删（改成悬停提示）⇒ 不再占高度
const SEG_BS_TO_ZOOM = 2 // `.tw-kline{gap:2px}`
const SEG_ZOOM = 43 // `.tw-zoom{margin-top:6px}` + 轨道 16 + 内间隙 5 + 文案行 15.75⇒16
const CONTROL_PARTS_PX = SEG_SVG_TO_LEGEND + SEG_LEGEND + SEG_BS + SEG_BS_TO_ZOOM + SEG_ZOOM
if (CONTROL_PARTS_PX !== CHART_CONTROLS_PX) {
  throw new Error(`控件块高度账自相矛盾：分项和 ${CONTROL_PARTS_PX} ≠ CHART_CONTROLS_PX ${CHART_CONTROLS_PX}`)
}

/** 图表三块绘图区的相对形状（与既有 210/54/64 同比例） */
const SHAPE = { main: 210, vol: 54, macd: 64 } as const
const SHAPE_SUM = SHAPE.main + SHAPE.vol + SHAPE.macd

/** 归一比例：非数字/越界 ⇒ 回落默认并给出原因（如实记录，不静默） */
export function normalizeSplitRatio(raw: unknown): { ratio: number; note: string | null } {
  if (raw === undefined) return { ratio: SPLIT_DEFAULT, note: null }
  if (typeof raw !== 'number' || !Number.isFinite(raw)) {
    return { ratio: SPLIT_DEFAULT, note: `分区分割比例不是数字（${String(raw)}）⇒ 回落默认 ${SPLIT_DEFAULT}` }
  }
  if (raw < SPLIT_MIN || raw > SPLIT_MAX) {
    return { ratio: SPLIT_DEFAULT, note: `分区分割比例 ${raw} 超出 [${SPLIT_MIN}, ${SPLIT_MAX}] ⇒ 回落默认 ${SPLIT_DEFAULT}` }
  }
  return { ratio: raw, note: null }
}

export interface SplitHeights {
  /** 上窗高度（px） */
  top: number
  /** 下窗（筹码）高度（px） */
  bottom: number
  /** 是否因为整体太矮而被最小高度夹住 */
  clamped: boolean
}

/**
 * 按比例算两区高度，并夹住边界：上窗 ≥160、下窗 ≥120；整体太矮时按最小高度给（**不许负高度/重叠**）。
 */
export function splitHeights(available: number, ratio: number): SplitHeights {
  const avail = Number.isFinite(available) && available > 0 ? available : 0
  const r = Math.min(SPLIT_MAX, Math.max(SPLIT_MIN, Number.isFinite(ratio) ? ratio : SPLIT_DEFAULT))
  let top = Math.round(avail * r)
  let bottom = avail - top
  let clamped = false
  if (top < SPLIT_MIN_TOP) {
    top = Math.min(SPLIT_MIN_TOP, Math.max(0, avail))
    clamped = true
  }
  if (avail - top < SPLIT_MIN_BOTTOM) {
    bottom = Math.max(0, Math.min(SPLIT_MIN_BOTTOM, avail))
    top = Math.max(0, avail - bottom)
    clamped = true
  } else {
    bottom = avail - top
  }
  // 极端情况（可用高度 < 两个最小值之和）：给最小值但保证相加不超过可用高度且都不为负
  if (top + bottom > avail) {
    const scale = avail / Math.max(1, top + bottom)
    top = Math.floor(top * scale)
    bottom = Math.max(0, avail - top)
    clamped = true
  }
  return { top: Math.max(0, top), bottom: Math.max(0, bottom), clamped }
}

export interface KlineHeights {
  /** **SVG 自己的高度**（绘图区 + SVG 内部留白 + x 轴文字）—— 不含 SVG 之下的控件块 */
  chartHeight: number
  mainH: number
  volH: number
  macdH: number
}

/**
 * 由上窗高度算出图表三块绘图区的高度（固定开销不变 ⇒ **不是**等比缩放）。
 * 可用高度不足（`top <= CHART_CHROME + CHART_CONTROLS_PX + 24`）⇒ 按最小值夹住
 * （**不重绘空图**、不出现 0/负高度）。
 *
 * `chartHeight` 是 **SVG 的高度**：上窗高度里先后扣掉
 * ① `CHART_CONTROLS_PX`（SVG 之下的控件块，含日期范围缩放轴）
 * ② `CHART_CHROME`（SVG 内部留白）+ 24（x 轴文字）。
 * 回归提交 5d11d91（v0.48.0）只扣了 ② ⇒ SVG 正好填满上窗、缩放轴被 `overflow:hidden` 整体裁掉。
 */
export function klineHeightsOf(top: number): KlineHeights & { usable: boolean } {
  const plot = Math.max(24, Math.round((Number.isFinite(top) ? top : 0) - CHART_CHROME - CHART_CONTROLS_PX - 24 /* x 轴文字 */))
  const usable = Number.isFinite(top) && top > CHART_CHROME + CHART_CONTROLS_PX + 24
  const mainH = Math.max(60, Math.round((plot * SHAPE.main) / SHAPE_SUM))
  const volH = Math.max(24, Math.round((plot * SHAPE.vol) / SHAPE_SUM))
  const macdH = Math.max(28, Math.round((plot * SHAPE.macd) / SHAPE_SUM))
  return { chartHeight: CHART_CHROME + 24 + mainH + volH + macdH, mainH, volH, macdH, usable }
}

/**
 * 上窗内的**纵向**几何账（纯算术，断言锚的就是它）。
 *
 * `svg + controls ≤ top` 是"日期范围缩放轴不被裁掉"的**充要条件**（上窗 `overflow:hidden`，
 * 裁掉的东西不会报错、只是看不见）。`top` 极小被最小值夹住时，这条不成立 ⇒ `clipped: true` **如实报**，
 * 不假装装得下（界面可据此不渲染缩放轴，而不是渲染一个必然被裁的控件）。
 */
export interface ChartGeom {
  /** 上窗可用高度（px） */
  top: number
  /** SVG 高度（px） */
  svg: number
  /** 均线图例高度（px） */
  legend: number
  /** 买卖点图例高度（px） */
  bsLegend: number
  /** SVG 与控件块之间的间隙（px） */
  gaps: number
  /** SVG 之下控件块合计（px） */
  controls: number
  /** 其中"日期范围缩放轴"那一块（px） */
  zoomBar: number
  /** 内容总高（= svg + gaps + controls） */
  content: number
  /** 是否会被上窗裁掉（`content > top`） */
  clipped: boolean
  /** 裁掉多少 px（不裁时为 0） */
  overflow: number
  /** SVG 与控件块**重叠**多少 px（正常为 0；极小上窗被最小值夹住时可能 > 0） */
  overlap: number
}

/**
 * 由上窗高度算出纵向几何账。
 *
 * 恒等式（断言锚它）：`controls = legend + bsLegend + gaps + zoomBar`，且 `CHART_CONTROLS_PX` 就是它们的和
 * —— 于是 `klineHeightsOf` 预留的空间与 `chartGeomOf` 记的账**不可能各说各话**。
 * `content ≤ top` 就是"日期范围缩放轴不被裁掉"的判据（上窗 `overflow:hidden`，被裁的东西不报错、只是看不见）。
 */
export function chartGeomOf(top: number): ChartGeom {
  const t = Number.isFinite(top) && top > 0 ? top : 0
  const k = klineHeightsOf(t)
  const svg = k.chartHeight
  const controls = CONTROL_PARTS_PX
  const content = svg + controls
  const overflow = Math.max(0, content - t)
  const overlap = Math.max(0, svg - t)
  return {
    top: t, svg,
    legend: SEG_SVG_TO_LEGEND + SEG_LEGEND,
    bsLegend: SEG_BS,
    gaps: SEG_BS_TO_ZOOM,
    zoomBar: SEG_ZOOM,
    controls, content, clipped: overflow > 0, overflow, overlap,
  }
}

/**
 * 轴刻度按**像素高度**重算：刻度条数随高度变（不是把同一套刻度等比放大）。
 * 极小高度 ⇒ 只留两端与中点共 3 条；常规 ⇒ 5 条。
 */
export function priceTicksFor(lo: number, hi: number, heightPx: number): number[] {
  if (!(hi > lo) || !Number.isFinite(lo) || !Number.isFinite(hi)) return []
  const count = heightPx < 120 ? 3 : heightPx < 240 ? 4 : 5
  return Array.from({ length: count }, (_, i) => lo + ((hi - lo) * i) / (count - 1))
}

/** 拖拽中的预览比例（只挪线，不重绘图表；松手才提交） */
export function splitDragRatio(startRatio: number, startY: number, y: number, available: number): number {
  if (!(available > 0)) return startRatio
  const next = startRatio + (y - startY) / available
  return Math.min(SPLIT_MAX, Math.max(SPLIT_MIN, next))
}

/** 键盘步长：2% */
export function splitKeyStep(ratio: number, key: 'ArrowUp' | 'ArrowDown'): number {
  const delta = key === 'ArrowUp' ? 0.02 : -0.02
  return Math.min(SPLIT_MAX, Math.max(SPLIT_MIN, Math.round((ratio + delta) * 1000) / 1000))
}
