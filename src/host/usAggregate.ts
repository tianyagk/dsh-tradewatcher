/**
 * **美股周/月/年 K：由日线聚合**（纯函数，无 IO）。
 *
 * 为什么是聚合而不是"上游原生"：美股上游（新浪 `US_MinKService.getDailyK`）**只有日线**；
 * 腾讯的 `fqkline` 对美股只回 2 根"首尾"（见 `docs/AUDIT-IMPL68.md` §3.3）。用户裁决：
 * 三档改由日线聚合提供，但**口径必须写明**「由日线聚合（非上游原生…）」。
 *
 * 三条不许（写成类型与断言，不靠注释口头保证）：
 *  1) **不许伪造调整**：日线是**未复权**原始价（实测 AAPL 拆股日 499.23→129.04），聚合只是把
 *     相邻日子的 O/H/L/C 归并，**不改任何价格**；拆股断层如实标出来（`detectUsSplits`），
 *     绝不为"看起来连续"去做隐形复权。
 *  2) **不许用别的周期冒充**：聚合只做 O/H/L/C 的首/极值/末 + 量额求和，不做插值、不做补齐。
 *  3) **不许 0 顶替**：某一根日线的 `vol`/`amount` 缺失 ⇒ 该聚合根的对应字段记 **null**（不是把 null 当 0 相加）。
 *
 * 时间口径：日线的 `date` 是**美东交易日**（新浪的 `d`；实测末根 `2026-10-16` = 周五 ET，
 * 若按北京日期会写成 10-17）。因此"自然周/月/年"直接用这些日期字符串分组 ——
 * 分组用的是纯日历算术（`Date.UTC`），**与宿主 `TZ` 无关**，也**不会**被北京日历日挪一天。
 */

import type { DayBar } from '../shared/model.ts'

export type UsAggPeriod = 'week' | 'month' | 'year'

/** 界面/工具共用的口径句（断言会检查这两句必须出现） */
export const US_AGG_NOTE = '由日线聚合（非上游原生周线/月线/年线）'
export const US_RAW_NOTE = '美股日线为未复权原始价：拆股/分红未调整'

/** 拆股检测阈值：相邻日收盘变动 ≥25% 才算"可疑"，且必须接近常见拆合股比 */
export const US_SPLIT_MIN_MOVE = 0.25
/** 常见拆合股比（收盘价之比：拆股 <1，合股 >1） */
export const US_SPLIT_RATIOS: readonly number[] = [1 / 20, 1 / 10, 1 / 5, 1 / 4, 1 / 3, 1 / 2, 2, 3, 4, 5, 10, 20]
/** 比值容差（相对误差）：8% 足够容纳"拆股日还有正常涨跌"，又窄到不会把普通暴跌算成拆股 */
export const US_SPLIT_TOLERANCE = 0.08

/**
 * 自然周/月/年键。
 *   - 周：该日所在自然周的**周一**（`YYYY-MM-DD`）；
 *   - 月：`YYYY-MM`；年：`YYYY`。
 * 只用 `Date.UTC` 做日历算术（`getUTCDay`），因此与宿主时区无关。
 */
export function usBucketOf(date: string, period: UsAggPeriod): string {
  const [y, m, d] = date.split('-').map(Number)
  if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) return date
  if (period === 'month') return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}`
  if (period === 'year') return String(y).padStart(4, '0')
  const utc = Date.UTC(y, m - 1, d)
  const wd = new Date(utc).getUTCDay() // 0 = 周日
  const monday = new Date(utc - ((wd + 6) % 7) * 86_400_000)
  return `${monday.getUTCFullYear()}-${String(monday.getUTCMonth() + 1).padStart(2, '0')}-${String(monday.getUTCDate()).padStart(2, '0')}`
}

/** 聚合后的一根：`date` = **该周/月/年的首个交易日**（稳定，便于按日期合并缓存），`from/to` = 覆盖的日线区间 */
export interface UsAggBar extends DayBar {
  from: string
  to: string
  /** 覆盖的日线根数（"这周只有 3 个交易日"这类事实，界面/工具可读） */
  sessions: number
}

/**
 * 日线 → 周/月/年（自然周/月/年，按美东交易日日期分组）。
 *
 * 每根：`open` = 首根 open、`high` = 最高、`low` = 最低、`close` = 末根 close；
 * `vol`/`amount` = **求和**，但只要有**任一日线缺失该字段**，该聚合根就记 **null**（不把 null 当 0）。
 * `pct` = 相对**上一根聚合收盘**的涨跌幅（首根为 null）。
 */
export function aggregateUsDaily(daily: readonly DayBar[], period: UsAggPeriod): UsAggBar[] {
  const out: UsAggBar[] = []
  let cur: UsAggBar | null = null
  let curKey = ''
  let volSum = 0
  let volMissing = false
  let amtSum = 0
  let amtMissing = false
  let sessions = 0
  const flush = (): void => {
    if (cur === null) return
    cur.vol = volMissing ? null : volSum
    cur.amount = amtMissing ? null : amtSum
    cur.sessions = sessions
    out.push(cur)
  }
  for (const b of daily) {
    const key = usBucketOf(b.date, period)
    if (cur === null || key !== curKey) {
      flush()
      cur = {
        date: b.date, open: b.open, close: b.close, high: b.high, low: b.low,
        vol: null, pct: null, amount: null, from: b.date, to: b.date, sessions: 0,
      }
      curKey = key
      volSum = 0
      volMissing = false
      amtSum = 0
      amtMissing = false
      sessions = 0
    } else {
      cur.high = Math.max(cur.high, b.high)
      cur.low = Math.min(cur.low, b.low)
      cur.close = b.close
      cur.to = b.date
    }
    sessions += 1
    if (typeof b.vol === 'number' && Number.isFinite(b.vol)) volSum += b.vol
    else volMissing = true
    const amt = typeof b.amount === 'number' && Number.isFinite(b.amount) ? b.amount : null
    if (amt === null) amtMissing = true
    else amtSum += amt
  }
  flush()
  for (let i = 0; i < out.length; i += 1) {
    const prev = i > 0 ? out[i - 1].close : null
    out[i].pct = prev !== null && prev > 0 ? Math.round(((out[i].close - prev) / prev) * 10000) / 100 : null
  }
  return out
}

/** 一处疑似拆股/合股（`factor` = 当日收盘 ÷ 前一日收盘） */
export interface UsSplit {
  /** 断层发生的交易日（美东日期） */
  day: string
  prevClose: number
  close: number
  /** close / prevClose：拆股 < 1，合股 > 1 */
  factor: number
  /** 人话标签：`4:1 拆股` / `1:5 合股` */
  label: string
}

/**
 * 检测相邻交易日的**疑似拆股/合股**。
 *
 * 判据（两条同时满足）：① `|close/prevClose − 1| ≥ 25%`；② 比值落在常见拆合股比附近（相对误差 ≤ 8%）。
 * 为什么是"疑似"：暴跌/暴涨也会让①成立，只有②把它压到"像拆股"的形状；但真实世界里拆股当天
 * 还会叠加正常涨跌，所以②给了容差 ⇒ 结论只能是**疑似**，不能断言"就是拆股"。
 */
export function detectUsSplits(daily: ReadonlyArray<{ date: string; close: number }>): UsSplit[] {
  const out: UsSplit[] = []
  for (let i = 1; i < daily.length; i += 1) {
    const prev = daily[i - 1].close
    const cur = daily[i].close
    if (!(prev > 0) || !(cur > 0)) continue
    const factor = cur / prev
    if (Math.abs(factor - 1) < US_SPLIT_MIN_MOVE) continue
    const hit = US_SPLIT_RATIOS.find((r) => Math.abs(factor - r) / r <= US_SPLIT_TOLERANCE)
    if (hit === undefined) continue
    out.push({ day: daily[i].date, prevClose: prev, close: cur, factor, label: hit < 1 ? `${Math.round(1 / hit)}:1 拆股` : `1:${Math.round(hit)} 合股` })
  }
  return out
}

/** 图表上要标注的那一根：把拆股日映射到它所属的聚合根 */
export interface UsSplitMark {
  /** 聚合根的 `date`（图表按它定位；日线档就是断层当天） */
  date: string
  /** 断层发生的交易日 */
  day: string
  label: string
}

/**
 * 把拆股日映射到它所属的聚合根。
 * ⚠ 旧缓存文件里的聚合根可能**没有** `from/to`（本版之前的文件）：那时退化成"按同一天匹配"，
 * 标记仍会出现（只是可能落在该周的某根上），不会静默消失。
 */
export function splitMarksOf(
  splits: readonly UsSplit[],
  aggs: ReadonlyArray<{ date: string; from?: string; to?: string }>,
): UsSplitMark[] {
  return splits.map((s) => {
    const hit = aggs.find((a) => (a.from ?? a.date) <= s.day && s.day <= (a.to ?? a.date))
    return { date: hit?.date ?? s.day, day: s.day, label: s.label }
  })
}

/**
 * 周/月/年档的**口径句**（界面口径行直接显示；两句必须出现：聚合来源 + 未复权）。
 * 拆股计数也在这里 —— 用户要能一眼看到"这张图里有几处不可比的价格断层"。
 */
export function usAggCaliber(period: UsAggPeriod, splits: readonly UsSplit[]): string {
  const label = period === 'week' ? '周' : period === 'month' ? '月' : '年'
  const split = splits.length === 0
    ? '未检测到疑似拆股/合股'
    : `检测到 ${splits.length} 处疑似拆股/合股（未复权，价差不可比）`
  return `${US_AGG_NOTE}（${label}K）· ${US_RAW_NOTE} · ${split}`
}
