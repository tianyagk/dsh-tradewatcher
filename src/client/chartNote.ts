import { shStampText } from './marketTime.ts'
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
  /**
   * 宿主（v0.63.0 起）在"缓存被判需要回源、但手里有 ≥10 根可用历史"时给的**具体原因**
   * （例：`回源未取到新数据 ⇒ 改用本地缓存的 800 根已完成 bar；不可信的最后一根已丢弃（原因：…）`）。
   * 有它就用它**替换**那句通用的「上次成功数据」——不新增第二处文案（用户要求减少常驻提示）。
   */
  staleReason?: string
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


/** `MM-DD HH:mm`（**北京时间**，与浏览器时区无关；`ts` 为毫秒）——K 线脚注的"上次成功数据"用它 */
export function stamp(ts: number): string {
  return shStampText(ts)
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

/**
 * 降级复用的**可见那一句**：取宿主那句话的**首段**（第一个全角括号之前）。
 *
 * 为什么截断：常驻只留一行（用户反复要求减少提示）。括号里是二级细节（TTL 数值、文件根数、
 * 采纳下限），完整原文仍在 payload（`kline.staleReason`）里，agent/接口照样读得到。
 */
export function staleVisibleOf(reason: string): string {
  const head = reason.split('（')[0].trim().replace(/[；;]$/, '')
  return head === '' ? reason.trim() : head
}

/** 这份 payload 有没有"降级复用的原因"（只有 K 线档才有；分时档没有这个字段） */
export function staleReasonOf(payload: NotePayloadLike): string | null {
  if (payload.kind !== 'kline') return null
  const r = payload.kline?.staleReason
  return typeof r === 'string' && r.trim() !== '' ? r : null
}

/**
 * `· 上次成功数据（MM-DD HH:mm）`；日期不可知时给短形（**必须能区分**）。
 *
 * v0.63.0 起：宿主给了 `staleReason`（降级复用的具体原因）⇒ **用它替换**这句通用说明。
 * 这是**同一处**文案的替换，不是新增第二行；没有原因时行为与以前完全相同。
 */
export function lastSuccessNote(payload: NotePayloadLike): string {
  const reason = staleReasonOf(payload)
  if (reason !== null) return ` · ${staleVisibleOf(reason)}`
  const own = ownStamp(payload)
  return own === null ? ' · 上次成功数据' : ` · 上次成功数据（${own}）`
}

/** 宿主是否已把这份数据冻结（休市定稿零回源）；与 `chartCache.settled()` 同一判据 */
export function settled(payload: NotePayloadLike): boolean {
  return payload.kind === 'kline' ? payload.kline?.cached === true : payload.trend?.cached === true
}

/**
 * 脚注里**该不该出现**这条来源提示（v0.55.0）。
 *
 * 用户要求减少常驻提示：**命中 TTL 缓存**（`· 本地缓存`）是实现细节、数据本身没变，不占位；
 * 而**会影响读数判断**的三类必须照旧常驻 —— 降级复用（上次成功数据）、非当日数据、休市定稿。
 * 带快照时刻的 `本地缓存（最近一次成功快照 …）`（本地归档拼接）也算"要说清"的一类，保留。
 */
export function visibleProvenanceOf(cn: string): string {
  const t = cn.trim()
  if (t === '' || t === '· 本地缓存') return ''
  return cn
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
