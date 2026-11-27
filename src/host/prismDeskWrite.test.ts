/** v0.203.0：棱镜写接口（B5）—— position / constraints + 六维裁剪，六条断言均带反例注入 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PrismAccount, PrismDecision } from '../shared/prism.ts'
import { applyPositionOp, appendPrismLedger, constraintsOf, readPrismLedger, validateConstraints, validatePositionInput } from './prismDeskWrite.ts'
import { clampDecision } from './prismAccount.ts'
import { PrismStore } from './prismStore.ts'

const baseAccount = (): PrismAccount => ({
  day: '2026-11-19', capital: 1_000_000, capitalLimit: 1_000_000, cash: 1_000_000, realized: 0, dayStartEquity: null,
  positions: [], copiedAt: null, copyLogs: [],
})

test('① add/update/remove 三条各成功且账本留痕（少一条 ⇒ 败）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'prism-led-'))
  let acc = baseAccount()
  const add = applyPositionOp(acc, { op: 'add', secid: '1.510300', shares: 1000, cost: 4.1 }, 1000)
  assert.equal(add.ok, true, add.error)
  acc = add.account!
  appendPrismLedger(dir, add.entry!)
  const upd = applyPositionOp(acc, { op: 'update', secid: '1.510300', shares: 500, cost: 4.0 }, 2000)
  assert.equal(upd.ok, true, upd.error)
  acc = upd.account!
  appendPrismLedger(dir, upd.entry!)
  const rem = applyPositionOp(acc, { op: 'remove', secid: '1.510300', confirm: true }, 3000)
  assert.equal(rem.ok, true, rem.error)
  appendPrismLedger(dir, rem.entry!)
  const ledger = readPrismLedger(dir)
  assert.equal(ledger.length, 3)
  assert.deepEqual(ledger.map((e) => e.op), ['add', 'update', 'remove'])
  assert.ok(ledger.every((e) => e.kind === 'manual-adjust'))
  assert.throws(() => assert.equal(ledger.length, 2, '反例上：少一条'), /反例上/, '⚠ 反例注入必须失败')
})

test('② 非法 secid / 非整手 / 负成本 ⇒ 400 一句原因（放行 ⇒ 败）', () => {
  assert.equal(validatePositionInput({ op: 'add', secid: '2.600519', shares: 100, cost: 1 }), 'secid 必须是沪深 A 股或 ETF（如 1.600519 / 1.510300）')
  assert.equal(validatePositionInput({ op: 'add', secid: '1.510300', shares: 150, cost: 1 }), 'shares 必须是正整数且为 100 的整数倍')
  assert.equal(validatePositionInput({ op: 'add', secid: '1.510300', shares: 100, cost: -1 }), 'cost 必须是有限正数')
  const r = applyPositionOp(baseAccount(), { op: 'add', secid: 'BAD', shares: 100, cost: 1 }, 1)
  assert.equal(r.ok, false)
  assert.ok(typeof r.error === 'string' && r.error.length > 0, '必须有原因')
  assert.throws(() => assert.equal(r.ok, true, '反例上：放行'), /反例上/, '⚠ 反例注入必须失败')
})

test('③ constraints 六字段持久化后重读一致（丢字段 ⇒ 败）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'prism-st-'))
  const store = new PrismStore(dir)
  await store.init()
  const six = { perStockPct: 12, stopLossPct: 8, perOrderYuan: 50_000, maxPosPct: 80, maxDDPct: 3, minCashPct: 10 }
  const checked = validateConstraints(six)
  assert.equal(checked.ok, true)
  await store.saveConstraints((checked as { ok: true; value: typeof six }).value)
  const again = new PrismStore(dir)
  await again.init()
  assert.deepEqual(constraintsOf(again.settings()), six)
  assert.throws(() => assert.deepEqual(constraintsOf(again.settings()), { ...six, perStockPct: null }, '反例上：丢字段'), /反例上/, '⚠ 反例注入必须失败')
})

test('④ clampDecision 六维度各一条裁剪用例（缺维度 ⇒ 败）', () => {
  const dec: PrismDecision = { limits: { singlePct: null, totalPct: null, note: null }, orders: [{ secid: '1.510300', side: 'buy', price: 4, shares: 10_000, reason: 'x' }], cancel: [], rejects: [], parseError: null }
  const run = (constraints: Record<string, number | null>, extra: { costs?: Record<string, number>; dayDrawdownPct?: number | null } = {}) =>
    clampDecision(dec, { cash: 100_000, positions: [], limits: { singlePct: null, totalPct: null }, at: 1, constraints, ...extra })

  // v0.221.2：配置的单票上限走 single 维度（配置优先），不再单列 perStock
  assert.ok(run({ perStockPct: 1 }).events.some((e) => e.dimension === 'single'), 'perStockPct ⇒ single')
  assert.ok(run({ perOrderYuan: 10_000 }).events.some((e) => e.dimension === 'perOrder'), 'perOrderYuan')
  assert.ok(run({ maxPosPct: 1 }).events.some((e) => e.dimension === 'total'), 'maxPosPct ⇒ total')
  assert.ok(run({ minCashPct: 99 }).events.some((e) => e.dimension === 'minCash'), 'minCashPct')
  assert.ok(run({ maxDDPct: 2 }, { dayDrawdownPct: -3 }).events.some((e) => e.dimension === 'maxDD'), 'maxDDPct')
  assert.ok(run({ stopLossPct: 5 }, { costs: { '1.510300': 10 } }).events.some((e) => e.dimension === 'stopLoss'), 'stopLossPct')
  // P0-1（用户口径）：未配置 maxPosPct ⇒ 「未设置」，不套 95%/100 的默认总仓上限
  // （minCashPct 仍是独立硬顶：上面的 minCash 用例已覆盖）
  const big: PrismDecision = { ...dec, orders: [{ secid: '1.510300', side: 'buy', price: 4, shares: 60_000, reason: 'x' }] }
  assert.equal(clampDecision(big, { cash: 200_000, positions: [], limits: { singlePct: null, totalPct: null }, at: 1, constraints: {} }).events.some((e) => e.dimension === 'total'), true, '未配置 maxPosPct ⇒ 默认 95% 总仓上限')
  assert.throws(() => assert.equal(run({}).events.length, 1, '反例上：无约束也裁剪'), /反例上/, '⚠ 反例注入必须失败')
})

test('⑤ 旧 action 不受影响（settings/industryLimits/copy 分支仍在）', () => {
  const src = readFileSync(new URL('./prismRoutes.ts', import.meta.url), 'utf8')
  for (const a of ["action === 'settings'", "action === 'industryLimits'", "action === 'copy'", "action === 'feeCorrection'", "action === 'model'"]) {
    assert.ok(src.includes(a), `旧 action 丢失：${a}`)
  }
  assert.ok(src.includes("action === 'position'") && src.includes("action === 'constraints'"), '新 action 必须存在')
  assert.throws(() => assert.ok(src.replace("action === 'settings'", '').includes("action === 'settings'"), '反例上：删旧分支'), /反例上/, '⚠ 反例注入必须失败')
})

test('补充：remove 需显式确认（有持仓不确认 ⇒ 败）', () => {
  let acc = baseAccount()
  acc = applyPositionOp(acc, { op: 'add', secid: '1.600519', shares: 100, cost: 1500 }, 1).account!
  const r = applyPositionOp(acc, { op: 'remove', secid: '1.600519' }, 2)
  assert.equal(r.ok, false)
  assert.match(r.error!, /confirm/)
  assert.equal(applyPositionOp(acc, { op: 'remove', secid: '1.600519', confirm: true }, 3).ok, true)
})
