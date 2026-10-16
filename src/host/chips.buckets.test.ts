/** task-67 ①②③ 的纯函数断言：96 桶、nice step 刻度、语义线、行高保护。 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CHIPS_BUCKETS, CHIPS_BUCKETS_MAX, CHIPS_BUCKETS_MIN, CHIPS_WINDOW, chipSeriesOf, normalizeBuckets } from './chips.ts'
import { chipsLinesOf, chipsRowHeight, niceStep, ratioTicks, stepDecimals } from '../client/chipsView.ts'

test('① 显式档数：范围夹取、非法回落并留痕，权重仍守恒（默认已改为自适应，见 chips.adaptive.test.ts）', () => {
  assert.equal(CHIPS_BUCKETS, 96, '历史默认值仍留在常量里（非自适应路径/老调用回落用）')
  assert.equal(CHIPS_BUCKETS / 32, 3, '与旧值 32 是 3× 关系（不是顺手改个数）')
  assert.equal(CHIPS_BUCKETS_MIN, 16)
  assert.equal(CHIPS_BUCKETS_MAX, 384, '上限放宽到自适应上限（显式 384 也要能跑）')
  assert.deepEqual(normalizeBuckets(undefined), { buckets: 96, note: null }, '缺省 ⇒ 96（历史默认；`chipSeriesOf` 的**缺省**走自适应，不走这里）')
  assert.deepEqual(normalizeBuckets(48), { buckets: 48, note: null }, '范围内 ⇒ 原样')
  const hi = normalizeBuckets(999)
  assert.equal(hi.buckets, CHIPS_BUCKETS_MAX, `越界上界 ⇒ 夹到 ${CHIPS_BUCKETS_MAX}`)
  assert.ok(hi.note !== null && hi.note.includes('夹到'), '夹取要留痕')
  const lo = normalizeBuckets(3)
  assert.equal(lo.buckets, CHIPS_BUCKETS_MIN, '越界下界 ⇒ 夹到 16')
  const bad = normalizeBuckets('96')
  assert.equal(bad.buckets, 96, '非数字 ⇒ 回落默认')
  assert.ok(bad.note !== null, '非数字要留痕')
  // 自适应默认：400 根 / 区间 7.8 元 ⇒ 档数由 planBuckets 定（不再恒为 96），权重守恒
  const bars = Array.from({ length: 400 }, (_, i) => ({ date: `d${i}`, close: 10 + (i % 40) * 0.2, low: 9.9 + (i % 40) * 0.2, high: 10.1 + (i % 40) * 0.2, vol: 100 }))
  const r = chipSeriesOf(bars, { fqSupported: true, floatMv: 1e9, window: CHIPS_WINDOW, display: 45, minSamples: 1 })
  assert.ok(r.bucketCount > 96, `缺省档数必须自适应（区间 7.8 元 ⇒ 比 96 多，实际 ${r.bucketCount}）`)
  assert.equal(r.latest?.buckets.length, r.bucketCount, '权重向量长度 = 实际档数')
  assert.ok(r.bucketWidth !== null && r.bucketWidth > 0, '档宽必须随结果给出（界面要显示）')
  // 显式给 32 也必须能跑（参数保留）
  const r32 = chipSeriesOf(bars, { fqSupported: true, floatMv: 1e9, window: CHIPS_WINDOW, display: 45, minSamples: 1, buckets: 32 })
  assert.equal(r32.bucketCount, 32, 'buckets 参数保留可用')
  for (const d of r.days.slice(0, 5)) {
    const sum = d.buckets.reduce((a, b) => a + b, 0)
    assert.ok(Math.abs(sum - 1) < 1e-6, `权重总和仍守恒（实际 ${sum}）`)
  }
})

test('② nice step 与比例刻度：步长整齐、数量 3–6、无浮点毛刺', () => {
  assert.equal(niceStep(0.012), 0.005, '峰值 1.2% ⇒ 步长 0.5%')
  assert.equal(niceStep(0.05), 0.02, '峰值 5%：raw=0.0125 ⇒ nice step 取 2%（1% < raw）')
  const step = niceStep(0.03)
  assert.ok([0.005, 0.01, 0.02, 0.025, 0.05].includes(step), `步长必须是 nice step（实际 ${step}）`)
  assert.equal(stepDecimals(0.005), 3)
  assert.equal(stepDecimals(0.01), 2)
  const ticks = ratioTicks(0.03)
  assert.ok(ticks.length >= 3 && ticks.length <= 6, `刻度数应在 3–6（实际 ${ticks.length}）`)
  for (const t of ticks) {
    assert.equal(t.label.endsWith('%'), true, '标签是百分比')
    assert.equal(/\d{1,2}(\.\d{1,3})?%/.test(t.label), true, `标签格式必须干净（实际 ${t.label}）`)
    assert.equal(t.label.includes('0000000'), false, `不许出现浮点毛刺（实际 ${t.label}）`)
  }
  assert.deepEqual(ratioTicks(0), [], '峰值为 0（没有分布）⇒ 不出横轴刻度')
  // 比例刻度从 0 起步且单调
  for (let i = 1; i < ticks.length; i += 1) assert.ok(ticks[i].value > ticks[i - 1].value, '刻度必须单调递增')
  assert.deepEqual(ratioTicks(Number.NaN), [], '非法峰值 ⇒ 空（不抛错）')
})

test('③ 语义线：坐标 = 平均成本/P95/P5（不是样例值），异常输入不出线不抛错', () => {
  const lines = chipsLinesOf({ avgCost: 18.57, support: 20.92, resistance: 22.2 })
  assert.equal(lines.length, 3)
  assert.deepEqual(lines.map((l) => l.kind), ['avg', 'resistance', 'support'])
  assert.deepEqual(lines.map((l) => l.price), [18.57, 22.2, 20.92], '坐标必须等于输入的三值（不是硬编码样例）')
  assert.deepEqual(lines.map((l) => l.label), ['18.57', '22.20', '20.92'], '标签文本 = 数值（两位小数）')
  // 换一组输入 ⇒ 坐标跟着变（证明不是写死的）
  const other = chipsLinesOf({ avgCost: 7.1, support: 6.5, resistance: 9.9 })
  assert.deepEqual(other.map((l) => l.price), [7.1, 9.9, 6.5])
  // 异常：缺值 / P95 < P5 / 非有限数 ⇒ 不出线
  assert.deepEqual(chipsLinesOf({ avgCost: null, support: 1, resistance: 2 }), [], '缺平均成本 ⇒ 不出线')
  assert.deepEqual(chipsLinesOf({ avgCost: 1, support: 5, resistance: 3 }), [], 'P95 < P5 ⇒ 不出线')
  assert.deepEqual(chipsLinesOf({ avgCost: Number.NaN, support: 1, resistance: 2 }), [], '非有限数 ⇒ 不出线')
  assert.doesNotThrow(() => chipsLinesOf({ avgCost: null, support: null, resistance: null }))
})

test('③ 行高：96 桶在可用高度里每行 ≥1px，极矮也照画（不静默丢桶）', () => {
  assert.equal(chipsRowHeight(192, 96), 2, '192px / 96 = 2px')
  assert.equal(chipsRowHeight(96, 96), 1, '正好 1px')
  assert.equal(chipsRowHeight(40, 96), 1, '不足 1px ⇒ 按 1px 画（不丢桶）')
  assert.equal(chipsRowHeight(0, 96), 1, '可用高度为 0 ⇒ 仍 1px（不抛错、不出 0 高度）')
  assert.equal(chipsRowHeight(Number.NaN, 96), 1)
})
