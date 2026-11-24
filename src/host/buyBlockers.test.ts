/**
 * 「挂单全是卖出、没有买入」的两条机械原因：
 *  ① 止损判定把 netCost（总成本）当每股成本 ⇒ 任何加仓都算出 −99.9% ⇒ 拒买；
 *  ② 回撤闸门的百分比分母用了「盈利」（累计亏损时基数只剩几十万）⇒ 日波动被放大成假熔断。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { drawdownGateOf } from './prismEval.ts'
import type { PrismEquityPoint } from '../shared/prism.ts'

const ROUTES = readFileSync(new URL('./prismRoutes.ts', import.meta.url), 'utf8')

test('① 止损成本必须是每股成本（p.cost），不得用 netCost', () => {
  const i = ROUTES.indexOf('costs: Object.fromEntries')
  assert.ok(i > 0)
  const seg = ROUTES.slice(i, i + 220)
  assert.match(seg, /p\.qty > 0 \? \(p\.avgCost \?\? p\.cost\) : 0/)
  assert.ok(!/p\.netCost \?\? p\.cost/.test(seg), '旧写法（netCost ?? cost）会把总成本当每股成本')
})

const pt = (day: string, equity: number, capital: number): PrismEquityPoint => ({ day, equity, capital, at: 0 } as PrismEquityPoint)

test('② 累计亏损很大时，日波动按 capital 归一，不再被放大成 −3% 假熔断', () => {
  // 本金 180 万，盈利 −30 万 → −32 万（波动 2 万）
  const g = drawdownGateOf([pt('2026-11-23', 1_500_000, 1_800_000), pt('2026-11-24', 1_480_000, 1_800_000)], null)
  assert.equal(g.dailyPct, -1.11, `日跌幅应按 2万/180万 = -1.11%，实际 ${g.dailyPct}`)
  assert.equal(g.dailyTriggered, false, '-1.11% 不该触发 −3% 熔断')
})

test('③ 反例：按「盈利」做比值分母，负盈利时符号会反 —— 旧实现把亏损算成 +6.7%', () => {
  const prevProfit = 1_500_000 - 1_800_000
  const lastProfit = 1_480_000 - 1_800_000
  const legacy = (lastProfit / prevProfit - 1) * 100
  assert.ok(legacy > 0, `旧实现每天亏 2 万却算出 +${legacy.toFixed(2)}%（符号反了）`)
})

test('④ 累计回撤仍按 capital 归一：−17% 依旧触发（真实累计亏损不能被洗掉）', () => {
  const g = drawdownGateOf([pt('2026-11-01', 1_800_000, 1_800_000), pt('2026-11-24', 1_494_000, 1_800_000)], null)
  assert.equal(g.cumulativePct, -17, '累计应按 30.6万/180万 = -17%')
  assert.equal(g.cumulativeTriggered, true)
  assert.equal(g.status, '已拒新买单')
})
