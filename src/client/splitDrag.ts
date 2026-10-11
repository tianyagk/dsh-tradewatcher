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
/** 图表的固定开销（不随高度缩放的间隙/留白） */
export const CHART_CHROME = 8 + 6 + 6 + 16
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
  chartHeight: number
  mainH: number
  volH: number
  macdH: number
}

/**
 * 由上窗高度算出图表三块绘图区的高度（固定开销不变 ⇒ **不是**等比缩放）。
 * 可用高度不足（`top <= CHART_CHROME + 24`）⇒ 按最小值夹住（**不重绘空图**、不出现 0/负高度）。
 */
export function klineHeightsOf(top: number): KlineHeights & { usable: boolean } {
  const plot = Math.max(24, Math.round((Number.isFinite(top) ? top : 0) - CHART_CHROME - 24 /* x 轴文字 */))
  const usable = Number.isFinite(top) && top > CHART_CHROME + 24
  const mainH = Math.max(60, Math.round((plot * SHAPE.main) / SHAPE_SUM))
  const volH = Math.max(24, Math.round((plot * SHAPE.vol) / SHAPE_SUM))
  const macdH = Math.max(28, Math.round((plot * SHAPE.macd) / SHAPE_SUM))
  return { chartHeight: CHART_CHROME + 24 + mainH + volH + macdH, mainH, volH, macdH, usable }
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
