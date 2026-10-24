import { shStampText } from './marketTime.ts'
import { TREND_LKG_RETENTION_NOTE } from '../shared/trendRetention.ts'
import { TREND_SOURCE_LABEL, type TrendSource } from '../shared/model.ts'
/**
 * 为什么日期不能省：K 线兜底那条以前只有 `· 显示上次成功数据（本次刷新失败）`，没有日期 ——
 */
export interface NoteTrendLike {
  /** 序列最后一个点所属交易日（宿主在"不是今天"时才会给） */
  sessionDay?: string
  /**
   * **非当日数据**的结构化交代（AUDIT-IMPL84 起，宿主 `TrendData.nonSession`）：
   * `{day, reason, detail}` —— 只说"是哪天"不够，必须说清"为什么今天没有"。
   * 缺省（老宿主）时退回 `sessionDay`，仍然要写出日期。
   */
  nonSession?: { day: string; reason: string; detail?: string }
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

/**
 * `· 非当日数据（YYYY-MM-DD）`：上游这次回的是**过去某个交易日**的序列（节假日/停市）。
 *
 * 为什么写**全年份**（`2026-10-19`）而不是只写 `10-19`：这条提示要能独立读，
 * 跨年/长期不看的归档数据上 `10-19` 看不出是哪一年；用户要求的措辞也是完整日期。
 */
export function nonSessionNote(day: string): string {
  return ` · 非当日数据（${day}）`
}

/**
 * 这份分时序列的"非当日"事实（有就返回，没有返回 null）。
 *
 * 判据**只看宿主给的字段**（`nonSession` 优先，其次 `sessionDay`）—— 客户端不自己算"今天"，
 * 免得浏览器时区/时钟与宿主不一致时凭空造出（或掩盖）一条"非当日"。
 */
export function nonSessionOf(payload: NotePayloadLike): { day: string; reason: string; detail: string } | null {
  if (payload.kind !== 'trend') return null
  const t = payload.trend
  if (t === undefined) return null
  const ns = t.nonSession
  if (ns !== undefined && typeof ns.day === 'string' && ns.day !== '') {
    return { day: ns.day, reason: typeof ns.reason === 'string' ? ns.reason : '', detail: typeof ns.detail === 'string' ? ns.detail : '' }
  }
  // 老宿主只给 sessionDay（没有原因）—— 日期照样必须写出来，原因那半句如实省略
  const day = t.sessionDay
  if (typeof day === 'string' && day !== '') return { day, reason: '', detail: '' }
  return null
}

/** 分时兜底时追加的"保留口径"后缀（K 线不走这份库 ⇒ 空串） */
function trendLkgNote(payload: NotePayloadLike): string {
  return payload.kind === 'trend' ? ` · ${TREND_LKG_RETENTION_NOTE}` : ''
}

/** 图表脚注的完整说明（顺序 = 事实的优先级：非当日 > 降级 > 定稿 > 本地缓存） */
export function cacheNoteOf(payload: NotePayloadLike | null): string {
  if (payload === null) return ''
  // "拿不到"没有缓存口径可谈（原因由 missing 说明，别在这里重复）
  if (payload.kind === 'unavailable') return ''
  /**
   * ★ **非当日数据排在最前**（AUDIT-IMPL84）。
   *
   * 之前它在 `staleAt` 后面：真机上落进 LKG 的那一刻，脚注先写成
   * 「上次成功数据（10-19 15:00）」+ 一长串兜底库保留口径，而图头仍是「昨收 … · 09:30 ~ 15:00」
   * —— 读者把这行读成"今天的图，只是刷新慢"。这类"看着正常的错数"是红线，
   * 所以只要数据不是今天的，**第一句必须是「非当日数据（YYYY-MM-DD）」并给出原因**。
   */
  const nonSession = nonSessionOf(payload)
  if (nonSession !== null) return nonSessionNote(nonSession.day) + (nonSession.reason === '' ? '' : `：${nonSession.reason}`)
  if (payload.fallback === true) return lastSuccessNote(payload) + trendLkgNote(payload)
  // 宿主自己标了降级（K 线的 `stale`）——这也是"上次成功数据"，必须带日期（E1）
  if (payload.kind === 'kline' && payload.kline?.stale === true) return lastSuccessNote(payload)
  // 宿主回了 last-known-good（staleAt 有值）⇒ 这是"上次成功数据"，必须把日期说清
  if (payload.trend?.staleAt !== undefined) return lastSuccessNote(payload) + trendLkgNote(payload)
  if (settled(payload)) return ' · 休市定稿缓存（未回源）'
  if (payload.fromCache === true) return ' · 本地缓存'
  return ''
}

/**
 * 分时**滞后**的口径段（AUDIT-INTL-MINUTE）：`· 数据滞后 14.5 小时（分钟源：新浪全球期货分钟 · 报价源：新浪 · 原因：…）`。
 *
 * 为什么由宿主给 `lagMinutes` 而不是客户端自己算：浏览器时钟/时区与宿主不一致时，客户端自算会
 * 凭空造出（或掩盖）一条"数据滞后"；而"该不该在这里谈滞后"（收盘后/休市）只有宿主知道。
 * 因此这里**只渲染**，判据一律在宿主（`TREND_LAG_WARN_MINUTES` 同一处常量）。
 *
 * 报价源与分钟源**同时标出**：`122.XAU` 的实时价来自新浪 `hf_XAU`、分钟来自新浪全球期货分时，
 * 两者虽同为新浪，但一个是快照一个是序列 —— 分开写清才不会把"报价新"读成"分时新"。
 */
const QUOTE_SOURCE_LABEL: Record<string, string> = {
  em: '东财',
  sina: '新浪',
  tencent: '腾讯',
  lkg: '本地兜底快照',
}

export function trendLagNote(
  trend: { lagMinutes?: number; lagReason?: string; source?: TrendSource } | undefined | null,
  quoteSource?: string | null,
): string {
  const minutes = trend?.lagMinutes
  if (typeof minutes !== 'number' || !(minutes > 0)) return ''
  const span = minutes < 60
    ? `${Math.round(minutes)} 分钟`
    : `${(minutes / 60).toFixed(1).replace(/\.0$/, '')} 小时`
  const src = trend?.source === undefined ? '—' : TREND_SOURCE_LABEL[trend.source]
  const quote = typeof quoteSource === 'string' && quoteSource !== ''
    ? ` · 报价源：${QUOTE_SOURCE_LABEL[quoteSource] ?? quoteSource}`
    : ''
  const why = typeof trend?.lagReason === 'string' && trend.lagReason !== '' ? ` · 原因：${trend.lagReason}` : ''
  return ` · 数据滞后 ${span}（分钟源：${src}${quote}${why}）`
}
