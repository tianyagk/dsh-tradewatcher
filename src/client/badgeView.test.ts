/**
 * 侧栏悬停提示的断言。
 *
 * 锁的是一条**用户明确抱怨过**的规则（README「开发」节的开发原则 1/2/6）：
 * 这段文字会被拼在侧栏插件名后面，长了就被宿主截断成 `…` ——
 * 实测踩到过 `盯盘·持仓当日盈亏 +0.07%（+795.00 元…`（金额那截永远读不到）。
 */
import { test } from 'node:test'
import { createRequire } from 'node:module'
import assert from 'node:assert/strict'
import { BADGE_DETAIL_MAX, badgeView, type BadgeInput } from './badgeView.ts'
const require = createRequire(import.meta.url)

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
  assert.ok(badgeView({ ...base, dayPnlPct: 0 }, false).detail.startsWith('当日盈亏 0.0%'))  // task-80：舍入统一到一位小数
})

test('徽标文字与配色档位不变（改的只是提示文案）', () => {
  assert.equal(badgeView({ ...base, dayPnlPct: 1.23 }, false).text, '+1.2%')
  assert.equal(badgeView({ ...base, dayPnlPct: -0.07 }, false).tone, 'down')
  assert.equal(badgeView({ ...base, dayPnlPct: 12.3 }, false).text, '+10+%')  // ≥10% 仍用 10+ 省略，但补 % 以标明量纲
  assert.equal(badgeView({ ...base, level: 2, levelLabel: '疑似护盘' }, false).text, '护')
})

/** task-80：一个事实只留一处 —— 标签不再重复当日盈亏；徽标与 tooltip 同口径同舍入 */
test('task-80：标签文案不许出现当日盈亏（也不许出现等价的盈亏数值写法），只留数据时刻', () => {
  // ⚠ 断言必须锚在**真实接线**上：读 index.tsx 里真正的 label 表达式，而不是自己拼一个
  const { readFileSync } = require('node:fs') as { readFileSync: (p: string) => string }
  const { fileURLToPath } = require('node:url') as { fileURLToPath: (u: string) => string }
  const { dirname, join } = require('node:path') as { dirname: (p: string) => string; join: (...p: string[]) => string }
  const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), './index.tsx'))
  // 用**子串**核对（别跟正则转义较劲）：真实接线必须是 stamp，不能是 detail
  assert.ok(src.includes("label: () => (badgeState.stamp"), '真实接线必须是 stamp（标签只留数据时刻）')
  assert.equal(src.includes("label: () => (badgeState.detail"), false, '标签不许再接 detail（那会把当日盈亏又带回标签）')
  const label = (s: { stamp: string }): string => `盯盘 · ${s.stamp}`
  const v = badgeView({ level: 0, levelLabel: null, indexPoint: 3000, indexName: '上证指数', dayPnlPct: -2.29, dayPnl: -2290, asOf: Date.parse('2026-10-12T09:42:52+08:00'), settled: false }, false)
  const text = label(v)
  assert.equal(/当日盈亏/.test(text), false, '标签里不许出现「当日盈亏」')
  assert.equal(/[+-]\d+(\.\d+)?\s*%/.test(text), false, '标签里不许出现等价的盈亏百分比（那是徽标的活）')
  assert.equal(/[+-]?\d+\.\d\b/.test(text), false, '标签里不许出现盈亏数值')
  const hhmmss = new Date(Date.parse('2026-10-12T09:42:52+08:00')).toLocaleTimeString('zh-CN', { hour12: false })
  assert.equal(text, `盯盘 · 数据 ${hhmmss}`, `标签只留数据时刻（实际 ${text}）`)
  assert.match(text, /^盯盘 · 数据 \d{2}:\d{2}:\d{2}$/, '标签形状：盯盘 · 数据 HH:mm:ss（由宿主 formatter 推导，避免时区耦合）')
  // 徽标保留（紧凑、带色那一处）
  assert.equal(v.text, '-2.3%', '徽标直接给百分比，便于比较')
  assert.equal(v.tone, 'down', '徽标仍带色（下跌）')
})

test('task-80：徽标与 tooltip 同口径同舍入（同一输入）', () => {
  const cases: Array<[number, string]> = [[-2.29, '-2.3%'], [2.349, '+2.3%'], [0, '0.0%'], [12.5, '+10+%']]
  for (const [pct, expect] of cases) {
    const v = badgeView({ level: 0, levelLabel: null, indexPoint: null, indexName: null, dayPnlPct: pct, dayPnl: 0, asOf: null, settled: false }, false)
    assert.equal(v.text, expect, `徽标（输入 ${pct}）`)
    // tooltip 里的百分比必须与徽标**同一个舍入结果**（去掉尾部的 · 数据 … 部分后逐字比对）
    const inDetail = /当日盈亏 ([+-]?[\d.]+\+?%)/.exec(v.detail)?.[1] ?? ''
    assert.equal(inDetail, v.text, `tooltip 里的百分比必须与徽标一致（detail=${v.detail}）`)
  }
  // 「不可算」时徽标为空、tooltip 给原因（不是 0）
  const none = badgeView({ level: 0, levelLabel: null, indexPoint: null, indexName: null, dayPnlPct: null, dayPnl: 0, asOf: null, settled: false }, false)
  assert.equal(none.text, '')
  assert.ok(none.detail.includes('当日盈亏 —'), none.detail)
})
