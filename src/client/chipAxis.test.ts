/** task-69：价格轴裁剪（质量覆盖）+ 横轴与条宽同源同尺度。 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CHIPS_COVERAGE, chipAxisOf, massWindowOf } from './chipsView.ts'

const centers = (n: number, lo = 5.47, hi = 22.82): number[] => Array.from({ length: n }, (_, i) => lo + ((hi - lo) * i) / (n - 1))

test('① 裁剪：显示区间必须覆盖 ≥ 目标比例的筹码质量，且不做归一化拉伸', () => {
  // 造一个"集中在中段 + 两端稀薄"的 96 桶分布
  const n = 96
  const c = centers(n)
  const b = new Array(n).fill(0)
  for (let i = 30; i <= 60; i += 1) b[i] = 1 / 31 // 中段 31 桶占 1.0
  const w = massWindowOf(c, b, CHIPS_COVERAGE)
  // 组合口径：先按质量 99% 裁，再按"稀疏行阈值"（< 窗口峰值 20%）裁 ⇒ 覆盖率可能低于 99%（阈值先咬住），
  // 因此断言用 95% 兜底，并另行断言 covered + dropped === 1（被裁掉的部分必须如实报告，不静默）
  assert.ok(w.covered >= 0.95, `裁剪后覆盖必须 ≥ 95%（组合口径，实际 ${w.covered}）`)
  assert.ok(w.rows < n, `裁剪必须真的缩小行数（${w.rows} < ${n}）`)
  assert.ok(Math.abs(w.covered + w.dropped - 1) < 1e-9, 'covered + dropped 必须为 1（如实报告被裁掉的部分）')
  assert.ok(w.lo >= c[0] && w.hi <= c[n - 1], '裁剪区间必须在原区间内')
  // 权重没有被改动：窗口内之和 === 原序列在窗口内的和（不是归一化）
  const kept = b.slice(w.from, w.to + 1).reduce((a, x) => a + x, 0)
  assert.equal(kept, b.reduce((a, x) => a + x, 0) * 1, '窗口内权重之和保持原值（未拉伸）')
  // 极端：全 0 / 空
  assert.doesNotThrow(() => massWindowOf(c, new Array(n).fill(0)))
  assert.deepEqual(massWindowOf([], [], 0.99).rows, 0)
})

test('② 横轴与条宽同源同尺度：条宽分母就是轴顶（不是峰值）', () => {
  const n = 96
  const c = centers(n)
  const b = new Array(n).fill(0)
  b[50] = 0.0805 // 单桶峰值 8.05%（与 live 同量级）
  b[49] = 0.04
  const ax = chipAxisOf(c, b)
  assert.equal(ax.peak, 0.0805, '峰值 = 当前展示日单桶最大权重')
  assert.ok(ax.top >= ax.peak, `轴顶必须 ≥ 峰值（实际 ${ax.top}）`)
  // 关键：条宽按**轴顶**换算 ⇒ 峰值的条宽 = peak/top，与刻度的同一尺度一致
  const peakWidth = ax.widthOf(ax.peak)
  assert.ok(Math.abs(peakWidth - (ax.peak / ax.top) * 100) < 1e-9, '峰值条宽 = peak/top（与刻度同尺度）')
  assert.ok(peakWidth <= 100 && peakWidth > 0)
  // 刻度的最大比例就是轴顶本身
  const last = ax.ticks[ax.ticks.length - 1]
  assert.ok(Math.abs(last.value - ax.top) < 1e-12, '刻度集必须覆盖到轴顶')
  assert.equal(ax.ticks[0].value, 0, '刻度从 0 起步')
  // 与旧实现的差别：旧实现条宽 = w/peak（峰值 ⇒ 100% 宽），在 10% 轴上看起来"顶到 10%"
  assert.notEqual(peakWidth, 100, '峰值条宽**不该**是 100%（那就又变回"按峰值归一"的错）')
})

test('② 刻度跟随展示日自适应；峰值为 0 不刻度；极值不抛错', () => {
  const n = 96
  const c = centers(n)
  const day1 = new Array(n).fill(0); day1[40] = 0.02
  const day2 = new Array(n).fill(0); day2[40] = 0.08   // 另一天峰值更大
  const a1 = chipAxisOf(c, day1)
  const a2 = chipAxisOf(c, day2)
  assert.notDeepEqual(a1.ticks.map((t) => t.label), a2.ticks.map((t) => t.label), '换一天（峰值不同）⇒ 刻度集必须不同')
  // 峰值为 0
  const zero = chipAxisOf(c, new Array(n).fill(0))
  assert.deepEqual(zero.ticks, [], '峰值为 0 ⇒ 不出刻度')
  assert.equal(zero.widthOf(0), 0)
  assert.equal(zero.top, 0)
  // 单桶 100% 的极端
  const one = new Array(n).fill(0); one[10] = 1
  const ax = chipAxisOf(c, one)
  assert.ok(ax.top >= 1 && ax.ticks.length >= 2, '单桶 100% ⇒ 轴顶 ≥ 100%、刻度正常')
  assert.ok(ax.widthOf(1) <= 100 + 1e-9, '条宽不得超过 100%')
  assert.doesNotThrow(() => chipAxisOf([], []))
  assert.doesNotThrow(() => chipAxisOf(c, new Array(n).fill(Number.NaN)))
})
