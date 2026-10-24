import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { TW_CSS } from './styles.ts'
import { decisionReasonFits, decisionReasonLayoutOf, leftColumnPctOf } from './prismView.ts'

const here = dirname(fileURLToPath(import.meta.url))
const page = readFileSync(join(here, './PrismPage.tsx'), 'utf8')
const shared = readFileSync(join(here, '../shared/prism.ts'), 'utf8')
const pipeline = readFileSync(join(here, '../host/prismPipeline.ts'), 'utf8')

test('①/②/③/④ 决策理由：长文本多行、完整、宽度不越界、左栏 62%、高度随内容增长', () => {
  const long = '半导体超限且总仓过高；'.repeat(80)
  const layout = decisionReasonLayoutOf(long, 300)
  assert.ok(layout.lines >= 2, `行数 ${layout.lines}`)
  assert.equal(layout.truncated, false)
  assert.equal(decisionReasonFits(300, layout.width), true)
  assert.equal(layout.width, 300)
  assert.equal(leftColumnPctOf(1000, 620), 62)
  const short = decisionReasonLayoutOf('短', 300)
  assert.ok(layout.height > short.height, '内容增加后高度必须增长')
  assert.throws(() => assert.equal(decisionReasonFits(300, 301), true, '注入：越界 1px'), /注入/)
  assert.throws(() => assert.equal(leftColumnPctOf(1000, 630) <= 62.5, true, '注入：左栏 63%'), /注入/)
  assert.throws(() => assert.ok(decisionReasonLayoutOf('短', 300).lines >= 2, '注入：行数=1'), /注入/)
})

test('⑤ 两个字段 CSS/页面不含 nowrap/line-clamp/ellipsis；仍可换行且完成显示', () => {
  const reason = /\.tw-prism-decision-reason\{([^}]*)\}/.exec(TW_CSS)?.[1] ?? ''
  const basis = /\.tw-prism-basis-block\{([^}]*)\}/.exec(TW_CSS)?.[1] ?? ''
  for (const block of [reason, basis]) {
    assert.doesNotMatch(block, /white-space:nowrap/)
    assert.doesNotMatch(block, /line-clamp/)
    assert.doesNotMatch(block, /text-overflow:ellipsis/)
    assert.match(block, /overflow-wrap:anywhere/)
    assert.match(block, /white-space:normal/)
  }
  assert.match(TW_CSS, /\.tw-prism-decision\{[^}]*table-layout:fixed/)
  assert.match(TW_CSS, /\.tw-prism-decisioncard\{[^}]*min-width:0;overflow:hidden/)
  assert.match(TW_CSS, /\.tw-prism-left\{[^}]*min-width:0;overflow:hidden/)
  assert.ok(page.includes('tw-prism-decision-reason') && page.includes('tw-prism-basis-block'))
  assert.equal(page.includes('title={r.value}'), false, '决策理由不得用 title 截断')
  const injected = `${reason}white-space:nowrap`
  assert.throws(() => assert.doesNotMatch(injected, /white-space:nowrap/, '注入：nowrap'), /注入/)
})

test('版本/指纹 UI 已删；run 回包字段仍保留', () => {
  for (const bad of ['版本 —', '指纹 —', '旧记录无版本绑定', 'tw-prism-verinfo']) assert.equal(page.includes(bad), false, bad)
  assert.match(shared, /codeVersion\?: string/)
  assert.match(shared, /mandateHash\?: string/)
  assert.match(pipeline, /codeVersion:/)
  assert.match(pipeline, /mandateHash:/)
  const injected = `${page}\n<div>版本 —（旧记录无版本绑定）</div>`
  assert.throws(() => assert.equal(!['版本 —', '指纹 —', '旧记录无版本绑定'].some((x) => injected.includes(x)), true, '注入：版本 UI'), /注入/)
})

test('长文本 ≥200 字：完整显示、行数 ≥2、truncated=false', () => {
  const text = '这是一段超过两百字的决策理由。'.repeat(20)
  assert.ok([...text].length >= 200)
  const layout = decisionReasonLayoutOf(text, 320)
  assert.ok(layout.lines >= 2)
  assert.equal(layout.truncated, false)
  assert.ok(layout.height >= 40)
})
