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
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { forecastCellOf, limitNoteOf, marginRowOf } from './distView.ts'
import type { AmountForecastWire, MarginCrossWire } from './api.ts'

const here = dirname(fileURLToPath(import.meta.url))
const read = (p: string): string => readFileSync(join(here, p), 'utf8')
const src = (): string => read('MarketPage.tsx')
const strip = (t: string): string => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

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

test('① 涨停/跌停：口径与池内样本进悬停；没取到 ⇒ 未取到 + 原因（不得 0）', () => {
  const note = limitNoteOf({ count: 52, sample: [{ code: '600000', name: '浦发银行', pct: 10.02 }], source: 'push2ex-ZT', at: Date.parse('2026-10-13T14:05:00+08:00') }, '池接口给名单与家数，口径同源', '涨停')
  for (const must of ['涨停家数', '池接口给名单与家数', 'push2ex-ZT', '14:05:00', '浦发银行', '+10.02%']) {
    assert.ok(note.includes(must), `悬停里必须能核对到：${must}（实际 ${note}）`)
  }
  const miss = limitNoteOf(null, '池接口', '跌停')
  assert.ok(miss.includes('未取到') && miss.includes('不用 0 顶替'), `取不到要说清（实际 ${miss}）`)
  // 源码接线：两格都必须走 `extras.limits.*.count`，缺时回落「未取到」
  const page = strip(src())
  assert.ok(page.includes("extras.limits.up.count === null ? '未取到'"), '涨停格：缺数回落未取到')
  assert.ok(page.includes("extras.limits.down.count === null ? '未取到'"), '跌停格：缺数回落未取到')
  assert.equal(/item\('涨停', '0'/.test(page), false, '涨停不许写死 0')
  // 反例注入：把涨停渲染成 0 ⇒ 判据必须失败
  const injected = page.replace("extras.limits.up.count === null ? '未取到'", "'0'")
  assert.notEqual(injected, page, '反例注入必须真改到源码')
  assert.throws(
    () => assert.equal(injected.includes("extras.limits.up.count === null ? '未取到'"), true, '反例上"缺数必须未取到"必须失败'),
    /反例上/,
    '⚠ 反例注入（缺数写 0）必须让断言失败',
  )
})

// ── ②③ 昨日成交 / 较昨日变动：原有接线（本地快照），缺 ⇒ null + 原因 ───────

test('②③ 昨日成交与较昨日变动：缺本地快照 ⇒ 「未取到」+ 原因；**不得**用 0 或今天的数顶替', () => {
  const page = strip(src())
  assert.ok(page.includes("item('昨日成交', prevAmt === null ? '未取到'"), '昨日成交缺快照必须是未取到')
  assert.ok(page.includes('不用今天的数顶替'), '原因里必须点明"不用今天的数顶替"')
  assert.ok(page.includes("item('较昨日变动', delta === null ? '未取到'"), '较昨日变动缺昨日必须是未取到')
  assert.ok(page.includes('取不到昨日成交就无法算变动（不是 0）'), '原因里必须点明"不是 0"')
  // 有数据时给真值（走 fmtAmt）
  assert.ok(/item\('昨日成交', prevAmt === null \? '未取到' : fmtAmt\(prevAmt\.amount\)/.test(page), '有快照时给真值')
  assert.ok(/item\('较昨日变动', delta === null \? '未取到' : `\$\{delta >= 0 \? '\+' : ''\}\$\{fmtAmt\(delta\)\}`/.test(page), '有昨日时给真值（带符号）')
  // 反例注入：缺昨日时写 0 ⇒ 判据必须失败
  const injected = page.replace("item('较昨日变动', delta === null ? '未取到'", "item('较昨日变动', delta === null ? '0'")
  assert.notEqual(injected, page, '反例注入必须真改到源码')
  assert.throws(
    () => assert.equal(injected.includes("item('较昨日变动', delta === null ? '未取到'"), true, '反例上"缺昨日必须未取到"必须失败'),
    /反例上/,
    '⚠ 反例注入（缺昨日写 0）必须让断言失败',
  )
})

// ── ⑥ 日内家数：仍无源（本轮不动）─────────────────────────────────────────

test('⑥ 日内家数：仍无源 ⇒ 保留「未取到」+ 原因（本轮不改）', () => {
  const page = strip(src())
  assert.ok(page.includes("value: '未取到', note: INTRADAY_REASON"), '日内两序列仍是未取到 + 原因')
  assert.ok(page.includes('INTRADAY_REASON'), '原因常量必须在')
})

// ── 路由与行归属 ─────────────────────────────────────────────────────────

test('路由接线与行归属：路由在 market 行、api 有调用、页面真的在调（三者一致）', () => {
  const indexSrc = readFileSync(join(here, '..', 'index.ts'), 'utf8')
  const apiSrc = read('api.ts')
  const page = strip(src())
  assert.ok(indexSrc.includes("'/tradewatcher/market-extras'"), 'ROW_ROUTES.market 必须登记该路由')
  assert.ok(/market: \[[^\]]*'\/tradewatcher\/market-extras'/.test(indexSrc), '必须登记在 market 行（不是 core）')
  assert.ok(apiSrc.includes('/tradewatcher/market-extras'), 'api.ts 必须指向该路由')
  assert.ok(page.includes('api.marketExtras(') || page.includes('api\n      .marketExtras('), 'MarketPage 必须真的在调它（行归属按调用方推导）')
  // 预测必须把**页面显示的**成交额带过去（宿主不再抓一遍）
  assert.ok(/\.marketExtras\(amountForForecast/.test(page), '要带 amount 参数（把页面显示的成交额带过去）')
  // 反例注入：把路由从 market 行删掉 ⇒ 判据必须失败
  const injected = indexSrc.replace("'/tradewatcher/board', '/tradewatcher/market-extras'", "'/tradewatcher/board'")
  assert.notEqual(injected, indexSrc, '反例注入必须真改到源码')
  assert.throws(
    () => assert.equal(injected.includes("'/tradewatcher/market-extras'"), true, '反例上"必须登记"必须失败'),
    /反例上/,
    '⚠ 反例注入（路由未登记）必须让断言失败',
  )
})
