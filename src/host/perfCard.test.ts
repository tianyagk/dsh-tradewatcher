/** 绩效卡：回撤不再被 30 窗口门槛卡成 —；决策数用累计计数 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { evaluationOf } from './prismEval.ts'
import { prismPerformanceOf } from './prismData.ts'
import type { PrismEquityPoint } from '../shared/prism.ts'

const pt = (day: string, equity: number): PrismEquityPoint => ({ day, at: 1, equity, capital: 1_800_000, cash: 0, positionsValue: 0, realized: 0, unrealized: 0, benchmarkClose: null } as PrismEquityPoint)

test('① 5 个净值点也能算出回撤（不再要求 30 窗口）', () => {
  const e = evaluationOf([pt('2026-11-21', 1_500_000), pt('2026-11-22', 1_460_000), pt('2026-11-24', 1_480_000), pt('2026-11-25', 1_455_000)], {}, 1, 30)
  assert.equal(typeof e.drawdown.value, 'number')
  assert.ok((e.drawdown.value as number) < 0)
})

test('② 决策数取累计与内存的较大值（升级首轮不会从 20 掉到 1）', () => {
  const runs20 = Array.from({ length: 20 }, (_, i) => ({ startedAt: i, finishedAt: i + 1 })) as never
  assert.equal(prismPerformanceOf([], null, runs20, 1).runsCount, 20)
  assert.equal(prismPerformanceOf([], null, runs20, 137).runsCount, 137)
})

test('②b 决策数优先用累计计数（不被 20 条保留上限卡住）', () => {
  const runs = Array.from({ length: 20 }, (_, i) => ({ startedAt: i, finishedAt: i + 1 })) as never
  const p = prismPerformanceOf([], null, runs, 137)
  assert.equal(p.runsCount, 137)
})

test('③ 路由：决策后累加 runsTotal，并提供 backfillBenchmark', () => {
  const src = readFileSync(new URL('./prismRoutes.ts', import.meta.url), 'utf8')
  assert.match(src, /runsTotal: \(deps\.store\.settings\(\)\.runsTotal \?\? 0\) \+ 1/)
  assert.match(src, /action === 'backfillBenchmark'/)
})
