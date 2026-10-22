/**
 * 为什么必须钉死：本插件判断"是否在交易时段""当前处于哪个阶段""今天是哪一天"
 * 因此所有时间标签一律走本模块，且回归断言必须在 TZ=UTC 与 TZ=Asia/Shanghai
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

/**
 * 解析**市场时钟字符串**（上游给的是北京墙上时间，如 `"2026-10-12 09:31"`）。
 *
 * ⚠ 必须显式写 `+08:00`：`Date.parse('2026-10-12T09:31:00')` **按宿主时区**解释 ——
 * 在 `TZ=UTC` 的 Docker/云主机上，北京 09:31 被读成 09:31Z = 北京 17:31，整整偏 8 小时
 * （复核实测：腾讯分时兜底刻度变成 17:30–23:00、护盘采样回填环整批"未来"点、`inTradingWindow` 命中 0/330）。
 *
 * 上游时间戳一律走这里；本模块以外**不得**再出现无偏移的 `Date.parse` 模板（见 FIX-2-TIMEZONE 排查表）。
 */
export function parseMarketStamp(text: string): number {
  const t = text.trim()
  if (t === '') return Number.NaN
  // 已带明确偏移（Z / ±hh:mm）⇒ 原样交给 Date.parse，不存在宿主时区歧义
  if (/[zZ]$|[+-]\d{2}:?\d{2}$/.test(t)) {
    const iso = Date.parse(t)
    return Number.isFinite(iso) ? iso : Number.NaN
  }
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/.exec(t)
  if (m !== null) return Date.parse(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6] ?? '00'}+08:00`)
  // 兼容 "YYYYMMDDHHmm[ss]" 紧凑写法
  const c = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})?$/.exec(t)
  if (c === null) return Number.NaN
  return Date.parse(`${c[1]}-${c[2]}-${c[3]}T${c[4]}:${c[5]}:${c[6] ?? '00'}+08:00`)
}

/** 固定北京时间（`Asia/Shanghai`）的日期时间格式化器 —— 不受宿主时区影响 */
let stampFmt: Intl.DateTimeFormat | null = null
function zipFormatter(): Intl.DateTimeFormat {
  if (stampFmt === null) {
    stampFmt = new Intl.DateTimeFormat('en-CA', {
      timeZone: SH_TZ,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
  }
  return stampFmt
}

/** 北京时间的 `YYYY-MM-DD HH:mm:ss`（**与宿主时区无关**；工具回包里的"数据时刻"一律用它） */
export function shDateTimeText(ts: number): string {
  const p = zipFormatter().formatToParts(new Date(ts))
  const get = (type: string): string => p.find((x) => x.type === type)?.value ?? ''
  const hh = get('hour') === '24' ? '00' : get('hour')
  return `${get('year')}-${get('month')}-${get('day')} ${hh}:${get('minute')}:${get('second')}`
}

/** 北京时间的 `HH:mm:ss` */
export function shClockText(ts: number): string {
  return shDateTimeText(ts).slice(11)
}

/** 北京时间的 `MM-DD HH:mm` */
export function shStampText(ts: number): string {
  return shDateTimeText(ts).slice(5, 16)
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
 * 交易窗口起点（北京时间 09:15，**集合竞价开始**）。
 *
 * 为什么不是 09:25：09:15–09:25 这十分钟里交易所已经在撮合，**上游会开始产生当日数据**
 * （开盘参考价、集合竞价成交）。把这段判成"休市"就会把昨天的快照当成"今天已定稿"复用，
 * 直到 09:25 才回源 —— 那十分钟里界面显示的是昨天的图（AUDIT-IMPL84 复现的正是这一类）。
 */
const MARKET_WINDOW_OPEN_HHMM = '09:15'

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
 * 现在是否落在**整个交易窗口**内（工作日 09:15–15:05，北京时间）。
 *
 * 与 `inSession` 的差别只有起点：09:15（集合竞价开始）而不是 09:25（集合竞价结束）。
 * 这段窗口只给"能不能判定稿/能不能跳过回源"用 —— 判据必须覆盖集合竞价与收盘瞬时
 * （09:15–09:25、15:00–15:05 上游都还可能给出新数据），午休也照旧算在窗口内
 * （宁多回源一次，不把昨天的图当今天）。
 */
export function inMarketWindow(ts: number = Date.now()): boolean {
  const wd = weekdayOf(ts)
  if (wd === 0 || wd === 6) return false
  const { hhmm } = shanghaiParts(ts)
  return hhmm >= MARKET_WINDOW_OPEN_HHMM && hhmm < CLOSE_HHMM
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

// ── 美东（America/New_York）────────────────────────────────────────────────
//
// 为什么需要单独一组：美股的上游时间戳（腾讯 `us*` 的 `f[30]`、新浪美股日线/分钟的 `d`）
// 都是**美东墙上时间**，而且美股盘（09:30–16:00 ET）与A股盘完全不重叠（北京 21:30–04:00）。
// 把美东当东八区解析会差 12–13 小时（还会被当成"未来时间"）；用"美股收盘"去判断
// "数据是否已定稿"也必须按纽约日历日，不能按北京日历日（跨零点）。
const NY_TZ = 'America/New_York'

let nyFmt: Intl.DateTimeFormat | null = null
function nyFormatter(): Intl.DateTimeFormat {
  if (nyFmt === null) {
    nyFmt = new Intl.DateTimeFormat('en-CA', {
      timeZone: NY_TZ,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
  }
  return nyFmt
}

/** 某一瞬时在纽约的墙上时间（分解；**与宿主时区无关**） */
export function newYorkParts(ts: number): { day: string; hhmm: string; hhmmss: string; weekday: number } {
  const p = nyFormatter().formatToParts(new Date(ts))
  const get = (type: string): string => p.find((x) => x.type === type)?.value ?? ''
  const hour = get('hour') === '24' ? '00' : get('hour')
  const day = `${get('year')}-${get('month')}-${get('day')}`
  const [y, m, d] = day.split('-').map(Number)
  return {
    day,
    hhmm: `${hour}:${get('minute')}`,
    hhmmss: `${hour}:${get('minute')}:${get('second')}`,
    // 用 Date.UTC 构造"该日历日的 00:00"，其 getUTCDay 即该日的星期（不会又被时区挪一天）
    weekday: new Date(Date.UTC(y, m - 1, d)).getUTCDay(),
  }
}

/** 纽约的日历日 `YYYY-MM-DD`（`dayOf` 的纽约版） */
export function usDayOf(ts: number): string {
  return newYorkParts(ts).day
}

/**
 * **美东墙上时间** → epoch ms（`TZ` 无关）。
 *
 * 输入形如 `2026-10-16 16:00:01` / `2026-10-16 09:31` / `2026-10-16T16:00`（秒可省）。
 * 做法：先假设墙上时间就是 UTC，再用 `Intl` 反解"这个瞬时在纽约的墙上时间"，
 * 按差值迭代纠正（夏令时由 `Intl` 自己判定）；最后**校验反解收敛**，
 * 落不回目标墙上时间（例如 DST 跳变里不存在的本地时刻）就返回 `null`，不给错时间。
 */
export function usWallToEpoch(text: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/.exec(text.trim())
  if (m === null) return null
  const wall = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6] ?? '0'))
  const wallOf = (ms: number): number => {
    const p = newYorkParts(ms)
    const [hh, mi, ss] = p.hhmmss.split(':').map(Number)
    const [y, mo, d] = p.day.split('-').map(Number)
    return Date.UTC(y, mo - 1, d, hh, mi, ss)
  }
  let ms = wall
  for (let i = 0; i < 3; i += 1) {
    const drift = wallOf(ms) - wall
    if (drift === 0) break
    ms -= drift
  }
  return wallOf(ms) === wall ? ms : null
}

/** 美股常规交易时段（工作日 09:30–16:00 ET，含收盘那一分钟）；半日市不单独处理 */
export function inUsSession(ts: number = Date.now()): boolean {
  const p = newYorkParts(ts)
  if (p.weekday === 0 || p.weekday === 6) return false
  return p.hhmm >= '09:30' && p.hhmm <= '16:00'
}

/** 最近一次"美股收盘定稿"（纽约 16:05）的 epoch ms（周末回溯到上周五） */
export function lastUsCloseBoundary(ts: number = Date.now()): number {
  const p = newYorkParts(ts)
  // 16:05 ET 的墙上时间 → epoch；没到就退回前一交易日
  let day = p.day
  const afterClose = p.hhmm >= '16:05'
  if (!afterClose) day = usDayOf(Date.parse(`${day}T12:00:00Z`) - 86_400_000)
  for (let guard = 0; guard < 10; guard += 1) {
    const [y, m, d] = day.split('-').map(Number)
    const wd = new Date(Date.UTC(y, m - 1, d)).getUTCDay()
    if (wd !== 0 && wd !== 6) break
    // ⚠ 不用 `toISOString()` 当日界（UTC 日期 ≠ 北京/纽约自然日；全仓有红线扫描守着）
    const prev = new Date(Date.UTC(y, m - 1, d) - 86_400_000)
    day = `${prev.getUTCFullYear()}-${String(prev.getUTCMonth() + 1).padStart(2, '0')}-${String(prev.getUTCDate()).padStart(2, '0')}`
  }
  const at = usWallToEpoch(`${day} 16:05:00`)
  return at === null ? 0 : at
}

/**
 * 美股版"已定稿"：非美股盘中 且 缓存更新晚于最近一次纽约收盘。
 *
 * 为什么不能复用 `isSettledOffline`：它按**北京**日历日与 A股 15:05 收盘判断 ——
 * 美股盘中正好是北京深夜（CN 休市），会被判成"定稿"⇒ 整夜不回源，日线永远停在昨天的柱子。
 */
export function isUsSettledOffline(cacheUpdatedAt: number, ts: number = Date.now()): boolean {
  if (inUsSession(ts)) return false
  if (!Number.isFinite(cacheUpdatedAt) || cacheUpdatedAt <= 0) return false
  const boundary = lastUsCloseBoundary(ts)
  return boundary > 0 && cacheUpdatedAt >= boundary
}

/**
 * 休市且本地缓存的更新时间已越过最近一次收盘 → 数据"已定稿"，可以不走上游。
 * 只有 ①休市 ②有缓存 ③缓存晚于最近收盘 三个条件同时成立才算 —— 凌晨/周末/
 * 节假日都成立，**交易窗口内永远不成立**（回源逻辑保持原样）。
 *
 * ⚠ 判"休市"用的是 `inMarketWindow`（09:15–15:05），不是 `inSession`（09:25–15:05）：
 * 09:15–09:25 集合竞价已经开始产生当日数据，这段里判"定稿"就会把**昨天的快照**当今天复用
 * （AUDIT-IMPL84：真机 09:2x 复用到 09:3x，图上还是昨天的整场）。
 */
export function isSettledOffline(cacheUpdatedAt: number, ts: number = Date.now()): boolean {
  if (inMarketWindow(ts)) return false
  if (!Number.isFinite(cacheUpdatedAt) || cacheUpdatedAt <= 0) return false
  return cacheUpdatedAt >= lastCloseBoundary(ts)
}

/** 北京时间 ISO（含 +08:00）：`2026-10-22T17:12:53+08:00` */
export function beijingIsoOf(ts: number): string {
  const d = new Date(ts + 8 * 3_600_000)
  return `${d.toISOString().slice(0, 19)}+08:00`
}
