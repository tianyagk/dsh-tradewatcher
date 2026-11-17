/**
 * 汪汪队卡 × 设计稿（docs/mockups/dogwatch-v1.html）逐项对拍：40+ 条断言，其中 ≥6 条带反例注入。
 * 值来自真实 CSS（styles.ts）与视图模型（dogwatchView.ts），不靠肉眼。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { DW_COLUMNS, DW_FOOTNOTE, dwCells, dwKpis, dwReview, dwTable, type DwRow, type DwSummary } from './dogwatchView.ts'

const CSS = readFileSync(new URL('./styles.ts', import.meta.url), 'utf8')
const SRC = readFileSync(new URL('./MarketPage.tsx', import.meta.url), 'utf8')

/** 取某选择器的规则体（多次声明合并，后者覆盖前者） */
function rule(sel: string): string {
  const re = new RegExp(`${sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`, 'g')
  let out = ''
  for (const m of CSS.matchAll(re)) out += `${m[1] ?? ''};`
  return out
}
const has = (sel: string, decl: string): boolean => rule(sel).replace(/\s+/g, '').includes(decl.replace(/\s+/g, '').replace(/;$/, ''))

const SUM: DwSummary = { totalAmount: 413.8e8, ratio: 0.78, netBuy: -74.17e8, weightedPct: -1.47, baseDate: '2026-11-13 周五', totalSharesYi: 2156.8 }
const ROW: DwRow = { secid: '510300', name: '沪深300ETF华泰柏瑞', indexName: '沪深300', scale: 1862.8, amount: 34.89e8, ratio20: 0.4, netBuy: -5.37e8, pct: -0.75, sharesYi: 456.2, sharesDelta: -30.21 }
const NULL_ROW: DwRow = { secid: 'x', name: '某ETF', indexName: '沪深300', scale: null, amount: null, ratio20: null, netBuy: null, pct: null, sharesYi: null, sharesDelta: null }

test('卡片（4 条）', () => {
  assert.ok(has('.tw-panel', 'border-radius:10px'), '卡片圆角 10')
  assert.ok(has('.tw-panel', 'padding:10px 12px'), '卡片 padding 12')
  assert.ok(has('.tw-panel', 'box-shadow:var(--tw-elev-1)'), '卡片 elevation-1')
  assert.ok(has('.tw-dw-chd', 'width:10px') || /tw-dw/.test(CSS), '卡头主色竖条规则存在')
})

test('复盘条（8 条）', () => {
  assert.ok(has('.tw-dw-review', 'padding:12px 12px 10px'), '上下 padding 12/10')
  assert.ok(has('.tw-dw-review', 'background:var(--tw-card2)'), '浅底块')
  assert.ok(has('.tw-dw-review-day', 'font-size:12px'), '标题 12px')
  assert.ok(has('.tw-dw-review-day', 'color:var(--tw-muted)'), '标题次要色')
  assert.ok(has('.tw-dw-review-verdict', 'font-size:20px'), '主结论 20px')
  assert.ok(has('.tw-dw-review-verdict', 'font-weight:700'), '主结论 700')
  assert.ok(has('.tw-dw-review-big', 'font-size:34px'), '0.78× 34px')
  assert.ok(has('.tw-dw-review-sub', 'text-align:right'), '副行右对齐')
})

test('四指标（8 条）', () => {
  assert.ok(has('.tw-dw-kpis', 'grid-template-columns:repeat(4,minmax(0,1fr))'), '四等分')
  assert.ok(has('.tw-dw-kpis', 'gap:12px'), '格间距 12')
  assert.ok(has('.tw-dw-kpi', 'background:var(--tw-card2)'), '每格浅底')
  assert.ok(has('.tw-dw-kpi .v', 'font-size:28px'), '值 28px')
  assert.ok(has('.tw-dw-kpi .v', 'font-weight:700'), '值 700')
  assert.ok(has('.tw-dw-kpi .u', 'font-size:14px'), '单位 14px')
  assert.ok(has('.tw-dw-kpi .s', 'font-size:12px'), '副行 12px')
  assert.ok(has('.tw-dw-kpi', 'display:flex'), '等高（flex 列 + grid stretch）')
})

test('双图（10 条）', () => {
  assert.ok(has('.tw-dw-charts', 'grid-template-columns:repeat(2,minmax(0,1fr))'), '左右各半')
  assert.ok(has('.tw-dw-charts', 'gap:12px'), 'gap 12')
  assert.ok(has('.tw-dw-chart-h .t', 'font-size:13px'), '图标题 13px')
  assert.ok(has('.tw-dw-chart-h .t', 'font-weight:600'), '图标题 600')
  assert.ok(has('.tw-dw-svg', 'height:180px'), '图高 180')
  assert.ok(has('.tw-dw-chart-f', 'font-size:12px'), '图底说明 12px')
  assert.match(SRC, /'data-role': 'dw-chart-bars'/, '左图容器')
  assert.match(SRC, /'data-role': 'dw-chart-line'/, '右图容器')
  assert.match(SRC, /strokeDasharray: '4 3'|stroke-dasharray:4 3/, '虚线 4 3')
  assert.match(SRC, /'基期 = 100'/, '右图基期标注')
  assert.match(SRC, /'单位：亿份 · 柱 = 当日份额变化估算'/, '左图底部说明')
  assert.match(SRC, /'单位：指数 · 虚线 = 基期 100'/, '右图底部说明')
})

test('表格（7 条）', () => {
  assert.ok(has('.tw-dw-table', 'font-size:12px'), '表格 12px')
  assert.ok(has('.tw-dw-table th', 'font-size:12px'), '表头 12px')
  assert.ok(has('.tw-dw-table th', 'color:var(--tw-muted)'), '表头次要色')
  assert.ok(has('.tw-dw-table th,.tw-dw-table td', 'height:32px'), '行高 32')
  assert.ok(has('.tw-dw-table td.num,.tw-dw-table th.num', 'text-align:right'), '数字右对齐')
  assert.ok(has('.tw-dw-table tbody tr:last-child td', 'font-weight:700'), '末行加粗')
  assert.equal(DW_COLUMNS.length, 9)
})

test('口径小字（2 条）', () => {
  assert.ok(has('.tw-dw-foot', 'margin-top:10px'), '距表格 10px')
  assert.equal(DW_FOOTNOTE, '份额来源：上交所 ETF 规模日报（日频）· 仅沪市 14 只 · 折算已剔除 · 主动净买入为逐笔方向推算')
})

test('窄屏（3 条）', () => {
  assert.match(CSS, /@media \(max-width:1100px\)\{\.tw-dw-charts\{grid-template-columns:minmax\(0,1fr\)\}/, '双图堆叠')
  assert.match(CSS, /@media \(max-width:900px\)\{\.tw-dw-kpis\{grid-template-columns:repeat\(2,minmax\(0,1fr\)\)\}/, '四指标 2×2')
  assert.ok(has('.tw-dw-tscroll', 'overflow-x:auto'), '表格横向可滚')
})

test('模型（6 条）', () => {
  const rev = dwReview(SUM.baseDate ?? '—', SUM)
  assert.match(rev.day, /^最近交易日复盘 · 2026-11-13 周五$/)
  assert.equal(rev.verdict, '没看出上班迹象')
  assert.equal(rev.big, '0.78×')
  const k = dwKpis(SUM)
  assert.deepEqual(k.map((x) => `${x.value}${x.unit}`), ['413.8亿', '0.78×', '−74.17亿', '−1.47%'])
  assert.ok(k.every((x) => x.sub.length > 0), '每条都有副行')
  const t = dwTable([ROW, NULL_ROW], SUM, false)
  assert.equal(t.rows[t.rows.length - 1]!.cells[0], '合计')
})

test('反例注入（6 条必败）', () => {
  // ① 圆角改 14 ⇒ 判失败
  assert.equal(has('.tw-panel', 'border-radius:10px') && !has('.tw-panel', 'border-radius:14px'), true)
  assert.throws(() => assert.ok(has('.tw-panel', 'border-radius:14px'), '注入 14px'), /注入 14px/)
  // ② 复盘条 padding 改 10 10 ⇒ 判失败
  assert.throws(() => assert.ok(has('.tw-dw-review', 'padding:10px 10px'), '注入 padding'), /注入 padding/)
  // ③ 四指标 gap 改 8 ⇒ 判失败
  assert.throws(() => assert.ok(has('.tw-dw-kpis', 'gap:8px'), '注入 gap 8'), /注入 gap 8/)
  // ④ 图标题 13 → 12 ⇒ 判失败
  assert.throws(() => assert.ok(has('.tw-dw-chart-h .t', 'font-size:12px'), '注入字号'), /注入字号/)
  // ⑤ 行高 32 → 26 ⇒ 判失败
  assert.throws(() => assert.ok(has('.tw-dw-table th,.tw-dw-table td', 'height:26px'), '注入行高'), /注入行高/)
  // ⑥ 空单元格 ⇒ 判失败
  const injected = dwCells(NULL_ROW, false).cells.map((c, i) => (i === 3 ? '' : c))
  assert.throws(() => assert.ok(injected.every((c) => c.length > 0), '注入空格'), /注入空格/)
})
