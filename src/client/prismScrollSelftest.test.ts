import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { TW_CSS } from './styles.ts'
import { scrollProblems } from './prismLayout.ts'
import { parseSelftestBody, selftestText } from './prismView.ts'

const here = dirname(fileURLToPath(import.meta.url))
const page = readFileSync(join(here, './PrismPage.tsx'), 'utf8')

test('滚动①：页面根 overflow-y:auto 且无 overflow:hidden', () => {
  assert.deepEqual(scrollProblems(TW_CSS), [])
  const hidden = TW_CSS.replace('overflow-y:auto;overflow-x:auto', 'overflow:hidden')
  assert.notEqual(hidden, TW_CSS)
  assert.notDeepEqual(scrollProblems(hidden), [], '改回 hidden 必须败')
})

test('滚动②：两栏容器 min-height:0（删 ⇒ 败）', () => {
  const body = /\.tw-prism-body\{([^}]*)\}/.exec(TW_CSS)?.[1] ?? ''
  assert.match(body, /min-height:0/)
  const injected = TW_CSS.replace('.tw-prism-body{display:grid;grid-template-columns:minmax(0,62fr) 6px minmax(0,38fr);gap:0;align-items:stretch;min-width:0;min-height:0}', '.tw-prism-body{display:grid;grid-template-columns:minmax(0,62fr) 6px minmax(0,38fr);gap:0;align-items:stretch;min-width:0}')
  assert.notEqual(injected, TW_CSS)
  assert.notDeepEqual(scrollProblems(injected), [], '删 min-height 必须败')
})

test('滚动③：移动端折叠容器可滚（加固定高度 ⇒ 败）', () => {
  assert.match(TW_CSS, /@media \(max-width:899px\)\{[^\n]*\.tw-prism-body\{[^}]*min-height:0/)
  const injected = TW_CSS.replace('@media (max-width:899px){.tw-prism-body{display:flex;flex-direction:column;gap:16px;min-height:0}', '@media (max-width:899px){.tw-prism-body{display:flex;flex-direction:column;gap:16px;height:600px')
  assert.notEqual(injected, TW_CSS)
  assert.notDeepEqual(scrollProblems(injected), [], '固定高度必须败')
})

test('自检①：200 + JSON ok ⇒ 通过文案含 OK/12ms', () => {
  const r = parseSelftestBody(200, JSON.stringify({ ok: true, text: 'OK', elapsedMs: 12, model: 'p/m' }))
  assert.equal(r.ok, true)
  const text = selftestText(r)
  assert.match(text, /自检通过/)
  assert.match(text, /12ms/)
  assert.match(text, /OK/)
})

test('自检②：200 + 非 JSON ⇒ 响应非 JSON + 前 60 字', () => {
  const raw = '<!doctype html><html><body>not json</body></html>'
  const r = parseSelftestBody(200, raw)
  assert.equal(r.ok, false)
  assert.match(String(r.error), /响应非 JSON/)
  assert.ok(String(r.error).includes(raw.slice(0, 60)))
  assert.doesNotMatch(String(r.error), /HTTP 200/)
})

test('自检③：页面源码不得把 HTTP ${status} 当失败文案', () => {
  assert.doesNotMatch(page, /HTTP\s*\$\{\s*status/)
  const injected = `${page}\nconst bad = \`HTTP \${status}\``
  assert.match(injected, /HTTP\s*\$\{\s*status/)
  assert.throws(() => assert.doesNotMatch(injected, /HTTP\s*\$\{\s*status/), /AssertionError/)
})
