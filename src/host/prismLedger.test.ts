import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { DataStore } from './store.ts'
import { PrismStore } from './prismStore.ts'
import { PrismTradingStore, placeDecision, type QuoteLite } from './prismAccount.ts'
import { makePrismRoutes } from './prismRoutes.ts'
import type { PrismDecision } from '../shared/prism.ts'

const day = '2026-10-22'

const fakeData = (qty = 100, price = 1000): DataStore => ({
  portData: () => ({
    groups: [{ id: 'g1', name: '默认', order: 0 }],
    items: [{ id: 'p1', groupId: 'g1', secid: '1.600519', name: '贵州茅台', createdAt: 1 }],
  }),
  watchData: () => ({ groups: [], items: [] }),
  ledgerEntries: () => [
    { id: 'l1', ts: Date.parse(`${day}T09:30:00+08:00`), actor: 'web', verb: 'buy', groupId: 'g1', posId: 'p1', secid: '1.600519', name: '贵州茅台', qty, price },
  ],
} as unknown as DataStore)

const callGet = async (deps: { store: PrismStore; trading: PrismTradingStore; data: DataStore }): Promise<Record<string, unknown>> => {
  const route = makePrismRoutes({ ...deps, get: () => undefined, quotes: async () => ({}) }).find((r) => r.path === '/tradewatcher/prism')
  let text = ''
  const res = {
    setHeader: () => undefined,
    end: (s: string) => { text = s },
    statusCode: 200,
  } as unknown as ServerResponse
  await route?.handler({ method: 'GET' } as IncomingMessage, res)
  return JSON.parse(text) as Record<string, unknown>
}

test('① 首次读取即初始化账户：按成本复制、现金 = 150万 − Σ(qty×cost)、净值写一点', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'prism-init-'))
  try {
    const store = new PrismStore(dir)
    const trading = new PrismTradingStore(dir)
    await store.init()
    await trading.init()
    const body = await callGet({ store, trading, data: fakeData() })
    const state = body['state'] as Record<string, any>
    assert.notEqual(state['account']?.copiedAt, null, '首次读取必须初始化 copiedAt')
    assert.equal(state['account']?.positions?.[0]?.cost, 1000, '必须按成本价（不是现价）')
    assert.equal(state['account']?.cash, 1_400_000)
    assert.equal((state['equity'] as unknown[]).length, 1, '首次读取写一个净值点')
    // 第二次读取不重复复制、同日净值覆盖
    const again = await callGet({ store, trading, data: fakeData() })
    const s2 = again['state'] as Record<string, any>
    assert.equal(s2['account']?.copiedAt, state['account']?.copiedAt, '已初始化 ⇒ 不重复复制')
    assert.equal((s2['equity'] as unknown[]).length, 1, '同一交易日一个点')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('① 现金不足：只复制能覆盖的部分并留痕', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'prism-init2-'))
  try {
    const store = new PrismStore(dir)
    const trading = new PrismTradingStore(dir)
    await store.init()
    await trading.init()
    await trading.saveAccount({ ...trading.account(), capitalLimit: 50_000, cash: 50_000 })
    const body = await callGet({ store, trading, data: fakeData() })
    const account = (body['state'] as Record<string, any>)['account']
    assert.equal(account.positions[0].qty, 50, '5 万 / 1000 = 50 股')
    assert.equal(account.cash, 0)
    assert.match(String(account.copyLogs[0].note), /部分复制/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('⑤ 盘后下单 ⇒ rejects 有原因、订单 rejected（不静默）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'prism-after-'))
  try {
    const store = new PrismTradingStore(dir)
    await store.init()
    await store.saveAccount({ ...store.account(), day, cash: 1_500_000 })
    const decision: PrismDecision = {
      limits: { singlePct: 10, totalPct: 50, note: 'x' },
      orders: [{ secid: '1.600519', side: 'buy', price: 10, shares: 100, reason: '测试' }],
      cancel: [], rejects: [], parseError: null,
    }
    const quotes: Record<string, QuoteLite> = { '1.600519': { name: '贵州茅台', price: 10, prev: 10 } }
    const now = Date.parse('2026-10-22T17:05:00+08:00')
    const r = await placeDecision(store, decision, now, quotes)
    assert.equal(r.orders[0]?.status, 'rejected')
    assert.match(String(r.orders[0]?.rejectReason), /盘后不下单/)
    assert.equal(r.rejects.length, 1)
    assert.match(String(r.rejects[0]?.reason), /盘后不下单/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
