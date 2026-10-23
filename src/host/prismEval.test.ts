import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  EMBARGO_DAYS, EVAL_FOOTNOTE, EVAL_MIN_SAMPLE,
  applyDrawdownGate, drawdownGateOf, evaluationOf, nonOverlappingWindowsOf,
} from './prismEval.ts'
import type { PrismDecision, PrismDrawdownGate, PrismEquityPoint } from '../shared/prism.ts'
import { clampDecision } from './prismAccount.ts'

const here = dirname(fileURLToPath(import.meta.url))
const point = (day: string, equity: number, capital: number, bench: number | null = 100): PrismEquityPoint => ({
  day, equity, capital, benchmarkClose: bench, cash: 0, positionsValue: equity, realized: 0, unrealized: 0, at: Date.parse(`${day}T10:00:00+08:00`),
})

test('P-02 非重叠窗口：100 个重叠事件/持有 5 日 ⇒ n 是独立窗口数，不是 100；embargo 常量回传', () => {
  const windows = nonOverlappingWindowsOf(100, 5)
  assert.ok(windows.length < 100)
  assert.equal(windows.length, 19)
  for (let i = 1; i < windows.length; i++) assert.ok((windows[i]!.start - windows[i - 1]!.start) >= 5)
  assert.equal(EMBARGO_DAYS, 1)
  const points = Array.from({ length: 40 }, (_, i) => point(`2026-01-${String((i % 28) + 1).padStart(2, '0')}`, 1000 + i * 4, 1000, 100 + i))
  const e = evaluationOf(points, {}, 1, EVAL_MIN_SAMPLE)
  assert.equal(e.embargoDays, EMBARGO_DAYS)
  assert.equal(e.footnote, EVAL_FOOTNOTE)
  assert.ok(e.n < 40)
})

test('P-03 超额含费/不含费两个数；n<30 ⇒ —+原因，不返回 0；回撤/命中率也有 n', () => {
  const points = Array.from({ length: 40 }, (_, i) => point(`2026-02-${String((i % 28) + 1).padStart(2, '0')}`, 1000 + i * 5, 1000, 100 + i * 2))
  const e = evaluationOf(points, {}, 1, EVAL_MIN_SAMPLE)
  assert.ok(e.excess.withFee !== null && e.excess.withoutFee !== null, '必须同时给两个数')
  assert.equal(typeof e.drawdown.value, 'number')
  assert.equal(typeof e.hitRate.value, 'number')
  assert.ok(e.n >= 30)
  const small = evaluationOf(points.slice(0, 10), {}, 1, EVAL_MIN_SAMPLE)
  assert.equal(small.excess.withFee, null)
  assert.match(small.excess.reason ?? '', /样本不足 n=\d+ < 30/)
  assert.equal(small.drawdown.value, null)
  assert.match(small.drawdown.reason ?? '', /样本不足/)
  assert.notEqual(small.drawdown.value, 0)
})

test('P-03 文案不含「预测能力」', () => {
  const files = ['../host/prismEval.ts', '../client/PrismPage.tsx', '../host/prismRoutes.ts']
  for (const f of files) assert.equal(readFileSync(join(here, f), 'utf8').includes('预测能力'), false, f)
})

test('P-20 用资本调整后序列：入金造成的 raw 权益跳升不触发；累计 −10% 触发', () => {
  const adjusted = [point('2026-03-01', 1000, 0), point('2026-03-02', 2000, 1000), point('2026-03-03', 1975, 1000)]
  const g = drawdownGateOf(adjusted, null)
  assert.equal(g.dailyPct, -2.5)
  assert.equal(g.cumulativePct, -2.5)
  assert.equal(g.triggered, false, 'raw 权益 2000 但 capital 调整后是 1000；不得按 raw 算')
  const cum = [point('2026-03-01', 1000, 0), point('2026-03-02', 900, 0)]
  const cg = drawdownGateOf(cum, null)
  assert.equal(cg.cumulativePct, -10)
  assert.equal(cg.triggered, true)
  assert.equal(cg.status, '已拒新买单')
  assert.equal(cg.targetTotalPct, 40)
  assert.equal(cg.cashMinPct, 25)
})

test('P-20 触发只拒买、卖单保留；不自动卖出；连续两次触发冻结一轮', () => {
  const d: PrismDecision = {
    limits: { singlePct: 20, totalPct: 60, note: null },
    orders: [
      { secid: '1.1', side: 'buy', price: 10, shares: 100, reason: '' },
      { secid: '1.2', side: 'sell', price: 10, shares: 100, reason: '' },
    ], cancel: [], rejects: [], parseError: null,
  }
  const g = drawdownGateOf([point('2026-04-01', 1000, 0), point('2026-04-02', 880, 0)], null)
  const gated = applyDrawdownGate(d, g)
  assert.equal(gated.orders.length, 1)
  assert.equal(gated.orders[0]?.side, 'sell')
  assert.equal(gated.rejects.length, 1)
  assert.equal(gated.rejects[0]?.side, 'buy')
  const prev = { ...g, freezeRound: false } as PrismDrawdownGate
  const frozen = drawdownGateOf([point('2026-04-01', 1000, 0), point('2026-04-02', 880, 0)], prev)
  assert.equal(frozen.freezeRound, true)
  assert.match(applyDrawdownGate(d, frozen).rejects[0]?.reason ?? '', /冻结/)
})

test('P-11 行业上限 18% 在同一裁剪链生效；缺行业不夹紧', () => {
  const d: PrismDecision = {
    limits: { singlePct: 100, totalPct: 100, note: null, byIndustry: { 半导体: 18 } },
    orders: [{ secid: '1.600000', side: 'buy', price: 10, shares: 2000, reason: '' }], cancel: [], rejects: [], parseError: null,
  }
  const r = clampDecision(d, { cash: 100000, positions: [], limits: d.limits, industries: { '1.600000': '半导体' }, at: 1 })
  assert.equal(r.decision.orders[0]?.shares, 1800, '100000×18%=18000 ⇒ 1800 股')
  const missing = clampDecision(d, { cash: 100000, positions: [], limits: d.limits, industries: {}, at: 1 })
  assert.equal(missing.decision.orders[0]?.shares, 2000)
})
