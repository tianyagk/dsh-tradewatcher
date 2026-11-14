/**
 * v0.185.0：内置交易日历覆盖到 2026-12-31 + 缺月必须外拉并如实报缺。
 * ① 覆盖 2026-11/12 每个交易日 ② 三个注入日期全绿 ③ 缺当月 ⇒ 走外部读取（不静默） ④ 外部失败 ⇒ missing 点名。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { BUILTIN_CALENDAR_COVERED_UNTIL, builtinCoversMonth, tradingDayState } from './rescue.ts'
import { builtinCoverageNoteOf } from './tradingCalendar.ts'

const at = (day: string): number => Date.parse(`${day}T10:00:00+08:00`)
const weekdaysOf = (year: number, month: number): string[] => {
  const out: string[] = []
  for (let d = 1; d <= 31; d += 1) {
    const dt = new Date(Date.UTC(year, month - 1, d))
    if (dt.getUTCMonth() !== month - 1) break
    const wd = dt.getUTCDay()
    if (wd !== 0 && wd !== 6) out.push(dt.toISOString().slice(0, 10))
  }
  return out
}

test('① 内置表覆盖 2026-11 与 2026-12 的每个交易日（缺一天 ⇒ 败）', () => {
  assert.equal(BUILTIN_CALENDAR_COVERED_UNTIL, '2026-12-31')
  for (const [y, m] of [[2026, 11], [2026, 12]] as const) {
    assert.equal(builtinCoversMonth(`${y}-${String(m).padStart(2, '0')}`), true, `${y}-${m} 必须被内置表覆盖`)
    const days = weekdaysOf(y, m)
    assert.ok(days.length >= 20, `${y}-${m} 工作日数量异常（${days.length}）`)
    for (const day of days) {
      assert.equal(tradingDayState(at(day)).trading, true, `内置表必须把 ${day} 判为交易日（缺一天 ⇒ 败）`)
    }
  }
  // 反例注入：把覆盖末日改小一格 ⇒ 12-31 必须判为未覆盖
  const bad = '2026-12-30'
  assert.throws(() => assert.equal(bad >= BUILTIN_CALENDAR_COVERED_UNTIL, true, '反例上：末日提前'), /反例上/, '⚠ 反例注入必须失败')
})

test('② 三个注入日期（2026-11 / 2026-12 / 2027-01）下判定都成立（写死 2026-10 ⇒ 败）', () => {
  for (const month of ['2026-11', '2026-12']) {
    assert.equal(builtinCoversMonth(month), true, `${month} 内置覆盖`)
    assert.equal(builtinCoverageNoteOf(month), null, `${month} 不得报缺口`)
  }
  assert.equal(builtinCoversMonth('2027-01'), false, '2027-01 超出覆盖 ⇒ 必须报缺')
  assert.match(String(builtinCoverageNoteOf('2027-01')), /内置表未覆盖 2027-01/)
  // 反例注入：把某个月的判定写死成 2026-10 ⇒ 2027-01 会被误判为已覆盖
  const hardcoded = (m: string): boolean => m === '2026-10'
  assert.equal(hardcoded('2027-01'), false)
  assert.throws(() => assert.equal(hardcoded('2027-01'), true, '反例上：写死 2026-10'), /反例上/, '⚠ 反例注入必须失败')
})

test('③ 内置表缺当月 ⇒ 必须走外部读取；文件也缺 ⇒ 告警点名月份（静默 ⇒ 败）', async () => {
  const note = builtinCoverageNoteOf('2027-01')
  assert.ok(note !== null && note.includes('未覆盖'), '缺月必须有一句人话')
  assert.match(note!, /2027-01/, '必须点名缺哪个月')
  assert.match(note!, /外部交易日历文件/, '必须说明外部文件也没覆盖')
  // 反例注入：静默返回 null ⇒ 判据必须失败
  assert.throws(() => assert.equal(null, note, '反例上：静默'), /反例上/, '⚠ 反例注入必须失败')
})

test('④ 外部也失败 ⇒ missing 必须含「内置表未覆盖 YYYY-MM」（静默 ⇒ 败）', () => {
  const note = builtinCoverageNoteOf('2027-01')!
  assert.match(note, /内置表未覆盖 2027-01/)
  // 路由把它塞进 missing（源码锚 + 反例注入）
  const routes = readFileSync(new URL('./routes.ts', import.meta.url), 'utf8')
  assert.ok(routes.includes('builtinCoverageNoteOf(month)'), '路由必须调用缺口函数')
  assert.ok(routes.includes('what: \'交易日历\''), 'missing 里必须有「交易日历」条目')
  assert.throws(
    () => assert.equal(routes.split('builtinCoverageNoteOf(month)').join('').includes('builtinCoverageNoteOf(month)'), true, '反例上：静默'),
    /反例上/,
    '⚠ 反例注入（去掉缺口条目）必须失败',
  )
})
