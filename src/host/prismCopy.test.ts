import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { PrismStore } from './prismStore.ts'
import { PrismTradingStore } from './prismAccount.ts'
import { makePrismRoutes } from './prismRoutes.ts'

type CopyRow = readonly [string, string, number, number]
const rows: readonly CopyRow[] = [
  ['1.688825', '长鑫科技', 5000, 42.64],
  ['1.588170', '科创半导体ETF华夏', 600000, 0.86],
  ['1.518880', '黄金ETF华安', 5000, 8.89],
  ['1.601872', '招商轮船', 15000, 19.39],
  ['1.688035', '德邦科技', 4000, 72.36],
  ['1.510300', '沪深300ETF华泰柏瑞', 65000, 4.33],
  ['1.600573', '惠泉啤酒', 2000, 13.47],
  ['1.560010', '中证1000ETF广发', 85000, 2.89],
] as const
const REQUIRED = 1_907_980

const fakeData = (list: readonly CopyRow[] = rows) => ({
  portData: () => ({
    groups: [{ id: 'g1', name: '默认', order: 0 }],
    items: list.map(([secid, name], i) => ({ id: `p${i}`, groupId: 'g1', secid, name, createdAt: 1 })),
  }),
  watchData: () => ({ groups: [], items: [] }),
  ledgerEntries: () => list.map(([secid, name, qty, cost], i) => ({ id: `l${i}`, ts: 1, actor: 'web', verb: 'buy', groupId: 'g1', posId: `p${i}`, secid, name, qty, price: cost })),
})

const call = async (store: PrismStore, trading: PrismTradingStore, data: ReturnType<typeof fakeData>, body: unknown): Promise<Record<string, any>> => {
  const route = makePrismRoutes({ store, trading, data: data as never, get: () => undefined, quotes: (async () => ({})) as never }).find((r) => r.path === '/tradewatcher/prism')
  let text = ''
  const res = { setHeader: () => undefined, end: (s: string) => { text = s }, statusCode: 200 } as unknown as ServerResponse
  await route?.handler({ method: 'POST', [Symbol.asyncIterator]: async function* () { yield Buffer.from(JSON.stringify(body)) } } as unknown as IncomingMessage, res)
  return JSON.parse(text) as Record<string, any>
}

test('① 不足 ⇒ 自动提到 required，8 只全复制；② cash=0；③ raised 摘要正确', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'prismcopy-'))
  try {
    const store = new PrismStore(dir); const trading = new PrismTradingStore(dir)
    await store.init(); await trading.init()
    await trading.saveAccount({ ...trading.account(), capitalLimit: 1_750_000, cash: 1_750_000 }, { explicitReset: true })
    const r = await call(store, trading, fakeData(), { action: 'copy' })
    assert.equal(r['copy']['required'], REQUIRED)
    assert.equal(r['copy']['requestedPositions'], 8)
    assert.equal(r['copy']['copiedPositions'], 8)
    assert.equal(r['copy']['raised'], true)
    assert.equal(r['copy']['capitalBefore'], 1_750_000)
    assert.equal(r['copy']['capitalAfter'], REQUIRED)
    assert.equal(r['account']['capitalLimit'], REQUIRED)
    assert.equal(r['account']['capital'], REQUIRED)
    assert.equal(r['account']['cash'], 0)
    assert.equal(r['settings']['capital'], REQUIRED)
    assert.equal(r['account']['positions'].find((p: any) => p.secid === '1.688825').qty, 5000)
    assert.deepEqual(r['account']['positions'].map((p: any) => p.qty), rows.map((x) => x[2]))
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('④ 上限已足够 ⇒ raised=false 且不改上限（无条件上调 ⇒ 败）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'prismcopy2-'))
  try {
    const store = new PrismStore(dir); const trading = new PrismTradingStore(dir)
    await store.init(); await trading.init()
    await trading.saveAccount({ ...trading.account(), capitalLimit: 2_000_000, cash: 2_000_000 }, { explicitReset: true })
    const r = await call(store, trading, fakeData(), { action: 'copy' })
    assert.equal(r['copy']['raised'], false)
    assert.equal(r['copy']['capitalBefore'], 2_000_000)
    assert.equal(r['copy']['capitalAfter'], 2_000_000)
    assert.equal(r['account']['capitalLimit'], 2_000_000)
    assert.equal(r['account']['cash'], 2_000_000 - REQUIRED)
    assert.throws(() => assert.equal(r['copy']['raised'], true, '注入：无条件上调'), /注入/)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('⑤ 连续两次 copy 不累加：数量/现金不变', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'prismcopy3-'))
  try {
    const store = new PrismStore(dir); const trading = new PrismTradingStore(dir)
    await store.init(); await trading.init()
    const first = await call(store, trading, fakeData(), { action: 'copy' })
    const second = await call(store, trading, fakeData(), { action: 'copy' })
    assert.equal(second['copy']['copiedPositions'], first['copy']['copiedPositions'])
    assert.equal(second['account']['cash'], first['account']['cash'])
    assert.equal(second['copy']['capitalAfter'], first['copy']['capitalAfter'])
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('真实持仓为空 ⇒ required=0，不改上限', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'prismcopy4-'))
  try {
    const store = new PrismStore(dir); const trading = new PrismTradingStore(dir)
    await store.init(); await trading.init()
    await trading.saveAccount({ ...trading.account(), capitalLimit: 1_750_000, cash: 1_750_000 }, { explicitReset: true })
    const r = await call(store, trading, fakeData([]), { action: 'copy' })
    assert.equal(r['copy']['required'], 0)
    assert.equal(r['copy']['raised'], false)
    assert.equal(r['account']['capitalLimit'], 1_750_000)
    assert.equal(r['account']['cash'], 1_750_000)
  } finally { await rm(dir, { recursive: true, force: true }) }
})
