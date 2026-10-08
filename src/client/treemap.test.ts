/**
 * treemap 布局的断言（P2-5）。
 *
 * 布局是"画出来才发现不对"的典型：面积不成比例时图看着仍然像样，但读者据此比较
 * 板块大小就会得出错误结论（成交额差 10 倍的板块看起来一样大）。
 * 因此这里断言的是**几何不变量**，而不是快照。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { squarify } from './treemap.ts'

const W = 600
const H = 400
const area = (r: { w: number; h: number }): number => r.w * r.h
const overlap = (a: { x: number; y: number; w: number; h: number }, b: { x: number; y: number; w: number; h: number }): boolean =>
  a.x < b.x + b.w - 1e-6 && b.x < a.x + a.w - 1e-6 && a.y < b.y + b.h - 1e-6 && b.y < a.y + a.h - 1e-6

test('面积与数值成正比（这才是热力图能被比较的前提）', () => {
  const values = [100, 50, 25, 25]
  const rects = squarify(values, W, H)
  assert.equal(rects.length, values.length)
  const total = values.reduce((a, b) => a + b, 0)
  values.forEach((v, i) => {
    const expected = (v / total) * W * H
    assert.ok(Math.abs(area(rects[i]) - expected) < 1e-6, `第 ${i} 块面积应为 ${expected}，实际 ${area(rects[i])}`)
  })
  // 最大的一块必须真的更大（防止"看起来一样大"）
  assert.ok(area(rects[0]) > area(rects[1]) * 1.9)
})

test('不越界、不重叠（画到画布外的块会被截断成假面积）', () => {
  const values = [220, 180, 140, 120, 90, 70, 60, 50, 40, 30]
  const rects = squarify(values, W, H)
  for (const r of rects) {
    assert.ok(r.x >= -1e-6 && r.y >= -1e-6, `越界：${JSON.stringify(r)}`)
    assert.ok(r.x + r.w <= W + 1e-6 && r.y + r.h <= H + 1e-6, `越界：${JSON.stringify(r)}`)
  }
  for (let i = 0; i < rects.length; i += 1) {
    for (let j = i + 1; j < rects.length; j += 1) {
      assert.ok(!overlap(rects[i], rects[j]), `第 ${i} 与第 ${j} 块重叠`)
    }
  }
  const sum = rects.reduce((a, r) => a + area(r), 0)
  assert.ok(Math.abs(sum - W * H) < 1e-3, `总面积应铺满画布：${sum} vs ${W * H}`)
})

test('长宽比不会退化成细长条（squarified 的意义）', () => {
  // 一个极大的值 + 一堆小值：朴素"从大到小切条"会切出针一样的细条
  const values = [1000, 20, 20, 20, 20, 20, 20, 20]
  const rects = squarify(values, W, H)
  const ratios = rects.map((r) => Math.max(r.w / r.h, r.h / r.w))
  // 大块应当接近方形；小块至少不比"整幅画布的长宽比"更糟
  assert.ok(Math.max(ratios[0], 1 / ratios[0]) < 3, `最大块长宽比应接近 1，实际 ${ratios[0]}`)
  const worst = Math.max(...ratios)
  assert.ok(worst < 12, `最差长宽比不应超过 12，实际 ${worst}`)
})

test('退化输入不产生 NaN 矩形', () => {
  assert.deepEqual(squarify([], W, H), [])
  assert.deepEqual(squarify([0, 0], W, H), [])
  assert.deepEqual(squarify([1, 2], 0, H), [])
  const withZero = squarify([10, 0, 5], W, H)
  assert.equal(withZero.length, 3)
  for (const r of withZero) {
    assert.ok(Number.isFinite(r.x) && Number.isFinite(r.y) && Number.isFinite(r.w) && Number.isFinite(r.h), `出现 NaN：${JSON.stringify(r)}`)
  }
  assert.equal(area(withZero[1]), 0, '值为 0 的块面积为 0（调用方应先过滤，而不是让它占位）')
})
