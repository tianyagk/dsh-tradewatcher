import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { TW_CSS } from './styles.ts'
import { designParityRows, parityProblems, rawJsonProblems } from './prismDesignParity.ts'

const here = dirname(fileURLToPath(import.meta.url))
const design = readFileSync(join(here, '../../docs/mockups/md-hybrid.html'), 'utf8')
const page = readFileSync(join(here, './PrismPage.tsx'), 'utf8')

test('设计稿对拍：底色/圆角/阴影/分段/表格/分隔条逐项相等', () => {
  const rows = designParityRows(design, TW_CSS)
  const bad = parityProblems(design, TW_CSS)
  assert.deepEqual(bad, [], `对拍不一致：${bad.join('；')}`)
  for (const r of rows) assert.equal(r.ok, true, `${r.key}: 设计 ${r.design} / 实现 ${r.impl}`)
})

test('注入：卡片圆角 0 ⇒ 对拍失败', () => {
  const injected = TW_CSS.replace('.tw-prism-card{position:relative;', '.tw-prism-card{position:relative;border-radius:0;')
  assert.notEqual(injected, TW_CSS)
  assert.notDeepEqual(parityProblems(design, injected), [], '圆角 0 必须被抓到')
})

test('注入：删掉分段选中背景 ⇒ 对拍失败', () => {
  const injected = TW_CSS.replace('--tw-md-accent-soft:rgba(94,106,210,.14);', '--tw-md-accent-soft:transparent;')
  assert.notEqual(injected, TW_CSS)
  assert.notDeepEqual(parityProblems(design, injected), [], '选中背景缺失必须被抓到')
})

test('注入：分隔条宽度 0 ⇒ 对拍失败', () => {
  const injected = TW_CSS.replace('.tw-prism-sep{position:relative;width:6px;', '.tw-prism-sep{position:relative;width:0px;')
  assert.notEqual(injected, TW_CSS)
  assert.notDeepEqual(parityProblems(design, injected), [], '分隔条 0 必须被抓到')
})

test('注入：去掉表格 tabular-nums ⇒ 对拍失败', () => {
  const injected = TW_CSS.replace('height:26px;white-space:nowrap;font-variant-numeric:tabular-nums}', 'height:26px;white-space:nowrap}')
  assert.notEqual(injected, TW_CSS)
  assert.notDeepEqual(parityProblems(design, injected), [], 'tabular 缺失必须被抓到')
})

test('页面不得出现原始 JSON；注入 {"limits" ⇒ 必败', () => {
  assert.deepEqual(rawJsonProblems(page), [])
  const injected = `${page}\nconst bad = '{"limits":{}}'`
  assert.notDeepEqual(rawJsonProblems(injected), [], '原始 JSON 必须被抓到')
  assert.throws(() => assert.deepEqual(rawJsonProblems(injected), [], '注入'), /注入/)
})
