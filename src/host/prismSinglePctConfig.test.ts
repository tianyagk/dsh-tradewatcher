/** 单票上限以用户配置为准：配置 30% 时不得按骨架的 20% 裁剪 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { clampDecision } from './prismAccount.ts'
import type { PrismDecision } from '../shared/prism.ts'

const dec = (shares: number): PrismDecision => ({
  limits: { singlePct: 20, totalPct: 100, note: null },
  orders: [{ secid: '1.601872', side: 'buy', price: 10, shares, reason: 'x' }],
  cancel: [], rejects: [], parseError: null,
})

/** 现金 750 000 + 持仓 25 000×10 = 总资产 1 000 000；该票现值 25% */
const ctx = (perStockPct: number | null) => ({
  cash: 750_000,
  positions: [{ secid: '1.601872', name: '招商轮船', qty: 25_000, available: 25_000, cost: 10, price: 10, industry: null }],
  limits: { singlePct: 20, totalPct: 100 },
  at: 1,
  constraints: { perStockPct },
})

test('① 配置 30%：现值 25% + 小额买入不触发单票裁剪（模型自报 20% 不作数）', () => {
  const r = clampDecision(dec(100), ctx(30) as never)
  assert.equal(r.events.filter((e) => e.dimension === 'single').length, 0, '25%+ 小额仍 ≤ 30%，不该裁')
  assert.equal(r.decision.orders.length, 1)
})

test('② 配置 30%：买到 35% 触发裁剪，basis 写「用户配置」', () => {
  const r = clampDecision(dec(100_000), ctx(30) as never)
  const ev = r.events.find((e) => e.dimension === 'single')
  assert.ok(ev, '35% 必须触发单票裁剪')
  assert.match(ev!.basis, /单票上限 30%（用户配置）/)
})

test('③ 没配置时回落到模型自报的 20%：25% 的持仓直接触发', () => {
  const r = clampDecision(dec(100), ctx(null) as never)
  const ev = r.events.find((e) => e.dimension === 'single')
  assert.ok(ev, '25% > 20% 必须裁')
  assert.match(ev!.basis, /单票 20%/)
})

test('④ 提示词：单票以配置为准 + 配置段进入上下文', () => {
  const pipe = readFileSync(new URL('./prismPipeline.ts', import.meta.url), 'utf8')
  assert.match(pipe, /【强制·单票以配置为准】/)
  assert.match(pipe, /limits\.singlePct 必须等于【约束（用户配置，硬边界）】/)
  const routes = readFileSync(new URL('./prismRoutes.ts', import.meta.url), 'utf8')
  assert.match(routes, /单票上限：\$\{pct\(settings\.perStockPct\)\}（limits\.singlePct 必须填这个值）/)
})
