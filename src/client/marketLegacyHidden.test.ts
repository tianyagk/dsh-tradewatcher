/** 旧汇总块隐藏（用户裁定）：不删 JSX/常量，只加 `hidden` + `display:none` + `data-legacy`。 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const page = readFileSync(join(HERE, 'MarketPage.tsx'), 'utf8')

test('旧块被隐藏且带 data-legacy，新块在它之后', () => {
  const i = page.indexOf("'data-legacy': 'market-summary'")
  assert.ok(i > 0, '缺少 data-legacy="market-summary"')
  // 同一节点的 props 对象里必须有 hidden（`hidden: true` 或 `hidden:!0`）与 display:none
  const line = page.slice(page.lastIndexOf('React.createElement(', i), page.indexOf('\n', i))
  assert.ok(/hidden:\s*(true|!0)/.test(line), `旧块根节点必须带 hidden（实际：${line.trim().slice(0, 120)}）`)
  assert.ok(/display:\s*'none'/.test(line), '旧块根节点必须带 display:none')
  // 新版两列块必须排在旧块之后
  const j = page.indexOf("className: 'tw-mk-grid2'")
  assert.ok(j > i, `新版两列块必须在旧块之后（legacy=${i}, grid=${j}）`)
  // 反例注入：去掉 hidden ⇒ 判据必败
  const cut = page.replace("hidden: true, style: { display: 'none' }", "style: { display: 'none' }")
  assert.throws(
    () => assert.equal(/hidden:\s*(true|!0)/.test(cut.slice(cut.lastIndexOf('React.createElement(', cut.indexOf("'data-legacy': 'market-summary'")), cut.indexOf('\n', cut.indexOf("'data-legacy': 'market-summary'")))), true, '反例上：旧块没隐藏'),
    /反例上/,
    '⚠ 反例注入（去掉 hidden）必须失败',
  )
})
