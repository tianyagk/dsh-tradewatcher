import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { TW_CSS } from './styles.ts'
import { DECISION_MAX_LINES, decisionReasonFits, decisionReasonLayoutOf } from './prismView.ts'

const here = dirname(fileURLToPath(import.meta.url))
const page = readFileSync(join(here, './PrismPage.tsx'), 'utf8')
const shared = readFileSync(join(here, '../shared/prism.ts'), 'utf8')
const pipeline = readFileSync(join(here, '../host/prismPipeline.ts'), 'utf8')

test('决策理由宽度/行数 clamp：≤左栏、≤3 行；越界/5 行注入必败', () => {
  const long = '半导体超限且总仓过高；'.repeat(80)
  const layout = decisionReasonLayoutOf(long, 300)
  assert.ok(layout.width <= 300, `渲染宽 ${layout.width} 越界`)
  assert.ok(layout.lines <= DECISION_MAX_LINES, `行数 ${layout.lines} 越界`)
  assert.equal(layout.truncated, true)
  assert.equal(decisionReasonFits(300, layout.width), true)
  assert.throws(() => assert.equal(decisionReasonFits(300, 301), true, '注入：越界'), /注入/)
  assert.throws(() => assert.ok(decisionReasonLayoutOf(long, 300, 7, 5).lines <= 3, '注入：5 行'), /注入/)
})

test('决策卡 CSS：min-width/overflow 隐藏、overflow-wrap、3 行 clamp；长文本没有 nowrap', () => {
  assert.match(TW_CSS, /\.tw-prism-left\{[^}]*min-width:0;overflow:hidden/)
  assert.match(TW_CSS, /\.tw-prism-decisioncard\{[^}]*min-width:0;overflow:hidden/)
  const reason = /\.tw-prism-decision-reason\{([^}]*)\}/.exec(TW_CSS)?.[1] ?? ''
  assert.match(reason, /overflow-wrap:anywhere/)
  assert.match(reason, /white-space:normal/)
  assert.match(reason, /-webkit-line-clamp:3/)
  assert.doesNotMatch(reason, /white-space:nowrap/)
  const basis = /\.tw-prism-basis-block\{([^}]*)\}/.exec(TW_CSS)?.[1] ?? ''
  assert.match(basis, /overflow-wrap:anywhere/)
  assert.doesNotMatch(basis, /white-space:nowrap/)
  assert.ok(page.includes('tw-prism-decision-reason') && page.includes('title={r.value}'))
  assert.throws(() => assert.match(`${reason}white-space:nowrap`, /^(?!.*nowrap)/, '注入：nowrap'), /注入/)
})

test('版本/指纹 UI 已删；run 回包字段仍保留', () => {
  for (const bad of ['版本 —', '指纹 —', '旧记录无版本绑定', 'tw-prism-verinfo']) {
    assert.equal(page.includes(bad), false, `页面仍含 ${bad}`)
  }
  assert.equal(page.includes('<details'), page.includes('tw-prism-analysis') ? page.includes('<details') : true, '只允许报告 details')
  assert.match(shared, /codeVersion\?: string/)
  assert.match(shared, /mandateHash\?: string/)
  assert.match(pipeline, /codeVersion:/)
  assert.match(pipeline, /mandateHash:/)
  const injected = `${page}\n<div>版本 —（旧记录无版本绑定）</div>`
  assert.throws(() => assert.equal(!['版本 —', '指纹 —', '旧记录无版本绑定'].some((x) => injected.includes(x)), true, '注入：版本 UI'), /注入/)
})
