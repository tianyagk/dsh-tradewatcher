/**
 * 这组断言锁的是一条**用户体验**约定：任何宽度下都必须**恰好一个**排序入口。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { pickSortEntry, WIDE_MIN_PX, WIDE_MEDIA_QUERY, isWideWidth, layoutModeOf } from './wide.ts'

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

test('P1-4：排序入口恰有一个 —— 宽屏列头不可见时退回段控（样式表缺失也不会没有入口）', () => {
  assert.equal(pickSortEntry({ wide: false, headerVisible: null }), 'bar', '窄屏用段控')
  assert.equal(pickSortEntry({ wide: true, headerVisible: true }), 'header', '宽屏且列头真的可见 ⇒ 用列头')
  assert.equal(pickSortEntry({ wide: true, headerVisible: false }), 'bar', '宽屏但列头被样式藏住 ⇒ 必须有段控兜底')
  assert.equal(pickSortEntry({ wide: true, headerVisible: null }), 'bar', '量不到列头 ⇒ 用始终可用的段控')
})
