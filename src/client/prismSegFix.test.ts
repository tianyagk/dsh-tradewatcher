import assert from 'node:assert/strict'
import test from 'node:test'
import { TW_CSS } from './styles.ts'
import { SEGMENT_MIN_HEIGHT, segmentRenderHeightOf, segmentWidthSumOf, tableScrollOk } from './prismView.ts'

const labels = ['持仓', '挂单', '成交']

test('①/② 成交 0/26/200 行：分段渲染高度一致且 ≥32px；删 flex:0 0 auto ⇒ 200 行被压到 8', () => {
  const heights = [0, 26, 200].map((n) => segmentRenderHeightOf(n, TW_CSS))
  assert.deepEqual(heights, [32, 32, 32])
  assert.ok(heights.every((h) => h >= SEGMENT_MIN_HEIGHT))
  const injected = TW_CSS.replace('flex:0 0 auto;min-height:32px;', '')
  assert.notEqual(injected, TW_CSS)
  assert.equal(segmentRenderHeightOf(200, injected), 8)
  assert.notDeepEqual([0, 26, 200].map((n) => segmentRenderHeightOf(n, injected)), [32, 32, 32])
})

test('③ 三个分段项宽度之和不随表格行数变化（min-width 49 ⇒ 147）', () => {
  assert.equal(segmentWidthSumOf(labels, TW_CSS), 147)
  for (const _n of [0, 26, 200]) assert.equal(segmentWidthSumOf(labels, TW_CSS), 147)
  const injected = TW_CSS.replace('min-width:49px', 'min-width:0')
  assert.equal(segmentWidthSumOf(labels, injected), 0)
})

test('④ 表格容器自有滚动区：flex:1 1 auto + min-height:0 + overflow:auto', () => {
  assert.equal(tableScrollOk(TW_CSS), true)
  assert.match(TW_CSS, /\.tw-prism-left\{[^}]*min-height:0/)
  const block = '.tw-prism-tablecard{flex:1 1 auto;min-height:0;overflow:auto}'
  for (const part of ['flex:1 1 auto', 'min-height:0', 'overflow:auto']) {
    const injected = TW_CSS.replace(block, block.replace(part, ''))
    assert.notEqual(injected, TW_CSS)
    assert.equal(tableScrollOk(injected), false, `删 ${part} 必须失败`)
  }
})
