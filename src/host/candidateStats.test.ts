/** 候选池指标表：算好的数给模型判断，不做评分排序 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { candidateLineOf, candidateRowOf, candidatesTextOf } from './candidateStats.ts'
import { techOf } from './indexTech.ts'
import type { DayBar } from '../shared/model.ts'

const bars = (closes: number[]): DayBar[] => closes.map((c) => ({ date: '2026-11-03', open: c, close: c, high: c * 1.01, low: c * 0.99, vol: 1000 }))
const rising = bars(Array.from({ length: 120 }, (_, i) => 10 + i * 0.1))
const falling = bars(Array.from({ length: 120 }, (_, i) => 30 - i * 0.1))

test('① 行内包含现价/动量/均线/RSI/量比/位置/估值', () => {
  const row = candidateRowOf({ secid: '1.601872', name: '招商轮船', held: true }, rising, { pe: 12.3, pb: 1.4, totalMv: 42e9, name: null })
  const line = candidateLineOf(row)
  for (const key of ['[持仓]', '招商轮船（1.601872）', '现价', '动量 5日', 'MA20', 'MA60', 'RSI14', '量比(5/20)', '20日位置', 'PE 12.3', 'PB 1.40', '总市值 420.0 亿']) {
    assert.ok(line.includes(key), `缺 ${key}：${line}`)
  }
})

test('② 缺数据写 —（未取到日线），不编指标', () => {
  const row = candidateRowOf({ secid: '1.999999', name: '无数据', held: false }, [], undefined)
  assert.match(candidateLineOf(row), /—（未取到日线，无法计算指标）/)
})

test('③ 顺序 = 传入顺序（持仓在前、自选在后），不做动量排序', async () => {
  const text = await candidatesTextOf([
    { secid: '1.601872', name: '招商轮船', held: true },
    { secid: '1.600938', name: '中国海油', held: false },
  ], {
    loadBars: async (secid) => (secid === '1.601872' ? falling : rising),
    loadValuation: async () => ({}),
  })
  const iA = text.indexOf('招商轮船'); const iB = text.indexOf('中国海油')
  assert.ok(iA > 0 && iB > iA, '必须保持传入顺序（弱动量的持仓也在前）')
})

test('④ 段落带口径说明：指标已算好、叙事状态由模型判断', async () => {
  const text = await candidatesTextOf([{ secid: '1.600938', name: '中国海油', held: false }], { loadBars: async () => rising, loadValuation: async () => ({}) })
  assert.match(text, /【候选池（持仓 \+ 自选，共 1 只；指标由后端算好，叙事状态由你判断）】/)
  assert.match(text, /使用「唯一 \/ 全部 \/ 所有」等绝对说法前/)
  assert.match(text, /指标不得自行编造/)
})

test('⑤ 提示词：orders 只能来自候选池，且要做叙事状态判断', () => {
  const pipe = readFileSync(new URL('./prismPipeline.ts', import.meta.url), 'utf8')
  assert.match(pipe, /【强制·候选池】/)
  assert.match(pipe, /叙事状态由你判断/)
})

test('⑥ 与指数技术面同源：同一序列算出的 RSI/动量一致', () => {
  const t = techOf({ name: 'x', secid: '1.000000', role: '' }, rising)
  const row = candidateRowOf({ secid: '1.000000', name: 'x', held: false }, rising, undefined)
  assert.equal(row.rsi14, t.rsi14)
  assert.equal(row.chg20, t.chg20)
})
