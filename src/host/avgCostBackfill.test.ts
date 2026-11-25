/** 买入均价回填：从最近复制基准 + 其后买入成交重算；卖出不影响 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { avgCostFromHistory } from './prismAccount.ts'

const logs = [{ at: 100, after: ['1.601872×24000@18.23', '1.518880×5000@8.89'] }]

test('① 只有复制基准、没有买入 ⇒ 均价 = 基准成本', () => {
  assert.equal(avgCostFromHistory('1.601872', logs, [], [], 30.71), 18.23)
})

test('② 基准后买入按含费加权；卖出不参与', () => {
  const fills = [
    { secid: '1.601872', side: 'buy' as const, at: 200, shares: 10_000, amount: 150_000, fee: 5 },
    { secid: '1.601872', side: 'sell' as const, at: 300, shares: 20_000, amount: 300_000, fee: 5 },
  ]
  const avg = avgCostFromHistory('1.601872', logs, fills, [], 30.71)
  // (24000×18.23 + 150005) / 34000 ≈ 17.28
  assert.ok(Math.abs(avg - 17.28) < 0.02, `实际 ${avg}`)
})

test('③ 没有复制记录 ⇒ 回落传入的 fallback（不编造）', () => {
  assert.equal(avgCostFromHistory('0.300999', logs, [], [], 12.34), 12.34)
})

test('④ 反例：摊薄成本 30.71 与均价 18.23 差距巨大（正是浮亏 −49% 的来源）', () => {
  const avg = avgCostFromHistory('1.601872', logs, [], [], 30.71)
  const diluted = 30.71
  const price = 15.52
  assert.ok((price / diluted - 1) * 100 < -45, '摊薄口径算出 −49%')
  assert.ok((price / avg - 1) * 100 > -16, '买入均价口径约 −14.9%')
})

test('⑤ 基准被卖光后重新买入 ⇒ 均价只由新买入决定（科创半导体 0.695，不是 0.85）', () => {
  const logs2 = [{ at: 0, after: ['1.588170×600000@0.86'] }]
  const fills2 = [
    { secid: '1.588170', side: 'sell' as const, at: 10, shares: 600_000, amount: 400_000, fee: 100 },
    { secid: '1.588170', side: 'buy' as const, at: 20, shares: 40_000, amount: 40_000 * 0.695, fee: 7.23 },
  ]
  assert.equal(avgCostFromHistory('1.588170', logs2, fills2, [], 0.7), 0.695, '40 000×0.695 + 7.23 ≈ 0.6952，低价 ETF 保留 3 位')
})

test('⑥ 手工调整按 after 重置（招商轮船 24 000 @18.21 后卖出，均价保持 18.21）', () => {
  const logs3 = [{ at: 0, after: ['1.601872×24000@18.23'] }]
  const adj = [{ at: 5, secid: '1.601872', after: { qty: 24_000, cost: 18.21 } }]
  const fills3 = [{ secid: '1.601872', side: 'sell' as const, at: 10, shares: 20_000, amount: 310_000, fee: 50 }]
  assert.equal(avgCostFromHistory('1.601872', logs3, fills3, adj as never, 30), 18.21)
})
