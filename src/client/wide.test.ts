/**
 * 宽窄判定的断言。
 *
 * 这组断言锁的是一条**用户体验**约定：任何宽度下都必须**恰好一个**排序入口。
 * 此前靠 CSS 隐藏其中一个，实测出现过两个同时可见；现在由判定决定挂哪个，
 * 因此这里的边界值就是"会不会同时出现两个"的边界。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { WIDE_MIN_PX, WIDE_MEDIA_QUERY, isWideWidth, layoutModeOf } from './wide.ts'

test('断点边界：1079 窄 / 1080 宽（差 1px 也不许两边都算）', () => {
  assert.equal(isWideWidth(WIDE_MIN_PX - 1), false)
  assert.equal(isWideWidth(WIDE_MIN_PX), true)
  assert.equal(layoutModeOf(WIDE_MIN_PX - 1), 'narrow')
  assert.equal(layoutModeOf(WIDE_MIN_PX), 'wide')
})

test('判定不出宽度时按窄处理（保守方向：保留始终可用的段控）', () => {
  assert.equal(isWideWidth(null), false)
  assert.equal(isWideWidth(undefined), false)
  assert.equal(isWideWidth(NaN), false)
  assert.equal(isWideWidth(Infinity), false, 'Infinity 不是"很宽"，是坏值')
  assert.equal(layoutModeOf(null), 'narrow')
})

test('媒体查询与断点同源（不许两处各写一个数字）', () => {
  assert.ok(WIDE_MEDIA_QUERY.includes(String(WIDE_MIN_PX)))
  assert.equal(WIDE_MEDIA_QUERY, `(min-width:${WIDE_MIN_PX}px)`)
})
