/**
 * 为什么必须给区间：`20 个样本的 80%` 与 `500 个样本的 80%` 是完全不同的两件事 ——
 */

/** 95% 双侧区间的标准正态分位数 */
export const Z_95 = 1.959964

export interface Interval {
  /** 点估计（0–1）；n=0 时为 null */
  p: number | null
  /** 下界（0–1） */
  lo: number | null
  /** 上界（0–1） */
  hi: number | null
  /** 样本量 */
  n: number
}

/** 由成功数与样本量算 Wilson 区间（successes 会被裁剪到 [0, n]） */
export function wilsonInterval(successes: number, n: number, z = Z_95): Interval {
  if (!Number.isFinite(n) || n <= 0) return { p: null, lo: null, hi: null, n: 0 }
  const k = Math.max(0, Math.min(n, successes))
  const p = k / n
  const z2 = z * z
  const denom = 1 + z2 / n
  const center = (p + z2 / (2 * n)) / denom
  const half = (z / denom) * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))
  return {
    p,
    lo: Math.max(0, center - half),
    hi: Math.min(1, center + half),
    n,
  }
}

/** 已有点估计时的便捷入口（点估计缺失或有分母问题时返回空区间） */
export function wilsonFromRate(rate: number | null, n: number, z = Z_95): Interval {
  if (rate === null || !Number.isFinite(rate) || n <= 0) return { p: rate, lo: null, hi: null, n: Math.max(0, n) }
  return wilsonInterval(rate * n, n, z)
}

/**
 * 区间是否有意义。`n < 30` 视为样本不足：此时区间宽到能同时容纳"有效"与"无效"，
 * 结论不该被当成可行动的信息，界面上必须显式标注。
 */
export const SMALL_SAMPLE_N = 30

export function isSmallSample(n: number): boolean {
  return n < SMALL_SAMPLE_N
}
