import test from 'node:test'
import assert from 'node:assert/strict'
import { amp20PctOf, atrPctOf, atrRank120Of, factorMetricsOf } from './prismFactors.ts'
import { evaluateAutoT, AUTO_T_RULES } from './prismGates.ts'
import type { DayBar } from '../shared/model.ts'

const bars = (n: number, high = 10.5, low = 9.5, close = 10): DayBar[] => Array.from({ length: n }, (_, i) => ({
  date: `2026-01-${String((i % 28) + 1).padStart(2, '0')}`, open: close, close, high, low, vol: 1000,
}))

test('因子：ATR14/AMP20/分位/tick 计算与缺数', () => {
  const b = bars(140)
  const atr = atrPctOf(b)
  assert.ok(atr !== null && atr > 0)
  const amp = amp20PctOf(b)
  assert.ok(amp !== null && Math.abs(amp - 10) < 0.01, `amp=${amp}`)
  const rank = atrRank120Of(b)
  assert.ok(rank !== null && rank >= 0 && rank <= 100)
  assert.equal(atrPctOf(bars(10)), null)
  assert.equal(amp20PctOf(bars(10)), null)
  const m = factorMetricsOf(b, 'stock')
  assert.equal(m?.tickPct, 0.1)
  assert.equal(m?.bars, 140)
})

test('门槛：数据不足/波动不足/价差/净额/条件满足', () => {
  const okMetrics = { lastClose: 10, atrPct: 2, atrRank120: 60, amp20Pct: 2, tickPct: 0.1, bars: 60 }
  const base = { metrics: okMetrics, buyPrice: 10, sellPrice: 10.2, shares: 1000, direction: 'buy-first' as const, cash: 100000, available: 10000, positionQty: 10000, nowHHMM: 1000 }
  assert.equal(evaluateAutoT(base).ok, true)
  assert.equal(evaluateAutoT({ ...base, metrics: null }).code, 'data-missing')
  assert.equal(evaluateAutoT({ ...base, metrics: { ...okMetrics, atrPct: 0.5 } }).code, 'atr-low')
  assert.equal(evaluateAutoT({ ...base, metrics: { ...okMetrics, atrRank120: 10 } }).code, 'atr-rank-low')
  assert.equal(evaluateAutoT({ ...base, metrics: { ...okMetrics, amp20Pct: 0.5 } }).code, 'amp-low')
  assert.equal(evaluateAutoT({ ...base, sellPrice: 10.05 }).code, 'spread-low')
  assert.equal(evaluateAutoT({ ...base, quoteFromLkg: true }).code, 'lkg-quote')
  assert.equal(evaluateAutoT({ ...base, nowHHMM: 1435 }).code, 'time-window')
  assert.equal(evaluateAutoT({ ...base, shares: 150 }).code, 'position-cap')
  assert.equal(AUTO_T_RULES.version, 't-gate-v2')
})
