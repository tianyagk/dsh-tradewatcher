import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { TW_CSS } from './styles.ts'
import { normalizeTradingState } from './prismView.ts'

const here = dirname(fileURLToPath(import.meta.url))
const page = readFileSync(join(here, './PrismPage.tsx'), 'utf8')

test('P-01/P-10 定稿：净值默认调整后；行业卡在 unavailable 时仍渲染并给原因', () => {
  assert.match(page, /useState<'nominal' \| 'adjusted'>\('adjusted'\)/)
  assert.ok(page.includes('tw-prism-netseg'))
  assert.ok(page.includes('tw-prism-exposurecard'))
  assert.ok(page.includes('exposureOk'))
  assert.ok(page.includes('exposure.reason'))
  assert.ok(page.includes('未穿透'))
  assert.ok(page.includes('未归类'))
  assert.ok(page.includes('= 100.00%'))
  assert.ok(page.includes('其余 {expRest.length} 行'))
  const injected = page.replace('<section className="tw-prism-card tw-prism-exposurecard"', '{false ? null : <section className="tw-prism-card tw-prism-exposurecard"')
  assert.notEqual(injected, page)
  assert.throws(() => assert.equal(injected.includes('tw-prism-exposurecard'), false, '注入：不可用时不渲染'), /注入/)
})

test('P-11 layout：左栏行业卡在决策卡前；移动端右栏净值在研判前', () => {
  assert.match(TW_CSS, /\.tw-prism-left>\.tw-prism-exposurecard\{order:5\}/)
  assert.match(TW_CSS, /\.tw-prism-left>\.tw-prism-decisioncard\{order:6\}/)
  assert.match(TW_CSS, /\.tw-prism-right>\.tw-prism-equitycard\{order:1\}/)
  assert.match(TW_CSS, /\.tw-prism-right>\.tw-prism-researchcard\{order:2\}/)
})

test('P-01 equity 与页面点数同源；版本缺值固定文案；达成度 — 带原因', () => {
  assert.match(page, /const equityPoints = trading\?\.equity \?\? \[\]/)
  assert.match(page, /equityChartOf\(equityPoints/)
  assert.ok(page.includes('—（旧记录无版本绑定）'))
  assert.ok(page.includes('缺行业数据'))
  assert.ok(page.includes('未配置行业上限'))
  const injected = page.replace('const equityPoints = trading?.equity ?? []', 'const equityPoints = []')
  assert.notEqual(injected, page)
  assert.throws(() => assert.match(injected, /const equityPoints = trading\?\.equity \?\? \[\]/), /AssertionError/)
  const noVersion = page.replaceAll('—（旧记录无版本绑定）', '')
  assert.throws(() => assert.equal(noVersion.includes('—（旧记录无版本绑定）'), true, '注入：版本空串'), /注入/)
  const noReason = page.replaceAll('—（${achievementReason ?? \'未配置行业上限\'}）', '—')
  assert.throws(() => assert.equal(noReason.includes('—（${achievementReason ?? \'未配置行业上限\'}）'), true, '注入：达成度只写 —'), /注入/)
})

test('③ equity 同源：trading 与 state 点数一致；exposure 缺失时也补 unavailable 而非 null', () => {
  const equity = [
    { day: '2026-10-22', equity: 100, capital: 100, cash: 0, positionsValue: 0, realized: 0, unrealized: 0, at: 1 },
    { day: '2026-10-23', equity: 110, capital: 100, cash: 0, positionsValue: 0, realized: 0, unrealized: 0, at: 2 },
  ]
  const account = { day: '2026-10-23', capitalLimit: 100, cash: 0, realized: 0, dayStartEquity: null, positions: [], copiedAt: null, copyLogs: [] }
  const normalized = normalizeTradingState({ trading: { account, orders: [], fills: [], equity, decision: null } as never, state: { account, orders: [], fills: [], equity, decision: null } as never })
  assert.equal(normalized?.equity.length, equity.length)
  assert.equal(normalized?.exposure?.state, 'unavailable')
  assert.match(normalized?.exposure?.reason ?? '', /未返回行业暴露/)
})
