/**
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { CorporateAction, MissingField, MutatePortBody, MutateWatchBody, QuoteRow } from '../shared/model.ts'
import { stripKindOf, RESCUE_LEVEL_LABEL, SECID_RE } from '../shared/model.ts'
import { isTrustedApiRequest } from './fence.ts'
import * as em from './em.ts'
import { ledgerTotal, assemblePortfolio, ledgerViews } from './portfolio.ts'
import { DataStore, secidKey } from './store.ts'
import { CalendarStore, calToday, type CalSyncSourceResult } from './calendar.ts'
import { RESCUE_METHODOLOGY, RescueMonitor } from './rescue.ts'
import { QUOTE_HOSTS, HISTORY_HOSTS } from './em.ts'
import { breakerSummary } from './breaker.ts'
import { HttpError, httpStatusOf, retryAfterSecondsOf } from './http.ts'
import { describeConflicts, makeBundle, verifyBundle } from './backup.ts'
import { detectAnomalies } from './anomaly.ts'
import { YTD_MAX_IDS, computeYtds } from './ytd.ts'
import { TONE_MAX_IDS, computeTones } from './tonesService.ts'
import { BREADTH_MIN_DAYS, BREADTH_WINDOW, BreadthStore, breadthUsable, percentileOf, upRatio } from './breadth.ts'
import { BREADTH_METHODOLOGY, BREADTH_COUNT_CALIBER, BREADTH_CLIST_MAX_PAGES, BREADTH_PAGE_SIZE, BreadthCountCache, resolveBreadthCount } from './breadthCount.ts'
import { dayOf } from './time.ts'
import { distributionBinsOf } from '../client/breadthView.ts'
import { log, type PluginWebRoute } from './context.ts'
import { dayTradesOf } from './dayTrade.ts'
import { CHIPS_DISPLAY, CHIPS_DISPLAY_MAX, CHIPS_MIN_SAMPLES, CHIPS_WINDOW, CHIPS_WINDOW_MAX, chipSeriesOf } from './chips.ts'
import { globalFlowPayload } from './globalFlow.ts'

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
interface DistSnapshot {
  labels: readonly string[]
  counts: number[] | null
  blank: number
  scanned: number
  total: number | null
  asOf: number
  reason: string | null
}
let distCache: DistSnapshot | null = null

async function distributionSnapshot(now = Date.now()): Promise<DistSnapshot> {
  if (distCache !== null && now - distCache.asOf < DIST_TTL_MS) return distCache
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
  if (reason === null && total !== null) {
    const pageCount = Math.max(1, Math.ceil(total / BREADTH_PAGE_SIZE))
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
  const snap: DistSnapshot = {
    labels: bins.labels,
    counts: full ? bins.counts : null,
    blank: bins.blank,
    scanned: pcts.length,
    total,
    asOf: now,
    reason: full
      ? null
      : `${reason ?? `只扫到 ${pcts.length} 只 / 全市场 ${total ?? '未知'} 只（页数上限 ${BREADTH_PAGES_MAX}）`}⇒ 没有扫全，不给部分分布冒充全市场`,
  }
  distCache = snap
  return snap
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
): TradeRoutes {
  const gate = (req: IncomingMessage): boolean => isTrustedApiRequest(req, trustedHosts)
  /** 上游主机组：503 时用它给出 retry-after，并聚合展示熔断明细（去重后 3 台） */
  const upstreamHosts = [...new Set([...QUOTE_HOSTS, ...HISTORY_HOSTS])]
  const fail = (res: ServerResponse, error: unknown): void => {
    const message = error instanceof Error ? error.message : String(error)
    const status = httpStatusOf(error)
    log(`route error (${status}):`, message)
    // 503 带上建议重试时刻：熔断中最早恢复的那台到点即可重试
    const retry = retryAfterSecondsOf(error, breakerSummary(upstreamHosts).minutesLeft)
    send(res, status, { error: message }, retry === null ? {} : { 'retry-after': String(retry) })
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
        send(res, 200, { ok: true, name: 'dsh-tradewatcher', time: Date.now(), breaker: breakerSummary(upstreamHosts) })
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
          // 口径来自 prefs（老 profile 缺键 ⇒ 默认 k=1.5 / triangle，由 store 的装载归一保证）
          const prefs = store.getPrefs()
          const series = chipSeriesOf(bars, {
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
          send(res, 200, {
            secid,
            // 出处沿用既有读契约：stale = 日线走缓存 或 行情降级；source 说清用了哪两处数据
            asOf: k === null ? null : Date.now(),
            stale: k?.stale === true || qprovenance.stale === true,
            source: 'em-kline+quote',
            // 最后一根 bar 的元信息：partial=true 说明是盘中未完成 bar（数值会变，不可当最终值）
            lastBar: em.lastBarOfKline(secid, 101, 1),
            ...series,
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
          const q = await em.fetchQuotesWithProvenance(ids)
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
          send(res, 200, { ts: Date.now(), ...detail, requested, truncated })
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
          send(res, 200, { trend, ...(missing.length === 0 ? {} : { missing }) })
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
          send(res, 200, { kline, ...(kline === null ? { missing: [em.klineMissingReason(secid, klt, { cache })] } : {}) })
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
          const map = secids.length > 0 ? await em.fetchIndustryOverview(secids) : {}
          send(res, 200, { map })
        } catch (error) {
          fail(res, error)
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
          const industry = await em.fetchIndustryOf(secid)
          send(res, 200, { industry })
        } catch (error) {
          fail(res, error)
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
          // 注意：上游**抛错**时保持原有语义（503 + retry-after，熔断期"快速失败不要重试"），
          // 只有"上游可达但这个标的没有详情字段"（返回 null 而不抛）才补原因。
          const detail = await em.fetchStockDetail(secid)
          send(res, 200, { detail, ...(detail === null ? { missing: [em.detailMissingReason()] } : {}) })
        } catch (error) {
          fail(res, error)
        }
      },
    },
    {
      kind: 'exact',
      path: '/tradewatcher/suggest',
      handler: async (req, res) => {
        if (!needGate(req, res)) return
        try {
          const q = String(queryOf(req).get('q') ?? '').slice(0, 40)
          const hits = q === '' ? [] : await em.searchSymbols(q)
          send(res, 200, { hits })
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
          fail(res, error)
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
            if (day !== null && /^\d{4}-\d{2}-\d{2}$/.test(day)) {
              send(res, 200, {
                snapshot,
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
              snapshot, history: rescue.history(30), calibrated: rescue.calibratedInfo,
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
  return { routes, store }
}

