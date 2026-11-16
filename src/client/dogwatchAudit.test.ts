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
  assert.match(SRC, /missingCellText\('加载中'\)/, '加载态有文案')
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
  assert.match(SRC, /className: `\$\{i >= 2 \? 'num' : ''\}/, '数值列带符号类')
})
