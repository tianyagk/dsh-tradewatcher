/** 技术面报告的数据源：指数指标必须由后端算好（不给模型自己编的机会） */
import test from 'node:test'
import assert from 'node:assert/strict'
import { INDEX_DEFS, indexTechTextOf, rsiOf, techOf } from './indexTech.ts'
import { PRISM_ANALYSIS_META } from '../shared/prism.ts'
import type { DayBar } from '../shared/model.ts'

const bars = (closes: number[], vol = 1000): DayBar[] => closes.map((c, i) => ({
  date: `2026-01-${String((i % 28) + 1).padStart(2, '0')}`, open: c, close: c, high: c * 1.01, low: c * 0.99, vol,
}))

test('① techOf：均线/MACD/RSI/量比/区间位置都算得出', () => {
  const closes = Array.from({ length: 120 }, (_, i) => 100 + i * 0.5)
  const t = techOf({ name: '中证1000', secid: '1.000852', role: '小微盘' }, bars(closes))
  assert.equal(t.close, 159.5)
  assert.ok(t.ma5! > t.ma20! && t.ma20! > t.ma60!, '单边上涨应是多头排列')
  assert.equal(t.maState, '多头排列')
  assert.ok(t.chg20! > 0 && t.chg60! > 0)
  assert.ok(t.dif! > 0 && t.hist! !== null)
  assert.equal(t.rsi14, 100, '只涨不跌 RSI=100')
  assert.ok(t.pos20! > 70, `区间位置应偏高，实际 ${t.pos20}`)
})

test('② 下跌序列：空头排列 + RSI 低', () => {
  const closes = Array.from({ length: 120 }, (_, i) => 200 - i * 0.5)
  const t = techOf({ name: '沪深300', secid: '1.000300', role: '核心蓝筹' }, bars(closes))
  assert.equal(t.maState, '空头排列')
  assert.equal(t.rsi14, 0)
  assert.ok(t.pos20! < 20, `区间位置应偏低，实际 ${t.pos20}`)
})

test('③ 缺数据：写 — 并给原因（不编数）', async () => {
  const text = await indexTechTextOf({ loadBars: async () => null })
  for (const def of INDEX_DEFS) assert.ok(text.includes(def.name), `缺少 ${def.name} 行`)
  assert.ok((text.match(/—（未取到日线）/g) ?? []).length >= 4, '缺数据必须标 —（未取到日线）')
})

test('④ 中证2000 走 ETF 代理时必须注明（不给假指数）', async () => {
  const text = await indexTechTextOf({
    loadBars: async (secid) => (secid === '1.563300' ? bars(Array.from({ length: 80 }, () => 1.1)) : null),
  })
  assert.match(text, /（数据源：1\.563300 中证2000ETF华泰柏瑞 代理；指数日线不可用）/)
})

test('⑤ 角色改名：A股宏观 → 技术面；信息面统一解读新闻', () => {
  const meta = PRISM_ANALYSIS_META
  const tech = meta.find((m) => m.key === 'a-macro')!
  assert.equal(tech.label, '技术面')
  for (const key of ['中证1000', '中证2000', '沪深300', '科创50', '科创半导体ETF']) assert.ok(tech.prompt.includes(key), `技术面提示词缺 ${key}`)
  const info = meta.find((m) => m.key === 'info')!
  assert.match(info.prompt, /统一解读/)
  assert.match(info.prompt, /新闻解读只在本段出现/)
})

test('⑥ RSI 边界：全涨=100、全跌=0、样本不足=null', () => {
  assert.equal(rsiOf([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]), 100)
  assert.equal(rsiOf([16, 15, 14, 13, 12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1]), 0)
  assert.equal(rsiOf([1, 2, 3]), null)
})
