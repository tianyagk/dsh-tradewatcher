/** v0.202.0：棱镜 AGENT DESK 新增字段（只做加法）—— 六条断言，均带反例注入 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import type { PrismOrder, PrismRun } from '../shared/prism.ts'
import { prismAccountOverviewOf, prismDecisionFlowOf, prismDeskOf, prismHoldingDetailOf, prismLimitUsageOf, prismPerformanceOf, prismPositionViewOf } from './prismData.ts'

const account = {
  day: '2026-11-18', capital: 1_000_000, capitalLimit: 1_000_000, cash: 200_000, realized: 0, dayStartEquity: null,
  positions: [
    { secid: '1.510300', name: '沪深300ETF', qty: 100_000, available: 100_000, cost: 4.0, netCost: 4.0 },
    { secid: '1.600519', name: '贵州茅台', qty: 100, available: 100, cost: 1500 },
  ],
  copiedAt: null, copyLogs: [],
}
const prices = { '1.510300': 4.2, '1.600519': 1600 }
const quotes = { '1.510300': { price: 4.2, prev: 4.1 }, '1.600519': { price: 1600, prev: 1590 } }

test('① 六个区块字段齐全（缺一 ⇒ 败）', () => {
  const d = prismDeskOf({ account, prices, quotes, orders: [], fills: [], runs: [], equity: [], evaluation: null })
  for (const k of ['limits', 'positions', 'holdings', 'decisionFlow', 'overview', 'performance'] as const) {
    assert.ok(k in d, `缺区块 ${k}`)
  }
  assert.deepEqual(Object.keys(d.limits).sort(), ['available', 'limit', 'limitState', 'missing', 'used'])
  assert.deepEqual(Object.keys(d.positions.rows[0]!).sort(), ['available', 'cost', 'marketValue', 'name', 'pnl', 'price', 'qty', 'secid', 'weight'])
  assert.deepEqual(Object.keys(d.holdings[0]!).sort(), ['dayPnl', 'missing', 'prevClose', 'secid'])
  assert.deepEqual(Object.keys(d.overview).sort(), ['available', 'cash', 'missing', 'positionPct', 'totalAssets'])
  assert.deepEqual(Object.keys(d.performance).sort(), ['benchmarkPct', 'excessPct', 'hitRate', 'latencyMs', 'maxDrawdown', 'missing', 'returnPct', 'runsCount', 'tokenUsage'])
  assert.throws(() => assert.ok('limits2' in d, '反例上：缺区块'), /反例上/, '⚠ 反例注入必须失败')
})

test('② 新增字段 null 安全：10 组缺数据输入不抛错、不出 NaN/undefined', () => {
  const cases: Array<Record<string, number | null>> = [
    {}, { '1.510300': null }, { '1.510300': Number.NaN }, { '1.510300': 0 },
    { '1.510300': -1 }, { '1.510300': Infinity }, { '1.600519': null },
    { '1.510300': 4.2 }, { '1.600519': 1600 }, { '1.510300': 4.2, '1.600519': 1600 },
  ]
  for (const p of cases) {
    const d = prismDeskOf({ account, prices: p, quotes, orders: [], fills: [], runs: [], equity: [], evaluation: null })
    const walk = (v: unknown, path: string): void => {
      if (v === undefined) throw new Error(`undefined at ${path}`)
      if (typeof v === 'number' && !Number.isFinite(v)) throw new Error(`NaN/Inf at ${path}`)
      if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${path}[${i}]`))
      else if (v !== null && typeof v === 'object') for (const [k, x] of Object.entries(v)) walk(x, `${path}.${k}`)
    }
    walk(d, 'desk')
  }
  assert.throws(() => { const bad = { x: Number.NaN }; if (!Number.isFinite(bad.x)) throw new Error('NaN') }, /NaN/, '⚠ 反例注入必须失败')
})

test('③ prismDecisionFlowOf：五种 action 齐全且按时间升序（降序 ⇒ 败）', () => {
  const orders: PrismOrder[] = [
    { id: 'o1', secid: '1.510300', name: 'A', side: 'buy', price: 4.2, shares: 100, reason: '突破', decidedAt: 1000, day: '2026-11-18', status: 'filled', filledAt: 1100, fillPrice: 4.21, origin: 'auto' },
    { id: 'o2', secid: '1.510300', name: 'A', side: 'sell', price: 4.4, shares: 50, reason: '止盈', decidedAt: 2000, day: '2026-11-18', status: 'pending', origin: 'manual' },
    { id: 'o3', secid: '1.600519', name: 'B', side: 'buy', price: 1500, shares: 10, reason: '试仓', decidedAt: 3000, day: '2026-11-18', status: 'cancelled', cancelledAt: 3100, cancelReason: '撤单', origin: 'auto' },
    { id: 'o4', secid: '1.600519', name: 'B', side: 'buy', price: 1500, shares: 10, reason: '追高', decidedAt: 4000, day: '2026-11-18', status: 'rejected', rejectReason: '超上限', origin: 'auto' },
  ]
  const runs = [{ startedAt: 5000, slot: '14:40', day: '2026-11-18', at: '', reports: [], analyses: [], summary: null, error: null, finishedAt: 5200, decision: { limits: { singlePct: 10, totalPct: 80, note: null }, note: '无机会，持有', orders: [], cancel: [], rejects: [], parseError: null } }] as unknown as PrismRun[]
  const flow = prismDecisionFlowOf({ runs }, orders, [], runs)
  const actions = new Set(flow.map((f) => f.action))
  for (const a of ['buy', 'sell', 'cancel', 'reject', 'hold']) assert.ok(actions.has(a as never), `缺 action ${a}`)
  const times = flow.map((f) => f.at)
  assert.deepEqual(times, [...times].sort((a, b) => a - b), '必须按时间升序')
  assert.equal(flow[0]!.action, 'buy')
  assert.throws(() => assert.deepEqual(times, [...times].sort((a, b) => b - a), '反例上：降序'), /反例上/, '⚠ 反例注入必须失败')
})

test('④ origin 缺省 = unknown（猜成 auto ⇒ 败）', () => {
  const legacy: PrismOrder[] = [{ id: 'x', secid: '1.510300', name: 'A', side: 'buy', price: 4, shares: 1, reason: '', decidedAt: 1, day: 'd', status: 'pending' }]
  const flow = prismDecisionFlowOf({}, legacy, [], [])
  assert.equal(flow[0]!.origin, 'unknown')
  assert.throws(() => assert.equal(flow[0]!.origin, 'auto', '反例上：猜成 auto'), /反例上/, '⚠ 反例注入必须失败')
})

test('⑤ token 用量恒 null 且 missing 含条目（给 0 或假值 ⇒ 败）', () => {
  const p = prismPerformanceOf([], null, [])
  assert.equal(p.tokenUsage, null)
  assert.ok(p.missing.some((m) => m.what === 'token 用量' && m.note === 'token 用量无源'), '必须有 missing 条目')
  assert.throws(() => assert.equal(p.tokenUsage, 0, '反例上：写 0'), /反例上/, '⚠ 反例注入必须失败')
})

test('⑥ 旧字段未被删除或改名（回包新增 desk 且保留 state/trading/modelCatalog）', () => {
  const src = readFileSync(new URL('./prismRoutes.ts', import.meta.url), 'utf8')
  const block = src.slice(src.indexOf("send(res, 200, {"), src.indexOf("return", src.indexOf("send(res, 200, {")))
  for (const key of ['ok: true', 'asOf:', 'state:', 'trading:', 'modelCatalog,']) assert.ok(block.includes(key), `回包缺旧字段 ${key}`)
  assert.ok(block.includes('desk,'), '回包必须新增 desk')
  const injected = block.replace('desk,', '')
  assert.throws(() => assert.ok(injected.includes('desk,'), '反例上：缺 desk'), /反例上/, '⚠ 反例注入必须失败')
})

test('补充：资产上限/持仓/总览的数值口径（used/available/weight/pnl/prevClose/dayPnl）', () => {
  const lim = prismLimitUsageOf(account, prices)
  assert.equal(lim.limit, 1_000_000)
  assert.equal(lim.used, 100_000 * 4.2 + 100 * 1600)
  assert.equal(lim.available, 1_000_000 - lim.used!)
  assert.equal(lim.limitState, 'ok')
  const pos = prismPositionViewOf(account, prices)
  assert.equal(pos.rows[0]!.marketValue, 420_000)
  assert.ok(Math.abs(pos.rows[0]!.pnl! - 20_000) < 1e-6)
  assert.ok(Math.abs(pos.rows[0]!.weight! - 420_000 / pos.totalAssets!) < 1e-12)
  const hold = prismHoldingDetailOf({ secid: '1.510300', qty: 100_000 }, quotes['1.510300']!)
  assert.equal(hold.prevClose, 4.1)
  assert.equal(hold.dayPnl, 100_000 * (4.2 - 4.1))
  const ov = prismAccountOverviewOf(account, prices)
  assert.equal(ov.totalAssets, 200_000 + 580_000)
  assert.ok(Math.abs(ov.positionPct! - 580_000 / 780_000) < 1e-12)
})
