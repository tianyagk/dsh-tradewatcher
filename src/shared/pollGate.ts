/**
 * 轮询闸门（用户 2026-10-26：稳定性降频）。
 *
 * 四条规则集中在这里，页面只调函数、不再各写 `setInterval` 判据：
 *   ① 护盘默认 300s（5 分钟，可调 [30,600]）；
 *   ② 盘后/非交易日 ⇒ 不轮询（手动"立即采样"不受限）；
 *   ③ 熔断全开 ⇒ **纯东财标的**跳过（只有带腾讯/新浪映射的才发）；
 *   ④ 11:30–13:00 午休与 15:00 后 ⇒ 行情不轮询（时钟页 1s 时钟不受影响）。
 */

/** 行情统一轮询间隔（用户定稿 60s） */
/** 行情统一轮询间隔（60s）——由 `shouldPollQuotes` 的调用方读取 */
export const QUOTE_POLL_MS = 60_000
/** 护盘默认/下限/上限（秒） */
export const RESCUE_DEFAULT_SEC = 300
export const RESCUE_MIN_SEC = 30
export const RESCUE_MAX_SEC = 600

/** 北京时间（UTC+8）的分钟数，避免依赖本机 TZ */
function shMinutes(ts: number): { minutes: number; weekday: number } {
  const d = new Date(ts + 8 * 3600_000)
  return { minutes: d.getUTCHours() * 60 + d.getUTCMinutes(), weekday: d.getUTCDay() }
}

/** 是否交易日（周一至周五；节假日不在本判据内，由宿主日历负责） */
export function isTradingDay(ts: number): boolean {
  const w = shMinutes(ts).weekday
  return w >= 1 && w <= 5
}

/** A股连续竞价时段：09:30–11:30、13:00–15:00（午休与盘后为 false） */
export function inQuoteSession(ts: number): boolean {
  if (!isTradingDay(ts)) return false
  const m = shMinutes(ts).minutes
  return (m >= 570 && m <= 690) || (m >= 780 && m <= 900)
}

/** 午休：11:30 < t < 13:00（边界按收盘/开盘瞬间处理：11:30 收盘后即停） */
export function inLunchBreak(ts: number): boolean {
  if (!isTradingDay(ts)) return false
  const m = shMinutes(ts).minutes
  return m > 690 && m < 780
}

/** 盘后：15:00 之后（含 15:00） */
export function afterClose(ts: number): boolean {
  if (!isTradingDay(ts)) return false
  return shMinutes(ts).minutes >= 900
}

/** 行情是否该轮询：只在连续竞价时段 */
export function shouldPollQuotes(ts: number): boolean {
  // 午休/盘后/非交易日一律不轮询（`inLunchBreak` 与 `afterClose` 都并进 `inQuoteSession` 的判据）
  return inQuoteSession(ts) && !inLunchBreak(ts) && !afterClose(ts)
}

/** 护盘是否该轮询：交易日 + 盘中（09:15–15:00，含集合竞价）；盘后/非交易日不轮询 */
export function shouldPollRescue(ts: number): boolean {
  void QUOTE_POLL_MS
  if (!isTradingDay(ts)) return false
  const m = shMinutes(ts).minutes
  return m >= 555 && m < 900
}

/** 护盘间隔收敛到 [30,600]（坏值回退默认 60） */
export function clampRescueSec(v: unknown): number {
  const n = typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : RESCUE_DEFAULT_SEC
  return Math.min(RESCUE_MAX_SEC, Math.max(RESCUE_MIN_SEC, n))
}

/**
 * 熔断全开时该轮询哪些标的：只保留**有备用源**（腾讯/新浪映射）的；
 * 纯东财（`113.*` / `101.*` / `118.*` 等）全部跳过；熔断关闭 ⇒ 原样返回。
 */
export function pollableSecids(
  secids: readonly string[],
  breaker: { open: boolean },
  hasFallback: (secid: string) => boolean,
): string[] {
  if (!breaker.open) return [...secids]
  return secids.filter((s) => hasFallback(s))
}

/** 同一轮里对 secid 去重（保持首次出现的顺序） */
export function dedupeSecids(secids: readonly string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const s of secids) {
    const k = s.trim().toUpperCase()
    if (k === '' || seen.has(k)) continue
    seen.add(k)
    out.push(k)
  }
  return out
}
