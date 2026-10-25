/**
 * 全球期货交易时钟：**时段配置 + 纯计算**（无 DOM、无 React、无时钟副作用）。
 *
 * 口径（与设计稿 `docs/mockups/global-clock.html` 一致）：
 *  · 表盘是**绝对 24 小时轮盘**：`wheelAngle(ms) = −(UTC 当日分钟 × 0.25°)` ⇒ 角度只取决于绝对时刻，
 *    切换显示时区**不会**改变角度（只改刻度数字与文字时刻）。
 *  · 时段一律按**交易所当地墙钟**配置（`start`/`end` + `tz`），跨零点由 `end <= start` 表达；
 *    夏令时**不手写偏移**，一律用 `Intl` 的时区数据换算成绝对时刻。
 *  · 显示时区只影响"怎么显示"：刻度数字、列表区间、当前时刻文字。
 */

export type ClockGroup = 'gold' | 'oil' | 'index'

/** 一条交易时段（交易所当地墙钟；`end <= start` ⇒ 跨零点到次日） */
export interface ClockSession {
  group: ClockGroup
  /** 交易所短名（表盘/列表都显示） */
  exchange: string
  /** 品种名（如 `AU黄金 夜盘`） */
  name: string
  /** 品种代码（列表「代码」列） */
  code: string
  /** 当地开盘 `HH:MM` */
  start: string
  /** 当地收盘 `HH:MM` */
  end: string
  /** ISO 星期（1=周一 … 7=周日） */
  days: readonly number[]
  /** IANA 时区（夏令时由 `Intl` 提供） */
  tz: string
}

export const CLOCK_GROUPS: readonly { key: ClockGroup; label: string }[] = [
  { key: 'gold', label: '黄金' },
  { key: 'oil', label: '原油' },
  { key: 'index', label: '主要股指' },
]

const WEEKDAYS = [1, 2, 3, 4, 5] as const

export const CLOCK_SESSIONS: readonly ClockSession[] = [
  // 黄金
  { group: 'gold', exchange: '上期所', name: 'AU黄金 夜盘', code: 'AU', start: '21:00', end: '02:30', days: WEEKDAYS, tz: 'Asia/Shanghai' },
  { group: 'gold', exchange: '上期所', name: 'AU黄金 日盘', code: 'AU', start: '09:00', end: '15:00', days: WEEKDAYS, tz: 'Asia/Shanghai' },
  { group: 'gold', exchange: 'COMEX', name: 'GC黄金', code: 'GC', start: '18:00', end: '17:00', days: WEEKDAYS, tz: 'America/New_York' },
  { group: 'gold', exchange: '伦敦', name: 'XAU现货', code: 'XAU', start: '08:00', end: '16:30', days: WEEKDAYS, tz: 'Europe/London' },
  { group: 'gold', exchange: '上金所', name: 'AU9999', code: 'AU9999', start: '20:00', end: '02:30', days: WEEKDAYS, tz: 'Asia/Shanghai' },
  // 原油
  { group: 'oil', exchange: '上期能源', name: 'SC原油 夜盘', code: 'SC', start: '21:00', end: '02:30', days: WEEKDAYS, tz: 'Asia/Shanghai' },
  { group: 'oil', exchange: '上期能源', name: 'SC原油 日盘', code: 'SC', start: '09:00', end: '15:00', days: WEEKDAYS, tz: 'Asia/Shanghai' },
  { group: 'oil', exchange: 'NYMEX', name: 'CL原油', code: 'CL', start: '18:00', end: '17:00', days: WEEKDAYS, tz: 'America/New_York' },
  { group: 'oil', exchange: 'ICE', name: 'Brent原油', code: 'B', start: '01:00', end: '23:00', days: WEEKDAYS, tz: 'Europe/London' },
  { group: 'oil', exchange: 'DME', name: 'Oman原油', code: 'O', start: '07:00', end: '15:00', days: WEEKDAYS, tz: 'Asia/Dubai' },
  // 主要股指
  { group: 'index', exchange: 'CME', name: 'ES标普500', code: 'ES', start: '18:00', end: '17:00', days: WEEKDAYS, tz: 'America/New_York' },
  { group: 'index', exchange: '新交所', name: 'A50 日盘', code: 'CN', start: '09:00', end: '16:30', days: WEEKDAYS, tz: 'Asia/Singapore' },
  { group: 'index', exchange: '新交所', name: 'A50 夜盘', code: 'CN', start: '17:00', end: '05:15', days: WEEKDAYS, tz: 'Asia/Singapore' },
  { group: 'index', exchange: '港交所', name: 'HSI恒指', code: 'HSI', start: '09:30', end: '16:00', days: WEEKDAYS, tz: 'Asia/Hong_Kong' },
  { group: 'index', exchange: '欧交所', name: 'FDAX', code: 'FDAX', start: '09:00', end: '17:30', days: WEEKDAYS, tz: 'Europe/Berlin' },
]

const MIN = 60_000
const DAY = 86_400_000

const fmtCache = new Map<string, Intl.DateTimeFormat>()

function tzFormatter(tz: string): Intl.DateTimeFormat {
  let f = fmtCache.get(tz)
  if (f === undefined) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hour12: false,
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
    })
    fmtCache.set(tz, f)
  }
  return f
}

interface WallParts { y: number; mo: number; d: number; h: number; mi: number; s: number }

/** 某个绝对时刻在 `tz` 的墙钟读数 */
export function wallClock(tz: string, atMs: number): WallParts {
  const parts = tzFormatter(tz).formatToParts(new Date(atMs))
  const get = (t: string): number => Number(parts.find((p) => p.type === t)?.value ?? '0')
  return { y: get('year'), mo: get('month'), d: get('day'), h: get('hour') % 24, mi: get('minute'), s: get('second') }
}

/** `tz` 在 `atMs` 的偏移（分钟，东八区 = 480）；夏令时由 `Intl` 决定 */
export function tzOffsetMinutes(tz: string, atMs: number): number {
  const w = wallClock(tz, atMs)
  const asUtc = Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi, w.s)
  return Math.round((asUtc - Math.floor(atMs / 1000) * 1000) / MIN)
}

function hhmm(value: string): { h: number; m: number } {
  const [h, m] = value.split(':').map((x) => Number(x))
  return { h: h ?? 0, m: m ?? 0 }
}

/** 交易所当地某日的 `HH:MM` → 绝对时刻（两遍求偏移，跨越 DST 也成立） */
export function localInstant(tz: string, y: number, mo: number, d: number, value: string): number {
  const { h, m } = hhmm(value)
  const guess = Date.UTC(y, mo - 1, d, h, m)
  const first = guess - tzOffsetMinutes(tz, guess) * MIN
  return guess - tzOffsetMinutes(tz, first) * MIN
}

function isoWeekday(y: number, mo: number, d: number): number {
  return ((new Date(Date.UTC(y, mo - 1, d)).getUTCDay() + 6) % 7) + 1
}

/** 一条时段在 `[fromMs, toMs)` 内的绝对窗口（按当地日期逐个展开，跨零点拆成次日结束） */
export function sessionWindows(s: ClockSession, fromMs: number, toMs: number): { start: number; end: number }[] {
  const out: { start: number; end: number }[] = []
  for (let i = -1; i <= 2; i += 1) {
    const w = wallClock(s.tz, fromMs + i * DAY)
    if (!s.days.includes(isoWeekday(w.y, w.mo, w.d))) continue
    const start = localInstant(s.tz, w.y, w.mo, w.d, s.start)
    let end = localInstant(s.tz, w.y, w.mo, w.d, s.end)
    if (end <= start) end += DAY
    if (end > fromMs && start < toMs) out.push({ start, end })
  }
  return out.sort((a, b) => a.start - b.start)
}

/** 当前是否在交易时段内 */
export function sessionStatus(s: ClockSession, atMs: number): 'trading' | 'outside' {
  const hit = sessionWindows(s, atMs - DAY, atMs + DAY).some((w) => atMs >= w.start && atMs < w.end)
  return hit ? 'trading' : 'outside'
}

/** 距下一段开始的秒数（当前正在交易 ⇒ 指下一段，通常为次日同一时刻） */
export function nextStartSeconds(s: ClockSession, atMs: number): number {
  const next = sessionWindows(s, atMs, atMs + 3 * DAY).find((w) => w.start > atMs)
  if (next === undefined) return 0
  return Math.max(0, Math.round((next.start - atMs) / 1000))
}

/** 表盘旋转角：绝对 24 小时轮盘，**只取决于时刻**（与时区无关）；逆时针，0.25°/分钟 */
export function wheelAngle(atMs: number): number {
  const minuteOfDay = ((atMs % DAY) + DAY) % DAY / MIN
  return -(minuteOfDay * 0.25)
}

/** 绝对窗口 → 轮盘分钟段（0–1440，跨零点拆两段） */
export function wheelSegments(windows: readonly { start: number; end: number }[], dayStartMs: number): { start: number; end: number }[] {
  const out: { start: number; end: number }[] = []
  for (const w of windows) {
    const s = ((w.start - dayStartMs) / MIN + 1440) % 1440
    const e = ((w.end - dayStartMs) / MIN + 1440) % 1440
    if (s < e) out.push({ start: s, end: e })
    else if (s > e) {
      out.push({ start: s, end: 1440 })
      if (e > 0) out.push({ start: 0, end: e })
    } else out.push({ start: 0, end: 1440 })
  }
  return out
}

/** 轮盘某分钟对应的显示时区分钟（刻度数字用） */
export function displayMinuteOfWheel(wheelMinute: number, zoneOffsetMin: number): number {
  return (((wheelMinute + zoneOffsetMin) % 1440) + 1440) % 1440
}

/** 行情刷新间隔（毫秒）：默认 120s，可在 settings 里改（30–600s） */
export function clockRefreshMs(prefs: { clockRefreshSec?: number } | null): number {
  const sec = prefs?.clockRefreshSec ?? 120
  return Math.min(600, Math.max(30, sec)) * 1000
}

/** 表盘几何常量（设计稿锁定值；测试逐项断言） */
export const DIAL = {
  cx: 220,
  cy: 220,
  ringR: 200,
  discR: 64,
  arcStroke: 12,
  radii: [160, 140, 120, 100] as const,
  arcLabelHalo: 4,
  needleWidth: 2.5,
  centerLineH: 18,
  centerLines: 3,
} as const

/** 金色读标：固定在 12 点，**不参与旋转**（无 transform） */
export function needleGeometry(): { x1: number; y1: number; x2: number; y2: number; transform: null } {
  return { x1: DIAL.cx, y1: DIAL.cy, x2: DIAL.cx, y2: DIAL.cy - DIAL.ringR + 2, transform: null }
}

/** 弧带几何自检：返回问题清单（空数组 = 合格） */
export function arcGapProblems(spec: { stroke: number; radii: readonly number[] } = { stroke: DIAL.arcStroke, radii: DIAL.radii }): string[] {
  const bad: string[] = []
  if (spec.stroke !== DIAL.arcStroke) bad.push(`弧宽必须是 ${DIAL.arcStroke}（实得 ${spec.stroke}）`)
  for (let i = 1; i < spec.radii.length; i += 1) {
    const diff = spec.radii[i - 1]! - spec.radii[i]!
    if (diff !== 20) bad.push(`相邻半径差必须是 20（第 ${i} 对实得 ${diff}）`)
    if (diff - spec.stroke < 2) bad.push(`相邻净空隙 ${diff - spec.stroke} < 2（会粘连）`)
  }
  return bad
}
