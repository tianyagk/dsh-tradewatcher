/**
 * squarified treemap 布局（纯函数，P2-5）。
 *
 * 单独成模块的理由与 quoteState/alertRules 一样：这是可断言的几何逻辑
 * （面积成比例、不越界、不重叠、长宽比不退化），而组件那边要引 React。
 * 混在 .tsx 里会让纯逻辑的测试必须装 React。
 *
 * 为什么用 squarified 而不是"从大到小切条"：后者在"一个极大值 + 一堆小值"时
 * 会切出针一样的细条 —— 细条的面积既量不准也看不清，热力图就失去了比较意义。
 */

export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

/**
 * 输入 `values` 必须是非负数，建议降序；返回与输入等长的矩形（顺序一致）。
 * 空输入、全 0、或画布尺寸非正时返回空数组（调用方据此显示空态，而不是画一堆 NaN）。
 */
export function squarify(values: readonly number[], width: number, height: number): Rect[] {
  const out: Rect[] = []
  if (values.length === 0 || width <= 0 || height <= 0) return out
  const total = values.reduce((a, b) => a + b, 0)
  if (!(total > 0)) return out
  const scale = (width * height) / total
  const areas = values.map((v) => Math.max(0, v) * scale)

  /** 一行（条带）的最差长宽比：越接近 1 越方 */
  const worstRatio = (row: readonly number[], shortSide: number): number => {
    const s = row.reduce((a, b) => a + b, 0)
    if (s <= 0) return Infinity
    const thickness = s / shortSide
    let worst = 0
    for (const a of row) {
      const len = a / thickness
      if (len <= 0) continue
      const ratio = Math.max(len / thickness, thickness / len)
      if (ratio > worst) worst = ratio
    }
    return worst
  }

  let x = 0
  let y = 0
  let w = width
  let h = height
  let i = 0
  while (i < areas.length) {
    const shortSide = Math.min(w, h)
    if (shortSide <= 0) break
    let row: number[] = []
    let best = Infinity
    let j = i
    while (j < areas.length) {
      const next = [...row, areas[j]]
      const r = worstRatio(next, shortSide)
      // 行内第一块总是允许；之后只在"更方"时继续加
      if (row.length === 0 || r <= best) {
        row = next
        best = r
        j += 1
      } else {
        break
      }
    }
    const s = row.reduce((a, b) => a + b, 0)
    const thickness = s / shortSide
    if (!(thickness > 0)) break
    if (w >= h) {
      // 竖条：宽度 = thickness，内部自上而下按面积切高度
      let cy = y
      for (const a of row) {
        const ih = a / thickness
        out.push({ x, y: cy, w: thickness, h: ih })
        cy += ih
      }
      x += thickness
      w -= thickness
    } else {
      // 横条：高度 = thickness，内部自左向右按面积切宽度
      let cx = x
      for (const a of row) {
        const iw = a / thickness
        out.push({ x: cx, y, w: iw, h: thickness })
        cx += iw
      }
      y += thickness
      h -= thickness
    }
    i = j
  }
  return out
}
