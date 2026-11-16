/**
 * 汪汪队跟踪卡片：6 条结构断言 + 反例注入（缺一 ⇒ 败）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { DW_COLUMNS, DW_FOOTNOTE, dwCells, dwKpis, dwReview, dwTable, type DwRow, type DwSummary } from './dogwatchView.ts'

const SRC = readFileSync(new URL('./MarketPage.tsx', import.meta.url), 'utf8')
const SUM: DwSummary = { totalAmount: 413.8e8, ratio: 0.78, netBuy: -74.17e8, weightedPct: -1.47, baseDate: '2026-11-13 周五', totalSharesYi: 2156.8 }
const ROW: DwRow = { secid: '510300', name: '沪深300ETF华泰柏瑞', indexName: '沪深300', scale: 1862.8, amount: 34.89e8, ratio20: 0.4, netBuy: -5.37e8, pct: -0.75, sharesYi: 456.2, sharesDelta: -30.21 }
const NULL_ROW: DwRow = { secid: 'x', name: '某ETF', indexName: '沪深300', scale: null, amount: null, ratio20: null, netBuy: null, pct: null, sharesYi: null, sharesDelta: null }

test('① 复盘条存在：日期行 + 结论 + 大号倍数', () => {
  const r = dwReview(SUM.baseDate ?? '—', SUM)
  assert.match(r.day, /^最近交易日复盘 · 2026-11-13 周五$/)
  assert.equal(r.verdict, '没看出上班迹象')
  assert.equal(r.big, '0.78×')
  assert.equal(r.bigSub, '较 20 日均额')
  assert.match(SRC, /'data-role': 'dw-review'/, '页面必须有复盘条')
  const injected = SRC.replace("'data-role': 'dw-review'", "'data-role': 'x'")
  assert.doesNotMatch(injected, /'data-role': 'dw-review'/, '注入删除复盘条必须判失败')
})

test('② 四指标且各带副行（缺副行 ⇒ 败）', () => {
  const k = dwKpis(SUM)
  assert.equal(k.length, 4)
  assert.deepEqual(k.map((x) => x.label), ['汪汪队合计成交额', '成交额放大倍数', '合计主动净买入', '池内加权涨跌'])
  for (const x of k) assert.ok(x.sub.length > 0, `${x.label} 必须有副行`)
  assert.deepEqual(k.map((x) => x.value), ['413.8亿', '0.78×', '−74.17亿', '−1.47%'])
  const injected = k.map((x) => ({ ...x, sub: '' }))
  assert.equal(injected.some((x) => x.sub === ''), true, '注入空副行必须判失败')
})

test('③ 两张图容器都在（缺一 ⇒ 败）', () => {
  assert.match(SRC, /'data-role': 'dw-chart-bars'/)
  assert.match(SRC, /'data-role': 'dw-chart-line'/)
  const onlyBars = SRC.replace("'data-role': 'dw-chart-line'", "'data-role': 'x'")
  assert.doesNotMatch(onlyBars, /'data-role': 'dw-chart-line'/, '注入删线图容器必须判失败')
})

test('④ 表头 9 列顺序正确', () => {
  assert.deepEqual([...DW_COLUMNS], ['ETF', '跟踪指数', '规模(亿)', '成交额(亿)', '较20日均', '主动净买入(亿)', '涨跌', '份额(亿份)', '份额变化'])
  assert.equal(DW_COLUMNS.length, 9)
})

test('⑤ 口径小字存在且逐字一致', () => {
  assert.equal(DW_FOOTNOTE, '份额来源：上交所 ETF 规模日报（日频）· 仅沪市 14 只 · 折算已剔除 · 主动净买入为逐笔方向推算')
  assert.match(SRC, /'data-role': 'dw-foot'/)
  assert.ok(SRC.includes('DW_FOOTNOTE'), '页面必须渲染同一常量')
})

test('⑥ 单元格永不为空：缺数据落 `—` + title 原因（空串 ⇒ 败）', () => {
  for (const row of [ROW, NULL_ROW]) {
    const c = dwCells(row, false)
    assert.equal(c.cells.length, 9)
    for (const cell of c.cells) assert.ok(cell.length > 0, `单元格不许为空：${JSON.stringify(c.cells)}`)
    c.cells.forEach((cell, i) => { if (cell === '—') assert.ok((c.titles[i] ?? '').length > 0, `第 ${i} 列 — 必须带 title 原因`) })
  }
  const injected = dwCells(NULL_ROW, false).cells.map((x, i) => (i === 2 ? '' : x))
  assert.equal(injected.some((x) => x === ''), true, '注入空字符串必须判失败')
})

test('表格：按规模降序 + 末行合计', () => {
  const rows: DwRow[] = [ROW, { ...ROW, secid: 'b', name: '小', scale: 10 }, { ...ROW, secid: 'c', name: '大', scale: 900 }]
  const t = dwTable(rows, SUM, false)
  assert.deepEqual(t.rows.slice(0, 3).map((r) => r.cells[0]), ['沪深300ETF华泰柏瑞', '大', '小'])
  assert.equal(t.rows[t.rows.length - 1]!.cells[0], '合计')
})
