/**
 * 时区回归测试（P0）。
 *
 * 这组断言的价值全在"**在任意宿主时区下都成立**"：护盘模块的采样时段、
 * 阶段语义、时点系数全部基于墙上时钟，若用宿主本地时间，Docker/云主机/CI
 * 的默认 TZ=UTC 会把真实盘中判成"盘前"→ 采样一次都不触发。
 *
 * `npm test` 会把这套测试跑两遍（宿主 TZ 与 TZ=UTC），只有显式切 TZ 才锁得住
 * —— 否则在任何一台 UTC+8 机器上都是绿的。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { calToday, dayOf, hhmmOf, shanghaiDayStart, weekdayOf } from './time.ts'
import { inTradingWindow, sessionElapsed, timeCoefficient, phaseOf } from './rescue.ts'

/** 北京时间 2026-09-28（周一）10:00 = UTC 02:00 */
const BJ_MON_1000 = Date.UTC(2026, 8, 28, 2, 0, 0)
/** 北京时间 2026-09-28（周一）14:40 = UTC 06:40（尾盘） */
const BJ_MON_1440 = Date.UTC(2026, 8, 28, 6, 40, 0)
/** 北京时间 2026-09-28（周一）18:00 = UTC 10:00（收盘后） */
const BJ_MON_1800 = Date.UTC(2026, 8, 28, 10, 0, 0)
/** 北京时间 2026-09-27（周日）10:00 */
const BJ_SUN_1000 = Date.UTC(2026, 8, 27, 2, 0, 0)

test('hhmm/day/weekday 一律按北京时间，与宿主 TZ 无关', () => {
  assert.equal(hhmmOf(BJ_MON_1000), '10:00')
  assert.equal(dayOf(BJ_MON_1000), '2026-09-28')
  assert.equal(weekdayOf(BJ_MON_1000), 1, '北京时间周一 → 星期 1')
  assert.equal(weekdayOf(BJ_SUN_1000), 0, '北京时间周日 → 星期 0')
  assert.equal(hhmmOf(BJ_MON_1800), '18:00')
  // 跨零点：北京 00:30（= 前一日 UTC 16:30）日期必须已经翻到北京的新一天
  const crossMidnight = Date.UTC(2026, 8, 28, 16, 30, 0)
  assert.equal(hhmmOf(crossMidnight), '00:30')
  assert.equal(dayOf(crossMidnight), '2026-09-29')
})

test('交易时段判定：北京时间盘中必须为 true（UTC 宿主下也一样）', () => {
  assert.equal(inTradingWindow(BJ_MON_1000), true, '北京周一 10:00 是盘中')
  assert.equal(inTradingWindow(BJ_MON_1440), true, '北京周一 14:40 是尾盘时段')
  assert.equal(inTradingWindow(BJ_MON_1800), false, '北京周一 18:00 已收盘')
  assert.equal(inTradingWindow(BJ_SUN_1000), false, '周日休市')
})

test('阶段语义与时点系数不错位', () => {
  assert.equal(phaseOf(hhmmOf(BJ_MON_1000)), 'am')
  assert.equal(timeCoefficient(sessionElapsed(hhmmOf(BJ_MON_1000))), 0.4, '早盘系数 0.4')
  assert.equal(phaseOf(hhmmOf(BJ_MON_1440)), 'tail')
  assert.equal(timeCoefficient(sessionElapsed(hhmmOf(BJ_MON_1440))), 1.1, '尾盘系数 1.1')
  assert.equal(phaseOf(hhmmOf(BJ_MON_1800)), 'closed', '收盘后不得再判为早盘')
})

test('shanghaiDayStart 与 calToday 同一口径', () => {
  const start = shanghaiDayStart(BJ_MON_1000)
  assert.equal(new Date(start).toISOString(), '2026-09-27T16:00:00.000Z', '北京 09-28 00:00 = UTC 09-27 16:00')
  assert.equal(calToday(0).length, 10)
  assert.equal(calToday(1) > calToday(0), true, '偏移一天递增')
})
