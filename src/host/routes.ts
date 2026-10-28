/**
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { CorporateAction, MissingField, MutatePortBody, MutateWatchBody, QuoteRow } from '../shared/model.ts'
import { stripKindOf, RESCUE_LEVEL_LABEL, SECID_RE, SUGGEST_FULL_COUNT, SUGGEST_MAX_COUNT } from '../shared/model.ts'
import { isTrustedApiRequest } from './fence.ts'
import * as em from './em.ts'
import { atr14PctOf } from './atr.ts'
import { ledgerTotal, assemblePortfolio, ledgerViews } from './portfolio.ts'
import { DataStore, secidKey } from './store.ts'
import { CalendarStore, calToday, type CalSyncSourceResult } from './calendar.ts'
import { RESCUE_METHODOLOGY, RescueMonitor, wireRescueSnapshot } from './rescue.ts'
import { wireKline, wireTrend } from './wireSlim.ts'
import { QUOTE_HOSTS, HISTORY_HOSTS } from './em.ts'
import { TENCENT_KLINE_HOSTS } from './tencent.ts'
import { auctionMissingOf } from './auction.ts'
import { breakerSummary } from './breaker.ts'
import { HttpError, httpStatusOf, retryAfterSecondsOf } from './http.ts'
import { TotalUpstreamError, partialOutcomeOf, shortError, upstreamHealth, type PartialOutcome } from './degrade.ts'
import { describeConflicts, makeBundle, verifyBundle } from './backup.ts'
import { detectAnomalies } from './anomaly.ts'
import { YTD_MAX_IDS, computeYtds } from './ytd.ts'
import { TONE_MAX_IDS, computeTones } from './tonesService.ts'
import { BREADTH_MIN_DAYS, BREADTH_WINDOW, BreadthStore, breadthUsable, percentileOf, upRatio } from './breadth.ts'
import { BREADTH_METHODOLOGY, BREADTH_COUNT_CALIBER, BREADTH_CLIST_MAX_PAGES, BREADTH_PAGE_SIZE, BreadthCountCache, resolveBreadthCount } from './breadthCount.ts'
import { tencentBreadthAggregate } from './breadthScan.ts'
import { fetchTextHost } from './hostFetch.ts'
import { detailWithFallback, fetchTencentDetail } from './detailTencent.ts'
import * as extras from './marketExtras.ts'
import { emptyLeveragePayload, LeverageService, parseLeverageRange } from './leverage.ts'
import { dayOf } from './time.ts'
import { DIST_LABELS, distributionBinsOf } from '../client/breadthView.ts'
import { log, type PluginWebRoute } from './context.ts'
import { dayTradesOf } from './dayTrade.ts'
import { CHIPS_DISPLAY, CHIPS_DISPLAY_MAX, CHIPS_MIN_SAMPLES, CHIPS_WINDOW, CHIPS_WINDOW_MAX, chipSeriesOf } from './chips.ts'
import { alignVolUnitWithQuote } from './klineUnits.ts'
import { globalFlowPayload } from './globalFlow.ts'
import { FUPAN_DROP_TEXT, FupanStore, fupanMonthView, notesInMonth, notesOnDay, parseFupanMonth, parseFupanOp } from './fupan.ts'
import { makePrismRoutes } from './prismRoutes.ts'
import { parseFupanDay, readFupanMonthTrades, readFupanTrades } from './fupanTrades.ts'
import { unreadableMissing } from './readGuard.ts'

/**
 * 【涨跌分布】全市场扫描（task-14 ②）：东财 clist 逐页取 `f3`（涨跌幅），按分档计数。
 *
 * 成本与边界（写死在注释里，免得后人以为它免费）：
 *   - 每页 100 只（`BREADTH_PAGE_SIZE`，上游上限），A 股约 5500 只 ⇒ **~56 页**；
 *   - 并发 `DIST_CONCURRENCY`：此前是**串行**扫 56 次（实测并发峰值 1、上游 100ms 延迟下墙钟 5.9s、
 *     真实上游 100–300ms 时 ≈6–20s 才出图，AUDIT-CACHE-1 §2.4）；现在与源 B 同量级的有限并发，
 *     但顺序不影响结果（分档计数与页序无关）、失败即整轮失败（红线不变）；
 *   - 页数上限**与源 B 共用同一个常量**（`BREADTH_CLIST_MAX_PAGES`）—— 两侧各自写死会漂移；
 *   - 超上限 / 中途失败 / 上游未给总数 ⇒ `counts: null` + 原因，
 *     **绝不**用"扫到的那部分"冒充全市场；
 *   - 结果按 `DIST_TTL_MS` 缓存（默认 60s）；页级另有 20s 短缓存（`em.fetchClistPctPage`），
 *     并与源 B（涨跌家数全量分页）**共享同一份页数据** ⇒ 同一次调用里两遍扫只打一遍上游
 *     （实测 113 → 57 次，AUDIT-CACHE-1 P0-2）。
 * 口径：只按**涨跌幅**分档；`null`（停牌/上游给 `-`）单独计入 `blank`，不当 0（不许凭空加一只平盘）。
 */
const DIST_TTL_MS = 60_000
const BREADTH_PAGES_MAX = BREADTH_CLIST_MAX_PAGES
/** 分布扫描的并发（页数上限仍写死在常量里；顺序无关，故可乱序完成） */
const DIST_CONCURRENCY = 6

/**
 * 涨跌分布快照。两条源：
 *   · `em-clist`    —— 东财 clist 分页自统计（原有唯一路子）
 *   · `tencent-agg` —— 腾讯批量报价聚合（东财不可用时的兜底，路径见 docs/PROBE-BREADTH-SOURCES.md）
 *
 * `counts === null` = 本轮没扫全 —— **不拿扫到的那部分冒充全市场**；此时 `reason` 必给。
 * `coverage` 三个数（池内代码 / 有报价 / 停牌）与 `partial` 一起上屏，界面据此写「覆盖 N 只」或「已扫 k/N 批」。
 */
interface DistSnapshot {
  labels: readonly string[]
  counts: number[] | null
  /** 无涨跌幅（停牌等）的行数，未计入任何档 */
  blank: number
  /** 参与分档的行数（= 有报价 − 停牌） */
  scanned: number
  /** 池内总数（东财=上游 total；腾讯=代码表条数） */
  total: number | null
  asOf: number
  reason: string | null
  source: 'em-clist' | 'tencent-agg' | null
  coverage: { codes: number; quoted: number; suspended: number } | null
  partial: boolean
  scannedBatches: number
  totalBatches: number
  warn: string | null
  /**
   * 分布**同一次扫描**里的五个家数（up/flat/down/limitUp/limitDown）。
   * 左侧「涨跌趋势」5 格直接取这五个数 —— 与柱状图同源，避免"格子是 A 源、柱子是 B 源"。
   * 取不到 ⇒ null（界面 `—` + 原因，不写 0）。东财路径的涨跌停不可由分档反推 ⇒ 那两格 null。
   */
  up: number | null
  down: number | null
  flat: number | null
  limitUp: number | null
  limitDown: number | null
}

let distCache: DistSnapshot | null = null

const distEmpty = (reason: string, source: DistSnapshot['source'], extra: Partial<DistSnapshot> = {}): DistSnapshot => ({
  labels: DIST_LABELS,
  counts: null,
  blank: 0,
  scanned: 0,
  total: null,
  asOf: Date.now(),
  reason,
  source,
  coverage: null,
  partial: false,
  scannedBatches: 0,
  totalBatches: 0,
  warn: null,
  up: null,
  down: null,
  flat: null,
  limitUp: null,
  limitDown: null,
  ...extra,
})

/** 东财 clist 分页自统计（原有逻辑原样搬进来，只改回包形状） */
async function emDistribution(now: number): Promise<DistSnapshot> {
  const pcts: Array<number | null> = []
  let total: number | null = null
  let reason: string | null = null
  // 第 1 页必须先取：它给出 `total`，决定要扫多少页（"扫全"的判据也是它）
  try {
    const first = await em.fetchClistPctPage(1, BREADTH_PAGE_SIZE)
    total = first.total
    pcts.push(...first.rows)
  } catch (error) {
    reason = `第 1 页取数失败（${String(error).slice(0, 80)}）`
  }
  if (reason === null && total === null) {
    // 不知道总数就无法确认"扫全了没有" ⇒ 宁可报失败，也不给一个看起来正常的截面
    reason = '上游未给出总数（无法确认是否扫全）'
  }
  let scannedPages = reason === null ? 1 : 0
  let pageCount = 0
  if (reason === null && total !== null) {
    pageCount = Math.max(1, Math.ceil(total / BREADTH_PAGE_SIZE))
    if (pageCount > BREADTH_PAGES_MAX) {
      reason = `需要 ${pageCount} 页 > 上限 ${BREADTH_PAGES_MAX} 页（总数 ${total}）`
    } else {
      const queue = Array.from({ length: pageCount - 1 }, (_, i) => i + 2)
      const failures: string[] = []
      const workers = Array.from({ length: Math.min(DIST_CONCURRENCY, Math.max(1, queue.length)) }, async () => {
        for (;;) {
          if (failures.length > 0) return
          const pn = queue.shift()
          if (pn === undefined) return
          try {
            const page = await em.fetchClistPctPage(pn, BREADTH_PAGE_SIZE)
            if (page.rows.length === 0 && pn < pageCount) {
              failures.push(`第 ${pn} 页为空（上游限流或分页被截断）`)
            } else {
              pcts.push(...page.rows)
              scannedPages += 1
            }
          } catch (error) {
            failures.push(`第 ${pn} 页取数失败（${String(error).slice(0, 80)}）`)
          }
        }
      })
      await Promise.all(workers)
      if (failures.length > 0) reason = failures[0]
    }
  }
  const bins = distributionBinsOf(pcts)
  const full = reason === null && total !== null && pcts.length >= total
  return {
    labels: bins.labels,
    // 没扫全 ⇒ `counts: null`（**不拿扫到的那部分冒充全市场**；原因在 `reason`）
    counts: full ? bins.counts : null,
    blank: bins.blank,
    scanned: pcts.length - bins.blank,
    total,
    asOf: now,
    reason: full
      ? null
      : `${reason ?? `只扫到 ${pcts.length} 只 / 全市场 ${total ?? '未知'} 只（页数上限 ${BREADTH_PAGES_MAX}）`}⇒ 没有扫全，不给部分分布冒充全市场`,
    source: 'em-clist',
    coverage: total === null ? null : { codes: total, quoted: pcts.length, suspended: bins.blank },
    partial: !full,
    scannedBatches: scannedPages,
    totalBatches: pageCount,
    warn: bins.blank > 0 ? `${bins.blank} 只无涨跌幅（停牌等）未计入任何档` : null,
    // 只有扫全时才反推（半个截面反推出来的"上涨家数"是错的）；涨跌停无法从分档反推 ⇒ null
    up: full ? bins.counts.slice(0, 4).reduce((a, c) => a + c, 0) : null,
    down: full ? bins.counts.slice(5).reduce((a, c) => a + c, 0) : null,
    flat: full ? (bins.counts[4] ?? 0) : null,
    limitUp: null,
    limitDown: null,
  }
}

/** 腾讯聚合路径（东财失败后的兜底）：代码表 → 600/批 → 11 桶 → 9 档 */
async function tencentDistribution(now: number, emReason: string | null): Promise<DistSnapshot> {
  try {
    const agg = await tencentBreadthAggregate({
      fetchText: (host, url, opts) => fetchTextHost(host, url, opts),
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      now,
    })
    const warn: string[] = []
    if (emReason !== null) warn.push(`东财不可用（${emReason}），已切腾讯聚合`)
    if (agg.warn !== null) warn.push(agg.warn)
    return {
      labels: DIST_LABELS,
      counts: agg.counts,
      blank: agg.suspendedCount,
      scanned: agg.quoted - agg.suspendedCount,
      total: agg.codes,
      asOf: agg.asOf,
      reason: null,
      source: 'tencent-agg',
      coverage: { codes: agg.codes, quoted: agg.quoted, suspended: agg.suspendedCount },
      // 覆盖不足（少批/少报价）仍给分布，但要如实标 `partial` 并写 `warn`（不静默）
      partial: agg.failedBatches.length > 0 || agg.quoted < agg.codes,
      scannedBatches: agg.scannedBatches,
      totalBatches: agg.totalBatches,
      warn: warn.length > 0 ? warn.join('；') : null,
      up: agg.up,
      down: agg.down,
      flat: agg.flat,
      limitUp: agg.limitUp,
      limitDown: agg.limitDown,
    }
  } catch (error) {
    return distEmpty(
      `腾讯聚合失败（${String(error).slice(0, 80)}）${emReason === null ? '' : `；东财：${emReason}`}`,
      null,
      { asOf: now },
    )
  }
}

/** 两级：东财优先 → 失败切腾讯聚合（都失败 ⇒ `counts:null` + 两句原因） */
async function distributionSnapshot(now = Date.now()): Promise<DistSnapshot> {
  if (distCache !== null && now - distCache.asOf < DIST_TTL_MS) return distCache
  const emSnap = await emDistribution(now)
  distCache = emSnap.counts === null ? await tencentDistribution(now, emSnap.reason) : emSnap
  return distCache
}

const MAX_BODY = 256 * 1024
const MAX_QUOTE_IDS = 160

export interface TradeRoutes {
  routes: PluginWebRoute[]
  store: DataStore
}

function send(res: ServerResponse, code: number, payload: unknown, extraHeaders: Record<string, string> = {}): void {
  const body = JSON.stringify(payload)
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    ...extraHeaders,
  })
  res.end(body)
}

function queryOf(req: IncomingMessage): URLSearchParams {
  const url = new URL(req.url ?? '/', 'http://localhost')
  return url.searchParams
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  // Content-Type 断言：写接口只接受 application/json。
  // 这条不是装饰 —— 浏览器对 `<form>` 只能发出 urlencoded/text/plain/multipart，
  // 因此"必须带 application/json"把跨站表单这一整类请求挡在了路由之外
  // （与 Origin/sec-fetch-site 围栏互补；此前 README 声称有这条断言但代码里并没有）。
  const contentType = String(req.headers['content-type'] ?? '')
  if (!contentType.toLowerCase().startsWith('application/json')) {
    throw new HttpError(`Content-Type 必须是 application/json（收到 ${contentType === '' ? '空' : contentType}）`, 415)
  }
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const b = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += b.length
    if (size > MAX_BODY) throw new HttpError(`请求体过大（上限 ${MAX_BODY} 字节）`, 413)
    chunks.push(b)
  }
  if (size === 0) return {}
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new HttpError('请求体不是合法 JSON', 400)
  }
}

/**
 * 解析 `ids=` 查询参数。
 *
 * **保留原始大小写**：`113.rbm` / `114.lhm` 这类商品后缀区分大小写，改写成大写会让
 * 上游请求与备用源（腾讯/新浪）映射双双落空（em.ts 曾因此把 4 个期货整批丢掉；
 * 而路由层此前一直在重新引入这个 bug）。去重按大小写无关键，保留首次出现的写法。
 * 超出上限时**如实回报**（截断不再静默）。
 */
function splitIds(raw: string | null): { ids: string[]; requested: number; truncated: boolean } {
  if (raw === null) return { ids: [], requested: 0, truncated: false }
  const seen = new Set<string>()
  const ids: string[] = []
  let requested = 0
  for (const piece of raw.split(',')) {
    const id = piece.trim()
    if (id === '' || !SECID_RE.test(id)) continue
    requested += 1
    const key = id.toUpperCase()
    if (seen.has(key) || ids.length >= MAX_QUOTE_IDS) continue
    seen.add(key)
    ids.push(id)
  }
  return { ids, requested, truncated: requested > ids.length }
}

/** Full portfolio view with quotes resolved through the quote cache. */
async function portfolioWithQuotes(store: DataStore): Promise<{ view: unknown; stale: number }> {
  const port = store.portData()
  const secids = [...new Set(port.items.map((p) => p.secid))]
  const quotes: Record<string, QuoteRow> = secids.length > 0 ? await em.fetchQuotes(secids) : {}
 // 折算口径来自偏好（缺省 none = 只含 A股 + 逐项说明）
  const prefs = store.getPrefs()
  const { view, stale } = assemblePortfolio(port.groups, port.items, store.ledgerEntries(), quotes, {
    mode: prefs.fxMode ?? 'none',
    rates: prefs.fxRates ?? {},
  })
  return { view, stale }
}

/**
 * 自选 + 持仓标的 → 6 位代码（仅 A股，供财报/分红数据源过滤）。
 * `heldOnly` 为真时只取持仓（P1-10 的勾稽要区分"有持仓"与"仅自选"）。
 */
function focusCodes(store: DataStore, heldOnly = false): string[] {
  const codes = new Set<string>()
  const push = (secid: string): void => {
    const m = /^(\d{1,3})\.([A-Za-z0-9]+)$/.exec(secid)
    if (m === null) return
    if (m[1] === '0' || m[1] === '1') codes.add(m[2])
  }
  if (!heldOnly) for (const it of store.watchData().items) push(it.secid)
  for (const it of store.portData().items) push(it.secid)
  return [...codes]
}

/**
 * 持仓的公司行为提示（P2-4）：从**已同步**的日历事件里取 `div:` 类（分红除权除息），
 * 与持仓标的按 6 位代码对上。不新增数据源、不自动改账。
 */
async function corporateActionsFor(
  store: DataStore,
  calendar: CalendarStore,
  windowDays = 30,
): Promise<CorporateAction[]> {
  await calendar.init()
  const today = dayOf(Date.now())
  const events = calendar.list(calToday(-3), calToday(windowDays))
  const port = store.portData()
  const byCode = new Map<string, { posId: string; name: string; secid: string }>()
  for (const p of port.items) {
    const m = /^(\d{1,3})\.(\d{6})$/.exec(p.secid)
    if (m !== null) byCode.set(m[2], { posId: p.id, name: p.name, secid: p.secid })
  }
  const out: CorporateAction[] = []
  for (const e of events) {
    if (e.category !== 'dividend') continue
    const code = symbolCode(e.symbol)
    if (code === null) continue
    const hit = byCode.get(code)
    if (hit === undefined) continue
    const kind: CorporateAction['kind'] = (e.autoKey ?? '').includes(':ex:') ? 'ex' : 'record'
    const daysUntil = Math.round((Date.parse(`${e.date}T00:00:00+08:00`) - Date.parse(`${today}T00:00:00+08:00`)) / 86_400_000)
    out.push({ ...hit, date: e.date, kind, note: e.note ?? '', daysUntil })
  }
  return out.sort((a, b) => a.date.localeCompare(b.date))
}

/** 事件关联标的 → 6 位代码（symbol 可能是代码或 secid） */
function symbolCode(symbol: string | undefined): string | null {
  if (symbol === undefined || symbol === '') return null
  const m = /(\d{6})/.exec(symbol)
  return m === null ? null : m[1]
}

export function makeTradeRoutes(
  store: DataStore,
  trustedHosts: readonly string[],
  calendar: CalendarStore,
  rescue?: RescueMonitor,
  breadth: BreadthStore = new BreadthStore(),
  /** 涨跌家数自统计（源 B）的结果缓存：一轮快照内不重复打上游 */
  breadthCountCache: BreadthCountCache = new BreadthCountCache(),
  /**
   * 当前活跃行（多行子组件用）。**由 core 行注入 ⇒ 端点永远可用**（不依赖任何功能行），
   * 客户端据此 gate tab；不传时返回 `['core']`（老 profile 的等价形态）。
   */
  activeRows: () => string[] = () => ['core'],
  /**
   * 复盘笔记存储（第 8 行 `fupan` 独占）。
   *
   * 缺省自建一个（老调用点/单测不传也照常工作 —— 它没有任何后台定时器）；
   * 生产路径由 core 行传入**内核里的那一个实例**（`CoreKernel.fupan`），避免每行各建一个。
   */
  fupan: FupanStore = new FupanStore(),
  /**
   * 杠杆温度计（两融杠杆热度；`/tradewatcher/leverage`）。
   *
   * 缺省自建一个（老调用点/单测不传也照常工作）：它**没有后台定时器**，首次历史回填是
   * 请求触发的后台 Promise（`startBackfill`）。取数一天最多一次（`needsDailyFetch`），
   * 与面板现有的两融读取（`marketExtras.marginCross`）是两条独立路径，互不缓存。
   */
  leverage: LeverageService = new LeverageService(),
  /** 棱镜（第 9 行）的依赖；不传 ⇒ 不注册棱镜路由（老调用点/单测照常） */
  prism?: { store: import('./prismStore.ts').PrismStore; trading: import('./prismAccount.ts').PrismTradingStore; data: DataStore; get: (name: string) => unknown },
): TradeRoutes {
  const gate = (req: IncomingMessage): boolean => isTrustedApiRequest(req, trustedHosts)
  /** 上游主机组：503 时用它给出 retry-after，并聚合展示熔断明细（去重后 3 台） */
  const upstreamHosts = [...new Set([...QUOTE_HOSTS, ...HISTORY_HOSTS])]
  /**
   * 「上游健康」面板要看的**全部**主机：东财那组 + 腾讯 K 线的三台同源主机。
   *
   * 为什么单独一组：K 线可以在 `web.ifzq.gtimg.cn` 被 WAF 挡成 501 时由 `ifzq.gtimg.cn`
   * 接住（`fetchTencentAppstock`）—— 那台是 **degraded（降级）**，链路本身有数据。
   * 只有把它们放进面板，用户才看得到"哪台不行、谁接住了"，而不是一句"上游不可用"。
   */
  const healthHosts = [...new Set([...upstreamHosts, ...TENCENT_KLINE_HOSTS.map((h) => h.host)])]
  /**
   * 兜底错误出口。
   *
   * P0（AUDIT-IMPL70 §1）：**逐标的路由不该走到这里**。走到这里说明这条路由没有部分结果
   * （板块榜单/搜索这类聚合接口），或者代码里还有把上游异常直接抛出来的路径。
   * 消息里必须带「哪个上游 × 哪个范围」（`TotalUpstreamError` 已经强制），否则界面上
   * 只剩一句"不可用"，用户不知道该等谁、等到什么时候。
   */
  const fail = (res: ServerResponse, error: unknown, scope?: string): void => {
    const message = error instanceof Error ? error.message : String(error)
    const status = httpStatusOf(error)
    log(`route error (${status}):`, message)
    // 503 带上建议重试时刻：熔断中最早恢复的那台到点即可重试
    const retry = retryAfterSecondsOf(error, breakerSummary(upstreamHosts).minutesLeft)
    const payload: Record<string, unknown> = { error: message }
    // 让界面/agent 一次看到"哪些上游现在不行"，而不是只有一个状态码
    if (status >= 500) {
      const health = upstreamHealth(upstreamHosts)
      payload.upstream = { line: health.line, hosts: health.hosts }
      if (scope !== undefined) payload.scope = scope
    }
    send(res, status, payload, retry === null ? {} : { 'retry-after': String(retry) })
  }
  /**
   * 多标的路由统一收口（P0）：**部分成功一律 200**。
   *
   * 为什么单独一个函数而不是各路由各写一遍：这条判据（"哪些标的没取到、为什么"）
   * 一旦在某条路由上漏写，界面就会退回"整块报错"，而用户看不出到底是哪一只。
   * 收口后：`partial` 给出请求/成功/失败计数，`missing[]` 给出逐标原因。
   */
  const replyBatch = <T extends Record<string, unknown>>(
    res: ServerResponse,
    body: T,
    outcome: PartialOutcome,
    missing: MissingField[],
  ): void => {
    send(res, 200, { ...body, partial: outcome, ...(missing.length === 0 ? {} : { missing }) })
  }
  const needGate = (req: IncomingMessage, res: ServerResponse): boolean => {
    if (gate(req)) return true
    send(res, 403, { error: 'forbidden' })
    return false
  }

  /**
   * 日历同步状态 → 回包字段（GET / POST 共用一份，避免两处口径分叉）。
 * `syncedAt` 只认最近一次**成功**同步（从未成功为 null），失败与否由 `stale`/`missing` 说明。
   */
  const calendarStatusPayload = (): {
    syncedAt: number | null
    syncAttemptAt: number | null
    stale: boolean
    syncSources: CalSyncSourceResult[]
    missing: MissingField[]
  } => {
    const s = calendar.syncStatus()
    return { syncedAt: s.syncedAt, syncAttemptAt: s.attemptAt, stale: s.stale, syncSources: s.sources, missing: s.missing }
  }

  const routes: PluginWebRoute[] = [
    {
      kind: 'exact',
      path: '/tradewatcher/health',
      handler: (req, res) => {
        if (!needGate(req, res)) return
        send(res, 200, {
          ok: true,
          name: 'dsh-tradewatcher',
          time: Date.now(),
          breaker: breakerSummary(upstreamHosts),
          /**
           * 「上一次上游健康摘要」（AUDIT-IMPL70 §5）：按主机给出最后一次成功/失败时刻、
           * 连续失败次数、是否熔断，外加一行可直接显示/写日志的 `line`。
           *
           * **零新增上游请求**：全部来自 `withHostBreaker` 与 `em.fetchAny` 已有的记账，
           * 这里只是把内存状态读出来。它不复位、不探活 —— 探活会变成"看一眼就多一次请求"。
           */
          upstream: upstreamHealth(healthHosts),
        })
      },
    },
    {
      // 筹码分布（45 日 / 换手率衰减 / P5-P95）。纯内存计算，不发新的上游请求：
      // 日线走 `em.fetchKline(secid, 101, 45, 1)`（前复权），流通市值走**同一次行情缓存**。
      kind: 'exact',
      path: '/tradewatcher/chips',
      handler: async (req, res) => {
        if (!needGate(req, res)) return
        try {
          const q = queryOf(req)
          const secid = String(q.get('secid') ?? '').trim()
          if (!SECID_RE.test(secid)) {
            send(res, 400, { error: 'secid 不合法（如 1.600519）' })
            return
          }
          // days = **累积窗口**（默认 180）；display = 展示窗口（默认 45、上限 60）。
          // 老调用只传 days=45 ⇒ 累积 45、展示 min(45, 45) ⇒ 与旧行为一致（回包多给 displayWindow，结构不破坏）
          const wantDays = Number(q.get('days') ?? CHIPS_WINDOW)
          const cum = Number.isFinite(wantDays) ? Math.min(CHIPS_WINDOW_MAX, Math.max(CHIPS_MIN_SAMPLES, Math.round(wantDays))) : CHIPS_WINDOW
          const wantDisplay = Number(q.get('display') ?? Math.min(CHIPS_DISPLAY, cum))
          const disp = Number.isFinite(wantDisplay) ? Math.min(CHIPS_DISPLAY_MAX, Math.max(1, Math.round(wantDisplay))) : CHIPS_DISPLAY
          const supported = em.fqSupported(secid)
          const k = supported ? await em.fetchKline(secid, 101, cum, 1) : null
          // 价格空间换算因子：**同一天**的 fqt=1 与 fqt=0 收盘价之比（日期不等 ⇒ 不换算，如实标注）
          const kRaw = supported ? await em.fetchKline(secid, 101, 5, 0) : null
          const lastFq1 = k?.days?.[k.days.length - 1] ?? null
          const rawDay = kRaw?.days?.find((d) => d.date === lastFq1?.date) ?? null
          const priceScale = lastFq1 !== null && rawDay !== null && rawDay.close > 0 ? lastFq1.close / rawDay.close : 1
          const qp = await em.fetchQuotesWithProvenance([secid])
          const qprovenance = qp.provenance
          const quote = qp.items[secid] ?? null
          const quotePrice = typeof quote?.price === 'number' && Number.isFinite(quote.price) && quote.price > 0 ? quote.price : null
          // 报价缺失 ⇒ 回落"最新前复权收盘价"（priceSource=close，如实标注）；两者都没有 ⇒ 现价不可得
          const priceForRatio = quotePrice ?? (lastFq1 !== null ? lastFq1.close / (priceScale || 1) : null)
          const priceSourceForRatio: 'quote' | 'close' = quotePrice !== null ? 'quote' : 'close'
          const bars = (k?.days ?? []).map((d) => ({ date: d.date, close: d.close, vol: d.vol }))
          /**
           * **绝对**量纲校正（读侧最后一道闸）：`fetchKline` 的段内归一只能保证"自己一致"，
           * 保证不了"自己是手"。同日报价（`amount ÷ (vol×100) ≈ price` 自洽，手口径）是外部参照。
           *
           * ⚠ REVIEW-7 D1 修复：参照日**必须来自报价自己的交易日**，不能取日线自己最后一根的日期。
           * 旧写法 `date: lastFq1.date` 让 `alignVolUnitWithQuote` 里的
           * `bars.findIndex(b => b.date === ref.date)` **必然命中最后一根** —— "必须同一天"这条前提
           * 退化成恒真式，代码里从来没有检查过报价的成交量属于哪一天。
           * 真实命中场景：东财限流 ⇒ `fetchKline` 返回**昨天**的旧 bar（`stale:true`），
           * 而报价是**今天开盘几分钟**的量，两者本来就不该比（实测比值 60×，
           * 旧实现照样 ×0.01 ⇒ 筹码换手率整体小 100 倍、`avgCost 9.9511 → 10.0675`）。
           *
           * 现在：报价时刻 → 该市场的日历日（A股/港股都是北京日），与日线最后一根不一致
           * ⇒ **不做量纲判定**（`unitRef = null`）。判不了就不改数，这比改错强。
           */
          const quoteDay = typeof quote?.time === 'number' && Number.isFinite(quote.time) && quote.time > 0
            ? dayOf(quote.time)
            : null
          const unitRef = quote !== null && lastFq1 !== null && quoteDay !== null && typeof quote.vol === 'number' && quote.vol > 0
            ? { date: quoteDay, vol: quote.vol }
            : null
          const unitGuard = unitRef === null
            ? { bars, dropped: 0, reason: null as string | null }
            : alignVolUnitWithQuote(bars, unitRef)
          const unitNote = [k?.unitNote ?? null, unitGuard.reason].filter((x): x is string => typeof x === 'string' && x !== '').join('；') || null
          // 口径来自 prefs（老 profile 缺键 ⇒ 默认 k=1.5 / triangle，由 store 的装载归一保证）
          const prefs = store.getPrefs()
          const series = chipSeriesOf(unitGuard.bars, {
            fqSupported: supported,
            isHk: secid.startsWith('116.'),
            floatMv: quote?.floatMv ?? null,
            price: priceForRatio,
            priceSource: priceSourceForRatio,
            priceScale: quotePrice !== null ? priceScale : 1,
            window: cum,
            display: disp,
            decay: prefs.chipsDecay,
            spread: prefs.chipsSpread,
          })
          const missing: Array<{ what: string; why: string; note: string }> = []
          if (series.why !== null) missing.push({ what: secid, why: 'no-source', note: series.why })
          if (series.decayReason !== null) missing.push({ what: `${secid} 衰减口径`, why: 'no-source', note: series.decayReason })
          // 量纲归一必须**可见**（用户看得到"这份数据被改过量纲"），不许静默
          if (unitNote !== null) missing.push({ what: `${secid} 成交量量纲`, why: 'no-source', note: unitNote })
          send(res, 200, {
            secid,
            // 出处沿用既有读契约：stale = 日线走缓存 或 行情降级；source 说清用了哪两处数据
            asOf: k === null ? null : Date.now(),
            stale: k?.stale === true || qprovenance.stale === true,
            source: 'em-kline+quote',
            // 最后一根 bar 的元信息：partial=true 说明是盘中未完成 bar（数值会变，不可当最终值）。
            // ⚠ 下面 `...series` 的 `lastBar` 会**覆盖**这一行（两者同源同形，见 AUDIT-IMPL74 §2）：
            //    这里先写是为了"回包字段顺序/形状"稳定，实际生效的是 `chipSeriesOf` 产出的那份。
            lastBar: em.lastBarOfKline(secid, 101, 1),
            ...series,
            // 量纲归一的如实标注（null = 没动过）；客户端把它并进"口径偏离"那一行
            unitNote,
            missing,
          })
        } catch (error) {
          fail(res, error)
        }
      },
    },
    {
      // 活跃行清单（core 持有，永远可用）：客户端用它 gate tab ——
      // 被停用的行连 tab 一起消失；**端点不可达时客户端失败放行**（全部照常渲染）。
      kind: 'exact',
      path: '/tradewatcher/rows',
      handler: (req, res) => {
        if (!needGate(req, res)) return
        const rows = activeRows()
        send(res, 200, { rows, asOf: Date.now() })
      },
    },
    {
      /**
       * 工具箱 → 工具①「五市场蛋糕」的数据（全球五市场宽基 ETF 规模权重）。
       *
       * 归属：**只被工具箱页消费** ⇒ 按 §2.2 的判据（单一消费方 ⇒ 该行）归 `tools` 行
       * （`src/index.ts` 的 `ROW_ROUTES.tools`），关掉工具箱行时这条路由随之 404。
       *
       * `?source=snapshot` = **只读本地快照、不发任何上游请求**（30 日手动回放走它；
       * 断言"回放零上游"也用它）。默认 `auto` = 三层 TTL + 在飞合并的现取模式。
       * 口径与来源全部写在 `globalFlow.ts` 文件头（份额/动量/汇率/重建/快照）。
       */
      kind: 'exact',
      path: '/tradewatcher/tools/global-flow',
      handler: async (req, res) => {
        if (!needGate(req, res)) return
        try {
          const q = queryOf(req)
          const raw = String(q.get('source') ?? 'auto').trim().toLowerCase()
          if (raw !== 'auto' && raw !== 'snapshot') {
            send(res, 400, { error: 'source 只接受 auto（默认，现取）或 snapshot（只读本地快照，零上游请求）' })
            return
          }
          send(res, 200, await globalFlowPayload({ source: raw === 'snapshot' ? 'snapshot' : 'auto' }))
        } catch (error) {
          fail(res, error)
        }
      },
    },
    {
      kind: 'exact',
      path: '/tradewatcher/backup',
      /**
       * 导出（GET）/ 导入（POST，P0-9）。
       *
       * POST body：`{ mode: 'preview' | 'apply', bundle }`
       *   - `preview` 只校验 + 给出冲突预览（不写任何文件）；
       *   - `apply` 校验通过才覆盖，且覆盖前由 store 写 `.bak`。
       * 校验不通过一律 400 并**逐条**给出原因（校验逻辑在 backup.ts，纯函数、可单测）。
       */
      handler: async (req, res) => {
        if (!needGate(req, res)) return
        try {
          await store.init()
          if (req.method === 'GET') {
            const raw = await store.exportFiles()
            if (raw.unreadable.includes('ledger.json')) {
              // 账本读不出来时导出会是"一份没有流水的持仓"，比不导出更危险
              throw new HttpError('ledger.json 无法解析，导出会缺少全部流水；请先修复或从 .corrupt-* 备份恢复', 400)
            }
            const bundle = makeBundle(
              {
                watch: raw.watch ?? { v: 1, groups: [], items: [] },
                positions: raw.positions ?? { v: 1, groups: [], items: [] },
                ledger: raw.ledger ?? { v: 1, entries: [] },
                prefs: (raw.prefs ?? {}) as Record<string, unknown>,
              } as Parameters<typeof makeBundle>[0],
              `dsh-tradewatcher/${__TW_VERSION__}`,
            )
            send(res, 200, { ok: true, bundle, unreadable: raw.unreadable })
            return
          }
          if (req.method === 'POST') {
            const body = (await readBody(req)) as { mode?: unknown; bundle?: unknown }
            const mode = body.mode === 'apply' ? 'apply' : 'preview'
            const check = verifyBundle(body.bundle)
            const port = store.portData()
            const current = {
              watchGroups: store.watchData().groups.length,
              watchItems: store.watchData().items.length,
              portGroups: port.groups.length,
              portItems: port.items.length,
              ledgerEntries: store.ledgerEntries().length,
              ledgerTo: store.ledgerEntries().reduce<number | null>((a, e) => (a === null || e.ts > a ? e.ts : a), null),
            }
            if (!check.ok || check.files === null) {
              send(res, 400, { ok: false, mode, errors: check.errors, summary: check.summary, conflicts: [] })
              return
            }
            const conflicts = describeConflicts(check, current)
            if (mode === 'preview') {
              send(res, 200, { ok: true, mode, errors: [], summary: check.summary, conflicts, current })
              return
            }
            const { backedUp } = await store.importFiles(check.files)
            send(res, 200, { ok: true, mode, errors: [], summary: check.summary, conflicts, current, backedUp })
            return
          }
          send(res, 405, { error: 'method not allowed' })
        } catch (error) {
          fail(res, error)
        }
      },
    },
    {
      kind: 'exact',
      path: '/tradewatcher/breadth',
      /**
       * 涨跌家数 + 历史分位（P1-8）。
       *
       * 数据源与「大盘」页**同一处**：上证指数（1.000001）与深证成指（0.399001）行情里的
       * 涨/跌/平家数与成交额（东财 f104/f105/f106/f6）。不另开一条链路 ——
       * 两处各算一套，迟早会对不上。
       *
       * 收盘后（15:05 起）会把当日快照写入 breadth.json；分位按"之前 N 个交易日"算（不含今天）。
       */
      handler: async (req, res) => {
        if (!needGate(req, res)) return
        try {
          await breadth.init()
          const wantDist = queryOf(req).get('dist') === '1'
          const ids = ['1.000001', '0.399001']
          // emFields：涨跌家数（f104/f105/f106）**只有东财给** ⇒ 这条链路允许东财先行
          // （AUDIT-IMPL70 P1：行情链已把东财降为兜底，不声明就拿不到家数）
          const q = await em.fetchQuotesWithProvenance(ids, { emFields: true })
          const sh = q.items['1.000001']
          const sz = q.items['0.399001']
          const usable = breadthUsable([sh?.up, sh?.down, sh?.even, sz?.up, sz?.down, sz?.even])
          const today = dayOf(Date.now())
          const amount = usable ? (sh?.amount ?? 0) + (sz?.amount ?? 0) : null
          // 家数走**多源链**（按成本从低到高，命中即止）：
          //   源 A：指数行情 f104/f105/f106（最便宜）→ 源 B：东财 clist 分页自统计
          // 自统计的结果带 source 与**统计完成时刻**（asOf 不复用行情时刻），并附自检结论
          const resolved = await resolveBreadthCount({
            fromIndexQuote: usable
              ? { up: (sh?.up ?? 0) + (sz?.up ?? 0), down: (sh?.down ?? 0) + (sz?.down ?? 0), even: (sh?.even ?? 0) + (sz?.even ?? 0) }
              : null,
            indexAsOf: q.provenance.asOf,
            deps: { clistPage: em.fetchClistPctPage },
            cache: breadthCountCache,
          })
          const current = resolved.counts === null
            ? null
            : {
                up: resolved.counts.up,
                down: resolved.counts.down,
                even: resolved.counts.even,
                amount: amount ?? 0,
                source: resolved.source,
                checks: resolved.checks,
              }
          // 只有拿到真实数字才记；记不进去（盘中/周末/已定稿）不是错误。
          // 家数可能是**自统计**的，而成交额仍只有指数行情里有 —— 成交额缺失（行情走备用源）时
          // 不记账：把 0 当成交额记进每日快照会污染分位的历史口径（不许把缺失写成 0）。
          const stored = current === null || amount === null ? false : await breadth.record(Date.now(), current)
          /**
           * 搭车（v0.18.0）：把刚算出来的家数记进护盘监视器（**纯内存，不发任何请求、不写文件**），
           * 供信号事件写"触发瞬间的家数"用；缓存过期/没读过 ⇒ 事件那边记 null + 原因。
           */
          if (current !== null && rescue !== undefined) {
            rescue.noteBreadthMoment({
              up: current.up, down: current.down, even: current.even,
              amount: amount ?? null, asOf: Date.now(),
              source: current.source === 'em-index' ? '东财指数行情（f104/f105/f106）' : '东财 clist 自统计',
            })
          }
          const ratio = current === null ? null : upRatio(current)
          const pct = percentileOf(ratio, breadth.history(BREADTH_WINDOW, today))
          // 【涨跌分布】直方图（可选）：与涨跌家数**同一处上游**（东财 clist 的 f3 涨跌幅），
          // 只是要多扫几页（每页 100 只、上限 BREADTH_PAGES）。扫不动/覆盖不足 ⇒ null + 原因，
          // **绝不**用已扫到的那部分冒充全市场（那是编数）。
          const dist = wantDist ? await distributionSnapshot() : null
          // 昨日两市成交额：本地 breadth.json 的**前一交易日快照**（没有那份快照 ⇒ null，不猜）
          const prev = breadth.history(BREADTH_WINDOW, today).slice(-1)[0] ?? null
          send(res, 200, {
            methodology: BREADTH_METHODOLOGY,
            current: current === null
              ? null
              : {
                  ...current,
                  ratio,
                  // 数字时刻：源 A = 行情时刻；自统计 = **统计完成时刻**（两者语义不同，不许混）
                  asOf: resolved.asOf,
                  caliber: resolved.source === 'em-index' ? null : BREADTH_COUNT_CALIBER,
                },
            percentile: pct,
            // 窗口与最小样本一起给界面：缺了它，"没有分位"会被读成"分位是 0"
            window: BREADTH_WINDOW,
            minDays: BREADTH_MIN_DAYS,
            storedDays: breadth.days,
            storedThisCall: stored,
            // 昨日成交（本地快照；口径：上一交易日收盘定稿那次记录，见 `breadth.json`）
            prevAmount: prev === null ? null : { day: prev.day, amount: prev.amount, final: prev.final },
            ...(wantDist ? { distribution: dist } : {}),
            // 数据不可用时如实说明：涨跌家数在部分行情源下没有（备用源不含 f104/f105/f106）
            missing: [
              ...(current !== null ? q.provenance.missing : []),
              ...(wantDist && (dist === null || dist.counts === null)
                ? [{
                    what: '涨跌分布',
                    why: 'transient' as const,
                    note: dist?.reason ?? '本轮没有扫描到全市场的涨跌幅分页（60 页上限），不给部分分布冒充全市场',
                  }]
                : []),
              ...(current !== null ? [] : [{
                  what: '沪深涨跌家数',
                  why: 'transient' as const,
                  note: resolved.reason ?? '本轮既没有拿到指数行情的涨/跌/平家数，自统计也没成功',
                }]),
            ],
          })
        } catch (error) {
          fail(res, error)
        }
      },
    },
    {
      // 大盘页的**附加行情**（v0.81.2）：涨停/跌停家数、两融（双源交叉）、全天成交额预测。
      // 全部是**只读镜像**：直接调 `marketExtras.ts` 的导出（不在此复刻任何宿主逻辑）。
      //   · 成交额：由调用方把"自己已经显示的那个数"带过来（`?amount=`）——这里**不再抓一遍**，
      //     避免复制 `/breadth` 的取数口径；非正数/缺省一律按"没取到"处理（**不当 0**）。
      //   · 日期：`day=YYYY-MM-DD`（两融，缺省用北京自然日）；`date=YYYYMMDD`（涨停池，缺省今天）。
      //   · 缺数据一律 null + 原因（在各段的 `missing[]` 里），与 quoteProvenance 同一口径。
      kind: 'exact',
      path: '/tradewatcher/market-extras',
      handler: async (req, res) => {
        if (!needGate(req, res)) return
        try {
          const p = queryOf(req)
          const day = String(p.get('day') ?? '').trim()
          const date = String(p.get('date') ?? '').trim()
          if (day !== '' && !/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new HttpError('day 非法（要 YYYY-MM-DD）', 400)
          if (date !== '' && !/^\d{8}$/.test(date)) throw new HttpError('date 非法（要 YYYYMMDD）', 400)
          const rawAmount = Number(p.get('amount'))
          const current = Number.isFinite(rawAmount) && rawAmount > 0 ? rawAmount : null
          const [limits, margin, forecast] = await Promise.all([
            extras.limitCounts(date === '' ? undefined : date),
            extras.marginCross(day === '' ? dayOf(Date.now()) : day),
            extras.amountForecast(current),
          ])
          send(res, 200, { limits, margin, forecast, asOf: Date.now() })
        } catch (error) {
          fail(res, error)
        }
      },
    },
    {
      /**
       * 杠杆温度计（`GET /tradewatcher/leverage?range=250|750|all`，默认 750）。
       *
       * **契约（已冻结，客户端按同一份编码）**：这条路由**永远 200**，缺数据一律 `null`：
       *   · 整块不可用（上游挂掉/本地没有历史）⇒ 200 + 全 `null` 的空壳，**不是 5xx、不是 {}**；
       *   · `range` 非法 ⇒ 回落默认 750（不 400）——它是画图参数，不是用户输入错误。
       * 温度 = `RZYEZB`（融资余额÷流通市值）在**全历史**里的百分位；样本 < 250 ⇒ `null`（不给 0）。
       * 取数一天最多一次、历史回填在后台跑（细节见 `src/host/leverage.ts` 文件头）。
       * 唯一非 200 的来源是既有围栏（`needGate`）：那不是数据路径，是全站一致的鉴权行为。
       */
      kind: 'exact',
      path: '/tradewatcher/leverage',
      handler: async (req, res) => {
        if (!needGate(req, res)) return
        const range = parseLeverageRange(queryOf(req).get('range'))
        try {
          send(res, 200, await leverage.payload(range))
        } catch (error) {
          // 契约兜底：连 service 自己的兜底都失败了，也要给形状完整的空回包（客户端不必判 5xx）
          log(`leverage route fallback: ${error instanceof Error ? error.message : String(error)}`)
          send(res, 200, emptyLeveragePayload(range))
        }
      },
    },
    {
      kind: 'exact',
      path: '/tradewatcher/anomaly',
      /**
       * 自选异动（P1-4）：`ids=` 逗号分隔。
       * 只用 K 线本地缓存 + 行情涨跌幅，不额外打上游（除非缓存过期需要增量更新）。
       * 判定规则与阈值在 `host/anomaly.ts`，那里同时给出**为什么不判定**（样本不足/非交易时段）——
       * 与"判定过且无异常"严格区分，界面不能把前者显示成"正常"。
       */
      handler: async (req, res) => {
        if (!needGate(req, res)) return
        try {
          const { ids } = splitIds(queryOf(req).get('ids'))
          if (ids.length === 0) {
            send(res, 200, { rows: [], asOf: Date.now(), missing: [] })
            return
          }
          const q = await em.fetchQuotesWithProvenance(ids)
          const items = ids.map((secid) => ({ secid, name: q.items[secid]?.name ?? secid }))
          const result = await detectAnomalies(items, q.items)
          send(res, 200, { ...result, source: q.provenance.source, stale: q.provenance.stale })
        } catch (error) {
          fail(res, error)
        }
      },
    },
    {
      kind: 'exact',
      path: '/tradewatcher/tones',
      /**
       * 五档状态 badge：`ids=` 逗号分隔（上限 `TONE_MAX_IDS`）。**每日一个**（按日 memo），
       * 复用 `em.fetchKline` 的磁盘缓存；取不到/样本不足一律 `level: null` + 原因，
       * **绝不用「适中」冒充缺失**（见 `host/tones.ts` 的注释）。
       */
      handler: async (req, res) => {
        if (!needGate(req, res)) return
        try {
          const { ids: all, requested, truncated } = splitIds(queryOf(req).get('ids'))
          const ids = all.slice(0, TONE_MAX_IDS)
          if (ids.length === 0) {
            send(res, 200, { asOf: null, stale: false, source: 'none', rows: [], missing: [], requested, truncated: false, limit: TONE_MAX_IDS })
            return
          }
          const items = ids.map((secid) => ({ secid, kind: stripKindOf(secid) }))
          const { rows, missing, day, methodology } = await computeTones(items)
          send(res, 200, {
            asOf: Date.now(),
            stale: false,
            source: 'em-kline',
            day,
            methodology,
            missing,
            rows,
            requested,
            truncated: truncated || all.length > ids.length,
            limit: TONE_MAX_IDS,
          })
        } catch (error) {
          send(res, 200, { asOf: null, stale: false, source: 'none', rows: [], missing: [{ what: '五档状态', why: 'transient', note: String(error).slice(0, 120) }], requested: 0, truncated: false, limit: TONE_MAX_IDS })
        }
      },
    },
    {
      kind: 'exact',
      path: '/tradewatcher/ytd',
      /**
       * 年初至今（YTD）：`ids=` 逗号分隔（上限 `YTD_MAX_IDS`，超出如实回报 truncated）。
       *
       * 口径写死在 `shared/model.ts` 的 `YTD_CALIBER`：
       *   YTD = (现价 − 本年内第一个交易日收盘价) ÷ 该收盘价 × 100%，前复权序列。
       *
       * 现价来自与其它面板**同一次**行情（`fetchQuotesWithProvenance` 的 TTL 缓存 + 逐标的槽），
       * 基准走 `host/ytd.ts` 的按日 memo + `em.fetchKline` 的磁盘缓存/增量/单飞 ——
       * 因此这个路由**不会每个轮询周期重算**，休市定稿时更是零回源。
       */
      handler: async (req, res) => {
        if (!needGate(req, res)) return
        try {
          const { ids: all, requested, truncated } = splitIds(queryOf(req).get('ids'))
          const ids = all.slice(0, YTD_MAX_IDS)
          if (ids.length === 0) {
            send(res, 200, { asOf: null, stale: false, source: 'none', rows: [], missing: [], requested, truncated: false, limit: YTD_MAX_IDS })
            return
          }
          const q = await em.fetchQuotesWithProvenance(ids)
          const items = ids.map((secid) => ({
            secid,
            name: q.items[secid]?.name ?? secid,
            price: q.items[secid]?.price ?? null,
          }))
          const { rows, missing, methodology } = await computeYtds(items)
          send(res, 200, {
            asOf: q.provenance.asOf,
            stale: q.provenance.stale,
            source: q.provenance.source,
            missing,
            methodology,
            rows,
            requested,
            truncated: truncated || all.length > ids.length,
            limit: YTD_MAX_IDS,
          })
        } catch (error) {
          fail(res, error)
        }
      },
    },
    {
      kind: 'exact',
      path: '/tradewatcher/badge',
      /**
       * 侧栏徽标数据（P0-3）。
       *
       * 关键约束：**不发起新的采样**。护盘等级直接取 `rescue.snapshot()`（内存里的最近一次
       * 成功采样，必要时才用当日复盘兜底），持仓当日盈亏走行情 TTL 缓存。徽标是常驻的，
       * 如果它自己去打一遍上游，就等于把"看一眼侧栏"变成一次真实的取数压力。
       *
       * 徽标与面板顶部数字同源：两者都读同一份 rescue 快照与同一份 store 数据，
       * 不存在"徽标一套算法、面板另一套"的可能。
       */
      handler: async (req, res) => {
        if (!needGate(req, res)) return
        try {
          await store.init()
          const port = store.portData()
          const posSecids = [...new Set(port.items.map((p) => p.secid))]
          // 指数点位要与持仓行情**同一次取数**（隐身档只显示点位，不能另开一条链路：
          // 那会让徽标与面板顶部显示两个不同时刻的数）
          const indexSecids = ['1.000300', '1.000001']
          const want = [...new Set([...posSecids, ...indexSecids])]
          const q = await em.fetchQuotesWithProvenance(want)
          const prefs = store.getPrefs()
          const { view } = assemblePortfolio(port.groups, port.items, store.ledgerEntries(), q.items, {
            mode: prefs.fxMode ?? 'none',
            rates: prefs.fxRates ?? {},
          })
          const snap = rescue?.snapshot() ?? null
          const win = snap?.activeWindow ?? null
          // 沪深300 优先，缺了退上证指数（两者都缺才给 null —— 不给假点位）
          const indexRow = q.items['1.000300'] ?? q.items['1.000001'] ?? null
          const dayPnlBase = view.grand.dayPnl
          const dayPnlPct = view.grand.totalMv > 0 ? (dayPnlBase / view.grand.totalMv) * 100 : null
          // 缺失计数只统计**持仓**标的：指数点位取不到不算"你的持仓缺数据"
          const posSet = new Set(posSecids.map((x) => x.toUpperCase()))
          const posMissing = q.provenance.missing.filter((m) => posSet.has(m.what.toUpperCase()))
          send(res, 200, {
            // 非交易日 ⇒ level 为 null（不出等级）；这里保留 null 供界面显示「休市（非交易日）」
            level: snap === null ? 0 : snap.level,
            levelLabel: snap === null ? null : snap.level === null ? '休市（非交易日）' : RESCUE_LEVEL_LABEL[snap.level],
            dayPnl: Math.round(dayPnlBase * 100) / 100,
            dayPnlPct: dayPnlPct === null ? null : Math.round(dayPnlPct * 100) / 100,
            indexPoint: indexRow?.price ?? null,
            indexPct: indexRow?.pct ?? null,
            indexName: indexRow?.name ?? null,
            // 收盘后缀「收」：只有在"非采样时段且原因是已收盘/周末"时才加
            settled: win !== null && win.sampling !== true && (win.reason === 'closed' || win.reason === 'weekend'),
            asOf: q.provenance.asOf ?? snap?.lastSampleTs ?? null,
            source: q.provenance.source ?? 'none',
            missingCount: posMissing.length + (view.unpriced?.length ?? 0),
          })
        } catch (error) {
          fail(res, error)
        }
      },
    },
    {
      kind: 'exact',
      path: '/tradewatcher/quotes',
      handler: async (req, res) => {
        if (!needGate(req, res)) return
        try {
          const { ids, requested, truncated } = splitIds(queryOf(req).get('ids'))
          if (ids.length === 0) {
            send(res, 200, {
              ts: Date.now(), asOf: null, stale: false, staleCount: 0, priced: 0, rows: 0, sources: {},
              items: {}, missing: [], requested, truncated: false,
            })
            return
          }
          // 真实新鲜度：asOf = 数据被观测到的时刻（不是响应生成时刻），
          // stale = 至少一行是 last-known-good 或已超过 90s —— 上游全挂时界面必须能如实报警。
          // missing = 请求了但**没有任何源**给出可用价格的标的（界面据此显示「无行情源」）
          const detail = await em.fetchQuotesDetailed(ids)
          /**
           * P0（AUDIT-IMPL70 §1）：`missing` 一直是**纯 id 列表**（界面只显示"无行情源"），
           * 但"为什么没有"从来没进过 `/quotes` 回包 —— 用户/agent 只能看到一个干名字。
           * 这里补 `missingReasons[]`（`{what, why, note}`，与工具层同一口径的
           * `em.quoteProvenance`）：逐标说明是「只有东财一个源且东财不可达（等它恢复）」
           * 还是「所有源都试过、本次都没给价」。
           *
           * 为什么**新增字段**而不是把 `missing` 改成对象：`missing: string[]` 是客户端
           * 已经在读的既有契约（`client/api.ts` 的 `quotes()`），改形状会让界面把 id 列表
           * 渲染成 `[object Object]`。语义清楚的加法优于破坏性改名。
           */
          const reasons = em.quoteProvenance(detail).missing
          send(res, 200, {
            ts: Date.now(),
            ...detail,
            requested,
            truncated,
            ...(reasons.length === 0 ? {} : { missingReasons: reasons }),
          })
        } catch (error) {
          fail(res, error)
        }
      },
    },
    {
      kind: 'exact',
      path: '/tradewatcher/trend',
      handler: async (req, res) => {
        if (!needGate(req, res)) return
        try {
          const secid = String(queryOf(req).get('secid') ?? '').trim()
          if (!SECID_RE.test(secid)) throw new HttpError('secid 非法', 400)
          const ndays = Number(queryOf(req).get('ndays') ?? 1) || 1
          // 归档开关来自 prefs（默认开）：关掉后不再写 trends/<secid>/，五日在无真实多日源的市场只能是当日
          const trend = await em.fetchTrend(secid, ndays, { archive: store.getPrefs().trendArchive !== false })
          // C/B：拿不到就带原因 —— no-source（结构性没有）与 transient（东财这会儿不可达）
          // 与 quoteProvenance 同一口径，客户端据此显示"为什么没有"，而不是一句光秃秃的失败。
          // ⚠ v0.66.0：**拿到了但量能用不了**（点够、带成交额的点不足）也必须给原因 ——
          // 否则界面上只剩「分钟成交额未取到」，违反"缺失必须给原因"。
          const amountReason = em.trendAmountMissingReason(trend)
          const missing = [
            ...(trend === null ? [em.trendMissingReason(secid)] : []),
            ...(amountReason === null ? [] : [amountReason]),
          ]
          /**
           * 「做T窗口」的 ATR（v0.166.0，用户定稿）：**按需计算**（`?atr=1`）——
           * 关着开关的标的完全不付这份成本（走 `fetchKline` 的日线缓存，不新建旁路）。
           * 取不到只回 `{reason}`，**绝不给默认值**（用户第 3 条）。
           */
          const atr = req.url !== undefined && /(?:^|[?&])atr=1(?:&|$)/.test(req.url)
            ? await atr14PctOf(secid)
            : undefined
          // 二级瘦身（AUDIT-IMPL77 第 2 项）：单日序列逐点 label 只留 HH:mm（日期在 labelDay）
          send(res, 200, {
            trend: wireTrend(trend),
            ...(atr === undefined ? {} : { atr }),
            ...(missing.length === 0 ? {} : { missing }),
          })
        } catch (error) {
          fail(res, error)
        }
      },
    },
    {
      kind: 'exact',
      path: '/tradewatcher/atr',
      handler: async (req, res) => {
        if (!needGate(req, res)) return
        try {
          const secid = String(queryOf(req).get('secid') ?? '').trim()
          if (!SECID_RE.test(secid)) throw new HttpError('secid 非法', 400)
          /**
           * 「做T窗口」的 ATR14（`ATR% = ATR14 ÷ 收盘 × 100`）。**只在开关打开时被调用**，
           * 所以不给它做常驻预算；取不到回 `{reason}`，客户端据此整组不渲染（不用默认值顶替）。
           */
          send(res, 200, { atr: await atr14PctOf(secid) })
        } catch (error) {
          fail(res, error)
        }
      },
    },
    {
      kind: 'exact',
      path: '/tradewatcher/kline',
      handler: async (req, res) => {
        if (!needGate(req, res)) return
        try {
          const secid = String(queryOf(req).get('secid') ?? '').trim()
          if (!SECID_RE.test(secid)) throw new HttpError('secid 非法', 400)
          const rawKlt = Number(queryOf(req).get('klt') ?? 101)
          const klt = rawKlt === 102 || rawKlt === 103 || rawKlt === 104 ? (rawKlt as 101 | 102 | 103 | 104) : 101
          const rawLmt = Number(queryOf(req).get('lmt') ?? 0)
          const defLmt = klt === 101 ? 240 : klt === 102 ? 200 : klt === 103 ? 120 : 20
          const lmt = Number.isFinite(rawLmt) && rawLmt >= 5 ? Math.min(1000, Math.round(rawLmt)) : defLmt
          // 复权口径：0=不复权 1=前复权（默认）2=后复权；非法值按默认处理，
          // 实际生效的口径由 fetchKline 回包里的 fqt 字段决定（指数/期货恒为 0）
          const rawFqt = Number(queryOf(req).get('fqt') ?? 1)
          const fqt = rawFqt === 0 || rawFqt === 2 ? rawFqt : 1
          const kline = await em.fetchKline(secid, klt, lmt, fqt)
          // 缓存状态要在 fetchKline 之后读（它才填过内存）—— note 必须能说清"是没缓存还是缓存被判不可用"。
          // 键必须与 fetchKline 内部一致：年K 用 103 的缓存，复权口径过 normalizeFq（指数/期货会被归为 0）
          const cache = em.klineCacheStatusOf(secid, klt === 104 ? 103 : klt, em.normalizeFq(secid, fqt))
          // 二级瘦身（AUDIT-IMPL77 第 2 项）：`pct:null` 不上线；读侧 `chartWire.klinePctOf` 还原成 null
          // `fqt` 一并传进理由函数：周/月/年拿不到时要能说清"本地日线够不够聚合"（AUDIT-BK-AGG）
          send(res, 200, { kline: wireKline(kline), ...(kline === null ? { missing: [em.klineMissingReason(secid, klt, { cache, fqt })] } : {}) })
        } catch (error) {
          fail(res, error)
        }
      },
    },
    {
      kind: 'exact',
      path: '/tradewatcher/industries',
      handler: async (req, res) => {
        if (!needGate(req, res)) return
        try {
          const raw = queryOf(req).get('secids') ?? ''
          const seen = new Set<string>()
          const secids: string[] = []
          for (const piece of raw.split(',')) {
            const id = piece.trim()
            if (id === '' || !SECID_RE.test(id) || seen.has(id.toUpperCase()) || secids.length >= 120) continue
            seen.add(id.toUpperCase())
            secids.push(id)
          }
          /**
           * P0（AUDIT-IMPL70 §1）：行业板块**只有东财一个上游**（`f127`）。东财不可达时
           * 以前是 `fetchIndustryOverview` 抛错 ⇒ 整条路由 503 ⇒ 客户端把整块行业标注判成"报错"。
           * 现在：能拿到几只就返回几只，取不到的逐标给原因；**任何情况下都不升级为 5xx**。
           */
          let map: Record<string, { name: string; pct: number | null }> = {}
          let failure: unknown = null
          if (secids.length > 0) {
            try {
              map = await em.fetchIndustryOverview(secids)
            } catch (error) {
              failure = error
            }
          }
          const missing: MissingField[] = secids
            .filter((id) => map[id] === undefined)
            .map((id) => ({
              what: id,
              why: failure === null ? ('no-source' as const) : ('transient' as const),
              note: failure === null
                ? `行业板块未取到：东财可达但没有返回该标的的板块归属（非 A股，或上游没有这个标的）`
                : `行业板块未取到：行业归属只有东财一个上游，而东财本次不可达（${shortError(failure)}）`,
            }))
          replyBatch(res, { map }, partialOutcomeOf(secids.length, Object.keys(map).length), missing)
        } catch (error) {
          fail(res, error, '行业板块')
        }
      },
    },
    {
      kind: 'exact',
      path: '/tradewatcher/industry',
      handler: async (req, res) => {
        if (!needGate(req, res)) return
        try {
          const secid = String(queryOf(req).get('secid') ?? '').trim()
          if (!SECID_RE.test(secid)) throw new HttpError('secid 非法', 400)
          // 单标的也是同一条纪律（P0）：拿不到就给 `industry: null` + 原因，不把整条路由变成 503
          let industry: { name: string; pct: number | null } | null = null
          let failure: unknown = null
          try {
            industry = await em.fetchIndustryOf(secid)
          } catch (error) {
            failure = error
          }
          send(res, 200, {
            industry,
            ...(industry === null
              ? {
                  missing: [{
                    what: secid,
                    why: failure === null ? 'no-source' : 'transient',
                    note: failure === null
                      ? `行业板块未取到：该标的不是 A股，或东财没有它的板块归属`
                      : `行业板块未取到：行业归属只有东财一个上游，而东财本次不可达（${shortError(failure)}）`,
                  }],
                }
              : {}),
          })
        } catch (error) {
          fail(res, error, '行业板块')
        }
      },
    },
    {
      kind: 'exact',
      path: '/tradewatcher/detail',
      handler: async (req, res) => {
        if (!needGate(req, res)) return
        try {
          const secid = String(queryOf(req).get('secid') ?? '').trim()
          if (!SECID_RE.test(secid)) throw new HttpError('secid 非法', 400)
          /**
           * P0（AUDIT-IMPL70 §1）：**上游抛错不再升级成 503**。
           *
           * 旧注释写着"上游抛错时保持 503 + retry-after"—— 但那正是用户看到的
           * 「route error (503): 上游暂时不可用（熔断中，约 2 分钟后自动重试）」：
           * 详情（开高低收/量额/市值）只有东财一个上游，东财一挂，抽屉整块变成"报错"，
           * 而同一只标的的价格其实腾讯/新浪已经给了（`/quotes` 是 200）。
           * 现在：`detail: null` + `missing[]` 写明"只有东财一个上游 + 本次不可达"，
           * 界面照常显示价格与其余字段，只在详情区标"未取到 + 原因"。
           */
          /**
           * **竞价与详情解耦**（AUDIT-AUCTION-DECOUPLE）：并发取，互不拖累。
           *
           * 旧实现把竞价算在 `fetchStockDetail` 里面 ⇒ 东财 `ulist.np` 一熔断，整条路由只剩
           * `detail: {}`，本地已经采样好的竞价序列（`auction/<secid>.json`）一条都读不到。
           * 现在竞价走 `fetchAuctionFor`（本地文件 + 腾讯 m1，**零东财**），并**同时**放在
           * 顶层 `auction`（新出口，客户端读它）与 `detail.auction`（兼容旧客户端）。
           */
          const auctionPromise = em.fetchAuctionFor(secid)
          const auction = await auctionPromise
          // 一级东财 → 兜底腾讯（v0.178.0）：东财熔断时抽屉头部不再全变 `—`
          const resolved = await detailWithFallback(secid, {
            eastmoney: (id) => em.fetchStockDetail(id),
            tencent: (id) => fetchTencentDetail(id),
          })
          const detail = resolved.detail
          send(res, 200, {
            detail: detail === null ? null : { ...detail, auction },
            auction,
            source: resolved.source,
            // 恒有 `missing`（东财成功时为 []）：客户端不用判断字段在不在
            missing: resolved.missing,
          })
        } catch (error) {
          fail(res, error, '行情详情')
        }
      },
    },
    {
      /**
       * 竞价（四项 + 竞价时段采样序列）——**唯一一条不依赖东财**的详情类出口。
       *
       * 为什么单独一条：东财 `ulist.np` 熔断时 `/detail` 只能给 `detail: null`，
       * 而竞价的数据其实已经在本机（采样器 09:15–09:25 落盘）+ 腾讯 m1 里。把它挂在 `/detail` 上
       * 等于让"东财挂了"连累"本地已有的数据"。这条路由**只**读本地文件与腾讯（零 `push2*` 请求）。
       *
       * 契约：**永远 200**，`auction` 必有（不可用时 `state:'unavailable'` + 一句原因），
       * 不可用时另给 `missing[]`（`no-source` = 该市场本来没有竞价；`transient` = 这次没取到）。
       */
      kind: 'exact',
      path: '/tradewatcher/auction',
      handler: async (req, res) => {
        if (!needGate(req, res)) return
        try {
          const secid = String(queryOf(req).get('secid') ?? '').trim()
          if (!SECID_RE.test(secid)) throw new HttpError('secid 非法', 400)
          const auction = await em.fetchAuctionFor(secid)
          const missing = auctionMissingOf(secid, auction)
          send(res, 200, { auction, ...(missing === null ? {} : { missing: [missing] }) })
        } catch (error) {
          fail(res, error, '竞价')
        }
      },
    },
    {
      kind: 'exact',
      path: '/tradewatcher/suggest',
      handler: async (req, res) => {
        if (!needGate(req, res)) return
        try {
          const p = queryOf(req)
          // v0.95.1（用户要求"列出所有匹配"）：默认一次要 50 条（原先写死 14、且映射里还有一处写死 10）。
          // `count` 由调用方给，服务端夹在 1..100（上游单次给不了更多，见报告的上游实测）。
          // 默认值与上夹取都取**共享常量**（与客户端请求值、断言阈值同源，改一处即可）
          const rawCount = Number(p.get('count') ?? SUGGEST_FULL_COUNT)
          const count = Number.isFinite(rawCount)
            ? Math.max(1, Math.min(SUGGEST_MAX_COUNT, Math.round(rawCount)))
            : SUGGEST_FULL_COUNT
          const q = String(p.get('q') ?? '').trim()
          // 空关键字：不发上游、也不给"无匹配"的假象（客户端另有提示）
          if (q === '') {
            send(res, 200, { hits: [], requested: count, truncated: false })
            return
          }
          // 超长关键字：**不静默截断**（截断后查上游会得到与用户输入不符的匹配）
          if (q.length > 40) {
            send(res, 200, {
              hits: [], requested: count, truncated: false,
              reason: `关键字超过 40 字上限（上游按 input 查询，超长只能截断 ⇒ 不查，免得给你不匹配的结果）`,
            })
            return
          }
          const hits = await em.searchSymbols(q, count)
          // 诚实边界：拿满 `count` 条时**无法排除上游还有更多** ⇒ 如实标记（界面写"已显示 N 条（上游本次上限 M）"）
          send(res, 200, { hits, requested: count, truncated: hits.length >= count })
        } catch (error) {
          fail(res, error)
        }
      },
    },
    {
      kind: 'exact',
      path: '/tradewatcher/board',
      handler: async (req, res) => {
        if (!needGate(req, res)) return
        try {
          const p = queryOf(req)
          const scope = String(p.get('scope') ?? 'industry')
          const sort = String(p.get('sort') ?? 'pct')
          if (scope !== 'industry' && scope !== 'concept' && scope !== 'etf') throw new HttpError('scope 非法', 400)
          if (sort !== 'pct' && sort !== 'money' && sort !== 'amount') throw new HttpError('sort 非法', 400)
          const pn = Math.max(1, Math.min(100, Number(p.get('pn') ?? 1) || 1))
          const pz = Math.max(1, Math.min(100, Number(p.get('pz') ?? 40) || 40))
          const data = await em.fetchBoard(scope as 'industry' | 'concept' | 'etf', sort as 'pct' | 'money' | 'amount', pn, pz)
          send(res, 200, data)
        } catch (error) {
          /**
           * 板块榜单是**聚合表**（没有"逐标的"可言）：东财拿不到就是整表拿不到，
           * 这里**允许** 503 —— 但必须写清「哪个上游 × 哪个范围」，
           * 而不是一句"上游暂时不可用"（用户无法判断该等谁、等到什么时候）。
           */
          if (httpStatusOf(error) >= 500) {
            fail(res, new TotalUpstreamError({
              upstreams: ['东财 push2delay/push2.eastmoney.com（板块榜单唯一上游）'],
              scope: '板块榜单',
              subjects: [],
              reason: shortError(error),
            }), '板块榜单')
            return
          }
          fail(res, error, '板块榜单')
        }
      },
    },
    {
      kind: 'exact',
      path: '/tradewatcher/watch',
      handler: async (req, res) => {
        if (!needGate(req, res)) return
        try {
          await store.init()
          if (req.method === 'GET') {
            send(res, 200, { watch: store.watchData() })
            return
          }
          if (req.method === 'POST') {
            const body = (await readBody(req)) as MutateWatchBody
            const watch = await store.mutateWatch(body)
            send(res, 200, { ok: true, watch })
            return
          }
          send(res, 405, { error: 'method not allowed' })
        } catch (error) {
          fail(res, error)
        }
      },
    },
    {
      kind: 'exact',
      path: '/tradewatcher/portfolio',
      handler: async (req, res) => {
        if (!needGate(req, res)) return
        try {
          await store.init()
          if (req.method === 'GET') {
            const { view, stale } = await portfolioWithQuotes(store)
 // 除权除息提示（来源是已同步的日历事件，不新增数据源）
            let actions: CorporateAction[] = []
            try {
              actions = await corporateActionsFor(store, calendar)
            } catch {
              /* 日历不可用时不阻断持仓视图：提示是附加信息，缺了要说但不该整页失败 */
              actions = []
            }
            // 做T（同日往返配对，P1-3）：客户端要显示收起态一行；纯派生自账本，无新逻辑
            // R1：本地文件读不到时，把原因一并回传（界面/agent 才可能知道"空"与"读不到"的区别）
            const readFailures = store.readFailures()
            send(res, 200, {
              ok: true,
              view,
              stale,
              corporateActions: actions,
              dayTrades: dayTradesOf(store.ledgerEntries()),
              ...(readFailures.length > 0 ? { readFailures } : {}),
            })
            return
          }
          if (req.method === 'POST') {
            const body = (await readBody(req)) as MutatePortBody
            await store.mutatePortfolio(body)
            const { view, stale } = await portfolioWithQuotes(store)
            send(res, 200, { ok: true, view, stale })
            return
          }
          send(res, 405, { error: 'method not allowed' })
        } catch (error) {
          fail(res, error)
        }
      },
    },
    {
      kind: 'exact',
      path: '/tradewatcher/trades',
      handler: async (req, res) => {
        if (!needGate(req, res)) return
        try {
          const secid = String(queryOf(req).get('secid') ?? '').trim()
          if (!SECID_RE.test(secid)) throw new HttpError('secid 非法', 400)
          await store.init()
          const port = store.portData()
          const groupName = new Map(port.groups.map((g) => [g.id, g.name]))
          const posName = new Map(port.items.map((p) => [p.id, p.name]))
          const trades = store
            .ledgerEntries()
            .filter((e) => (e.verb === 'buy' || e.verb === 'sell') && secidKey(e.secid) === secidKey(secid) && typeof e.price === 'number' && typeof e.qty === 'number')
            .sort((a, b) => a.ts - b.ts)
            .map((e) => ({
              id: e.id,
              ts: e.ts,
              verb: e.verb as 'buy' | 'sell',
              qty: e.qty as number,
              price: e.price as number,
              posName: e.posId !== undefined ? posName.get(e.posId) ?? e.name ?? null : null,
              groupName: e.groupId !== undefined ? groupName.get(e.groupId) ?? null : null,
            }))
          send(res, 200, { trades })
        } catch (error) {
          fail(res, error)
        }
      },
    },
    {
      kind: 'exact',
      path: '/tradewatcher/ledger',
      handler: async (req, res) => {
        if (!needGate(req, res)) return
        try {
          await store.init()
          const p = queryOf(req)
          const groupId = p.get('groupId') ?? undefined
          const posId = p.get('posId') ?? undefined
          const limit = Math.min(1000, Math.max(1, Number(p.get('limit') ?? 200) || 200))
          const port = store.portData()
          const allEntries = store.ledgerEntries()
          const matched = ledgerTotal(allEntries, { groupId, posId })
          const entries = ledgerViews(allEntries, port.groups, port.items, { groupId, posId, limit })
          send(res, 200, {
            returned: entries.length,
            total: matched,
            truncated: matched > entries.length,
            limit, entries })
        } catch (error) {
          fail(res, error)
        }
      },
    },
    {
      kind: 'exact',
      path: '/tradewatcher/rescue',
      handler: async (req, res) => {
        if (!needGate(req, res)) return
        try {
          if (rescue === undefined) {
            send(res, 200, { error: '护盘监测未启用', snapshot: null, history: [] })
            return
          }
          if (req.method === 'GET') {
            const p = queryOf(req)
            const wantsForce = p.get('force') === '1'
            const day = p.get('day')
            // 收盘后重启等情形下本会话还没有快照：自动补采一次（带冷却），
            // 否则前端拿到的是空快照 —— 标的卡与因子表会整块消失
            if (!wantsForce) await rescue.ensureFresh()
            const snapshot = wantsForce ? await rescue.sampleNow() : rescue.snapshot()
            // 线上编码（AUDIT-IMPL76 ④）：只裁空字段（hhmm 空串 / price null），语义不变；
            // 客户端 `rescueCardPointsOf()` 对新旧两种编码都能还原。落盘快照仍是 dense。
            const wireSnapshot = wireRescueSnapshot(snapshot)
            if (day !== null && /^\d{4}-\d{2}-\d{2}$/.test(day)) {
              send(res, 200, {
                snapshot: wireSnapshot,
                history: rescue.history(30),
                // 口径字符串随结果返回（与算法同源）
                methodology: RESCUE_METHODOLOGY,
                day,
                dayEvents: rescue.eventsOf(day),
                dayIntraday: rescue.intradayOf(day),
                calibrated: rescue.calibratedInfo,
                calibration: rescue.calibrationInfo,
              })
              return
            }
            const b = breakerSummary(upstreamHosts)
            send(res, 200, {
              snapshot: wireSnapshot, history: rescue.history(30), calibrated: rescue.calibratedInfo,
              calibration: rescue.calibrationInfo,
              // 聚合：此前只反映单台 push2delay 的状态（其它主机被限流时横幅显示"正常"，
              // 而 push2delay 单独熔断时又让界面以为整组不可用）
              breaker: b,
            })
            return
          }
          send(res, 405, { error: 'method not allowed' })
        } catch (error) {
          fail(res, error)
        }
      },
    },
    {
      kind: 'exact',
      path: '/tradewatcher/calendar',
      handler: async (req, res) => {
        if (!needGate(req, res)) return
        try {
          await calendar.init()
          if (req.method === 'GET') {
            const p = queryOf(req)
            const from = String(p.get('from') ?? calToday(-45))
            const to = String(p.get('to') ?? calToday(400))
            if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) throw new HttpError('from/to 应为 YYYY-MM-DD', 400)
            const codes = focusCodes(store)
            if (p.get('sync') !== '0') {
              try {
                await calendar.sync(codes, p.get('force') === '1')
              } catch {
                // 同步过程本身出错：原因已由 calendar.sync 记进 syncStatus().missing，
                // 下面照常返回本地事件并**如实带上降级标记**（此前这里静默吞掉，
                // 界面于是分不清"这两天没有新股/分红"与"日历根本没同步上"）
              }
            }
 // 勾稽：持仓（实心）/ 仅自选（空心）/ 无关，三种由宿主判定
            // 避免客户端自己拿两份数据拼（那样两处会不一致）
            const heldSet = new Set(focusCodes(store, true))
            const watchSet = new Set(focusCodes(store, false))
            const events = calendar.list(from, to).map((e) => {
              const code = symbolCode(e.symbol)
              if (code === null) return e
              return { ...e, link: { held: heldSet.has(code), watched: !heldSet.has(code) && watchSet.has(code) } }
            })
            // asOf 口径（P0-2）：只认最近一次**成功**同步；从未成功过是 null
            send(res, 200, { events, ...calendarStatusPayload(), symbolCount: codes.length })
            return
          }
          if (req.method === 'POST') {
            const body = (await readBody(req)) as Record<string, unknown>
            await calendar.mutate(body)
            const events = calendar.list(calToday(-45), calToday(400))
            send(res, 200, { ok: true, events, ...calendarStatusPayload() })
            return
          }
          send(res, 405, { error: 'method not allowed' })
        } catch (error) {
          fail(res, error)
        }
      },
    },
    {
      /**
       * 复盘（第 8 行 `fupan`）：整月视图 —— 每天是否有笔记 + 该日是否交易日 + **该日交易笔数**。
       *
       * **零新增上游请求**：笔记读本地 `fupan.json`，休市日读本地 `trading-calendar.json` 并走
       * 既有判定链 `tradingDayState`，笔数读本地流水（`fupanTrades.tradeCountsOfMonth`，
       * 与 `/fupan/trades` 同一份过滤/归属）。一个 fetch 都没有。
       * 归属：只被复盘页消费 ⇒ `ROW_ROUTES.fupan`（关掉该行 ⇒ 本路由随行 404）。
       */
      kind: 'exact',
      path: '/tradewatcher/fupan/month',
      handler: async (req, res) => {
        if (!needGate(req, res)) return
        try {
          const ym = parseFupanMonth(queryOf(req).get('ym'))
          await fupan.init()
          await store.init()
          const state = fupan.readState()
          const view = await fupanMonthView(state.notes, ym)
          const notes = notesInMonth(state.notes, ym)
          // 每天的计入笔数（0 只能来自"那天真的没有"；读不到就是 null，界面据此不画 ▲n）
          const monthTrades = readFupanMonthTrades(store, ym)
          const dates = view.dates.map((d) => ({
            ...d,
            trades: monthTrades.counts === null ? null : (monthTrades.counts[d.date] ?? 0),
          }))
          // 「读不到」≠「没有」：读失败时 notes 是空数组，但这句必须跟着回去
          const missing: MissingField[] = [
            ...(state.unreadable === null
              ? []
              : unreadableMissing([{ file: fupan.path(), reason: state.unreadable }], '复盘笔记文件')),
            ...monthTrades.missing,
          ]
          send(res, 200, {
            ym,
            asOf: Date.now(),
            source: view.source,
            stale: false,
            notes,
            dates,
            // 流水读不到 ⇒ 每格 trades 为 null（不是 0）；显示层按 readFailed 不画三角
            readFailed: monthTrades.readFailed,
            readFailedReason: monthTrades.readFailedReason,
            totals: {
              // 该月**可见**的笔记数 = 写在本月的 + 被钉到本月的（与下面 two 个分项能对上账）
              notes: notes.length,
              pinned: notes.filter((n) => n.pinnedTo !== undefined).length,
              // 分项：写在本月 / 钉到本月（`sum(dates[].count)` 等于 `writtenHere`，不会与 notes 打架）
              writtenHere: notes.filter((n) => n.date.startsWith(`${ym}-`)).length,
              pinnedIn: notes.filter((n) => n.pinnedTo !== undefined && n.pinnedTo.startsWith(`${ym}-`)).length,
              days: view.dates.length,
              daysWithNotes: view.dates.filter((d) => d.count > 0).length,
              daysWithPinned: view.dates.filter((d) => d.hasPinned).length,
              // 交易日数也是算出来的（0 只能来自"这个月真的没有交易日"，不能当"不知道"用）
              tradingDays: view.dates.filter((d) => d.trading).length,
            },
            calendar: view.calendar,
            // 覆盖不足/未生效时的原因（null = 该月真的按外部文件判定）
            calendarWhy: view.calendarWhy,
            notesUnreadable: state.unreadable,
            notesQuarantined: state.quarantined,
            invalidEntries: state.invalidEntries,
            missing,
          })
        } catch (error) {
          fail(res, error)
        }
      },
    },
    {
      /**
       * 复盘：新增 / 更新 / 删除**一条**笔记（按 `id` 或 `(date, id)` 定位）。
       *
       * body：`{ op: 'upsert'|'delete', id?, date?, text?, pinnedTo? }`
       * 回包带**写入后**该日的笔记、该月的日期骨架，以及被上限丢掉的条目（`dropped`）——
       * 丢弃绝不静默：超限时前端能逐条显示"哪几条被丢了、为什么"。
       */
      kind: 'exact',
      path: '/tradewatcher/fupan/note',
      handler: async (req, res) => {
        if (!needGate(req, res)) return
        try {
          if (req.method !== 'POST') {
            send(res, 405, { error: 'method not allowed' })
            return
          }
          const op = parseFupanOp(await readBody(req))
          const written = await fupan.write(op)
          const state = fupan.readState()
          const date = written.note?.date ?? op.date ?? ''
          const ym = /^\d{4}-\d{2}$/.test(date.slice(0, 7)) ? date.slice(0, 7) : null
          const view = ym === null ? null : await fupanMonthView(state.notes, ym)
          const missing: MissingField[] = state.unreadable === null
            ? []
            : unreadableMissing([{ file: fupan.path(), reason: state.unreadable }], '复盘笔记文件')
          send(res, 200, {
            ok: true,
            asOf: Date.now(),
            source: 'local:fupan.json',
            op: op.op,
            id: written.note?.id ?? null,
            removed: written.removed,
            date,
            ym,
            notes: date === '' ? [] : notesOnDay(state.notes, date),
            dropped: {
              notes: written.dropped,
              count: written.dropped.length,
              reasons: [...new Set(written.dropped.map((d) => FUPAN_DROP_TEXT[d.reason]))],
            },
            month: view === null ? null : { ym, dates: view.dates, calendar: view.calendar, calendarWhy: view.calendarWhy },
            notesUnreadable: state.unreadable,
            notesQuarantined: state.quarantined,
            missing,
          })
        } catch (error) {
          fail(res, error)
        }
      },
    },
    {
      /**
       * 复盘（第 8 行 `fupan`）：**某一天的持仓交易记录** —— 逐笔 + 汇总 + 当日盈亏（只读）。
       *
       * 归属日按流水 `ts` 的**北京日**算（`fupanTrades.ts`，与宿主 TZ 无关）；只计入
       * buy/sell/adjust。当日盈亏**取持仓核算**（与持仓页同一来源），不按逐笔重算。
       * **零新增上游请求**：行情只读本地槽（`em.peekQuotes`），取不到就如实缺。
       * 读取失败按用户显式决定回"0 笔 + readFailed 标记"（HTTP 200，不抛错）。
       */
      kind: 'exact',
      path: '/tradewatcher/fupan/trades',
      handler: async (req, res) => {
        if (!needGate(req, res)) return
        try {
          if (req.method !== 'GET') {
            send(res, 405, { error: 'method not allowed' })
            return
          }
          const day = parseFupanDay(queryOf(req).get('day'))
          await store.init()
          send(res, 200, readFupanTrades(store, day))
        } catch (error) {
          fail(res, error)
        }
      },
    },
    {
      kind: 'exact',
      path: '/tradewatcher/prefs',
      handler: async (req, res) => {
        if (!needGate(req, res)) return
        try {
          await store.init()
          if (req.method === 'GET') {
            send(res, 200, { prefs: store.getPrefs() })
            return
          }
          if (req.method === 'POST') {
            const body = (await readBody(req)) as { patch?: Record<string, unknown> }
            const patch = body?.patch
            if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) {
              throw new HttpError('patch 必须是对象', 400)
            }
            const prefs = await store.setPrefs(patch as Parameters<DataStore['setPrefs']>[0])
            // 改刷新间隔立刻生效（否则要等下一次重启才对齐行情新鲜度）
            em.setQuoteFreshnessMs(prefs.refreshSec * 1000)
            rescue?.setConfig(prefs.rescue)
            send(res, 200, { prefs })
            return
          }
          send(res, 405, { error: 'method not allowed' })
        } catch (error) {
          fail(res, error)
        }
      },
    },
  ]
  if (prism !== undefined) routes.push(...makePrismRoutes(prism))
  return { routes, store }
}

