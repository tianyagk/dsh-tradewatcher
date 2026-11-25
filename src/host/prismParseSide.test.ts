/** 决策解析：方向缺失/拼错必须丢弃，不能默认成买 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { parseDecisionDetailed } from './prismAccount.ts'

const wrap = (orders: unknown[]): string => '```json\n' + JSON.stringify({ note: '不买：x；不卖：y', limits: { singlePct: 20, totalPct: 100 }, orders, cancel: [] }) + '\n```'

test('① side 缺失 ⇒ 丢弃并记 parseError（旧实现会当 buy）', () => {
  const r = parseDecisionDetailed(wrap([{ secid: '1.600938', price: 30, shares: 100 }]))
  assert.equal(r.decision?.orders.length, 0)
  assert.match(String(r.decision?.parseError), /字段非法被丢弃/)
})

test('② side 拼错（"SELL"/"卖"）⇒ 丢弃', () => {
  const r = parseDecisionDetailed(wrap([{ secid: '1.600938', side: 'SELL', price: 30, shares: 100 }, { secid: '1.600938', side: '卖', price: 30, shares: 100 }]))
  assert.equal(r.decision?.orders.length, 0)
})

test('③ 正常 buy / sell 不受影响', () => {
  const r = parseDecisionDetailed(wrap([{ secid: '1.600938', side: 'buy', price: 30, shares: 100 }, { secid: '1.600938', side: 'sell', price: 31, shares: 200 }]))
  assert.deepEqual(r.decision?.orders.map((o) => o.side), ['buy', 'sell'])
})
