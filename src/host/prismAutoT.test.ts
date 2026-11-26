/** 自动做T 第二阶段：tPlans 解析、回包统计、配对挂单接线 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { parseDecisionDetailed } from './prismAccount.ts'
import { autoTPayloadOf } from './prismRoutes.ts'

const wrap = (body: unknown): string => '```json\n' + JSON.stringify(body) + '\n```'
const plan = (over: Record<string, unknown> = {}) => ({ secid: '1.601872', direction: 'buy-first', buyPrice: 15.2, sellPrice: 15.45, shares: 500, observe: 'o', reasoning: 'r', conclusion: 'c', ...over })

test('① tPlans 解析：合法项保留，非法（价差倒挂/非整手/负价）丢弃', () => {
  const r = parseDecisionDetailed(wrap({ limits: { singlePct: 30, totalPct: 100 }, orders: [], cancel: [], tPlans: [plan(), plan({ sellPrice: 15.0 }), plan({ shares: 150 }), plan({ buyPrice: -1 })] }))
  assert.equal(r.decision?.tPlans?.length, 1)
  assert.equal(r.decision?.tPlans?.[0]?.shares, 500)
})

test('② 回包统计：次数/收益/胜率/有效成本（无结果 ⇒ null 不写 0）', () => {
  const store = {
    autoT: () => ({ plans: [], trades: [], results: [
      { id: 'r1', planId: 'p1', secid: '1.601872', day: '2026-11-25', buyPrice: 15.2, sellPrice: 15.45, shares: 500, fees: 12.6, net: 112.3, at: 1 },
      { id: 'r2', planId: 'p2', secid: '1.601872', day: '2026-11-25', buyPrice: 15.3, sellPrice: 15.2, shares: 500, fees: 12.6, net: -62.6, at: 2 },
    ] }),
    settings: () => ({ autoT: { enabled: true, positions: { '1.601872': { enabled: true } } } }),
  } as never
  const account = { positions: [{ secid: '1.601872', name: '招商轮船', qty: 1000, available: 1000, cost: 18.21 }] } as never
  const p = autoTPayloadOf(store, account, '2026-11-25') as { stats: { rounds: number; profit: number; winRate: number; n: number }; effectiveCost: Record<string, number> }
  assert.equal(p.stats.rounds, 2)
  assert.ok(Math.abs(p.stats.profit - 49.7) < 0.01, `profit=${p.stats.profit}`)
  assert.equal(p.stats.winRate, 50)
  assert.equal(p.stats.n, 2)
  assert.ok(Math.abs(p.effectiveCost['1.601872'] - 18.16) < 0.01, `eff=${p.effectiveCost['1.601872']}`)
})

test('③ 路由：tPlans → 配对挂单（channel:autoT）并结算/截止回补', () => {
  const src = readFileSync(new URL('./prismRoutes.ts', import.meta.url), 'utf8')
  const acc = readFileSync(new URL('./prismAccount.ts', import.meta.url), 'utf8')
  assert.match(src, /channel: 'autoT'/)
  assert.match(src, /placeAutoTPairs/)
  assert.match(acc, /plan\.status = 'done'/)
  assert.match(acc, /plan\.status = 'aborted'/)
  assert.match(acc, /-forced/)
})

test('④ ETF 卖出免印花税；股票仍收 0.1%', async () => {
  const { feesOf } = await import('./prismAccount.ts')
  const etf = feesOf('sell', 2.32, 10_000, 0, 0, true)
  const stock = feesOf('sell', 10, 10_000, 0, 0, false)
  assert.equal(etf.stamp, 0)
  assert.equal(stock.stamp, 100)
  assert.ok(etf.total < stock.total / 2)
})
