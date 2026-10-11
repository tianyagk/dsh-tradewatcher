/**
 * 筹码区块的**纯**视图逻辑（不 import react ⇒ 能在 node 里断言）。
 */
export interface ChipsViewState {
  data: unknown
  error: string | null
  loading: boolean
}

/**
 * 日期滑杆索引的边界收敛：0 / N−1 / 越界都收敛到 `[0, N−1]`；空序列 ⇒ −1（界面据此不渲染滑杆）。
 */
export function clampIndex(index: number, length: number): number {
  if (length <= 0) return -1
  if (!Number.isFinite(index)) return length - 1
  return Math.min(length - 1, Math.max(0, Math.round(index)))
}

/** 筹码分布的纵轴刻度：取 3–5 个均匀刻度覆盖 [lo, hi]（含两端），与横条逐行对齐用 */
export function axisTicks(centers: readonly number[], max = 5): number[] {
  const n = centers.length
  if (n === 0) return []
  const tickCount = Math.min(max, Math.max(3, n))
  const lo = centers[0]
  const hi = centers[n - 1]
  if (!(hi > lo)) return [lo]
  return Array.from({ length: tickCount }, (_, i) => lo + ((hi - lo) * i) / (tickCount - 1))
}

/**
 * 口径**是否偏离默认**（偏离才给一行原因；正常情况一个字都不显示）。
 * 默认 = A股/深沪 + 有 floatMv + 支持前复权 + 样本够 ⇒ 换手率衰减 k=1.5、三角形、近 45 日。
 */
export function caliberDeviates(input: {
  decay: 'turnover' | 'half-life'
  decayReason: string | null
  fqSupported: boolean
  why: string | null
  samples: number
  window: number
}): string | null {
  if (input.why !== null) return input.why
  if (!input.fqSupported) return '该标的不支持前复权（指数/期货/板块）⇒ 不提供筹码分布'
  if (input.decay !== 'turnover') return input.decayReason ?? '按固定半衰期 10 日衰减（经验口径）'
  if (input.samples < input.window) return `只取到近 ${input.samples} 日（不足 ${input.window} 日）——历史越长越准`
  return null
}

/**
 * 横坐标刻度用的 **nice step**（随峰值自适应）：1/2/2.5/5 × 10^n。
 * 返回值是"占总筹码比例"的步长（0–1）。
 */
export function niceStep(peak: number, wantTicks = 5): number {
  const p = Number.isFinite(peak) && peak > 0 ? peak : 0
  if (!(p > 0)) return 0
  const raw = p / Math.max(2, wantTicks - 1)
  const mag = 10 ** Math.floor(Math.log10(raw))
  for (const m of [1, 2, 2.5, 5, 10]) {
    if (raw <= m * mag) return m * mag
  }
  return 10 * mag
}

/** 步长决定小数位（**不许出现 0.30000000004** 这类浮点毛刺） */
export function stepDecimals(step: number): number {
  if (!(step > 0)) return 2
  for (let d = 0; d <= 4; d += 1) {
    const scaled = step * 10 ** d
    if (Math.abs(scaled - Math.round(scaled)) < 1e-9) return d
  }
  return 4
}

/**
 * 横坐标刻度（该价位筹码占**总筹码**的比例）：0 起步、nice step 递增，覆盖到峰值。
 * 数量控制在 3–6 之间（nice step 自适应 + 峰值上限）。
 */
export function ratioTicks(peak: number): Array<{ value: number; label: string; pct: number }> {
  const step = niceStep(peak)
  if (!(step > 0)) return []
  const d = stepDecimals(step)
  const top = Math.max(step, Math.ceil((peak + 1e-12) / step) * step)
  const out: Array<{ value: number; label: string; pct: number }> = []
  for (let v = 0; v <= top + 1e-12 && out.length < 6; v += step) {
    const value = Math.round(v / step) * step // 消掉累加误差
    out.push({ value, label: `${(value * 100).toFixed(d === 0 ? 0 : d)}%`, pct: top > 0 ? (value / top) * 100 : 0 })
  }
  if (out.length < 3) out.push({ value: top, label: `${(top * 100).toFixed(d === 0 ? 0 : d)}%`, pct: 100 })
  return out
}

export interface ChipsLine {
  kind: 'avg' | 'resistance' | 'support'
  /** 价格（画线用） */
  price: number
  /** 标签文本 = 该价格（保留两位） */
  label: string
}

/**
 * 三条**语义线**（平均成本 / 压力 P95 / 支撑 P5）。
 *
 * 异常输入（任一值缺失、P95 < P5、非有限数）⇒ 返回空数组（不出线、不抛错）——
 * 不拿默认值硬画一条线出来。
 */
export function chipsLinesOf(day: {
  avgCost: number | null
  support: number | null
  resistance: number | null
}): ChipsLine[] {
  const { avgCost, support, resistance } = day
  if (avgCost === null || support === null || resistance === null) return []
  if (![avgCost, support, resistance].every((v) => Number.isFinite(v))) return []
  if (resistance < support) return []
  return [
    { kind: 'avg', price: avgCost, label: avgCost.toFixed(2) },
    { kind: 'resistance', price: resistance, label: resistance.toFixed(2) },
    { kind: 'support', price: support, label: support.toFixed(2) },
  ]
}

/**
 * 分布图的行高：**96 桶在可用高度里每行 ≥1px**（低于 1px 就按 1px 画，**不许静默丢桶**）。
 */
export function chipsRowHeight(availablePx: number, bucketCount: number): number {
  const n = Math.max(1, Math.round(bucketCount))
  const h = Math.floor((Number.isFinite(availablePx) ? availablePx : 0) / n)
  return Math.max(1, h)
}
