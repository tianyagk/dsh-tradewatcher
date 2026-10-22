/**
 * **周/月/年 K 由日线聚合**（纯函数，无 IO）—— 美股与 A股/ETF/指数/板块**共用这一份实现**。
 *
 * 为什么要有这一层：周/月/年的"原生"数据只有东财 `push2his` 一条链路（腾讯 `fqkline` 对**板块码
 * `90.BK*`、中证指数 `2.*`、商品/期货** 连映射都没有，见 `tencentSymbol`），而东财历史行情主机在本机
 * 长期不可达 ⇒ 用户切「周K/月K/年K」时看到的是「该周期未取到」，**哪怕他手里已经有日线**
 * （日线缓存 / 美股新浪日线）。日线在手却算不出周线，这是**丢数据**，不是"上游没有"。
 *
 * 三条不许（写成类型与断言，不靠注释口头保证）：
 *  1) **不许伪造调整**：日线是什么口径，聚合就什么口径；只把相邻日子的 O/H/L/C 归并，**不改任何价格**。
 *     美股日线是未复权原始价，拆股断层由 `detectUsSplits` 如实标出来（`usAggregate.ts`）。
 *  2) **不许用别的周期冒充**：只做 O/H/L/C 的首/极值/末 + 量额求和，不做插值、不做补齐、
 *     不把"当月只有 3 个交易日"补成 20 天。
 *  3) **不许 0 顶替**：桶内任一日的 `vol`/`amount` 缺失 ⇒ 该桶的对应字段记 **null**
 *     （把 null 当 0 相加会写出一个"成交量为零"的假桶）。
 *
 * 时间口径：分组只用日期的**纯日历算术**（`Date.UTC` + `getUTCDay`），与宿主 `TZ` 无关，
 * 因此 `TZ=UTC` 与 `TZ=Asia/Shanghai` 两轮跑出来的桶完全相同。
 */

import type { DayBar } from '../shared/model.ts'

export type AggPeriod = 'week' | 'month' | 'year'

/** 界面/工具共用的口径句（断言检查「由日线聚合」必须出现） */
export const AGG_NOTE = '由日线聚合（非上游原生周线/月线/年线）'

/** 聚合周期的人话标签（`周K` / `月K` / `年K`） */
export function aggLabel(period: AggPeriod): string {
  return `${period === 'week' ? '周' : period === 'month' ? '月' : '年'}K`
}

/** K 线周期号 → 聚合周期（101 = 日线本身，不聚合） */
export function aggPeriodOfKlt(klt: number): AggPeriod | null {
  return klt === 102 ? 'week' : klt === 103 ? 'month' : klt === 104 ? 'year' : null
}

/**
 * 自然周/月/年键。
 *   - 周：该日所在自然周的**周一**（`YYYY-MM-DD`）；
 *   - 月：`YYYY-MM`；年：`YYYY`。
 * 只用 `Date.UTC` 做日历算术（`getUTCDay`），因此与宿主时区无关。
 */
export function aggBucketOf(date: string, period: AggPeriod): string {
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
export interface AggBar extends DayBar {
  from: string
  to: string
  /** 覆盖的日线根数（"这周只有 3 个交易日"这类事实，界面/工具可读） */
  sessions: number
}

/**
 * 日线 → 周/月/年（自然周/月/年，按交易日日期分组）。
 *
 * 每根：`open` = 首根 open、`high` = 最高、`low` = 最低、`close` = 末根 close；
 * `vol`/`amount` = **求和**，但只要有**任一日线缺失该字段**，该聚合根就记 **null**（不把 null 当 0）。
 * `pct` = 相对**上一根聚合收盘**的涨跌幅（首根为 null；年K 即"同比"，与 `resampleYearly` 同口径）。
 */
export function aggregateDaily(daily: readonly DayBar[], period: AggPeriod): AggBar[] {
  const out: AggBar[] = []
  let cur: AggBar | null = null
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
    const key = aggBucketOf(b.date, period)
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

/**
 * 该不该用日线聚合兜底（纯决策，便于直接断言/注入）。
 *
 * 判据三条同时成立：
 *   ① 这个周期**本身可聚合**（102/103/104，日线自己不聚合）；
 *   ② 该周期的**原生数据一条都没有**（`nativeBars === 0`）—— 原生永远优先，有原生就不用聚合；
 *   ③ 手里有**够用的日线**（≥ `minDailyBars`：少于这个数聚出来的"周"只是几天，不配叫周线）。
 */
export function shouldAggregate(input: {
  klt: number
  nativeBars: number
  dailyBars: number
  minDailyBars: number
}): boolean {
  if (aggPeriodOfKlt(input.klt) === null) return false
  if (input.nativeBars > 0) return false
  return input.dailyBars >= Math.max(1, input.minDailyBars)
}

/**
 * 聚合档的**口径句**（界面口径行直接显示，**只有这一处**，不新增浮层/第二行）。
 *
 * 必须写清两件事：① 这**不是**上游原生周/月/年线；② 日线是从**哪儿**来的、有多少根、截至何时
 * —— 少了②，读者会把"本地 800 根日线聚合出来的周K"读成"上游刚给的周K"。
 */
export function aggCaliberOf(
  period: AggPeriod,
  input: { dailyBars: number; dailyAsOfText: string },
): string {
  return `${AGG_NOTE}（${aggLabel(period)}）· 日线取自本地缓存 ${input.dailyBars} 根（截至 ${input.dailyAsOfText}）`
}
