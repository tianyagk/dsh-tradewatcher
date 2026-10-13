/**
 * 【涨跌分布】模块的纯视图逻辑（不 import react ⇒ 能在 node 里直接断言）。
 *
 * 参考版（Arkvol）结构：左列三段紧凑内联行（涨跌趋势 / 成交量 / 两融走势）+ 右列两块
 * （柱状直方图带纵轴与网格线 / 双序列日内折线）。这里只放"能算的那部分"：
 * 直方图的纵轴刻度与网格线位置（写在纯函数里，便于把"必须有纵轴"断言死）。
 */

/**
 * 直方图纵轴：值域按**数据取整**（"nice" 步长：1/2/5 × 10ⁿ），返回 4 条网格线（含 0 与上界）。
 *
 * 为什么取整：参考版的纵轴是整洁刻度（如 0 / 500 / 1000 / 1500）；直接用最大值当上界会得到
 * "上界 = 1234" 这种刻度，读数困难。取整只影响**轴的标注与网格**，不动柱高所依据的原始计数。
 */
export function distAxisOf(counts: readonly number[]): { max: number; ticks: number[] } {
  const peak = Math.max(0, ...counts.map((c) => (Number.isFinite(c) && c > 0 ? c : 0)))
  if (peak === 0) return { max: 1, ticks: [0, 1] }
  const step = niceStep(peak / 3)
  const max = Math.ceil(peak / step) * step
  const ticks: number[] = []
  for (let v = 0; v <= max + 1e-9; v += step) ticks.push(Math.round(v))
  return { max, ticks }
}

/** 取 1/2/5 × 10ⁿ 里 ≥ raw 的最小步长（"nice number" 惯例） */
function niceStep(raw: number): number {
  if (!(raw > 0)) return 1
  const exp = Math.floor(Math.log10(raw))
  const base = Math.pow(10, exp)
  const norm = raw / base
  const mult = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10
  return mult * base
}

/** 柱高百分比：按**轴的上界**归一（不是按峰值）——否则柱顶会贴着顶点、与网格线对不上 */
export function distBarPctOf(count: number, axisMax: number): number {
  if (!(axisMax > 0)) return 0
  const pct = (Math.max(0, count) / axisMax) * 100
  return Math.min(100, Math.round(pct * 100) / 100)
}
