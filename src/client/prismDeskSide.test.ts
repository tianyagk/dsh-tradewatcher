/**
 * 第二批（右栏：账户总览 / 持仓·挂单 / Agent 绩效 + 底部状态条）对拍断言。
 *
 * 口径来源：`docs/PRISM-DESIGN-DIFF.md` §8–§11 + 本批任务书「右栏要求」。
 * 全部数字都取自实机回包（2026-11-19 15:05 快照）：总资产 1,582,253.68 / 今日 −11,603.82 / 累计 −217,746.32。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  accountViewOf, blockedTodayOf, moneyOf, orderProgressOf, pendingOrdersOf,
  perfCellsOf, ratioPctOf, realizedTodayOf, signedMoneyOf, signedPctOf, sparkOf, statusFactsOf,
} from './prismDeskSide.ts'

const PAGE = readFileSync(new URL('./PrismPage.tsx', import.meta.url), 'utf8')
const CSS = readFileSync(new URL('./styles.ts', import.meta.url), 'utf8')

const REAL_ACCOUNT = {
  totalAssets: 1_582_253.68,
  capitalLimit: 1_800_000,
  dayStartEquity: 1_593_857.5,
  cash: 342_027.68,
  positionPct: 0.7838351180197604,
  rows: [{ marketValue: 1_240_226, pnl: -217_746.32 }],
  equity: [
    { day: '2026-11-18', realized: -521_612.07 },
    { day: '2026-11-19', realized: -566_695.13 },
  ],
  day: '2026-11-19',
}

/* ───────────── ① 金额格式 ───────────── */

test('① 千分位金额：1,582,253.68 / 负数 / 零 / 缺失', () => {
  assert.equal(moneyOf(1_582_253.68), '1,582,253.68')
  assert.equal(moneyOf(-217_746.32), '-217,746.32')
  assert.equal(moneyOf(0), '0.00')
  assert.equal(moneyOf(null), '—')
  assert.equal(moneyOf(Number.NaN), '—')
})

test('② 带符号金额与百分比：+ / − / —', () => {
  assert.equal(signedMoneyOf(-11_603.82), '-11,603.82')
  assert.equal(signedMoneyOf(240), '+240.00')
  assert.equal(signedMoneyOf(null), '—')
  assert.equal(signedPctOf(-0.73), '-0.73%')
  assert.equal(signedPctOf(1.24), '+1.24%')
  assert.equal(signedPctOf(null), '—')
})

test('③ 仓位读数：0.7838 ⇒ 78.4%（一位小数）；缺失 ⇒ —', () => {
  assert.equal(ratioPctOf(0.7838351), '78.4%')
  assert.equal(ratioPctOf(null), '—')
})

/* ───────────── ② 账户总览 ───────────── */

test('④ 账户总览真实值：今日 −11,603.82 (−0.73%) / 累计 −217,746.32 (−12.10%)', () => {
  const v = accountViewOf(REAL_ACCOUNT)
  assert.equal(v.totalText, '1,582,253.68')
  assert.equal(v.dayText, '-11,603.82')
  assert.equal(v.dayPctText, '-0.73%')
  assert.equal(v.dayTone, 'down')
  assert.equal(v.cumText, '-217,746.32')
  assert.equal(v.cumPctText, '-12.10%')
  assert.equal(v.positionText, '78.4%')
})

test('⑤ 今日盈亏 = 总资产 − dayStartEquity（缺 dayStart ⇒ —，不写 0）', () => {
  const v = accountViewOf({ ...REAL_ACCOUNT, dayStartEquity: null })
  assert.equal(v.dayPnl, null)
  assert.equal(v.dayText, '—')
  assert.equal(v.dayPctText, '—')
  assert.equal(v.dayTone, 'flat')
})

test('⑥ 累计 = 总资产 − 净值点资本（state.equity 末点 capital；缺资本与上限 ⇒ —）', () => {
  const v = accountViewOf({ ...REAL_ACCOUNT, capitalLimit: null })
  assert.equal(v.cumPnl, null)
  assert.equal(v.cumText, '—')
  assert.equal(v.cumPctText, '—')
  const withCap = accountViewOf({
    ...REAL_ACCOUNT,
    equity: [
      { day: '2026-11-18', realized: -521_612.07, capital: 1_900_000 },
      { day: '2026-11-19', realized: -566_695.13, capital: 1_900_000 },
    ],
  })
  assert.equal(withCap.cumText, '-317,746.32')
  assert.equal(withCap.cumPctText, '-16.72%')
})

test('⑦ 四格：可用资金 / 持仓市值 / 浮动盈亏 / 今日已实现（顺序 + 真实值）', () => {
  const v = accountViewOf(REAL_ACCOUNT)
  assert.deepEqual(v.cells.map((c) => c.label), ['可用资金', '持仓市值', '浮动盈亏', '今日已实现'])
  assert.equal(v.cells[0].value, '342,027.68')
  assert.equal(v.cells[1].value, '1,240,226.00')
  assert.equal(v.cells[2].value, '-217,746.32')
  assert.equal(v.cells[2].tone, 'down')
  assert.equal(v.cells[3].value, '-45,083.06')
})

test('⑦b 可用资金取现金：现金 342,027.68 + 市值 1,240,226 = 总资产（available 559,774 不得混入）', () => {
  const v = accountViewOf({ ...REAL_ACCOUNT, available: 559_774 } as unknown as Parameters<typeof accountViewOf>[0])
  assert.equal(v.cells[0].value, '342,027.68')
  assert.notEqual(v.cells[0].value, '559,774.00')
  const cash = Number(v.cells[0].value.replace(/,/g, ''))
  const mv = Number(v.cells[1].value.replace(/,/g, ''))
  assert.equal(Math.round(cash + mv), 1_582_254, '现金 + 持仓市值 = 总资产（分位四舍五入）')
})

test('⑦c 缺现金 ⇒ 可用资金 —（不拿 available 顶，title 说明）', () => {
  const v = accountViewOf({ ...REAL_ACCOUNT, cash: null })
  assert.equal(v.cells[0].value, '—')
  assert.match(v.cells[0].title, /现金/)
})

test('⑧ 浮动盈亏：任一行缺 pnl ⇒ —（不部分求和）', () => {
  const v = accountViewOf({ ...REAL_ACCOUNT, rows: [{ marketValue: 1, pnl: -1 }, { marketValue: 2, pnl: null }] })
  assert.equal(v.cells[2].value, '—')
  assert.match(v.cells[2].title, /缺现价/)
})

test('⑨ 今日已实现 = 今日 realized − 上一净值点 realized（−45,083.06）', () => {
  assert.equal(realizedTodayOf(REAL_ACCOUNT.equity, '2026-11-19'), -45_083.06)
})

test('⑩ 今日已实现：最后一个点不是今天 / 只有一个点 / 缺日 ⇒ null', () => {
  assert.equal(realizedTodayOf(REAL_ACCOUNT.equity, '2026-11-20'), null)
  assert.equal(realizedTodayOf([{ day: '2026-11-19', realized: -1 }], '2026-11-19'), null)
  assert.equal(realizedTodayOf(REAL_ACCOUNT.equity, null), null)
})

test('⑪ 反例：今日已实现不得拿累计 realized 冒充（−566,695.13 ≠ −45,083.06）', () => {
  const v = accountViewOf(REAL_ACCOUNT)
  assert.notEqual(v.cells[3].value, '-566,695.13')
})

/* ───────────── ③ 持仓 / 挂单 ───────────── */

test('⑫ 挂单只取 pending（filled/rejected/cancelled 一律不进队列）', () => {
  const orders = [
    { id: 'a', name: 'A', side: 'buy' as const, price: 1, shares: 100, status: 'pending', decidedAt: 1 },
    { id: 'b', name: 'B', side: 'sell' as const, price: 1, shares: 100, status: 'filled', decidedAt: 2 },
    { id: 'c', name: 'C', side: 'sell' as const, price: 1, shares: 100, status: 'rejected', decidedAt: 3 },
  ]
  assert.deepEqual(pendingOrdersOf(orders).map((o) => o.id), ['a'])
  assert.deepEqual(pendingOrdersOf([]), [])
})

test('⑬ 委托进度：已成/总量；缺 filledShares ⇒ 0；股数 0 ⇒ 0；上限夹到 1', () => {
  assert.equal(orderProgressOf({ shares: 2600, filledShares: 1200 }), 1200 / 2600)
  assert.equal(orderProgressOf({ shares: 2600 }), 0)
  assert.equal(orderProgressOf({ shares: 0, filledShares: 10 }), 0)
  assert.equal(orderProgressOf({ shares: 100, filledShares: 300 }), 1)
})

/* ───────────── ④ Agent 绩效 ───────────── */

test('⑭ 绩效四格：决策 20 / 胜率 — / 回撤 — / 超额 —（无源不写 0）', () => {
  const cells = perfCellsOf({ runsCount: 20, hitRate: null, maxDrawdown: null, excessPct: null })
  assert.deepEqual(cells.map((c) => c.label), ['决策', '胜率', '回撤', '超额'])
  assert.deepEqual(cells.map((c) => c.value), ['20', '—', '—', '—'])
  assert.match(cells[1].title, /样本不足/)
  assert.match(cells[3].title, /基准/)
})

test('⑮ 绩效有源：胜率 0 是有效值（不得当成缺失）', () => {
  const cells = perfCellsOf({ runsCount: 3, hitRate: 0, maxDrawdown: -6.8, excessPct: 1.24 })
  assert.deepEqual(cells.map((c) => c.value), ['3', '0.00%', '-6.80%', '+1.24%'])
})

test('⑯ sparkline：取最近 20 点；涨/跌方向；少于 2 点 ⇒ has=false', () => {
  const eq = Array.from({ length: 30 }, (_, i) => ({ equity: 100 + i }))
  const s = sparkOf(eq, 20)
  assert.equal(s.points.length, 20)
  assert.equal(s.points[0].value, 110)
  assert.equal(s.points.at(-1)?.value, 129)
  assert.equal(s.up, true)
  assert.equal(sparkOf([{ equity: 2 }, { equity: 1 }]).up, false)
  assert.equal(sparkOf([{ equity: 1 }]).has, false)
  assert.equal(sparkOf([]).has, false)
})

/* ───────────── ⑤ 底部状态条 ───────────── */

const STATUS = {
  feed: null,
  model: 'cn:deepseek-v4.1-flash',
  modelProvider: 'workbuddy',
  temperature: null,
  times: ['09:35', '11:15', '13:10', '14:35'],
  constraintVersion: null,
  blockedToday: 0,
}

test('⑰ 底条六项顺序：行情源 / 决策引擎 / T / 决策周期 / 约束版本 / 风控', () => {
  assert.deepEqual(statusFactsOf(STATUS).map((f) => f.label), ['行情源', '决策引擎', 'T', '决策周期', '约束版本', '风控'])
})

test('⑱ 底条取值：无源 —（带 title 原因）/ 真实模型 / 四个时点 / 全部通过', () => {
  const f = statusFactsOf(STATUS)
  assert.equal(f[0].value, '—')
  assert.match(f[0].title ?? '', /未提供行情源/)
  assert.equal(f[1].value, 'cn:deepseek-v4.1-flash')
  assert.equal(f[1].title, 'provider workbuddy')
  assert.equal(f[2].value, '—')
  assert.match(f[2].title ?? '', /温度/)
  assert.equal(f[3].value, '09:35 · 11:15 · 13:10 · 14:35')
  assert.equal(f[4].value, '—')
  assert.equal(f[5].value, '全部通过')
})

test('⑲ 底条风控：有拦截 ⇒ 「拦截 N 笔」；无法统计 ⇒ —', () => {
  assert.equal(statusFactsOf({ ...STATUS, blockedToday: 3 })[5].value, '拦截 3 笔')
  assert.equal(statusFactsOf({ ...STATUS, blockedToday: null })[5].value, '—')
})

test('⑳ 反例：无源项不得写演示值（SIM-FEED / v1 / T=0.25）', () => {
  const f = statusFactsOf(STATUS)
  const text = f.map((x) => x.value).join('|')
  assert.ok(!text.includes('SIM-FEED'))
  assert.ok(!text.includes('v1'))
  assert.ok(!text.includes('0.25'))
})

test('㉑ 今日拦截数 = 今日被拒委托 + 今日各轮 decision.rejects；缺 day ⇒ null', () => {
  const orders = [
    { status: 'rejected', day: '2026-11-19' },
    { status: 'rejected', day: '2026-11-18' },
    { status: 'filled', day: '2026-11-19' },
  ]
  const runs = [{ day: '2026-11-19', decision: { rejects: [{}, {}] } }, { day: '2026-11-18', decision: { rejects: [{}] } }]
  assert.equal(blockedTodayOf(orders, runs, '2026-11-19'), 3)
  assert.equal(blockedTodayOf(orders, runs, null), null)
})

/* ───────────── ⑥ DOM / CSS 对拍 ───────────── */

test('㉒ 页面：账户总览 27px 大数 + 只读徽标 + 今日/累计 + 四格 + 仓位条', () => {
  assert.match(PAGE, /'data-role': 'ad-total'/)
  assert.match(PAGE, /'data-role': 'ad-readonly'/)
  assert.match(PAGE, /'今日盈亏'/)
  assert.match(PAGE, /'累计 '/)
  assert.match(PAGE, /acctView\.cells/)
  assert.match(PAGE, /'data-role': 'ad-pos-bar'/)
  assert.match(CSS, /\.tw-ad-acct-total\{[^}]*font-size:27px/)
})

test('㉓ 页面：持仓/挂单 tab 计数真实 + 上限只在「已保存」时显示', () => {
  assert.match(PAGE, /'data-role': 'ad-tab-pos'/)
  assert.match(PAGE, /'data-role': 'ad-tab-ord'/)
  assert.match(PAGE, /String\(posRows\.length\)/)
  assert.match(PAGE, /String\(pending\.length\)/)
  assert.match(PAGE, /perStockSaved === null\s*\n\s*\? null/)
  assert.match(PAGE, /权重 \/ 上限 \$\{numText\(perStockSaved, 0\)\}%/)
})

test('㉔ 页面：空挂单写「—（当前无挂单）」，空持仓走 missText', () => {
  assert.match(PAGE, /'—（当前无挂单）'/)
  assert.match(PAGE, /missText\('持仓'\)/)
})

test('㉕ 页面：绩效四格 + sparkline；样本不足写「—（样本不足）」', () => {
  assert.match(PAGE, /perfCells\.map/)
  assert.match(PAGE, /spark\.has/)
  assert.match(PAGE, /'—（样本不足）'/)
  assert.match(PAGE, /Sparkline/)
})

test('㉖ 页面：底条由 statusFactsOf 渲染六项，高度 28px', () => {
  assert.match(PAGE, /statusFactsOf\(\{/)
  assert.match(PAGE, /'data-role': 'ad-sbar'/)
  assert.match(CSS, /\.tw-ad-sbar\{[^}]*height:28px/)
})

test('㉗ 样式：右栏四格等宽 + 进度条只动 transform（不动 width）', () => {
  assert.match(CSS, /\.tw-ad-perf-row\{display:grid;grid-template-columns:repeat\(4,minmax\(0,1fr\)\)/)
  assert.match(CSS, /\.tw-ad-acct-bar i\{[^}]*transition:transform/)
  assert.match(CSS, /\.tw-ad-ord-prog i\{[^}]*transition:transform/)
  assert.ok(!CSS.includes('transition:width'))
})

test('㉘ 右栏字号全部 ≥12（设计稿 9–11.5px 抬到 12px）', () => {
  const start = CSS.indexOf('/* ── 右栏 · 账户总览')
  const end = CSS.indexOf('/* ── 底部状态条')
  assert.ok(start > 0 && end > start, '找不到右栏样式段')
  const sizes = [...CSS.slice(start, end).matchAll(/font-size:(\d+(?:\.\d+)?)px/g)].map((m) => Number(m[1]))
  assert.ok(sizes.length > 8, `扫描到的字号太少：${sizes.length}`)
  assert.deepEqual(sizes.filter((n) => n < 12), [])
})
test('㉙ 页面：账户四格取 desk.overview.cash（不是可用额度 available）', () => {
  assert.match(PAGE, /cash: ov\?\.cash \?\? null/)
  assert.ok(!PAGE.includes('available: ov?.available'), '可用资金不得用 overview.available 顶替')
})

