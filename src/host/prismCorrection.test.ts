/** 错价订正：511130 事故形态回归（买入价误用 511090 价位 121.825） */
import test from 'node:test'
import assert from 'node:assert/strict'
import { applyPriceCorrection } from './prismCorrection.ts'
import type { PrismAccount, PrismFill, PrismOrder } from '../shared/prism.ts'

const account = (): PrismAccount => ({
  day: '2026-11-20', capital: 1_800_000, capitalLimit: 1_800_000, cash: 469_340.88, realized: 0,
  dayStartEquity: null,
  positions: [{ secid: '1.511130', name: '30年国债ETF博时', qty: 200, available: 200, cost: 121.86, netCost: 24_371.1 }],
} as PrismAccount)

const order = (): PrismOrder => ({
  id: 'o-test', secid: '1.511130', name: '30年国债ETF博时', side: 'buy', price: 121.825, shares: 200,
  reason: '补低波端', decidedAt: 1, day: '2026-11-20', status: 'filled', fillPrice: 121.825, filledShares: 200, filledAt: 2, fee: 1.16,
} as PrismOrder)

const fill = (): PrismFill => ({ orderId: 'o-test', secid: '1.511130', name: '30年国债ETF博时', side: 'buy', price: 121.825, shares: 200, amount: 24_365, fee: 1.16, at: 2, source: '1min' })

test('① 买入错价订正：现金退回、成本下调、订单留痕', () => {
  const r = applyPriceCorrection(account(), [order()], [fill()], { orderId: 'o-test', newPrice: 111.48, basis: '当日区间 110.93–111.50' }, 1000)
  assert.ok(r.delta > 2000 && r.delta < 2100, `delta 应约 2069，实际 ${r.delta}`)
  assert.equal(r.account.cash, Math.round((469_340.88 + r.delta) * 100) / 100)
  const p = r.account.positions[0]
  assert.ok(p.netCost < 24_371.1)
  assert.ok(Math.abs(p.cost - p.netCost / 200) < 1e-4)
  assert.equal(r.orders[0].price, 111.48)
  assert.equal(r.orders[0].fillPrice, 111.48)
  assert.equal(r.orders[0].corrections?.length, 1)
  assert.equal(r.orders[0].corrections?.[0].oldPrice, 121.825)
  assert.equal(r.fills[0].price, 111.48)
  assert.equal(r.fills[0].amount, 22_296)
})

test('② 未成交委托拒绝订正', () => {
  const o = { ...order(), status: 'pending' as const }
  assert.throws(() => applyPriceCorrection(account(), [o], [], { orderId: 'o-test', newPrice: 111.48, basis: 'x' }), /只有已成交/)
})

test('③ 没有成交记录拒绝订正', () => {
  assert.throws(() => applyPriceCorrection(account(), [order()], [], { orderId: 'o-test', newPrice: 111.48, basis: 'x' }), /没有成交记录/)
})

test('④ 新旧价格相同拒绝订正（幂等保护）', () => {
  assert.throws(() => applyPriceCorrection(account(), [order()], [fill()], { orderId: 'o-test', newPrice: 121.825, basis: 'x' }), /无需订正/)
})

test('⑤ 无依据拒绝订正', () => {
  assert.throws(() => applyPriceCorrection(account(), [order()], [fill()], { orderId: 'o-test', newPrice: 111.48, basis: '  ' }), /basis/)
})

test('⑥ 反例：把 newPrice 传成 0 必须拒绝（不得把成本写成 0）', () => {
  assert.throws(() => applyPriceCorrection(account(), [order()], [fill()], { orderId: 'o-test', newPrice: 0, basis: 'x' }), /有限正数/)
})

test('⑦ 卖出方向的错价订正：少收 ⇒ 负数差额（补回现金需减现金）', () => {
  const acc = {
    day: '2026-11-20', capital: 1_800_000, capitalLimit: 1_800_000, cash: 100_000, realized: 0, dayStartEquity: null,
    positions: [{ secid: '1.511130', name: '30年国债ETF博时', qty: 100, available: 100, cost: 100, netCost: 10_000 }],
  } as PrismAccount
  const o = { ...order(), id: 'o-sell', side: 'sell' as const, price: 100, fillPrice: 100, shares: 100, filledShares: 100 } as PrismOrder
  const f = { orderId: 'o-sell', secid: '1.511130', name: '30年国债ETF博时', side: 'sell' as const, price: 100, shares: 100, amount: 10_000, fee: 15.1, at: 2, source: '1min' } as PrismFill
  const r = applyPriceCorrection(acc, [o], [f], { orderId: 'o-sell', newPrice: 90, basis: '错价卖出' }, 1000)
  // 新价更低 ⇒ 卖出少收 1000 ⇒ delta 为负（现金减少 1000 左右）
  assert.ok(r.delta < -900, `卖出少收应产生负差额，实际 ${r.delta}`)
  assert.equal(r.fills[0].price, 90)
  assert.ok(r.account.cash < 100_000)
})

test('⑧ 二次订正可累积留痕（corrections 不覆盖历史）', () => {
  const r1 = applyPriceCorrection(account(), [order()], [fill()], { orderId: 'o-test', newPrice: 111.48, basis: '第一次' }, 1000)
  const r2 = applyPriceCorrection(r1.account, r1.orders, r1.fills, { orderId: 'o-test', newPrice: 111.0, basis: '第二次' }, 2000)
  assert.equal(r2.orders[0].corrections?.length, 2)
  assert.equal(r2.orders[0].corrections?.[0].newPrice, 111.48)
  assert.equal(r2.orders[0].corrections?.[1].newPrice, 111.0)
  assert.equal(r2.orders[0].fillPrice, 111.0)
})

test('⑨ 路由分派：action 名称必须在本文件真实存在（防改名后无测试）', async () => {
  const { readFileSync } = await import('node:fs')
  const routes = readFileSync(new URL('./prismRoutes.ts', import.meta.url), 'utf8')
  assert.match(routes, /action === 'priceCorrection'/)
  assert.match(routes, /applyPriceCorrection\(/)
})
