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
import { calToday, dayOf, hhmmOf, inSession, isSettledOffline, lastCloseBoundary, shanghaiDayStart, weekdayOf } from './time.ts'
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

/**
 * 收盘定稿判定（v0.22.0）：决定"休市时还要不要回源"。
 * 这一组的价值同样在"任意宿主时区下都成立"，且**不依赖真实当前时间**。
 * 参考周：2026-09-28 是周一 → 周三 = 09-30，周五 = 10-02，周六 = 10-03。
 */
const BJ = (y: number, m: number, d: number, hh: number, mm: number): number =>
  Date.UTC(y, m - 1, d, hh - 8, mm, 0)

test('inSession：北京时间 09:25–15:05 才可能产生新 bar', () => {
  assert.equal(inSession(BJ(2026, 9, 30, 10, 0)), true, '周三 10:00 盘中')
  assert.equal(inSession(BJ(2026, 9, 30, 9, 30)), true, '开盘后')
  assert.equal(inSession(BJ(2026, 9, 30, 15, 4)), true, '收盘前一分钟')
  assert.equal(inSession(BJ(2026, 9, 30, 15, 5)), false, '15:05 已定稿')
  assert.equal(inSession(BJ(2026, 9, 30, 8, 0)), false, '盘前')
  assert.equal(inSession(BJ(2026, 10, 3, 12, 0)), false, '周六')
  assert.equal(inSession(BJ(2026, 10, 4, 12, 0)), false, '周日')
})

test('lastCloseBoundary：最近一次收盘定稿时刻（跨周末回溯）', () => {
  const iso = (t: number): string => new Date(t).toISOString()
  assert.equal(iso(lastCloseBoundary(BJ(2026, 9, 30, 10, 0))), '2026-09-29T07:05:00.000Z', '周三盘中 → 周二 15:05')
  assert.equal(iso(lastCloseBoundary(BJ(2026, 9, 30, 15, 5))), '2026-09-30T07:05:00.000Z', '刚好收盘 → 当天 15:05')
  assert.equal(iso(lastCloseBoundary(BJ(2026, 9, 30, 22, 0))), '2026-09-30T07:05:00.000Z', '周三夜里 → 周三 15:05')
  assert.equal(iso(lastCloseBoundary(BJ(2026, 10, 3, 12, 0))), '2026-10-02T07:05:00.000Z', '周六 → 周五 15:05')
  assert.equal(iso(lastCloseBoundary(BJ(2026, 10, 5, 8, 0))), '2026-10-02T07:05:00.000Z', '周一早盘 → 周五 15:05')
  assert.equal(iso(lastCloseBoundary(BJ(2026, 10, 5, 16, 0))), '2026-10-05T07:05:00.000Z', '周一收盘后 → 周一 15:05')
})

test('isSettledOffline：休市 + 缓存晚于收盘 → 零回源；盘中永不成立', () => {
  const wed1000 = BJ(2026, 9, 30, 10, 0)
  const wed2000 = BJ(2026, 9, 30, 20, 0)
  const tueClose = Date.parse('2026-09-29T15:05:00+08:00')
  const wedJustClosed = Date.parse('2026-09-30T15:06:00+08:00')
  assert.equal(isSettledOffline(wedJustClosed, wed2000), true, '缓存晚于最近一次收盘 → 定稿，可零回源')
  assert.equal(isSettledOffline(tueClose + 60_000, wed2000), false, '缓存是上一个交易日收盘后的 → 必须回源')
  assert.equal(isSettledOffline(tueClose - 60_000, wed2000), false, '缓存早于最近收盘 → 必须回源')
  assert.equal(isSettledOffline(Date.now(), wed1000), false, '盘中永远不成立')
  assert.equal(isSettledOffline(0, wed2000), false, '没有缓存不成立')
  assert.equal(isSettledOffline(Number.NaN, wed2000), false, 'NaN 不成立')
})
