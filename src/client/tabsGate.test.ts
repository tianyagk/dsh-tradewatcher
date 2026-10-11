/**
 * tab 行门控 + 幂等/兼容的断言（task-52 验收）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { gateTabs, type TabLike } from './tabsGate.ts'

const TABS: Array<TabLike<'watch' | 'portfolio' | 'calendar'>> = [
  { key: 'watch', label: '自选', full: '自选', row: 'watchlist' },
  { key: 'portfolio', label: '持仓', full: '持仓', row: 'portfolio' },
  { key: 'calendar', label: '日历', full: '日历', row: 'calendar' },
]

test('端点不可达（rows=null）⇒ 失败放行：全部 tab 照常渲染', () => {
  const g = gateTabs(TABS, null, 'watch')
  assert.equal(g.visible.length, 3, '失败放行必须全开（网络抖动不该让界面消失）')
  assert.equal(g.hideBar, false)
  assert.equal(g.fallback, null, '全部可用 ⇒ 不需要回落')
})

test('关掉 calendar ⇒ 只有日历 tab 消失，其余不受影响', () => {
  const g = gateTabs(TABS, new Set(['core', 'watchlist', 'portfolio']), 'watch')
  assert.deepEqual(g.visible.map((t) => t.key), ['watch', 'portfolio'])
  assert.equal(g.hideBar, false)
  assert.equal(g.fallback, null, '当前页仍可用 ⇒ 不回落')
})

test('当前页被停用 ⇒ 回落到首个可用 tab', () => {
  const g = gateTabs(TABS, new Set(['core', 'watchlist']), 'calendar')
  assert.deepEqual(g.visible.map((t) => t.key), ['watch'])
  assert.equal(g.fallback, 'watch')
})

test('tab 全被关掉 ⇒ hideBar（不渲染空壳）且回落为 null', () => {
  const g = gateTabs(TABS, new Set(['core']), 'watch')
  assert.equal(g.visible.length, 0)
  assert.equal(g.hideBar, true, '全关 ⇒ 不渲染 tab 条')
  assert.equal(g.fallback, null, '没有可用 tab ⇒ 不回落（调用方渲染空态）')
})

test('向后兼容：只有 core（老 profile 的等价形态）⇒ 与"无行数据"同款行为', () => {
  // core 行不含任何 tab 的归属行 ⇒ 老 profile 里这不会发生（row 缺省 = core，其余行也都在）
  const g = gateTabs(TABS, new Set(['core', 'watchlist', 'portfolio', 'calendar', 'market', 'cloudmap']), 'watch')
  assert.equal(g.visible.length, 3, '全部行都在 ⇒ 与今天一致')
})
