/**
 * 多日分时的**本地拼接**（不 import react，纯函数）。
 *
 * 背景：`五日` 此前只走新浪/腾讯 5 分钟 K 线，而这两家**只覆盖沪/深** ——
 * 港股、国际指数、外盘商品、期货都没有多日分钟源。于是本插件改为把**每日成功取到的分时按日归档**，
 * 需要多日时本地拼接（从本版起累积，一天一天变多）。
 *
 * 三条不许（写在类型与实现里，不靠注释口头保证）：
 *  1) 不许假装立刻给出五日 —— 归档里没有的日子就**如实列进 `missing`**，不补；
 *  2) 不许用日K冒充分时 —— 输入只有分时点 `TrendPoint`，本模块不接触 K 线；
 *  3) 不许凭空补齐 —— 拼接结果只含实际归档到的点，覆盖报告与点是同一批数据算出来的。
 */
import type { TrendCoverage, TrendPoint } from './model.ts'

export interface StitchDayInput {
  /** `YYYY-MM-DD`（北京时间的交易日） */
  day: string
  points: readonly TrendPoint[]
}

/** 覆盖报告的形状来自 shared/model.ts（回包与界面共用同一份定义，避免两处字段漂移） */
export type StitchCoverage = TrendCoverage

export interface StitchResult {
  /** 连续拼接后的点（按日期、再按时间升序） */
  points: TrendPoint[]
  /** 日分隔线位置：`points[breaks[i]]` 是某一天的第一个点 */
  breaks: number[]
  coverage: StitchCoverage
}

/** 一天至少要有这么多个点才算"有这一天"（1 个点看不出走势，也与"空序列不计入"一致） */
export const STITCH_MIN_POINTS_PER_DAY = 2

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/

/** `YYYY-MM-DD` → 该日的 UTC 毫秒（只用于日期差值；不参与展示口径） */
function dayMs(day: string): number {
  return Date.parse(`${day}T00:00:00Z`)
}

function msToDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10)
}

/** 周一~周五（没有交易日历，只能粗筛；节假日由调用方在文案里说明） */
function isWeekday(day: string): boolean {
  const wd = new Date(dayMs(day)).getUTCDay()
  return wd >= 1 && wd <= 5
}

/**
 * 拼接若干"单日序列"。
 *
 * - 日期升序；**同一天只保留一份**（重复传入时取最后一个 —— 调用方按"后到的更完整"覆盖写盘，
 *   因此后传入的就是更新的那份）；
 * - 空序列 / 点不足 2 个的日期不计入覆盖；
 * - `missing` 只列**工作日**（见 `StitchCoverage.missing` 的说明），升序、不补。
 */
export function stitchTrendDays(
  days: readonly StitchDayInput[],
  opts: { limitDays?: number; today?: string } = {},
): StitchResult {
  const limit = Math.max(1, Math.round(opts.limitDays ?? 5))
  const today = opts.today !== undefined && DAY_RE.test(opts.today) ? opts.today : undefined

  // 同一天只留一份（后传入的覆盖先传入的）
  const byDay = new Map<string, TrendPoint[]>()
  for (const d of days) {
    if (!DAY_RE.test(d.day)) continue
    const pts = d.points.filter((p) => typeof p.price === 'number' && Number.isFinite(p.price) && p.price > 0)
    byDay.set(d.day, pts.map((p) => ({ ...p })))
  }

  const have = [...byDay.entries()]
    .filter(([, pts]) => pts.length >= STITCH_MIN_POINTS_PER_DAY)
    .map(([day]) => day)
    .sort()

  const points: TrendPoint[] = []
  const breaks: number[] = []
  for (const day of have) {
    const pts = (byDay.get(day) ?? []).slice().sort((a, b) => a.t - b.t)
    if (pts.length === 0) continue
    breaks.push(points.length)
    for (const p of pts) points.push(p)
  }

  // 覆盖范围：从最早有数据的那天到"今天（若有）或最晚那天"，只数工作日
  const missing: string[] = []
  if (have.length > 0) {
    const first = have[0]
    const lastDay = have[have.length - 1]
    const end = today !== undefined && dayMs(today) > dayMs(lastDay) ? today : lastDay
    const haveSet = new Set(have)
    for (let ms = dayMs(first); ms <= dayMs(end); ms += 86_400_000) {
      const day = msToDay(ms)
      if (!isWeekday(day) || haveSet.has(day)) continue
      missing.push(day)
    }
  }

  return { points, breaks, coverage: { have, missing, limit } }
}
