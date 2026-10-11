/**
 * 五日档口径行的**诚实化**（纯函数）：滞后优先 + 归档天数 + 缺口短形 + 陈旧提示。
 *
 * 背景：`122.XAU` 的本地归档只有 **09-24 一天**，而今天已是 10-11 ⇒ 用户读到「五日」会以为
 * "这是最近五日的走势"。问题不在缺数据（缺就给原因），而在**呈现顺序**：让"数据是 17 天前的快照"
 * 这件事排在最前面说出来。
 *
 * 陈旧判据（如实说明是近似）：没有交易日历，所以用"自然日差 + 工作日近似"：
 * 从最新数据日到现在的**工作日数** ≥ 2 就算陈旧（周末自然日差不误报）。
 * 图表本身不做任何美化：不插值、不延长，且**不因为陈旧就不显示**（看历史快照是合理需求）。
 */
import { missingBrief } from './trendStitch.ts'

/** 陈旧阈值：近似工作日数 ≥ 2 */
export const STALE_APPROX_WORKDAYS = 2

export interface TrendCaliberInput {
  /** 数据最新一点的日期（`MM-DD` 或 `YYYY-MM-DD`；取日期部分即可） */
  lastDay: string | null
  now: number
  /** 归档到的天数 */
  have: number
  /** 档位上限（五日 = 5） */
  limit: number
  /** 缺口日期（短标签，如 `09-25`） */
  missing: readonly string[]
  /** 最近一次成功快照的显示时刻（如 `09-24 13:41`）；拿不到给 null */
  snapshotAt: string | null
}

export interface TrendCaliber {
  stale: boolean
  naturalDays: number
  approxWorkdays: number
  /** 滞后前缀（不陈旧 ⇒ 空串：**非恒输出**） */
  lagPrefix: string
  /** `仅 1 天可画`（have < limit 时给；只有 1 天时必须给） */
  only: string
  /** `归档 1 天（本插件无多日源，逐日累积）` */
  archive: string
  /** `缺 4 天`（短形，不铺日期；无缺口 ⇒ 空串） */
  gaps: string
  /** 陈旧提示一句（不陈旧 ⇒ 空串） */
  staleNote: string
  /** 拼好的口径段（调用方前面自己接档位名与复权口径） */
  text: string
}

const DAY_MS = 86_400_000

/** 解析 `MM-DD`（按 now 的年份）或 `YYYY-MM-DD` ⇒ UTC 天数（用于差值，避开时区漂移） */
export function dayNumberOf(label: string, now: number): number | null {
  const m = /^(?:(\d{4})-)?(\d{2})-(\d{2})/.exec(label.trim())
  if (m === null) return null
  const year = m[1] !== undefined ? Number(m[1]) : new Date(now).getUTCFullYear()
  return Date.UTC(year, Number(m[2]) - 1, Number(m[3]))
}

/** 近似工作日数（跳过周六周日；**没有节假日日历**，所以是近似 —— 如实写进口径） */
export function approxWorkdaysBetween(fromMs: number, toMs: number): number {
  let n = 0
  for (let t = fromMs + DAY_MS; t <= toMs; t += DAY_MS) {
    const dow = new Date(t).getUTCDay()
    if (dow !== 0 && dow !== 6) n += 1
  }
  return n
}

export function trendCaliberOf(input: TrendCaliberInput): TrendCaliber {
  const lastMs = input.lastDay === null ? null : dayNumberOf(input.lastDay, input.now)
  const nowMs = dayNumberOf(
    `${new Date(input.now).toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' })}`,
    input.now,
  )
  const naturalDays = lastMs === null || nowMs === null ? 0 : Math.max(0, Math.round((nowMs - lastMs) / DAY_MS))
  const approxWorkdays = lastMs === null || nowMs === null ? 0 : approxWorkdaysBetween(lastMs, nowMs)
  const stale = lastMs !== null && approxWorkdays >= STALE_APPROX_WORKDAYS
  const snapshot = input.snapshotAt === null ? '' : `（最近一次成功快照 ${input.snapshotAt}）`
  const lagPrefix = stale ? `数据滞后 ${naturalDays} 天${snapshot}` : ''
  // 只有 1 天时必须明说"仅 1 天可画"；不足上限时也给（比"1/5 天"直白，不会被读成"5 天里只取到 1 天"）
  const only = input.have > 0 && input.have < input.limit ? `仅 ${input.have} 天可画` : ''
  const archive = input.have > 0 ? `归档 ${input.have} 天（本插件无多日源，逐日累积）` : ''
  // 短形就是短形：不给它加尾巴（≤40 字），近似日历的说明留在 caliberExplain 里讲一次
  const gaps = missingBrief(input.missing)
  const staleNote = stale ? '陈旧：图表按真实点画，不插值、不延长' : ''
  const parts = [lagPrefix, only, archive, gaps, staleNote].filter((x) => x !== '')
  return {
    stale,
    naturalDays,
    approxWorkdays,
    lagPrefix,
    only,
    archive,
    gaps,
    staleNote,
    text: parts.join(' · '),
  }
}
