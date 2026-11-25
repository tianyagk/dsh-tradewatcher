/** v0.202.0：棱镜 AGENT DESK 新增字段（只做加法）—— 六条断言，均带反例注入 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import type { PrismOrder, PrismRun } from '../shared/prism.ts'
import { HOLD_CONSTRAINT_NONE, HOLD_THESIS_NONE, holdingAnalysesOf, prismAccountOverviewOf, prismDecisionFlowOf, prismDeskOf, prismHoldingDetailOf, prismLimitUsageOf, prismPerformanceOf, prismPositionViewOf, thesisOf } from './prismData.ts'

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
  assert.deepEqual(Object.keys(d.holdings[0]!).sort(), ['dayPnl', 'missing', 'prevClose', 'secid', 'thesis'])
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

test('⑥ 回包保留 state/modelCatalog/desk（顶层 trading 已按审计删除，避免重复序列化）', () => {
  const src = readFileSync(new URL('./prismRoutes.ts', import.meta.url), 'utf8')
  const start = src.indexOf("slimPrismPayload({")
  const block = src.slice(start, src.indexOf("return", start))
  for (const key of ['ok: true', 'asOf:', 'state:', 'modelCatalog,']) assert.ok(block.includes(key), `回包缺旧字段 ${key}`)
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

/* ───────────── ⑦ 个股研判 thesisOf（v0.211.0，≥10 条断言含反例注入） ───────────── */

const OLD_601398: PrismOrder = {
  id: 'o-1795152026587-1.601398-buy-9.17-1400', secid: '1.601398', name: '工商银行', side: 'buy', price: 9.17, shares: 1400,
  reason: '低波端黄金+长债仅7.50%<10%，缺口约4.02万元；按规则10只做首批约1/3，用红利银行补低波，不追成长。',
  decidedAt: 1_795_152_026_587, day: '2026-11-20', status: 'filled',
}
const NEW_601398: PrismOrder = {
  id: 'o-1795156226684-1.601398-buy-9.14-1000', secid: '1.601398', name: '工商银行', side: 'buy', price: 9.14, shares: 1000,
  reason: '红利端补位第二批，今日+0.44%逆势收红验证对冲价值；与长债共同把低波端补至约9.98%，银行板块暴露仍仅约1.4%',
  decidedAt: 1_795_156_226_684, day: '2026-11-20', status: 'filled',
}
const OTHER_STOCK: PrismOrder = {
  id: 'o-other', secid: '1.600938', name: '中国海油', side: 'sell', price: 25, shares: 100,
  reason: '别的股票的理由：油气高位止盈', decidedAt: 1_795_160_000_000, day: '2026-11-20', status: 'filled',
}
const RUN_AT = '2026-11-20T14:50:26+08:00'
const runWithNote = (note: string | null, at: string = RUN_AT, analyses: PrismRun['analyses'] = []): PrismRun => ({
  slot: '14:50', day: '2026-11-20', at, reports: [], analyses, summary: null, error: null,
  startedAt: 1_795_157_426_706, finishedAt: null,
  decision: note === null ? null : { limits: { singlePct: null, totalPct: null, note: null }, note, orders: [], cancel: [], rejects: [], parseError: null },
}) as PrismRun

test('⑦ 有该股委托 ⇒ 最新 reason / kind=order / at=decidedAt', () => {
  const t = thesisOf('1.601398', '工商银行', [NEW_601398], [])
  assert.deepEqual(t, { text: NEW_601398.reason, at: NEW_601398.decidedAt, kind: 'order' })
})

test('⑧ 多笔委托（乱序）⇒ 取 decidedAt 最新的一条，旧的不覆盖', () => {
  for (const orders of [[OLD_601398, NEW_601398], [NEW_601398, OLD_601398], [OTHER_STOCK, OLD_601398, NEW_601398]]) {
    const t = thesisOf('1.601398', '工商银行', orders, [])
    assert.equal(t?.text, NEW_601398.reason, '必须是最新一笔（别的股票更晚也不得顶替）')
    assert.equal(t?.at, NEW_601398.decidedAt)
    assert.equal(t?.kind, 'order')
  }
})

test('⑨ 反例注入：把旧委托理由当结果 ⇒ 必败', () => {
  const t = thesisOf('1.601398', '工商银行', [OLD_601398, NEW_601398], [])
  assert.notEqual(t?.text, OLD_601398.reason)
  assert.throws(() => assert.equal(t?.text, OLD_601398.reason, '反例上：旧理由'), /反例上/, '⚠ 反例注入必须失败')
})

test('⑩ 无委托但 note 提到股票名称 ⇒ kind=run-note + 首句 + at=run.at', () => {
  const note = '工商银行低波补位完成，银行板块暴露仍约1.4%。不卖：总量不减，现金即缓冲。'
  const t = thesisOf('1.601398', '工商银行', [], [runWithNote(note)])
  assert.equal(t?.kind, 'run-note')
  assert.equal(t?.text, '工商银行低波补位完成，银行板块暴露仍约1.4%。')
  assert.equal(t?.at, Date.parse(RUN_AT))
  assert.ok(!t?.text.includes('不卖'), '首句之外的内容不得混入')
})

test('⑪ 无委托但 note 只提到 6 位代码（601398）⇒ 也命中 run-note', () => {
  const t = thesisOf('1.601398', '工商银行', [], [runWithNote('601398 尾盘放量，暂不追加。下午观察。')])
  assert.equal(t?.kind, 'run-note')
  assert.equal(t?.text, '601398 尾盘放量，暂不追加。')
})

test('⑫ 反例注入：note 只提到别的股票 ⇒ thesis=null（不得用别股理由顶替）', () => {
  const note = '中国海油高位止盈，油气暴露降至3%。其余不动。'
  const t = thesisOf('1.601398', '工商银行', [], [runWithNote(note)])
  assert.equal(t, null)
  assert.throws(() => assert.equal(t?.text, '中国海油高位止盈，油气暴露降至3%。', '反例上：别股理由'), /反例上/, '⚠ 反例注入必须失败')
})

test('⑬ 无委托、note 未提该股 ⇒ thesis === null（不编）', () => {
  assert.equal(thesisOf('1.601398', '工商银行', [], [runWithNote('观察为主，等周一日韩开盘。')]), null)
  assert.equal(thesisOf('1.601398', '工商银行', [], []), null)
})

test('⑭ 反例注入：宏观研报（analyses）里提到该股，但 decision.note 没提 ⇒ 仍是 null', () => {
  const run = runWithNote('总量不减，现金即缓冲。', RUN_AT, [{ key: 'a-macro', label: 'A股宏观', text: '工商银行等大行受益于红利风格。', error: null }])
  assert.equal(thesisOf('1.601398', '工商银行', [], [run]), null)
})

test('⑮ prismDeskOf：thesis 挂在 holdings 上，且不跨股票借用', () => {
  const d = prismDeskOf({ account, prices, quotes, orders: [NEW_601398], fills: [], runs: [], equity: [], evaluation: null })
  const icbc = d.holdings.find((h) => h.secid === '1.601398')
  assert.equal(icbc, undefined, '该账户没有 601398 持仓')
  const mt = d.holdings.find((h) => h.secid === '1.600519')
  assert.equal(mt?.thesis, null, '茅台没有委托/研判 ⇒ null，不得借用工商银行')
  const withIcbc = {
    ...account,
    positions: [...account.positions, { secid: '1.601398', name: '工商银行', qty: 1000, available: 1000, cost: 9.14 }],
  }
  const d2 = prismDeskOf({ account: withIcbc, prices: { ...prices, '1.601398': 9.2 }, quotes, orders: [OLD_601398, NEW_601398], fills: [], runs: [], equity: [], evaluation: null })
  const h = d2.holdings.find((x) => x.secid === '1.601398')
  assert.equal(h?.thesis?.kind, 'order')
  assert.equal(h?.thesis?.text, NEW_601398.reason)
  assert.equal(h?.thesis?.at, NEW_601398.decidedAt)
})

test('⑯ 委托 reason 为空 ⇒ 不拿空串当研判；回退到提到该股的 note', () => {
  const empty: PrismOrder = { ...NEW_601398, id: 'o-empty', reason: '   ' }
  const t = thesisOf('1.601398', '工商银行', [empty], [runWithNote('工商银行继续持有。')])
  assert.equal(t?.kind, 'run-note')
  assert.equal(t?.text, '工商银行继续持有。')
})

test('⑰ run.at 解析失败 ⇒ 回退 startedAt（仍是 number，不编日期）', () => {
  const run = runWithNote('工商银行继续持有。', 'not-a-date')
  const t = thesisOf('1.601398', '工商银行', [], [run])
  assert.equal(t?.at, 1_795_157_426_706)
})

/* ───────────── ⑱ 持仓分析 HOLD（v0.212.0，含反例注入） ───────────── */

const GOLD_ACCOUNT = {
  day: '2026-11-21', capital: 1_000_000, capitalLimit: 1_000_000, cash: 500_000, realized: 0, dayStartEquity: null,
  positions: [{ secid: '1.518880', name: '黄金ETF华安', qty: 100_000, available: 100_000, cost: 4.0 }],
  copiedAt: null, copyLogs: [],
}
const GOLD_PRICES = { '1.518880': 5.0 }
const GOLD_HOLDING = [{ secid: '1.518880', prevClose: 4.9, thesis: null }]
const goldOverview = (): ReturnType<typeof prismAccountOverviewOf> => prismAccountOverviewOf(GOLD_ACCOUNT, GOLD_PRICES)
const goldOf = (constraints: { perStockPct?: number | null; stopLossPct?: number | null } | null, holdings = GOLD_HOLDING, runs: PrismRun[] = []) =>
  holdingAnalysesOf(GOLD_ACCOUNT, GOLD_PRICES, goldOverview(), constraints, holdings, runs)[0]!

test('⑱ 每个持仓一条 HOLD；数量 = 持仓数（少一条 ⇒ 败）', () => {
  const three = {
    ...GOLD_ACCOUNT,
    positions: [
      ...GOLD_ACCOUNT.positions,
      { secid: '1.510300', name: '沪深300ETF', qty: 10_000, available: 10_000, cost: 4.0 },
      { secid: '1.600519', name: '贵州茅台', qty: 100, available: 100, cost: 1500 },
    ],
  }
  const list = holdingAnalysesOf(three, { '1.518880': 5.0, '1.510300': 4.2, '1.600519': 1600 }, prismAccountOverviewOf(three, { '1.518880': 5.0, '1.510300': 4.2, '1.600519': 1600 }), { perStockPct: 15, stopLossPct: 8 }, [])
  assert.equal(list.length, three.positions.length, '每个持仓一条')
  assert.deepEqual(list.map((x) => x.secid), three.positions.map((p) => p.secid), '顺序 = 持仓顺序')
  assert.throws(() => assert.equal(list.length, 2, '反例上：漏掉一条'), /反例上/, '⚠ 反例注入必须失败')
})

test('⑲ 观察四项：权重 / 浮盈 / 当日 / 持仓市值（固定 payload，逐项可复算）', () => {
  const a = goldOf({ perStockPct: 60, stopLossPct: 8 })
  assert.equal(a.observation, '权重 50.0%（单票上限 60%） · 浮盈 +25.00% · 当日 +2.04% · 持仓市值 50.0万')
  assert.equal(a.weight, 0.5)
  assert.equal(a.marketValue, 500_000)
  assert.ok(Math.abs((a.pnlPct as number) - 25) < 1e-9, '浮盈 = 现价 / 成本 − 1')
  assert.ok(Math.abs((a.dayPct as number) - (5.0 / 4.9 - 1) * 100) < 1e-9, '当日 = 现价 / 昨收 − 1')
  // 反例：缺成本价时写 0.00% 顶替 ⇒ 必败
  const noCost = { ...GOLD_ACCOUNT, positions: [{ ...GOLD_ACCOUNT.positions[0]!, cost: null as unknown as number }] }
  const miss = holdingAnalysesOf(noCost, GOLD_PRICES, prismAccountOverviewOf(noCost, GOLD_PRICES), { perStockPct: 60, stopLossPct: 8 }, GOLD_HOLDING)[0]!
  assert.match(miss.observation, /浮盈 —（缺成本价或现价）/, '缺数据必须 `—` + 原因')
  assert.throws(() => assert.equal(miss.observation, '浮盈 +0.00%', '反例上：缺成本写 0'), /反例上/, '⚠ 反例注入必须失败')
})

test('⑳ 推理·超单票上限：权重 50.0% > 15% ⇒ 写判定 + 依据', () => {
  const a = goldOf({ perStockPct: 15, stopLossPct: 8 })
  assert.equal(a.verdict, 'over')
  assert.equal(a.reasoning, '超单票上限（权重 50.0% > 单票上限 15%）')
})

test('㉑ 推理·触及止损线：浮亏 -10.00% ≤ −8% ⇒ 写判定 + 依据', () => {
  const acc = { ...GOLD_ACCOUNT, positions: [{ ...GOLD_ACCOUNT.positions[0]!, cost: 4.0 }] }
  const prices = { '1.518880': 3.6 }
  const a = holdingAnalysesOf(acc, prices, prismAccountOverviewOf(acc, prices), { perStockPct: 60, stopLossPct: 8 }, [{ secid: '1.518880', prevClose: 3.7, thesis: null }])[0]!
  assert.equal(a.verdict, 'stop')
  assert.equal(a.reasoning, '触及止损线（浮亏 -10.00% ≤ −8%）')
})

test('㉒ 推理·未触及：50.0% ≤ 60%（未超上限）且 +25.00% > −8%（未触止损）', () => {
  const a = goldOf({ perStockPct: 60, stopLossPct: 8 })
  assert.equal(a.verdict, 'ok')
  assert.equal(a.reasoning, '未触及上限/止损线（权重 50.0% ≤ 60%，浮亏 +25.00% > −8%）')
})

test('㉓ 推理·约束未设置 ⇒ —（约束未设置，无法判定）；默认 15/8 顶替 ⇒ 必败', () => {
  const cases: Array<{ perStockPct?: number | null; stopLossPct?: number | null } | null | undefined> = [null, undefined, {}, { perStockPct: null, stopLossPct: null }, { perStockPct: 15 }]
  for (const c of cases) {
    const a = goldOf(c)
    assert.equal(a.reasoning, HOLD_CONSTRAINT_NONE, `约束 ${JSON.stringify(c)} 未完整保存`)
    assert.equal(a.verdict, 'no-constraint')
    assert.equal(a.perStockPct, c !== null && c !== undefined && typeof c.perStockPct === 'number' ? 15 : null)
  }
  assert.throws(
    () => assert.equal(goldOf(null).reasoning, '超单票上限（权重 50.0% > 单票上限 15%）', '反例上：用默认 15/8'),
    /反例上/, '⚠ 反例注入必须失败',
  )
})

test('㉔ 结论：有 thesis 用原文；没有 ⇒ —（该股暂无研判）（拿别股/宏观顶替 ⇒ 败）', () => {
  const thesis = { text: '黄金端对冲价值仍在，继续持有。', at: 1_795_156_226_684, kind: 'order' as const }
  assert.equal(goldOf({ perStockPct: 60, stopLossPct: 8 }, [{ secid: '1.518880', prevClose: 4.9, thesis }]).conclusion, thesis.text)
  assert.equal(goldOf({ perStockPct: 60, stopLossPct: 8 }, [{ secid: '1.518880', prevClose: 4.9, thesis: null }]).conclusion, HOLD_THESIS_NONE)
  assert.equal(HOLD_THESIS_NONE, '—（该股暂无研判）')
  assert.throws(() => assert.equal(goldOf({ perStockPct: 60, stopLossPct: 8 }).conclusion, '别的股票的研判', '反例上：编研判'), /反例上/, '⚠ 反例注入必须失败')
})

test('㉕ 时间戳：thesis.at 优先；无则最近一轮 run 的 at；都没有 ⇒ null（不编）', () => {
  const thesis = { text: '继续持有。', at: 1_795_156_226_684, kind: 'order' as const }
  assert.equal(goldOf({ perStockPct: 60, stopLossPct: 8 }, [{ secid: '1.518880', prevClose: 4.9, thesis }]).at, thesis.at)
  const runLater = runWithNote('黄金ETF华安继续持有。', '2026-11-20T15:01:00+08:00')
  const runEarlier = runWithNote('观察为主。', '2026-11-20T09:35:00+08:00')
  const noThesis = goldOf({ perStockPct: 60, stopLossPct: 8 }, GOLD_HOLDING, [runEarlier, runLater])
  assert.equal(noThesis.at, Date.parse('2026-11-20T15:01:00+08:00'), '取最近一轮 run 的 at')
  assert.equal(goldOf({ perStockPct: 60, stopLossPct: 8 }, GOLD_HOLDING, []).at, null, '无 run ⇒ null（界面 —）')
  assert.throws(() => assert.equal(goldOf({ perStockPct: 60, stopLossPct: 8 }, GOLD_HOLDING, []).at, 0, '反例上：写 0'), /反例上/, '⚠ 反例注入必须失败')
})

test('㉖ prismDeskOf：holdingAnalyses 挂在 desk 上、不写 runs、不混进宿主 decisionFlow', () => {
  const runs = [runWithNote('黄金ETF华安继续持有。', RUN_AT)]
  const before = JSON.stringify(runs)
  const d = prismDeskOf({ account: GOLD_ACCOUNT, prices: GOLD_PRICES, quotes: { '1.518880': { price: 5.0, prev: 4.9 } }, orders: [], fills: [], runs, equity: [], evaluation: null, constraints: { perStockPct: 60, stopLossPct: 8 } })
  assert.equal(d.holdingAnalyses.length, GOLD_ACCOUNT.positions.length)
  assert.equal(d.holdingAnalyses[0]!.conclusion, '黄金ETF华安继续持有。')
  assert.equal(JSON.stringify(runs), before, '不得改写 runs')
  assert.ok(!d.decisionFlow.some((f) => f.action === 'hold' && f.secid === '1.518880'), 'HOLD 由客户端合并，不写进宿主 decisionFlow')
  // 源码层：宿主不产生任何写路径
  const src = readFileSync(new URL('./prismData.ts', import.meta.url), 'utf8')
  for (const bad of ['replaceRun', 'saveAccount', 'placeDecision', 'appendPrismLedger']) assert.ok(!src.includes(bad), `prismData.ts 不得出现写路径 ${bad}`)
  assert.throws(() => assert.ok(src.includes('placeDecision'), '反例上：宿主写 runs'), /反例上/, '⚠ 反例注入必须失败')
})
