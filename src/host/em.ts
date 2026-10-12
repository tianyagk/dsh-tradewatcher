/**
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
import { MISSING_TIER_ADVICE, SECID_RE, normalizeTrendSeries } from '../shared/model.ts'
import { BREADTH_HS_A_FS, BREADTH_PAGE_SIZE, type CountPage } from './breadthCount.ts'
import { isMultiDayTrend, stitchTrendDays } from '../shared/trendStitch.ts'
import { TREND_ARCHIVE_KEEP_DAYS, archiveTrendDays, loadTrendArchive, type TrendArchiveEntry } from './trendArchive.ts'
import { mkdir, readdir, readFile, rm, stat } from 'node:fs/promises'
import { writeFileAtomic } from './atomic.ts'
import { updateJsonLocked, withFileLock } from './lock.ts'
import { breakerFor, hostsAllowed, minutesToRecover } from './breaker.ts'
import { fetchSinaEtfRanking, fetchSinaQuotes, sinaSymbol as sinaQuoteSymbol } from './sina.ts'
import { fetchTencentBoards, fetchTencentMinutes, fetchTencentQuoteRows, fetchTencentSuggest, minuteTrendPointsOf, tencentCode, tencentIndexCode, tencentQuoteCode, type TencentQuoteFull } from './tencent.ts'
import { join } from 'node:path'
import { dataHome } from './store.ts'
import { hhmmOf, dayOf, inSession, isSettledOffline, shanghaiParts } from './time.ts'

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

/**
 * 严格 TTL 命中（**没有**隐式宽限）。
 *
 * 此前这里叫 `peekCache(key, 45_000)`：槽的 `exp` 之外再允许 45s 的"宽限"，
 * 于是分时那条 60s 的 TTL 实际等于 **≈105s**，而界面/口径按 60s 读"数据有多新"
 * （AUDIT-CACHE-1 P2-2：不是请求放大，是**口径不一致**，会让人把 105s 前的行情当成 60s 内的）。
 * 真要提前复用，就调 TTL 本身 —— 不再叠一层看不见的窗口。
 */
function readFresh<T>(key: string): T | undefined {
  const slot = cache.get(key)
  if (slot === undefined || Date.now() >= slot.exp) return undefined
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
/** ⚠ 与 shared 的 `numOrNull` **不合并**：这里要接受上游给的字符串（含 `'-'`＝无值），
 *  合并会让这类字段整片变成 null（S7 的说明）。 */
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

/**
 * ⚠ `f62`（主力净额）/`f66`（超大单净额）是**护盘采样器**要的分单资金流字段。
 * 它们加在这里（而不是让采样器自己打一条 URL）是有意的：采样器的标的（6 只宽基 ETF + 上证指数）
 * 与顶部行情条的引擎集合高度重叠，字段表相同 ⇒ 两条链路共用同一个逐标的槽，
 * 同一秒内谁先取数、另一个就命中缓存（实测此前两条链路各打一遍、互不命中，见 AUDIT-CACHE-2 §3.10）。
 * 多带两列不增加 HTTP 请求数（同一个 URL）。
 */
const QUOTE_FIELDS =
  'f1,f2,f3,f4,f5,f6,f8,f9,f10,f12,f13,f14,f15,f16,f17,f18,f20,f21,f23,f62,f66,f104,f105,f106,f124'

const LKG_MAX = 1500
const LKG_PERSIST_MS = 45_000

/**
 * **已退役兜底来源**的标的集合（AUDIT-IMPL44）：这七个国际指数的兜底曾是新浪 `int_*`，
 * 实测那是**陈旧快照且没有时间戳**（`100.SPX` 曾落盘 6643.70，同刻腾讯 `us.INX` = 7811.54；
 * `100.NDX` 22484.07 vs `us.NDX` = 30883.15 —— 偏差 10–27%）。
 * 对它们，last-known-good 里**只信东财/腾讯的观测**；其余来源（sina / 无来源）一律作废。
 * 其余 `100.*`（法国/韩国/斯托克 50）历史上只有东财一个源，不在此列，保持原样。
 */
const RETIRED_INDEX_FALLBACK = new Set(['100.SPX', '100.DJI', '100.NDX', '100.HSI', '100.FTSE', '100.N225', '100.GDAXI'])
/** 作废留痕（进程内 + 落盘 `purged` 字段）：供 /quotes 排查与断言观察 */
const lkgPurged: Array<{ secid: string; price: number | null; at: number | null; reason: string }> = []

/** 该行是否是"已退役兜底来源"的旧值（是 ⇒ 返回作废原因；否 ⇒ null） */
function retiredIndexRowReason(row: QuoteRow): string | null {
  const key = row.secid.toUpperCase()
  if (!RETIRED_INDEX_FALLBACK.has(key)) return null
  const src = typeof row.source === 'string' ? row.source : '(无来源)'
  if (src === 'em' || src === 'tencent') return null
  return `新浪 int_* 陈旧快照（无时间戳；实测偏差 10–27%）已整体停用 ⇒ 来源 ${src} 的行作废`
}

/** 本次进程作废掉的 last-known-good 行（含原因）；供断言与排查 */
export function lastGoodPurged(): ReadonlyArray<{ secid: string; price: number | null; at: number | null; reason: string }> {
  return lkgPurged
}

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
        // 已退役兜底来源的旧值：**作废 + 留痕**，绝不当"最后成功值"端上界面（AUDIT-IMPL44）
        const retired = retiredIndexRowReason(row)
        if (retired !== null) {
          lkgPurged.push({ secid: row.secid, price: row.price, at: typeof row.at === 'number' ? row.at : null, reason: retired })
          continue
        }
        // 键用大小写无关形式：库里可能存着历史写入的大写 secid（如 114.LHM），
        // 而新请求是小写（114.lhm）—— 按原样做键会让这些标的丢掉兜底价
        lastGood.set(row.secid.toUpperCase(), typeof row.at === 'number' ? row : { ...row, at: fileTs })
      }
      if (lkgPurged.length > 0) {
        console.warn(
          '[tradewatcher] 作废 last-known-good 里的国际指数旧值：',
          lkgPurged.map((p) => `${p.secid}=${p.price}`).join(' / '),
          '— 新浪 int_* 是陈旧快照且无时间戳，已整体停用（下一次取数会用腾讯 us.INX/us.DJI/us.NDX/hkHSI 重建）',
        )
        // 立刻把作废结果写回文件（不留着错值等下一个人继承）；`purged` 是留痕
        lkgDirty = true
        lkgLastWrite = 0
        persistLastGood()
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
  // `v`: 落盘 schema 版本（v2 = 国际指数不再接受新浪 int_* 兜底值，见 RETIRED_INDEX_FALLBACK）；
  // `purged`: 本次进程作废掉的旧值留痕（有才写，避免给文件加无意义的字段）
  const purged = lkgPurged.length > 0 ? lkgPurged.slice(-20) : undefined
  void (async () => {
    try {
      // ⚠ 原子写（tmp + rename）：这份文件会被下一次读取与另一个写者同时看到，
      // 直接 writeFile 会让读者读到半截 JSON（解析失败 ⇒ 被当成"没有缓存" ⇒ 白拉一遍上游）。
      // 序列化保持**逐字节不变**（compact，不换缩进）—— 4MB 级的 trends-lkg 不值得为好看翻倍。
      await writeFileAtomic(join(dataHome(), 'quotes-lkg.json'), JSON.stringify(purged === undefined ? { v: 2, ts: Date.now(), rows } : { v: 2, ts: Date.now(), rows, purged }))
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
          // 「等东财恢复」是**原因对象**（具体等谁），不是 tier 建议句：S19 要求"差异只在原因对象上另加半句"
          note: `东财行情主机本次不可用（熔断中或整批失败），而该标的没有腾讯/新浪备用源映射（等东财恢复就会有）—— ${MISSING_TIER_ADVICE.transient}`,
        }
      }
      if (noFallback) {
        return {
          what: secid,
          why: 'no-source' as const,
          note: `该标的无腾讯/新浪备用源映射（东财之外的源不提供它），且东财本次可正常取数 —— ${MISSING_TIER_ADVICE['no-source']}`,
        }
      }
      return {
        what: secid,
        why: 'transient' as const,
        note: `东财与备用源本次都未给出可用价格（限流或超时）—— ${MISSING_TIER_ADVICE.transient}`,
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
      // 换手率 f8 / 量比 f10：行情本身用不到，但护盘采样器要（它此前自己打一条 URL 拿这两列）
      turnover: num(it.f8),
      volRatio: num(it.f10),
      // 分单资金流（主力净额 f62 / 超大单净额 f66）：只有东财给；腾讯/新浪备用源为 null
      mainNet: num(it.f62),
      superNet: num(it.f66),
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

/**
 * 每条取数链路"最近一次尝试是否**因为上游失败**"（trend / kline / detail 各自记账）。
 *
 * 为什么需要它：`fetchTrend`/`requestKlineRaw` 把上游异常吞在内部、只返回 `null`，
 * 于是"东财被限流"与"东财可达但没有这个标的"在路由层看起来一模一样 —— 只能靠猜。
 * 由**实际发起请求的那一层**记账，`missing[].why` 才是事实而不是猜测。
 * 窗口与 `missing` 的判定一致（超出窗口就不拿旧失败说事）。
 */
const upstreamFailAt: Record<'trend' | 'kline' | 'detail', number> = { trend: 0, kline: 0, detail: 0 }

/** 记账入口（导出是为了可测：测试用它把状态机推到"上游刚失败过"） */
export function noteUpstreamFailure(kind: 'trend' | 'kline' | 'detail'): void {
  upstreamFailAt[kind] = Date.now()
}

/** 该链路最近是否因上游失败过（窗口外视为没有） */
export function upstreamFailedRecently(kind: 'trend' | 'kline' | 'detail'): boolean {
  const at = upstreamFailAt[kind]
  return at > 0 && Date.now() - at <= EM_FAIL_RECENT_MS
}

/** 这组主机是否全部处于熔断冷却中（该链路"现在根本发不出请求"） */
export function hostsUnavailable(hosts: readonly string[]): boolean {
  return hosts.length > 0 && hosts.every((host) => !breakerFor(host).allow())
}

/**
 * 东财此刻是否不可用：熔断中，或最近 2 分钟内整批失败过。
 *
 * 公开给路由层：`missing[].why` 的 `no-source` / `transient` 判定必须与 `quoteProvenance` 同口径 ——
 * "东财这会儿挂了"⇒ transient（等恢复），"东财可达但没有这个标的"⇒ no-source（重试无用）。
 */
export function emUnavailableNow(): boolean {
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
  // ⚠ 必须用 `tencentQuoteCode`（沪深/港股 **+ 国际指数**）：用只认沪深港的 `tencentCode`
  // 会在请求之前就把 `100.SPX`/`100.DJI`/`100.NDX`/`100.HSI` 过滤掉 —— 表现为"映射改了但兜底仍拿不到值"
  const usable = list.filter((secid) => tencentQuoteCode(secid) !== null)
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
 * 国内期货 nf_*、外盘商品 hf_*（国际指数**不再**走新浪 —— `int_*` 是陈旧快照且无时间戳，
 * 已整族停用，改由腾讯 `us.INX`/`us.DJI`/`us.NDX`/`hkHSI` 兜底，见 sina.ts/tencent.ts 的实测注释）。
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
      // 原子写（同上：读者可能正在解析这份文件）
      await writeFileAtomic(join(dataHome(), 'board-lkg.json'), JSON.stringify({ ts: Date.now(), entries }))
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

/**
 * 新鲜度窗口（ms）：跟随用户的刷新间隔设置，夹在 5–60 秒；由插件入口与 prefs 变更处写入。
 *
 * ⚠ 这是**客户端轮询间隔**，不是服务端槽的有效期：`loadQuotes` 用的 TTL 见 `quoteSlotTtlMs()`。
 */
let quoteFreshMs = 10_000

export function setQuoteFreshnessMs(ms: number): void {
  if (!Number.isFinite(ms)) return
  quoteFreshMs = Math.max(5_000, Math.min(60_000, Math.round(ms)))
}

export function quoteFreshnessMs(): number {
  return quoteFreshMs
}

/** 槽有效期相对轮询间隔的余量：间隔的 20%，夹在 1–5 秒（覆盖定时器抖动 + 一次网络往返） */
const QUOTE_SLOT_MARGIN_MIN_MS = 1_000
const QUOTE_SLOT_MARGIN_MAX_MS = 5_000

/**
 * 服务端行情槽的有效期 = **客户端轮询间隔 + 一档余量**。
 *
 * 为什么必须严格大于间隔：此前两者是同一个数（`quoteFreshMs`，实测 prefs 里 `refreshSec=10` ⇒ 两边都 10s），
 * 客户端下一拍回来时槽**刚好**过期 ⇒ 稳态命中率 0%，每拍必然回源
 * （实测连续三拍 8 条/拍、每拍一模一样，见 AUDIT-CACHE-2 §3.1b）；这是"同一数据反复拉取"的根因。
 *
 * 语义边界（不许让界面数据变陈旧）：余量只有一档（20%），因此
 *   - 下一拍（间隔 + 网络往返）必定命中 ⇒ 请求数减半；
 *   - 最坏情况下界面上那一行也只比"刚刚取到"旧**一拍**（≤ 客户端间隔），
 *     不会出现"看着是 10s 刷新、数据其实旧了两三拍"。
 * 界面上的"数据时刻"始终取行内 `at`/`asOf`，与本 TTL 无关，因此标注永远如实。
 */
export function quoteSlotTtlMs(): number {
  const margin = Math.min(QUOTE_SLOT_MARGIN_MAX_MS, Math.max(QUOTE_SLOT_MARGIN_MIN_MS, Math.round(quoteFreshMs * 0.2)))
  return quoteFreshMs + margin
}

/**
 * 非交易时段且该槽的观测时刻已越过最近一次收盘 ⇒ 这份行情不会再变，直接复用（**零回源**）。
 *
 * 只对**沪/深（`1.`/`0.` 市场）**生效：它们的交易时段就是 `time.inSession` 的口径；
 * 外盘指数（`100.*`）、商品/期货（`101/112/113/114/122.*`）、美债收益率（`171.*`）的交易时段不同
 * （夜盘/美盘都在北京深夜），用 A 股时段把它们冻住会让面板在真正有行情时不刷新 —— 所以它们仍按 TTL 轮询。
 */
function frozenOfflineSlot(secid: string, slotAt: number, now: number): boolean {
  return /^[01]\./.test(secid) && isSettledOffline(slotAt, now)
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
  /** 槽是否可直接复用：仍在有效期内，或（沪/深 + 已收盘定稿）不会再变 */
  const reusable = (secid: string, slot: { exp: number; at: number; row: QuoteRow } | undefined): boolean => {
    if (slot === undefined) return false
    return now < slot.exp || frozenOfflineSlot(secid, slot.at, now)
  }
  for (const secid of list) {
    const key = secid.toUpperCase()
    const slot = quoteSlots.get(key)
    if (reusable(secid, slot)) {
      picked.set(key, slot!.row)
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
    if (reusable(secid, slot)) {
      picked.set(key, slot!.row)
      continue
    }
    still.push(secid)
  }
  if (still.length > 0) {
    const ttl = quoteSlotTtlMs()
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

/**
 * **共用行情槽**的批量读取出口（护盘采样器等后台取数方用；不经过路由）。
 *
 * 契约：与 `/quotes`（顶部行情条/自选/持仓）读的是**同一份**逐标的槽 + 同一个在飞合并
 * （`quoteInflight`），因此两条链路同刻取数时只有一条会真的打上游。
 * 返回的行可能来自东财、备用源（腾讯/新浪）或 last-known-good —— 来源如实写在 `row.source` 里，
 * 分单资金流（`mainNet`/`superNet`）只有 `source === 'em'` 的行才有值。
 */
export async function loadQuoteRowsShared(secids: string[]): Promise<Map<string, QuoteRow>> {
  return loadQuotes(secids)
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
      // 原子写（同上：4MB 级的文件更容易被读者撞上"半截"）
      await writeFileAtomic(join(dataHome(), 'trends-lkg.json'), JSON.stringify({ ts: Date.now(), entries }))
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

/**
 * 分时的**在飞合并**：同一个 `trend:<secid>:<ndays>` 的回源段只跑一份。
 *
 * 为什么必须有：客户端有三条互不共享缓存的分时消费者（行情条迷你卡 90s、抽屉图表 30s、
 * 大盘页滚动 `openDetail` 无缓存），它们会撞在同一瞬间 —— 实测**并发 8 个同 secid 请求 ⇒ 8 次上游**
 * （AUDIT-CACHE-1 S2-3），同一份数据被打了 8 遍。对照：K 线与五日分时都走 `ttlCache` 的同一套机制，
 * 并发 8 / 4 ⇒ **1 次**。这里补上的就是那一套（`inflight` 合并）。
 *
 * 合并范围只覆盖"回源那一段"（上游 → 活的备用源 → LKG 的判定与写缓存），
 * 不覆盖已命中新鲜缓存/休市定稿的快路径 —— 它们本来就 0 请求，没必要排队等。
 */
const trendInflight = new Map<string, Promise<TrendData | null>>()

/** 分时取数统一入口：内存新鲜缓存 → 休市定稿复用 → 上游（带重试）→ last-known-good */
async function trendWithFallbackRaw(
  secid: string,
  ndays: number,
  loader: () => Promise<TrendData | null>,
  opts: TrendOptions = {},
): Promise<TrendData | null> {
  await loadTrendLkg()
  const key = `trend:${secid}:${ndays}`
  const fresh = readFresh<TrendData>(key)
  if (fresh !== undefined) return fresh
  // 休市且本地快照已越过最近一次收盘 → 当天的分时/五日序列不会再变，直接吃本地
  // （进程重启后仍生效：trendLkg 是落盘的）。盘中 / 快照过期一律走上游。
  const settled = trendLkg.get(trendKey(secid, ndays))
  // 休市定稿分支**不动**：那时当天的序列不会再变，复用本地是正确行为
  if (settled !== undefined && settled.trend.points.length >= 2 && isSettledOffline(settled.at, opts.now ?? Date.now())) {
    const reused: TrendData = { ...settled.trend, cached: true }
    cache.set(key, { exp: Date.now() + 300_000, value: reused })
    return reused
  }
  const pending = trendInflight.get(key)
  if (pending !== undefined) return pending
  const run = (async (): Promise<TrendData | null> => {
    // ⚠ 顺序：**上游 → 活的备用源（腾讯分钟线）→ LKG**（判据见 pickTrendFallback）。
    // 决不能在备用源之前吃 LKG：那会让"有昨日 LKG 的标的"在东财不可达时永远显示昨天。
    let upstream: TrendData | null = null
    let upstreamThrew = false
    try {
      upstream = await loader()
    } catch {
      upstreamThrew = true
    }
    let backup: TrendData | null = null
    if (upstream === null || upstream.points.length < 2) {
      backup = await (opts.fallbackSource ?? tencentTrend)(secid).catch(() => null)
    }
    const now = opts.now ?? Date.now()
    const picked = pickTrendFallback({ upstream, backup, lkg: lastGoodTrend(secid, ndays), today: dayOf(now) })
    if (picked.data === null) {
      // 上游与备用源都没给数据 —— 记账（"东财被限流"与"该标的没有分时"必须能分开）
      if (upstreamThrew) noteUpstreamFailure('trend')
      // 返回 null（路由回 200 + trend:null），客户端按"暂无分时"降级
      return null
    }
    // 缓存 TTL 按来源区分：实时值 60s、备用源 30s、LKG 20s（LKG 是"可能过期"的数据，短 TTL 逼着重新回源试探；
    // TTL 就是 TTL，不再有隐式宽限，见 readFresh 的说明）
    // 方向二：**不是今天**的数据必须留下痕迹（节假日上游会回节前那天的分时）。
    // `expired` 就是为此算的 —— 客户端拿它写「· 非当日数据（MM-DD）」，否则旧交易日会被读成今天。
    const annotate = (data: TrendData): TrendData =>
      picked.sessionDay !== null && (picked.expired || picked.from === 'lkg')
        ? { ...data, sessionDay: picked.sessionDay }
        : data
    if (picked.from === 'lkg') {
      // 兜底回 LKG：带上这份数据自己的交易日，界面据此写明"这是哪天的"
      const annotated = annotate(picked.data)
      cache.set(key, { exp: Date.now() + 20_000, value: annotated })
      return annotated
    }
    const annotated = annotate(picked.data)
    cache.set(key, { exp: Date.now() + (picked.from === 'upstream' ? 60_000 : 30_000), value: annotated })
    rememberTrend(secid, ndays, annotated)
    return annotated
  })()
  trendInflight.set(key, run)
  try {
    return await run
  } finally {
    if (trendInflight.get(key) === run) trendInflight.delete(key)
  }
}

/**
 * 分时序列的**出口**：无论数据来自上游、内存缓存还是落盘的 last-known-good，
 * 一律过一遍 `normalizeTrendSeries`。
 *
 * 为什么必须在出口而不只在解析上游时：LKG 是**上一次运行落盘的文件**，里面可能还存着
 * 修复前写进去的 `avg: 0`（旧进程的产物）—— 只在解析处归一的话，断网/休市走 LKG 时
 * `curl /tradewatcher/trend` 仍会看到 0，等于没修。归一幂等，重复跑没有副作用。
 */
/** 分时取数的选项 */
export interface TrendOptions {
  /** 是否把取到的每日分时落盘归档（默认开，见 prefs.trendArchive） */
  archive?: boolean
  /** 注入"现在"（测试用：休市定稿判定与"是不是今天的"判据都依赖它） */
  now?: number
  /** 注入上游取数（测试用；默认走东财 trends2 / 新浪·腾讯多日链） */
  upstream?: (secid: string, ndays: number) => Promise<TrendData | null>
  /** 注入活的备用源（测试用；默认腾讯分钟线） */
  fallbackSource?: (secid: string) => Promise<TrendData | null>
  /**
   * 只给"验证上游多日能力"与将来接多日用：把东财 `trends2` 的 `ndays` 改成指定值。
   * 默认 1（既有行为不变，路由也不设置它）—— 上游到底认不认 `ndays`，用我们自己的取数链实测。
   */
  ndays?: number
}

/** 一份分时序列的交易日（最后一个点属于哪天）；没有点返回 null */
export function trendSessionDay(trend: TrendData | null): string | null {
  const last = trend?.points[trend.points.length - 1]
  return last === undefined ? null : last.label.slice(0, 10)
}

export type TrendOrigin = 'upstream' | 'backup' | 'lkg' | 'none'

export function pickTrendFallback(args: {
  upstream: TrendData | null
  backup: TrendData | null
  lkg: TrendData | null
  today: string
}): { data: TrendData | null; from: TrendOrigin; sessionDay: string | null; expired: boolean } {
  const usable = (t: TrendData | null): t is TrendData => t !== null && t.points.length >= 2
  if (usable(args.upstream)) {
    const day = trendSessionDay(args.upstream)
    return { data: args.upstream, from: 'upstream', sessionDay: day, expired: day !== null && day !== args.today }
  }
  if (usable(args.backup)) {
    const day = trendSessionDay(args.backup)
    return { data: args.backup, from: 'backup', sessionDay: day, expired: day !== null && day !== args.today }
  }
  if (usable(args.lkg)) {
    const day = trendSessionDay(args.lkg)
    return { data: args.lkg, from: 'lkg', sessionDay: day, expired: day !== null && day !== args.today }
  }
  return { data: null, from: 'none', sessionDay: null, expired: false }
}

/**
 * 把一份分时序列按**交易日**归档（同一天覆盖写）。归档失败绝不能影响取数：
 * 这里吞掉异常，只把"没写成功"的原因带进回包让界面说明。
 */
async function archiveTrendData(secid: string, points: readonly TrendPoint[]): Promise<TrendData['archive']> {
  const byDay = new Map<string, TrendPoint[]>()
  for (const p of points) {
    const day = p.label.slice(0, 10)
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) continue
    const list = byDay.get(day)
    if (list === undefined) byDay.set(day, [p])
    else list.push(p)
  }
  const entries: TrendArchiveEntry[] = [...byDay.entries()].map(([day, pts]) => ({ day, points: pts }))
  if (entries.length === 0) return undefined
  try {
    const r = await archiveTrendDays(secid, entries)
    return r.skipped.length > 0 ? { saved: r.saved, skipped: r.skipped } : undefined
  } catch (error) {
    console.warn('[tradewatcher] 归档每日分时失败:', String(error).slice(0, 120))
    return { saved: [], skipped: entries.map((e) => ({ day: e.day, reason: `归档异常：${String(error).slice(0, 60)}` })) }
  }
}

async function trendWithFallback(
  secid: string,
  ndays: number,
  loader: () => Promise<TrendData | null>,
  opts: TrendOptions = {},
): Promise<TrendData | null> {
  const data = await trendWithFallbackRaw(secid, ndays, loader, opts)
  if (data === null) return null
  const clean = { ...data, points: normalizeTrendSeries(data.points) }
  // 归档放在**出口**：上游、内存缓存、落盘 LKG 命中的都在这里过一遍
  // （用户要的"拿缓存的每日分时拼接"必须连 LKG 那次也归档，否则永远只有今天）
  const archive = opts.archive === false ? undefined : await archiveTrendData(secid, clean.points)
  return archive === undefined ? clean : { ...clean, archive }
}

/**
 * 腾讯分钟线 → 分时序列（价格 + 当日均价 VWAP + **每分钟成交额**），供东财不可用时兜底。
 *
 * ⚠ 成交额口径（v0.66.0 修）：
 *   腾讯逐分钟只给**累计**成交额（第 4 段，元）与**累计**成交量（第 3 段，手）——
 *   而 `TrendPoint.amount` 的口径是**每分钟**成交额（东财 `trends2` 给的就是每分钟值）。
 *   故这里对累计值做**差分**得每分钟值，并在每个点上挂 `amountDerived: true` + 说明：
 *   **这是推导值，不是上游直给的分钟额**（不标注就等于伪造上游字段）。
 *   - 累计值回退（数据抖）⇒ 该点成交额**如实为 null**（不编、不用 0 顶替）；
 *   - 只有价格/量、没有第 4 段（结构变化）⇒ 用 `价格 × 手数 × 100` 推导，同样标 `amountDerived`；
 *   - 两者都拿不到 ⇒ 该点 `amount: null`。
 *   `vol` 同步改成**每分钟**手数（与东财口径一致），不再是累计值（旧实现给的是累计值，会让下游按分钟读错）。
 */
async function tencentTrend(secid: string): Promise<TrendData | null> {
  const raw = await fetchTencentMinutes(secid)
  if (raw.length < 5) return null
  // 映射逻辑在 tencent.ts 的**纯函数**里（差分 + 推导标记），这里只做 IO 与收尾
  const { points } = minuteTrendPointsOf(raw, (ts) => `${dayOf(ts)} ${hhmmOf(ts)}`)
  if (points.length < 5) return null
  const clean = normalizeTrendSeries(points as unknown as TrendPoint[]) as Array<TrendPoint & { amountDerived?: boolean; amountNote?: string }>
  return {
    secid,
    prePrice: null,
    points: clean,
    last: clean[clean.length - 1]?.price ?? null,
    staleAt: undefined,
  }
}

/**
 * 东财单日分时。
 *
 * ndays 参数：2026-10-11 本次实测（用我们自己的取数链，同一 secid 各跑 ndays=1 与 ndays=5）——
 * 上游忽略该参数：1.000001 两次都是 1 天/242 点，100.SPX 两次都是 2 天/391 点（美盘跨北京日期，非多日能力），
 * 101.HG00Y 两次都是 1 天/269 点。此前这里引的是“历史记录”，现在换成本次实测结论。
 */
async function fetchTrendSingleDay(secid: string, opts: TrendOptions = {}): Promise<TrendData | null> {
  const fields2 = 'f51,f52,f53,f54,f55,f56,f57,f58'
  return trendWithFallback(secid, 1, async () => {
    // 注入上游（测试用）：让"上游抛错/没数据"这些分支可以构造，不必真去打上游
    if (opts.upstream !== undefined) return opts.upstream(secid, 1)
    const json = await fetchAny(
      HISTORY_HOSTS,
      `/api/qt/stock/trends2/get?secid=${encodeURIComponent(secid)}&fields1=f1,f2,f3,f4,f5,f6,f7,f8,f9,f10,f11,f12,f13&fields2=${fields2}&ndays=${Math.min(5, Math.max(1, Math.round(opts.ndays ?? 1)))}&iscr=0`,
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
    // 昨收不可能是 0：上游把"没有"给成 0 时按缺失处理（缺失不许编码成 0）。
    // ⚠ 客户端另有一道判据（`isUsableBaseline`）—— 跑着的宿主可能是旧构建，那边才是主修复。
    const rawPre = num(data.prePrice) ?? num(data.preClose) ?? null
    const pre = rawPre !== null && rawPre > 0 ? rawPre : null
    // 缺失不许编码成 0：东财对国际指数/外盘商品一律回 avg/vol/amount = 0（见 normalizeTrendSeries）
    const clean = normalizeTrendSeries(points)
    return { secid, prePrice: pre, points: clean, last: clean[clean.length - 1]?.price ?? null }
  }, opts)
}

/** 该标的是否有备用源（腾讯或新浪报价映射）；用于搜索结果与工具输出如实标注"仅东财源"。 */
export function hasQuoteFallback(secid: string): boolean {
  // 用 tencentQuoteCode（沪深/港股 + 国际指数）：国际指数已改由腾讯兜底，
  // 新浪 int_* 整族停用（陈旧快照 + 无时间戳，见 sina.ts 文件头）
  return tencentQuoteCode(secid) !== null || sinaQuoteSymbol(secid) !== null
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
  // ⚠ 两条渠道的**符号体系是分开的**：新浪只认沪/深（`sh600519`），腾讯覆盖沪/深/**港股**（`hk00700`）。
  // 此前这里先算一个 `sinaSymbol` 并让腾讯档复用它 ⇒ 港股/国际/商品/期货**在结构上永远进不去**
  // （不是"上游没有多日分钟源"，而是"我们的入口把非沪深挡死了"）。现在两条各用自己的符号。
  const sinaSym = sinaSymbol(secid)
  const txSym = tencentCode(secid)
  if (sinaSym === null && txSym === null) return null
  const datalen = Math.min(1000, days * 48 + 24)
  const bars = await ttlCache<MinuteBar[]>(`trend-md:${sinaSym ?? '-'}:${txSym ?? '-'}:${datalen}`, 90_000, async () => {
    if (sinaSym !== null) {
      try {
        const s = await fetchSina5Min(sinaSym, datalen)
        if (s.length > 0) return s
      } catch {
        /* 换腾讯 */
      }
    }
    if (txSym !== null) {
      try {
        return await fetchTencent5Min(txSym, datalen)
      } catch {
        return []
      }
    }
    return []
  })
  if (bars.length === 0) return null
  const dates = [...new Set(bars.map((b) => b.label.slice(0, 10)))].sort()
  const keep = new Set(dates.slice(-days))
  const points: TrendPoint[] = bars
    .filter((b) => keep.has(b.label.slice(0, 10)))
    .map((b) => ({ t: b.t, label: b.label, price: b.price, avg: null, vol: b.vol }))
  if (points.length === 0) return null
  const clean = normalizeTrendSeries(points)
  return { secid, prePrice: null, points: clean, last: clean[clean.length - 1]?.price ?? null }
}

 // 结论（task-50 实测）：**我们的两条多日渠道（新浪 5 分钟线、腾讯 5 分钟线）只覆盖沪/深**；
 // 其它市场回落本地归档逐日累积（界面如实标注）。注意这是"我们没覆盖"，不等于"上游没有"。
 // （`trendDayCount` + 抽屉里的提示），不许静默把当日当五日画。
 // 不支持的市场退回首日数据（客户端会如实显示交易日数量）。
export async function fetchTrend(secid: string, ndays = 1, opts: TrendOptions = {}): Promise<TrendData | null> {
  if (!SECID_RE.test(secid)) return null
  const days = Math.min(5, Math.max(1, Math.round(ndays)))
  if (days > 1) {
    // 1) 真实多日源（新浪 5 分钟线 → 腾讯 5 分钟线）：**只覆盖沪/深**
    const multi = await trendWithFallback(secid, days, async () => {
      const got = await fetchMultiDayTrend(secid, days)
      return got !== null && got.points.length > 0 ? got : null
    }, opts)
    // ⚠ 判据是"**真有多天**"（不同日期数 ≥2），不是"点数 > 1"：
    // 备用源（腾讯）对港股/美股给的就是**当日** 1 分钟线（点数几百）⇒ 旧判据会让五日档只显示当天，
    // 本地归档写了从不读。现在这类市场会落到下面的归档拼接，并如实回 `coverage`。
    if (multi !== null && isMultiDayTrend(multi.points)) return multi
    // 2) 其余市场（或真实源失败）⇒ 本地归档拼接：**从本版起累积**，覆盖情况如实回包
    const stitched = await stitchFromArchive(secid, days, opts)
    if (stitched !== null) return stitched
  }
  return fetchTrendSingleDay(secid, opts)
}

/**
 * 本地归档拼接出来的多日分时。
 *
 * 三条不许（对应任务里的硬要求）：
 *  1) **不假装立刻有五日**：只有归档里真实存在的日子会进结果，`coverage.missing` 如实列出缺口；
 *  2) **不用日K冒充分时**：只用按日归档的 `TrendPoint`（K 线数据完全不参与）；
 *  3) **不凭空补齐**：`have`/`missing` 与 `points` 由同一个纯函数 `stitchTrendDays` 产出。
 *
 * 归档里一天都没有时，先取当日（顺带归档）再拼 —— 这样"今天"必然在内，
 * 界面看到的是"本地拼接 1/5 天 · 仅当日（本版起累积）"，而不是一句失败。
 */
async function stitchFromArchive(secid: string, days: number, opts: TrendOptions = {}): Promise<TrendData | null> {
  const today = dayOf(Date.now())
  const readStitched = async (): Promise<ReturnType<typeof stitchTrendDays>> => {
    const load = await loadTrendArchive(secid, { keepDays: TREND_ARCHIVE_KEEP_DAYS }).catch(() => null)
    return stitchTrendDays(load?.days ?? [], { limitDays: days, today })
  }
  let stitched = await readStitched()
  if (stitched.coverage.have.length === 0) {
    // 归档里还没有任何一天：用当日分时的取数补上（成功即归档），再拼一次
    const single = await fetchTrendSingleDay(secid, opts)
    if (single === null) return null
    stitched = await readStitched()
  }
  if (stitched.points.length < 2) return null
  return {
    secid,
    prePrice: null,
    points: stitched.points,
    last: stitched.points[stitched.points.length - 1]?.price ?? null,
    // 如实标注来源与覆盖：这不是上游给的五日，是从本版起累积的本地归档拼出来的
    source: 'local-stitch',
    coverage: stitched.coverage,
  }
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
  /** 内存里这根是不是未完成 bar（盘中抓的）；供上层暴露 lastBar.partial */
  partial: boolean
  /** 磁盘缓存**文件里**原本有多少根（降级采纳时用来写"文件里 N 根、采用 M 根"） */
  fileBars: number
  /** 被判"需要回源"的原因（null = 没被拒）；被拒**但仍采纳**时见 degradedReason */
  refusedReason: string | null
  /** 降级采纳的原因说明（"被拒但手里有 ≥N 根可用 bar ⇒ 照用"）；仅降级时有值 */
  degradedReason: string | null
  /** 采纳时是否丢掉了最后一根（未完成 bar / 旧 schema 下无法验证的那一根） */
  droppedLast: boolean
}

const klineMem = new Map<string, KlineEntry>()

/**
 * K 线磁盘缓存 schema 版本。
 * **v3 起记录 `partial`**：v2 及以前的文件**可能冻着盘中未完成 bar**（实测：`1.601872_101_1.json`
 * 的 10-09 bar 是 09:33 写下的 `close 21.93 / low 21.81 / vol 222846`，真宿主完整 bar 是
 * `close 22.07 / low 20.65 / vol 2115568`）⇒ **版本不等于当前值一律不采用**，回源重取。
 */
export const KLINE_CACHE_V = 3
/** 未完成 bar 的存活时间：超时后读缓存**必须**回源重取（盘中数据在动） */
export const PARTIAL_TTL_MS = 60_000

/**
 * 该 bar 是否"未完成"（纯函数，便于断言）：日期 == 抓取当日 **且** 抓取时刻在开盘后、收盘前。
 * 收盘后抓到的同日 bar 视为最终（可缓存）。
 */
export function isPartialBar(date: string, ts: number, closeMinute = 15 * 60): boolean {
  if (date !== dayOf(ts)) return false
  const p = shanghaiParts(ts)
  const mins = p.minutes
  return mins >= 9 * 60 + 15 && mins < closeMinute
}

/**
 * "够不够构成可用历史"的下限（与筹码模块的样本阈值 `CHIPS_MIN_SAMPLES = 10` **同值**）。
 *
 * 为什么放在这一层：判"手里的缓存能不能当历史用"是取数层的责任，筹码只是最明显的消费者。
 * 两层阈值必须一致，否则会出现"取数层给了 6 根、筹码层说样本不足"这种互相甩锅的状态。
 */
export const KLINE_MIN_USABLE_BARS = 10

/** 磁盘缓存的采纳判定结果（纯函数输出，便于直接断言） */
export interface KlineCacheAdoption {
  /** 是否采用它（true = 用这些 bar） */
  adopt: boolean
  /** 采用前是否丢掉最后一根（未完成 bar / 旧 schema 下无法验证的那一根） */
  dropLast: boolean
  /** 采用后实际能用的 bar 数 */
  usableBars: number
  /** 文件里原本有多少根（含被丢的那根） */
  fileBars: number
  /** 被判"需要回源"的原因（null = 没被拒） */
  refusedReason: string | null
  /** 降级采纳的说明（仅"被拒但仍采用"时有值） */
  degradedReason: string | null
  /** 本次用的下限 */
  minBars: number
}

/**
 * 该不该**采用**这份磁盘缓存（纯函数）。
 *
 * 缺陷背景（v0.63.0 修）：缓存里绝大多数 bar 是**已完成的历史 bar**，只有最后一根可能是盘中未完成 bar。
 * 老实现把"最后一根不可信"扩大成"整段不可用" ⇒ 回源又失败时返回 0 根 ⇒ 筹码模块报"样本不足"。
 * 手里有 900+ 根历史却报缺数据，**这是丢数据**。
 *
 * 现行规则：
 *   - 通过可用性闸门 ⇒ 原样采用（最后一根也不丢）；
 *   - 被拒（未完成 bar 超 TTL / schema 过期）⇒ **丢掉最后一根**（那根不可信），
 *     剩下的 ≥ `minBars` 根就**照用**，并把拒绝原因与"降级采纳"写进返回；
 *   - 丢掉后仍不足 `minBars` 根 ⇒ 不采用（如实报样本不足，**不硬凑**）。
 */
export function klineCacheAdoptionOf(input: {
  meta: { v?: unknown; partial?: unknown; updatedAt?: unknown }
  bars: readonly DayBar[]
  now: number
  minBars?: number
}): KlineCacheAdoption {
  const minBars = input.minBars ?? KLINE_MIN_USABLE_BARS
  const ok = klineCacheUsable(input.meta, input.now)
  const fileBars = input.bars.length
  if (ok.usable) {
    return { adopt: fileBars > 0, dropLast: false, usableBars: fileBars, fileBars, refusedReason: null, degradedReason: null, minBars }
  }
  // 被拒时最后一根为何不可信：① 未完成 bar 超 TTL；② 旧 schema（可能冻着未完成 bar，见 KLINE_CACHE_V 注释）
  const v = typeof input.meta.v === 'number' ? input.meta.v : 0
  const dropLast = fileBars > 0 && (ok.partial || v !== KLINE_CACHE_V)
  const usableBars = Math.max(0, fileBars - (dropLast ? 1 : 0))
  if (usableBars >= minBars) {
    return {
      adopt: true,
      dropLast,
      usableBars,
      fileBars,
      refusedReason: ok.reason,
      degradedReason: `${ok.reason}；但文件里有 ${fileBars} 根，丢掉不可信的最后一根后仍有 ${usableBars} 根 ≥ ${minBars} ⇒ 降级采用（不回源成功也照用）`,
      minBars,
    }
  }
  return { adopt: false, dropLast, usableBars, fileBars, refusedReason: ok.reason, degradedReason: null, minBars }
}

/**
 * 缓存条目是否可用（纯函数）：版本不符 ⇒ 不可用；`partial` 且超过 TTL ⇒ 不可用（须回源）。
 *
 * ⚠ 这里只回答"要不要回源"；**要不要放弃整段缓存**由 `klineCacheAdoptionOf` 决定（它会在被拒时降级采用）。
 */
export function klineCacheUsable(meta: { v?: unknown; partial?: unknown; updatedAt?: unknown }, now: number): { usable: boolean; partial: boolean; reason: string | null } {
  const v = typeof meta.v === 'number' ? meta.v : 0
  if (v !== KLINE_CACHE_V) return { usable: false, partial: false, reason: `缓存 schema v${v} ≠ v${KLINE_CACHE_V}（旧文件可能含未完成 bar）⇒ 回源重取` }
  const partial = meta.partial === true
  const at = typeof meta.updatedAt === 'number' ? meta.updatedAt : 0
  if (partial && now - at > PARTIAL_TTL_MS) {
    return { usable: false, partial: true, reason: `未完成 bar 已超过 ${PARTIAL_TTL_MS / 1000}s TTL ⇒ 回源重取` }
  }
  return { usable: true, partial, reason: null }
}

/**
 * 该 (secid, klt, fqt) 依次尝试的缓存**文件名**（纯函数，便于断言）。
 *
 * - 现行命名：`<secid>_<klt>_<fqt>.json`（复权口径各自一份，混存会造成图上无解释的跳空）；
 * - 及以前是 `<secid>_<klt>.json`，那时的取数一律 `fqt=0`，所以它**就是**不复权口径的缓存
 *   —— 只在 `fqt=0` 时兜底复用，不迁移、不重命名（指数/期货被 `normalizeFq` 归一为 0，
 *   因此它们命中的正是这份老文件）。
 */
/**
 * 最近一次取数的"最后一根 bar"元信息（供回包暴露 `lastBar`）：
 * `partial` 为 true 说明它是**盘中未完成 bar**（数值会变，不可与最终 bar 混用）。
 */
export function lastBarOfKline(secid: string, klt: number, fqt: FqMode): { date: string; close: number; vol: number; partial: boolean } | null {
  const key = `${secid}|${klt}|${fqt}`
  const hit = klineMem.get(key)
  if (hit === undefined || hit.bars.length === 0) return null
  const last = hit.bars[hit.bars.length - 1]
  return { date: last.date, close: last.close, vol: last.vol, partial: hit.partial === true }
}

/** 磁盘缓存当前状态（供路由层写原因文案；在 fetchKline 之后调用即为本次实际用的那份） */
export interface KlineCacheStatus {
  /** 盘上是否有这个 (secid, klt, fqt) 的缓存文件（哪怕是"被判不可用"的那份） */
  exists: boolean
  fileBars: number
  usableBars: number
  /** 被判"需要回源"的原因（null = 没被拒） */
  refusedReason: string | null
  /** 是否降级采用（被拒但仍用了它的 bar） */
  degraded: boolean
  minBars: number
}

/** 读本次 (secid, klt, fqt) 的缓存状态（需先经过 `fetchKline`/`loadKlineCache` 填充内存） */
export function klineCacheStatusOf(secid: string, klt: number, fqt: FqMode): KlineCacheStatus | null {
  const hit = klineMem.get(`${secid}|${klt}|${fqt}`)
  if (hit === undefined) return null
  const fileBars = hit.fileBars
  return {
    exists: fileBars > 0 || hit.refusedReason !== null,
    fileBars,
    usableBars: hit.bars.length,
    refusedReason: hit.refusedReason,
    degraded: hit.degradedReason !== null,
    minBars: KLINE_MIN_USABLE_BARS,
  }
}

/**
 * 降级复用时给客户端的那句说明（纯函数）。
 *
 * 只在"**用了被判需要回源的缓存** 且 回源这轮没拿到新数据"时给；定稿免回源（settled）与正常回源都不给
 * —— 那两种情况下数据是正常的，多说一句就是噪音（用户明确要求少提示）。
 */
export function klineStaleNoteOf(input: {
  settled: boolean
  stale: boolean
  degradedReason: string | null
  droppedLast: boolean
  usableBars: number
}): string | null {
  if (input.settled || !input.stale || input.degradedReason === null) return null
  // v0.64.1（lead 决定）：可见句是被截断的**首段**，「未完成」比「不可信」点得更明（这是盘中未完成 bar）
  const dropped = input.droppedLast ? '；未完成的最后一根已丢弃' : ''
  return `回源未取到新数据 ⇒ 改用本地缓存的 ${input.usableBars} 根已完成 bar${dropped}（原因：${input.degradedReason}）`
}

export function klineCacheFileNames(secid: string, klt: number, fqt: FqMode): string[] {
  const names = [`${secid}_${klt}_${fqt}.json`]
  if (fqt === 0) names.push(`${secid}_${klt}.json`)
  return names
}

function klineFile(secid: string, klt: number, fqt: FqMode): string {
  return join(dataHome(), 'klines', `${secid}_${klt}_${fqt}.json`)
}

async function loadKlineCache(secid: string, klt: number, fqt: FqMode): Promise<KlineEntry> {
  const key = `${secid}|${klt}|${fqt}`
  const hit = klineMem.get(key)
  if (hit !== undefined && hit.loaded) return hit
  const entry: KlineEntry = hit ?? {
    bars: [], loaded: false, updatedAt: 0, partial: false,
    fileBars: 0, refusedReason: null, degradedReason: null, droppedLast: false,
  }
  const paths = klineCacheFileNames(secid, klt, fqt).map((name) => join(dataHome(), 'klines', name))
  for (const path of paths) {
    try {
      const raw = await readFile(path, 'utf8')
      const parsed = JSON.parse(raw) as { bars?: DayBar[]; updatedAt?: number; v?: number; partial?: boolean }
      const bars = Array.isArray(parsed.bars)
        ? parsed.bars.filter((b) => b !== null && typeof b.date === 'string' && Number.isFinite(b.close))
        : []
      // ⚠ v0.63.0：不再"被拒就整段丢弃" —— 由 klineCacheAdoptionOf 决定（≥N 根可用时降级采用）
      const decision = klineCacheAdoptionOf({ meta: parsed, bars, now: Date.now() })
      entry.fileBars = decision.fileBars
      entry.refusedReason = decision.refusedReason
      entry.degradedReason = decision.degradedReason
      entry.droppedLast = decision.adopt && decision.dropLast
      if (!decision.adopt) {
        console.warn('[tradewatcher] 跳过 K 线缓存:', path, decision.refusedReason,
          `文件里 ${decision.fileBars} 根、可用 ${decision.usableBars} 根 < ${decision.minBars}`)
        continue
      }
      if (decision.refusedReason !== null) {
        console.warn('[tradewatcher] 降级采用 K 线缓存:', path, decision.degradedReason)
      }
      entry.bars = decision.dropLast ? bars.slice(0, -1) : bars
      entry.updatedAt = typeof parsed.updatedAt === 'number' ? parsed.updatedAt : 0
      // 丢掉那根未完成 bar 之后，最后一根就是**已完成**的 ⇒ partial 必须跟着变成 false
      entry.partial = decision.dropLast ? false : parsed.partial === true
      break
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
    // 落盘时判定最后一根：盘中抓到的当日 bar 标 partial（读侧按 60s TTL 决定是否回源）
    const last = bars.length > 0 ? bars[bars.length - 1] : null
    const partial = last !== null && isPartialBar(last.date, Date.now())
    // 跨进程：**锁内「读磁盘最新 → 按日期合并 → 原子写回」**。
    // 两个进程同时落盘同一标的时，裸写会让一份覆盖另一份（谁的 bars 更全取决于时序）；
    // 半截 JSON 还会被读侧当成"没有缓存"⇒ 白拉一遍上游（正是本轮要减少的那种请求）。
    await updateJsonLocked(
      klineFile(secid, klt, fqt),
      (disk) => {
        const old = (disk !== null && typeof disk === 'object' ? (disk as { bars?: DayBar[] }).bars : undefined) ?? []
        return {
          v: KLINE_CACHE_V,
          secid,
          klt,
          fqt,
          updatedAt: Date.now(),
          partial,
          bars: mergeBars(old, bars, KLINE_CAP[klt] ?? Math.max(old.length, bars.length)),
        }
      },
      { note: `kline:${secid}:${klt}:${fqt}` },
    )
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
    // 跨进程："读目录 → 按配额删"是读-改-写；两个进程同时裁剪会各自按同一份旧清单删
    // （并且可能把对方刚写的文件删掉）。锁文件放在被裁剪的目录里 ⇒ **清单必须排除非 .json 与点文件**，
    // 否则裁剪会把锁自己删掉（那是硬要求，见 docs/AUDIT-IMPL42.md §5.2）。
    await withFileLock(join(dir, '.klines'), async () => {
      const names = (await readdir(dir)).filter((n) => n.endsWith('.json') && !n.startsWith('.'))
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
    }, { note: 'klines:prune', staleMs: 30_000, timeoutMs: 10_000 })
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
  // 国际指数（100.*）：腾讯用 `us.INX` 这种**带点**的写法（美股个股是 `usAAPL`，不带点）
  return tencentIndexCode(secid)
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
    // 也不能把不复权价格当前复权画出去（旧实现优先取 `${period}`，就是这种混口径）。
    // 例外：**国际指数**（`100.*`）实测只回 `${period}`（如 `us.INX` 的 `day`），
    // 且指数没有除权除息 ⇒ `day` 与 `qfqday` 是同一份序列，取它不构成混口径。
    const key = fq === '' ? period : `${fq}${period}`
    const rows = (node[key] ?? (/^100\./.test(secid) ? node[period] : undefined)) as unknown
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

/**
 * 熔断冷却中（一台可用主机都没有）：与"试过但失败"**必须分开**。
 *
 * 分开的意义在负缓存：`ttlCache` 连 `null` 也缓存（full 键 1 小时、incr 键 2 分钟），
 * 若把"熔断中"也写进负缓存，一次冷却就会把该标的的 K 线锁死一小时（而冷却通常 2–15 分钟就恢复了）。
 * 所以冷却时抛这个错误，由 `refreshKline` 识别后**不写缓存**，下次调用重新判断
 * （冷却期内每次都是本地快速失败，不会产生任何上游请求）。
 */
class UpstreamCoolingError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'UpstreamCoolingError'
  }
}

/**
 * 单主机取数，**过熔断器**：放行判定、半开探针名额、成功/失败记账与释放，与 `fetchAny` 同源。
 *
 * 为什么 K 线不直接用 `fetchAny`：`fetchAny` 把"200 + 空数组"当成功返回（任一台成功即返回），
 * 而 K 线必须识别"这台回了但没有数据 ⇒ 换下一台"（push2delay/push2 常回空），所以保留逐主机循环；
 * 但**账本必须共用** —— 此前这里直调裸 `fetchFromHost`：既不查 `allow()` 也不 `recordFailure`，
 * 实测三台主机全部熔断时一次 `/kline` 仍发 **6 条**请求，而 `trips`/`fails` 一字不变
 * （AUDIT-CACHE-2 §3.2 / C2，两份审计独立命中）。
 */
async function fetchHostThroughBreaker(host: string, pathAndQuery: string, timeoutMs: number): Promise<unknown> {
  const breaker = breakerFor(host)
  if (!breaker.allow()) {
    throw new UpstreamCoolingError(`上游熔断冷却中（约 ${minutesToRecover([host])} 分钟后自动重试）`)
  }
  // 半开期只放行一个探针（与 fetchAny 同语义）：抢不到名额就当"这次没发请求"，不计失败
  if (!breaker.claimProbe()) {
    throw new UpstreamCoolingError(`上游熔断半开探测中（约 ${minutesToRecover([host])} 分钟后重试）`)
  }
  try {
    const json = await fetchFromHost(host, pathAndQuery, timeoutMs)
    breaker.recordSuccess()
    return json
  } catch (error) {
    breaker.recordFailure(error)
    throw error
  } finally {
    breaker.releaseProbe()
  }
}

/** 单主机取 K 线；空数组视为失败（push2delay/push2 会返回 200 + 空）。优先腾讯。 */
async function requestKlineRaw(secid: string, klt: number, lmt: number, fqt: FqMode): Promise<DayBar[] | null> {
  /** 至少有一个源给了**成功回包**（哪怕没有这个标的的 K 线）—— 决定 missing 的 why 是 no-source 还是 transient */
  let replied = false
  const fromTencent = await requestKlineFromTencent(secid, klt, lmt, fqt)
  if (fromTencent !== null) return fromTencent
  const fields2 = 'f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61'
  const path = `/api/qt/stock/kline/get?secid=${encodeURIComponent(secid)}&klt=${klt}&fqt=${fqt}&lmt=${lmt}&end=20500101&fields1=f1,f2,f3&fields2=${fields2}`
  for (let attempt = 0; attempt < 2; attempt += 1) {
    /** 本轮是否真的发出过请求（三台全在冷却 ⇒ 一条都没发 ⇒ 不必再等 500ms 重试第二轮） */
    let triedThisRound = false
    for (const host of HISTORY_HOSTS) {
      try {
        const json = await fetchHostThroughBreaker(host, path, 9000)
        triedThisRound = true
        replied = true
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
      } catch (error) {
        // 熔断冷却/半开探针被别人占用：这一次没发请求，换下一台，**不计失败**
        if (error instanceof UpstreamCoolingError) continue
        triedThisRound = true
        /* 换主机 / 重试 */
      }
    }
    if (!triedThisRound) throw new UpstreamCoolingError('东财历史行情主机全部处于熔断冷却中')
    if (attempt === 0) await new Promise((r) => setTimeout(r, 500))
  }
  // 全程一个成功回包都没有 ⇒ 上游故障（transient）；有回包但没数据 ⇒ 结构性缺失（no-source）
  if (!replied) noteUpstreamFailure('kline')
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
): Promise<(KlineData & { staleReason?: string }) | null> {
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
  // 降级复用的说明（只在"用了被判需要回源的缓存 且 回源没拿到新数据"时给；正常/定稿都不给）
  const staleReason = klineStaleNoteOf({
    settled,
    stale,
    degradedReason: entry.degradedReason,
    droppedLast: entry.droppedLast,
    usableBars: entry.bars.length,
  })
  return {
    secid,
    days,
    stale,
    ...(staleReason === null ? {} : { staleReason }),
    fqt: mode,
    fqSupported: supported,
    // 口径条的"数据截至"= 本地最近一次成功取数时刻（定稿时就是收盘那一次）
    asOf: entry.updatedAt > 0 ? entry.updatedAt : Date.now(),
    barOpen,
    ...(settled ? { cached: true } : {}),
  }
}

/**
 * 「这份数据拿不到」的**原因**（A/B/C 项的 C）：与 `quoteProvenance` 同一口径，
 * `no-source`（上游结构性没有，重试无用）/ `transient`（上游这会儿不可达，等恢复）。
 *
 * 之前路由只回 `{trend:null}` / `{kline:null}` / `{detail:null}`，客户端只能给一句
 * 「详情加载失败 重试」—— 用户无从知道是"该市场本来就没有"还是"东财被限流了"。
 */
export interface UpstreamReason {
  what: string
  why: 'no-source' | 'transient'
  note: string
}

/** 分时（trend）拿不到时的原因。腾讯分钟线只覆盖沪/深/港股（见 `tencentCode`），其余市场没有兜底。 */
export function trendMissingReason(secid: string, opts: { emDown?: boolean } = {}): UpstreamReason {
  const tencentMinute = tencentCode(secid) !== null
  // 判定顺序：注入值（测试）→ 本链路刚失败过 → 本链路主机熔断中 → 东财整体不可用
  const down = opts.emDown ?? (upstreamFailedRecently('trend') || hostsUnavailable(HISTORY_HOSTS) || emUnavailableNow())
  if (down) {
    return {
      what: '分时',
      why: 'transient',
      note: tencentMinute
        ? `东财行情主机当前不可达（熔断/限流），腾讯分钟线这次也未取到，本地又没有可用快照 —— ${MISSING_TIER_ADVICE.transient}`
        : `东财行情主机当前不可达（熔断/限流），而该标的没有腾讯分钟线兜底（腾讯只覆盖沪/深/港股），本地也没有可用快照 —— ${MISSING_TIER_ADVICE.transient}（不是"该标的没有分时"）`,
    }
  }
  return {
    what: '分时',
    why: 'no-source',
    note: `东财当前可达但没有返回该标的的分时数据，且本插件没有别的分钟源可兜底（腾讯只覆盖沪/深/港股）—— ${MISSING_TIER_ADVICE['no-source']}`,
  }
}

/**
 * 「分时拿到了、但**量能**用不了」的原因（v0.66.0，红线修复）。
 *
 * 为什么单独一条：`/trend` 只在 `trend === null` 时给 `missing` ⇒ 出现"有 180 个点、个个 `amount: null`"
 * 时 `missing` 仍是 `null`，客户端只剩一句「分钟成交额未取到」——**违反"缺失必须给原因"**。
 *
 * 三情形分开写（判据互斥，按①②③顺序）：
 *   ① 上游都不可达（东财熔断/限流 + 腾讯也没给）⇒ `transient`（等恢复）
 *   ② 可达但结构变了/字段缺失（点位够、带成交额的点不足）⇒ `no-source`（重试无用，要修映射）
 *   ③ 非采样时段（未开盘/午休/已收盘）⇒ `transient`，但文案说明"不是故障"
 */
export function trendAmountMissingReason(
  trend: TrendData | null,
  opts: { emDown?: boolean; now?: number } = {},
): UpstreamReason | null {
  if (trend === null) return null // 整条都没有 ⇒ 由 trendMissingReason 负责，别重复
  const usable = trend.points.filter((p) => typeof p.amount === 'number' && p.amount > 0).length
  if (usable >= 5) return null // 够用就不报
  const total = trend.points.length
  const now = opts.now ?? Date.now()
  const down = opts.emDown ?? (upstreamFailedRecently('trend') || hostsUnavailable(HISTORY_HOSTS) || emUnavailableNow())
  const session = inSession(now)
  if (!session) {
    return {
      what: '分时量能',
      why: 'transient',
      note: `当前非采样时段（未开盘/午休/已收盘）⇒ 分时量能要开盘后才有；本轮 ${total} 个点里有成交额的 ${usable} 个 —— 不是故障，也不是 0`,
    }
  }
  if (down) {
    return {
      what: '分时量能',
      why: 'transient',
      note: `东财行情主机当前不可达（熔断/限流），腾讯逐分钟源这次也没给出可用成交额 ⇒ 本轮 ${total} 个点里有成交额的只有 ${usable} 个 —— ${MISSING_TIER_ADVICE.transient}`,
    }
  }
  return {
    what: '分时量能',
    why: 'no-source',
    note: `上游可达但成交额字段缺失/结构变化：本轮 ${total} 个点里只有 ${usable} 个带成交额（东财 trends2 的成交额段、腾讯逐分钟第 4 段的累计额都没给到）—— 不用 0 顶替，需核对上游字段`,
  }
}

/**
 * 日K/周K/月K 拿不到时的原因。
 * K 线的上游：腾讯 fqkline（**只覆盖沪/深/港股/美股**，见 `tencentSymbol`）→ 东财 push2his → 本地增量缓存。
 */
export function klineMissingReason(
  secid: string,
  klt: number,
  opts: { emDown?: boolean; cache?: KlineCacheStatus | null } = {},
): UpstreamReason {
  const label = klt === 101 ? '日K' : klt === 102 ? '周K' : klt === 103 ? '月K' : '年K'
  const tencentKline = tencentSymbol(secid) !== null
  const down = opts.emDown ?? (upstreamFailedRecently('kline') || hostsUnavailable(HISTORY_HOSTS) || emUnavailableNow())
  /**
   * **缓存那半句**必须区分三情形（v0.63.0 修）：老实现无论哪种都写"本地没有该周期的缓存"，
   * 而用户遇到的恰恰是"缓存明明在、只是被判不可用" —— 那句话与事实不符，会把人引到错的方向。
   */
  const cacheClause = ((): string => {
    const c = opts.cache ?? null
    if (c === null || !c.exists) return '本地确实没有该周期的缓存数据'
    if (c.refusedReason !== null) {
      return `本地有该周期的缓存，但被判不可用（${c.refusedReason}${c.fileBars > 0 ? `；文件里 ${c.fileBars} 根` : ''}${c.fileBars > 0 && c.fileBars < c.minBars ? `，不足 ${c.minBars} 根的样本下限` : ''}）`
    }
    return `本地有该周期的缓存（${c.fileBars} 根），但可用部分不足 ${c.minBars} 根的样本下限`
  })()
  if (down) {
    return {
      what: label,
      why: 'transient',
      note: tencentKline
        ? `${cacheClause}；东财行情主机当前不可达（熔断/限流），腾讯这次也没取到 —— ${MISSING_TIER_ADVICE.transient}`
        : `${cacheClause}；该标的也不在腾讯的 K 线覆盖内（腾讯只覆盖沪/深/港股/美股），而东财行情主机当前不可达（熔断/限流）—— ${MISSING_TIER_ADVICE.transient}`,
    }
  }
  return {
    what: label,
    why: 'no-source',
    note: `${cacheClause}；腾讯与东财当前都可达但没有返回该标的的 K 线 —— ${MISSING_TIER_ADVICE['no-source']}`,
  }
}

/** 个股详情（抽屉头部）拿不到时的原因。 */
export function detailMissingReason(opts: { emDown?: boolean } = {}): UpstreamReason {
  if (opts.emDown ?? (upstreamFailedRecently('detail') || hostsUnavailable(QUOTE_HOSTS) || emUnavailableNow())) {
    return {
      what: '详情',
      why: 'transient',
      note: `东财行情主机当前不可达（熔断/限流）—— 行情详情（开高低收/量额/市值）只有东财一个上游；${MISSING_TIER_ADVICE.transient}`,
    }
  }
  return {
    what: '详情',
    why: 'no-source',
    note: `东财当前可达但没有返回该标的的详情字段（这类标的常见于指数/外盘商品）—— ${MISSING_TIER_ADVICE['no-source']}`,
  }
}

/**
 * 增量回源 + 落盘。返回 true 表示"上游失败、这次给的是旧缓存"。
 * 拆成独立函数是为了让 fetchKline 的三个分支（定稿免回源 / 失败 / 成功）各只有一条出口。
 */
async function refreshKline(secid: string, baseKlt: number, fqt: FqMode, entry: KlineEntry, needFull: boolean): Promise<boolean> {
  const key = `kline:${secid}:${baseKlt}:${fqt}:${needFull ? 'full' : 'incr'}`
  let fetched: DayBar[] | null
  try {
    fetched = await ttlCache<DayBar[] | null>(key, needFull ? 3600_000 : 120_000, () =>
      requestKlineRaw(secid, baseKlt, needFull ? KLINE_FULL_LMT[baseKlt] : KLINE_RECENT_LMT[baseKlt], fqt),
    )
  } catch (error) {
    if (!(error instanceof UpstreamCoolingError)) throw error
    // 熔断冷却中（一台可用主机都没有）：**不写负缓存** —— 否则一次冷却会把该标的锁到 1 小时后，
    // 而熔断通常 2–15 分钟就恢复。冷却期内每次调用都是本地快速失败（0 上游请求），代价可忽略。
    fetched = null
  }
  if (fetched !== null && fetched.length > 0) {
    const before = entry.bars.length
    const beforeLast = entry.bars[entry.bars.length - 1]?.date ?? ''
    entry.bars = mergeBars(entry.bars, fetched, KLINE_CAP[baseKlt])
    entry.updatedAt = Date.now()
    const afterLast = entry.bars[entry.bars.length - 1]?.date ?? ''
    // 内存里同步标出最后一根是否未完成（盘中），并把标记落盘（读侧按 TTL 决定是否回源）
    const lastNow = entry.bars.length > 0 ? entry.bars[entry.bars.length - 1] : null
    entry.partial = lastNow !== null && isPartialBar(lastNow.date, Date.now())
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
/**
 * 东财 clist 的**一页**（涨跌幅），供涨跌家数自统计（源 B）与涨跌分布扫描用。
 *
 * `pz` 被上游截在 100（实测），所以调用方按 100 分页；`fs` 固定为沪深A股（不含北交所，
 * 口径写在 `BREADTH_COUNT_CALIBER` 里）。返回 `rows` = 该页每只的涨跌幅（f3），`total` = 上游给的总数。
 *
 * ── 短 TTL（P0-2）：同一轮里两遍扫只会打一遍上游 ──────────────────────────────
 * `/breadth?dist=1` 在"指数行情没有涨跌家数"（＝行情走备用源时的常态）下，源 B（涨跌家数全量分页）
 * 与涨跌分布扫描会**各扫一遍字节级相同的 56 个 URL** —— 实测一次调用 **112 次上游**（56 × 2，
 * AUDIT-CACHE-1 S4-4）。两条链路都走本函数，所以缓存加在这里、同轮两遍自然共享：
 * 改后同一场景实测 56 次（每个 URL 恰好一遍）。
 * 窗口取 20s，**必须小于分布快照的 60s 口径** —— 直方图描述的是"同一时刻全市场"的截面，
 * 跨 60s 复用会让两处口径不一致。
 *
 * ── 负缓存（P1-1）：失败也要记一小会儿 ────────────────────────────────────────
 * 此前失败**什么都不缓存**，于是故障期间每次 `/breadth` 调用都会重跑一整遍 56 页循环
 * （网络流量为 0，因为 `fetchAny` 已把主机熔断、快速失败），代价是 CPU，以及
 * **每个调用都去抢半开探针名额** —— 一次低价值的页请求就能把探针名额吃掉。
 * 现在失败记 15s（带原因），到点自动重试；恢复后的第一次请求不会被挡（窗口很短且只挡同一页）。
 */
const CLIST_PCT_TTL_MS = 20_000
const CLIST_PCT_FAIL_TTL_MS = 15_000
const CLIST_PCT_FAIL_MAX = 200
const clistPctFail = new Map<string, { at: number; message: string }>()

export async function fetchClistPctPage(pn: number, pz: number): Promise<CountPage> {
  const p = Math.max(1, Math.round(pn))
  const z = Math.max(1, Math.min(BREADTH_PAGE_SIZE, Math.round(pz)))
  const key = `clist-pct:${p}:${z}`
  const failed = clistPctFail.get(key)
  if (failed !== undefined && Date.now() - failed.at < CLIST_PCT_FAIL_TTL_MS) {
    throw new Error(failed.message)
  }
  const path = `/api/qt/clist/get?pn=${p}&pz=${z}&po=1&np=1&fltt=2&invt=2&fid=f3&fs=${encodeURIComponent(BREADTH_HS_A_FS)}&fields=f3,f12`
  try {
    return await ttlCache<CountPage>(key, CLIST_PCT_TTL_MS, async () => {
      const json = await fetchAny(QUOTE_HOSTS, path)
      const body = bodyOf(json)
      const rawTotal = body?.data?.total
      const total = typeof rawTotal === 'number' && Number.isFinite(rawTotal) ? rawTotal : null
      // 无涨跌幅的行（停牌 / 上游给 '-'）**保留为 null 占位**：既不能当 0，也不能悄悄丢掉 ——
      // 丢掉会让"三类之和 = 上游总数"的等式永远不成立（当日有 1 只停牌就判失败）
      const rows = diffList(json).map((r) => num(r.f3))
      return { rows, total }
    })
  } catch (error) {
    if (clistPctFail.size >= CLIST_PCT_FAIL_MAX) clistPctFail.clear()
    clistPctFail.set(key, { at: Date.now(), message: String(error instanceof Error ? error.message : error).slice(0, 120) })
    throw error
  }
}

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

/** 行业榜结果的有效期（与 `fetchBoard` 的 30s 页缓存对齐）：窗口内反复查询不再翻页 */
const INDUSTRY_MAP_TTL_MS = 30_000
/** 行业榜一次全量的页数上限（上游 total 异常时不至于无限翻页） */
const INDUSTRY_BOARD_MAX_PAGES = 8
interface IndustryBoardMap { at: number; map: Map<string, number | null>; total: number }
let industryMapCache: IndustryBoardMap | null = null
let industryMapInflight: Promise<IndustryBoardMap> | null = null

/**
 * name → 板块当日涨跌幅。**按需取页**（P2-1）。
 *
 * 此前无论要几个板块名，都从 `pn=1` 一路翻到 `map.size >= total`：用户数据里行业榜
 * `total=496`（`board-lkg.json` 实测）、`pz` 被上游截在 100 ⇒ 至少 5 页，抽屉首开实测 **+8 次上游**
 * （AUDIT-CACHE-1 S7-5，"8 页只为 1 个板块"）。现在两处收口：
 *   ① `wanted` 里的名字**全部定位到**就停翻（只查 1 个板块且它在第 1 页 ⇒ 实测 5 → 1 次）；
 *   ② 同一份结果 30s 内复用 + **在飞合并** ⇒ 抽屉反复开关、`/industries` 与 `/industry` 同刻调用
 *      都只翻一遍（页本身另有 30s 缓存，所以"续翻"也不会让已取过的页重打上游）。
 *
 * ⚠ 定位不到的名字**照实缺席**（调用方记 `pct: null`，界面显示未取到），
 * 绝不用别的板块的涨幅顶替 —— 那不是"省一次请求"，是编数。
 */
async function industryBoardPctMap(wanted: ReadonlySet<string>): Promise<IndustryBoardMap> {
  const cached = industryMapCache
  if (cached !== null && Date.now() - cached.at < INDUSTRY_MAP_TTL_MS && [...wanted].every((n) => cached.map.has(n))) {
    return cached
  }
  if (industryMapInflight !== null) {
    // 在飞：等它结算；若它的结果没覆盖这次要的名字，再续翻（已取过的页命中 30s 页缓存 ⇒ 0 请求）
    const flying = await industryMapInflight
    if ([...wanted].every((n) => flying.map.has(n))) return flying
  }
  const run = (async (): Promise<IndustryBoardMap> => {
    const map = new Map<string, number | null>()
    let total = Infinity
    for (let pn = 1; pn <= INDUSTRY_BOARD_MAX_PAGES && map.size < total; pn += 1) {
      const board = await fetchBoard('industry', 'pct', pn, 100)
      total = board.total
      for (const r of board.rows) {
        if (!map.has(r.name)) map.set(r.name, r.pct)
      }
      // 按需取页：要的名字都定位到了就不再翻（顺序按涨幅降序，与"同一个板块的涨幅"无关）
      if (wanted.size > 0 && [...wanted].every((n) => map.has(n))) break
      if (board.rows.length === 0) break
    }
    return { at: Date.now(), map, total }
  })()
  industryMapInflight = run
  try {
    const done = await run
    industryMapCache = done
    return done
  } finally {
    if (industryMapInflight === run) industryMapInflight = null
  }
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
  const board = (await industryBoardPctMap(new Set(names.values()))).map
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
