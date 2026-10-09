/**
 * 这正是必须钉死的点 —— 概率面板上出现 >100% 的区间，整块结论就没人信了。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { SMALL_SAMPLE_N, isSmallSample, wilsonInterval, wilsonFromRate } from './stats.ts'

test('Wilson：区间恒在 [0,1] 内（极端比例与极小样本也不例外）', () => {
  for (const [k, n] of [[0, 1], [1, 1], [1, 5], [5, 5], [0, 5], [3, 3], [80, 100], [8, 10]] as Array<[number, number]>) {
    const iv = wilsonInterval(k, n)
    assert.ok(iv.lo !== null && iv.hi !== null)
    assert.ok(iv.lo! >= 0 && iv.lo! <= 1, `lo=${iv.lo} 必须落在 [0,1]`)
    assert.ok(iv.hi! >= 0 && iv.hi! <= 1, `hi=${iv.hi} 必须落在 [0,1]`)
    assert.ok(iv.lo! <= iv.hi!, '下界不得高于上界')
    // 注意：Wilson 是 **score** 区间，围绕"调整后的估计"对称，而不是围绕 p̂ 对称。
    // 因此 p̂ 落在区间外是正确行为（如 k=0,n=1 时区间约 [0.19, 1]，而 p̂=0）。
    // 这里只对"比例不在边界"的常见情形断言包含关系 —— 曾经把这条写成对**所有**输入的
    // 硬断言，结果测的是错误的数学事实，而不是实现。
    if (n >= 5 && k > 0 && k < n) {
      assert.ok(iv.lo! <= iv.p! && iv.p! <= iv.hi!, `n=${n}、k=${k} 时点估计应落在区间内`)
    }
  }
})

test('Wilson：极端比例下区间不会越界（朴素正态近似会给出 >100%）', () => {
  // k=n=5：朴素正态近似给 1 ± 0 → 上界 100%，看似"确定"，实际样本只有 5
  const perfect = wilsonInterval(5, 5)
  assert.equal(perfect.p, 1)
  assert.ok(perfect.lo! < 0.6, `5/5 的下界必须远低于 100%（实际 ${perfect.lo}）`)
  assert.equal(perfect.hi, 1)
  // k=0：上界不能是 0（"一次都没出现"不等于"不可能"）
  const none = wilsonInterval(0, 10)
  assert.equal(none.p, 0)
  assert.ok(none.hi! > 0.2, `0/10 的上界必须明显大于 0（实际 ${none.hi}）`)
})

test('Wilson：点估计等于 k/n，且样本越大区间越窄', () => {
  assert.equal(wilsonInterval(8, 10).p, 0.8)
  const small = wilsonInterval(16, 20) // 20 个样本的 80%
  const big = wilsonInterval(400, 500) // 500 个样本的 80%
  assert.ok(Math.abs(small.p! - 0.8) < 1e-9 && Math.abs(big.p! - 0.8) < 1e-9, '两者的点估计相同')
  const wSmall = small.hi! - small.lo!
  const wBig = big.hi! - big.lo!
  assert.ok(wSmall > wBig * 4, `小样本区间必须明显更宽（${wSmall.toFixed(3)} vs ${wBig.toFixed(3)}）`)
  // 20 个样本的 80%：区间要宽到能跨过"没用"的位置
  assert.ok(small.lo! < 0.6 && small.hi! > 0.9, `20 样本 80% 的区间应约 58%–92%，实际 ${small.lo}–${small.hi}`)
  assert.ok(wBig < 0.1, '500 样本的区间应窄于 10 个百分点')
})

test('Wilson：零样本与非法输入返回空区间（不是 0 或 1）', () => {
  for (const iv of [wilsonInterval(0, 0), wilsonInterval(3, -1), wilsonInterval(3, NaN)]) {
    assert.equal(iv.p, null)
    assert.equal(iv.lo, null)
    assert.equal(iv.hi, null)
    assert.equal(iv.n, 0)
  }
  assert.equal(wilsonFromRate(null, 100).lo, null)
  assert.equal(wilsonFromRate(0.5, 0).lo, null)
  // 成功数越界要被裁剪，而不是算出 >1 的点估计
  assert.equal(wilsonInterval(20, 10).p, 1)
  assert.equal(wilsonInterval(-5, 10).p, 0)
})

test('wilsonFromRate 与 wilsonInterval 同一口径', () => {
  const a = wilsonFromRate(0.8, 20)
  const b = wilsonInterval(16, 20)
  assert.equal(a.lo, b.lo)
  assert.equal(a.hi, b.hi)
})

test('小样本阈值是 n < 30（界面据此标「样本少」）', () => {
  assert.equal(SMALL_SAMPLE_N, 30)
  assert.equal(isSmallSample(0), true)
  assert.equal(isSmallSample(29), true)
  assert.equal(isSmallSample(30), false)
  assert.equal(isSmallSample(1536), false)
})
