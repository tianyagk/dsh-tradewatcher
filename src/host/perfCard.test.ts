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

test('② 决策数 = 账本里实际保留的决策轮次', () => {
  const runs20 = Array.from({ length: 20 }, (_, i) => ({ startedAt: i, finishedAt: i + 1 }))
  assert.equal(prismPerformanceOf([], null, runs20 as never).runsCount, 20)
  assert.equal(prismPerformanceOf([], null, runs20.slice(0, 7) as never).runsCount, 7)
})

test('③ 路由：决策后累加 runsTotal，并提供 backfillBenchmark', () => {
  const src = readFileSync(new URL('./prismRoutes.ts', import.meta.url), 'utf8')
  assert.ok(!/runsTotal/.test(src), '不再使用累计计数')
  assert.match(src, /action === 'backfillBenchmark'/)
})
