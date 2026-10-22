/**
 * **美股周/月/年 K：由日线聚合**（纯函数，无 IO）与**拆股标注**。
 *
 * 为什么是聚合而不是"上游原生"：美股上游（新浪 `US_MinKService.getDailyK`）**只有日线**；
 * 腾讯的 `fqkline` 对美股只回 2 根"首尾"（见 `docs/AUDIT-IMPL68.md` §3.3）。用户裁决：
 * 三档改由日线聚合提供，但**口径必须写明**「由日线聚合（非上游原生…）」。
 *
 * ⚠ v0.129.0 起，**聚合实现搬到 `klineAggregate.ts`**（A股/ETF/指数/板块 的"日线兜底"复用同一份，
 * 不允许两份各写一套）。本文件只保留美股**特有**的两件事：
 *   ① 口径句 `usAggCaliber`（未复权 + 拆股计数）；
 *   ② 拆股/合股检测与"聚合根定位"（`detectUsSplits` / `splitMarksOf`）。
 * 下面 `usBucketOf` / `aggregateUsDaily` 是**别名**（历史调用方与断言继续按原名引用同一份实现）。
 *
 * 三条不许（写成类型与断言，不靠注释口头保证）：
 *  1) **不许伪造调整**：日线是**未复权**原始价（实测 AAPL 拆股日 499.23→129.04），聚合只是把
 *     相邻日子的 O/H/L/C 归并，**不改任何价格**；拆股断层如实标出来（`detectUsSplits`）。
 *  2) **不许用别的周期冒充**：聚合只做 O/H/L/C 的首/极值/末 + 量额求和，不做插值、不做补齐。
 *  3) **不许 0 顶替**：某一根日线的 `vol`/`amount` 缺失 ⇒ 该聚合根的对应字段记 **null**。
 *
 * 时间口径：日线的 `date` 是**美东交易日**（新浪的 `d`）；分组用纯日历算术（`Date.UTC`），
 * **与宿主 `TZ` 无关**，也**不会**被北京日历日挪一天。
 */

import { AGG_NOTE, aggBucketOf, aggregateDaily, type AggPeriod } from './klineAggregate.ts'

/** 美股聚合周期（与通用聚合器同一类型） */
export type UsAggPeriod = AggPeriod

/** 自然周/月/年键（实现见 `klineAggregate.aggBucketOf`：周一为一周起点，月/年按日历） */
export const usBucketOf = aggBucketOf

/** 日线 → 周/月/年（实现见 `klineAggregate.aggregateDaily`；量额缺失 ⇒ 该根 null，不 0 相加） */
export const aggregateUsDaily = aggregateDaily

/**
 * 美股聚合档的口径句。
 * ⚠ 与通用 `AGG_NOTE` **必须是同一句**（同一个事实只许有一种写法）：v0.129.0 起由
 * `klineAggregate.AGG_NOTE` 单一来源产出，这里只追加美股特有的未复权与拆股信息。
 */
export const US_AGG_NOTE = AGG_NOTE
export const US_RAW_NOTE = '美股日线为未复权原始价：拆股/分红未调整'

/** 拆股检测阈值：相邻日收盘变动 ≥25% 才算"可疑"，且必须接近常见拆合股比 */
export const US_SPLIT_MIN_MOVE = 0.25
/** 常见拆合股比（收盘价之比：拆股 <1，合股 >1） */
export const US_SPLIT_RATIOS: readonly number[] = [1 / 20, 1 / 10, 1 / 5, 1 / 4, 1 / 3, 1 / 2, 2, 3, 4, 5, 10, 20]
/** 比值容差（相对误差）：8% 足够容纳"拆股日还有正常涨跌"，又窄到不会把普通暴跌算成拆股 */
export const US_SPLIT_TOLERANCE = 0.08

/** 一处疑似拆股/合股（`factor` = 当日收盘 ÷ 前一日收盘） */
export interface UsSplit {  /** 断层发生的交易日（美东日期） */
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
