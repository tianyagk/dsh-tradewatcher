import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { TW_CSS } from './styles.ts'
import { designParityRows, parityProblems, rawJsonProblems } from './prismDesignParity.ts'

const here = dirname(fileURLToPath(import.meta.url))
const design = readFileSync(join(here, '../../docs/mockups/prism-v3.html'), 'utf8')
const page = readFileSync(join(here, './PrismPage.tsx'), 'utf8')

const badAfter = (injected: string): string[] => parityProblems(design, injected)
const inject = (from: string, to: string): string => {
  assert.ok(TW_CSS.includes(from), `注入锚点不存在：${from}`)
  const out = TW_CSS.replace(from, to)
  assert.notEqual(out, TW_CSS)
  return out
}

test('设计稿对拍 ≥40 项：颜色/形状/阴影/排版/间距/组件/深色逐项相等', () => {
  const rows = designParityRows(design, TW_CSS)
  assert.ok(rows.length >= 40, `对拍项只有 ${rows.length}，要求 ≥40`)
  assert.deepEqual(parityProblems(design, TW_CSS), [], `对拍不一致：${parityProblems(design, TW_CSS).join('；')}`)
  for (const r of rows) assert.equal(r.ok, true, `${r.key}: 设计 ${r.design} / 实现 ${r.impl}`)
})

test('注入：卡片圆角 0 / 选中背景删除 / 表格字号 13 / 分隔条 0 / 阴影 none / 深色阴影放大 / 图例 11 ⇒ 均必败', () => {
  const cases: Array<[string, string, RegExp]> = [
    ['卡片圆角 0', inject('border-radius:10px;background:var(--tw-prism-surface-1)', 'border-radius:0;background:var(--tw-prism-surface-1)'), /卡片圆角/],
    ['选中背景删除', inject('.tw-prism-segbtn.on{background:rgba(94,106,210,.18);color:#2f3aa0;font-weight:700', '.tw-prism-segbtn.on{color:#2f3aa0;font-weight:700'), /分段选中背景/],
    ['表格字号 13', inject('font-size:12px;line-height:1.2;height:26px;white-space:normal', 'font-size:13px;line-height:1.2;height:26px;white-space:nowrap'), /表格字号/],
    ['分隔条 0', inject('.tw-prism-sep{position:relative;width:6px', '.tw-prism-sep{position:relative;width:0px'), /分隔条宽度/],
    ['阴影 none', `${TW_CSS}\n.tw-prism-card{box-shadow:none}`, /卡片阴影/],
    ['深色阴影放大', `${TW_CSS}\n.tw-root[data-theme=dark]{--tw-elev-1:0 8px 24px rgba(0,0,0,.8)}`, /深色阴影/],
    ['图例 11', inject('.tw-prism-composition-legend{display:flex;flex-wrap:wrap;gap:8px;color:var(--tw-muted);font-size:12px;line-height:1.3}', '.tw-prism-composition-legend{display:flex;flex-wrap:wrap;gap:8px;color:var(--tw-muted);font-size:11px;line-height:1.3}'), /图例字号/],
  ]
  for (const [name, css, key] of cases) {
    const bad = badAfter(css)
    assert.ok(bad.some((x) => key.test(x)), `${name} 必须被抓到，实际：${bad.join('；')}`)
  }
})

test('页面不得出现原始 JSON；注入 {"limits" ⇒ 必败', () => {
  assert.deepEqual(rawJsonProblems(page), [])
  const injected = `${page}\nconst bad = '{"limits":{}}'`
  assert.notDeepEqual(rawJsonProblems(injected), [], '原始 JSON 必须被抓到')
  assert.throws(() => assert.deepEqual(rawJsonProblems(injected), [], '注入'), /注入/)
})
