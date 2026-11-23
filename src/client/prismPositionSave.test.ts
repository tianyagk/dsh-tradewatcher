/** 持仓行内编辑保存：secid 带市场前缀 + 零股（89/26 股）都必须能存 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { positionErrorOf, bareCodeOf } from './prismForm.ts'
import { validatePositionInput, applyPositionOp } from '../host/prismDeskWrite.ts'
import type { PrismAccount } from '../shared/prism.ts'

test('① 行内编辑的 secid 带市场前缀也要能通过校验', () => {
  assert.equal(bareCodeOf('1.601872'), '601872')
  assert.equal(positionErrorOf('1.601872', 100), null, '1.601872 必须合法（旧实现按 6 位正则判 ⇒ 报「仅支持沪深 A 股与 ETF」）')
  assert.equal(positionErrorOf('0.002739', 100), null)
})

test('② 修改已有持仓允许零股；新增仍要求整手', () => {
  assert.equal(positionErrorOf('1.601872', 26, true), null)
  assert.equal(positionErrorOf('1.601872', 89, true), null)
  assert.match(positionErrorOf('1.601872', 26, false) ?? '', /100 的整数倍/)
})

test('③ 非法代码/股数仍拒绝', () => {
  assert.match(positionErrorOf('00700', 100, true) ?? '', /仅支持沪深 A 股与 ETF/)
  assert.match(positionErrorOf('1.601872', 0, true) ?? '', /正整数/)
  assert.match(positionErrorOf('1.601872', 1.5, true) ?? '', /正整数/)
})

test('④ 宿主：update 允许零股，add 不允许', () => {
  assert.equal(validatePositionInput({ op: 'update', secid: '1.601872', shares: 26, cost: 17 }), null)
  assert.match(validatePositionInput({ op: 'add', secid: '1.601872', shares: 26, cost: 17 }) ?? '', /100 的整数倍/)
})

test('⑤ 端到端纯函数：89 股 → 26 股保存成功，netCost 同步', () => {
  const acc = { day: '2026-11-23', capital: 1e6, capitalLimit: 1e6, cash: 1e5, realized: 0, dayStartEquity: null, positions: [{ secid: '1.601872', name: '招商轮船', qty: 89, available: 89, cost: 793.94, netCost: 70660.48 }] } as PrismAccount
  const r = applyPositionOp(acc, { op: 'update', secid: '1.601872', shares: 26, cost: 17 }, 1000)
  assert.equal(r.ok, true, r.error)
  const p = r.account!.positions[0]!
  assert.equal(p.qty, 26)
  assert.equal(p.cost, 17)
  assert.equal(p.netCost, 442)
})
