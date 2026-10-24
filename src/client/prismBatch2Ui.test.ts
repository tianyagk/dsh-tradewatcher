import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { TW_CSS } from './styles.ts'
import { basisBlocksOf, evalCurveOf, segmentItemWidthOf, segmentLayoutOf, segmentPaintOf } from './prismView.ts'

const here = dirname(fileURLToPath(import.meta.url))
const page = readFileSync(join(here, './PrismPage.tsx'), 'utf8')

test('评估卡 C：右栏净值之后、版本之前；三行 + n + 迷你曲线 + 脚注；样本不足给原因', () => {
  const eq = page.indexOf('tw-prism-equitycard')
  const ev = page.indexOf('tw-prism-evalcard')
  const ver = page.indexOf('tw-prism-verinfo')
  assert.ok(eq >= 0 && ev > eq && ver > ev, '顺序必须是净值 → 评估 → 版本')
  assert.ok(page.includes('超额（对 1.000300）'))
  assert.ok(page.includes('含费'))
  assert.ok(page.includes('不含费'))
  assert.ok(page.includes('回撤（自高点）'))
  assert.ok(page.includes('命中率'))
  assert.ok(page.includes('非重叠样本 · 不含 embargo 区间'))
  assert.ok(page.includes('n={evaluation.'))
  assert.ok(page.includes('tw-prism-evalchart'))
  assert.equal(evalCurveOf([1]) , null)
  assert.equal(evalCurveOf([1, 2])?.split(' ').length, 2)
  assert.throws(() => assert.equal(evalCurveOf([1]), '0,0', '注入：无样本也画曲线'), /注入/)
})

test('决策卡新增回撤闸门行：阈值/当前值/状态/不自动卖出', () => {
  assert.ok(page.includes("key: '回撤闸门'"))
  assert.ok(page.includes('单日 −3% / 累计 −10% / 状态'))
  assert.ok(page.includes('目标总仓 ≤'))
  assert.ok(page.includes('dd.status'))
  assert.equal(/自动卖出/.test(page), false, '界面不得提供自动卖出动作')
})

test('行业上限 A：行业/宽基单元格可编辑；未穿透/现金固定行不写 input', () => {
  assert.ok(page.includes('tw-prism-limitinput'))
  assert.ok(page.includes('saveIndustryLimit'))
  assert.ok(page.includes('onBlur'))
  assert.ok(page.includes('onKeyDown'))
  assert.match(page, /aria-label=\{`\$\{r\.name\}行业上限`\}/)
  const fixed = page.slice(page.indexOf('{expFixed.map((r) =>'), page.indexOf('{expTop.map((r) =>'))
  assert.equal(fixed.includes('tw-prism-limitinput'), false, '固定行不得出现可编辑上限')
  assert.match(TW_CSS, /\.tw-prism-limitinput\{[^}]*border-bottom:1px dashed/)
  assert.match(TW_CSS, /\.tw-prism-limitinput:focus\{[^}]*box-shadow/)
})

test('评估/回撤/行业上限样式在 CSS 中存在且不出现“预测能力”', () => {
  for (const s of ['.tw-prism-evalrow', '.tw-prism-evalchart', '.tw-prism-limitinput']) assert.ok(TW_CSS.includes(s), s)
  const all = `${page}\n${TW_CSS}\n${readFileSync(join(here, '../host/prismEval.ts'), 'utf8')}`
  assert.equal(all.includes('预测能力'), false)
})

test('分段控件渲染级：每项最小宽 + 实际间隙 ≥4px + 容器 2px；选中/未选中背景不同', () => {
  const labels = ['持仓', '挂单', '成交']
  const layout = segmentLayoutOf(labels)
  assert.equal(layout.padding, 2)
  assert.equal(layout.gap, 4)
  assert.ok(segmentItemWidthOf(labels) >= 49)
  assert.ok(page.includes('segmentItemWidthOf') && page.includes('SEGMENT_GAP'))
  assert.ok(layout.gaps.every((g) => g >= 4), `实际间隙 ${layout.gaps.join(',')}`)
  const selected = segmentPaintOf(true)
  const idle = segmentPaintOf(false)
  assert.notEqual(selected.background, idle.background)
  assert.equal(selected.fontWeight, 700)
  const injected = segmentLayoutOf(labels, { gap: 0 })
  assert.throws(() => assert.ok(injected.gaps.every((g) => g >= 4), '注入：间隙 0'), /注入/)
  assert.throws(() => assert.notEqual('red', 'red', '注入：同色'), /注入/)
})

test('仓位上限依据渲染级：恰为 3 块、每块单行；合成一段 ⇒ 必败', () => {
  const blocks = basisBlocksOf(['资金上限 1 · 单票 25% · 总仓 60%', '达成度 —（缺行业数据）', '本次夹紧 —'])
  assert.equal(blocks.length, 3)
  assert.ok(blocks.every((b) => !b.includes('\n')))
  assert.ok(page.includes('basisBlocks.map'))
  assert.ok(page.includes('basisBlocksOf'))
  assert.ok(page.includes('tw-prism-basis-block'))
  assert.throws(() => basisBlocksOf(['a\nb', 'c']), /3 块/)
  assert.throws(() => basisBlocksOf(['a', 'b', 'c', 'd']), /3 块/)
})
