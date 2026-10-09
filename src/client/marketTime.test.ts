/**
 * 与宿主侧 `host/time.test.ts` 同一个思路：**在任意宿主时区下都必须成立**。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cnSessionState, shanghaiClock } from './marketTime.ts'

/** 北京时间 2026-09-28（周一） */
const BJ = (hhmm: string, day = '2026-09-28'): number => Date.parse(`${day}T${hhmm}:00+08:00`)

test('shanghaiClock 一律按北京时间，与宿主时区无关', () => {
  assert.equal(shanghaiClock(BJ('10:00')).hhmm, '10:00')
  assert.equal(shanghaiClock(BJ('10:00')).weekday, 1, '北京周一 → 1')
  assert.equal(shanghaiClock(BJ('10:00', '2026-09-27')).weekday, 0, '北京周日 → 0')
  // 跨零点：北京 00:30 不能被算成前一天
  assert.equal(shanghaiClock(Date.UTC(2026, 8, 28, 16, 30)).hhmm, '00:30')
})

test('盘中/午休/收盘后/周末四态与 inSession 口径一致', () => {
  assert.equal(cnSessionState(BJ('10:00')).phase, 'am')
  assert.equal(cnSessionState(BJ('10:00')).inSession, true)
  assert.equal(cnSessionState(BJ('10:00')).settled, false, '盘中永远不是定稿')

  assert.equal(cnSessionState(BJ('12:00')).phase, 'noon')
  assert.equal(cnSessionState(BJ('12:00')).inSession, false)
  assert.equal(cnSessionState(BJ('12:00')).settled, false, '午休只是暂停，不是定稿')

  assert.equal(cnSessionState(BJ('14:30')).phase, 'pm')
  assert.equal(cnSessionState(BJ('15:00')).inSession, true, '15:00 仍在 session 内（收盘 15:05）')
  assert.equal(cnSessionState(BJ('15:00')).settled, false)

  assert.equal(cnSessionState(BJ('15:06')).phase, 'closed')
  assert.equal(cnSessionState(BJ('15:06')).settled, true, '15:05 之后才定稿')

  assert.equal(cnSessionState(BJ('10:00', '2026-10-03')).phase, 'weekend')
  assert.equal(cnSessionState(BJ('10:00', '2026-10-03')).settled, true, '周末一律定稿')
})

test('开盘前也算定稿（当天还没有新数据），但阶段标签不同', () => {
  const pre = cnSessionState(BJ('08:30'))
  assert.equal(pre.phase, 'pre')
  assert.equal(pre.inSession, false)
  assert.equal(pre.settled, true, '开盘前显示的是上一交易日的定稿数据')
})

test('边界：09:24 未开盘 / 09:25 已开盘', () => {
  assert.equal(cnSessionState(BJ('09:24')).inSession, false)
  assert.equal(cnSessionState(BJ('09:25')).inSession, true)
  assert.equal(cnSessionState(BJ('11:29')).phase, 'am')
  assert.equal(cnSessionState(BJ('11:30')).phase, 'noon')
  assert.equal(cnSessionState(BJ('12:59')).phase, 'noon')
  assert.equal(cnSessionState(BJ('13:00')).phase, 'pm')
  assert.equal(cnSessionState(BJ('15:05')).inSession, true)
  assert.equal(cnSessionState(BJ('15:05')).settled, false)
})
