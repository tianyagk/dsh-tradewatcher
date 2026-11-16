/** v0.193.0：汪汪队两张图的坐标轴/网格/柱高归一（AUDIT 图形验收） */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { dwSeries, niceTicksOf, xTicksOf } from './dogwatchView.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const SRC = readFileSync(join(HERE, 'MarketPage.tsx'), 'utf8')
const series = [
  { day: '2026-09-01', change: -3.2, index: 98 },
  { day: '2026-09-02', change: 1.5, index: 99.5 },
  { day: '2026-09-03', change: 0.4, index: 99.9 },
  { day: '2026-09-04', change: 8.6, index: 108.5 },
  { day: '2026-09-05', change: -0.9, index: 107.6 },
]

test('③ Y 轴 ≥3 档且含 0（柱）/ 含基期 100（线）', () => {
  const d = dwSeries(series)
  assert.ok(d.yTicksBar.length >= 3, `柱图 Y 轴至少 3 档（实得 ${d.yTicksBar.length}）`)
  assert.ok(d.yTicksBar.includes(0), '柱图 Y 轴必须含 0')
  assert.ok(d.yTicksLine.length >= 3, `折线 Y 轴至少 3 档（实得 ${d.yTicksLine.length}）`)
  assert.ok(d.yTicksLine.includes(100), '折线 Y 轴必须含基期 100')
  assert.throws(() => assert.equal(d.yTicksBar.length, 1, '反例上：无轴'), /反例上/, '⚠ 反例注入必须失败')
})

test('④ X 轴 ≥5 个日期刻度（缺 ⇒ 败）', () => {
  const long = Array.from({ length: 60 }, (_, i) => ({ day: `2026-10-${String((i % 28) + 1).padStart(2, '0')}`, change: i % 5, index: 100 + i }))
  const d = dwSeries(long)
  assert.ok(d.xTicks.length >= 5, `X 轴至少 5 个刻度（实得 ${d.xTicks.length}）`)
  for (const t of d.xTicks) assert.match(t.label, /^\d{2}-\d{2}$/, '刻度必须是 MM-DD')
  assert.equal(xTicksOf([]).length, 0, '空序列不造刻度')
  assert.throws(() => assert.equal(d.xTicks.length, 2, '反例上：刻度不足'), /反例上/, '⚠ 反例注入必须失败')
})

test('⑤ 两图都有 ≥3 条水平网格线（无 ⇒ 败）', () => {
  const d = dwSeries(series)
  assert.ok(d.yTicksBar.length >= 3)
  assert.ok(d.yTicksLine.length >= 3)
  assert.match(SRC, /'data-role': 'dw-grid'/, '柱图必须渲染网格线')
  const grids = (SRC.match(/'data-role': 'dw-grid'/g) ?? []).length
  assert.ok(grids >= 2, `柱/线两图都要有网格（实得 ${grids} 处渲染点）`)
  assert.throws(() => assert.equal(grids, 0, '反例上：无网格'), /反例上/, '⚠ 反例注入必须失败')
})

test('⑥ 柱高归一：max(barPct) === 100 且正负两侧都出现', () => {
  const d = dwSeries(series)
  assert.equal(Math.max(...d.barPct), 100, '最大柱必须是 100%')
  const positives = d.bars.filter((v) => v > 0).length
  const negatives = d.bars.filter((v) => v < 0).length
  assert.ok(positives > 0 && negatives > 0, '正负两侧都要有柱')
  assert.ok(d.barPct.filter((v) => v > 50).length >= 1, '不得全贴零线')
  assert.throws(() => assert.equal(Math.max(...d.barPct), 3, '反例上：全贴零线'), /反例上/, '⚠ 反例注入必须失败')
})

test('niceTicksOf：步长 1/2/5×10ⁿ、含 anchor、≥3 档', () => {
  const t0 = niceTicksOf(0, 10, 0)
  assert.ok(t0.includes(0) && t0.length >= 3, '含 0 且 ≥3 档')
  const t = niceTicksOf(-3.2, 8.6, 0)
  assert.ok(t.includes(0) && t.length >= 3)
  const diffs = t.slice(1).map((v, i) => +(v - t[i]!).toFixed(6))
  assert.equal(new Set(diffs).size, 1, '等距')
})
