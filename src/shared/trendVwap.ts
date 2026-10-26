/**
 * 分时序列的**逐点累计均价（VWAP）回填**（用户口径 2026-10-26）。
 *
 * 为什么需要：主源（东财 trends2）自带每分钟均价；备用源（新浪 1 分钟）只有成交量、
 * **没有成交额** ⇒ 解析出来 `avg` 全空 ⇒ 均价线缺失、做T 网格没有基准。
 *
 * 两条口径（**逐点累计**，不是拿最后一点单点算）：
 *   · 有 `amount`：`avg = Σamount ÷ Σvolume`（精确，`avgApprox=false`）；
 *   · 无 `amount`：`avg = Σ(典型价 × volume) ÷ Σvolume`，典型价 = (high+low+close)/3（近似，`avgApprox=true`）；
 *   · `volume = 0`：该点 `avg` **沿用前值**（前值为空 ⇒ null）—— 绝不写 0。
 */

export interface VwapPoint {
  t: number
  price: number
  high?: number | null
  low?: number | null
  avg?: number | null
  vol?: number | null
  amount?: number | null
}

export interface VwapResult<T extends VwapPoint> {
  points: T[]
  /** 是否用了"典型价"近似（缺成交额） */
  approx: boolean
  /** 有没有任何一个点算出了 avg */
  hasAvg: boolean
}

const numOrNull = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)

/**
 * 逐点累计回填 `avg`（纯函数；不改入参对象）。
 *
 * `lotSize`：成交量的"每手股数"。A股/ETF 的分钟量是**手**、成交额是**元** ⇒ 必须 `lotSize: 100`
 * （否则 `Σamount ÷ Σvolume` 会算出 100× 的价格，被价格域判据直接丢成 null —— 实测踩过）。
 */
export function backfillTrendAvg<T extends VwapPoint>(
  points: readonly T[],
  opts: { lotSize?: number } = {},
): VwapResult<T> {
  const lot = typeof opts.lotSize === 'number' && Number.isFinite(opts.lotSize) && opts.lotSize > 0 ? opts.lotSize : 1
  let cumVol = 0
  let cumAmount = 0
  let cumTypical = 0
  let prev: number | null = null
  let approx = false
  let hasAvg = false
  const out: T[] = []
  for (const p of points) {
    const vol = numOrNull(p.vol)
    const amount = numOrNull(p.amount)
    const price = numOrNull(p.price)
    let avg: number | null = null
    const given = numOrNull(p.avg)
    if (given !== null && given > 0) {
      // 上游已经给了均价（东财 f58 / 新浪全球期货）：**以它为准**，不重算、不算近似
      avg = given
    } else if (vol !== null && vol > 0 && price !== null && price > 0) {
      cumVol += vol
      if (amount !== null && amount > 0) {
        cumAmount += amount
        avg = cumAmount / (cumVol * lot)
      } else {
        const high = numOrNull(p.high) ?? price
        const low = numOrNull(p.low) ?? price
        const typical = (high + low + price) / 3
        cumTypical += typical * vol
        avg = cumTypical / cumVol
        approx = true
      }
    } else {
      // volume = 0 / 缺失：沿用前值（前值为空就是 null —— 不写 0）
      avg = prev
    }
    if (avg !== null && Number.isFinite(avg) && avg > 0) {
      prev = avg
      hasAvg = true
    } else {
      avg = prev
    }
    out.push({ ...p, avg })
  }
  return { points: out, approx, hasAvg }
}

/** 序列里**最后一个非空**的 avg（做T 网格的基准；全无 ⇒ null） */
export function lastAvgOf(points: ReadonlyArray<{ avg?: number | null }>): number | null {
  for (let i = points.length - 1; i >= 0; i -= 1) {
    const v = points[i]?.avg
    if (typeof v === 'number' && Number.isFinite(v) && v > 0) return v
  }
  return null
}
