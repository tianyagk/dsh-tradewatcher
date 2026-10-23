import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { TW_CSS } from './styles.ts'
import { PRISM_DEFAULT_TIMES } from '../shared/prism.ts'
import { decisionRows, stripMarkdown, summaryBullets } from './prismView.ts'
import { finalCardShadow } from './prismLayout.ts'

const here = dirname(fileURLToPath(import.meta.url))
const page = readFileSync(join(here, './PrismPage.tsx'), 'utf8')

test('① 汇总/报告剥离 Markdown 星号与反引号（恢复 ⇒ 败）', () => {
  assert.equal(stripMarkdown('**总体偏弱**、`防御`占优'), '总体偏弱、防御占优')
  const bullets = summaryBullets('**总体偏弱、防御占优**\n2. *外盘* 承压')
  assert.equal(bullets.some((b) => b.includes('**') || b.includes('*') || b.includes('`')), false)
  assert.equal(page.includes('**'), false, '页面源码/文案不得出现连续两个星号')
  assert.throws(() => assert.equal(summaryBullets('**总体偏弱**')[0]?.includes('**'), true, '注入：恢复星号'), /注入/)
})

test('② 四格宽屏 4 列、<1100 2 列、<640 单列（写回 2 列 ⇒ 败）', () => {
  assert.match(TW_CSS, /\.tw-prism-cards\{display:grid;grid-template-columns:repeat\(4,minmax\(0,1fr\)\);gap:8px\}/)
  assert.match(TW_CSS, /@media \(max-width:1099px\)\{\.tw-prism-cards\{grid-template-columns:repeat\(2,minmax\(0,1fr\)\)\}\}/)
  assert.match(TW_CSS, /@media \(max-width:639px\)\{\.tw-prism-cards\{grid-template-columns:minmax\(0,1fr\)\}\}/)
  assert.match(TW_CSS, /\.tw-prism-v\{[^}]*font:600 26px/)
  const injected = TW_CSS.replace('.tw-prism-cards{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:8px}', '.tw-prism-cards{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}')
  assert.notEqual(injected, TW_CSS)
  assert.doesNotMatch(injected, /\.tw-prism-cards\{[^}]*repeat\(4,minmax/)
})

test('③ 卡片阴影最终生效值 = 设计稿值（后写覆盖 ⇒ 败）', () => {
  assert.equal(finalCardShadow(TW_CSS), '0 1px 2px rgba(0,0,0,.06),0 1px 3px rgba(0,0,0,.04)')
  const injected = `${TW_CSS}\n.tw-prism-card{box-shadow:none}`
  assert.notEqual(finalCardShadow(injected), finalCardShadow(TW_CSS), '后写覆盖必须被最终值判据抓到')
})

test('④ 分段选中背景/文字/字重达标（删背景 ⇒ 败）', () => {
  assert.match(TW_CSS, /\.tw-prism-segbtn\.on\{background:rgba\(94,106,210,\.18\);color:#2f3aa0;font-weight:700/)
  assert.match(TW_CSS, /\.tw-prism-seg\{[^}]*padding:2px;[^}]*border:1px solid/)
  const injected = TW_CSS.replace('background:rgba(94,106,210,.18);color:#2f3aa0;font-weight:700', 'color:#2f3aa0;font-weight:700')
  assert.notEqual(injected, TW_CSS)
  assert.doesNotMatch(injected, /\.tw-prism-segbtn\.on\{background:rgba\(94,106,210,\.18\)/)
})

test('⑤ rejects 走决策表格行，orders/cancel 0 用次要色（纯文本 ⇒ 败）', () => {
  const rows = decisionRows({ limits: { singlePct: 20, totalPct: null }, orders: [], cancel: [], rejects: [] })
  assert.deepEqual(rows.map((r) => r.key), ['单票上限', '总仓位上限', '仓位上限依据', '决策理由', 'orders', 'cancel', 'rejects'])
  assert.equal(rows.find((r) => r.key === 'rejects')?.value, '无')
  assert.equal(rows.find((r) => r.key === 'orders')?.muted, true)
  assert.ok(page.includes('tw-prism-decision') && page.includes('zero'))
  assert.equal(page.includes('rejects：'), false, '不得再以纯文本行渲染 rejects')
  const injected = `${page}\n<div>rejects：无</div>`
  assert.notEqual(injected, page)
  assert.throws(() => assert.equal(injected.includes('rejects：'), false, '注入：纯文本'), /注入/)
})

test('⑥ 默认时点常量含 14:40（用户文件 14:35 属编辑，不改）', () => {
  assert.deepEqual([...PRISM_DEFAULT_TIMES], ['09:35', '11:20', '13:10', '14:40'])
})
