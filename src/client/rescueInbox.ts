/**
 * 跨日「信号收件箱」的**纯视图逻辑**（不 import react ⇒ 能在 node 里直接断言）。
 *
 * 数据来源：宿主已有的护盘历史（`rescue-log` 的 `days[].events`，按天经 `/tradewatcher/rescue?day=`
 * 取回；今天直接用快照里的 `today`）—— **不新增路由、不新增上游请求**。
 *
 * 规格（用户 2026-10-19 定的口径）：
 *   · 保留 **30 天**；
 *   · 只列**未读**、且等级 ≥ `INBOX_MIN_LEVEL`（疑似护盘及以上）；
 *     ⚠ 「资金异动」（等级 1）**不入箱**：实测基率 100% ⇒ 列出来等于每拍一条噪音；
 *   · 排序：**等级优先**，同等级内**时间倒序**；
 *   · 合并：同等级 **5 分钟内**并为一条并计数；合并后**得分取窗口内最大值**（不是最新值）；
 *   · 已读状态存 **prefs**（`PortPrefs.rescueInboxRead`），**不写进 `rescue-log`** ——
 *     日志是行情记录，"我看过哪条"是阅读偏好，混进去会被日志裁剪连坐；
 *   · 空态必须给「最近一次信号在 X 天前」+ 本期统计（只写"无信号"会被读成系统坏了）；
 *   · 不做：推送、红点、闪烁、新依赖。
 */
import type { RescueLevel } from '../shared/model.ts'
import { RESCUE_LEVEL_LABEL } from '../shared/model.ts'
import { shClockText } from './marketTime.ts'

/** 保留窗口（自然日）：与宿主 `history(30)` 同口径 */
export const INBOX_RETAIN_DAYS = 30

/** 合并窗口：同等级 5 分钟内并成一条（锚在窗口**起点**，不滚动成链） */
export const INBOX_MERGE_MS = 5 * 60 * 1000

/**
 * 入箱的最小等级 = 2（疑似护盘）。
 *
 * 为什么不收等级 1（资金异动）：它的实测基率接近 100% —— 每拍都会被记一条，
 * 列出来只会把真正的信号淹掉。等级 0（平静）更不用说。
 */
export const INBOX_MIN_LEVEL: RescueLevel = 2

/** 常驻一行口径（可见，但不铺开；细节在 title 里） */
export const INBOX_CALIBER =
  `只列「疑似护盘」及以上、未读（资金异动基率 100%，不入箱）· 同等级 ${INBOX_MERGE_MS / 60000} 分钟内合并为一条、得分取窗口内最高 · 已读状态存偏好（prefs），不写行情日志。`

/** 收件箱列表下方那一行更短的常驻说明（口径全文在 `INBOX_CALIBER`，挂 title） */
export const INBOX_SHORT_HINT = '只列疑似护盘及以上 · 未读 · 同等级 5 分钟内合并（得分取最高）'

/**
 * 统计句里的**短等级名**：共享的 `RESCUE_LEVEL_LABEL[3]` 是「强护盘（已删除，不再出现）」，
 * 放进「最高 …」这种统计槽里读起来别扭 ⇒ 这里只写「强护盘（历史）」（等级 3 只存在于旧日志）。
 */
const LEVEL_SHORT: Record<RescueLevel, string> = {
  0: RESCUE_LEVEL_LABEL[0],
  1: RESCUE_LEVEL_LABEL[1],
  2: RESCUE_LEVEL_LABEL[2],
  3: '强护盘（历史）',
}

/** 已读状态：merge 键 → 已读时刻（epoch ms） */
export type InboxReadMap = Record<string, number>

/** 收件箱的输入事件（今天的来自 `snapshot.today`，历史的来自 `?day=` 的 `dayEvents`） */
export interface InboxEvent {
  /** `YYYY-MM-DD`（北京时间自然日） */
  day: string
  ts: number
  /** HH:mm；缺省时按 `ts` 的北京时间现算（不猜） */
  hhmm?: string
  level: RescueLevel
  score: number
}

/** 收件箱里的一条（= 一个合并窗口） */
export interface InboxEntry {
  /** 稳定合并键：`day#level#窗口起点 ts`（窗口起点不变 ⇒ 已读状态不会因为新事件而失效） */
  id: string
  day: string
  level: RescueLevel
  startTs: number
  /** 窗口起点 HH:mm */
  startHhmm: string
  /** 窗口末条 HH:mm（只有一条时 == startHhmm） */
  endHhmm: string
  /** 窗口内**最高**得分（不是最新一条的得分） */
  score: number
  /** 窗口内事件条数 */
  count: number
}

/** 合并键的唯一实现 */
export function inboxEntryId(day: string, level: RescueLevel, startTs: number): string {
  return `${day}#${level}#${startTs}`
}

/**
 * 一条的悬停说明（把"合并了几条 / 得分为什么是它"讲清楚）：
 * 得分是窗口内**最高**分，不是最新一条 —— 用户有权知道这个数怎么来的。
 */
export function inboxEntryTitleOf(e: InboxEntry): string {
  const span = e.count > 1 ? `${e.startHhmm}–${e.endHhmm} 共 ${e.count} 条合并` : `${e.startHhmm}（单条，无合并）`
  return `${e.day} ${span}；得分取窗口内最高 ${e.score}（不是最新一条）；已读状态存偏好（prefs），不写行情日志。`
}

function hhmmOf(ts: number, hhmm?: string): string {
  if (typeof hhmm === 'string' && /^\d{2}:\d{2}$/.test(hhmm.trim())) return hhmm.trim()
  return shClockText(ts).slice(0, 5)
}

/**
 * 合并：同一天、同等级、距**窗口起点** ≤ 5 分钟的事件并为一条。
 *  - 计数 = 窗口内条数；
 *  - 得分 = 窗口内**最大值**（取最新值会被回落的事件拉低，让一次强信号看起来平平）；
 *  - 锚在起点而非"上一条"：否则一路续在 5 分钟边上能滚成一个整段（那不是"一次事件"）。
 */
export function mergeInboxEvents(events: readonly InboxEvent[]): InboxEntry[] {
  const kept = events.filter(
    (e) =>
      e !== null &&
      e !== undefined &&
      typeof e.day === 'string' &&
      /^\d{4}-\d{2}-\d{2}$/.test(e.day) &&
      Number.isFinite(e.ts) &&
      Number.isFinite(e.score) &&
      Number.isFinite(e.level) &&
      e.level >= INBOX_MIN_LEVEL,
  )
  // **先按（天, 等级）分组**再各自扫窗口：等级交错时（14:30 L2 → 14:31 L3 → 14:32 L2）
  // 单趟扫描会把同一个 L2 窗口切断，合并计数就错了。
  const groups = new Map<string, InboxEvent[]>()
  for (const ev of kept) {
    const key = `${ev.day}#${ev.level}`
    const list = groups.get(key)
    if (list === undefined) groups.set(key, [ev])
    else list.push(ev)
  }
  const out: InboxEntry[] = []
  for (const list of groups.values()) {
    const sorted = [...list].sort((a, b) => a.ts - b.ts)
    let cur: InboxEntry | null = null
    for (const ev of sorted) {
      const at = hhmmOf(ev.ts, ev.hhmm)
      if (cur !== null && ev.ts - cur.startTs <= INBOX_MERGE_MS) {
        cur.count += 1
        if (ev.score > cur.score) cur.score = ev.score
        if (at > cur.endHhmm) cur.endHhmm = at
        continue
      }
      if (cur !== null) out.push(cur)
      cur = {
        id: inboxEntryId(ev.day, ev.level, ev.ts),
        day: ev.day,
        level: ev.level,
        startTs: ev.ts,
        startHhmm: at,
        endHhmm: at,
        score: ev.score,
        count: 1,
      }
    }
    if (cur !== null) out.push(cur)
  }
  return out
}

/** 排序唯一实现：**等级优先**，同等级内**时间倒序** */
export function sortInboxEntries(entries: readonly InboxEntry[]): InboxEntry[] {
  return [...entries].sort((a, b) => b.level - a.level || b.startTs - a.startTs)
}

/**
 * `YYYY-MM-DD` 平移 n 天。
 *
 * 只在**日历标签**上做算术（`Date.UTC` + `getUTC*`）：这里没有"时刻→自然日"的换算，
 * 与浏览器时区无关。⚠ 不许用 `toISOString().slice(0,10)` —— 仓里有红线扫描
 * （`marketTimeDisplay.test.ts` R5-⑤：UTC 日期 ≠ 北京自然日）。
 */
export function shiftDayOf(day: string, delta: number): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day)
  if (m === null) return day
  const t = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) + delta * 86400000
  const d = new Date(t)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`
}

/** 相差多少个自然日（later − earlier）；输入不合法 ⇒ `null`（不返回 0 顶替） */
export function dayDiffOf(later: string, earlier: string): number | null {
  const a = Date.parse(`${later}T00:00:00Z`)
  const b = Date.parse(`${earlier}T00:00:00Z`)
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null
  return Math.round((a - b) / 86400000)
}

/** 只保留窗口内的自然日（越界/未来一律丢掉） */
export function retainInboxEvents<T extends { day: string }>(
  events: readonly T[],
  today: string,
  days = INBOX_RETAIN_DAYS,
): T[] {
  const cutoff = shiftDayOf(today, -(Math.max(1, days) - 1))
  return events.filter((e) => typeof e.day === 'string' && e.day >= cutoff && e.day <= today)
}

/** prefs 里的已读状态读侧归一（宽容：非对象 ⇒ `{}`；值非有限数 ⇒ 丢弃；不抛错） */
export function inboxReadMapOf(raw: unknown): InboxReadMap {
  const out: InboxReadMap = {}
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return out
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    const id = k.trim()
    if (id === '') continue
    if (typeof v !== 'number' || !Number.isFinite(v)) continue
    out[id] = v
  }
  return out
}

/** 标记已读（返回新对象，不改入参；调用方负责写 prefs） */
export function markInboxRead(map: InboxReadMap, ids: readonly string[], at: number): InboxReadMap {
  const out: InboxReadMap = { ...map }
  for (const id of ids) if (typeof id === 'string' && id.trim() !== '') out[id] = at
  return out
}

/**
 * 裁掉窗口外的已读记录（避免 prefs 无限长）。
 *
 * 按 **id 里的日期前缀**裁，而不是按"当前列表里还在不在"：某天的事件这一轮没取到（网络失败）时，
 * 用它在不在列表里来裁会把手动已读的记录抹掉，下一轮重新取到就又变成未读（幽灵未读）。
 */
export function pruneInboxRead(map: InboxReadMap, today: string, days = INBOX_RETAIN_DAYS): InboxReadMap {
  const cutoff = shiftDayOf(today, -(Math.max(1, days) - 1))
  const out: InboxReadMap = {}
  for (const [id, at] of Object.entries(map)) {
    const day = id.split('#')[0] ?? ''
    if (day.length !== 10 || day < cutoff || day > today) continue
    out[id] = at
  }
  return out
}

/** 空态的第一句（**必须**有，且不许只写"无信号"）：最近一次信号在 X 天前 */
export function lastSignalTextOf(input: {
  lastSignalDay: string | null
  ago: number | null
  days?: number
  /** 实际有日志的天数（自采样起）；缺省 = 满窗口 */
  coveredDays?: number
}): string {
  const days = input.days ?? INBOX_RETAIN_DAYS
  const covered = Math.max(0, Math.min(days, input.coveredDays ?? days))
  if (input.lastSignalDay === null || input.ago === null) {
    if (covered === 0) return `最近一次信号在 ${days} 天前以外（自采样起还没有日志）`
    return covered < days
      ? `最近一次信号在 ${covered} 天前以外（自采样起只有 ${covered} 天日志）`
      : `最近一次信号在 ${days} 天前以外（窗口只回溯 ${days} 天，更早的没有查询）`
  }
  if (input.ago === 0) return `最近一次信号在今天（${input.lastSignalDay}）`
  if (input.ago < 0) return `最近一次信号在 ${input.lastSignalDay}（晚于今天，时间源可疑）`
  return `最近一次信号在 ${input.ago} 天前（${input.lastSignalDay}）`
}

export interface InboxView {
  /** 收件箱内容：**未读**、已排序 */
  entries: InboxEntry[]
  /** 窗口内全部（已读 + 未读），已排序；统计与"最近一次"都用它 */
  all: InboxEntry[]
  unread: number
  total: number
  /** 窗口内有信号的天数 */
  signalDays: number
  maxLevel: RescueLevel | null
  lastSignalDay: string | null
  lastSignalAgoDays: number | null
  lastSignalText: string
  statsText: string
  /** 空态整句：`最近一次信号在 X 天前 · 本期（30 天）…` */
  emptyText: string
}

/**
 * 收件箱视图（唯一实现）。`read` 来自 prefs；`coveredDays` 传实际日志天数（自采样起），
 * 用来把"30 天内没有"与"自采样起没有"分开说 —— 两者不能混成一句。
 */
export function inboxViewOf(input: {
  events: readonly InboxEvent[]
  read?: InboxReadMap | null
  today: string
  days?: number
  coveredDays?: number
}): InboxView {
  const days = input.days ?? INBOX_RETAIN_DAYS
  const read = input.read ?? {}
  const all = sortInboxEntries(mergeInboxEvents(retainInboxEvents(input.events, input.today, days)))
  const entries = all.filter((e) => read[e.id] === undefined)
  const signalDays = new Set(all.map((e) => e.day)).size
  const maxLevel = all.reduce<RescueLevel | null>((a, e) => (a === null || e.level > a ? e.level : a), null)
  const last = all.reduce<InboxEntry | null>((a, e) => (a === null || e.startTs > a.startTs ? e : a), null)
  const lastSignalDay = last === null ? null : last.day
  const lastSignalAgoDays = lastSignalDay === null ? null : dayDiffOf(input.today, lastSignalDay)
  const lastSignalText = lastSignalTextOf({
    lastSignalDay,
    ago: lastSignalAgoDays,
    days,
    coveredDays: input.coveredDays,
  })
  const statsText =
    `本期（${days} 天）：${signalDays} 天有信号 / ${all.length} 条` +
    (maxLevel === null ? '' : `（最高 ${LEVEL_SHORT[maxLevel]}）`)
  return {
    entries,
    all,
    unread: entries.length,
    total: all.length,
    signalDays,
    maxLevel,
    lastSignalDay,
    lastSignalAgoDays,
    lastSignalText,
    statsText,
    emptyText: `${lastSignalText} · ${statsText}`,
  }
}
