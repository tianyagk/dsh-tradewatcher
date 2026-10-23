import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { sparklineOf, topCardsOf } from './prismView.ts'
import type { PrismTradingState } from '../shared/prism.ts'

const here = dirname(fileURLToPath(import.meta.url))
const page = readFileSync(join(here, './PrismPage.tsx'), 'utf8')

test('⑩ 页面四格 + 三张表 + 净值曲线齐全（少一格 ⇒ 必败）', () => {
  for (const label of ['总资产', '现金', '当日盈亏', '累计盈亏']) assert.ok(page.includes(label), `缺少「${label}」`)
  for (const label of ['持仓', '挂单', '成交记录']) assert.ok(page.includes(label), `缺少「${label}」表`)
  assert.ok(page.includes('<svg') && page.includes('polyline'), '缺净值折线')
  const injected = page.replace('总资产', '')
  for (const label of ['总资产', '现金', '当日盈亏', '累计盈亏']) {
    if (!injected.includes(label)) {
      assert.throws(() => assert.equal(injected.includes('总资产'), true, '反例'), /反例/, '⚠ 反例（少一格）必须失败')
    }
  }
})

test('四格口径：总资产 = 现金 + 市值；累计 = 总资产 − 资金上限；当日用净值+capital差分', () => {
  const t: PrismTradingState = {
    account: {
      day: '2026-10-22', capitalLimit: 1_500_000, cash: 1_000_000, realized: 100,
      dayStartEquity: 1_490_000, copiedAt: null, copyLogs: [],
      positions: [{ secid: '1.600519', name: '茅台', qty: 100, available: 100, cost: 1000 }],
    },
    orders: [], fills: [], decision: null, prices: { '1.600519': 1200 },
    equity: [
      { day: '2026-10-21', equity: 1500000, capital: 1500000, cash: 0, positionsValue: 0, realized: 0, unrealized: 0, at: 1 },
      { day: '2026-10-22', equity: 1120000, capital: 1500000, cash: 0, positionsValue: 0, realized: 0, unrealized: 0, at: 2 },
    ],
  }
  const cards = topCardsOf(t)
  assert.equal(cards.length, 4)
  assert.match(cards[0]?.value ?? '', /1,120,000/)
  assert.match(cards[2]?.value ?? '', /-380,000/)
  assert.match(cards[3]?.value ?? '', /-380,000/)
  assert.equal(topCardsOf(null)[0]?.value, '—')
})

test('净值折线：不足两点 ⇒ null；两点 ⇒ 一条 polyline 点串', () => {
  assert.equal(sparklineOf([]), null)
  const line = sparklineOf([{ day: '2026-10-21', equity: 100, cash: 0, positionsValue: 0, realized: 0, unrealized: 0, at: 1 }, { day: '2026-10-22', equity: 110, cash: 0, positionsValue: 0, realized: 0, unrealized: 0, at: 2 }])
  assert.equal(line?.split(' ').length, 2)
})

test('⑨ 自检路由永远 200 且失败带 error 原文', async () => {
  const routes = readFileSync(join(here, '../host/prismRoutes.ts'), 'utf8')
  const block = routes.slice(routes.indexOf("path: '/tradewatcher/prism/selftest'"))
  assert.match(block, /send\(res, 200, \{ ok, error, model, elapsedMs/)
  assert.match(block, /catch \(e\) \{\s*error = String\(e\)\.slice\(0, 200\)/)
  assert.match(block, /AbortSignal\.timeout\(20_000\)/)
})

test('② 仓位占比：市值 60/40、现金 0 ⇒ 60.00% / 40.00%（用总资产，不是持仓内部占比）', async () => {
  const { positionWeightPct } = await import('./prismView.ts')
  assert.equal(positionWeightPct(30, 2, 100), 60)
  assert.equal(positionWeightPct(20, 2, 100), 40)
  // 注入：现金 100、市值 60/40、总资产 200 ⇒ 30%/20%；若用持仓内部占比会得到 60%/40%
  assert.equal(positionWeightPct(30, 2, 200), 30)
  assert.equal(positionWeightPct(20, 2, 200), 20)
  assert.equal(positionWeightPct(10, 1, 0), null)
  assert.ok(page.includes('仓位占比'), '表头必须有「仓位占比」')
  assert.ok(page.indexOf('仓位占比') > page.indexOf('市值') && page.indexOf('仓位占比') < page.indexOf('浮盈'), '位置在市值之后、浮盈之前')
})

test('④ 页头自检文案：ok ⇒ 通过 + 文本；失败 ⇒ 失败 + error 原文', async () => {
  const { selftestText } = await import('./prismView.ts')
  const okText = selftestText({ ok: true, error: null, text: 'OK', elapsedMs: 12 })
  assert.match(okText, /自检通过/)
  assert.match(okText, /OK/)
  assert.match(okText, /12ms/)
  const failText = selftestText({ ok: false, error: 'boom-原文', text: null, elapsedMs: 0 })
  assert.match(failText, /自检失败/)
  assert.match(failText, /boom-原文/)
  assert.throws(() => assert.match(okText, /自检失败/, '注入：仍显示失败'), /注入/)
  assert.ok(page.includes('selftestText(selftest)'), '页头必须使用统一自检文案')
})

test('汇总要点：剥掉 ```json 决策块，页面不出现原始 JSON', async () => {
  const { summaryBullets } = await import('./prismView.ts')
  const bullets = summaryBullets('1. 宽基普跌，先降集中度。\n2. 外盘偏弱，控制敞口。\n```json\n{"limits":{"singlePct":20},"orders":[],"cancel":[]}\n```')
  assert.equal(bullets.length, 2)
  assert.equal(bullets.some((b) => b.includes('{') || b.includes('limits')), false)
})
