/**
 * v0.185–v0.188 客户端审查（汪汪队卡）：P0/P1 断言 + 反例注入。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dwCells, dwSeries, dwTable, type DwRow, type DwSummary } from './dogwatchView.ts'

const SRC = readFileSync(new URL('./MarketPage.tsx', import.meta.url), 'utf8')
const SUM: DwSummary = { totalAmount: null, ratio: null, netBuy: null, weightedPct: null, baseDate: null, totalSharesYi: null }
const ROW = (i: number): DwRow => ({ secid: `s${i}`, name: `ETF${i}`, indexName: '沪深300', scale: 100 - i, amount: null, ratio20: null, netBuy: null, pct: null, sharesYi: null, sharesDelta: null })

test('P1-1 切窗先清空旧数据（旧窗口数据挂新 tab ⇒ 败）', () => {
  assert.match(SRC, /setDogwatch\(null\)\s*\/\* P1：切窗前先清空/, '切窗时必须先 setDogwatch(null)')
  const injected = SRC.replace(/setDogwatch\(null\)\s*\/\* P1：切窗前先清空[^\n]*\n/, '')
  assert.doesNotMatch(injected, /setDogwatch\(null\)/, '注入删除清空 ⇒ 判失败')
})

test('① 接口失败/加载中：整卡降级为一句原因（不渲染空表）', () => {
  assert.match(SRC, /dwErr !== null\s*\?\s*React\.createElement\('div', \{ className: 'tw-mk-empty' \}/, '失败态有独立分支')
  assert.match(SRC, /'data-role': 'dw-skeleton'/, '加载态走骨架屏')
})

test('① summary 全 null ⇒ 全部 `—`（不许 NaN/0）', () => {
  const cells = dwCells(ROW(1), false)
  assert.ok(cells.cells.every((c) => c.length > 0))
  const t = dwTable([ROW(1)], SUM, false)
  for (const c of t.rows.flatMap((r) => r.cells)) assert.doesNotMatch(c, /NaN|undefined|null/)
})

test('① series 空数组 ⇒ 两张图都不炸（bar/line 为空）', () => {
  const s = dwSeries([])
  assert.deepEqual(s.bars, [])
  assert.deepEqual(s.line, [])
})

test('② dwTable 动态行数：5 行 ⇒ 5 + 合计', () => {
  const rows = [1, 2, 3, 4, 5].map(ROW)
  assert.equal(dwTable(rows, SUM, false).rows.length, 6)
})

test('② sharesStale ⇒ 合计行「份额变化」也降级', () => {
  const t = dwTable([ROW(1), ROW(2)], SUM, true)
  const last = t.rows[t.rows.length - 1]!
  assert.equal(last.cells[0], '合计')
  assert.equal(last.cells[8], '—')
  assert.equal(last.titles[8], '份额源未日更')
  const injected = { ...last, cells: [...last.cells.slice(0, 8), '−1.00'] }
  assert.notEqual(injected.cells[8], '—', '注入旧值 ⇒ 判失败')
})

test('④ 数字格式：null/NaN 不产生 NaN；符号类按 redUp 变量走', () => {
  const c = dwCells({ ...ROW(1), sharesYi: Number.NaN, pct: Number.NaN, sharesDelta: 2.5 }, false)
  assert.doesNotMatch(c.cells.join('|'), /NaN/)
  assert.equal(c.cells[7], '—')
  assert.equal(c.signs[8], 'up', '正数份额变化 → up 类（颜色由 --tw-up 决定，redUp 反转自动跟随）')
  assert.match(SRC, /className: [^\n]*(num|pos|neg)/, '数值列带符号/对齐类')
})

// ── P2 清理（1/2/3/6）──────────────────────────────────────────────────────
const CSS = readFileSync(new URL('./styles.ts', import.meta.url), 'utf8')

test('P2-1 带 title 的单元格可聚焦（tabIndex + focus-visible 描边）', () => {
  assert.match(SRC, /tabIndex: r\.titles\[i\] \? 0 : undefined/, '有 title 的 td 必须 tabIndex=0')
  assert.match(CSS, /\.tw-dw-table td\[title\]:focus-visible\{outline:1px solid var\(--tw-accent\)/, '聚焦描边 1px 主题色')
  const injected = SRC.replace('tabIndex: r.titles[i] ? 0 : undefined, ', '')
  assert.doesNotMatch(injected, /tabIndex: r\.titles\[i\]/, '注入删除 tabIndex ⇒ 判失败')
})

test('P2-2 .tw-mk-* 复核：仍被大盘页小格/分布使用（误删 ⇒ 败）', () => {
  assert.match(CSS, /\.tw-mk-v\{font-size:22px/, '数值 22px 规则在')
  assert.match(CSS, /\.tw-mk-cell\{padding:8px;border-radius:8px/, '小格 padding/圆角在')
  assert.match(CSS, /\.tw-mk-card\{[^}]*border-radius:10px[^}]*padding:12px/, '卡片圆角/padding 在')
  const injected = CSS.replace(/\.tw-mk-cell\{[^}]*\}/, '')
  assert.doesNotMatch(injected, /\.tw-mk-cell\{/, '注入删规则 ⇒ 判失败')
})

test('P2-3 切窗骨架屏：dogwatch===null && dwErr===null 时出灰块 + 3 行灰条', () => {
  assert.match(SRC, /'data-role': 'dw-skeleton'/, '骨架容器存在')
  assert.match(SRC, /\.\.\.\[0, 1, 2\]\.map\(\(i\) => React\.createElement\('div', \{ key: i, className: 'tw-dw-skel-row' \}\)\)/, '表格 3 行灰条')
  assert.match(CSS, /@keyframes twDwPulse\{0%,100%\{opacity:\.55\}50%\{opacity:\.95\}\}/, '只用 opacity 动画')
  const injected = SRC.replace("'data-role': 'dw-skeleton'", "'data-role': 'x'")
  assert.doesNotMatch(injected, /dw-skeleton/, '注入删除骨架 ⇒ 判失败')
})

test('P2-6 合计行规模/份额变化前端现算（恒 — ⇒ 败）', () => {
  const rows = [ROW(0), { ...ROW(1), scale: 200, sharesDelta: 3.5 }, { ...ROW(2), scale: null, sharesDelta: null }]
  const t = dwTable(rows, SUM, false)
  const total = t.rows[t.rows.length - 1]!
  assert.notEqual(total.cells[2], '—', '规模合计必须现算')
  assert.notEqual(total.cells[8], '—', '份额变化合计必须现算')
  assert.match(total.titles[2] ?? '', /跳过 1 行缺规模/, '规模 title 写跳过行数')
  assert.match(total.titles[8] ?? '', /跳过 2 行缺份额变化/, '份额变化 title 写跳过行数')
  const injected = { ...total, cells: [...total.cells.slice(0, 8), '—'] }
  assert.equal(injected.cells[8], '—', '注入恒 — ⇒ 判失败')
})
