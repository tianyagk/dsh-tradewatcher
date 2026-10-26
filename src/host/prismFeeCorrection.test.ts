import assert from 'node:assert/strict'
import test from 'node:test'
import { applyFeeCorrection } from './prismAccount.ts'
import type { PrismAccount, PrismFill } from '../shared/prism.ts'

const at = Date.parse('2026-10-26T11:16:00+08:00')
const fills: PrismFill[] = Array.from({ length: 26 }, () => ({
  orderId: 'o-26', secid: '1.588170', name: '科创半导体ETF华夏', side: 'sell', price: 0.7,
  shares: 5062, amount: 3558.59, fee: 8.6, at, source: '1min',
}))
const account: PrismAccount = {
  day: '2026-10-26', capitalLimit: 2_000_000, cash: 1000, realized: 10,
  dayStartEquity: null, positions: [], copiedAt: null, copyLogs: [],
}

test('① 重算按公式而非 125；② 现金增量 = 订正金额；③ fills 不变', () => {
  const beforeFills = JSON.parse(JSON.stringify(fills))
  const r = applyFeeCorrection(account, fills, { orderId: 'o-26', secid: '1.588170', at, price: 0.7 })
  assert.equal(r.correction.beforeFee, 223.6)
  assert.equal(r.correction.afterFee, 116.58)
  assert.equal(r.correction.credit, 107.02)
  assert.notEqual(r.correction.credit, 125)
  assert.equal(r.account.cash, 1107.02)
  assert.equal(r.account.realized, 117.02)
  assert.deepEqual(fills, beforeFills)
  assert.throws(() => assert.equal(r.correction.credit, 125, '注入：125 硬编码'), /注入/)
})

test('④ 幂等：重复订正不加钱、不新增第二条记录', () => {
  const first = applyFeeCorrection(account, fills, { orderId: 'o-26', secid: '1.588170', at, price: 0.7 })
  const second = applyFeeCorrection(first.account, fills, { orderId: 'o-26', secid: '1.588170', at, price: 0.7 })
  assert.equal(second.credit, 0)
  assert.equal(second.duplicate, true)
  assert.equal(second.account.cash, first.account.cash)
  assert.equal(second.account.feeCorrections?.length, 1)
})

test('⑤ 已实现盈亏包含 credit；无匹配 fills 拒绝', () => {
  const r = applyFeeCorrection(account, fills, { orderId: 'o-26', secid: '1.588170', at, price: 0.7 })
  assert.equal(r.account.realized, 10 + r.correction.credit)
  assert.throws(() => applyFeeCorrection(account, [], { orderId: 'x', secid: '1.588170', at, price: 0.7 }), /没有匹配/)
})
