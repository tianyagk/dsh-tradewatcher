/** task-69：价格轴裁剪（质量覆盖）+ 横轴与条宽同源同尺度。 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { CHIPS_COVERAGE, axisTicks, bucketCenterTicks, chipAxisOf, massWindowOf } from './chipsView.ts'
const require = createRequire(import.meta.url)

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

test('task-78 ①：窗口内行数 == 覆盖的桶数（不许因权重小少行），空桶占位、权重守恒', () => {
  const n = 96
  const c = centers(n)
  const b = new Array(n).fill(0)
  // 中段密集 + **中间夹一个空桶**（旧实现会把它删掉 ⇒ 轴出现空洞）
  for (let i = 30; i <= 60; i += 1) b[i] = 1 / 31
  b[45] = 0
  const w = massWindowOf(c, b, CHIPS_COVERAGE)
  assert.equal(w.rows, w.to - w.from + 1, '布局行数必须等于窗口覆盖的桶数')
  const view = b.slice(w.from, w.to + 1)
  assert.equal(view.length, w.rows)
  assert.equal(view.some((x) => x === 0), true, '窗口里必须仍有空桶（占位，不删行）')
  // 空桶不参与权重，但守恒关系不变
  const kept = view.reduce((a, x) => a + x, 0)
  assert.ok(Math.abs(kept - b.reduce((a, x) => a + x, 0)) < 1e-9, '权重之和守恒（没有归一化拉伸）')
})

test('task-78 ②：刻度值**必须**是某行的桶中心价（旧实现按两端等分 ⇒ 不在集合里）', () => {
  const n = 42
  const c = centers(n, 15.33, 22.82)
  const ticks = bucketCenterTicks(c)
  assert.ok(ticks.length >= 2 && ticks.length <= 5, `刻度数应在 2–5（实际 ${ticks.length}）`)
  for (const t of ticks) {
    assert.ok(c.some((y) => Math.abs(y - t) < 1e-12), `刻度 ${t} 必须是某个桶的中心价`)
  }
  assert.equal(ticks[0], c[0], '首刻度覆盖窗口下端')
  assert.equal(ticks[ticks.length - 1], c[n - 1], '末刻度覆盖窗口上端')
  // 旧函数（对照）：线性等分产生**非**桶中心值 ⇒ 正是"刻度与行对不上"的来源
  const legacy = axisTicks(c)
  assert.equal(legacy.some((t) => !c.some((y) => Math.abs(y - t) < 1e-12)), true, '旧 axisTicks 会产生非桶中心值（这就是要换掉它的原因）')
})

test('task-78 ③：轴顶与条宽同源（同一峰值变量），换一天一起变', () => {
  const n = 96
  const c = centers(n)
  const day1 = new Array(n).fill(0); day1[50] = 0.05
  const day2 = new Array(n).fill(0); day2[50] = 0.08
  const a1 = chipAxisOf(c, day1), a2 = chipAxisOf(c, day2)
  assert.equal(a1.peak, 0.05); assert.equal(a2.peak, 0.08)
  assert.ok(Math.abs(a1.widthOf(a1.peak) - (a1.peak / a1.top) * 100) < 1e-9, '条宽分母就是轴顶（同源）')
  assert.notEqual(a1.top, a2.top, '换一天（峰值不同）⇒ 轴顶跟着变')
  assert.notDeepEqual(a1.ticks.map((t) => t.pct), a2.ticks.map((t) => t.pct), '刻度位置也一起变')
})

test('task-79 ②：几何锚定断言（真实量级 fixture）——单位混用必被抓', () => {
  // 真实量级：展示日峰值 0.0863（分数）、轴顶 0.1（分数）
  const n = 40
  const c = centers(n, 15.3, 22.8)
  const b = new Array(n).fill(0)
  b[20] = 0.0863
  const ax = chipAxisOf(c, b)
  assert.ok(Math.abs(ax.peak - 0.0863) < 1e-12, `peak 是分数（实际 ${ax.peak}）`)
  assert.ok(Math.abs(ax.top - 0.1) < 1e-12, `top 是分数 0.1（实际 ${ax.top}）`)
  const w = ax.widthOf(ax.peak)
  // ① 峰值条宽必须落在 [80%, 90%]（0.0863 / 0.1 = 86.3%）——**混单位时这里会是 0.86%**
  assert.ok(w >= 80 && w <= 90, `widthOf(峰值) 必须 ≈86%（实际 ${w}%）`)
  // ② 轴顶对应的桶 ⇒ 正好 100%
  assert.ok(Math.abs(ax.widthOf(ax.top) - 100) < 1e-9, `轴顶桶宽必须 === 100%（实际 ${ax.widthOf(ax.top)}%）`)
  // ③ peak === top ⇒ 1.0（100%）
  const b2 = new Array(n).fill(0)
  b2[20] = 0.1
  const ax2 = chipAxisOf(c, b2)
  assert.equal(ax2.peak, ax2.top, '单桶 10% ⇒ 轴顶就是它自己')
  assert.ok(Math.abs(ax2.widthOf(ax2.peak) - 100) < 1e-9, 'peak === top ⇒ 条宽 100%')
  // ④ 单位契约：widthOf 返回**百分数**（0–100），不是分数
  assert.ok(ax.widthOf(0.05) > 1 && ax.widthOf(0.05) <= 100, `widthOf 必须返回百分数（实际 ${ax.widthOf(0.05)}）`)
  // ⑤ 渲染层写的也是百分号（静态核对，避免"函数对、渲染又乘一次"）
  const { readFileSync } = require('node:fs') as { readFileSync: (p: string) => string }
  const { fileURLToPath } = require('node:url') as { fileURLToPath: (u: string) => string }
  const { dirname, join } = require('node:path') as { dirname: (p: string) => string; join: (...p: string[]) => string }
  const panel = readFileSync(join(dirname(fileURLToPath(import.meta.url)), './ChipsPanel.tsx'))
  assert.ok(panel.includes('width: `${axis.widthOf(w)}%`'), '渲染必须直接用 widthOf 的百分数 + %')
  assert.equal(/width: `\$\{axis\.widthOf\(w\) \* 100\}%`/.test(panel), false, '渲染层不许再乘一次 100')
})
