import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PrismTradingStore, feesOf, matchTick } from './prismAccount.ts'
import type { PrismOrder } from '../shared/prism.ts'

const day = '2026-10-22'
const at = (h: number) => Date.parse(`${day}T${String(h).padStart(2, '0')}:00:00+08:00`)
const account = () => ({ day, capitalLimit: 1_500_000, cash: 100_000, realized: 0, dayStartEquity: null, positions: [], copiedAt: null, copyLogs: [] })
const order = (id = 'o1'): PrismOrder => ({
  id, secid: '1.600000', name: '测试', side: 'buy', price: 0.7, shares: 20_000,
  reason: '', decidedAt: at(9), day, status: 'pending',
})

const setup = async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fillslice-'))
  const store = new PrismTradingStore(dir)
  await store.init()
  await store.saveAccount({ ...account(), day })
  await store.saveOrders([order()], [])
  const deps = {
    now: () => at(10),
    quotes: async () => ({ '1.600000': { name: '测试', price: 0.7, prev: 0.7 } }),
    bars: async () => ({ bars: [
      { t: at(10), high: 0.71, low: 0.69, volume: 50_620 },
      { t: at(11), high: 0.71, low: 0.69, volume: 50_620 },
    ], source: '1min' as const, reason: null }),
    participationRate: 0.1,
  }
  return { dir, store, deps }
}

test('同一 bar 的 volume×参与率累计：反复 tick 总成交 ≤ 5062，不按 26 次重置', async () => {
  const { dir, store, deps } = await setup()
  try {
    const sameBar = { ...deps, bars: async () => ({ bars: [{ t: at(10), high: 0.71, low: 0.69, volume: 50_620 }], source: '1min' as const, reason: null }) }
    const a = await matchTick(store, sameBar)
    const b = await matchTick(store, sameBar)
    const fills = store.fills()
    assert.equal(a.filled, 1)
    assert.equal(b.filled, 0, '同一 bar 不能再次成交')
    assert.equal(fills.reduce((s, f) => s + f.shares, 0), 5062)
    assert.equal(store.orders()[0]?.lastBarTime, at(10))
    assert.equal(store.orders()[0]?.status, 'pending')
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('同一委托跨 bar 分批成交：最低佣金只收一次', async () => {
  const { dir, store, deps } = await setup()
  try {
    await matchTick(store, deps)
    await matchTick(store, deps)
    const fills = store.fills()
    assert.equal(fills.length, 2)
    assert.equal(fills.reduce((s, f) => s + f.commission!, 0), 5)
    assert.equal(fills[0]?.commission, 5)
    assert.equal(fills[1]?.commission, 0)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('feesOf 累计口径：两笔合计佣金仍只一次最低 5', () => {
  const a = feesOf('buy', 0.7, 5062)
  const b = feesOf('buy', 0.7, 5062, 0.7 * 5062, a.commission)
  assert.equal(a.commission, 5)
  assert.equal(b.commission, 0)
  assert.equal(a.commission + b.commission, 5)
})
