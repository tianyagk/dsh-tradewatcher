/**
 * 用户报：前几天就持有的仓位，今天仍被 T+1 拦住。
 * 实测（2026-11-24 儒意电影）：委托 1,000 股、先成交 789 股，剩余 211 股被拒且理由写「T+1 不可卖（今日可卖 211 股）」
 * —— 可用 211 = 剩余 211，本该继续成交。根因是拿**原始 shares**（1000）比可用，而不是剩余。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { rejectReasonOf } from './prismAccount.ts'
import type { PrismOrder } from '../shared/prism.ts'

const order = (over: Partial<PrismOrder> = {}): PrismOrder => ({
  id: 'o1', secid: '0.002739', name: '儒意电影', side: 'sell', price: 10.7, shares: 1000,
  reason: 'x', decidedAt: 1, day: '2026-11-24', status: 'pending', ...over,
})

const ctx = (availableQty: number, positionQty = availableQty) => ({
  limits: { prevClose: 10, upper: 11, lower: 9 }, suspended: false, positionQty, availableQty,
})

test('① 部分成交后（1000 已成交 789，剩 211），可用 211 ⇒ 不得再拒', () => {
  const o = order({ filledShares: 789 })
  assert.equal(rejectReasonOf(o, ctx(211)), null, '剩余 211 与可用 211 相等，应继续成交')
})

test('② 可用确实不足（剩 211，可用 100）⇒ 拒，理由写剩余 211', () => {
  const o = order({ filledShares: 789 })
  const reason = rejectReasonOf(o, ctx(100))
  assert.match(String(reason), /T\+1 不可卖/)
  assert.match(String(reason), /剩余 211 股/)
})

test('③ 未成交过的委托仍按原股数判断（1000 股、可用 500 ⇒ 拒）', () => {
  assert.match(String(rejectReasonOf(order(), ctx(500))), /今日可卖 500 股/)
})

test('④ 反例：用原始 shares 比较（旧实现）会把剩余 211 误拒', () => {
  const legacy = (o: PrismOrder, available: number): string | null => (available < o.shares ? `T+1 不可卖（今日可卖 ${available} 股）` : null)
  assert.match(String(legacy(order({ filledShares: 789 }), 211)), /T\+1/)
})
