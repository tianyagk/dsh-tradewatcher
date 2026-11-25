/** 成本口径：卖出只冲减账面成本，不得把 netCost 冲成负数（审计 A1） */
import test from 'node:test'
import assert from 'node:assert/strict'
import { applyFill } from './prismAccount.ts'
import type { PrismAccount, PrismFill, PrismOrder } from '../shared/prism.ts'

const acc = (): PrismAccount => ({
  day: '2026-11-25', capital: 1_000_000, capitalLimit: 1_000_000, cash: 100_000, realized: 0, dayStartEquity: null,
  positions: [{ secid: '1.600938', name: '中国海油', qty: 10_000, available: 10_000, cost: 10, netCost: 100_000, avgCost: 10 }],
} as PrismAccount)

const order = (shares: number): PrismOrder => ({ id: 'o', secid: '1.600938', name: '中国海油', side: 'sell', price: 30, shares, reason: '', decidedAt: 1, day: '2026-11-25', status: 'filled' } as PrismOrder)
const fill = (shares: number): PrismFill => ({ orderId: 'o', secid: '1.600938', name: '中国海油', side: 'sell', price: 30, shares, amount: 30 * shares, fee: 0, at: 2, source: '1min' })

test('① 盈利卖出：成本不变，netCost 不为负，realized 计入盈利', () => {
  const r = applyFill(acc(), order(3_000), fill(3_000))
  const p = r.positions[0]!
  assert.equal(p.cost, 10, '每股成本不得被卖出所得冲低')
  assert.equal(p.netCost, 70_000)
  assert.equal(r.realized, 60_000, '利润 = (30−10)×3000')
})

test('② 全部卖出后盈利仍正确，且不残留负成本', () => {
  const r = applyFill(acc(), order(10_000), fill(10_000))
  assert.equal(r.positions.length, 0)
  assert.equal(r.realized, 200_000)
})

test('③ 亏损卖出：成本不再抬高（旧口径会从 10 涨到 12.86）', () => {
  const o = { ...order(3_000), price: 5 } as PrismOrder
  const f = { ...fill(3_000), price: 5, amount: 15_000 } as PrismFill
  const r = applyFill(acc(), o, f)
  assert.equal(r.positions[0]!.cost, 10, '亏损卖出后成本仍应为 10')
  assert.equal(r.realized, -15_000)
})

test('④ 路由提供 normalizeCostBasis（把旧摊薄成本对齐 avgCost）', async () => {
  const { readFileSync } = await import('node:fs')
  const r = readFileSync(new URL('./prismRoutes.ts', import.meta.url), 'utf8')
  assert.match(r, /action === 'normalizeCostBasis'/)
  assert.match(r, /cost: avg, netCost:/)
})

test('⑤ 回撤闸门状态进入提示词上下文（审计 P0-4）', async () => {
  const { readFileSync } = await import('node:fs')
  const routes = readFileSync(new URL('./prismRoutes.ts', import.meta.url), 'utf8')
  const pipe = readFileSync(new URL('./prismPipeline.ts', import.meta.url), 'utf8')
  assert.match(routes, /【回撤闸门（引擎判定，先于你的决策）】/)
  assert.match(pipe, /inputs\.drawdown/)
})
