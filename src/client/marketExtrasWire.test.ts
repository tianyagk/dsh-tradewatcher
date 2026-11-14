/**
 * v0.81.2（附加行情接线批）：六处逐项的断言 + 反例注入。
 *
 * 新数据来自宿主 `marketExtras.ts`（只读镜像路由 `/tradewatcher/market-extras`）：
 *   ① 涨停/跌停家数（池接口，含样本）  ② 昨日成交（本地快照）  ③ 较昨日变动（派生）
 *   ④ 预测全天（**只在盘中给值**，收盘后回落实际值，口径必须随值走）
 *   ⑤ 两融（双源交叉：不一致时**两个读数都要显示**）  ⑥ 日内家数（仍无源 ⇒ 未取到 + 原因）
 *
 * 红线：缺数据「未取到 + 原因」，**不得 0 顶替**；断言全部落在真源码 / 纯函数上（不自指）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { forecastCellOf, marginRowOf } from './distView.ts'
import type { AmountForecastWire, MarginCrossWire } from './api.ts'

// v0.187.0：MarketPage 的卡片下线后，部分用例已删除

const forecast = (over: Partial<AmountForecastWire> = {}): AmountForecastWire => ({
  current: 2_000_000_000_000,
  forecast: 3_100_000_000_000,
  band: { low: 2_900_000_000_000, high: 3_300_000_000_000 },
  progress: 0.6452,
  caliber: {
    curve: '新浪 5 分钟线 126 个交易日标定的日内成交进度曲线',
    samples: 126,
    generatedAt: '2026-06-01T00:00:00.000Z',
    note: '预测 = 当前累计成交额 ÷ 进度；进度越小误差被放得越大（早盘），故同时给区间并只在盘中给值',
  },
  actual: null,
  phase: 'intraday',
  missing: [],
  ...over,
})

// ── ④ 预测全天：盘中给值 + 口径随值走；收盘后回落实际值 ────────────────────

test('④ 预测全天：盘中给**预测值**且口径（曲线/样本天数/区间/进度）必须随值一起给', () => {
  const c = forecastCellOf(forecast(), '3.10 万亿')
  assert.equal(c.value, '3.10 万亿', '盘中必须给出预测值')
  for (const must of ['新浪 5 分钟线', '126 天', '2026-06-01', '区间', '已过时段占比', '预测']) {
    assert.ok(c.note.includes(must), `口径必须带出来：${must}（实际 ${c.note}）`)
  }
  assert.ok(c.note.includes('非实际值'), '必须点明这是预测而不是实际值')
  assert.equal(/\*\*/.test(c.note), false, '界面字符串不许带 Markdown 星号（项目全局防线）')
  // 反例注入：把口径去掉（只给一个光秃秃的数）⇒ 判据必须失败
  const bare = { ...c, note: '预测全天' }
  assert.equal(bare.note.includes('126 天'), false, '⚠ 反例（缺口径）必须能被抓住')
  assert.throws(
    () => assert.equal(bare.note.includes('126 天'), true, '反例上"必须带口径"必须失败'),
    /反例上/,
    '⚠ 反例注入（预测值缺口径）必须让断言失败',
  )
})

test('④ 收盘后：回落**实际值**、不再给预测；盘前/休市/缺数 ⇒ 未取到 + 原因（不是 0）', () => {
  const closed = forecastCellOf(forecast({ phase: 'closed', forecast: null, actual: 4_200_000_000_000 }), '4.20 万亿')
  assert.equal(closed.value, '4.20 万亿', '收盘后显示实际全天值')
  assert.ok(closed.note.includes('回落') && closed.note.includes('不再给预测'), `要说明是回落实际值（实际 ${closed.note}）`)
  // 反例注入：收盘后仍给预测 ⇒ 判据必须失败
  const stillForecast = forecastCellOf(forecast({ phase: 'intraday' }), '3.10 万亿')
  assert.throws(
    () => assert.equal(stillForecast.note.includes('不再给预测'), true, '反例上"收盘后仍给预测"必须失败'),
    /反例上/,
    '⚠ 反例注入（收盘后仍给预测）必须让断言失败',
  )
  // 盘前 / 非交易日 / 缺当前累计额
  const pre = forecastCellOf(forecast({ phase: 'pre', forecast: null }), '—')
  assert.equal(pre.value, '未取到', '盘前没有预测 ⇒ 未取到')
  assert.ok(pre.note.includes('09:30') && pre.note.includes('不用 0 顶替'), `盘前原因要具体（实际 ${pre.note}）`)
  const nonTrading = forecastCellOf(forecast({ phase: 'non-trading', forecast: null }), '—')
  assert.equal(nonTrading.value, '未取到')
  assert.ok(nonTrading.note.includes('非交易日'), '非交易日要说清')
  const missing = forecastCellOf(forecast({ phase: 'intraday', forecast: null, missing: [{ what: '成交额', why: 'transient', note: '当前累计成交额未取到' }] }), '—')
  assert.equal(missing.value, '未取到', '缺当前累计额 ⇒ 未取到（不是 0）')
  assert.ok(missing.note.includes('当前累计成交额未取到'), '要把宿主的原因带出来')
})

// ── ⑤ 两融：双源不一致时两个读数都显示 ────────────────────────────────────

const margin = (over: Partial<MarginCrossWire> = {}): MarginCrossWire => ({
  szse: { marginBalance: 12280.22, marginBuy: 512.3, shortBalance: 71.2, day: '2026-10-12', source: 'szse' },
  em: { marginBalance: 25252.96, marginBuy: 1103.8, shortBalance: 132.1, day: '2026-10-12', source: 'em' },
  diffPct: 0.5136,
  mismatch: true,
  note: '两源不一致',
  missing: [],
  ...over,
})

test('⑤ 两融：不一致时**两个读数都显示**并标注差异口径（绝不只显示一个）', () => {
  const r = marginRowOf(margin(), (x) => x.marginBalance)
  assert.ok(r.value.includes('深所 12280.22 亿'), `必须显示深交所读数（实际 ${r.value}）`)
  assert.ok(r.value.includes('东财 25252.96 亿'), `必须显示东财读数（实际 ${r.value}）`)
  assert.ok(r.value.includes('不一致'), '必须带不一致标记')
  assert.ok(r.note.includes('51.4%'), `要给出相对差（实际 ${r.note}）`)
  assert.ok(r.note.includes('深市口径') && r.note.includes('沪深汇总'), '要说清差异是口径 + 时点，不是谁错')
  // 反例注入：只显示一个数（掩盖差异）⇒ 判据必须失败
  const masked = { value: '东财 25252.96 亿', note: '两融余额' }
  assert.equal(masked.value.includes('深所'), false, '⚠ 反例（只显示一个源）必须能被抓住')
  assert.throws(
    () => assert.equal(masked.value.includes('深所'), true, '反例上"两个源都要显示"必须失败'),
    /反例上/,
    '⚠ 反例注入（不一致时只显示一个）必须让断言失败',
  )
})

test('⑤ 两融：单源可得出、双源全缺 ⇒ 未取到（不是 0）', () => {
  const onlyEm = marginRowOf(margin({ szse: null, diffPct: null, mismatch: false, note: '只有东财一个源' }), (x) => x.marginBalance)
  assert.equal(onlyEm.value.includes('东财'), true, '单源也要显示（不隐藏）')
  assert.equal(onlyEm.value.includes('深所'), false, '缺的那个源不显示（如实缺失）')
  const none = marginRowOf(margin({ szse: null, em: null, diffPct: null, mismatch: false, note: '两源都没取到' }), (x) => x.marginBalance)
  assert.equal(none.value, '未取到', '两源全缺 ⇒ 未取到')
  assert.ok(none.note.includes('两源都没取到'), '要带原因')
})

// ── ① 涨停/跌停：真值 + 样本；取不到仍是未取到 ─────────────────────────────

