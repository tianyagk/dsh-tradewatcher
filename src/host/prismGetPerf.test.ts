/**
 * P2-7（AUDIT-HOST-PERF）：`GET /tradewatcher/prism` 不再每 30 s 做重活。
 *
 * 断言口径（页面开着时 2 880 次/日）：
 *   ① 连续 5 次 GET（数据没变）⇒ `saveEquity` 0 次、`reloadOrders` 真读盘 0 次、行业请求 0 次；
 *   ② 账户现金变了 ⇒ 净值点写 1 次；
 *   ③ 委托文件变了（别的进程写入）⇒ 真读盘 1 次，且新委托立刻可见；
 *   ④ 持仓 secid 集合变了 ⇒ 行业请求 1 次。
 *
 * 全部上游都注入（行情 / 行业 / 基准 K 线），不联网、不读用户目录。
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { DataStore } from './store.ts'
import type { QuoteRow } from '../shared/model.ts'
import type { PrismOrder } from '../shared/prism.ts'
import { PrismStore } from './prismStore.ts'
import { PrismTradingStore } from './prismAccount.ts'
import { makePrismRoutes, type PrismRouteDeps } from './prismRoutes.ts'

const fakeData = (): DataStore => ({
  portData: () => ({
    groups: [{ id: 'g1', name: '默认', order: 0 }],
    items: [
      { id: 'p1', groupId: 'g1', secid: '1.600519', name: '贵州茅台', createdAt: 1 },
      { id: 'p2', groupId: 'g1', secid: '1.510300', name: '沪深300ETF', createdAt: 2 },
    ],
  }),
  watchData: () => ({ groups: [], items: [] }),
  ledgerEntries: () => [
    { id: 'l1', ts: Date.parse('2026-10-22T09:30:00+08:00'), actor: 'web', verb: 'buy', groupId: 'g1', posId: 'p1', secid: '1.600519', name: '贵州茅台', qty: 100, price: 1000 },
    { id: 'l2', ts: Date.parse('2026-10-22T09:30:00+08:00'), actor: 'web', verb: 'buy', groupId: 'g1', posId: 'p2', secid: '1.510300', name: '沪深300ETF', qty: 10_000, price: 4 },
  ],
} as unknown as DataStore)

interface Harness {
  deps: PrismRouteDeps
  trading: PrismTradingStore
  get(): Promise<Record<string, any>>
  post(body: unknown): Promise<Record<string, any>>
  counts: { saveEquity: number; quotes: number; industry: number; kline: number }
}

async function harness(dir: string): Promise<Harness> {
  const store = new PrismStore(dir)
  const trading = new PrismTradingStore(dir)
  await store.init()
  await trading.init()
  const counts = { saveEquity: 0, quotes: 0, industry: 0, kline: 0 }
  const priceOf: Record<string, { price: number; prev: number }> = {
    '1.600519': { price: 1000, prev: 990 },
    '1.510300': { price: 4, prev: 3.98 },
    '1.000001': { price: 3, prev: 3 },
  }
  const deps: PrismRouteDeps = {
    store,
    trading,
    data: fakeData(),
    get: () => undefined,
    quotes: (async (secids: string[]) => {
      counts.quotes += 1
      const out: Record<string, QuoteRow> = {}
      for (const secid of secids) {
        const p = priceOf[secid]
        if (p !== undefined) out[secid] = { secid, name: secid, price: p.price, prev: p.prev, pct: 0, chg: 0 } as never
      }
      return out
    }) as never,
    industry: (async (secids: string[]) => {
      counts.industry += 1
      return Object.fromEntries(secids.map((s) => [s, { name: '测试行业', pct: 1.5 }]))
    }) as never,
    kline: (async () => {
      counts.kline += 1
      return { days: [{ close: 4000 }] }
    }) as never,
  }
  const route = makePrismRoutes(deps).find((r) => r.path === '/tradewatcher/prism')
  if (route === undefined) throw new Error('未找到棱镜路由')
  // 净值写盘计数：包一层（生产代码不加计数器，测试从外面观察）
  const realSaveEquity = trading.saveEquity.bind(trading)
  trading.saveEquity = async (points) => {
    counts.saveEquity += 1
    return realSaveEquity(points)
  }
  const call = async (method: 'GET' | 'POST', body?: unknown): Promise<Record<string, any>> => {
    let text = ''
    const res = {
      statusCode: 200,
      setHeader: () => undefined,
      end: (s: string) => { text = s },
    } as unknown as ServerResponse
    const req = method === 'GET'
      ? ({ method, url: '/tradewatcher/prism', headers: { host: '127.0.0.1:3080' } } as unknown as IncomingMessage)
      : ({
          method,
          url: '/tradewatcher/prism',
          headers: { host: '127.0.0.1:3080', 'content-type': 'application/json' },
          async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify(body)) },
        } as unknown as IncomingMessage)
    await route.handler(req, res)
    return JSON.parse(text) as Record<string, any>
  }
  return {
    deps,
    trading,
    counts,
    get: () => call('GET'),
    post: (body) => call('POST', body),
  }
}

test('P2-7 连续 5 次 GET（同数据）⇒ equity 写 0、orders 读盘 0、行业请求 0', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'prism-perf-p27-'))
  try {
    const h = await harness(dir)
    const copied = await h.post({ action: 'copy' })
    assert.equal(copied['ok'], true)
    // 预热一次：装载委托、写第一个净值点、取一次行业
    const warm = await h.get()
    assert.equal(warm['ok'], true)
    const read0 = h.trading.ordersIo.read
    const cached0 = h.trading.ordersIo.cached
    const save0 = h.counts.saveEquity
    const industry0 = h.counts.industry
    const quotes0 = h.counts.quotes
    const kline0 = h.counts.kline

    for (let i = 0; i < 5; i += 1) {
      const res = await h.get()
      assert.equal(res['ok'], true)
    }
    assert.equal(h.counts.saveEquity - save0, 0, `同数据 5 次 GET 不得写净值（实测 ${h.counts.saveEquity - save0} 次）`)
    assert.equal(h.trading.ordersIo.read - read0, 0, `同数据 5 次 GET 不得重读 195KB 委托文件（实测 ${h.trading.ordersIo.read - read0} 次）`)
    assert.equal(h.trading.ordersIo.cached - cached0, 5, '5 次 GET 应全部命中 mtime+size 缓存')
    assert.equal(h.counts.industry - industry0, 0, `同持仓集合 5 次 GET 不得请求行业（实测 ${h.counts.industry - industry0} 次）`)
    // 顺带：行情只取一份（旧实现 recordEquity + 价格各取一次 = 10 次）
    assert.equal(h.counts.quotes - quotes0, 5, `每次 GET 只取一次行情（实测 ${h.counts.quotes - quotes0} 次/5 GET）`)
    // 跳过写盘时连基准 K 线也不取（旧实现每次 GET 都 fetchKline 1.000300）
    assert.equal(h.counts.kline - kline0, 0, `净值没变时不得取基准 K 线（实测 ${h.counts.kline - kline0} 次）`)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('P2-7 数据变化 ⇒ 各自触发 1 次（cash → equity 写；委托文件 → 读盘；持仓集合 → 行业）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'prism-perf-p27b-'))
  try {
    const h = await harness(dir)
    await h.post({ action: 'copy' })
    await h.get()
    const save0 = h.counts.saveEquity
    const industry0 = h.counts.industry

    // ① 现金变了 ⇒ 同日净值点变化 ⇒ 写 1 次
    const account = h.trading.account()
    await h.trading.saveAccount({ ...account, cash: account.cash + 123.45 })
    const afterCash = await h.get()
    assert.equal(afterCash['ok'], true)
    assert.equal(h.counts.saveEquity - save0, 1, '现金变化后必须写 1 次净值')
    assert.equal(h.counts.industry - industry0, 0, '持仓集合没变 ⇒ 行业仍走缓存')

    // ② 委托文件被别的进程写入 ⇒ 读盘 1 次，新委托立刻可见
    const ordersFile = join(dir, 'prism-orders.json')
    const root = JSON.parse(await readFile(ordersFile, 'utf8')) as { orders: PrismOrder[]; fills: unknown[] }
    const extra: PrismOrder = {
      id: 'ord-external-1', secid: '1.600519', name: '贵州茅台', side: 'buy', price: 900, shares: 100,
      reason: '外部进程写入', decidedAt: Date.now(), day: h.trading.account().day || '2026-11-23', status: 'pending',
    }
    await writeFile(ordersFile, JSON.stringify({ v: 1, orders: [...root.orders, extra], fills: root.fills }), 'utf8')
    const readBefore = h.trading.ordersIo.read
    const afterOrders = await h.get()
    assert.equal(h.trading.ordersIo.read - readBefore, 1, '委托文件变了必须重读 1 次')
    assert.ok((afterOrders['state']['orders'] as PrismOrder[]).some((o) => o.id === extra.id), '新委托必须立刻出现在 GET 回包里')

    // ③ 持仓 secid 集合变了 ⇒ 行业请求 1 次（净值不变 ⇒ 不写盘）
    const acc2 = h.trading.account()
    const saveBefore = h.counts.saveEquity
    await h.trading.saveAccount({ ...acc2, positions: [...acc2.positions, { secid: '1.000001', name: '上证指数ETF', qty: 0, available: 0, cost: 0 }] })
    const afterSet = await h.get()
    assert.equal(afterSet['ok'], true)
    assert.equal(h.counts.industry - industry0, 1, '持仓集合变化后必须重新取 1 次行业')
    assert.equal(h.counts.saveEquity - saveBefore, 0, 'qty=0 的新持仓不改变净值 ⇒ 不写盘')
    // 行业缓存键跟随集合：再 GET 一次仍然 0 次新增
    const industryNow = h.counts.industry
    await h.get()
    assert.equal(h.counts.industry - industryNow, 0, '集合稳定后回到缓存命中')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
