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
  data: DataStore
  get: (name: string) => unknown
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
  const quotes = await fetchQuotes(secids).catch(() => ({}))
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
  const news = deps.store.news().items.slice().sort((a, b) => (a.time < b.time ? 1 : -1))
  return { positions, quotes: quoteText, news, skeleton: deps.store.skeleton() }
}

const kickNews = (store: PrismStore): void => {
  const status = store.news().status
  const task = status.state === 'ready' ? incrementalNews(store) : backfillNews(store)
  void task.catch(() => undefined)
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
          send(res, 200, { ok: true, asOf: Date.now(), state: stateOf(store, deps.get) })
          return
        }
        if (req.method !== 'POST') {
          send(res, 405, { ok: false, error: 'method not allowed' })
          return
        }
        try {
          const body = (await readBody(req)) as { action?: unknown; times?: unknown; text?: unknown; slot?: unknown } | null
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
            const slot = typeof body?.slot === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(body.slot) ? body.slot : 'manual'
            const run = await runPrismForSlot(deps, slot)
            if (slot !== 'manual') await store.markFired(dayOf(Date.now()), slot)
            send(res, 200, { ok: true, asOf: Date.now(), run })
            return
          }
          send(res, 400, { ok: false, error: '未知 action' })
        } catch (error) {
          send(res, 500, { ok: false, error: String(error).slice(0, 160) })
        }
      },
    },
  ]
}
