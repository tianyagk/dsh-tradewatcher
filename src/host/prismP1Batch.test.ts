/** 审计 P1 批量修复的回归断言 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { parseDecisionDetailed, equityPointOf, copyAtCost } from './prismAccount.ts'
import { drawdownGateOf } from './prismEval.ts'

const wrap = (body: unknown): string => '```json\n' + JSON.stringify(body) + '\n```'

test('① 模型自报 singlePct/totalPct 超 0–100 ⇒ 置 null（不得放大上限）', () => {
  const r = parseDecisionDetailed(wrap({ limits: { singlePct: 500, totalPct: 1000 }, orders: [], cancel: [] }))
  assert.equal(r.decision?.limits.singlePct, null)
  assert.equal(r.decision?.limits.totalPct, null)
})

test('② 净值点对 0/NaN 价按成本计，不把市值打成 0/NaN', () => {
  const acc = { day: '2026-11-25', capital: 1_000_000, capitalLimit: 1_000_000, cash: 0, realized: 0, dayStartEquity: null,
    positions: [{ secid: '1.600938', name: '中国海油', qty: 1_000, available: 1_000, cost: 30, netCost: 30_000 }] } as never
  const zero = equityPointOf(acc, () => 0, 1)
  const nan = equityPointOf(acc, () => Number.NaN, 1)
  assert.equal(zero.equity, 30_000)
  assert.equal(nan.equity, 30_000)
  assert.equal(Number.isFinite(nan.unrealized), true)
})

test('③ 按成本复制 ⇒ 已实现盈亏归零（新账本）', () => {
  const acc = { day: '2026-11-25', capital: 1_000_000, capitalLimit: 1_000_000, cash: 0, realized: 12_345.67, dayStartEquity: null, copiedAt: null, copyLogs: [], positions: [] } as never
  const r = copyAtCost([{ secid: '1.600938', name: '中国海油', qty: 1_000, cost: 30 }], acc, 1)
  assert.equal(r.account.realized, 0)
  assert.equal(r.account.cash, 1_000_000 - 30_000)
})

test('④ rebase 不再解锁 available（T+1 不得被校平绕过）', () => {
  const src = readFileSync(new URL('./prismRoutes.ts', import.meta.url), 'utf8')
  assert.ok(!/positionsFixed = account\.positions\.map\(\(p\) => \(\{ \.\.\.p, available: p\.qty \}\)\)/.test(src), '不得整仓解锁')
})

test('⑤ 闸门样本不足时状态是「未启用（样本不足）」，不是「正常」', () => {
  const g = drawdownGateOf([], null, 1)
  assert.equal(g.status, '未启用（样本不足）')
  assert.equal(g.triggered, false)
})
