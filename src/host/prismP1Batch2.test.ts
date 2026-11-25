/** 审计 P1 第二批：手工调仓成对记账 / 现金改动静默 / 新开仓行业归属 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { applyPositionOp } from './prismDeskWrite.ts'

const acc = () => ({
  day: '2026-11-25', capital: 1_000_000, capitalLimit: 1_000_000, cash: 1_000_000, realized: 0, dayStartEquity: null,
  copiedAt: null, copyLogs: [], positions: [],
}) as never

test('① 新增持仓按成本扣现金：总资产不变', () => {
  const r = applyPositionOp(acc(), { op: 'add', secid: '1.600938', shares: 1_000, cost: 30 }, 1)
  assert.equal(r.ok, true)
  assert.equal(r.account!.cash, 970_000)
  assert.equal(r.account!.positions[0]!.netCost, 30_000)
  assert.equal(r.account!.positions[0]!.avgCost, 30)
})

test('② 调大持仓补扣差额，调小退回差额', () => {
  const a = applyPositionOp(acc(), { op: 'add', secid: '1.600938', shares: 1_000, cost: 30 }, 1).account!
  const b = applyPositionOp(a, { op: 'update', secid: '1.600938', shares: 2_000, cost: 30 }, 2).account!
  assert.equal(b.cash, 940_000, '多 1000 股应再扣 3 万')
  const c = applyPositionOp(b, { op: 'update', secid: '1.600938', shares: 500, cost: 30 }, 3).account!
  assert.equal(c.cash, 985_000, '少 1500 股应退回 4.5 万')
})

test('③ 删除持仓按成本退回现金（需 confirm）', () => {
  const a = applyPositionOp(acc(), { op: 'add', secid: '1.600938', shares: 1_000, cost: 30 }, 1).account!
  const denied = applyPositionOp(a, { op: 'remove', secid: '1.600938' }, 2)
  assert.equal(denied.ok, false)
  const r = applyPositionOp(a, { op: 'remove', secid: '1.600938', confirm: true }, 3)
  assert.equal(r.account!.cash, 1_000_000)
  assert.equal(r.account!.positions.length, 0)
})

test('④ 现金编辑写 ledger（不再静默改余额）', () => {
  const src = readFileSync(new URL('./prismRoutes.ts', import.meta.url), 'utf8')
  const block = src.slice(src.indexOf("action === 'cash'"), src.indexOf("action === 'capital'"))
  assert.match(block, /appendPrismLedger/)
  assert.match(block, /账外资金变动/)
})

test('⑤ 行业归属覆盖本轮新开仓标的', () => {
  const src = readFileSync(new URL('./prismRoutes.ts', import.meta.url), 'utf8')
  assert.match(src, /industrySecids = \[\.\.\.new Set\(\[\.\.\.account\.positions\.map\(\(p\) => p\.secid\), \.\.\.run\.decision\.orders\.map\(\(o\) => o\.secid\)\]\)\]/)
})
