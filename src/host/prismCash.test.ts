import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readFileSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { DataStore } from './store.ts'
import { PrismStore } from './prismStore.ts'
import { PrismTradingStore } from './prismAccount.ts'
import { makePrismRoutes } from './prismRoutes.ts'

const fakeData = (): DataStore => ({
  portData: () => ({
    groups: [{ id: 'g1', name: '默认', order: 0 }],
    items: [{ id: 'p1', groupId: 'g1', secid: '1.600519', name: '贵州茅台', createdAt: 1 }],
  }),
  watchData: () => ({ groups: [], items: [] }),
  ledgerEntries: () => [{ id: 'l1', ts: Date.parse('2026-10-22T09:30:00+08:00'), actor: 'web', verb: 'buy', groupId: 'g1', posId: 'p1', secid: '1.600519', name: '贵州茅台', qty: 100, price: 1000 }],
} as unknown as DataStore)

const quotes = async (): Promise<Record<string, { name: string; price: number; prev: number }>> => ({ '1.600519': { name: '贵州茅台', price: 1000, prev: 1000 } })

const routeOf = (store: PrismStore, trading: PrismTradingStore) =>
  makePrismRoutes({ store, trading, data: fakeData(), get: () => undefined, quotes: quotes as never })

const call = async (store: PrismStore, trading: PrismTradingStore, method: 'GET' | 'POST', body?: unknown): Promise<Record<string, any>> => {
  const route = routeOf(store, trading).find((r) => r.path === '/tradewatcher/prism')
  let text = ''
  const res = { setHeader: () => undefined, end: (s: string) => { text = s }, statusCode: 200 } as unknown as ServerResponse
  const req = method === 'GET'
    ? ({ method } as IncomingMessage)
    : ({ method, [Symbol.asyncIterator]: async function* () { yield Buffer.from(JSON.stringify(body)) } } as unknown as IncomingMessage)
  await route?.handler(req, res)
  return JSON.parse(text) as Record<string, any>
}

test('① capital 落 settings，3 次 GET 恒为新值；重启仍保留', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'prismcash-cap-'))
  try {
    let store = new PrismStore(dir)
    let trading = new PrismTradingStore(dir)
    await store.init(); await trading.init()
    await call(store, trading, 'POST', { action: 'copy' })
    const baseline = await call(store, trading, 'GET')
    const baseCash = baseline['trading']['account']['cash']
    const res = await call(store, trading, 'POST', { action: 'capital', capitalLimit: 2_000_000 })
    assert.equal(res['account']['capitalLimit'], 2_000_000)
    assert.equal(res['settings']['capital'], 2_000_000)
    const seen: Array<{ capital: number; cash: number }> = []
    for (let i = 0; i < 3; i += 1) {
      const got = await call(store, trading, 'GET')
      seen.push({ capital: got['trading']['account']['capitalLimit'], cash: got['trading']['account']['cash'] })
      await new Promise((r) => setTimeout(r, 2))
    }
    assert.deepEqual(seen.map((x) => x.capital), [2_000_000, 2_000_000, 2_000_000])
    assert.deepEqual(seen.map((x) => x.cash), [baseCash + 500_000, baseCash + 500_000, baseCash + 500_000])
    // 重启：settings + account 都保留
    store = new PrismStore(dir); trading = new PrismTradingStore(dir)
    await store.init(); await trading.init()
    const again = await call(store, trading, 'GET')
    assert.equal(again['state']['settings']['capital'], 2_000_000)
    assert.equal(again['trading']['account']['capitalLimit'], 2_000_000)
    assert.equal(again['trading']['account']['cash'], baseCash + 500_000)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('② GET 不写 account：现金/copiedAt/逐字节 account 三次相同', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'prismcash-get-'))
  try {
    const store = new PrismStore(dir); const trading = new PrismTradingStore(dir)
    await store.init(); await trading.init()
    await call(store, trading, 'POST', { action: 'copy' })
    const a = await call(store, trading, 'GET')
    const b = await call(store, trading, 'GET')
    assert.equal(a['trading']['account']['cash'], b['trading']['account']['cash'])
    assert.equal(a['trading']['account']['copiedAt'], b['trading']['account']['copiedAt'])
    assert.equal(JSON.stringify(a['trading']['account']), JSON.stringify(b['trading']['account']))
    assert.equal(a['state']['account']['cash'], a['trading']['account']['cash'])
    assert.equal(JSON.stringify(a['state']['account']), JSON.stringify(a['trading']['account']), '两处必须逐字节相同')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('③ copiedAt 非空后 GET 不复制；④ 入金只改上限与现金，不重置成本', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'prismcash-copy-'))
  try {
    const store = new PrismStore(dir); const trading = new PrismTradingStore(dir)
    await store.init(); await trading.init()
    const copied = await call(store, trading, 'POST', { action: 'copy' })
    const at = copied['account']['copiedAt']
    const positions = JSON.stringify(copied['account']['positions'])
    const g1 = await call(store, trading, 'GET')
    assert.equal(g1['trading']['account']['copiedAt'], at)
    const dep = await call(store, trading, 'POST', { action: 'capital', capitalLimit: 2_000_000 })
    assert.equal(dep['account']['copiedAt'], at)
    assert.equal(JSON.stringify(dep['account']['positions']), positions)
    assert.equal(dep['account']['cash'], copied['account']['cash'] + 500_000)
    const dep2 = await call(store, trading, 'POST', { action: 'capital', capitalLimit: 2_000_000 })
    assert.equal(dep2['account']['cash'], dep['account']['cash'], '同值再存不得重复加现金')
    assert.equal(trading.account().copiedAt, at)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('⑤ 源码：GET 分支不得 saveAccount / 重算 cash / 自动复制（注入 ⇒ 败）', () => {
  const src = readFileSync(join(process.cwd(), 'src/host/prismRoutes.ts'), 'utf8')
  const start = src.indexOf("if (req.method === 'GET')")
  const end = src.indexOf("if (req.method !== 'POST')", start)
  const get = src.slice(start, end)
  assert.equal(/saveAccount|ensureAccount|copyAtCost/.test(get), false)
  const injected = get.replace('await recordEquity(deps)', "await deps.trading.saveAccount({ ...deps.trading.account(), cash: 1 })")
  assert.notEqual(injected, get)
  assert.throws(() => assert.equal(/saveAccount|ensureAccount|copyAtCost/.test(injected), false, '注入：GET 写 account'), /注入/)
})
