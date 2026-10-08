/**
 * Eastmoney (东方财富) quote relay. All endpoints are the free public "延迟行情"
 * JSON feeds; browser CORS blocks them, so the host half fetches on behalf of
 * the GUI and normalizes everything to the shared model.
 *
 * Reliability layout (verified live against the deployed network):
 *  - push2delay.eastmoney.com  — primary quotes/boards host (very tolerant)
 *  - push2.eastmoney.com       — fallback quotes/boards
 *  - push2his.eastmoney.com    — history (intraday trends + daily klines),
 *                                with push2delay/push2 as fallbacks (all three
 *                                served trends2 during probing)
 *  - searchapi.eastmoney.com   — symbol search (suggest)
 */
import type {
  BoardRow,
  DataProvenance,
  DayBar,
  FqMode,
  KlineData,
  QuoteRow,
  QuoteSource,
  StockDetail,
  SuggestItem,
  TrendData,
  TrendPoint,
} from '../shared/model.ts'
import { SECID_RE } from '../shared/model.ts'
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { breakerFor, hostsAllowed, minutesToRecover } from './breaker.ts'
import { fetchSinaEtfRanking, fetchSinaQuotes, sinaSymbol as sinaQuoteSymbol } from './sina.ts'
import { fetchTencentBoards, fetchTencentMinutes, fetchTencentQuoteRows, fetchTencentSuggest, tencentCode, type TencentQuoteFull } from './tencent.ts'
import { join } from 'node:path'
import { dataHome } from './store.ts'
import { dayOf, inSession, isSettledOffline } from './time.ts'

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
const REFERER = 'https://quote.eastmoney.com/'
const SUGGEST_TOKEN = 'D43BF722C8E33BDC906FB84D85E326E8'

export const QUOTE_HOSTS = ['push2delay.eastmoney.com', 'push2.eastmoney.com']
export const HISTORY_HOSTS = ['push2his.eastmoney.com', 'push2delay.eastmoney.com', 'push2.eastmoney.com']
const SEARCH_HOST = 'searchapi.eastmoney.com'

// ─────────────────────────── tiny TTL cache ───────────────────────────────

interface CacheSlot {
  exp: number
  value: unknown
  /**
   * peek 的额外宽限（ms）。新鲜数据允许小幅过期复用（省上游请求）；
   * 而 last-known-good 兜底项必须**显式 grace: 0** —— 否则 "20s 短缓存"
   * 会被 peekCache 的 45s 宽限吞掉，真实陈旧窗口变成 ~65s（README 曾据此写错）。
   */
  grace?: number
}

const inflight = new Map<string, Promise<unknown>>()

async function ttlCache<T>(key: string, ttlMs: number, loader: () => Promise<T>): Promise<T> {
  const slot = cache.get(key)
  if (slot !== undefined && Date.now() < slot.exp) return slot.value as T
  const pending = inflight.get(key)
  if (pending !== undefined) return pending as Promise<T>
  const run = (async () => {
    const value = await loader()
    cache.set(key, { exp: Date.now() + ttlMs, value })
    return value
  })()
  inflight.set(key, run)
  try {
    return await run
  } finally {
    inflight.delete(key)
  }
}

const cache = new Map<string, CacheSlot>()

function peekCache<T>(key: string, maxAgeMs: number): T | undefined {
  const slot = cache.get(key)
  if (slot === undefined) return undefined
  const grace = slot.grace ?? maxAgeMs
  if (Date.now() > slot.exp + grace) return undefined
  return slot.value as T
}

// ─────────────────────────── low-level fetch ──────────────────────────────

async function fetchFromHost(host: string, pathAndQuery: string, timeoutMs = 7000): Promise<unknown> {
  const url = `https://${host}${pathAndQuery}`
  const res = await fetch(url, {
    headers: { 'user-agent': UA, referer: REFERER, accept: 'application/json, text/plain, */*' },
    signal: AbortSignal.timeout(timeoutMs),
    redirect: 'follow',
  })
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${host}`)
  const text = await res.text()
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error(`non-JSON reply from ${host}: ${text.slice(0, 80)}`)
  }
  return parsed
}

/**
 * 上游中继：多主机 + 多轮重试。
 *
 * 实测本机到东财的连接会随机被立刻关闭（UND_ERR_SOCKET，瞬时失败率 20–75%，
 * 与响应大小无关），单次尝试的成功率无法接受，因此按「轮 × 主机」重试，
 * 并用总体截止时间兜住延迟。任何一次成功即返回。
 *
 * **导出**：护盘采样器（rescue.ts）复用这一份实现，不再自己写一套 —— 它此前那套用
 * 单台 `push2delay` 的熔断器当整组闸门，push2delay 冷却时会把健康的 push2 一起挡掉。
 */
const FETCH_ROUNDS = 2
const FETCH_ATTEMPTS_PER_HOST = 2
const FETCH_DEADLINE_MS = 9_000

export async function fetchAny(hosts: readonly string[], pathAndQuery: string, timeoutMs = 7000): Promise<unknown> {
  // 熔断冷却期内跳过该主机；整组都在冷却才快速失败（重试只会加重上游对本机 IP 的封锁）
  const live = hostsAllowed(hosts)
  if (live.length === 0) {
    throw new Error(`上游暂时不可用（熔断中，约 ${minutesToRecover(hosts)} 分钟后自动重试）`)
  }
  // 半开期只放行一个探针，其余调用快速失败走兜底
  const claimed = live.filter((h) => breakerFor(h).claimProbe())
  if (claimed.length === 0) {
    throw new Error(`上游熔断半开探测中（约 ${minutesToRecover(hosts)} 分钟后重试）`)
  }
  const deadline = Date.now() + FETCH_DEADLINE_MS
  let lastError: unknown = null
  /** 本次调用中从未成功过的主机 —— 只对它们记失败，避免误熔健康主机 */
  const neverSucceeded = new Set<string>(claimed)
  try {
  for (let round = 0; round < FETCH_ROUNDS; round++) {
    /** 本轮是否存在"非瞬时失败"（慢失败/超时/HTTP 错误）：只有瞬时失败才值得跳过下一轮 */
    let anySlowFailure = false
    for (const host of claimed) {
      for (let attempt = 0; attempt < FETCH_ATTEMPTS_PER_HOST; attempt++) {
        const left = deadline - Date.now()
        if (left <= 250) {
          throw lastError instanceof Error ? lastError : new Error('上游请求超时')
        }
        const startedAt = Date.now()
        try {
          const ok = await fetchFromHost(host, pathAndQuery, Math.min(timeoutMs, left))
          breakerFor(host).recordSuccess()
          neverSucceeded.delete(host)
          return ok
        } catch (error) {
          lastError = error
          // 握手/连接被立刻关闭：短退避后立刻重试；HTTP 4xx 之类不重试
          const message = error instanceof Error ? error.message : String(error)
          if (/HTTP 4\d\d/.test(message)) break
          // 几十毫秒即返回的失败 = 连接被立刻关闭（针对本机 IP 的封锁特征）。
          // 慢失败（超时/半开）则说明链路只是不稳定，仍值得多试一轮。
          if (Date.now() - startedAt > 300) anySlowFailure = true
          // 抖动：并发的多个 worker 不要同步重试
          await new Promise((r) => setTimeout(r, 60 + attempt * 120 + Math.random() * 140))
        }
      }
    }
    // 整轮都是"立刻被关闭"：这不是抖动而是封锁，第二轮只会再烧掉 1–2 秒退避。
    // 抖动仍由本轮内的两次尝试覆盖（实测瞬时失败率 20–75%，两次尝试足以救回单次抖动）。
    if (!anySlowFailure && round === 0 && FETCH_ROUNDS > 1) {
      console.warn('[tradewatcher] upstream fast-fail (connection reset) on', hosts.join('/'), '— 跳过第二轮重试')
      break
    }
  }
  // 只对「本次尝试中从未成功过」的主机记失败
  for (const host of neverSucceeded) breakerFor(host).recordFailure(lastError)
  console.warn('[tradewatcher] upstream failed', hosts.join('/'), String(lastError).slice(0, 120))
  throw lastError instanceof Error ? lastError : new Error(String(lastError))
  } finally {
    for (const host of claimed) breakerFor(host).releaseProbe()
  }
}

/** Parse an EM scalar: '-' / '' / null → null, else Number. */
function num(v: unknown): number | null {
  if (v === null || v === undefined) return null
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  const s = String(v).trim()
  if (s === '' || s === '-') return null
  const n = Number(s)
  return Number.isFinite(n) ? n : null
}

function normTime(v: unknown): number | null {
  const n = num(v)
  if (n === null) return null
  if (n > 1e12) return n // already ms
  if (n > 1e9) return n * 1000 // seconds
  return null
}

function bodyOf(d: unknown): { data?: { diff?: unknown; total?: unknown } } | undefined {
  if (d !== null && typeof d === 'object') return d as { data?: { diff?: unknown; total?: unknown } }
  return undefined
}

function diffList(d: unknown): Array<Record<string, unknown>> {
  const body = bodyOf(d)
  const diff = body?.data?.diff
  if (Array.isArray(diff)) return diff as Array<Record<string, unknown>>
  if (diff !== null && typeof diff === 'object') return [diff as Record<string, unknown>]
  return []
}

// ─────────────────────────────── quotes ───────────────────────────────────

const QUOTE_FIELDS =
  'f1,f2,f3,f4,f5,f6,f8,f9,f10,f12,f13,f14,f15,f16,f17,f18,f20,f21,f23,f104,f105,f106,f124'

const LKG_MAX = 1500
const LKG_PERSIST_MS = 45_000

/** Per-secid most recent quote that actually carried a price. Persisted to
 *  <dataHome>/quotes-lkg.json so a feed drop-window right after a host
 *  restart can never blank the UI (values survive the process). */
const lastGood = new Map<string, QuoteRow>()
let lkgLoaded: Promise<void> | null = null
let lkgDirty = false
let lkgLastWrite = 0

async function loadLastGood(): Promise<void> {
  if (lkgLoaded !== null) return lkgLoaded
  lkgLoaded = (async () => {
    try {
      const raw = await readFile(join(dataHome(), 'quotes-lkg.json'), 'utf8')
      const parsed = JSON.parse(raw)
      const rows = Array.isArray(parsed?.rows) ? parsed.rows : []
      // 文件写入时刻：老版本落盘的行没有 at 字段，用它近似"观测时刻"，
      // 否则重启后这些行会被当成"时刻未知"而无法参与新鲜度判定
      const fileTs = typeof parsed?.ts === 'number' ? parsed.ts : Date.now()
      for (const r of rows) {
        if (r === null || typeof r !== 'object') continue
        const row = r as QuoteRow
        if (typeof row.secid !== 'string' || !SECID_RE.test(row.secid)) continue
        if (typeof row.price !== 'number' || !Number.isFinite(row.price)) continue
        // 键用大小写无关形式：库里可能存着历史写入的大写 secid（如 114.LHM），
        // 而新请求是小写（114.lhm）—— 按原样做键会让这些标的丢掉兜底价
        lastGood.set(row.secid.toUpperCase(), typeof row.at === 'number' ? row : { ...row, at: fileTs })
      }
    } catch {
      /* no persisted file yet — first boot */
    }
  })()
  return lkgLoaded
}

function persistLastGood(): void {
  if (!lkgDirty) return
  const now = Date.now()
  if (now - lkgLastWrite < LKG_PERSIST_MS) return
  lkgLastWrite = now
  lkgDirty = false
  if (lastGood.size > LKG_MAX) {
    let drop = lastGood.size - LKG_MAX
    for (const key of lastGood.keys()) {
      if (drop <= 0) break
      lastGood.delete(key)
      drop -= 1
    }
  }
  const rows = [...lastGood.values()]
  void (async () => {
    try {
      await mkdir(dataHome(), { recursive: true })
      await writeFile(join(dataHome(), 'quotes-lkg.json'), JSON.stringify({ ts: Date.now(), rows }), 'utf8')
    } catch (error) {
      console.warn('[tradewatcher] persist quotes-lkg failed:', String(error))
    }
  })()
}

function noteLastGood(row: QuoteRow): void {
  lastGood.set(row.secid.toUpperCase(), { ...row, at: typeof row.at === 'number' ? row.at : Date.now() })
  lkgDirty = true
  persistLastGood()
}

/**
 * 行情新鲜度汇总（真实 `asOf` / `stale`）。
 *
 * 此前 `/quotes` 回传的 `ts` 是**响应生成时刻**，与数据本身无关：上游全挂、整屏
 * 都是 last-known-good 旧值时，界面依然显示"更新 14:32:05"，用户以为刚拿到最新价。
 * 这里按行给出真实判定：
 *   - `asOf` = 所有有价行中最新的**观测时刻**（`row.at`），无行则为 null
 *   - `stale` = 至少一行是兜底值（`source === 'lkg'`）或观测时刻已超过 `QUOTE_STALE_MS`
 *   - `staleCount` / `sources` 供界面如实标注"哪几行不是新数据、来自哪个源"
 */
export const QUOTE_STALE_MS = 90_000

export interface QuoteProvenance {
  /** 最新一次真实观测到行情的时间（epoch ms）；无有效行为 null */
  asOf: number | null
  /**
   * 请求了但**没有任何源**给出可用价格的标的（原样大小写）。
   * 与 `stale` 是两件事：`stale` 是"有价格但是旧值"，`missing` 是"一个价都没有"。
   * 界面必须区分「暂无行情源」与「本轮还没数据」，否则取自选/持仓里消失的标的
   * （曾因大小写被整批丢掉）看起来只是"还没刷新"。
   */
  missing: string[]
  /** 是否至少一行不新鲜（兜底值或已超时） */
  stale: boolean
  /** 不新鲜的行数 */
  staleCount: number
  /** 有价行数 / 总行数 */
  priced: number
  rows: number
  /** 按来源计数（em/tencent/sina/lkg） */
  sources: Record<string, number>
  /**
   * 休市定稿（P0-2 的第三态）：非交易时段 + 全部行都新鲜（没有兜底行）+ 至少有一行有价。
   * 与 `stale` 语义不同 —— 定稿是"数据已确定、不需要回源"，不是"降级复用旧值"。
   * 卡片据此显示灰色点（定稿复用）而不是绿色（实时）：未开盘时不得显示绿色。
   */
  cached: boolean
}

/**
 * 把行情新鲜度升级为 agent 可读的**数据出处契约**（P0-1）。
 *
 * 关键在 `missing[].why` 的判定：同样是"一个价都没有"，成因完全不同——
 *   - 该标的**没有备用源映射**（腾讯/新浪都不认这个 secid）**且东财可达** → `no-source`：
 *     这是上游的结构性缺口，重试一万次也没有，agent 应该改口径而不是等；
 *   - 有备用源映射但三源这次都失败了 → `transient`：稍后重试可能拿到；
 *   - 没有备用源映射**但东财此刻不可用** → 也是 `transient`（P1-7 修正）：
 *     此前只看静态映射，于是"东财被限流 + 该标的只有东财一条链路"会被判成
 *     "拆结构性缺失、重试无效"，而事实是**等东财恢复就有** —— 方向错会让 agent 放弃等待。
 *
 * 此前工具层只回 `{ ts, items }`，两者都是"列表里少几行"，agent 无从分辨。
 *
 * @param opts.emDown 覆盖"东财此刻是否不可用"（默认读熔断器与最近一次批量失败）；测试可注入
 */
export function quoteProvenance(detail: QuoteProvenance, opts: { emDown?: boolean } = {}): DataProvenance {
  const emDown = opts.emDown ?? emUnavailableNow()
  const sources: Record<string, number> = {}
  for (const [k, v] of Object.entries(detail.sources)) if (v > 0) sources[k] = v
  const keys = Object.keys(sources)
  const source: DataProvenance['source'] =
    detail.rows === 0 ? 'none' : keys.length === 1 ? (keys[0] as QuoteSource) : keys.length > 1 ? 'mixed' : 'none'
  return {
    asOf: detail.asOf,
    stale: detail.stale,
    staleCount: detail.staleCount,
    source,
    sources,
    missing: detail.missing.map((secid) => {
      const noFallback = !hasQuoteFallback(secid)
      if (noFallback && emDown) {
        return {
          what: secid,
          why: 'transient' as const,
          note: '东财行情主机本次不可用（熔断中或整批失败），而该标的没有腾讯/新浪备用源映射 —— 等东财恢复就会有（不是结构性缺失），稍后自动重试即可',
        }
      }
      if (noFallback) {
        return {
          what: secid,
          why: 'no-source' as const,
          note: '该标的无腾讯/新浪备用源映射（东财之外的源不提供它），且东财本次可正常取数 —— 属结构性缺失，重试无效',
        }
      }
      return {
        what: secid,
        why: 'transient' as const,
        note: '东财与备用源本次都未给出可用价格（限流或超时），稍后重试可能恢复',
      }
    }),
    // 这一批是否"休市定稿零回源"：定稿时 asOf 会停在收盘时刻，且没有任何兜底行
    cached: detail.cached,
  }
}

/**
 * 把行情 + 新鲜度一起取回的便捷入口。
 * 工具层此前用 `fetchQuotes`（丢掉全部出处信息），改用这个即可满足 P0-1。
 */
export async function fetchQuotesWithProvenance(secids: string[]): Promise<{
  items: Record<string, QuoteRow>
  provenance: DataProvenance
  /** 有价行数 / 总行数（供调用方判断"是不是整批空"） */
  priced: number
  rows: number
}> {
  const detail = await fetchQuotesDetailed(secids)
  return {
    items: detail.items,
    provenance: quoteProvenance(detail),
    priced: detail.priced,
    rows: detail.rows,
  }
}

export function summarizeQuoteProvenance(items: Record<string, QuoteRow>, now = Date.now(), missing: string[] = []): QuoteProvenance {
  let asOf: number | null = null
  let staleCount = 0
  let priced = 0
  const sources: Record<string, number> = {}
  const rows = Object.values(items)
  for (const row of rows) {
    const src = row.source ?? 'em'
    sources[src] = (sources[src] ?? 0) + 1
    if (row.price === null) continue
    priced += 1
    const at = typeof row.at === 'number' && Number.isFinite(row.at) ? row.at : null
    if (at !== null && (asOf === null || at > asOf)) asOf = at
    if (src === 'lkg' || at === null || now - at > QUOTE_STALE_MS) staleCount += 1
  }
  // 定稿判定：休市 + 零兜底行 + 有价（盘中永远为 false；分钟级延迟的盘中数据不是"定稿"）
  const cached = !inSession(now) && staleCount === 0 && priced > 0
  return { asOf, stale: staleCount > 0, staleCount, priced, rows: rows.length, sources, missing, cached }
}

/**
 * Field-level last-known-good fill for one request list. The delay feed
 * occasionally answers a symbol with f2='-' (empty price) or drops it from
 * the diff entirely for tens of seconds; a blank sample must never replace a
 * good reading. Works on any Map (`bank` defaults to the persisted store), so
 * it is also applied to TTL-cache hits and is unit-testable.
 */
export function fillLastGood(
  list: readonly string[],
  rows: Map<string, QuoteRow>,
  bank: Map<string, QuoteRow> = lastGood,
): void {
  for (const secid of list) {
    const row = rows.get(secid)
    const good = bank.get(secid.toUpperCase())
    if (row === undefined) {
      // 整行来自兜底库：标 source='lkg' 并保留**原始观测时刻**（at），
      // 界面与 /quotes 的 asOf 才能如实反映"这是几点的旧价"。
      // secid 归位到**本次请求的写法**，保证客户端按自己持有的 secid 能取到。
      if (good !== undefined && good.price !== null) rows.set(secid, { ...good, secid, source: 'lkg' })
      continue
    }
    if (row.price !== null) {
      if (bank === lastGood) noteLastGood(row)
      else bank.set(secid.toUpperCase(), { ...row })
      continue
    }
    if (good !== undefined && good.price !== null) {
      // 价格本身取自旧值 → 该行即兜底行（即使行内有其它字段是新的）
      if (row.price === null) row.price = good.price
      if (row.chg === null) row.chg = good.chg
      if (row.pct === null) row.pct = good.pct
      if (row.prev === null) row.prev = good.prev
      if (row.open === null) row.open = good.open
      if (row.high === null) row.high = good.high
      if (row.low === null) row.low = good.low
      if (row.time === null) row.time = good.time
      row.source = 'lkg'
      if (typeof good.at === 'number') row.at = good.at
    }
  }
}

function rowsFrom(json: unknown): Map<string, QuoteRow> {
  const rows = new Map<string, QuoteRow>()
  for (const it of diffList(json)) {
    const market = String(it.f13 ?? '')
    const code = String(it.f12 ?? '')
    if (market === '' || code === '' || code === 'undefined') continue
    const secid = `${market}.${code}`
    rows.set(secid, {
      secid,
      code,
      name: String(it.f14 ?? secid),
      price: num(it.f2),
      chg: num(it.f4),
      pct: num(it.f3),
      prev: num(it.f18),
      open: num(it.f17),
      high: num(it.f15),
      low: num(it.f16),
      vol: num(it.f5),
      amount: num(it.f6),
      up: num(it.f104),
      down: num(it.f105),
      even: num(it.f106),
      time: normTime(it.f124),
      // 市值：东财 f20/f21 已是**元**（fltt=2 只影响价格类字段的缩放）
      totalMv: num(it.f20),
      floatMv: num(it.f21),
      // 真实观测时刻（本行的 asOf）：客户端据此显示"数据是几点几分拿到的"，
      // 而不是"响应是几点几分返回的"（后者在上游不可用时会显示成刚刚更新）
      at: Date.now(),
    })
  }
  return rows
}

/**
 * 批量行情（自选/持仓的主路径，每 refreshSec 秒一次）。
 *
 * 此前这里是「每主机单次尝试 + 静默 catch」——全项目最高频的路径反而最不受保护，
 * 且行情主机被限流时仍会持续打请求（熔断器形同虚设）。现改为：
 *   - 复用 fetchAny（多轮 + 抖动退避 + 总截止 + 按主机熔断 + 半开探针）
 *   - 主机只丢一部分标的时，对缺口再试一轮（最多两轮，避免放大请求量）
 *   - 失败必打日志（含主机与错误），不再静默
 */
/**
 * 东财行情批量取数最近一次是否整批失败，以及失败时刻（P1-7）。
 *
 * 用途只有一个：`missing[]` 的归因方向。同样是"这个标的没有价"：
 *   - 东财**可达**但没有这个标的（如某些美股/国际指数它不给）→ 结构性缺失，重试无效；
 *   - 东财**此刻不可用**（熔断中或刚整批失败）+ 该标的没有腾讯/新浪映射 →
 *     等东财恢复就会有，"重试无效"是错的结论（agent 会据此改口径、放弃等待）。
 */
let lastEmBatchFailed = false
let lastEmBatchFailAt = 0
/** 整批失败后的"算作现在不可用"窗口：超过它就不再拿旧失败说事 */
const EM_FAIL_RECENT_MS = 120_000

/** 东财此刻是否不可用：熔断中，或最近 2 分钟内整批失败过 */
function emUnavailableNow(): boolean {
  if (QUOTE_HOSTS.every((host) => !breakerFor(host).allow())) return true
  return lastEmBatchFailed && Date.now() - lastEmBatchFailAt <= EM_FAIL_RECENT_MS
}

async function rawQuotes(list: string[]): Promise<Map<string, QuoteRow>> {
  const rows = new Map<string, QuoteRow>()
  for (let pass = 0; pass < 2; pass++) {
    const missing = list.filter((secid) => !rows.has(secid))
    if (missing.length === 0) break
    const q = `secids=${encodeURIComponent(missing.join(','))}&fltt=2&invt=2&fields=${QUOTE_FIELDS}`
    try {
      const json = await fetchAny(QUOTE_HOSTS, `/api/qt/ulist.np/get?${q}`)
      // 东财回包用**它自己的 f12 大小写**（商品是小写 rbm/lhm），而请求与库里的写法可能不同
      // （历史数据曾被大写化）。这里按大小写无关把行归位到本次请求的写法，否则
      // 客户端按自己持有的 secid 查不到这行（表现为"行情条少了几项"）。
      const want = new Map(missing.map((secid) => [secid.toUpperCase(), secid]))
      for (const [echoed, row] of rowsFrom(json)) {
        const asRequested = want.get(echoed.toUpperCase()) ?? echoed
        rows.set(asRequested, asRequested === row.secid ? row : { ...row, secid: asRequested })
      }
    } catch (error) {
      // 记下"东财这会儿不可用"：missing[] 的归因要用它区分结构性缺失与瞬时故障
      lastEmBatchFailed = true
      lastEmBatchFailAt = Date.now()
      console.warn('[tradewatcher] quotes batch failed', `pass ${pass + 1}`, `${missing.length} symbols`, String(error).slice(0, 120))
      break
    }
    // 拿到回包（哪怕 diff 为空）说明东财可达 → 清掉失败标记
    lastEmBatchFailed = false
  }
  return rows
}

/**
 * 腾讯备用源的批量行情（自选/持仓的行情链路）。
 *
 * 东财行情主机遇限流时，此前只能吃 last-known-good（价格冻在旧值，用户看到的就是
 * "无法加载最新数据"）。这里把腾讯作为实时兜底：EM 拿不到的标的用腾讯补齐，
 * 结果带 source='tencent' 以便界面如实标注来源。仅覆盖沪/深/港股；
 * 美股、国际指数、商品无法映射，仍只有东财源。
 */
export function quoteFromTencent(secid: string, q: TencentQuoteFull): QuoteRow | null {
  if (q.price === null || !(q.price > 0)) return null
  const prev = q.prev
  const chg = q.price !== null && prev !== null ? q.price - prev : null
  const pct = q.pct ?? (chg !== null && prev !== null && prev > 0 ? (chg / prev) * 100 : null)
  return {
    secid,
    code: secid.split('.')[1] ?? secid,
    name: q.name === '' ? secid : q.name,
    price: q.price,
    chg,
    pct,
    prev,
    open: q.open,
    high: q.high,
    low: q.low,
    vol: q.vol,
    amount: q.amount,
    up: null,
    down: null,
    even: null,
    time: q.ts,
    source: 'tencent',
    at: Date.now(),
    totalMv: q.totalMv,
    floatMv: q.floatMv,
  }
}

async function tencentQuoteRows(list: readonly string[]): Promise<Map<string, QuoteRow>> {
  const out = new Map<string, QuoteRow>()
  const usable = list.filter((secid) => tencentCode(secid) !== null)
  if (usable.length === 0) return out
  const rows = await fetchTencentQuoteRows([...usable])
  for (const [secid, q] of Object.entries(rows)) {
    const row = quoteFromTencent(secid, q)
    if (row !== null) out.set(secid, row)
  }
  return out
}

/** 用腾讯补齐缺失或价格为空的标的（EM 部分丢码时也走这里） */
/**
 * 兜底链：**腾讯（沪/深/港 + 美股指数）→ 新浪（国际指数、国内期货、外盘商品）**。
 *
 * 此前只有腾讯，于是「国际市场 + 大宗商品」共 17 只标的在东财不可用时**代码层就没有任何兜底**
 * （客户端只能吃 LKG 旧值）—— 实测 23 只预设里只有 6 只可解析。现补新浪一档：
 * 国际指数 int_*（含日经/德国/富时，腾讯没有）、国内期货 nf_*、外盘商品 hf_*。
 */
async function fillFromFallbacks(list: readonly string[], rows: Map<string, QuoteRow>): Promise<void> {
  const need = (): string[] => list.filter((secid) => {
    const row = rows.get(secid)
    return row === undefined || row.price === null
  })
  const missing = need()
  if (missing.length === 0) return
  try {
    const tx = await tencentQuoteRows(missing)
    for (const [secid, row] of tx) {
      const cur = rows.get(secid)
      if (cur === undefined || cur.price === null) rows.set(secid, row)
      // 字段级混源：价格来自东财、成交额来自腾讯（两者快照时刻不同）→ 明确标注 amountSource
      else if (cur.amount === null && row.amount !== null) rows.set(secid, { ...cur, amount: row.amount, amountSource: 'tencent' })
    }
  } catch {
    /* 继续尝试新浪 */
  }
  const still = need()
  if (still.length === 0) return
  try {
    const sx = await fetchSinaQuotes(still)
    for (const [secid, q] of Object.entries(sx)) {
      const cur = rows.get(secid)
      if (cur !== undefined && cur.price !== null) continue
      rows.set(secid, {
        secid,
        code: secid.split('.')[1] ?? secid,
        name: q.name,
        price: q.price,
        chg: q.prev !== null ? q.price - q.prev : null,
        pct: q.pct,
        prev: q.prev,
        open: q.open,
        high: q.high,
        low: q.low,
        vol: null,
        amount: null,
        up: null,
        down: null,
        even: null,
        time: null,
        source: 'sina',
        at: Date.now(),
      })
    }
  } catch {
    /* 三个源都不可用时交给 LKG */
  }
}

function rowsToRecord(rows: Map<string, QuoteRow>): Record<string, QuoteRow> {
  const out: Record<string, QuoteRow> = {}
  for (const row of rows.values()) out[row.secid] = row
  return out
}

/**
 * 板块/排行数据的 last-known-good。
 *
 * 这一栏只在你打开面板或切换 scope/sort 时才请求，属"冷连接"请求；东财行情 CDN
 * 被限流时它几乎必然失败（行情/护盘因为持续轮询才养着热连接）。因此失败时回落到
 * 上一次成功结果并标注时间，而不是让整块面板显示"不可用"。
 */
const boardLkg = new Map<string, { ts: number; total: number; rows: BoardRow[] }>()
let boardLkgLoaded: Promise<void> | null = null
let boardLkgDirty = false
let boardLkgLastWrite = 0

async function loadBoardLkg(): Promise<void> {
  if (boardLkgLoaded !== null) return boardLkgLoaded
  boardLkgLoaded = (async () => {
    try {
      const raw = await readFile(join(dataHome(), 'board-lkg.json'), 'utf8')
      const parsed = JSON.parse(raw) as { entries?: Array<{ key?: string; ts?: number; total?: number; rows?: BoardRow[] }> }
      for (const e of Array.isArray(parsed?.entries) ? parsed.entries : []) {
        if (typeof e?.key !== 'string' || typeof e?.ts !== 'number' || !Array.isArray(e?.rows)) continue
        boardLkg.set(e.key, { ts: e.ts, total: typeof e.total === 'number' ? e.total : e.rows.length, rows: e.rows })
      }
    } catch {
      /* 首次 */
    }
  })()
  return boardLkgLoaded
}

function persistBoardLkg(): void {
  if (!boardLkgDirty) return
  const now = Date.now()
  if (now - boardLkgLastWrite < 10_000) return
  boardLkgLastWrite = now
  boardLkgDirty = false
  const entries = [...boardLkg.entries()].slice(-40).map(([key, v]) => ({ key, ts: v.ts, total: v.total, rows: v.rows }))
  void (async () => {
    try {
      await mkdir(dataHome(), { recursive: true })
      await writeFile(join(dataHome(), 'board-lkg.json'), JSON.stringify({ ts: Date.now(), entries }), 'utf8')
    } catch (error) {
      console.warn('[tradewatcher] persist board-lkg failed:', String(error))
    }
  })()
}

/** Batch quotes with a 2.5 s TTL + last-known-good on every return path
 *  (fresh fetch, TTL hit and peek hit alike). */
/**
 * 逐标的行情缓存槽。
 *
 * 此前缓存键是**整批 id 的拼接**（`quotes:1.600519,1.510300,…`），于是
 * `/quotes`（引擎：行情条 + 自选 + 持仓）与 `/portfolio`（仅持仓）虽然标的**互相包含**，
 * 却落在两个槽里 → 每个客户端节拍各打一次上游（实测一拍 20 次上游请求，其中持仓那 3 个
 * 标的是引擎集合的子集，纯重复劳动）。改为逐标的槽后，子集请求直接命中，
 * 一拍只剩一次批量取数。
 */
const quoteSlots = new Map<string, { exp: number; at: number; row: QuoteRow }>()
/** 槽位上限（与 LKG_MAX 对称）：只增不减会随"历史上出现过的标的"无限增长 */
const QUOTE_SLOT_MAX = 1500

/** 在飞的批量取数：大小写键 → 覆盖它的那次批量（并发去重，避免同一批打两遍） */
const quoteInflight = new Map<string, Promise<void>>()

/** 兜底可用窗口：上游失败时仍可服务最近一次成功读数（旧到看不出来时由 `at`/`stale` 如实暴露） */
const QUOTE_SERVE_STALE_MS = 10 * 60_000

/** 新鲜度窗口（ms）：跟随用户的刷新间隔设置，夹在 5–60 秒；由插件入口与 prefs 变更处写入 */
let quoteFreshMs = 10_000

export function setQuoteFreshnessMs(ms: number): void {
  if (!Number.isFinite(ms)) return
  quoteFreshMs = Math.max(5_000, Math.min(60_000, Math.round(ms)))
}

export function quoteFreshnessMs(): number {
  return quoteFreshMs
}

/** 去重（大小写无关，保留首次出现的写法）+ 稳定排序 */
function normalizeQuoteList(secids: readonly string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of secids) {
    const id = raw.trim()
    if (id === '' || seen.has(id.toUpperCase())) continue
    seen.add(id.toUpperCase())
    out.push(id)
  }
  return out.sort((a, b) => (a.toUpperCase() < b.toUpperCase() ? -1 : a.toUpperCase() > b.toUpperCase() ? 1 : 0))
}

async function loadQuotes(secids: string[]): Promise<Map<string, QuoteRow>> {
  const list = normalizeQuoteList(secids)
  if (list.length === 0) return new Map()
  await loadLastGood()

  const picked = new Map<string, QuoteRow>()
  const waiters = new Set<Promise<void>>()
  const need: string[] = []
  const now = Date.now()
  for (const secid of list) {
    const key = secid.toUpperCase()
    const slot = quoteSlots.get(key)
    if (slot !== undefined && now < slot.exp) {
      picked.set(key, slot.row)
      continue
    }
    const flying = quoteInflight.get(key)
    if (flying !== undefined) {
      waiters.add(flying)
      continue
    }
    need.push(secid)
  }
  if (waiters.size > 0) await Promise.all([...waiters]).catch(() => undefined)

  // 等在飞的批量结算后重新看槽（它们可能已经把我们需要的标的填好了）
  const still: string[] = []
  for (const secid of list) {
    const key = secid.toUpperCase()
    if (picked.has(key)) continue
    const slot = quoteSlots.get(key)
    if (slot !== undefined && Date.now() < slot.exp) {
      picked.set(key, slot.row)
      continue
    }
    still.push(secid)
  }
  if (still.length > 0) {
    const ttl = quoteFreshMs
    const batch = (async () => {
      const got = await rawQuotes(still)
      // 东财整体不可用或部分丢码时，用腾讯/新浪把缺口补上
      await fillFromFallbacks(still, got)
      const at = Date.now()
      for (const [secid, row] of got) quoteSlots.set(secid.toUpperCase(), { exp: at + ttl, at, row })
      // Map 保持插入序：超限时从最旧的开始丢（正被使用的槽会被重新 set 而回到队尾）
      while (quoteSlots.size > QUOTE_SLOT_MAX) {
        const oldest = quoteSlots.keys().next()
        if (oldest.done === true) break
        quoteSlots.delete(oldest.value)
      }
    })()
    for (const secid of still) quoteInflight.set(secid.toUpperCase(), batch)
    try {
      await batch
    } catch {
      /* 批量失败不影响其它标的；下面用旧槽与 LKG 兜底 */
    } finally {
      for (const secid of still) {
        const key = secid.toUpperCase()
        if (quoteInflight.get(key) === batch) quoteInflight.delete(key)
      }
    }
  }

  const rows = new Map<string, QuoteRow>()
  const freshNow = Date.now()
  for (const secid of list) {
    const key = secid.toUpperCase()
    const pickedRow = picked.get(key)
    const slot = quoteSlots.get(key)
    // 优先用本轮（或刚在飞的那轮）拿到的行；否则退回槽里的旧读数（10 分钟内），
    // 再往下的兜底交给 LKG。行内 `at`/`source` 会如实标注它有多旧。
    const row = pickedRow ?? (slot !== undefined && freshNow - slot.at <= QUOTE_SERVE_STALE_MS ? slot.row : undefined)
    if (row === undefined) continue
    rows.set(secid, row.secid === secid ? row : { ...row, secid })
  }
  fillLastGood(list, rows)
  return rows
}

/**
 * 行情 + 真实新鲜度。`asOf` 是数据被观测到的时刻，`stale` 表示至少一行是兜底/过期值 ——
 * 二者都由行内的 `at`/`source` 推导，不依赖响应生成时间（见 summarizeQuoteProvenance）。
 */
export async function fetchQuotesDetailed(secids: string[]): Promise<QuoteProvenance & { items: Record<string, QuoteRow> }> {
  const rows = await loadQuotes(secids)
  const items = rowsToRecord(rows)
  // 大小写无关地判定"这一项到底有没有价"：调用方可能混用写法，归一到大写再比对
  const priced = new Set<string>()
  for (const row of rows.values()) if (row.price !== null) priced.add(row.secid.toUpperCase())
  const requested: string[] = []
  const seen = new Set<string>()
  for (const raw of secids) {
    const id = raw.trim()
    if (id === '' || seen.has(id.toUpperCase())) continue
    seen.add(id.toUpperCase())
    requested.push(id)
  }
  const missing = requested.filter((id) => !priced.has(id.toUpperCase()))
  return { items, ...summarizeQuoteProvenance(items, Date.now(), missing) }
}

/** 只要行情的调用方用这个（tools 等）；需要新鲜度信息的用 fetchQuotesDetailed */
export async function fetchQuotes(secids: string[]): Promise<Record<string, QuoteRow>> {
  return rowsToRecord(await loadQuotes(secids))
}

/** Detail card for one stock/ETF (extra fundamentals; indices return what the feed has). */
export async function fetchStockDetail(secid: string): Promise<StockDetail | null> {
  if (!SECID_RE.test(secid)) return null
  const json = await ttlCache(`detail:${secid}`, 10_000, () => fetchAny(QUOTE_HOSTS, `/api/qt/ulist.np/get?secids=${encodeURIComponent(secid)}&fltt=2&invt=2&fields=${QUOTE_FIELDS}`))
  const rows = diffList(json)
  const it = rows[0]
  if (it === undefined) return null
  const code = String(it.f12 ?? '')
  const market = String(it.f13 ?? '')
  return {
    secid: `${market}.${code}`,
    code,
    name: String(it.f14 ?? secid),
    price: num(it.f2),
    chg: num(it.f4),
    pct: num(it.f3),
    open: num(it.f17),
    high: num(it.f15),
    low: num(it.f16),
    prev: num(it.f18),
    vol: num(it.f5),
    amount: num(it.f6),
    turnover: num(it.f8),
    volumeRatio: num(it.f10),
    pe: num(it.f9),
    pb: num(it.f23),
    totalMv: num(it.f20),
    floatMv: num(it.f21),
    up: num(it.f104),
    down: num(it.f105),
  }
}

// ───────────────────────────── intraday trend ─────────────────────────────

function parseTrendRow(row: string): TrendPoint | null {
  const parts = row.split(',')
  if (parts.length < 3) return null
  const timeText = parts[0] // "YYYY-MM-DD HH:mm"
  const price = num(parts[2]) // close
  if (price === null) return null
  const t = Date.parse(timeText.replace(' ', 'T'))
  return {
    t: Number.isFinite(t) ? t : 0,
    label: timeText,
    price,
    avg: num(parts[7]),
    vol: num(parts[5]),
    amount: num(parts[6]),
  }
}

/**
 * 分时序列的 last-known-good：上游瞬时失败时用最近一次成功结果兜底，
 * 避免缩略图在「有 / 无」之间闪烁（与 quotes-lkg.json 同一思路）。
 * 文件：<dataHome>/trends-lkg.json
 */
const trendLkg = new Map<string, { at: number; trend: TrendData }>()
let trendLkgLoaded: Promise<void> | null = null
let trendLkgDirty = false
let trendLkgLastWrite = 0
const TREND_LKG_PERSIST_MS = 5000
const TREND_LKG_MAX = 400

function trendKey(secid: string, ndays: number): string {
  return `${secid}|${ndays}`
}

async function loadTrendLkg(): Promise<void> {
  if (trendLkgLoaded !== null) return trendLkgLoaded
  trendLkgLoaded = (async () => {
    try {
      const raw = await readFile(join(dataHome(), 'trends-lkg.json'), 'utf8')
      const parsed = JSON.parse(raw) as { entries?: Array<{ key?: string; at?: number; trend?: TrendData }> }
      for (const e of Array.isArray(parsed?.entries) ? parsed.entries : []) {
        if (typeof e?.key !== 'string' || typeof e?.at !== 'number') continue
        const t = e.trend
        if (t === null || typeof t !== 'object' || !Array.isArray(t.points) || t.points.length < 2) continue
        trendLkg.set(e.key, { at: e.at, trend: t })
      }
    } catch {
      /* 首次：无缓存文件 */
    }
  })()
  return trendLkgLoaded
}

function persistTrendLkg(): void {
  if (!trendLkgDirty) return
  const now = Date.now()
  if (now - trendLkgLastWrite < TREND_LKG_PERSIST_MS) return
  trendLkgLastWrite = now
  trendLkgDirty = false
  if (trendLkg.size > TREND_LKG_MAX) {
    let drop = trendLkg.size - TREND_LKG_MAX
    for (const key of trendLkg.keys()) {
      if (drop <= 0) break
      trendLkg.delete(key)
      drop -= 1
    }
  }
  const entries = [...trendLkg.entries()].map(([key, v]) => ({ key, at: v.at, trend: v.trend }))
  void (async () => {
    try {
      await mkdir(dataHome(), { recursive: true })
      await writeFile(join(dataHome(), 'trends-lkg.json'), JSON.stringify({ ts: Date.now(), entries }), 'utf8')
    } catch (error) {
      console.warn('[tradewatcher] persist trends-lkg failed:', String(error))
    }
  })()
}

function rememberTrend(secid: string, ndays: number, trend: TrendData): void {
  if (trend.points.length < 2) return
  trendLkg.set(trendKey(secid, ndays), { at: Date.now(), trend })
  trendLkgDirty = true
  persistTrendLkg()
}

/** 取兜底快照；maxAgeMs 为 Infinity 时表示「只要有过就用」 */
export function lastGoodTrend(secid: string, ndays: number, maxAgeMs = Infinity): TrendData | null {
  const hit = trendLkg.get(trendKey(secid, ndays))
  if (hit === undefined) return null
  if (Date.now() - hit.at > maxAgeMs) return null
  return { ...hit.trend, staleAt: hit.at }
}

/** 分时取数统一入口：内存新鲜缓存 → 休市定稿复用 → 上游（带重试）→ last-known-good */
async function trendWithFallback(
  secid: string,
  ndays: number,
  loader: () => Promise<TrendData | null>,
): Promise<TrendData | null> {
  await loadTrendLkg()
  const key = `trend:${secid}:${ndays}`
  const fresh = peekCache<TrendData>(key, 45_000)
  if (fresh !== undefined) return fresh
  // 休市且本地快照已越过最近一次收盘 → 当天的分时/五日序列不会再变，直接吃本地
  // （进程重启后仍生效：trendLkg 是落盘的）。盘中 / 快照过期一律走上游。
  const settled = trendLkg.get(trendKey(secid, ndays))
  if (settled !== undefined && settled.trend.points.length >= 2 && isSettledOffline(settled.at)) {
    const reused: TrendData = { ...settled.trend, cached: true }
    cache.set(key, { exp: Date.now() + 300_000, value: reused })
    return reused
  }
  try {
    const data = await loader()
    if (data === null || data.points.length < 2) {
      return lastGoodTrend(secid, ndays) ?? data
    }
    cache.set(key, { exp: Date.now() + 60_000, value: data })
    rememberTrend(secid, ndays, data)
    return data
  } catch (error) {
    const lkg = lastGoodTrend(secid, ndays)
    if (lkg !== null) {
      // 短缓存兜底结果：断网期间避免每行请求都重新跑满重试（行数多时会形成风暴），
      // 20s 后再试上游，恢复后立刻回到实时数据
      // 兜底项不享受 peek 宽限：20s 后必须重新回源试探（此前被 45s 宽限吞掉）
      cache.set(key, { exp: Date.now() + 20_000, value: lkg, grace: 0 })
      return lkg
    }
    // 没有 last-known-good 时用腾讯分钟线兜底（自选/持仓的缩略图与抽屉图）
    const viaTencent = await tencentTrend(secid).catch(() => null)
    if (viaTencent !== null) {
      cache.set(key, { exp: Date.now() + 30_000, value: viaTencent })
      rememberTrend(secid, ndays, viaTencent)
      return viaTencent
    }
    void error
    // 仍然拿不到：返回 null（路由回 200 + trend:null），客户端按"暂无分时"降级
    return null
  }
}

/** 腾讯分钟线 → 分时序列（价格 + 当日均价 VWAP），供东财不可用时兜底 */
async function tencentTrend(secid: string): Promise<TrendData | null> {
  const points = await fetchTencentMinutes(secid)
  if (points.length < 5) return null
  const trendPoints: TrendPoint[] = points
    .filter((p) => typeof p.price === 'number' && p.price > 0)
    .map((p) => {
      const cumVol = p.cumVol ?? null
      const avg = cumVol !== null && cumVol > 0 ? p.amount / (cumVol * 100) : null
      const label = new Date(p.ts).toISOString().slice(0, 10) + ' ' + new Date(p.ts).toTimeString().slice(0, 5)
      return { t: p.ts, label, price: p.price as number, avg, vol: cumVol, amount: null }
    })
  if (trendPoints.length < 5) return null
  return {
    secid,
    prePrice: null,
    points: trendPoints,
    last: trendPoints[trendPoints.length - 1]?.price ?? null,
    staleAt: undefined,
  }
}

/** 东财单日分时（trends2 实测只提供当日；ndays 参数被上游忽略）。 */
async function fetchTrendSingleDay(secid: string): Promise<TrendData | null> {
  const fields2 = 'f51,f52,f53,f54,f55,f56,f57,f58'
  return trendWithFallback(secid, 1, async () => {
    const json = await fetchAny(
      HISTORY_HOSTS,
      `/api/qt/stock/trends2/get?secid=${encodeURIComponent(secid)}&fields1=f1,f2,f3,f4,f5,f6,f7,f8,f9,f10,f11,f12,f13&fields2=${fields2}&ndays=1&iscr=0`,
    )
    const body = bodyOf(json)
    const data = body?.data as { prePrice?: unknown; preClose?: unknown; trends?: unknown } | undefined
    if (!data) return null
    const raw = Array.isArray(data.trends) ? data.trends : []
    const points: TrendPoint[] = []
    for (const r of raw) {
      if (typeof r !== 'string') continue
      const p = parseTrendRow(r)
      if (p !== null) points.push(p)
    }
    if (points.length === 0) return null
    const pre = num(data.prePrice) ?? num(data.preClose) ?? null
    return { secid, prePrice: pre, points, last: points[points.length - 1]?.price ?? null }
  })
}

/** 该标的是否有备用源（腾讯或新浪报价映射）；用于搜索结果与工具输出如实标注"仅东财源"。 */
export function hasQuoteFallback(secid: string): boolean {
  return tencentCode(secid) !== null || sinaQuoteSymbol(secid) !== null
}

/** 东财 secid → 新浪代码（仅 A股/深沪 ETF；港股/美股接口不适用）。 */
function sinaSymbol(secid: string): string | null {
  const dot = secid.indexOf('.')
  if (dot <= 0) return null
  const mkt = secid.slice(0, dot)
  const code = secid.slice(dot + 1)
  if (mkt === '1') return `sh${code}`
  if (mkt === '0') return `sz${code}`
  return null
}

interface MinuteBar {
  t: number
  label: string
  price: number
  vol: number | null
}

/** 新浪 5 分钟 K 线（一次可取多个交易日，用于「五日」视图）。 */
async function fetchSina5Min(sym: string, datalen: number): Promise<MinuteBar[]> {
  const url = `https://quotes.sina.cn/cn/api/json_v2.php/CN_MarketDataService.getKLineData?symbol=${sym}&scale=5&ma=no&datalen=${datalen}`
  const res = await fetch(url, {
    headers: { 'user-agent': UA, referer: 'https://finance.sina.com.cn' },
    signal: AbortSignal.timeout(9000),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status} from sina`)
  const rows = (await res.json()) as Array<{ day?: unknown; close?: unknown; volume?: unknown }>
  if (!Array.isArray(rows)) return []
  const out: MinuteBar[] = []
  for (const r of rows) {
    const label = typeof r.day === 'string' ? r.day.slice(0, 16) : null
    const price = num(r.close)
    if (label === null || price === null) continue
    const t = Date.parse(label.replace(' ', 'T'))
    if (!Number.isFinite(t)) continue
    out.push({ t, label, price, vol: num(r.volume) })
  }
  return out
}

/** 腾讯 5 分钟 K 线（新浪失败时的兜底，仅 A股/ETF）。 */
async function fetchTencent5Min(sym: string, lmt: number): Promise<MinuteBar[]> {
  const path = `/ifzqgtimg/appstock/app/kline/mkline?param=${sym},m5,,${lmt}`
  const json = (await fetchFromHost('proxy.finance.qq.com', path, 9000)) as {
    data?: Record<string, { m5?: unknown }>
  }
  const rows = json?.data?.[sym]?.m5
  if (!Array.isArray(rows)) return []
  const out: MinuteBar[] = []
  for (const r of rows) {
    if (!Array.isArray(r) || r.length < 3) continue
    const raw = String(r[0]) // YYYYMMDDHHmm
    if (raw.length < 12) continue
    const label = `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)} ${raw.slice(8, 10)}:${raw.slice(10, 12)}`
    const price = num(r[2])
    if (price === null) continue
    const t = Date.parse(label.replace(' ', 'T'))
    if (!Number.isFinite(t)) continue
    out.push({ t, label, price, vol: num(r[5]) })
  }
  return out
}

/** 多日分时（五日）：用 5 分钟 K 线拼出最近 N 个交易日。 */
async function fetchMultiDayTrend(secid: string, days: number): Promise<TrendData | null> {
  const sym = sinaSymbol(secid)
  if (sym === null) return null
  const datalen = Math.min(1000, days * 48 + 24)
  const bars = await ttlCache<MinuteBar[]>(`trend-md:${sym}:${datalen}`, 90_000, async () => {
    try {
      const s = await fetchSina5Min(sym, datalen)
      if (s.length > 0) return s
    } catch {
      /* 换腾讯 */
    }
    try {
      return await fetchTencent5Min(sym, datalen)
    } catch {
      return []
    }
  })
  if (bars.length === 0) return null
  const dates = [...new Set(bars.map((b) => b.label.slice(0, 10)))].sort()
  const keep = new Set(dates.slice(-days))
  const points: TrendPoint[] = bars
    .filter((b) => keep.has(b.label.slice(0, 10)))
    .map((b) => ({ t: b.t, label: b.label, price: b.price, avg: null, vol: b.vol }))
  if (points.length === 0) return null
  return { secid, prePrice: null, points, last: points[points.length - 1]?.price ?? null }
}

/** 分时序列：ndays=1 用东财当日分时；ndays>1 优先 5 分钟 K 拼接（新浪/腾讯），
 *  不支持的市场退回首日数据（客户端会如实显示交易日数量）。 */
export async function fetchTrend(secid: string, ndays = 1): Promise<TrendData | null> {
  if (!SECID_RE.test(secid)) return null
  const days = Math.min(5, Math.max(1, Math.round(ndays)))
  if (days > 1) {
    const multi = await trendWithFallback(secid, days, async () => {
      const got = await fetchMultiDayTrend(secid, days)
      return got !== null && got.points.length > 0 ? got : null
    })
    if (multi !== null && multi.points.length > 1) return multi
  }
  return fetchTrendSingleDay(secid)
}

// ───────────────────────────── daily kline ────────────────────────────────

// ───────────────────────── kline cache & fetch ───────────────────────────
/**
 * K 线历史在本地按 (secid, 周期, **复权口径**) 缓存：首次查看一次性拉全量，
 * 之后只拉最新几根做增量合并，上游失败时直接吃本地缓存 —— 既省请求
 * （push2his 限流严重），也保证图表永远有数据。
 *   101=日K  102=周K  103=月K  104=年K（由月K本地重采样，上游 104 实际是季K）
 *
 * 复权口径进缓存键：前复权与不复权是**两套价格序列**，混存会让图上出现
 * 无解释的跳空，所以三个口径各自一个文件、各自一套增量。
 */

/**
 * 该标的是否存在除权除息概念（决定复权开关能不能用）。
 *
 * 股票 / ETF / 基金 / 港美股 → true；指数是点位回报、期货是合约、板块是成分股统计，
 * 强行"复权"等于伪造趋势 → false。判定只看 (市场号, 代码前缀)：
 *   - 沪市(1) 000 开头是上证指数系列（沪市股票没有 000 前缀，深市才有）
 *   - 深市(0/1) 399 开头是深证指数系列
 *   - 100=国际指数 / 101·112=外盘商品 / 113·114·115=国内期货 / 90=板块 → 一律不适用
 */
export function fqSupported(secid: string): boolean {
  const dot = secid.indexOf('.')
  if (dot <= 0) return false
  const market = secid.slice(0, dot)
  const code = secid.slice(dot + 1)
  if (market === '1' || market === '0') {
    if (market === '1' && code.startsWith('000')) return false
    return !code.startsWith('399')
  }
  return market === '116' || market === '105' || market === '106' || market === '107'
}

/** 把请求口径收敛到该标的真正可用的口径：不适用恒为 0，非法值按默认前复权处理 */
export function normalizeFq(secid: string, fqt: unknown): FqMode {
  if (!fqSupported(secid)) return 0
  const n = Number(fqt)
  return n === 0 || n === 2 ? (n as FqMode) : 1
}
const KLINE_FULL_LMT: Record<number, number> = { 101: 800, 102: 400, 103: 240 }
const KLINE_RECENT_LMT: Record<number, number> = { 101: 10, 102: 5, 103: 3 }
const KLINE_CAP: Record<number, number> = { 101: 1200, 102: 800, 103: 600 }

interface KlineEntry {
  bars: DayBar[]
  loaded: boolean
  updatedAt: number
}

const klineMem = new Map<string, KlineEntry>()

function klineFile(secid: string, klt: number, fqt: FqMode): string {
  return join(dataHome(), 'klines', `${secid}_${klt}_${fqt}.json`)
}

/**
 * v0.22.0 及以前的缓存文件名是 `<secid>_<klt>.json`，那时的取数一律 `fqt=0`，
 * 所以它**就是**不复权口径的缓存 —— 只在 fqt=0 时兜底复用，不迁移、不重命名。
 */
function legacyKlineFile(secid: string, klt: number): string {
  return join(dataHome(), 'klines', `${secid}_${klt}.json`)
}

async function loadKlineCache(secid: string, klt: number, fqt: FqMode): Promise<KlineEntry> {
  const key = `${secid}|${klt}|${fqt}`
  const hit = klineMem.get(key)
  if (hit !== undefined && hit.loaded) return hit
  const entry: KlineEntry = hit ?? { bars: [], loaded: false, updatedAt: 0 }
  const paths = fqt === 0 ? [klineFile(secid, klt, fqt), legacyKlineFile(secid, klt)] : [klineFile(secid, klt, fqt)]
  for (const path of paths) {
    try {
      const raw = await readFile(path, 'utf8')
      const parsed = JSON.parse(raw) as { bars?: DayBar[]; updatedAt?: number }
      if (Array.isArray(parsed.bars) && parsed.bars.length > 0) {
        entry.bars = parsed.bars.filter((b) => b !== null && typeof b.date === 'string' && Number.isFinite(b.close))
        entry.updatedAt = typeof parsed.updatedAt === 'number' ? parsed.updatedAt : 0
        break
      }
    } catch {
      /* 该口径还没有缓存文件 */
    }
  }
  entry.loaded = true
  klineMem.set(key, entry)
  return entry
}

async function saveKlineCache(secid: string, klt: number, fqt: FqMode, bars: DayBar[]): Promise<void> {
  try {
    await mkdir(join(dataHome(), 'klines'), { recursive: true })
    await writeFile(klineFile(secid, klt, fqt), JSON.stringify({ v: 2, secid, klt, fqt, updatedAt: Date.now(), bars }), 'utf8')
    void pruneKlineCache()
  } catch (error) {
    console.warn('[tradewatcher] 保存K线缓存失败:', String(error))
  }
}

/**
 * K 线磁盘缓存裁剪：每个 (secid, klt) 一个文件，长期浏览会持续累积
 * （实测 40 个文件 2.7MB，无上限）。超过 KLINE_CACHE_MAX 时按 mtime 从最旧开始删。
 * 有节流：最多 10 分钟扫一次目录，不影响常态写入路径。
 */
const KLINE_CACHE_MAX = 300
let klinePruneAt = 0

async function pruneKlineCache(): Promise<void> {
  const now = Date.now()
  if (now - klinePruneAt < 600_000) return
  klinePruneAt = now
  try {
    const dir = join(dataHome(), 'klines')
    const names = await readdir(dir)
    if (names.length <= KLINE_CACHE_MAX) return
    const stats = await Promise.all(
      names.map(async (name) => {
        try {
          const st = await stat(join(dir, name))
          return { name, mtime: st.mtimeMs }
        } catch {
          return { name, mtime: 0 }
        }
      }),
    )
    stats.sort((a, b) => a.mtime - b.mtime)
    for (const drop of stats.slice(0, stats.length - KLINE_CACHE_MAX)) {
      await rm(join(dir, drop.name), { force: true }).catch(() => undefined)
    }
    console.log(`[tradewatcher] K线缓存裁剪：保留 ${KLINE_CACHE_MAX} 个，清理 ${stats.length - KLINE_CACHE_MAX} 个`)
  } catch {
    /* 目录不存在或权限不足：不影响主路径 */
  }
}

/** 按日期合并（新覆盖旧、排序、截断）——纯函数，便于测试。 */
export function mergeBars(oldBars: readonly DayBar[], freshBars: readonly DayBar[], cap: number): DayBar[] {
  const byDate = new Map<string, DayBar>()
  for (const b of oldBars) byDate.set(b.date, b)
  for (const b of freshBars) byDate.set(b.date, b)
  const merged = [...byDate.values()].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
  return cap > 0 && merged.length > cap ? merged.slice(merged.length - cap) : merged
}

/** 月K → 年K 重采样（开盘取首月、收盘取末月、高低取极值、量额求和）。 */
export function resampleYearly(monthly: readonly DayBar[]): DayBar[] {
  const out: DayBar[] = []
  let curYear = ''
  let cur: DayBar | null = null
  let prevClose: number | null = null
  for (const b of monthly) {
    const year = b.date.slice(0, 4)
    if (cur === null || year !== curYear) {
      if (cur !== null) out.push(cur)
      cur = { date: b.date, open: b.open, close: b.close, high: b.high, low: b.low, vol: b.vol, pct: null }
      curYear = year
    } else {
      cur.date = b.date
      cur.close = b.close
      cur.high = Math.max(cur.high, b.high)
      cur.low = Math.min(cur.low, b.low)
      cur.vol = (cur.vol ?? 0) + (b.vol ?? 0)
    }
  }
  if (cur !== null) out.push(cur)
  for (const bar of out) {
    const base = prevClose ?? bar.open
    bar.pct = base > 0 ? Math.round(((bar.close - base) / base) * 10000) / 100 : null
    prevClose = bar.close
  }
  return out
}

/** 东财 secid → 腾讯代码（sh/sz/hk/us）；指数/期货等返回 null。 */
function tencentSymbol(secid: string): string | null {
  const dot = secid.indexOf('.')
  if (dot <= 0) return null
  const mkt = secid.slice(0, dot)
  const code = secid.slice(dot + 1)
  if (mkt === '1') return `sh${code}`
  if (mkt === '0') return `sz${code}`
  if (mkt === '116') return `hk${code}`
  if (mkt === '105' || mkt === '106' || mkt === '107') return `us${code.toUpperCase()}`
  return null
}

/**
 * 腾讯历史 K 线兜底源（东财 push2his 限流严重时救命）。
 * 统一走「不复权」，与东财 fqt=0 同口径，避免混源污染本地缓存。
 * 行格式 [date, open, close, high, low, volume]。
 */
async function requestKlineFromTencent(secid: string, klt: number, lmt: number, fqt: FqMode): Promise<DayBar[] | null> {
  const sym = tencentSymbol(secid)
  if (sym === null) return null
  const period = klt === 101 ? 'day' : klt === 102 ? 'week' : 'month'
  const fq = fqt === 1 ? 'qfq' : fqt === 2 ? 'hfq' : ''
  const path = `/appstock/app/fqkline/get?param=${sym},${period},,,${Math.min(1000, Math.max(5, lmt))},${fq}`
  try {
    const json = (await fetchFromHost('web.ifzq.gtimg.cn', path, 9000)) as {
      data?: Record<string, Record<string, unknown>>
    }
    const node = json?.data?.[sym]
    if (node === undefined) return null
    // 严格按请求的口径取键：要前复权却只拿到不复权序列时宁可失败，
    // 也不能把不复权价格当前复权画出去（旧实现优先取 `${period}`，就是这种混口径）
    const rows = node[fq === '' ? period : `${fq}${period}`] as unknown
    if (!Array.isArray(rows)) return null
    const bars: DayBar[] = []
    for (const r of rows) {
      if (!Array.isArray(r) || r.length < 5) continue
      const close = num(r[2])
      const open = num(r[1])
      if (close === null || open === null) continue
      bars.push({
        date: String(r[0]),
        open,
        close,
        high: num(r[3]) ?? close,
        low: num(r[4]) ?? close,
        vol: r.length > 5 ? num(r[5]) : null,
        pct: null,
      })
    }
    return bars.length > 0 ? bars : null
  } catch {
    return null
  }
}

/** 单主机取 K 线；空数组视为失败（push2delay/push2 会返回 200 + 空）。优先腾讯。 */
async function requestKlineRaw(secid: string, klt: number, lmt: number, fqt: FqMode): Promise<DayBar[] | null> {
  const fromTencent = await requestKlineFromTencent(secid, klt, lmt, fqt)
  if (fromTencent !== null) return fromTencent
  const fields2 = 'f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61'
  const path = `/api/qt/stock/kline/get?secid=${encodeURIComponent(secid)}&klt=${klt}&fqt=${fqt}&lmt=${lmt}&end=20500101&fields1=f1,f2,f3&fields2=${fields2}`
  for (let attempt = 0; attempt < 2; attempt += 1) {
    for (const host of HISTORY_HOSTS) {
      try {
        const json = await fetchFromHost(host, path, 9000)
        const data = (bodyOf(json)?.data ?? null) as { klines?: unknown } | null
        const raw = Array.isArray(data?.klines) ? data?.klines ?? [] : []
        const bars: DayBar[] = []
        for (const r of raw) {
          if (typeof r !== 'string') continue
          const p = r.split(',')
          if (p.length < 6) continue
          const close = num(p[2])
          if (close === null) continue
          bars.push({
            date: p[0],
            open: num(p[1]) ?? close,
            close,
            high: num(p[3]) ?? close,
            low: num(p[4]) ?? close,
            vol: num(p[5]),
            pct: num(p[8]),
          })
        }
        if (bars.length > 0) return bars
      } catch {
        /* 换主机 / 重试 */
      }
    }
    if (attempt === 0) await new Promise((r) => setTimeout(r, 500))
  }
  return null
}

/**
 * 取 K 线：命中本地缓存时只增量更新最新几根；上游不可用时回退缓存。
 *
 * 三层：① 磁盘缓存（<dataHome>/klines/<secid>_<klt>_<fqt>.json，落盘可跨重启）
 *      ② 增量回源（正常 10/5/3 根，首次 800/400/240 根）
 *      ③ 休市定稿免回源 —— 非交易时段且缓存更新时间已越过最近 15:05 收盘时，
 *         这根收盘 bar 早已落袋，上游不会再有新数据，**一次请求都不发**。
 *
 * `fqt` 默认前复权（1）：除权跳空会让历史 K 线出现无解释的暴跌，前复权序列
 * 连续、最适合判断位置与相对成本。指数/期货等由 `normalizeFq` 收敛为 0。
 */
export async function fetchKline(
  secid: string,
  klt: 101 | 102 | 103 | 104 = 101,
  lmt = 6,
  fqt: FqMode = 1,
): Promise<KlineData | null> {
  if (!SECID_RE.test(secid)) return null
  const baseKlt = klt === 104 ? 103 : klt
  const supported = fqSupported(secid)
  const mode = normalizeFq(secid, fqt)
  const entry = await loadKlineCache(secid, baseKlt, mode)
  const needFull = entry.bars.length === 0
  const settled = !needFull && isSettledOffline(entry.updatedAt)
  const stale = settled ? false : await refreshKline(secid, baseKlt, mode, entry, needFull)
  if (!settled && stale && entry.bars.length === 0) return null
  const series = baseKlt === 103 && klt === 104 ? resampleYearly(entry.bars) : entry.bars
  const want = Math.max(1, Math.min(Math.round(lmt) || series.length, series.length))
  const days = series.slice(series.length - want)
  // 最后一根是否未收盘：只有"该 bar 就是今天"且此刻仍可能产生新数据时才算。
  // 周/月/年 K 的"今天"同理存在，但判断口径一致（date 相等 + inSession）。
  const lastDate = days[days.length - 1]?.date ?? ''
  const barOpen = !settled && lastDate !== '' && lastDate === dayOf(Date.now()) && inSession()
  return {
    secid,
    days,
    stale,
    fqt: mode,
    fqSupported: supported,
    // 口径条的"数据截至"= 本地最近一次成功取数时刻（定稿时就是收盘那一次）
    asOf: entry.updatedAt > 0 ? entry.updatedAt : Date.now(),
    barOpen,
    ...(settled ? { cached: true } : {}),
  }
}

/**
 * 增量回源 + 落盘。返回 true 表示"上游失败、这次给的是旧缓存"。
 * 拆成独立函数是为了让 fetchKline 的三个分支（定稿免回源 / 失败 / 成功）各只有一条出口。
 */
async function refreshKline(secid: string, baseKlt: number, fqt: FqMode, entry: KlineEntry, needFull: boolean): Promise<boolean> {
  const key = `kline:${secid}:${baseKlt}:${fqt}:${needFull ? 'full' : 'incr'}`
  const fetched = await ttlCache<DayBar[] | null>(key, needFull ? 3600_000 : 120_000, () =>
    requestKlineRaw(secid, baseKlt, needFull ? KLINE_FULL_LMT[baseKlt] : KLINE_RECENT_LMT[baseKlt], fqt),
  )
  if (fetched !== null && fetched.length > 0) {
    const before = entry.bars.length
    const beforeLast = entry.bars[entry.bars.length - 1]?.date ?? ''
    entry.bars = mergeBars(entry.bars, fetched, KLINE_CAP[baseKlt])
    entry.updatedAt = Date.now()
    const afterLast = entry.bars[entry.bars.length - 1]?.date ?? ''
    if (before !== entry.bars.length || beforeLast !== afterLast) void saveKlineCache(secid, baseKlt, fqt, entry.bars)
    return false
  }
  return true
}

// ─────────────────────────────── boards ───────────────────────────────────

export type BoardScope = 'industry' | 'concept' | 'etf'

const BOARD_FS: Record<Exclude<BoardScope, 'etf'>, string> = {
  industry: 'm:90+t:2',
  concept: 'm:90+t:3',
}
const ETF_FS = 'b:MK0021,b:MK0023,b:MK0022'
const BOARD_FIELDS = 'f2,f3,f4,f5,f6,f8,f12,f13,f14,f62,f104,f105,f128,f136'

/** Sector/ETF ranking. sort: pct (default) | money (boards) | amount (ETF). */
export async function fetchBoard(
  scope: BoardScope,
  sort: 'pct' | 'money' | 'amount',
  pn = 1,
  pz = 40,
): Promise<{ total: number; rows: BoardRow[]; stale?: boolean; asOf?: number; source?: 'em' | 'tencent' | 'sina' | 'lkg' }> {
  try {
    return await fetchBoardLive(scope, sort, pn, pz)
  } catch (error) {
    // 东财与腾讯都不可用（或 ETF 排行无替代源）：回落上一次成功结果并标注时间
    await loadBoardLkg()
    const hit = boardLkg.get(`board:${scope}:${sort}:${pn}:${pz}`)
    if (hit !== undefined) return { total: hit.total, rows: hit.rows, stale: true, asOf: hit.ts, source: 'lkg' }
    throw error
  }
}

async function fetchBoardLive(
  scope: BoardScope,
  sort: 'pct' | 'money' | 'amount',
  pn = 1,
  pz = 40,
): Promise<{ total: number; rows: BoardRow[]; source?: 'em' | 'tencent' | 'sina' }> {
  await loadBoardLkg()
  const fs = scope === 'etf' ? ETF_FS : BOARD_FS[scope]
  const fid = sort === 'money' ? 'f62' : sort === 'amount' ? 'f6' : 'f3'
  const po = sort === 'money' || sort === 'amount' ? 1 : 1 // all descending by chosen fid
  const q = `pn=${pn}&pz=${pz}&po=${po}&np=1&fltt=2&invt=2&fid=${fid}&fs=${encodeURIComponent(fs)}&fields=${BOARD_FIELDS}`
  const key = `board:${scope}:${sort}:${pn}:${pz}`
  const json = await ttlCache(key, 30_000, async () => {
    try {
      return await fetchAny(QUOTE_HOSTS, `/api/qt/clist/get?${q}`)
    } catch (error) {
      // 东财行情 CDN 被限流/封锁时的备用源：
      //   行业 / 概念 → 腾讯板块排行；ETF → 新浪 ETF 排行（后者只提供涨跌/价/成交额/换手，无资金流）
      if (pn === 1) {
        try {
          if (scope === 'etf') {
            const rows = await fetchSinaEtfRanking(sort === 'amount' ? 'amount' : 'pct', pz)
            if (rows.length > 0) {
              return {
                data: {
                  diff: rows.map((r) => ({ f12: r.code, f13: r.secid.split('.')[0], f14: r.name, f2: r.price, f3: r.pct, f6: r.amount, f8: r.turnover })),
                  total: rows.length, fallback: 'sina',
                },
              }
            }
          } else {
            const tx = await fetchTencentBoards(scope === 'concept' ? 'concept' : 'industry', pz)
            if (tx.length > 0) return { data: { diff: tx.map((b) => ({ f12: b.code, f14: b.name, f3: b.pct, f2: b.price, f128: b.leader, f136: b.leaderPct })), total: tx.length, fallback: 'tencent' } }
          }
        } catch {
          /* 交给 LKG */
        }
      }
      throw error
    }
  })
  const body = bodyOf(json)
  const rows: BoardRow[] = diffList(json).map((it) => {
    const code = String(it.f12 ?? '')
    const mkt = String(it.f13 ?? '')
    const secid = code !== '' && (mkt === '0' || mkt === '1') ? `${mkt}.${code}` : undefined
    return {
      secid,
      code,
      name: String(it.f14 ?? ''),
      pct: num(it.f3),
      chg: num(it.f4),
      price: num(it.f2),
      up: num(it.f104),
      down: num(it.f105),
      leader: it.f128 === '-' || it.f128 === undefined || it.f128 === null ? null : String(it.f128),
      leaderPct: num(it.f136),
      money: num(it.f62),
      vol: num(it.f5),
      amount: num(it.f6),
      turnover: num(it.f8),
    }
  })
  const total = num(body?.data?.total as unknown) ?? rows.length
  if (rows.length > 0) {
    boardLkg.set(key, { ts: Date.now(), total, rows })
    boardLkgDirty = true
    persistBoardLkg()
    const fb = (body as { data?: { fallback?: string } } | undefined)?.data?.fallback
    const source = fb === 'tencent' ? 'tencent' : fb === 'sina' ? 'sina' : 'em'
    return { total, rows, source }
  }
  return { total, rows }
}

// ─────────────────────── industry board (A股) ─────────────────────────────

/** A-share-only secid filter. */
function aShare(secid: string): boolean {
  const dot = secid.indexOf('.')
  if (dot <= 0) return false
  const mkt = secid.slice(0, dot)
  return mkt === '0' || mkt === '1'
}

const INDUSTRY_NAMES_TTL = 600_000 // EM 侧行业归属极少变动

/** One A股 secid → industry name (single stock/get; f127), 10-min cached. */
async function industryNameOf(secid: string): Promise<string | null> {
  const json = await ttlCache(`industry-name:${secid}`, INDUSTRY_NAMES_TTL, () =>
    fetchAny(QUOTE_HOSTS, `/api/qt/stock/get?secid=${encodeURIComponent(secid)}&fltt=2&invt=2&fields=f57,f58,f127`),
  )
  const data = (bodyOf(json)?.data ?? null) as { f127?: unknown } | null
  const raw = data?.f127
  if (raw === null || raw === undefined || raw === '-' || raw === '') return null
  return String(raw)
}

/** name → 板块当日涨跌幅；分页拉全行业榜（每页 30s 缓存），供批量复用。 */
async function industryBoardPctMap(): Promise<Map<string, number | null>> {
  const map = new Map<string, number | null>()
  let total = Infinity
  for (let pn = 1; pn <= 8 && map.size < total; pn += 1) {
    const board = await fetchBoard('industry', 'pct', pn, 100)
    total = board.total
    for (const r of board.rows) {
      if (!map.has(r.name)) map.set(r.name, r.pct)
    }
  }
  return map
}

/** 小并发池：批量执行（行业名逐代码抓取时用，避免打爆上游）。 */
async function poolRun<T>(items: readonly T[], concurrency: number, worker: (item: T) => Promise<void>): Promise<void> {
  const queue = [...items]
  const runners = Array.from({ length: concurrency }, async () => {
    for (;;) {
      const item = queue.shift()
      if (item === undefined) return
      await worker(item)
    }
  })
  await Promise.all(runners)
}

/** A股 secids → {行业名, 板块今日涨幅}（批量；非 A股与解析失败者缺席）。 */
export async function fetchIndustryOverview(secids: string[]): Promise<Record<string, { name: string; pct: number | null }>> {
  const targets = [...new Set(secids)].filter((s) => SECID_RE.test(s) && aShare(s)).slice(0, 120)
  if (targets.length === 0) return {}
  const names = new Map<string, string>()
  await poolRun(targets, 4, async (secid) => {
    const name = await industryNameOf(secid)
    if (name !== null) names.set(secid, name)
  })
  if (names.size === 0) return {}
  const board = await industryBoardPctMap()
  const out: Record<string, { name: string; pct: number | null }> = {}
  for (const [secid, name] of names) {
    out[secid] = { name, pct: board.get(name) ?? null }
  }
  return out
}

/** 单只 A股 → 行业板块信息（抽屉顶部用），复用上面的缓存与榜单。 */
export async function fetchIndustryOf(secid: string): Promise<{ name: string; pct: number | null } | null> {
  if (!SECID_RE.test(secid) || !aShare(secid)) return null
  const map = await fetchIndustryOverview([secid])
  return map[secid] ?? null
}

// ─────────────────────────────── search ───────────────────────────────────

/**
 * EM suggest search. Eastmoney's `Classify` is NOT stable across markets
 * (沪A/深A="AStock", 科创板="23", 港股="HK", …), so acceptance is decided by
 * the *market number* with only clearly unusable pools excluded:
 *   - 90  板块 composites (not quoteable via /tradewatcher/detail)
 *   - 150 场外基金 OTC funds (no live quote)
 * A-share (0/1), HK (116), US (105–107), global indices (100) and exchange
 * futures/spot (101/103/104/112–125/142…) all pass and quote fine.
 */
const SUGGEST_EXCLUDE_MARKETS = new Set(['90', '150', '151', '152', '80'])

function suggestKind(it: Record<string, unknown>, name: string): string {
  const mkt = String(it.MktNum ?? '')
  const cls = String(it.Classify ?? '')
  const secType = String(it.SecurityTypeName ?? '')
  if (name.includes('ETF')) return 'ETF'
  if (mkt === '116') return '港股'
  if (mkt === '105' || mkt === '106' || mkt === '107') return '美股'
  if (cls === 'UniversalIndex' || cls === 'Index' || mkt === '100') return '指数'
  if (cls === 'Futures') return '期货'
  if (cls === 'Spot') return '现货'
  if (secType.includes('科创') || secType.includes('创业') || cls === 'AStock' || cls === 'Stock') return '股票'
  if (cls === 'Fund' || cls === 'OTCFUND') return '基金'
  return '行情'
}

export async function searchSymbols(query: string): Promise<SuggestItem[]> {
  const q = query.trim()
  if (q === '') return []
  if (q.length > 40) return []
  const key = `suggest:${q}`
  let data: Array<Record<string, unknown>> = []
  try {
    const json = await ttlCache(key, 8000, () =>
      fetchAny(
        [SEARCH_HOST],
        `/api/suggest/get?input=${encodeURIComponent(q)}&type=14&token=${SUGGEST_TOKEN}&count=14`,
      ),
    )
    const body = json as { QuotationCodeTable?: { Data?: Array<Record<string, unknown>> } }
    data = Array.isArray(body?.QuotationCodeTable?.Data) ? (body.QuotationCodeTable.Data as Array<Record<string, unknown>>) : []
  } catch {
    data = []
  }
  // 东财搜索不可用时回落腾讯智慧搜索（搜索与行情是不同主机，不能一起熔断）
  if (data.length === 0) {
    try {
      const tx = await fetchTencentSuggest(q, 10)
      if (tx.length > 0) return tx.map((h) => ({ ...h, hasFallback: hasQuoteFallback(h.secid) }))
    } catch {
      /* 交给下面返回空列表 */
    }
  }
  const out: SuggestItem[] = []
  const seen = new Set<string>()
  for (const it of data) {
    const quoteId = String(it.QuoteID ?? '')
    const code = String(it.Code ?? '')
    const mkt = String(it.MktNum ?? '')
    if (!SECID_RE.test(quoteId)) continue
    if (code === '' || code.includes('_')) continue
    if (!/^\d{1,3}$/.test(mkt) || SUGGEST_EXCLUDE_MARKETS.has(mkt)) continue
    if (seen.has(quoteId)) continue
    const name = String(it.Name ?? '')
    if (name === '') continue
    seen.add(quoteId)
    out.push({
      secid: quoteId,
      code,
      name,
      kind: suggestKind(it, name),
      market: mkt,
      hasFallback: hasQuoteFallback(quoteId),
    })
    if (out.length >= 10) break
  }
  return out
}

export async function searchBest(query: string): Promise<SuggestItem | null> {
  const hits = await searchSymbols(query)
  if (hits.length === 0) return null
  const bare = query.trim().toUpperCase()
  const exactCode = hits.find((h) => h.code.toUpperCase() === bare || h.name === query.trim())
  return exactCode ?? hits[0]
}

export { cache as _cache }
