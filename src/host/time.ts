/**
 * 统一时区工具（**唯一口径：Asia/Shanghai**）。
 *
 * 为什么必须钉死：本插件判断"是否在交易时段""当前处于哪个阶段""今天是哪一天"
 * 全都基于墙上时钟。此前 rescue.ts / calendar.ts 用宿主本地时间
 * （`new Date(ts).getHours()` 等），而 portfolio.ts 用 `Intl.DateTimeFormat('Asia/Shanghai')`
 * —— 同一插件内两套口径并存。
 *
 * 实测后果（TZ=UTC，Docker / 云主机 / CI 的默认值）：
 *   北京时间 10:00（真实盘中）→ inTradingWindow=false、phase='pre'
 *   → **护盘采样一次都不触发**；反而在北京时间 17:25–19:35 / 20:55–23:05 采样，
 *     且时点系数、阶段语义、脉冲锚点全部错位（晚间盘面按"早盘"给 0.4 折）。
 *
 * 因此所有时间标签一律走本模块，且回归断言必须在 TZ=UTC 与 TZ=Asia/Shanghai
 * 两个环境下都成立（见 src/host/time.test.ts 与 npm test 的双 TZ 跑法）。
 */
const SH_TZ = 'Asia/Shanghai'

let partsFmt: Intl.DateTimeFormat | null = null

function formatter(): Intl.DateTimeFormat {
  if (partsFmt === null) {
    partsFmt = new Intl.DateTimeFormat('en-CA', {
      timeZone: SH_TZ,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    })
  }
  return partsFmt
}

export interface ShanghaiParts {
  /** YYYY-MM-DD（北京） */
  day: string
  /** HH:mm（北京，24 小时制） */
  hhmm: string
  /** 当日已过分钟数（北京，0–1439） */
  minutes: number
}

/** 把任意 epoch ms 拆成"北京时间的日期与时刻" */
export function shanghaiParts(ts: number): ShanghaiParts {
  const parts = formatter().formatToParts(new Date(ts))
  let year = ''
  let month = ''
  let day = ''
  let hour = ''
  let minute = ''
  for (const p of parts) {
    if (p.type === 'year') year = p.value
    else if (p.type === 'month') month = p.value
    else if (p.type === 'day') day = p.value
    else if (p.type === 'hour') hour = p.value
    else if (p.type === 'minute') minute = p.value
  }
  const hh = hour === '24' ? '00' : hour
  const hhmm = `${hh}:${minute}`
  return { day: `${year}-${month}-${day}`, hhmm, minutes: Number(hh) * 60 + Number(minute) }
}

/** HH:mm（北京时间） */
export function hhmmOf(ts: number): string {
  return shanghaiParts(ts).hhmm
}

/** YYYY-MM-DD（北京时间的自然日） */
export function dayOf(ts: number): string {
  return shanghaiParts(ts).day
}

/** 北京时间的今天（可偏移天数）——财经日历等"今日/±N 天"标签共用 */
export function calToday(offsetDays = 0): string {
  return dayOf(Date.now() + offsetDays * 86_400_000)
}

/**
 * 北京时间的星期（0=周日 … 6=周六）。
 * 注意不能用 `new Date(ts).getDay()` —— 那是**宿主时区**的星期：
 * 例如北京时间周一 10:00 在 TZ=America/New_York 下是周日 22:00，
 * 会把真实交易日判成非交易日。
 */
export function weekdayOf(ts: number): number {
  const [y, m, d] = shanghaiParts(ts).day.split('-').map(Number)
  // 用 Date.UTC 构造"该日历日的 00:00"，其 getUTCDay 即该日的星期（不会再被时区偏移一天）
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay()
}

/** 北京时间某日 00:00 对应的 epoch ms */
export function shanghaiDayStart(ts: number): number {
  // 北京无夏令时，固定 +08:00 —— 与 Intl 口径一致且更快
  const { day } = shanghaiParts(ts)
  return Date.parse(`${day}T00:00:00+08:00`)
}

/** 收盘时刻（北京时间 15:05，沪深连续竞价的最后一分钟之后） */
const CLOSE_HHMM = '15:05'
/** 开盘时刻（北京时间 09:25，集合竞价结束） */
const OPEN_HHMM = '09:25'

/**
 * 现在是否处于交易时段（工作日 09:25–15:05，北京时间）。
 *
 * 用途是**粗略判断"上游会不会有新数据"**，决定 kline/trend 要不要回源；
 * 精确的护盘采样窗口另有 `rescue.inTradingWindow`（含午休、尾盘切换）。
 * 因此这里只关心"是否可能还在生成新 bar"，宁可判 true（多回源一次）也不漏。
 */
export function inSession(ts: number = Date.now()): boolean {
  const wd = weekdayOf(ts)
  if (wd === 0 || wd === 6) return false
  const { hhmm } = shanghaiParts(ts)
  return hhmm >= OPEN_HHMM && hhmm < CLOSE_HHMM
}

/**
 * 最近一次"收盘定稿"时刻（北京时间 15:05）的 epoch ms。
 *
 * 休市期间上游不会产生新 bar：只要本地缓存的更新时间晚于该时刻，
 * 就说明这一根收盘 bar 已经落袋，可以**完全跳过回源**（0 请求）。
 * 周末/周一早盘会一直回溯到上一个工作日的 15:05。
 */
export function lastCloseBoundary(ts: number = Date.now()): number {
  const parts = shanghaiParts(ts)
  // 先取"今天 15:05"（北京无夏令时：UTC+8 → 当日 07:05Z）
  let day = parts.day
  if (parts.hhmm < CLOSE_HHMM) {
    day = dayOf(shanghaiDayStart(ts) - 86_400_000)
  }
  for (let guard = 0; guard < 10; guard += 1) {
    // 必须用 weekdayOf（按北京日历日）——`new Date(day+'T00:00:00+08:00').getUTCDay()`
    // 拿到的是"该日 00:00 北京"换算到 UTC 前一天的星期，整体偏一天
    const wd = weekdayOf(Date.parse(`${day}T00:00:00+08:00`))
    if (wd !== 0 && wd !== 6) break
    day = dayOf(Date.parse(`${day}T00:00:00+08:00`) - 86_400_000)
  }
  return Date.parse(`${day}T${CLOSE_HHMM}:00+08:00`)
}

/**
 * 休市且本地缓存的更新时间已越过最近一次收盘 → 数据"已定稿"，可以不走上游。
 * 只有 ①休市 ②有缓存 ③缓存晚于最近收盘 三个条件同时成立才算 —— 凌晨/周末/
 * 节假日都成立，盘中永远不成立（回源逻辑保持原样）。
 */
export function isSettledOffline(cacheUpdatedAt: number, ts: number = Date.now()): boolean {
  if (inSession(ts)) return false
  if (!Number.isFinite(cacheUpdatedAt) || cacheUpdatedAt <= 0) return false
  return cacheUpdatedAt >= lastCloseBoundary(ts)
}
