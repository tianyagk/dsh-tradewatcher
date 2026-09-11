/**
 * 图表用纯函数指标库（无 React 依赖，便于单独测试）。
 *  - ma / ema / macd：标准算法，MACD 的 HIST 采用国内软件惯例 ×2
 *  - niceTicks：给定区间生成"好看"的纵轴刻度（1/2/5×10^n 步长）
 */

/** 简单移动平均；前 period-1 个为 null。 */
export function ma(values: readonly number[], period: number): Array<number | null> {
  const out: Array<number | null> = new Array(values.length).fill(null)
  if (period <= 0) return out
  let sum = 0
  for (let i = 0; i < values.length; i += 1) {
    sum += values[i]
    if (i >= period) sum -= values[i - period]
    if (i >= period - 1) out[i] = sum / period
  }
  return out
}

/** 指数移动平均；以首个有效值为种子（与主流行情软件一致）。 */
export function ema(values: readonly number[], period: number): number[] {
  const out: number[] = new Array(values.length).fill(0)
  if (values.length === 0) return out
  const k = 2 / (period + 1)
  let prev = values[0]
  out[0] = prev
  for (let i = 1; i < values.length; i += 1) {
    prev = values[i] * k + prev * (1 - k)
    out[i] = prev
  }
  return out
}

export interface MacdSeries {
  dif: number[]
  dea: number[]
  /** (DIF − DEA) × 2 */
  hist: number[]
}

export function macd(closes: readonly number[], fast = 12, slow = 26, signal = 9): MacdSeries {
  if (closes.length === 0) return { dif: [], dea: [], hist: [] }
  const fastE = ema(closes, fast)
  const slowE = ema(closes, slow)
  const dif = fastE.map((v, i) => v - slowE[i])
  const dea = ema(dif, signal)
  const hist = dif.map((v, i) => (v - dea[i]) * 2)
  return { dif, dea, hist }
}

function niceNum(range: number, round: boolean): number {
  const exp = Math.floor(Math.log10(range <= 0 ? 1 : range))
  const frac = (range <= 0 ? 1 : range) / 10 ** exp
  let nice: number
  if (round) {
    if (frac < 1.5) nice = 1
    else if (frac < 3) nice = 2
    else if (frac < 7) nice = 5
    else nice = 10
  } else {
    if (frac <= 1) nice = 1
    else if (frac <= 2) nice = 2
    else if (frac <= 5) nice = 5
    else nice = 10
  }
  return nice * 10 ** exp
}

/** 生成区间内的刻度值（含边界内的"整数"刻度）。 */
export function niceTicks(min: number, max: number, count = 4): number[] {
  if (!Number.isFinite(min) || !Number.isFinite(max) || count < 2) return []
  if (min === max) return [min]
  const step = niceNum((max - min) / (count - 1), true)
  const start = Math.ceil(min / step) * step
  const out: number[] = []
  for (let v = start; v <= max + step * 1e-6 && out.length < count + 2; v += step) {
    out.push(Math.round(v * 1e6) / 1e6)
  }
  return out.length >= 2 ? out : [min, max]
}

/** 数值格式化（刻度/图例共用）：大数少小数、小数多位。 */
export function fmtAxis(v: number): string {
  const a = Math.abs(v)
  if (a >= 1e8) return `${(v / 1e8).toFixed(2)}亿`
  if (a >= 1e4) return `${(v / 1e4).toFixed(2)}万`
  if (a >= 100) return v.toFixed(0)
  if (a >= 1) return v.toFixed(2)
  return v.toFixed(3)
}
