/**
 * 为什么日期不能省：K 线兜底那条以前只有 `· 显示上次成功数据（本次刷新失败）`，没有日期 ——
 */
export interface NoteTrendLike {
  /** 序列最后一个点所属交易日（宿主在"不是今天"时才会给） */
  sessionDay?: string
  staleAt?: number
  /** 宿主已把这份数据冻结（休市定稿，零回源） */
  cached?: boolean
  points: ReadonlyArray<{ label: string }>
}

export interface NoteKlineLike {
  cached?: boolean
  /** 宿主给的 K 线是降级复用（上游本次不可用）——与 `fallback` 同一个事实，措辞必须同一句 */
  stale?: boolean
  /** 分钟级/多周期 K 线的时间戳（有它就给 HH:mm） */
  bars?: ReadonlyArray<{ t: number }>
  /** 日线档给的是日期（只有到"天"，就给 MM-DD） */
  days?: ReadonlyArray<{ date: string }>
}

export interface NotePayloadLike {
  fallback?: boolean
  fromCache?: boolean
  kind: 'trend' | 'kline' | string
  trend?: NoteTrendLike
  kline?: NoteKlineLike
}

function pad(n: number): string {
  return String(n).padStart(2, '0')
}

/** `MM-DD HH:mm`（本地时区；`ts` 为毫秒） */
export function stamp(ts: number): string {
  const d = new Date(ts)
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** 这份数据自己带的时刻：分时取最后一个点的 label，K 线取最后一根的时间 */
function ownStamp(payload: NotePayloadLike): string | null {
  if (payload.kind === 'trend') {
    const pts = payload.trend?.points ?? []
    const last = pts[pts.length - 1]
    if (last === undefined) return null
    const day = payload.trend?.sessionDay ?? last.label.slice(0, 10)
    const hhmm = last.label.slice(11, 16)
    return hhmm === '' ? day : `${day.slice(5)} ${hhmm}`
  }
  const bars = payload.kline?.bars ?? []
  const lastBar = bars[bars.length - 1]
  if (lastBar !== undefined) return stamp(lastBar.t)
  // 日线档只有日期（没有时间）——那就只给到天，不编一个时间出来
  const days = payload.kline?.days ?? []
  const lastDay = days[days.length - 1]
  return lastDay === undefined ? null : lastDay.date.slice(5)
}

/** `· 上次成功数据（MM-DD HH:mm）`；日期不可知时给短形（**必须能区分**） */
export function lastSuccessNote(payload: NotePayloadLike): string {
  const own = ownStamp(payload)
  return own === null ? ' · 上次成功数据' : ` · 上次成功数据（${own}）`
}

/** 宿主是否已把这份数据冻结（休市定稿零回源）；与 `chartCache.settled()` 同一判据 */
export function settled(payload: NotePayloadLike): boolean {
  return payload.kind === 'kline' ? payload.kline?.cached === true : payload.trend?.cached === true
}

/** `· 非当日数据（MM-DD）`：上游这次回的是**过去某个交易日**的序列（节假日/停市） */
export function nonSessionNote(day: string): string {
  return ` · 非当日数据（${day.slice(5)}）`
}

/** 图表脚注的完整说明（顺序 = 事实的优先级：降级 > 非当日 > 定稿 > 本地缓存） */
export function cacheNoteOf(payload: NotePayloadLike | null): string {
  if (payload === null) return ''
  // "拿不到"没有缓存口径可谈（原因由 missing 说明，别在这里重复）
  if (payload.kind === 'unavailable') return ''
  if (payload.fallback === true) return lastSuccessNote(payload)
  // 宿主自己标了降级（K 线的 `stale`）——这也是"上次成功数据"，必须带日期（E1）
  if (payload.kind === 'kline' && payload.kline?.stale === true) return lastSuccessNote(payload)
  // 宿主回了 last-known-good（staleAt 有值）⇒ 这是"上次成功数据"，必须把日期说清
  if (payload.trend?.staleAt !== undefined) return lastSuccessNote(payload)
  // 宿主说"这份序列不是今天的"（节假日上游回节前分时）⇒ 必须写出来，否则会被读成今天
  const sessionDay = payload.trend?.sessionDay
  if (payload.kind === 'trend' && sessionDay !== undefined && sessionDay !== '') return nonSessionNote(sessionDay)
  if (settled(payload)) return ' · 休市定稿缓存（未回源）'
  if (payload.fromCache === true) return ' · 本地缓存'
  return ''
}
