/**
 * 上游降级的**三块公共件**（`docs/AUDIT-IMPL70.md`）。
 *
 * 这个文件**只 import `breaker.ts` 与 `http.ts`**，不 import 任何取数模块
 * （`em/tencent/sina/breakerFetch`）—— 否则 `breakerFetch → degrade → tencent → breakerFetch`
 * 会成环，在模块初始化期拿到 `undefined`。品种能力表放在 `em.ts`（它本来就同时 import 腾讯/新浪）。
 *
 * 三块件对应本轮三个问题：
 *  1. `upstreamHealth()`（§可观测性）：按主机的最后一次成功/失败时刻、连续失败次数、是否熔断。
 *     **纯读内存状态，零新增上游请求** —— 由 `withHostBreaker`（以及 `em.fetchAny`）记账。
 *  2. `noteDegraded()` / `flushDegraded()`（P2）：同一轮 N 个标的的降级**聚合成 1 行**，
 *     逐标的明细降到 `debug` 级（`TW_DEBUG=1` 才输出）。此前每个标的一行 ⇒ 几十行刷屏。
 *  3. `partialOutcome` / `TotalUpstreamError`（P0）：多标的路由"只要还有一个标的取到就 200"，
 *     只有**全部来源对全部标的都失败**才 5xx，且消息必须写清「哪个上游 × 哪个范围」。
 */
import { HttpError } from './http.ts'
import { breakerFor } from './breaker.ts'
import { shClockText } from './time.ts'

// ─────────────────────────── ① 上游健康簿 ─────────────────────────────────

interface HostTimeline {
  lastOkAt: number | null
  lastFailAt: number | null
  /** 连续失败次数（**自己的**计数器：熔断器的 `fails` 在跳闸瞬间被清零，当不了"连续"） */
  consecutiveFails: number
  lastError: string | null
  /** 最近一次"本轮根本没发请求"（熔断冷却/半开探测被占）：跳过 ≠ 失败 */
  lastSkipAt: number | null
  lastSkipReason: string | null
}

const timelines = new Map<string, HostTimeline>()

function timelineOf(host: string): HostTimeline {
  let t = timelines.get(host)
  if (t === undefined) {
    t = { lastOkAt: null, lastFailAt: null, consecutiveFails: 0, lastError: null, lastSkipAt: null, lastSkipReason: null }
    timelines.set(host, t)
  }
  return t
}

/** 一次主机请求成功 */
export function noteHostSuccess(host: string): void {
  const t = timelineOf(host)
  t.lastOkAt = Date.now()
  t.consecutiveFails = 0
  t.lastError = null
}

/** 一次主机请求失败（**真实发出过请求**才算；熔断期跳过请用 `noteHostSkipped`） */
export function noteHostFailure(host: string, error: unknown): void {
  const t = timelineOf(host)
  t.lastFailAt = Date.now()
  t.consecutiveFails += 1
  t.lastError = error instanceof Error ? error.message : String(error)
}

/**
 * 本轮**没有发出请求**（熔断冷却中 / 半开探测名额已被别人占）。
 *
 * 为什么必须与"失败"分开记：熔断打开时每个调用都会走到这里，
 * 若记成失败就会把 `consecutiveFails` 越堆越大（看着像"上游越来越坏"），
 * 而事实恰恰相反 —— 我们**一个请求都没发**，上游状态未知。
 */
export function noteHostSkipped(host: string, reason: string): void {
  const t = timelineOf(host)
  t.lastSkipAt = Date.now()
  t.lastSkipReason = reason
}

/**
 * 该主机这次**失败了，但同源的兄弟主机接住了**同一份请求（→ 降级，不判死）。
 *
 * 为什么要这个记号：腾讯 K 线有三台同源主机（`appstock` 那套：`web.ifzq.gtimg.cn` /
 * `ifzq.gtimg.cn` / `proxy.finance.qq.com`），它们的数据**完全相同**（实测 2026-10-22：
 * 同一 `param` 回包的 `qfqday` 逐字相同）。当 `web.ifzq.gtimg.cn` 被 WAF 挡成 501、而
 * `ifzq.gtimg.cn` 照常 200 时，用户的图**是有数据的** —— 这时把失败那台记成"死了"
 * 会让面板显示"K 线上游不可用"，与事实相反。`degraded` 表达的就是"这台这轮不行、链路没事"。
 */
const fallbacks = new Map<string, { at: number; servedBy: string }>()

export function noteHostFallback(host: string, servedBy: string): void {
  fallbacks.set(host, { at: Date.now(), servedBy })
}

/** 最近一次"被同源兄弟接住"的记录（供 `/health` 与断言读取；无则 null） */
export function hostFallbackOf(host: string): { at: number; servedBy: string } | null {
  return fallbacks.get(host) ?? null
}

/** 清空健康簿（**测试钩子**：`__` 前缀与全仓约定一致，见 repoHygiene ③） */
export function __resetUpstreamHealth(): void {
  timelines.clear()
  fallbacks.clear()
}

export interface HostHealth {
  host: string
  /** 最后已知状态：最近一次成功晚于最近一次失败 ⇒ true；从未成功过 ⇒ false */
  healthy: boolean
  lastOkAt: number | null
  lastFailAt: number | null
  /** 连续失败次数（我们自己数，不被熔断器的清零影响） */
  consecutiveFails: number
  /** 熔断器此刻是否在冷却 */
  open: boolean
  /** 冷却剩余（分钟，向上取整；未熔断为 0） */
  minutesLeft: number
  lastError: string | null
  /** 最近一次"没发请求"的时刻与原因（熔断冷却 / 半开探测被占） */
  lastSkipAt: number | null
  lastSkipReason: string | null
  /**
   * **降级（不是死）**：这台这次没成功，但同源的兄弟主机接住了同一份请求。
   * `null` = 没有这回事（正常、或真的没有备用主机）。
   */
  servedBy: string | null
  /** 上面那次"被接住"的时刻 */
  servedByAt: number | null
}

export interface UpstreamHealth {
  hosts: HostHealth[]
  /** 一行摘要（界面横幅 / 日志一行直接用） */
  line: string
  /** 任一主机熔断中 */
  anyOpen: boolean
  /** 传入的主机**全部**熔断中（此时才是真的"无可用上游"） */
  allOpen: boolean
}

/** `HH:MM:ss`（**北京时间**，走 `time.ts` 的固定时区实现；不得用本地 getHours 那套） */
function hhmmss(at: number): string {
  return shClockText(at)
}

/**
 * 按主机汇总健康状态（**零新增请求**：只读内存）。
 *
 * 不传 `hosts` 时返回**全部**记过账的主机（按最后一次活动时间倒序），
 * 供「本机到底哪些上游活着」这个问题一次看全。
 */
export function upstreamHealth(hosts?: readonly string[]): UpstreamHealth {
  const names = hosts === undefined
    ? [...timelines.keys()]
    : [...new Set(hosts)]
  const rows: HostHealth[] = []
  for (const host of names) {
    const t = timelines.get(host)
    const b = breakerFor(host)
    const open = !b.allow()
    const lastOkAt = t?.lastOkAt ?? null
    const lastFailAt = t?.lastFailAt ?? null
    const fb = fallbacks.get(host) ?? null
    rows.push({
      host,
      healthy: lastOkAt !== null && (lastFailAt === null || lastOkAt >= lastFailAt),
      lastOkAt,
      lastFailAt,
      consecutiveFails: t?.consecutiveFails ?? 0,
      open,
      minutesLeft: open ? b.minutesLeft() : 0,
      lastError: t?.lastError ?? b.state.lastError,
      lastSkipAt: t?.lastSkipAt ?? null,
      lastSkipReason: t?.lastSkipReason ?? null,
      servedBy: fb?.servedBy ?? null,
      servedByAt: fb?.at ?? null,
    })
  }
  // 有活动的排前面（最近活动时间倒序），从未活动过的排最后 —— 摘要第一眼看到的就是"刚动过的那台"
  rows.sort((a, b) => (b.lastOkAt ?? b.lastFailAt ?? b.lastSkipAt ?? 0) - (a.lastOkAt ?? a.lastFailAt ?? a.lastSkipAt ?? 0))
  const openCount = rows.filter((r) => r.open).length
  return {
    hosts: rows,
    line: healthLine(rows),
    anyOpen: openCount > 0,
    allOpen: rows.length > 0 && openCount === rows.length,
  }
}

/** 摘要的一行文本：`上游健康 20:15:03：腾讯 qt.gtimg.cn ✓ 20:15:02 ｜ 东财 push2 ✗ 20:14:58（连续 3 次，熔断剩 2 分钟）` */
function healthLine(rows: readonly HostHealth[]): string {
  if (rows.length === 0) return '上游健康：尚无上游请求记录'
  const now = rows.reduce<number>((acc, r) => Math.max(acc, r.lastOkAt ?? 0, r.lastFailAt ?? 0, r.lastSkipAt ?? 0), 0)
  const parts = rows.slice(0, 8).map((r) => {
    /**
     * **降级（不判死）**先说：这台这次没成功，但同源兄弟接住了 ⇒ 链路有数据。
     * 若把它写成"熔断/不可用"，面板会与用户的图（有数据）矛盾。
     */
    if (r.servedBy !== null && r.lastFailAt !== null && (r.lastOkAt === null || r.lastFailAt >= r.lastOkAt)) {
      const why = r.lastError === null ? '' : `，${shortError(r.lastError)}`
      const openTail = r.open ? `，熔断剩 ${r.minutesLeft} 分钟` : ''
      return `${r.host} 降级（同源 ${r.servedBy} 接住${openTail}，连续失败 ${r.consecutiveFails} 次${why}）`
    }
    if (r.open) {
      const why = r.lastError === null ? '' : `，${shortError(r.lastError)}`
      return `${r.host} 熔断剩 ${r.minutesLeft} 分钟（连续失败 ${r.consecutiveFails} 次${why}）`
    }
    if (r.lastOkAt !== null && (r.lastFailAt === null || r.lastOkAt >= r.lastFailAt)) {
      return `${r.host} ✓ ${hhmmss(r.lastOkAt)}`
    }
    if (r.lastFailAt !== null) {
      const why = r.lastError === null ? '' : `，${shortError(r.lastError)}`
      return `${r.host} ✗ ${hhmmss(r.lastFailAt)}（连续失败 ${r.consecutiveFails} 次${why}）`
    }
    return `${r.host} 未尝试`
  })
  const more = rows.length > 8 ? ` 等 ${rows.length} 台` : ''
  return `上游健康${now > 0 ? ` ${hhmmss(now)}` : ''}：${parts.join(' ｜ ')}${more}`
}

/** 错误消息截短（日志/摘要一行放得下） */
export function shortError(error: unknown, max = 60): string {
  const s = error instanceof Error ? error.message : String(error)
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`
}

// ─────────────────────────── ② 降级日志聚合 ───────────────────────────────

/** debug 级明细的开关：`TW_DEBUG=1`（或含 tradewatcher 的 `DEBUG=`） */
export function debugEnabled(): boolean {
  const tw = process.env.TW_DEBUG
  if (tw !== undefined && tw !== '' && tw !== '0' && tw.toLowerCase() !== 'false') return true
  return /tradewatcher/i.test(process.env.DEBUG ?? '')
}

interface Bucket {
  label: string
  /** 去重后的标的名（保序，样例从这里取） */
  subjects: string[]
  subjectSet: Set<string>
  /** 原因 → 次数（聚合行的"（…×N）"用它） */
  reasons: Map<string, number>
  /** 逐标的完整明细（只在 debug 级输出） */
  details: string[]
}

const buckets = new Map<string, Bucket>()
/**
 * 聚合窗口：一轮取数里同一 `kind` 的降级都落进同一个桶。
 *
 * 取 400ms 的理由：`/quotes` 一轮（腾讯 → 新浪 → 兜底）实测 100–1200ms，
 * 而相邻两轮之间至少隔一个客户端轮询间隔（默认 10s）⇒ 400ms 既能把一轮收全，
 * 又不会把两轮并成一行（并成一行会让人以为"只降级了一次"）。
 */
const AGG_FLUSH_MS = 400
let flushTimer: ReturnType<typeof setTimeout> | null = null
let sink: (line: string) => void = (line) => console.warn(line)
let debugSink: (line: string) => void = (line) => console.debug(line)

/** 测试/自检注入输出口（传 null 恢复默认；返回前一个 sink 便于恢复） */
export function setDegradedSink(fn: ((line: string) => void) | null): (line: string) => void {
  const prev = sink
  sink = fn ?? ((line) => console.warn(line))
  return prev
}

export function setDebugSink(fn: ((line: string) => void) | null): (line: string) => void {
  const prev = debugSink
  debugSink = fn ?? ((line) => console.debug(line))
  return prev
}

/**
 * 记一次降级（**不直接打印**：进桶，窗口到期聚合成一行）。
 *
 * @param kind  桶键（同键合并）：`'kline-cache'` / `'quotes-batch'` / …
 * @param label 聚合行的主语，如 `K 线缓存降级采用`
 * @param subject 标的/文件名（去重；聚合行只取前几个当"样例"）
 * @param reason 原因（聚合行按原因计数；**不要**放标的独有的细节，那进 `detail`）
 * @param detail 逐标的明细（debug 级）
 */
export function noteDegraded(kind: string, note: { label: string; subject: string; reason: string; detail?: string }): void {
  let bucket = buckets.get(kind)
  if (bucket === undefined) {
    bucket = { label: note.label, subjects: [], subjectSet: new Set(), reasons: new Map(), details: [] }
    buckets.set(kind, bucket)
  }
  if (!bucket.subjectSet.has(note.subject)) {
    bucket.subjectSet.add(note.subject)
    bucket.subjects.push(note.subject)
  }
  const reason = note.reason.trim() === '' ? '原因未给出' : note.reason.trim()
  bucket.reasons.set(reason, (bucket.reasons.get(reason) ?? 0) + 1)
  bucket.details.push(note.detail ?? `${note.subject}：${reason}`)
  scheduleFlush()
}

function scheduleFlush(): void {
  if (flushTimer !== null) return
  flushTimer = setTimeout(() => { flushDegraded() }, AGG_FLUSH_MS)
  // 不要让一个待聚合的定时器把进程/测试挂住
  const timer = flushTimer as unknown as { unref?: () => void }
  timer.unref?.()
}

/** 原因计数 → `未完成 bar 已超过 60s TTL ⇒ 回源重取 ×27、…` */
function reasonTally(reasons: Map<string, number>): string {
  const entries = [...reasons.entries()].sort((a, b) => b[1] - a[1])
  const shown = entries.slice(0, 3).map(([reason, n]) => (n > 1 ? `${reason} ×${n}` : reason))
  const extra = entries.length > 3 ? ` 等 ${entries.length} 类原因` : ''
  return `${shown.join('、')}${extra}`
}

/**
 * 立即聚合输出（窗口到期会自动调用；测试直接调它取确定结果）。
 * 返回本轮产出的行（同时送 sink），桶清空。
 */
export function flushDegraded(): string[] {
  if (flushTimer !== null) {
    clearTimeout(flushTimer)
    flushTimer = null
  }
  if (buckets.size === 0) return []
  const lines: string[] = []
  const debug = debugEnabled()
  for (const bucket of buckets.values()) {
    const n = bucket.subjectSet.size
    const sample = bucket.subjects.slice(0, 3).join('、')
    const more = n > 3 ? ` 等 ${n} 个` : ''
    lines.push(
      `[tradewatcher] ${bucket.label} ${n} 个（${reasonTally(bucket.reasons)}）；样例：${sample}${more}；明细见 debug 级（TW_DEBUG=1）`,
    )
    if (debug) for (const detail of bucket.details) debugSink(`[tradewatcher][debug] ${bucket.label}：${detail}`)
  }
  buckets.clear()
  for (const line of lines) sink(line)
  return lines
}

/** 当前待聚合的桶（测试断言"只聚合不逐条打印"用；不触发输出） */
export function pendingDegraded(): Array<{ kind: string; label: string; count: number }> {
  return [...buckets.entries()].map(([kind, b]) => ({ kind, label: b.label, count: b.subjectSet.size }))
}

/** 清空待聚合的桶（**测试钩子**；不输出） */
export function __resetDegraded(): void {
  if (flushTimer !== null) {
    clearTimeout(flushTimer)
    flushTimer = null
  }
  buckets.clear()
}

// ─────────────────────────── ③ 部分成功契约 ───────────────────────────────

export interface PartialOutcome {
  /** 请求标的数 */
  requested: number
  /** 取到可用值的标的数 */
  succeeded: number
  /** 取不到的标的数 */
  failed: number
  /** 是否**至少有一个**标的可用 ⇒ 路由必须 200（不许因为部分失败变成 503） */
  partialOk: boolean
}

/** 多标的路由的部分成功判定：`succeeded > 0` 就必须 200 */
export function partialOutcomeOf(requested: number, succeeded: number): PartialOutcome {
  const total = Math.max(0, requested)
  const ok = Math.min(total, Math.max(0, succeeded))
  return { requested: total, succeeded: ok, failed: total - ok, partialOk: ok > 0 }
}

/**
 * 「全部来源 × 全部标的都失败」时**唯一允许**的 5xx。
 *
 * 消息必须写清两件事（缺一不可，否则界面上只剩一句"不可用"，没人知道该等谁）：
 *   ① **哪个上游**：主机名（`upstreams`）；
 *   ② **哪个范围**：本次涉及多少只、哪几只（`scope` + `subjects`）。
 */
export class TotalUpstreamError extends HttpError {
  readonly upstreams: readonly string[]
  readonly scope: string
  readonly subjects: readonly string[]

  constructor(input: { upstreams: readonly string[]; scope: string; subjects: readonly string[]; reason?: string }) {
    const tail = input.reason === undefined || input.reason === '' ? '' : `；原因：${input.reason}`
    const list = input.subjects.slice(0, 6).join('、')
    const more = input.subjects.length > 6 ? ` 等 ${input.subjects.length} 只` : ''
    // 聚合类路由（板块榜单）没有"逐标的"这回事 ⇒ 只报范围，不硬凑"0 只标的"
    const scopeText = input.subjects.length === 0
      ? `「${input.scope}」`
      : `「${input.scope}」的 ${input.subjects.length} 只标的（${list}${more}）`
    super(`上游全部不可用：${input.upstreams.join(' / ')} 对${scopeText}均未给出可用数据${tail}`, 503)
    this.name = 'TotalUpstreamError'
    this.upstreams = [...input.upstreams]
    this.scope = input.scope
    this.subjects = [...input.subjects]
  }
}
