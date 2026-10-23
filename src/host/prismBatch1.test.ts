import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PrismTradingStore, clampDecision, dayStartMismatchOf, equityPointOf, matchTick } from './prismAccount.ts'
import { mandateHashOf } from './prismPipeline.ts'
import { industryExposureOf } from './prismExposure.ts'
import type { PrismDecision, PrismEquityPoint, PrismOrder } from '../shared/prism.ts'

const day = '2026-10-22'
const at = Date.parse(`${day}T10:00:00+08:00`)
const account = (cash: number) => ({
  day, capitalLimit: 1_500_000, capital: 1_500_000, cash, realized: 0,
  dayStartEquity: null, positions: [], copiedAt: null, copyLogs: [],
})
const order = (over: Partial<PrismOrder> = {}): PrismOrder => ({
  id: 'o1', secid: '1.600000', name: '测试', side: 'buy', price: 10, shares: 200,
  reason: '测试', decidedAt: at - 1000, day, status: 'pending', ...over,
})

test('P-01 净值点带 capital/benchmark；缺 capital 的调整后收益为 —，不拿当前值回填', () => {
  const p = equityPointOf({ ...account(1000), positions: [{ secid: '1.600000', name: '测试', qty: 100, available: 100, cost: 10 }] }, () => 12, at, 4000)
  assert.equal(p.capital, 1_500_000)
  assert.equal(p.benchmarkClose, 4000)
  assert.equal(p.equity, 2200)
  const prev = { ...p, day: '2026-10-21', equity: 2000, capital: 1_500 } as PrismEquityPoint
  assert.equal(p.equity - p.cash, 1200)
  assert.equal(prev.equity - (prev.capital as number), 500)
  assert.equal(dayStartMismatchOf({ ...account(1000), dayStartEquity: null }, [prev]), null, '缺 dayStart 不应告警')
  assert.match(dayStartMismatchOf({ ...account(1000), dayStartEquity: 9999, day }, [prev]) ?? '', /差/)
})

test('P-01 当日盈亏 = 相邻净值点 (equity−capital) 差分，缺 capital 给原因', async () => {
  const { dayPnlOf } = await import('../client/prismView.ts')
  const r = dayPnlOf([{ day: 'a', equity: 1000, capital: 1000 }, { day: 'b', equity: 1100, capital: 1000 }])
  assert.equal(r.value, 100)
  const missing = dayPnlOf([{ day: 'a', equity: 1000 }, { day: 'b', equity: 1100, capital: 1000 }])
  assert.equal(missing.value, null)
  assert.match(missing.reason ?? '', /缺 capital/)
})

test('P-04 mandateHash：剔除 lastFired、含 capital/阈值；改一处即变；全摘要 64 位', () => {
  const base = { times: ['09:35', '14:40'], capital: 1_500_000, lastFired: { '2026-10-22': ['09:35'] }, thresholds: { a: 1 } }
  const a = mandateHashOf('骨架', base)
  const b = mandateHashOf('骨架', { ...base, lastFired: { '2026-10-23': ['14:40'] } })
  const c = mandateHashOf('骨架', { ...base, capital: 1_600_000 })
  assert.equal(a, b)
  assert.notEqual(a, c)
  assert.match(a, /^[0-9a-f]{64}$/)
})

const tick = async (opts: { bars: any[]; source?: '1min' | 'trend' | null; volume?: number | null; shares?: number; rate?: number }) => {
  const dir = await mkdtemp(join(tmpdir(), 'pbbatch-'))
  const store = new PrismTradingStore(dir)
  await store.init()
  await store.saveAccount({ ...account(10000), positions: [], day })
  const o = order({ shares: opts.shares ?? 200 })
  await store.saveOrders([o], [])
  const result = await matchTick(store, {
    now: () => at,
    quotes: async () => ({ '1.600000': { name: '测试', price: 10, prev: 10 } }),
    bars: async () => ({ bars: opts.bars, source: opts.source === undefined ? '1min' : opts.source, reason: null }),
    participationRate: opts.rate ?? 0.1,
  })
  const out = { store, result, dir }
  return out
}

test('P-05 volume=null/0/trend/transient 都保持 pending，并给独立原因码', async () => {
  const miss = await tick({ bars: [{ t: at - 500, high: 11, low: 9, volume: null }] })
  assert.equal(miss.result.filled, 0)
  assert.equal(miss.store.fills().length, 0)
  assert.equal(miss.store.orders()[0]?.status, 'pending')
  assert.equal(miss.store.orders()[0]?.skipCode, 'vol-missing')
  assert.equal(miss.result.skipped[0]?.code, 'vol-missing')
  assert.equal(miss.result.rejects[0]?.code, 'vol-missing', '原因码也进 rejects')
  const zero = await tick({ bars: [{ t: at - 500, high: 11, low: 9, volume: 0 }] })
  assert.equal(zero.store.orders()[0]?.skipCode, 'vol-zero')
  const trend = await tick({ source: 'trend', bars: [{ t: at - 500, high: 11, low: 9 }] })
  assert.equal(trend.store.orders()[0]?.skipCode, 'trend-no-1min')
  const transient = await tick({ source: null, bars: [] })
  assert.equal(transient.store.orders()[0]?.status, 'pending')
  assert.equal(transient.store.orders()[0]?.skipCode, 'transient-source')
  await rm(miss.dir, { recursive: true, force: true }); await rm(zero.dir, { recursive: true, force: true }); await rm(trend.dir, { recursive: true, force: true }); await rm(transient.dir, { recursive: true, force: true })
})

test('P-05 参与率不足 ⇒ 部分成交，余量仍 pending', async () => {
  const { store, result, dir } = await tick({ bars: [{ t: at - 500, high: 11, low: 9, volume: 1000 }], shares: 200 })
  assert.equal(result.filled, 1)
  assert.equal(store.fills()[0]?.shares, 100)
  assert.equal(store.orders()[0]?.status, 'pending')
  assert.equal(store.orders()[0]?.filledShares, 100)
  assert.match(store.orders()[0]?.skipReason ?? '', /部分成交/)
  await rm(dir, { recursive: true, force: true })
})

test('P-08 单票上限裁剪；卖单不动；缺行业不夹', () => {
  const d: PrismDecision = {
    limits: { singlePct: 25, totalPct: 100, note: null },
    orders: [
      { secid: '1.600000', side: 'buy', price: 10, shares: 10000, reason: '' },
      { secid: '1.600001', side: 'sell', price: 10, shares: 10000, reason: '' },
    ], cancel: [], rejects: [], parseError: null,
  }
  const r = clampDecision(d, {
    cash: 100000, positions: [{ secid: '1.600000', qty: 1000, price: 10, industry: '半导体' }],
    limits: d.limits, industries: { '1.600000': '半导体' }, at,
  })
  assert.equal(r.decision.orders[0]?.shares, 1700, '总资产 110000×25%=27500，现仓 10000 ⇒ 1750 向下整手 1700')
  assert.equal(r.decision.orders[1]?.shares, 10000, '卖单不得被裁')
  assert.ok(r.events.some((e) => e.dimension === 'single'))
})


test('P-08 单票 40.92% → 25%：4092 股买单夹到 2500 股', () => {
  const d: PrismDecision = {
    limits: { singlePct: 25, totalPct: 100, note: null },
    orders: [{ secid: '1.600000', side: 'buy', price: 10, shares: 4092, reason: '' }], cancel: [], rejects: [], parseError: null,
  }
  const r = clampDecision(d, { cash: 100000, positions: [], limits: d.limits, industries: {}, at })
  assert.equal(r.decision.orders[0]?.shares, 2500)
  assert.equal(r.events[0]?.dimension, 'single')
  assert.equal(r.events[0]?.before, 4000, '先按整手向下')
})

test('P-08 夹掉不重分配：两个买单的总仓不因第一个被裁而变大', () => {
  const d: PrismDecision = {
    limits: { singlePct: 100, totalPct: 60, note: null }, orders: [
      { secid: '1.600000', side: 'buy', price: 10, shares: 7000, reason: '' },
      { secid: '1.600001', side: 'buy', price: 10, shares: 7000, reason: '' },
    ], cancel: [], rejects: [], parseError: null,
  }
  const r = clampDecision(d, { cash: 100000, positions: [], limits: d.limits, industries: {}, at })
  assert.equal(r.decision.orders.reduce((s, o) => s + o.shares * o.price, 0), 60000)
  assert.equal(r.decision.orders[0]?.shares, 6000)
  assert.equal(r.decision.orders.length, 1, '第二个单被拒，不把第一个裁掉的额度补给它')
  assert.ok(r.events.some((e) => e.dimension === 'total'))
})

test('P-08 缺行业数据时不按行业上限夹紧', () => {
  const d: PrismDecision = {
    limits: { singlePct: 100, totalPct: 100, note: null, byIndustry: { 半导体: 1 } },
    orders: [{ secid: '1.600000', side: 'buy', price: 10, shares: 1000, reason: '' }], cancel: [], rejects: [], parseError: null,
  }
  const r = clampDecision(d, { cash: 100000, positions: [], limits: d.limits, industries: {}, at })
  assert.equal(r.decision.orders[0]?.shares, 1000)
  assert.equal(r.events.some((e) => e.dimension === 'industry'), false)
})

test('P-10 暴露：宽基去重、未穿透独立、现金残差、权重合计 100.00', () => {
  const view = industryExposureOf(
    { cash: 1000, positions: [
      { secid: '1.510300', name: '沪深300ETF', qty: 100, cost: 10 },
      { secid: '1.600000', name: '半导体股', qty: 100, cost: 10 },
      { secid: '1.600001', name: '未知股', qty: 100, cost: 10 },
    ] },
    { '1.510300': 20, '1.600000': 20, '1.600001': 20 },
    { '1.510300': { name: '宽基ETF' }, '1.600000': { name: '半导体' } },
    { 半导体: 20 },
  )
  assert.equal(view.rows.find((r) => r.kind === 'wide')?.name, '宽基 ETF')
  assert.equal(view.rows.filter((r) => r.kind === 'wide').length, 1)
  assert.equal(view.rows.find((r) => r.kind === 'wide')?.family, '大盘')
  assert.equal(view.rows.find((r) => r.kind === 'unpenetrated')?.name, '未穿透')
  assert.equal(Math.round(view.rows.reduce((s, r) => s + r.weight, 0) * 100) / 100, 100)
  assert.equal(Math.round((view.classifiedPct + view.unclassifiedPct) * 100) / 100, 100)
})
