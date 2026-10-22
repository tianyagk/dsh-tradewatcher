import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  COMMISSION_MIN,
  PRISM_INITIAL_CAPITAL,
  PrismTradingStore,
  applyFill,
  copyAtCost,
  equityPointOf,
  feesOf,
  limitsOf,
  matchOrder,
  matchTick,
  parseDecision,
  placeDecision,
  rejectReasonOf,
  rollDay,
  upsertEquity,
  type MinuteBar,
} from './prismAccount.ts'
import type { PrismAccount, PrismOrder } from '../shared/prism.ts'

const emptyAccount = (): PrismAccount => ({
  day: '2026-10-22', capitalLimit: PRISM_INITIAL_CAPITAL, cash: PRISM_INITIAL_CAPITAL, realized: 0,
  dayStartEquity: null, positions: [], copiedAt: null, copyLogs: [],
})
const orderOf = (o: Partial<PrismOrder>): PrismOrder => ({
  id: 'o1', secid: '1.600519', name: '贵州茅台', side: 'buy', price: 10, shares: 100,
  reason: 'test', decidedAt: Date.parse('2026-10-22T09:30:00+08:00'), day: '2026-10-22', status: 'pending', ...o,
})

test('① 初始 150 万；入金可改（现金同步）', () => {
  assert.equal(PRISM_INITIAL_CAPITAL, 1_500_000)
  assert.equal(emptyAccount().cash, 1_500_000)
})

test('② 复制持仓按成本价（不是现价），并留痕', () => {
  const r = copyAtCost([{ secid: '1.600519', name: '茅台', qty: 100, cost: 1200 }], emptyAccount(), 1)
  assert.equal(r.ok, true)
  if (r.ok) {
    assert.equal(r.account.positions[0]?.cost, 1200)
    assert.equal(r.account.cash, 1_500_000 - 120_000)
    assert.equal(r.account.copyLogs.length, 1)
    assert.match(r.log.after[0] ?? '', /1200\.00/)
  }
})

test('⑤ 费用三项逐笔正确、佣金最低 5 元', () => {
  const buy = feesOf('buy', 10, 100)
  assert.equal(buy.commission, COMMISSION_MIN)
  assert.equal(buy.stamp, 0)
  assert.equal(buy.transfer, 0.01)
  assert.equal(buy.total, 5.01)
  const sell = feesOf('sell', 10, 100)
  assert.equal(sell.stamp, 1)
  assert.equal(sell.total, 6.01)
  const big = feesOf('buy', 100, 1_000)
  assert.equal(big.commission, 25)
  assert.equal(big.transfer, 1)
})

test('④ 撮合：买看 low、卖看 high，按挂单价成交（不用收盘价）', () => {
  const buy = orderOf({ side: 'buy', price: 10 })
  const bars: MinuteBar[] = [{ t: buy.decidedAt + 1000, high: 10.5, low: 9.9 }]
  assert.deepEqual(matchOrder(buy, bars), { price: 10, at: bars[0]?.t })
  const sell = orderOf({ side: 'sell', price: 10 })
  assert.deepEqual(matchOrder(sell, [{ t: sell.decidedAt + 1, high: 10.1, low: 9.5 }]), { price: 10, at: sell.decidedAt + 1 })
  assert.equal(matchOrder(buy, [{ t: buy.decidedAt + 1, high: 11, low: 10.01 }]), null, '没触及不成交')
})

test('⑥ 四种拒绝各有原因：T+1 / 涨停 / 停牌 / 整手', () => {
  const limits = limitsOf('1.600519', '贵州茅台', 10)
  const base = { limits, suspended: false, positionQty: 100, availableQty: 0 }
  assert.match(String(rejectReasonOf(orderOf({ shares: 150 }), base)), /整手/)
  assert.match(String(rejectReasonOf(orderOf({ side: 'sell' }), base)), /T\+1/)
  assert.match(String(rejectReasonOf(orderOf({ price: 11 }), base)), /涨停/)
  assert.match(String(rejectReasonOf(orderOf({}), { ...base, suspended: true })), /停牌/)
})

test('③ 挂单当日有效：跨日自动失效并留痕', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'prism-acc-'))
  try {
    const store = new PrismTradingStore(dir)
    await store.init()
    await store.saveAccount({ ...emptyAccount(), day: '2026-10-22' })
    await store.saveOrders([orderOf({ id: 'x', day: '2026-10-22' })], [])
    const r = await matchTick(store, {
      now: () => Date.parse('2026-10-23T10:00:00+08:00'),
      quotes: async () => ({}),
      bars: async () => ({ bars: [], source: null, reason: 'no data' }),
    })
    assert.equal(r.filled, 0)
    const o = store.orders()[0]
    assert.equal(o?.status, 'cancelled')
    assert.match(String(o?.cancelReason), /次日失效/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('③ 后续研判可撤销：状态 + 时间 + 原因留痕', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'prism-acc2-'))
  try {
    const store = new PrismTradingStore(dir)
    await store.init()
    const now = Date.parse('2026-10-22T10:00:00+08:00')
    await store.saveAccount({ ...emptyAccount(), day: '2026-10-22' })
    await store.saveOrders([orderOf({ id: 'o1' })], [])
    const placed = await placeDecision(store, { limits: { singlePct: 10, totalPct: 50, note: 'x' }, orders: [], cancel: ['o1'] }, now, {})
    assert.equal(placed.length, 0)
    const o = store.orders()[0]
    assert.equal(o?.status, 'cancelled')
    assert.equal(o?.cancelReason, '后续研判撤销')
    assert.equal(o?.cancelledAt, now)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('⑤ 成交：买入摊薄成本、卖出已实现盈亏含费用；现金正确', () => {
  const account = { ...emptyAccount(), cash: 100_000 }
  const order = orderOf({ price: 10, shares: 100 })
  const next = applyFill(account, order, {
    orderId: 'o1', secid: '1.600519', name: '贵州茅台', side: 'buy', price: 10, shares: 100, amount: 1000, fee: 5.01,
    at: 1, source: '1min',
  })
  assert.equal(next.cash, 100_000 - 1005.01)
  assert.equal(next.positions[0]?.cost, 10.05)
  const sold = applyFill(next, orderOf({ side: 'sell', price: 12, shares: 100 }), {
    orderId: 'o2', secid: '1.600519', name: '贵州茅台', side: 'sell', price: 12, shares: 100, amount: 1200, fee: 6.21,
    at: 2, source: '1min',
  })
  assert.equal(sold.positions.length, 0)
  assert.equal(sold.realized, Math.round((1200 - 1005 - 6.21) * 100) / 100)
})

test('⑧ 净值每日一点：同日覆盖、跨日新增', () => {
  const a = { ...emptyAccount(), day: '2026-10-22' }
  const p1 = equityPointOf(a, () => null, 1)
  const p2 = equityPointOf(a, () => null, 2)
  assert.equal(upsertEquity([p1], p2).length, 1, '同一天只保留一点')
  const p3 = equityPointOf({ ...a, day: '2026-10-23' }, () => null, 3)
  assert.equal(upsertEquity([p2], p3).length, 2)
})

test('⑦ 三账本走锁 + 读守卫 + 坏文件隔离', async () => {
  const src = await import('node:fs/promises').then((m) => m.readFile(new URL('./prismAccount.ts', import.meta.url), 'utf8'))
  assert.match(src, /updateJsonLocked/)
  assert.match(src, /ReadGuard/)
  assert.match(src, /quarantineFile/)
  const dir = await mkdtemp(join(tmpdir(), 'prism-acc3-'))
  try {
    await writeFile(join(dir, 'prism-account.json'), '{bad json')
    const store = new PrismTradingStore(dir)
    await store.init()
    await store.quarantine()
    const files = await readdir(dir)
    assert.equal(files.some((f) => f.includes('.corrupt')), true, '坏文件必须被隔离保留')
    assert.equal(store.account().cash, PRISM_INITIAL_CAPITAL, '隔离后从容重建')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('决策 JSON 解析：limits/orders/cancel；坏 JSON ⇒ null', () => {
  const d = parseDecision('前言\n```json\n{"limits":{"singlePct":10,"totalPct":60,"note":"波动"},"orders":[{"secid":"1.600519","side":"buy","price":10,"shares":100,"reason":"低估"}],"cancel":["o1"]}\n```')
  assert.equal(d?.orders.length, 1)
  assert.equal(d?.limits.singlePct, 10)
  assert.deepEqual(d?.cancel, ['o1'])
  assert.equal(parseDecision('```json\n{坏}\n```'), null)
  assert.equal(parseDecision(null), null)
})

test('T+1 日切：新交易日 available=qty', () => {
  const a = { ...emptyAccount(), positions: [{ secid: '1.600519', name: '茅台', qty: 100, available: 0, cost: 10 }] }
  assert.equal(rollDay(a, '2026-10-23', 1).positions[0]?.available, 100)
})

/* ── 成交前资金/可卖硬校验（发布前补的真缺陷） ── */

async function tickWith(opts: {
  cash: number
  positions?: PrismAccount['positions']
  order: PrismOrder
  quote: { name: string; price: number; prev: number }
  bars: MinuteBar[]
}): Promise<{ store: PrismTradingStore; result: { filled: number; rejected: number } }> {
  const dir = await mkdtemp(join(tmpdir(), 'prism-cash-'))
  const store = new PrismTradingStore(dir)
  await store.init()
  await store.saveAccount({ ...emptyAccount(), cash: opts.cash, positions: opts.positions ?? [] })
  await store.saveOrders([opts.order], [])
  const result = await matchTick(store, {
    now: () => Date.parse('2026-10-22T10:00:00+08:00'),
    quotes: async () => ({ [opts.order.secid]: opts.quote }),
    bars: async () => ({ bars: opts.bars, source: '1min', reason: null }),
  })
  return { store, result }
}

test('现金不足：买 100@20（需 2005.02）⇒ rejected、现金仍 1000、不成交', async () => {
  const { store, result } = await tickWith({
    cash: 1000,
    order: orderOf({ price: 20, shares: 100 }),
    quote: { name: '贵州茅台', price: 20, prev: 20 },
    bars: [{ t: Date.parse('2026-10-22T09:31:00+08:00'), high: 20.2, low: 19.8 }],
  })
  const o = store.orders()[0]
  assert.equal(result.filled, 0)
  assert.equal(o?.status, 'rejected')
  assert.match(String(o?.rejectReason), /现金不足（需 2005\.02，可用 1000\.00）/)
  assert.equal(store.account().cash, 1000)
  assert.equal(store.fills().length, 0)
})

test('现金刚好够：买 100@9.9（需 995.01）⇒ 成交、现金 4.99', async () => {
  const { store, result } = await tickWith({
    cash: 1000,
    order: orderOf({ price: 9.9, shares: 100 }),
    quote: { name: '贵州茅台', price: 9.9, prev: 9.9 },
    bars: [{ t: Date.parse('2026-10-22T09:31:00+08:00'), high: 10, low: 9.8 }],
  })
  const o = store.orders()[0]
  assert.equal(result.filled, 1)
  assert.equal(o?.status, 'filled')
  assert.equal(store.account().cash, 4.99)
  assert.equal(store.fills()[0]?.fee, 5.01)
})

test('卖出超量：持仓 100 卖 200 ⇒ rejected、持仓不变、不成交', async () => {
  const { store, result } = await tickWith({
    cash: 1000,
    positions: [{ secid: '1.600519', name: '贵州茅台', qty: 100, available: 100, cost: 10 }],
    order: orderOf({ side: 'sell', price: 10, shares: 200 }),
    quote: { name: '贵州茅台', price: 10, prev: 10 },
    bars: [{ t: Date.parse('2026-10-22T09:31:00+08:00'), high: 10.2, low: 9.9 }],
  })
  const o = store.orders()[0]
  assert.equal(result.filled, 0)
  assert.equal(o?.status, 'rejected')
  assert.match(String(o?.rejectReason), /不可卖/)
  assert.equal(store.account().positions[0]?.qty, 100)
  assert.equal(store.fills().length, 0)
})

test('注入：绕开成交前校验直接 applyFill ⇒ 必须抛错（现金不得为负）', () => {
  assert.throws(
    () => applyFill({ ...emptyAccount(), cash: 1000 }, orderOf({ price: 20, shares: 100 }), {
      orderId: 'x', secid: '1.600519', name: '贵州茅台', side: 'buy', price: 20, shares: 100,
      amount: 2000, fee: 5.02, at: 1, source: '1min',
    }),
    /现金不足/,
    '⚠ 反例（照常成交）必须被兜底拦住',
  )
})
