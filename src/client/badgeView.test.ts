/**
 * 侧栏悬停提示的断言。
 *
 * 锁的是一条**用户明确抱怨过**的规则（README「开发」节的开发原则 1/2/6）：
 * 这段文字会被拼在侧栏插件名后面，长了就被宿主截断成 `…` ——
 * 实测踩到过 `盯盘·持仓当日盈亏 +0.07%（+795.00 元…`（金额那截永远读不到）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { BADGE_DETAIL_MAX, badgeView, type BadgeInput } from './badgeView.ts'

const base: BadgeInput = {
  level: 0, levelLabel: null, indexPoint: 3963, indexName: '沪深300',
  dayPnlPct: 0.07, dayPnl: 795, asOf: Date.parse('2026-10-09T15:00:00+08:00'), settled: false,
}

test('悬停提示只留一行、且不会长到被宿主截断', () => {
  const cases: BadgeInput[] = [
    base,
    { ...base, dayPnlPct: -2.35 },
    { ...base, dayPnlPct: 0 },
    { ...base, dayPnlPct: null },
    { ...base, level: 2, levelLabel: '疑似护盘' },
    { ...base, settled: true },
  ]
  for (const c of cases) {
    const v = badgeView(c, false)
    assert.ok(v.detail.length <= BADGE_DETAIL_MAX, `「${v.detail}」超长（${v.detail.length} > ${BADGE_DETAIL_MAX}）会被截断`)
    assert.ok(!v.detail.includes('\n'), '悬停提示必须是一行')
  }
})

test('金额不进悬停提示（那截永远被截断，细节留在面板里）', () => {
  const v = badgeView({ ...base, dayPnlPct: 0.07, dayPnl: 795 }, false)
  assert.ok(!v.detail.includes('元'), `不该出现金额：${v.detail}`)
  assert.ok(!v.detail.includes('持仓'), `不该重复"持仓"这类可从上下文得知的词：${v.detail}`)
})

test('缺失与零必须分开：null 给原因、0 才是 0.00%', () => {
  assert.equal(badgeView({ ...base, dayPnlPct: null }, false).detail, '当日盈亏 —（无持仓行情）')
  assert.ok(badgeView({ ...base, dayPnlPct: 0 }, false).detail.startsWith('当日盈亏 0.00%'))
})

test('徽标文字与配色档位不变（改的只是提示文案）', () => {
  assert.equal(badgeView({ ...base, dayPnlPct: 1.23 }, false).text, '+1.2')
  assert.equal(badgeView({ ...base, dayPnlPct: -0.07 }, false).tone, 'down')
  assert.equal(badgeView({ ...base, dayPnlPct: 12.3 }, false).text, '+10+')
  assert.equal(badgeView({ ...base, level: 2, levelLabel: '疑似护盘' }, false).text, '护')
})
