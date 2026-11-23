/** 口径：现金单独作为一种持仓参与权重，全部行（含现金）占比之和 = 100% */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { prismPositionViewOf } from './prismData.ts'
import type { PrismAccount } from '../shared/prism.ts'

const acc = (): PrismAccount => ({
  day: '2026-11-23', capital: 1_000_000, capitalLimit: 1_000_000, cash: 250_000, realized: 0, dayStartEquity: null,
  positions: [
    { secid: '1.518880', name: '黄金ETF华安', qty: 10_000, available: 10_000, cost: 7, netCost: 70_000 },
    { secid: '1.600938', name: '中国海油', qty: 10_000, available: 10_000, cost: 25, netCost: 250_000 },
  ],
} as PrismAccount)

test('① 现金作为一行持仓出现，权重 = 现金 ÷ 总资产', () => {
  const v = prismPositionViewOf(acc(), { '1.518880': 8, '1.600938': 30 })
  const cash = v.rows.find((r) => r.kind === 'cash')
  assert.ok(cash, '必须有现金行')
  assert.equal(cash!.name, '现金')
  assert.equal(cash!.marketValue, 250_000)
  assert.equal(v.totalAssets, 250_000 + 80_000 + 300_000)
  assert.ok(Math.abs((cash!.weight ?? 0) - 250_000 / 630_000) < 1e-9)
})

test('② 含现金的权重之和 = 100%', () => {
  const v = prismPositionViewOf(acc(), { '1.518880': 8, '1.600938': 30 })
  const sum = v.rows.reduce((a, r) => a + (r.weight ?? 0), 0)
  assert.ok(Math.abs(sum - 1) < 1e-9, `权重之和应为 1，实际 ${sum}`)
})

test('③ 现金行没有成本/盈亏（null，不写 0 冒充）', () => {
  const v = prismPositionViewOf(acc(), { '1.518880': 8, '1.600938': 30 })
  const cash = v.rows.find((r) => r.kind === 'cash')!
  assert.equal(cash.pnl, null)
  assert.equal(cash.price, null)
  assert.equal(cash.cost, 0)
})

test('④ 反例：不含现金时持仓权重之和只有 60.3%（说明旧口径看不出现金占比）', () => {
  const v = prismPositionViewOf(acc(), { '1.518880': 8, '1.600938': 30 })
  const posOnly = v.rows.filter((r) => r.kind !== 'cash').reduce((a, r) => a + (r.weight ?? 0), 0)
  assert.ok(Math.abs(posOnly - 380_000 / 630_000) < 1e-9)
  assert.ok(posOnly < 1, '只有持仓行时达不到 100% ⇒ 现金必须单独成行')
})

test('⑤ 界面：现金行不可编辑、不可移除、不可点开详情', () => {
  const page = readFileSync(new URL('../client/PrismPage.tsx', import.meta.url), 'utf8')
  assert.match(page, /p\.kind !== 'cash' && \(e\.key === 'Enter'/)
  assert.match(page, /editing \|\| p\.kind === 'cash' \? null : React\.createElement\('button'/)
  assert.match(page, /p\.kind === 'cash'\s*\?\s*'—'/)
})
