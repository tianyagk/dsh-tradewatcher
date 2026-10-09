/**
 * 分时/五日的坐标域与"这条序列到底有没有均价/成交量"的**纯函数**（不 import react）。
 *
 * 为什么单独放：这些判定既是图表 bug 的根因（缺失被编码成 0 → y 轴被压到 0~4303），
 * 又必须能被断言锁住 —— 塞在 React 组件里就只能靠肉眼。组件与测试共用同一份实现。
 *
 * 口径：
 *  - `avg`（当日均价/VWAP）**不可能 ≤ 0**：`null`/`0`/负数都不是有效值 ⇒ 不画、也不进坐标域。
 *    老版本宿主会把"没有均价"回成 0，所以这里不只看 `null`，也挡掉非正值（纵深防御）。
 *  - 成交量/成交额按**整条序列**判："有没有这个字段"，而不是逐点抹零（安静的分钟真的可能是 0）。
 */

/** 有效均价：不是 `null`、且 `> 0`（真实 VWAP 不可能为 0 或负） */
export function isUsableAvg(v: number | null | undefined): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0
}

/** 这条序列到底有没有成交量数据（全 `null` ⇒ 该市场不提供，界面应明说而不是画一条假量） */
export function hasVolumeSeries(vols: readonly (number | null | undefined)[]): boolean {
  return vols.some((v) => typeof v === 'number' && Number.isFinite(v) && v > 0)
}

/**
 * 主图纵轴域。只由**有效**价格与**有效**均价（+ 昨收基准线）决定；
 * 均价缺失时域就等于价格域 —— 这正是"国际指数/外盘商品被压成平线"的修复点。
 *
 * `pad` 与原实现一致：上下各留 6% 的呼吸位；全程无波动时给 ±1 兜底（避免除以 0）。
 */
export function trendScale(
  values: readonly number[],
  avgs: readonly (number | null | undefined)[] = [],
  baseline?: number | null,
): { lo: number; hi: number } {
  const candidates: number[] = []
  for (const v of values) if (typeof v === 'number' && Number.isFinite(v)) candidates.push(v)
  for (const v of avgs) if (isUsableAvg(v)) candidates.push(v)
  if (typeof baseline === 'number' && Number.isFinite(baseline)) candidates.push(baseline)
  if (candidates.length === 0) return { lo: -1, hi: 1 }
  const min = Math.min(...candidates)
  const max = Math.max(...candidates)
  const pad = (max - min) * 0.06 || 1
  return { lo: min - pad, hi: max + pad }
}
