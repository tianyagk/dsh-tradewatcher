/**
 * 用户报的「卖出循环」：
 *  小幅亏损 → 卖出 → 摊薄成本抬高 ⇒ 亏损比例变大 → 触发止损 → 继续卖 → …
 * 根因：止损判定用了**摊薄成本**（会被亏损卖出抬高）。修法：止损改用**买入均价 avgCost**（卖出不变）。
 * 同时：超额卖单先按 T+1 可用数量裁剪，避免「被拒 → 下轮再报同样股数」的循环。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { applyFill, clampDecision } from './prismAccount.ts'
import type { PrismAccount, PrismDecision, PrismFill, PrismOrder } from '../shared/prism.ts'

const acc = (): PrismAccount => ({
  day: '2026-11-24', capital: 1_800_000, capitalLimit: 1_800_000, cash: 100_000, realized: 0, dayStartEquity: null,
  positions: [{ secid: '1.601872', name: '招商轮船', qty: 10_000, available: 10_000, cost: 18.83, netCost: 188_300, avgCost: 18.23 }],
} as PrismAccount)

const sellOrder = (shares: number): PrismOrder => ({ id: 'o', secid: '1.601872', name: '招商轮船', side: 'sell', price: 15.5, shares, reason: 'x', decidedAt: 1, day: '2026-11-24', status: 'filled', filledShares: shares, filledAt: 2, fillPrice: 15.5 } as PrismOrder)
const sellFill = (shares: number): PrismFill => ({ orderId: 'o', secid: '1.601872', name: '招商轮船', side: 'sell', price: 15.5, shares, amount: 15.5 * shares, fee: 5, at: 2, source: '1min' })

test('① 亏损卖出会抬高摊薄成本，但买入均价 avgCost 不变', () => {
  const r = applyFill(acc(), sellOrder(1_000), sellFill(1_000))
  const p = r.positions[0]!
  assert.ok(p.cost > 18.83, `摊薄成本应被抬高，实际 ${p.cost}`)
  assert.equal(p.avgCost, 18.23, '买入均价不得因卖出变化')
})

test('② 止损用 avgCost：现价 15.5 vs 均价 18.23 = −14.98%，不触发 −20%', () => {
  const d: PrismDecision = { limits: { singlePct: 20, totalPct: 100, note: null }, orders: [{ secid: '1.601872', side: 'buy', price: 15.5, shares: 100, reason: 'x' }], cancel: [], rejects: [], parseError: null }
  const r = clampDecision(d, {
    cash: 500_000, positions: [{ secid: '1.601872', qty: 10_000, available: 10_000, price: 15.5, name: '招商轮船' }],
    limits: {}, at: 1, constraints: { stopLossPct: 20, perStockPct: 50 }, costs: { '1.601872': 18.23 },
  } as never)
  assert.equal(r.events.filter((e) => e.dimension === 'stopLoss').length, 0)
})

test('③ 反例：用摊薄成本 25 元则会误判 −38% 并拒买', () => {
  const d: PrismDecision = { limits: { singlePct: 100, totalPct: 100, note: null }, orders: [{ secid: '1.601872', side: 'buy', price: 15.5, shares: 100, reason: 'x' }], cancel: [], rejects: [], parseError: null }
  const r = clampDecision(d, {
    cash: 500_000, positions: [{ secid: '1.601872', qty: 10_000, available: 10_000, price: 15.5, name: '招商轮船' }],
    limits: {}, at: 1, constraints: { stopLossPct: 20 }, costs: { '1.601872': 25 },
  } as never)
  assert.equal(r.events.filter((e) => e.dimension === 'stopLoss').length, 1)
})

test('④ 超额卖单按可用数量裁剪（不再整单被拒后下轮重报）', () => {
  const d: PrismDecision = { limits: { singlePct: null, totalPct: null, note: null }, orders: [{ secid: '1.601872', side: 'sell', price: 15.5, shares: 4_400, reason: 'x' }], cancel: [], rejects: [], parseError: null }
  const r = clampDecision(d, {
    cash: 10_000, positions: [{ secid: '1.601872', qty: 4_400, available: 4_023, price: 15.5, name: '招商轮船' }], limits: {}, at: 1,
  } as never)
  assert.equal(r.decision.orders[0]?.shares, 4_000, '应按可用 4023 取整手 4000')
  assert.equal(r.events.find((e) => e.dimension === 'available')?.after, 4_000)
})

test('⑤ 可用为 0 ⇒ 明确拒绝（不产生空卖单）', () => {
  const d: PrismDecision = { limits: { singlePct: null, totalPct: null, note: null }, orders: [{ secid: '1.601872', side: 'sell', price: 15.5, shares: 1_000, reason: 'x' }], cancel: [], rejects: [], parseError: null }
  const r = clampDecision(d, {
    cash: 0, positions: [{ secid: '1.601872', qty: 1_000, available: 0, price: 15.5, name: '招商轮船' }], limits: {}, at: 1,
  } as never)
  assert.equal(r.decision.orders.length, 0)
  assert.match(String(r.rejected[0]?.reason), /今日可卖 0 股/)
})

test('⑥ 手工调大股数 ⇒ 可卖数量同步解锁（账面调整不是成交，不该按 T+1 锁住）', async () => {
  const { applyPositionOp } = await import('./prismDeskWrite.ts')
  const before = {
    day: '2026-11-24', capital: 1_800_000, capitalLimit: 1_800_000, cash: 0, realized: 0, dayStartEquity: null,
    positions: [{ secid: '1.601872', name: '招商轮船', qty: 10_428, available: 10_428, cost: 21.63, netCost: 225_000 }],
  } as never
  const r = applyPositionOp(before, { op: 'update', secid: '1.601872', shares: 24_000, cost: 18.21 }, 1)
  assert.equal(r.ok, true)
  const p = r.account!.positions[0]!
  assert.equal(p.qty, 24_000)
  assert.equal(p.available, 24_000, `调大后必须全部可卖，实际 ${p.available}`)
  assert.equal(p.avgCost, 18.21)
})

test('⑦ 裁剪上下文必须带 available（否则卖单不会被裁到可卖数量）', async () => {
  const { readFileSync } = await import('node:fs')
  const routes = readFileSync(new URL('./prismRoutes.ts', import.meta.url), 'utf8')
  assert.match(routes, /positions: account\.positions\.map\(\(p\) => \(\{ secid: p\.secid, qty: p\.qty, available: p\.available/)
})

test('⑧ 持仓快照必须给「可卖数量」（卖单按 T+1 静默裁剪，模型需要看到）', async () => {
  const { readFileSync } = await import('node:fs')
  const routes = readFileSync(new URL('./prismRoutes.ts', import.meta.url), 'utf8')
  assert.match(routes, /股（可卖 \$\{p\.available\} 股）/)
})
