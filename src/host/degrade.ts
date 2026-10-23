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
  const st = noiseOf(host)
  const wasTripped = st.prevOpen || st.prevTrips > 0
  st.prevOpen = false
  st.prevTrips = 0
  st.probed = false
  if (wasTripped) {
    // ③ 状态转换「恢复」——这是熔断周期里**必须留下**的三条之一
    emitHostTransition(host, 'recovered', '探测成功，熔断解除')
  }
  // ⑤ 恢复后计数归零：这台主机相关签名的抑制账清零（下次再出事按"首次"重新算）
  resetSuppressionFor(host)
}

/** 一次主机请求失败（**真实发出过请求**才算；熔断期跳过请用 `noteHostSkipped`） */
export function noteHostFailure(host: string, error: unknown): void {
  const t = timelineOf(host)
  t.lastFailAt = Date.now()
  t.consecutiveFails += 1
  t.lastError = error instanceof Error ? error.message : String(error)
  const b = breakerFor(host)
  const st = noiseOf(host)
  const openNow = !b.allow()
  if (openNow) {
    /**
     * ① **熔断开启**只在状态**转换**时留一条；此后每个 tick 的失败只进计数器
     * （`期间抑制 N 条` 会在探测/恢复那两条里给出）—— 这正是刷屏的根源。
     */
    if (!st.prevOpen) emitHostTransition(host, 'open', `连续失败 ${b.state.trips} 次后熔断，冷却 ${b.minutesLeft()} 分钟`)
    else st.suppressed += 1
  }
  st.prevOpen = openNow
  st.prevTrips = b.state.trips
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
  const st = noiseOf(host)
  const openNow = !breakerFor(host).allow()
  if (openNow) {
    if (!st.prevOpen) emitHostTransition(host, 'open', `熔断冷却中（本轮未发请求：${shortError(reason, 24)}）`)
    else st.suppressed += 1
  }
  st.prevOpen = openNow
}

/**
 * ② **half-open 探测**（`breakerFetch.withHostBreaker` 在"冷却到期、放行一个探针"时调用）。
 *
 * 一个熔断周期只该留一条：重复的探测由签名抑制折叠（`期间抑制 N 条` 累计）。
 */
export function noteHostProbe(host: string): void {
  const st = noiseOf(host)
  if (st.probed) {
    st.suppressed += 1
    return
  }
  st.probed = true
  emitHostTransition(host, 'probe', '冷却到期，放行 1 个探针')
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
  /** 这条聚合涉及的**主机**（用于"主机恢复后把与它有关的抑制账清零"） */
  hosts: Set<string>
  /**
   * 熔断期被静默掉的条数（`期间抑制 N 条`）。
   * 与"聚合抑制"（同一签名跨批被折叠）不是一回事，所以分开写：
   *   · 期间抑制 = 熔断 open 时那些 tick **根本没进桶**；
   *   · 聚合抑制 = 进了桶但按签名规则没输出。
   */
  periodSuppressed: number
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

// ── 日志噪声控制（AUDIT-LOG-NOISE）：跨批抑制 / 熔断期降噪 / 行长上限 ──────────

/** 单条聚合日志的**硬上限**（超出就截断，末尾给 `(其余见 TW_DEBUG=1)`） */
export const LOG_LINE_MAX = 200
/** 同一签名"累计每翻 10 倍"才再输出一条（1 → 10 → 100 → 1000 …） */
export const LOG_SILENT_STEP = 10
const LINE_TAIL = '…(其余见 TW_DEBUG=1)'

/**
 * 原因串的**最短表述**（聚合行只写它，长解释留 `TW_DEBUG=1`）。
 *
 * 为什么必须缩短：K 线降级的原因里带着"文件里有 810 根 / 808 根 / 806 根…"这种逐文件不同的尾巴，
 * 于是同一件事在聚合行里被展开成一长串近乎重复的整句（用户贴的日志里那行有几百字）。
 * 这里在第一个分隔符处截断并限长 —— 聚合行要的是"**哪一类**原因、各多少次"。
 */
export function shortReasonOf(reason: string, max = 22): string {
  const t = reason.trim()
  if (t === '') return '原因未给出'
  let cut = t
  for (const sep of ['；', ';', '⇒', '（', '(', '：', '，', ',']) {
    const at = cut.indexOf(sep)
    if (at > 0) cut = cut.slice(0, at)
  }
  cut = cut.trim()
  if (cut === '') return '原因未给出'
  return cut.length <= max ? cut : `${cut.slice(0, max - 1)}…`
}

/** 单条日志限长（超长截断 + 尾巴指明去哪看全文） */
export function clipLogLine(line: string, max = LOG_LINE_MAX): string {
  if (line.length <= max) return line
  const keep = Math.max(0, max - LINE_TAIL.length)
  return `${line.slice(0, keep)}${LINE_TAIL}`
}

interface SigRecord {
  /** 该签名累计条数（含被抑制的） */
  total: number
  /** 已输出条数 */
  emitted: number
  /** 被抑制条数（= total − emitted） */
  suppressed: number
  /** 下一次允许输出的累计值（10 的幂） */
  emitAt: number
  /** 上次输出时的原因签名（变了 ⇒ 立刻再出一条：状态变了不能静默） */
  reasonKey: string
}

const sigs = new Map<string, SigRecord>()
/** 每个签名涉及的主机（主机恢复 ⇒ 把这些签名的抑制账清零，下次再出事按"首次"重新算） */
const sigHosts = new Map<string, Set<string>>()
let logSuppressedTotal = 0
let logEmittedTotal = 0

function signatureOf(kind: string): SigRecord {
  let rec = sigs.get(kind)
  if (rec === undefined) {
    rec = { total: 0, emitted: 0, suppressed: 0, emitAt: 1, reasonKey: '' }
    sigs.set(kind, rec)
  }
  return rec
}

export interface LogAdmission {
  emit: boolean
  /** 该签名**累计**被抑制的条数（写进"期间抑制 N 条"） */
  suppressed: number
  total: number
}

/**
 * 同一签名该不该真的输出（跨批抑制的核心）。
 *
 * 规则：**首次**输出；此后同一签名在**状态未变**时只在"累计数每翻 10 倍"（10/100/1000…）各输出一条，
 * 其余静默累加计数；**原因签名变了**（换了一种失败）则立刻输出 —— 状态变了不能静默。
 *
 * 为什么不是"每 N 秒一条"：时间窗抑制在故障持续时仍然按窗刷屏（用户那份日志就是每 tick 三条）；
 * 按**累计次数**抑制才有上界：N 次事件最多输出 `1 + floor(log10(N))` 条。
 */
function admitSignature(sig: string, reasonKey: string, hosts?: Iterable<string>): LogAdmission {
  if (hosts !== undefined) {
    let set = sigHosts.get(sig)
    if (set === undefined) { set = new Set<string>(); sigHosts.set(sig, set) }
    for (const h of hosts) set.add(h)
  }
  const rec = signatureOf(sig)
  rec.total += 1
  const changed = rec.reasonKey !== '' && reasonKey !== rec.reasonKey
  const emit = rec.total === 1 || changed || rec.total >= rec.emitAt
  if (emit) {
    rec.emitted += 1
    logEmittedTotal += 1
    rec.reasonKey = reasonKey
    let next = rec.emitAt <= 1 ? LOG_SILENT_STEP : rec.emitAt * LOG_SILENT_STEP
    while (next <= rec.total) next *= LOG_SILENT_STEP
    rec.emitAt = next
  } else {
    rec.suppressed += 1
    logSuppressedTotal += 1
  }
  return { emit, suppressed: rec.suppressed, total: rec.total }
}

/** 抑制统计（供断言/自检/排障：**抑制了多少条**一眼可查，不靠猜） */
export function logNoiseStats(): { emitted: number; suppressed: number } {
  return { emitted: logEmittedTotal, suppressed: logSuppressedTotal }
}

/** 该主机"恢复"后把与它有关的抑制账清零（下次再出事按首次重新算） */
function resetSuppressionFor(host: string): void {
  for (const [key, hosts] of [...sigHosts.entries()]) {
    if (!hosts.has(host)) continue
    sigs.delete(key)
    sigHosts.delete(key)
  }
  for (const key of [...sigs.keys()]) if (key.includes(`|${host}`)) sigs.delete(key)
  hostNoise.delete(host)
}

/** 主机降噪状态：熔断期只累计、不逐 tick 记录 */
interface HostNoise {
  prevOpen: boolean
  prevTrips: number
  probed: boolean
  /** 抑制期间累计的条数（写在探测/恢复那两条里） */
  suppressed: number
}

const hostNoise = new Map<string, HostNoise>()

function noiseOf(host: string): HostNoise {
  let st = hostNoise.get(host)
  if (st === undefined) {
    st = { prevOpen: false, prevTrips: 0, probed: false, suppressed: 0 }
    hostNoise.set(host, st)
  }
  return st
}

type HostTransition = 'open' | 'probe' | 'recovered'

const TRANSITION_LABEL: Record<HostTransition, string> = {
  open: '上游熔断开启',
  probe: '上游 half-open 探测',
  recovered: '上游恢复',
}

/**
 * ② 熔断周期的**三次状态转换**（开启 / half-open 探测 / 恢复）——其余 tick 只进计数器。
 *
 * 转换行**立即**输出（不进 400ms 桶）：它们是状态事实，等一个窗口没有意义；
 * 但同样过签名抑制 —— 反复 open↔probe 的循环不会把日志刷满。
 */
function emitHostTransition(host: string, kind: HostTransition, why: string): void {
  const st = noiseOf(host)
  const suppressed = st.suppressed
  st.suppressed = 0
  /**
   * 转换行也进**桶**（同窗口多台合并成 1 行：`上游恢复 3 个（…）；样例：a、b、c`），
   * 但它**绕过**"熔断期静默"过滤器 —— 熔断开启那一刻主机正是在冷却中，过滤会把这条唯一的状态事实吃掉。
   */
  enqueue(`host-${kind}`, {
    label: TRANSITION_LABEL[kind],
    subject: host,
    reason: why,
    detail: `${host} ${why}${suppressed > 0 ? `；期间抑制 ${suppressed} 条` : ''}`,
  }, true, suppressed)
}

/**
 * 记一次降级（**不直接打印**：进桶，窗口到期聚合成一行）。
 *
 * @param kind  桶键（同键合并）：`'kline-cache'` / `'quotes-batch'` / …
 * @param label 聚合行的主语，如 `K 线缓存降级采用`
 * @param subject 标的/文件名（去重；聚合行只取前几个当"样例"）
 * @param reason 原因（聚合行按原因计数；**不要**放标的独有的细节，那进 `detail`）
 * @param detail 逐标的明细（debug 级）
 * @param hosts 这条降级涉及的**主机**：本轮它们都处于熔断 open ⇒ 只计数不出行
 *              （熔断期的每个 tick 都是同一件事，见 AUDIT-LOG-NOISE ②）
 */
export function noteDegraded(
  kind: string,
  note: { label: string; subject: string; reason: string; detail?: string; hosts?: readonly string[] },
): void {
  enqueue(kind, note, false)
}

/** 入桶（`bypassOpenFilter` = 状态转换那条，见 `emitHostTransition`） */
function enqueue(
  kind: string,
  note: { label: string; subject: string; reason: string; detail?: string; hosts?: readonly string[] },
  bypassOpenFilter: boolean,
  periodSuppressed = 0,
): void {
  /**
   * ② 熔断期降噪：涉及的主机**全部**在冷却中 ⇒ 这一 tick 不产出日志，只把次数记到
   * 该主机的抑制计数器上（下一次状态转换那条会写 `期间抑制 N 条`）。
   * 为什么判"全部"而不是"任一台"：只要还有活主机，这次失败里就有**不是熔断引起**的部分，
   * 那条日志仍有信息量。
   */
  if (!bypassOpenFilter && note.hosts !== undefined && note.hosts.length > 0 && note.hosts.every((h) => !breakerFor(h).allow())) {
    for (const h of note.hosts) noiseOf(h).suppressed += 1
    if (debugEnabled()) debugSink(`[tradewatcher][debug] ${note.label}（熔断期抑制）：${note.subject} ${note.reason}`)
    return
  }
  let bucket = buckets.get(kind)
  if (bucket === undefined) {
    bucket = { label: note.label, subjects: [], subjectSet: new Set(), reasons: new Map(), details: [], hosts: new Set(), periodSuppressed: 0 }
    buckets.set(kind, bucket)
  }
  if (!bucket.subjectSet.has(note.subject)) {
    bucket.subjectSet.add(note.subject)
    bucket.subjects.push(note.subject)
  }
  bucket.periodSuppressed += periodSuppressed
  for (const h of note.hosts ?? []) bucket.hosts.add(h)
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

/**
 * 原因计数 → `未完成 bar 已超过 60s TTL ×52、回源失败 ×4`。
 * ⚠ 用**最短表述**归并（不同文件的不同尾巴合并成同一类），长解释只在 debug 级。
 */
function reasonTally(reasons: Map<string, number>): string {
  const agg = new Map<string, number>()
  for (const [reason, n] of reasons) {
    const key = shortReasonOf(reason)
    agg.set(key, (agg.get(key) ?? 0) + n)
  }
  const entries = [...agg.entries()].sort((a, b) => b[1] - a[1])
  const shown = entries.slice(0, 3).map(([reason, n]) => (n > 1 ? `${reason} ×${n}` : reason))
  const extra = entries.length > 3 ? ` 等 ${entries.length} 类原因` : ''
  return `${shown.join('、')}${extra}`
}

/**
 * 立即聚合输出（窗口到期会自动调用；测试直接调它取确定结果）。
 * 返回本轮产出的行（同时送 sink），桶清空。
 *
 * ① **跨批同一签名抑制**：同一 `kind` 在状态未变时只在首次与"累计数每翻 10 倍"时输出，
 * 其余静默累加；被抑制的条数写进下一次输出的 `期间抑制 N 条`。
 * ④ 行长上限 200，超出截断并指向 `TW_DEBUG=1`。
 */
export function flushDegraded(): string[] {
  if (flushTimer !== null) {
    clearTimeout(flushTimer)
    flushTimer = null
  }
  if (buckets.size === 0) return []
  const lines: string[] = []
  const debug = debugEnabled()
  for (const [kind, bucket] of buckets) {
    const n = bucket.subjectSet.size
    const sample = bucket.subjects.slice(0, 3).join('、')
    const more = n > 3 ? ` 等 ${n} 个` : ''
    const reasonKey = [...bucket.reasons.keys()].map((r) => shortReasonOf(r)).sort().join('|')
    const adm = admitSignature(`deg|${kind}`, reasonKey, bucket.hosts)
    if (!adm.emit) {
      // ④ 被抑制也要能在 TW_DEBUG=1 里看到明细（否则等于丢日志）
      if (debug) for (const detail of bucket.details) debugSink(`[tradewatcher][debug] ${bucket.label}（聚合抑制）：${detail}`)
      continue
    }
    const periodNote = bucket.periodSuppressed > 0 ? `；期间抑制 ${bucket.periodSuppressed} 条` : ''
    const foldedNote = adm.suppressed > 0 ? `；聚合抑制 ${adm.suppressed} 条` : ''
    lines.push(clipLogLine(
      `[tradewatcher] ${bucket.label} ${n} 个（${reasonTally(bucket.reasons)}）；样例：${sample}${more}${periodNote}${foldedNote}；明细见 debug 级（TW_DEBUG=1）`,
    ))
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

/** 清空待聚合的桶 + 抑制账（**测试钩子**；不输出） */
export function __resetDegraded(): void {
  if (flushTimer !== null) {
    clearTimeout(flushTimer)
    flushTimer = null
  }
  buckets.clear()
  resetLogNoise()
}

/** 清空跨批抑制账（**测试钩子**；生产里只有"主机恢复"会局部清零） */
export function resetLogNoise(): void {
  sigs.clear()
  hostNoise.clear()
  logSuppressedTotal = 0
  logEmittedTotal = 0
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
