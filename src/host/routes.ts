/**
 * /tradewatcher/* HTTP routes (same-origin with the web GUI).
 * GET  — quote relay (quotes / trend / kline / detail / suggest / board)
 * GET  — watch / portfolio / ledger / prefs snapshots
 * POST — watch + portfolio mutations (validated by the store) and prefs
 * Every route is behind the browser-trust fence; POST bodies are capped.
 *
 * 错误语义见 http.ts：400 请求有问题 / 413 体过大 / 503 上游不可用 / 500 本插件 bug。
 * 此前一律 400，把"上游被限流"报成"你的请求写错了"。
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { MutatePortBody, MutateWatchBody, QuoteRow } from '../shared/model.ts'
import { SECID_RE } from '../shared/model.ts'
import { isTrustedApiRequest } from './fence.ts'
import * as em from './em.ts'
import { assemblePortfolio, ledgerViews } from './portfolio.ts'
import { DataStore, secidKey } from './store.ts'
import { CalendarStore, calToday } from './calendar.ts'
import { RescueMonitor } from './rescue.ts'
import { QUOTE_HOSTS, HISTORY_HOSTS } from './em.ts'
import { breakerSummary } from './breaker.ts'
import { HttpError, httpStatusOf, retryAfterSecondsOf } from './http.ts'
import { log, type PluginWebRoute, type PluginWebServer } from './context.ts'

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
  const { view, stale } = assemblePortfolio(port.groups, port.items, store.ledgerEntries(), quotes)
  return { view, stale }
}

/** 关注标的 → 6 位代码（仅 A股，供财报/分红数据源过滤） */
function focusCodes(store: DataStore): string[] {
  const codes = new Set<string>()
  const push = (secid: string): void => {
    const m = /^(\d{1,3})\.([A-Za-z0-9]+)$/.exec(secid)
    if (m === null) return
    if (m[1] === '0' || m[1] === '1') codes.add(m[2])
  }
  for (const it of store.watchData().items) push(it.secid)
  for (const it of store.portData().items) push(it.secid)
  return [...codes]
}

export function makeTradeRoutes(
  store: DataStore,
  trustedHosts: readonly string[],
  calendar: CalendarStore,
  rescue?: RescueMonitor,
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
          // missing = 请求了但**没有任何源**给出可用价格的标的（界面据此显示"暂无可用行情源"）
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
          const trend = await em.fetchTrend(secid, ndays)
          send(res, 200, { trend })
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
          const kline = await em.fetchKline(secid, klt, lmt)
          send(res, 200, { kline })
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
          const detail = await em.fetchStockDetail(secid)
          send(res, 200, { detail })
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
            send(res, 200, { ok: true, view, stale })
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
          const entries = ledgerViews(store.ledgerEntries(), port.groups, port.items, { groupId, posId, limit })
          send(res, 200, { entries })
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
                /* 同步失败仍返回本地事件 */
              }
            }
            send(res, 200, { events: calendar.list(from, to), syncedAt: calendar.syncedAt, symbolCount: codes.length })
            return
          }
          if (req.method === 'POST') {
            const body = (await readBody(req)) as Record<string, unknown>
            await calendar.mutate(body)
            const events = calendar.list(calToday(-45), calToday(400))
            send(res, 200, { ok: true, events, syncedAt: calendar.syncedAt })
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

export { DataStore }
