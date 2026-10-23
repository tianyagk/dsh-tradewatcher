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
import { PrismTradingStore, copyAtCost, equityPointOf, matchTick, placeDecision, rebuildFromOrders, upsertEquity, type QuoteLite } from './prismAccount.ts'
import type { DataStore } from './store.ts'
import type { PrismAccount, PrismFill, PrismSettings, PrismState } from '../shared/prism.ts'
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

/** 账户快照：七项数字/单位必须同时出现（提示词用，缺项写 — 与原因） */
export function accountSnapshotOf(
  account: PrismAccount,
  prices: Readonly<Record<string, number | null>>,
  fills: readonly PrismFill[],
  pendingCount: number,
  now: number = Date.now(),
): string {
  const value = account.positions.reduce((sum, p) => sum + p.qty * (prices[p.secid] ?? p.cost), 0)
  const total = account.cash + value
  const weight = total > 0 ? (value / total) * 100 : null
  const today = dayOf(now)
  const filledToday = fills.filter((f) => dayOf(f.at) === today).length
  return [
    `总资产：${total.toFixed(2)} 元`,
    `现金：${account.cash.toFixed(2)} 元`,
    `持仓市值：${value.toFixed(2)} 元`,
    `当前仓位占比：${weight === null ? '—（总资产为 0）' : `${weight.toFixed(2)}%`}`,
    `可买额度：${account.cash.toFixed(2)} 元`,
    `当日已成交笔数：${filledToday} 笔`,
    `未成交挂单：${pendingCount} 笔`,
  ].join('\n')
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
  const account = deps.trading.account()
  const accountPrices: Record<string, number | null> = {}
  for (const p of account.positions) accountPrices[p.secid] = quotes[p.secid]?.price ?? null
  const accountSnapshot = accountSnapshotOf(account, accountPrices, deps.trading.fills(), pending.length)
  const pendingText = pending.length === 0
    ? '—'
    : pending.map((o) => `${o.id} ${o.side === 'buy' ? '买' : '卖'} ${o.name} ${o.shares}@${o.price}`).join('\n')
  const news = deps.store.news().items.slice().sort((a, b) => (a.time < b.time ? 1 : -1))
  return { positions, account: accountSnapshot, quotes: `${quoteText}\n【待成交挂单】\n${pendingText}`, news, skeleton: deps.store.skeleton() }
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
  const quotes = await loadQuotes(deps, secids).catch(() => ({}))
  const view = assemblePortfolio(port.groups, port.items, deps.data.ledgerEntries(), quotes).view
  // 用户口径：复制主插件**摊薄成本**（不是移动加权 avgCost）
  return view.positions.filter((p) => p.qty > 0).map((p) => ({ secid: p.secid, name: p.name, qty: p.qty, cost: p.dilutedCost ?? p.avgCost }))
}

/** 每天一个净值点（缺价按成本）；GET/研判/复制后都写，同日覆盖 */
const recordEquity = async (deps: PrismRouteDeps, now = Date.now()): Promise<void> => {
  const account = deps.trading.account()
  const quotes = await quoteLiteOf(deps, account.positions.map((p) => p.secid)).catch(() => ({}))
  const point = equityPointOf(account, (secid) => quotes[secid]?.price ?? null, now)
  await deps.trading.saveEquity(upsertEquity(deps.trading.equity(), point))
}

interface ModelCatalog {
  providers: Array<{ id: string; name: string }>
  models: Record<string, string[]>
  error: string | null
}

let catalogCache: { at: number; value: ModelCatalog } | null = null

/** 宿主可用模型（60s 缓存）；拿不到 ⇒ providers 空 + error（页面退化为自由输入） */
const modelCatalogOf = async (get: (n: string) => unknown): Promise<ModelCatalog> => {
  if (catalogCache !== null && Date.now() - catalogCache.at < 60_000) return catalogCache.value
  try {
    const llm = get('llm') as {
      listProviders?: () => Array<{ id?: unknown; name?: unknown }>
      listModels?: (provider: string) => Promise<Array<{ id?: unknown }>>
    } | undefined
    const providers = (llm?.listProviders?.() ?? [])
      .filter((p): p is { id: string; name?: unknown } => typeof p.id === 'string')
      .map((p) => ({ id: p.id, name: typeof p.name === 'string' ? p.name : p.id }))
    const models: Record<string, string[]> = {}
    if (typeof llm?.listModels === 'function') {
      for (const p of providers) {
        try {
          models[p.id] = (await llm.listModels(p.id)).map((m) => m.id).filter((id): id is string => typeof id === 'string')
        } catch {
          models[p.id] = []
        }
      }
    }
    const value: ModelCatalog = { providers, models, error: providers.length === 0 ? '宿主没有可用 provider 列表（可自由输入）' : null }
    catalogCache = { at: Date.now(), value }
    return value
  } catch (error) {
    const value: ModelCatalog = { providers: [], models: {}, error: `模型列表不可读（${String(error).slice(0, 80)}）` }
    catalogCache = { at: Date.now(), value }
    return value
  }
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
  const run = await runPrismAnalysis(deps.store, slot, inputs, { get: deps.get, model: deps.store.settings().model ?? null })
  if (run.decision === null) {
    run.placement = { placed: 0, skipped: 0, rejects: [] }
    await deps.store.replaceRun(run)
    return run
  }
  const quotes = run.decision.orders.length > 0 ? await quoteLiteOf(deps, run.decision.orders.map((o) => o.secid)) : {}
  const result = await placeDecision(deps.trading, run.decision, Date.now(), quotes)
  run.decision = { ...run.decision, rejects: result.rejects }
  run.placement = result.placement
  await deps.store.replaceRun(run)
  return run
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
          await recordEquity(deps)
          const account = deps.trading.account()
          const quotes = await quoteLiteOf(deps, account.positions.map((p) => p.secid)).catch(() => ({}))
          const prices: Record<string, number | null> = {}
          for (const p of account.positions) prices[p.secid] = quotes[p.secid]?.price ?? null
          const trading = tradingOf(deps.trading, prices)
          const latestDecision = store.runs().at(-1)?.decision ?? null
          const tradingWithDecision = { ...trading, decision: latestDecision }
          const modelCatalog = await modelCatalogOf(deps.get)
          // 顶层 `state` 也带模拟盘字段（旧消费者读 state.account；页面读 trading）
          send(res, 200, {
            ok: true,
            asOf: Date.now(),
            state: { ...stateOf(store, deps.get), ...tradingWithDecision, modelCatalog },
            trading: tradingWithDecision,
            modelCatalog,
          })
          return
        }
        if (req.method !== 'POST') {
          send(res, 405, { ok: false, error: 'method not allowed' })
          return
        }
        try {
          const body = (await readBody(req)) as { action?: unknown; times?: unknown; text?: unknown; slot?: unknown; capitalLimit?: unknown; orderId?: unknown; provider?: unknown; model?: unknown } | null
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
          if (action === 'model') {
            const provider = typeof body?.provider === 'string' ? body.provider.trim() : ''
            const model = typeof body?.model === 'string' ? body.model.trim() : ''
            if (provider === '' || model === '') {
              send(res, 400, { ok: false, error: 'provider 和 model 都必须填写' })
              return
            }
            const catalog = await modelCatalogOf(deps.get)
            if (catalog.providers.length > 0 && !catalog.providers.some((p) => p.id === provider)) {
              send(res, 400, { ok: false, error: `未知 provider「${provider}」（可用：${catalog.providers.map((p) => p.id).join(' / ')}）` })
              return
            }
            const settings = await store.saveModel(provider, model)
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
            const slot = typeof body?.slot === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(body.slot) ? body.slot : 'manual'
            const run = await runPrismForSlot(deps, slot)
            await recordEquity(deps)
            if (slot !== 'manual') await store.markFired(dayOf(Date.now()), slot)
            send(res, 200, { ok: true, asOf: Date.now(), run, orders: deps.trading.orders() })
            return
          }
          if (action === 'capital') {
            const limit = Number(body?.capitalLimit)
            if (!Number.isFinite(limit) || limit <= 0) {
              send(res, 400, { ok: false, error: '资金上限必须是正数' })
              return
            }
            const account = deps.trading.account()
            const cash = Math.round((account.cash + (limit - account.capitalLimit)) * 100) / 100
            if (cash < 0) {
              send(res, 400, { ok: false, error: '资金上限低于当前持仓成本 + 已用现金，不能把现金改为负数' })
              return
            }
            const next = { ...account, capitalLimit: limit, cash }
            await deps.trading.saveAccount(next)
            const settings = await store.saveCapital(limit)
            send(res, 200, { ok: true, account: next, settings })
            return
          }
          if (action === 'copy') {
            const rows = await copyRowsOf(deps)
            const result = copyAtCost(rows, deps.trading.account(), Date.now())
            await deps.trading.saveAccount(result.account, { explicitReset: true })
            const settings = await store.saveCapital(result.account.capitalLimit)
            await recordEquity(deps)
            send(res, 200, { ok: true, account: result.account, settings, log: result.log, skipped: result.skipped })
            return
          }
          if (action === 'recover') {
            const account = deps.trading.account()
            const rebuilt = rebuildFromOrders(account, deps.trading.orders())
            send(res, 200, { ok: true, rebuilt: true, fills: rebuilt.fills, cash: rebuilt.cash, note: rebuilt.note })
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
          const resolved = await import('./prismLlm.ts').then((m) => m.resolvePrismModel(deps.get, deps.store.settings().model ?? null))
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
