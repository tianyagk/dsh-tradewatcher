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
  const file = { plans: [], trades: [], results: [
      { id: 'r1', planId: 'p1', secid: '1.601872', day: '2026-11-25', buyPrice: 15.2, sellPrice: 15.45, shares: 500, fees: 12.6, net: 112.3, at: 1 },
      { id: 'r2', planId: 'p2', secid: '1.601872', day: '2026-11-25', buyPrice: 15.3, sellPrice: 15.2, shares: 500, fees: 12.6, net: -62.6, at: 2 },
    ] } as never
  const settings = { autoT: { enabled: true, positions: { '1.601872': { enabled: true } } } } as never
  const account = { positions: [{ secid: '1.601872', name: '招商轮船', qty: 1000, available: 1000, cost: 18.21 }] } as never
  const p = autoTPayloadOf(file, settings, account, '2026-11-25', []) as { stats: { rounds: number; profit: number; winRate: number; n: number }; effectiveCost: Record<string, number> }
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

test('⑤ 换日生成 dayOpenQty 开盘快照（收盘对账基线）', async () => {
  const { rollDay } = await import('./prismAccount.ts')
  const acc = {
    day: '2026-11-25', capitalLimit: 1_000_000, cash: 1000, realized: 0, dayStartEquity: null,
    positions: [{ secid: '1.601872', name: '招商轮船', qty: 1000, available: 1000, cost: 10, avgCost: 10 }],
    copiedAt: null, copyLogs: [],
  } as never
  const next = rollDay(acc, '2026-11-26', 1_000_000)
  assert.equal(next.dayOpenQty?.['1.601872'], 1000)
  const same = rollDay(next, '2026-11-26', 1_000_000)
  assert.equal(same.dayOpenQty?.['1.601872'], 1000)
})

test('⑥ 费用门槛被拒（无 PrismOrder）也会进入下一轮提示词', async () => {
  const { rejectedTodayOf, rejectedTodayTextOf } = await import('./prismRoutes.ts')
  const run = { day: '2026-11-27', startedAt: Date.parse('2026-11-27T10:30:00+08:00'), decision: { rejects: [{ secid: '1.601872', side: 'sell', price: 15.17, shares: 120, reason: '费用不经济：成交额 1820 元' }] } }
  const items = rejectedTodayOf([], '2026-11-27', [run] as never)
  assert.equal(items.length, 1)
  assert.equal(items[0]?.reason, '费用不经济：成交额 1820 元')
  assert.match(rejectedTodayTextOf(items), /1\.601872|费用不经济/)
})

test('⑦ 清仓/碎股卖出豁免费用门槛', async () => {
  const { applyFeeGate } = await import('./prismRoutes.ts')
  const dec = (side: 'buy' | 'sell', shares: number) => ({ limits: { singlePct: 30, totalPct: null, note: null }, orders: [{ secid: '1.601872', side, price: 15.17, shares, reason: 'x' }], cancel: [], rejects: [] })
  const held = [{ secid: '1.601872', qty: 120 }]
  assert.equal(applyFeeGate(dec('sell', 120) as never, held).orders.length, 1, '清仓卖出必须放行')
  assert.equal(applyFeeGate(dec('sell', 120) as never, [{ secid: '1.601872', qty: 1000 }]).orders.length, 0, '非清仓小额卖出仍拒')
  assert.equal(applyFeeGate(dec('buy', 100) as never, [{ secid: '1.601872', qty: 100 }]).orders.length, 0, '买入不豁免')
})
