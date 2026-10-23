import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { TW_CSS } from './styles.ts'

const here = dirname(fileURLToPath(import.meta.url))
const page = readFileSync(join(here, './PrismPage.tsx'), 'utf8')

test('P-01/P-10 定稿：净值默认调整后 + 口径开关；行业卡含未穿透/现金/合计 100.00%', () => {
  assert.match(page, /useState<'nominal' \| 'adjusted'>\('adjusted'\)/)
  assert.ok(page.includes('tw-prism-netseg'))
  assert.ok(page.includes('tw-prism-exposurecard'))
  assert.ok(page.includes('未穿透'))
  assert.ok(page.includes('未归类'))
  assert.ok(page.includes('= 100.00%'))
  assert.ok(page.includes('其余 {expRest.length} 行'))
})

test('P-11 layout：左栏行业卡在决策卡前；移动端右栏净值在研判前', () => {
  assert.match(TW_CSS, /\.tw-prism-left>\.tw-prism-exposurecard\{order:5\}/)
  assert.match(TW_CSS, /\.tw-prism-left>\.tw-prism-decisioncard\{order:6\}/)
  assert.match(TW_CSS, /\.tw-prism-right>\.tw-prism-equitycard\{order:1\}/)
  assert.match(TW_CSS, /\.tw-prism-right>\.tw-prism-researchcard\{order:2\}/)
})
