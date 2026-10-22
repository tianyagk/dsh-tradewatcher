/**
 * 棱镜（第 9 行）的路由：**只有一条** `/tradewatcher/prism`。
 *
 * GET  → 首屏状态（设置/骨架/新闻/最近运行/默认模型）
 * POST → `{action}`：
 *   · `settings` `{times}` 保存时点（可增删，≤50）
 *   · `skeleton` `{text}`  保存骨架（≤20 000 字）
 *   · `news`               立即同步金十（首次回填 24h / 之后增量）
 *   · `run` `{slot}`        手动补跑指定时点（只跑这一轮）
 *
 * 五类操作复用同一条路径 ⇒ 路由账只 +1（用户裁决：30 → 31）。
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { PluginWebRoute } from './context.ts'
import type { PrismStore } from './prismStore.ts'
import { PrismTradingStore, copyAtCost, equityPointOf, matchTick, placeDecision, upsertEquity, type QuoteLite } from './prismAccount.ts'
import type { DataStore } from './store.ts'
import type { PrismSettings, PrismState } from '../shared/prism.ts'
import { PRISM_MAX_TIMES, PRISM_SKELETON_MAX } from '../shared/prism.ts'
import { backfillNews, incrementalNews } from './prismNews.ts'
import { runPrismAnalysis, type PrismInputs } from './prismPipeline.ts'
import { fetchQuotes } from './em.ts'
import { assemblePortfolio } from './portfolio.ts'
import { dayOf } from './time.ts'

export interface PrismRouteDeps {
  store: PrismStore
  trading: PrismTradingStore
  data: DataStore
  get: (name: string) => unknown
  /** 测试注入；缺省走既有 `fetchQuotes`（不新增源） */
  quotes?: typeof fetchQuotes
}

const send = (res: ServerResponse, status: number, body: unknown): void => {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(JSON.stringify(body))
}

const readBody = async (req: IncomingMessage): Promise<unknown> => {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string)
    size += buf.length
    if (size > 1_000_000) throw new Error('body too large')
    chunks.push(buf)
  }
  const text = Buffer.concat(chunks).toString('utf8').trim()
  if (text === '') return null
  return JSON.parse(text) as unknown
}

export const prismInputsOf = async (deps: PrismRouteDeps): Promise<PrismInputs> => {
  const watch = deps.data.watchData().items
  const port = deps.data.portData()
  const secids = [...new Set([...watch.map((w) => w.secid), ...port.items.map((p) => p.secid)])]
  const quotes = await loadQuotes(deps, secids).catch(() => ({}))
  const assembly = assemblePortfolio(port.groups, port.items, deps.data.ledgerEntries(), quotes)
  const positions = assembly.view.positions
    .filter((p) => p.qty > 0)
    .map((p) => `${p.name}（${p.secid}）：${p.qty} 股，成本 ${p.avgCost.toFixed(3)}`)
    .join('\n')
  const quoteText = secids
    .map((secid) => {
      const q = quotes[secid]
      if (q === undefined || q.price === null) return `${secid}：—（未取到行情）`
      return `${q.name ?? secid}：${q.price}（${q.pct === null ? '—' : `${q.pct.toFixed(2)}%`}）`
    })
    .join('\n')
  const pending = deps.trading.orders().filter((o) => o.status === 'pending')
  const pendingText = pending.length === 0
    ? '—'
    : pending.map((o) => `${o.id} ${o.side === 'buy' ? '买' : '卖'} ${o.name} ${o.shares}@${o.price}`).join('\n')
  const news = deps.store.news().items.slice().sort((a, b) => (a.time < b.time ? 1 : -1))
  return { positions, quotes: `${quoteText}\n【待成交挂单】\n${pendingText}`, news, skeleton: deps.store.skeleton() }
}

const kickNews = (store: PrismStore): void => {
  if (process.env.NODE_TEST_CONTEXT !== undefined) return
  const status = store.news().status
  const task = status.state === 'ready' ? incrementalNews(store) : backfillNews(store)
  void task.catch(() => undefined)
}

const loadQuotes = (deps: PrismRouteDeps, secids: string[]): Promise<Record<string, import('../shared/model.ts').QuoteRow>> =>
  (deps.quotes ?? fetchQuotes)(secids)

const quoteLiteOf = async (deps: PrismRouteDeps, secids: string[]): Promise<Record<string, QuoteLite>> => {
  const rows = await loadQuotes(deps, secids).catch(() => ({}))
  const out: Record<string, QuoteLite> = {}
  for (const secid of secids) {
    const q = rows[secid]
    if (q !== undefined) out[secid] = { name: q.name, price: q.price, prev: q.prev }
  }
  return out
}

const copyRowsOf = async (deps: PrismRouteDeps): Promise<Array<{ secid: string; name: string; qty: number; cost: number }>> => {
  const port = deps.data.portData()
  const secids = port.items.map((p) => p.secid)
  const quotes = await fetchQuotes(secids).catch(() => ({}))
  const view = assemblePortfolio(port.groups, port.items, deps.data.ledgerEntries(), quotes).view
  return view.positions.filter((p) => p.qty > 0).map((p) => ({ secid: p.secid, name: p.name, qty: p.qty, cost: p.avgCost }))
}

/** 首次读取/研判前初始化：按真实成本复制，现金不足则部分复制并留痕 */
const ensureAccount = async (deps: PrismRouteDeps): Promise<ReturnType<PrismTradingStore['account']>> => {
  const account = deps.trading.account()
  if (account.copiedAt !== null) return account
  const rows = await copyRowsOf(deps)
  const result = copyAtCost(rows, account, Date.now())
  await deps.trading.saveAccount(result.account)
  return result.account
}

/** 每天一个净值点（缺价按成本）；GET/研判/复制后都写，同日覆盖 */
const recordEquity = async (deps: PrismRouteDeps, now = Date.now()): Promise<void> => {
  const account = deps.trading.account()
  const quotes = await quoteLiteOf(deps, account.positions.map((p) => p.secid)).catch(() => ({}))
  const point = equityPointOf(account, (secid) => quotes[secid]?.price ?? null, now)
  await deps.trading.saveEquity(upsertEquity(deps.trading.equity(), point))
}

const stateOf = (store: PrismStore, get: (n: string) => unknown): PrismState => {
  let provider: string | null = null
  let model: string | null = null
  let error: string | null = null
  try {
    const sel = get('agentDefaultModel') as { currentSelection?: () => { provider?: unknown; model?: unknown } } | undefined
    const picked = sel?.currentSelection?.()
    if (typeof picked?.provider === 'string' && typeof picked?.model === 'string') {
      provider = picked.provider
      model = picked.model
    } else {
      error = '没有默认模型（agentDefaultModel.currentSelection 为空）'
    }
  } catch (e) {
    error = `默认模型不可读（${String(e).slice(0, 80)}）`
  }
  const news = store.news()
  return {
    settings: store.settings(),
    skeleton: store.skeleton(),
    news: news.status,
    runs: store.runs(),
    model: { provider, model, error },
  }
}

const tradingOf = (trading: PrismTradingStore, prices: Record<string, number | null> = {}): {
  account: ReturnType<PrismTradingStore['account']>
  orders: ReturnType<PrismTradingStore['orders']>
  fills: ReturnType<PrismTradingStore['fills']>
  equity: ReturnType<PrismTradingStore['equity']>
  decision: ReturnType<PrismStore['runs']>[number]['decision'] | null
  prices: Record<string, number | null>
} => ({
  account: trading.account(),
  orders: trading.orders(),
  fills: trading.fills(),
  equity: trading.equity(),
  decision: trading === undefined ? null : null,
  prices,
})

export async function runPrismForSlot(deps: PrismRouteDeps, slot: string): Promise<Awaited<ReturnType<typeof runPrismAnalysis>>> {
  const inputs = await prismInputsOf(deps)
  return runPrismAnalysis(deps.store, slot, inputs, { get: deps.get })
}

export function makePrismRoutes(deps: PrismRouteDeps): PluginWebRoute[] {
  const { store } = deps
  return [
    {
      kind: 'exact',
      path: '/tradewatcher/prism',
      handler: async (req, res) => {
        if (req.method === 'GET') {
          kickNews(store)
          await ensureAccount(deps)
          await recordEquity(deps)
          const account = deps.trading.account()
          const quotes = await quoteLiteOf(deps, account.positions.map((p) => p.secid)).catch(() => ({}))
          const prices: Record<string, number | null> = {}
          for (const p of account.positions) prices[p.secid] = quotes[p.secid]?.price ?? null
          const trading = tradingOf(deps.trading, prices)
          const latestDecision = store.runs().at(-1)?.decision ?? null
          const tradingWithDecision = { ...trading, decision: latestDecision }
          // 顶层 `state` 也带模拟盘字段（旧消费者读 state.account；页面读 trading）
          send(res, 200, { ok: true, asOf: Date.now(), state: { ...stateOf(store, deps.get), ...tradingWithDecision }, trading: tradingWithDecision })
          return
        }
        if (req.method !== 'POST') {
          send(res, 405, { ok: false, error: 'method not allowed' })
          return
        }
        try {
          const body = (await readBody(req)) as { action?: unknown; times?: unknown; text?: unknown; slot?: unknown; capitalLimit?: unknown; orderId?: unknown } | null
          const action = body !== null && typeof body.action === 'string' ? body.action : ''
          if (action === 'settings') {
            const raw = body !== null && Array.isArray(body.times) ? body.times : null
            if (raw === null) {
              send(res, 400, { ok: false, error: 'times 必须是 HH:MM 数组' })
              return
            }
            if (raw.length > PRISM_MAX_TIMES) {
              send(res, 400, { ok: false, error: `时点最多 ${PRISM_MAX_TIMES} 个` })
              return
            }
            const times = raw.filter((t): t is string => typeof t === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(t))
            if (times.length !== raw.length) {
              send(res, 400, { ok: false, error: '存在非法时点（HH:MM）' })
              return
            }
            const settings: PrismSettings = await store.saveTimes(times)
            send(res, 200, { ok: true, settings })
            return
          }
          if (action === 'skeleton') {
            const text = body !== null && typeof body.text === 'string' ? body.text : null
            if (text === null) {
              send(res, 400, { ok: false, error: 'text 必须是字符串' })
              return
            }
            if (text.length > PRISM_SKELETON_MAX) {
              send(res, 400, { ok: false, error: `骨架最多 ${PRISM_SKELETON_MAX} 字` })
              return
            }
            await store.saveSkeleton(text)
            send(res, 200, { ok: true, text })
            return
          }
          if (action === 'news') {
            const status = store.news().status.state === 'ready'
              ? await incrementalNews(store).catch(() => store.news().status)
              : await backfillNews(store).catch(() => store.news().status)
            send(res, 200, { ok: true, asOf: Date.now(), status })
            return
          }
          if (action === 'run') {
            await ensureAccount(deps)
            const slot = typeof body?.slot === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(body.slot) ? body.slot : 'manual'
            const run = await runPrismForSlot(deps, slot)
            let placed: ReturnType<PrismTradingStore['orders']> = []
            if (run.decision !== null) {
              const quotes = run.decision.orders.length > 0 ? await quoteLiteOf(deps, run.decision.orders.map((o) => o.secid)) : {}
              const result = await placeDecision(deps.trading, run.decision, Date.now(), quotes)
              placed = result.orders
              run.decision = { ...run.decision, rejects: result.rejects }
              await store.replaceRun(run)
            }
            await recordEquity(deps)
            if (slot !== 'manual') await store.markFired(dayOf(Date.now()), slot)
            send(res, 200, { ok: true, asOf: Date.now(), run, orders: placed })
            return
          }
          if (action === 'capital') {
            await ensureAccount(deps)
            const limit = Number(body?.capitalLimit)
            if (!Number.isFinite(limit) || limit <= 0) {
              send(res, 400, { ok: false, error: '资金上限必须是正数' })
              return
            }
            const account = deps.trading.account()
            const next = { ...account, capitalLimit: limit, cash: Math.round((account.cash + (limit - account.capitalLimit)) * 100) / 100 }
            await deps.trading.saveAccount(next)
            send(res, 200, { ok: true, account: next })
            return
          }
          if (action === 'copy') {
            const rows = await copyRowsOf(deps)
            const result = copyAtCost(rows, deps.trading.account(), Date.now())
            await deps.trading.saveAccount(result.account)
            await recordEquity(deps)
            send(res, 200, { ok: true, account: result.account, log: result.log, skipped: result.skipped })
            return
          }
          if (action === 'cancel') {
            const orderId = typeof body?.orderId === 'string' ? body.orderId : ''
            const orders = deps.trading.orders()
            const order = orders.find((o) => o.id === orderId && o.status === 'pending')
            if (order === undefined) {
              send(res, 200, { ok: false, error: '没有可撤销的挂单' })
              return
            }
            order.status = 'cancelled'
            order.cancelledAt = Date.now()
            order.cancelReason = '手动撤销'
            await deps.trading.saveOrders(orders, deps.trading.fills())
            send(res, 200, { ok: true, orders })
            return
          }
          if (action === 'match') {
            const result = await matchTick(deps.trading, {
              quotes: (secids) => quoteLiteOf(deps, secids),
              bars: (secid, day) => import('./prismAccount.ts').then((m) => m.fetchOneMinuteBars(secid, day)),
            })
            send(res, 200, { ok: true, ...result, trading: tradingOf(deps.trading) })
            return
          }
          send(res, 400, { ok: false, error: '未知 action' })
        } catch (error) {
          send(res, 500, { ok: false, error: String(error).slice(0, 160) })
        }
      },
    },
    {
      kind: 'exact',
      path: '/tradewatcher/prism/selftest',
      handler: async (_req, res) => {
        const started = Date.now()
        let ok = false
        let error: string | null = null
        let model: string | null = null
        let text: string | null = null
        let chunks: Array<{ type: string; keys: string[] }> = []
        try {
          const resolved = await import('./prismLlm.ts').then((m) => m.resolvePrismModel(deps.get))
          if (resolved.llm === null || resolved.info.provider === null || resolved.info.model === null) {
            error = resolved.info.error ?? '模型不可用'
          } else {
            model = `${resolved.info.provider} / ${resolved.info.model}`
            const r = await import('./prismLlm.ts').then((m) =>
              m.streamText(resolved.llm as never, { provider: resolved.info.provider as string, model: resolved.info.model as string },
                [{ role: 'user', content: '只回复 OK' }], undefined, AbortSignal.timeout(20_000)),
            )
            ok = r.text !== null && r.error === null
            text = r.text
            chunks = r.chunks
            error = r.error
          }
        } catch (e) {
          error = String(e).slice(0, 200)
        }
        send(res, 200, { ok, error, model, elapsedMs: Date.now() - started, text, chunks })
      },
    },
  ]
}
