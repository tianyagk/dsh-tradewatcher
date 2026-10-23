import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { TW_CSS } from './styles.ts'
import { PRISM_SERIES, PRISM_SERIES_CSS } from './prismView.ts'
import {
  PRISM_SPLIT_DEFAULT,
  clampSplit,
  darkSurfaceProblems,
  elevationProblems,
  seriesProblems,
  spacingProblems,
  splitPctFromDrag,
  tableRhythmProblems,
} from './prismLayout.ts'

const here = dirname(fileURLToPath(import.meta.url))
const page = readFileSync(join(here, './PrismPage.tsx'), 'utf8')

test('① 两栏可拖拽且夹在 40–75（固定 50/50 或 20% ⇒ 败）', () => {
  assert.equal(PRISM_SPLIT_DEFAULT, 62)
  assert.equal(clampSplit(20), 40)
  assert.equal(clampSplit(90), 75)
  assert.equal(splitPctFromDrag(62, 100, 1100, 1000), 75, '拖到 162% 必须夹到 75')
  assert.equal(splitPctFromDrag(62, 500, 0, 1000), 40, '拖到负值必须夹到 40')
  assert.ok(page.includes('role="separator"'), '必须有 separator')
  assert.ok(page.includes('aria-valuenow={Math.round(split)}'), '必须暴露 aria-valuenow')
  assert.ok(page.includes("ev.key === 'ArrowRight' ? 2 : -2"), '键盘左右键必须可调')
  assert.throws(() => assert.equal(clampSplit(20), 20, '注入：允许 20%'), /注入/)
})

test('② <900px 折叠为上下（仍两栏 ⇒ 败）', () => {
  assert.match(TW_CSS, /@media \(max-width:899px\)\{[^}]*\.tw-prism-body\{display:flex;flex-direction:column/)
  assert.match(page, /className="tw-prism-body"/)
  assert.match(TW_CSS, /\.tw-prism-left>\.tw-prism-cards\{order:1\}/)
  assert.match(TW_CSS, /\.tw-prism-left>\.tw-prism-tablecard\{order:4\}/)
  assert.match(TW_CSS, /\.tw-prism-left>\.tw-prism-decisioncard\{order:5\}/)
  assert.match(TW_CSS, /\.tw-prism-left>\.tw-prism-equitycard\{order:6\}/)
  const injected = TW_CSS.replace('.tw-prism-body{display:flex;flex-direction:column', '.tw-prism-body{display:grid;grid-template-columns:62% 6px 1fr')
  assert.notEqual(injected, TW_CSS)
  assert.throws(() => assert.match(injected, /\.tw-prism-body\{display:flex;flex-direction:column/), /AssertionError/)
  const noOrder = TW_CSS.replace('.tw-prism-left>.tw-prism-cards{order:1}', '')
  assert.throws(() => assert.match(noOrder, /\.tw-prism-left>\.tw-prism-cards\{order:1\}/), /AssertionError/)
})

test('③ 块间 8 的倍数、行内 1px/12px/24–26px（块间 12px ⇒ 败）', () => {
  assert.deepEqual(spacingProblems(TW_CSS), [], `块间距违规：${JSON.stringify(spacingProblems(TW_CSS))}`)
  assert.deepEqual(tableRhythmProblems(TW_CSS), [])
  assert.match(TW_CSS, /\.tw-prism-table th,\.tw-prism-table td\{[^}]*border-bottom:1px solid/)
  const injected = `${TW_CSS}\n.tw-prism-x{gap:12px}`
  assert.notDeepEqual(spacingProblems(injected), [], '注入 12px 必须被抓到')
})

test('④ 分段在左栏四格之后、交易内容之前，三项为持仓/挂单/成交（放右栏 ⇒ 败）', () => {
  assert.ok(page.includes("label: '持仓'") && page.includes("label: '挂单'") && page.includes("label: '成交'"))
  const left = page.indexOf('tw-prism-left')
  const seg = page.indexOf('tw-prism-seg')
  const cards = page.indexOf('tw-prism-cards')
  assert.ok(left >= 0 && cards > left && seg > cards, '分段必须在左栏四格之后')
  const table = page.indexOf('tw-prism-tablecard')
  assert.ok(table < 0 || seg < table, '分段必须在交易内容之前')
  assert.equal((page.match(/className="tw-prism-seg"/g) ?? []).length, 1, '右栏不得再做分段')
  const injected = page.replace('<div className="tw-prism-col tw-prism-right">', '<div className="tw-prism-col tw-prism-right"><div className="tw-prism-seg"></div>')
  assert.notEqual(injected, page)
  assert.throws(() => assert.equal((injected.match(/className="tw-prism-seg"/g) ?? []).length, 1, '注入：右栏也放分段'), /注入/)
})

test('⑤ MD dataviz：8 系列色、细网格、点、图例右上（旧单色 ⇒ 败）', () => {
  assert.deepEqual(seriesProblems(PRISM_SERIES), [])
  assert.equal(PRISM_SERIES.length, 8)
  assert.equal(PRISM_SERIES_CSS.length, 8)
  assert.ok(page.includes('stroke={PRISM_SERIES_CSS[0]}'), '折线必须用系列色')
  assert.ok(page.includes('tw-prism-gridline') && page.includes('tw-prism-dot'), '必须细网格 + 点标记')
  assert.match(TW_CSS, /\.tw-prism-legend\{position:absolute;top:8px;right:8px/)
  assert.ok(page.includes('compositionItems') && page.includes('PRISM_SERIES_CSS'), '持仓构成必须用系列色')
  assert.throws(() => assert.deepEqual(seriesProblems(PRISM_SERIES.slice(0, 1)), [], '注入：单色'), /注入/)
})

test('⑥ 表格涨跌仍用红涨绿跌 token（改用系列色 ⇒ 败）', () => {
  assert.match(TW_CSS, /\.tw-prism-table \.up\{color:var\(--tw-up\)\}/)
  assert.match(TW_CSS, /\.tw-prism-table \.down\{color:var\(--tw-down\)\}/)
  assert.ok(page.includes("pnl >= 0 ? 'up' : 'down'"))
  const injected = TW_CSS.replace('.tw-prism-table .up{color:var(--tw-up)}', '.tw-prism-table .up{color:#4285F4}')
  assert.notEqual(injected, TW_CSS)
  assert.throws(() => assert.match(injected, /\.tw-prism-table \.up\{color:var\(--tw-up\)\}/), /AssertionError/)
})

test('⑦ ripple 仅在按钮/分段（表格行加 ripple ⇒ 败）', () => {
  assert.ok(page.includes("className = 'tw-prism-ripple'"))
  assert.ok(page.includes('className={`tw-prism-segbtn'))
  assert.equal(/<tr[^>]*tw-prism-ripple/.test(page), false)
  const injected = `${page}\nconst bad = <tr className="tw-prism-ripple" />`
  assert.notEqual(injected, page)
  assert.throws(() => assert.equal(/<tr[^>]*tw-prism-ripple/.test(injected), false, '注入：表格行 ripple'), /注入/)
})

test('⑧ elevation 三层都用上（全 0 ⇒ 败）', () => {
  assert.deepEqual(elevationProblems(TW_CSS), [], `elevation 违规：${JSON.stringify(elevationProblems(TW_CSS))}`)
  const injected = TW_CSS.replace('.tw-prism-seg{', '.tw-prism-seg-ignored{').replace('.tw-prism-seg', '.tw-prism-seg')
  assert.throws(() => assert.deepEqual(elevationProblems(injected), [], '注入：缺分段 e3'), /注入/)
})

test('⑨ 深色用更浅表面色分层，不放大阴影（加深阴影 ⇒ 败）', () => {
  assert.deepEqual(darkSurfaceProblems(TW_CSS), [])
  const dark = [...TW_CSS.matchAll(/\.tw-root\[data-theme=dark\]\{([^}]*)\}/g)].map((m) => m[1] ?? '').find((b) => b.includes('--tw-prism-surface-1')) ?? ''
  assert.ok(dark.includes('--tw-prism-surface-1:#16181b'))
  const injected = TW_CSS.replace('--tw-elev-1:0 1px 2px rgba(0,0,0,.24)', '--tw-elev-1:0 8px 24px rgba(0,0,0,.8)')
  assert.notEqual(injected, TW_CSS)
  assert.notDeepEqual(darkSurfaceProblems(injected), [], '注入：放大深色阴影必须被抓到')
})

test('⑩ 功能十项不回退（逐项存在）', () => {
  for (const s of ['总资产', '现金', '当日盈亏', '累计盈亏', '摊薄成本', '仓位占比', '模型配置', 'selftestText', 'timesText', 'reports', 'orders', 'fills', 'equity', '—（']) {
    assert.ok(page.includes(s), `缺少功能/文案：${s}`)
  }
  assert.equal(/免责|风险提示|不构成投资建议|仅供参考/.test(page), false)
})
