/** task-76：盈利比例的现价必须换算到**前复权空间**，并暴露四个输入字段。 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chipSeriesOf } from './chips.ts'

/** 合成一段"带除权"的前复权日线：fqt=1 序列把除权前的价格按因子缩过（这里手工构造已缩过的桶价） */
function barsFq1(): Array<{ date: string; close: number; low: number; high: number; vol: number }> {
  const out = []
  for (let i = 0; i < 30; i += 1) {
    // 前复权空间里的价格：10 → 20（区间够大，便于断言分位）
    const c = 10 + (i % 15) * 0.7
    out.push({ date: `2026-09-${String(i + 1).padStart(2, '0')}`, close: c, low: c - 0.2, high: c + 0.2, vol: 100 })
  }
  return out
}

const OPTS = { fqSupported: true, floatMv: 1e9, window: 360, display: 45, minSamples: 1, buckets: 32 } as const

test('① 合成除权（因子≠1）：盈利比例按**换算后**的现价算', () => {
  const bars = barsFq1()
  const rawSnapshot = 18 // 未复权快照价
  const scale = 0.9       // closeFq1_last / closeFq0_last = 0.9（除权把历史价格缩了 10%）
  const adj = chipSeriesOf(bars, { ...OPTS, price: rawSnapshot, priceScale: scale, priceSource: 'quote', fqSupported: true })
  assert.ok(Math.abs((adj.priceScale) - scale) < 1e-12, '汇算因子必须随结果返回')
  assert.ok(Math.abs((adj.priceUsed ?? 0) - rawSnapshot * scale) < 1e-9, `priceUsed = 原始价 × 因子（实际 ${adj.priceUsed}）`)
  assert.equal(adj.priceSource, 'quote')
  assert.equal(adj.fqt, 1)
  // 直接用原始快照（= 反例注入：绕过换算）必须得到**不同**的盈利比例
  const bypass = chipSeriesOf(bars, { ...OPTS, price: rawSnapshot, priceScale: 1, priceSource: 'quote', fqSupported: true })
  assert.notEqual(adj.profitRatio, bypass.profitRatio, '换算与不换算的结果必须不同（否则断言抓不住回退）')
  // 换算后的等价写法：把 priceUsed 直接当现价传、因子 1 ⇒ 结果必须逐位相等
  const equivalent = chipSeriesOf(bars, { ...OPTS, price: rawSnapshot * scale, priceScale: 1, priceSource: 'quote', fqSupported: true })
  assert.equal(adj.profitRatio, equivalent.profitRatio, 'price × scale 与 priceUsed 直传必须一致')
})

test('② 因子 == 1 ⇒ 与换算前**逐位相等**（恒等，不引入漂移）', () => {
  const bars = barsFq1()
  const a = chipSeriesOf(bars, { ...OPTS, price: 19.37, priceScale: 1, priceSource: 'quote', fqSupported: true })
  const b = chipSeriesOf(bars, { ...OPTS, price: 19.37, fqSupported: true })
  assert.equal(a.profitRatio, b.profitRatio, '因子 1 必须与不传因子逐位一致')
  assert.deepEqual(a.latest?.buckets, b.latest?.buckets, '桶权重也必须逐位一致（换算不碰分布）')
})

test('③ priceSource 两条分支 + 降级', () => {
  const bars = barsFq1()
  const quote = chipSeriesOf(bars, { ...OPTS, price: 18, priceScale: 0.95, priceSource: 'quote', fqSupported: true })
  assert.equal(quote.priceSource, 'quote')
  assert.equal(quote.priceUsed !== null, true)
  const fallback = chipSeriesOf(bars, { ...OPTS, price: 17.1, priceScale: 1, priceSource: 'close', fqSupported: true })
  assert.equal(fallback.priceSource, 'close', '报价缺失 ⇒ 回落收盘价并标注 close')
  const none = chipSeriesOf(bars, { ...OPTS, price: null, priceScale: 0.9, priceSource: 'quote', fqSupported: true })
  assert.equal(none.priceUsed, null, '现价不可得 ⇒ priceUsed = null（界面显示"未取到"）')
  assert.equal(none.profitRatio, null, '现价不可得 ⇒ 盈利比例未取到（不是 0）')
  assert.notEqual(none.avgCost, null, '平均成本仍有值（与现价无关）')
})

test('④ "最新一根"语义：最新一根用换算后的现价，历史展示日用当天收盘价（不混用）', () => {
  const bars = barsFq1()
  const r = chipSeriesOf(bars, { ...OPTS, price: 18, priceScale: 1, priceSource: 'quote', fqSupported: true })
  assert.equal(r.latestBarDate, bars[bars.length - 1].date, 'latestBarDate = 递推窗口最后一根')
  assert.equal(r.barAlignsWithDisplay, true, '默认展示日就是最新一根 ⇒ 对齐')
  assert.ok(r.methodology.includes('最新一根'), '口径字符串必须写明"最新一根"语义')
  assert.ok(r.methodology.includes('不混用'), '口径字符串必须写明展示日不一致时不混用')
})

test('⑤ 面板口径：四字段可读 + 现价不可得显示"未取到"', async () => {
  const { readFileSync } = await import('node:fs')
  const { fileURLToPath } = await import('node:url')
  const { dirname, join } = await import('node:path')
  const here = dirname(fileURLToPath(import.meta.url))
  const panel = readFileSync(join(here, '../client/ChipsPanel.tsx'), 'utf8')
  const api = readFileSync(join(here, '../client/api.ts'), 'utf8')
  for (const k of ['priceUsed', 'priceSource', 'fqt', 'priceScale']) {
    assert.ok(api.includes(k), `回包类型必须暴露 ${k}`)
    assert.ok(panel.includes(k) || panel.includes('latestBarDate'), `面板口径必须能读出 ${k}`)
  }
  assert.ok(panel.includes("'未取到'"), '现价不可得 ⇒ 显示"未取到"')
  assert.equal(/v === null \? '—' : `\$\{v\.toFixed\(2\)\}%`/.test(panel), false, '盈利比例的空值不再用 —')
})
