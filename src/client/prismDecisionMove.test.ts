import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { TW_CSS } from './styles.ts'
import { decisionRows } from './prismView.ts'
import { clampSplit, PRISM_SPLIT_DEFAULT } from './prismLayout.ts'

const here = dirname(fileURLToPath(import.meta.url))
const page = readFileSync(join(here, './PrismPage.tsx'), 'utf8')
const leftStart = page.indexOf('tw-prism-left')
const sep = page.indexOf('tw-prism-sep', leftStart)
const rightStart = page.indexOf('tw-prism-right', sep)
const left = page.slice(leftStart, sep)
const right = page.slice(rightStart)

const DECISION = 'tw-prism-decisioncard'
const EQUITY = 'tw-prism-equitycard'

test('① 决策卡在左栏（留右栏 ⇒ 败）', () => {
  assert.ok(left.includes(DECISION), '左栏缺决策卡')
  assert.equal(right.includes(DECISION), false, '右栏不得有决策卡')
  const injected = page.replace('<div className="tw-prism-col tw-prism-right">', `<div className="tw-prism-col tw-prism-right"><section className="tw-prism-card ${DECISION}"></section>`)
  assert.notEqual(injected, page)
  assert.throws(() => assert.equal(injected.slice(injected.indexOf('tw-prism-right')).includes(DECISION), false, '注入：留右栏'), /注入/)
})

test('② 净值卡在右栏且位于研判之后（放回左栏 ⇒ 败）', () => {
  const r = right.indexOf('tw-prism-researchcard')
  const e = right.indexOf(EQUITY)
  assert.ok(r >= 0 && e > r, '净值卡必须在右栏研判之后')
  assert.equal(left.includes(EQUITY), false, '净值卡不得留在左栏')
  const injected = page.replace('</section>\n\n          <section className="tw-prism-card tw-prism-equitycard">', '</section>\n\n          <section className="tw-prism-card tw-prism-equitycard">')
  assert.equal(injected, page)
  assert.throws(() => assert.equal(left.includes(EQUITY), true, '注入：放回左栏'), /注入/)
})

test('③ 右栏不含决策卡（两处都渲染 ⇒ 败）', () => {
  assert.equal(right.includes('tw-prism-decision'), false)
  const injected = `${page}\n${right.replace('tw-prism-right', 'tw-prism-right')}<section className="tw-prism-card tw-prism-decisioncard"></section>`
  assert.notEqual(injected, page)
  assert.throws(() => assert.equal(injected.slice(injected.indexOf('tw-prism-right')).includes(DECISION), false, '注入：两处'), /注入/)
})

test('④ 决策七行齐全（少任一行 ⇒ 败）', () => {
  const rows = decisionRows({ note: '不买：无钱；不卖：未破位', limits: { singlePct: 20, totalPct: 50, note: '依据' }, orders: [], cancel: [], rejects: [] })
  const keys = rows.map((r) => r.key)
  for (const k of ['单票上限', '总仓位上限', '仓位上限依据', '决策理由', 'orders', 'cancel', 'rejects']) assert.ok(keys.includes(k), `缺 ${k}`)
  assert.ok(page.includes('dRows.map'))
  const missing = rows.filter((r) => r.key !== 'rejects')
  assert.throws(() => assert.equal(new Set(missing.map((r) => r.key)).size, 7, '注入：少一行'), /注入/)
})

test('⑤ 移动端：左栏决策先于右栏净值（反转 ⇒ 败）', () => {
  assert.match(TW_CSS, /\.tw-prism-left>\.tw-prism-decisioncard\{order:6\}/)
  assert.match(TW_CSS, /\.tw-prism-right>\.tw-prism-equitycard\{order:1\}/)
  assert.match(TW_CSS, /\.tw-prism-right>\.tw-prism-researchcard\{order:2\}/)
  const injected = TW_CSS.replace('.tw-prism-right>.tw-prism-equitycard{order:1}', '.tw-prism-right>.tw-prism-equitycard{order:3}')
  assert.notEqual(injected, TW_CSS)
  assert.throws(() => assert.match(injected, /\.tw-prism-right>\.tw-prism-equitycard\{order:1\}/), /AssertionError/)
})

test('⑥ 两栏 62:38、拖拽 40–75 回归', () => {
  assert.equal(PRISM_SPLIT_DEFAULT, 62)
  assert.equal(clampSplit(20), 40)
  assert.equal(clampSplit(90), 75)
  assert.match(page, /gridTemplateColumns: `\$\{split\}fr \$\{PRISM_SEP_PX\}px \$\{100 - split\}fr`/)
  assert.match(TW_CSS, /grid-template-columns:minmax\(0,62fr\) 6px minmax\(0,38fr\)/)
})
