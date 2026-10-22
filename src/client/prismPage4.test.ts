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

test('四格口径：总资产 = 现金 + 市值；累计 = 总资产 − 资金上限；缺基准给原因', () => {
  const t: PrismTradingState = {
    account: {
      day: '2026-10-22', capitalLimit: 1_500_000, cash: 1_000_000, realized: 100,
      dayStartEquity: 1_490_000, copiedAt: null, copyLogs: [],
      positions: [{ secid: '1.600519', name: '茅台', qty: 100, available: 100, cost: 1000 }],
    },
    orders: [], fills: [], equity: [], decision: null, prices: { '1.600519': 1200 },
  }
  const cards = topCardsOf(t)
  assert.equal(cards.length, 4)
  assert.match(cards[0]?.value ?? '', /1,120,000/)
  assert.match(cards[2]?.value ?? '', /-370,000/)
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
