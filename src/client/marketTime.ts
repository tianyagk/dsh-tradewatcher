/**
 * 北京时间交易时段判定（纯函数，可单测）。
 *
 * 与宿主 `host/time.ts` 的 `inSession` 同一口径（工作日 09:25–15:05），但这里是**展示层**
 * 需要的粗粒度状态：用来决定"这一屏数据是不是已经定稿"、以及页面上该写「定稿」还是「实时」。
 *
 * 为什么不用 `new Date().getHours()`：那读的是**宿主时区**。浏览器时区可能是 UTC 或任意
 * 时区（用户在国外、或容器里的 headless 浏览器），用本地小时会把收盘后判成盘中。
 * 因此一律按 Asia/Shanghai 取墙上时钟（`shanghaiClock`；`shDateTimeText`/`shClockText`/
 * `shStampText`/`shDayText`/`shToday` 是 v0.76.0 时区批补的同一族格式化）。
 */

export type CnSessionPhase = 'pre' | 'am' | 'noon' | 'pm' | 'closed' | 'weekend'

export interface CnSessionState {
  phase: CnSessionPhase
  /** 该时刻是否可能还在产生新数据（工作日 09:25–15:05） */
  inSession: boolean
  /**
   * 是否已定稿：休市且已过当日 15:05（含周末）。
   * 盘中即使数据有延迟也**不是**定稿 —— 定稿是"不会再变"，延迟是"这次没拿到"。
   */
  settled: boolean
  /** 北京时间 HH:mm */
  hhmm: string
  /** 北京时间的星期（0=周日） */
  weekday: number
}

const OPEN_HHMM = '09:25'
const CLOSE_HHMM = '15:05'

/** 取北京时间墙上时钟（用 Intl 而不是本地 getX，理由见文件头） */
export function shanghaiClock(now: number): { hhmm: string; weekday: number } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    hour12: false,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(new Date(now))
  const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? ''
  const hour = get('hour') === '24' ? '00' : get('hour')
  const hhmm = `${hour.padStart(2, '0')}:${get('minute').padStart(2, '0')}`
  const wd = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(get('weekday'))
  return { hhmm, weekday: wd === -1 ? new Date(now).getUTCDay() : wd }
}

export function cnSessionState(now: number = Date.now()): CnSessionState {
  const { hhmm, weekday } = shanghaiClock(now)
  if (weekday === 0 || weekday === 6) {
    return { phase: 'weekend', inSession: false, settled: true, hhmm, weekday }
  }
  if (hhmm < OPEN_HHMM) return { phase: 'pre', inSession: false, settled: true, hhmm, weekday }
  if (hhmm < '11:30') return { phase: 'am', inSession: true, settled: false, hhmm, weekday }
  if (hhmm < '13:00') return { phase: 'noon', inSession: false, settled: false, hhmm, weekday }
  if (hhmm <= CLOSE_HHMM) return { phase: 'pm', inSession: true, settled: false, hhmm, weekday }
  return { phase: 'closed', inSession: false, settled: true, hhmm, weekday }
}

/** 固定北京时间的格式化器（`timeZone` 写死 ⇒ 与浏览器时区无关） */
let shFmt: Intl.DateTimeFormat | null = null
function shFormatter(): Intl.DateTimeFormat {
  if (shFmt === null) {
    shFmt = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Shanghai',
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
  }
  return shFmt
}

function shParts(ts: number): (type: string) => string {
  const parts = shFormatter().formatToParts(new Date(ts))
  return (type) => parts.find((x) => x.type === type)?.value ?? ''
}

/**
 * 北京时间的 `YYYY-MM-DD HH:mm:ss`。
 *
 * ⚠ 这是**市场数据时刻**的唯一出口：所有"数据时刻"族展示都必须走这里。
 * 直接用 `toLocaleString('zh-CN')` / `getHours()` 会按**浏览器时区**渲染 ——
 * 复核里同一 epoch 在 UTC 下显示 01:42、纽约 21:42、悉尼 12:42（用户看到的"数据时刻"与市场无关）。
 */
export function shDateTimeText(ts: number): string {
  const g = shParts(ts)
  const hh = g('hour') === '24' ? '00' : g('hour')
  return `${g('year')}-${g('month')}-${g('day')} ${hh}:${g('minute')}:${g('second')}`
}

/** 北京时间的 `HH:mm:ss` */
export function shClockText(ts: number): string {
  return shDateTimeText(ts).slice(11)
}

/** 北京时间的 `MM-DD HH:mm` */
export function shStampText(ts: number): string {
  return shDateTimeText(ts).slice(5, 16)
}

/** 北京时间某时刻所在的自然日 `YYYY-MM-DD` */
export function shDayText(ts: number): string {
  return shDateTimeText(ts).slice(0, 10)
}

/** 北京时间的今天 `YYYY-MM-DD`（日历"今天"高亮 / 即将发生用它，不用浏览器本地日） */
export function shToday(now: number = Date.now()): string {
  return shDayText(now)
}

export const CN_PHASE_LABEL: Record<CnSessionPhase, string> = {
  pre: '开盘前',
  am: '上午盘中',
  noon: '午休',
  pm: '下午盘中',
  closed: '已收盘',
  weekend: '周末休市',
}
