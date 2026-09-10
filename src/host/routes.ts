/**
 * /tradewatcher/* HTTP routes (same-origin with the web GUI).
 * GET  — quote relay (quotes / trend / kline / detail / suggest / board)
 * GET  — watch / portfolio / ledger / prefs snapshots
 * POST — watch + portfolio mutations (validated by the store) and prefs
 * Every route is behind the browser-trust fence; POST bodies are capped.
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { MutatePortBody, MutateWatchBody, QuoteRow } from '../shared/model.ts'
import { SECID_RE } from '../shared/model.ts'
import { isTrustedApiRequest } from './fence.ts'
import * as em from './em.ts'
import { assemblePortfolio, ledgerViews } from './portfolio.ts'
import { DataStore } from './store.ts'
import { log, type PluginWebRoute, type PluginWebServer } from './context.ts'

const MAX_BODY = 256 * 1024
const MAX_QUOTE_IDS = 160

export interface TradeRoutes {
  routes: PluginWebRoute[]
  store: DataStore
}

function send(res: ServerResponse, code: number, payload: unknown): void {
  const body = JSON.stringify(payload)
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(body)
}

function queryOf(req: IncomingMessage): URLSearchParams {
  const url = new URL(req.url ?? '/', 'http://localhost')
  return url.searchParams
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const b = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += b.length
    if (size > MAX_BODY) throw new Error('请求体过大')
    chunks.push(b)
  }
  if (size === 0) return {}
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

function splitIds(raw: string | null): string[] {
  if (raw === null) return []
  const ids = raw.split(',')
    .map((s) => s.trim().toUpperCase())
    .filter((s) => s !== '' && SECID_RE.test(s))
  return [...new Set(ids)].slice(0, MAX_QUOTE_IDS)
}

/** Full portfolio view with quotes resolved through the quote cache. */
async function portfolioWithQuotes(store: DataStore): Promise<{ view: unknown; stale: number }> {
  const port = store.portData()
  const secids = [...new Set(port.items.map((p) => p.secid))]
  const quotes: Record<string, QuoteRow> = secids.length > 0 ? await em.fetchQuotes(secids) : {}
  const { view, stale } = assemblePortfolio(port.groups, port.items, store.ledgerEntries(), quotes)
  return { view, stale }
}

export function makeTradeRoutes(store: DataStore, trustedHosts: readonly string[]): TradeRoutes {
  const gate = (req: IncomingMessage): boolean => isTrustedApiRequest(req, trustedHosts)
  const fail = (res: ServerResponse, error: unknown): void => {
    const message = error instanceof Error ? error.message : String(error)
    log('route error:', message)
    send(res, 400, { error: message })
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
        send(res, 200, { ok: true, name: 'dsh-tradewatcher', time: Date.now() })
      },
    },
    {
      kind: 'exact',
      path: '/tradewatcher/quotes',
      handler: async (req, res) => {
        if (!needGate(req, res)) return
        try {
          const ids = splitIds(queryOf(req).get('ids'))
          if (ids.length === 0) {
            send(res, 200, { ts: Date.now(), items: {} })
            return
          }
          const items = await em.fetchQuotes(ids)
          send(res, 200, { ts: Date.now(), items })
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
          const secid = String(queryOf(req).get('secid') ?? '').toUpperCase()
          if (!SECID_RE.test(secid)) throw new Error('secid 非法')
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
          const secid = String(queryOf(req).get('secid') ?? '').toUpperCase()
          if (!SECID_RE.test(secid)) throw new Error('secid 非法')
          const rawKlt = Number(queryOf(req).get('klt') ?? 101)
          const klt = rawKlt === 102 || rawKlt === 103 || rawKlt === 104 ? (rawKlt as 101 | 102 | 103 | 104) : 101
          const rawLmt = Number(queryOf(req).get('lmt') ?? 0) || 0
          const lmt = Math.min(1000, Math.max(5, rawLmt)) || (klt === 101 ? 120 : klt === 102 ? 160 : klt === 103 ? 240 : 30)
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
          const secids = [...new Set(raw.split(',').map((x) => x.trim().toUpperCase()).filter((x) => SECID_RE.test(x)))].slice(0, 120)
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
          const secid = String(queryOf(req).get('secid') ?? '').toUpperCase()
          if (!SECID_RE.test(secid)) throw new Error('secid 非法')
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
          const secid = String(queryOf(req).get('secid') ?? '').toUpperCase()
          if (!SECID_RE.test(secid)) throw new Error('secid 非法')
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
          if (scope !== 'industry' && scope !== 'concept' && scope !== 'etf') throw new Error('scope 非法')
          if (sort !== 'pct' && sort !== 'money' && sort !== 'amount') throw new Error('sort 非法')
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
              throw new Error('patch 必须是对象')
            }
            const prefs = await store.setPrefs(patch as Parameters<DataStore['setPrefs']>[0])
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
