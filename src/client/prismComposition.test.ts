import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { TW_CSS } from './styles.ts'
import { compositionItems, decisionRows, equityLegendItems } from './prismView.ts'

const here = dirname(fileURLToPath(import.meta.url))
const page = readFileSync(join(here, './PrismPage.tsx'), 'utf8')
const series = ['#1', '#2', '#3', '#4', '#5', '#6'] as const
const pos = (n: number) => Array.from({ length: n }, (_, i) => ({ secid: `s${i}`, name: `标的${i}`, qty: 1, cost: 10 }))
const prices = Object.fromEntries(Array.from({ length: 7 }, (_, i) => [`s${i}`, 10]))

test('① 净值卡图例只有 1 项（再列持仓 ⇒ 败）', () => {
  assert.deepEqual(equityLegendItems(), ['总资产'])
  assert.ok(page.includes('equityLegend.map'))
  const injected = page.replace("equityLegend.map((name) => <span key={name}>", "['总资产','标的 A'].map((name) => <span key={name}>")
  assert.notEqual(injected, page)
  assert.throws(() => assert.equal(injected.includes("'标的 A'"), false, '注入：再列持仓'), /注入/)
})

test('② 持仓构成图例 = min(持仓数,6)：3→3、6→6、7→6（写死 4 ⇒ 败）', () => {
  assert.equal(compositionItems(pos(3), prices, 1000, series).length, 3)
  assert.equal(compositionItems(pos(6), prices, 1000, series).length, 6)
  const seven = compositionItems(pos(7), prices, 1000, series)
  assert.equal(seven.length, 6)
  assert.equal(seven[5]?.name, '其他')
  assert.throws(() => assert.equal(seven.length, 4, '注入：写死 4'), /注入/)
})

test('③ 净值卡与持仓构成不在同一卡片（合并回一卡 ⇒ 败）', () => {
  const tableCard = page.indexOf('tw-prism-tablecard')
  const composition = page.indexOf('tw-prism-composition')
  const equity = page.indexOf('tw-prism-equitycard')
  assert.ok(tableCard >= 0 && composition > tableCard && equity > composition, '构成必须在持仓卡内、净值卡之前')
  const equityChunk = page.slice(equity)
  assert.equal(equityChunk.includes('tw-prism-composition'), false, '净值卡不得再嵌构成条')
  const injected = page.replace('tw-prism-equitycard', 'tw-prism-equitycard tw-prism-composition-merged')
  assert.notEqual(injected, page)
  assert.throws(() => assert.equal(page.slice(page.indexOf('tw-prism-equitycard')).includes('tw-prism-composition'), true, '注入：合并'), /注入/)
})

test('时点按钮无 emoji（⏱/✕ 恢复 ⇒ 败）', () => {
  assert.equal(/[⏱⏰⏳✕]/.test(page), false)
  const injected = `${page}\nconst bad = '⏱ ✕'`
  assert.throws(() => assert.equal(/[⏱⏰⏳✕]/.test(injected), false, '注入：emoji'), /注入/)
})

test('④ 四格次要说明右对齐（margin-left:auto）', () => {
  const sub = /\.tw-prism-sub\{([^}]*)\}/.exec(TW_CSS)?.[1] ?? ''
  assert.match(sub, /margin-left:auto/)
  assert.match(sub, /text-align:right/)
  const injected = TW_CSS.replace('.tw-prism-sub{color:var(--tw-muted);font-size:12px;line-height:1.3;margin-left:auto;align-self:flex-end;text-align:right}', '.tw-prism-sub{color:var(--tw-muted);font-size:12px;line-height:1.3}')
  assert.doesNotMatch(injected, /\.tw-prism-sub\{[^}]*margin-left:auto/)
})

test('limits 为 null 时页面保持 —（模型没给，非解析失败）', () => {
  const rows = decisionRows({ limits: { singlePct: null, totalPct: null }, orders: [], cancel: [], rejects: [] })
  assert.equal(rows[0]?.value, '—')
  assert.equal(rows[1]?.value, '—')
})
