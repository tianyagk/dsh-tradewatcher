/**
 * 用户把前一日的整场读成"今天横盘"。日期不能省。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cacheNoteOf, lastSuccessNote, nonSessionNote, stamp } from './chartNote.ts'

const trend = (labels: string[], extra: Record<string, unknown> = {}) => ({
  kind: 'trend' as const,
  trend: { points: labels.map((label) => ({ label })), ...extra },
})

test('E1：降级复用一律写成「上次成功数据（MM-DD HH:mm）」，三种入口同一句话', () => {
  const live = trend(['2026-10-09 09:30', '2026-10-09 14:55'])
  const fallback = cacheNoteOf({ ...live, fallback: true })
  const stale = cacheNoteOf({ ...live, trend: { ...live.trend, staleAt: 1790000000000 } })
  assert.equal(fallback, ' · 上次成功数据（10-09 14:55）')
  assert.equal(stale, fallback, '刷新失败与 LKG 兜底必须同一句话（此前是两种说法）')
  assert.ok(!fallback.includes('本次刷新失败'), '「本次刷新失败」这种说法已删除')
})

test('E1：K 线兜底也必须带日期（事故源：没日期就被读成今天）', () => {
  const kline = {
    kind: 'kline' as const,
    kline: { bars: [{ t: Date.parse('2026-10-08T15:00:00+08:00') }] },
    fallback: true,
  }
  const note = cacheNoteOf(kline)
  assert.match(note, /上次成功数据（10-08 \d\d:\d\d）/, `K 线兜底要带日期：${note}`)
  // 日线档只有日期（没有时间）⇒ 只给到天，不编时间
  const daily = cacheNoteOf({ kind: 'kline', kline: { days: [{ date: '2026-10-08' }] }, fallback: true })
  assert.equal(daily, ' · 上次成功数据（10-08）')
})

test('E1：日期不可知时退到短形（仍能与"新鲜数据"区分）', () => {
  assert.equal(lastSuccessNote({ kind: 'trend', trend: { points: [] } }), ' · 上次成功数据')
  assert.equal(lastSuccessNote({ kind: 'kline', kline: { bars: [] } }), ' · 上次成功数据')
})

test('P1-2：不是今天的数据必须写出来（节假日上游回节前那天的分时）', () => {
  const expired = cacheNoteOf({ kind: 'trend', trend: { points: [{ label: '2026-10-01 09:30' }], sessionDay: '2026-10-01' } })
  assert.equal(expired, ' · 非当日数据（10-01）')
  assert.equal(nonSessionNote('2026-10-01'), ' · 非当日数据（10-01）')
  // 是今天 ⇒ 什么都不写
  assert.equal(cacheNoteOf({ kind: 'trend', trend: { points: [{ label: '2026-10-09 10:00' }] } }), '')
})

test('其它两种口径各自独立：定稿缓存 / 本地缓存不写成"上次成功数据"', () => {
  assert.equal(cacheNoteOf({ kind: 'trend', trend: { points: [], cached: true } }), ' · 休市定稿缓存（未回源）')
  assert.equal(cacheNoteOf({ kind: 'kline', kline: { bars: [{ t: 1 }] }, fromCache: true }), ' · 本地缓存')
  assert.equal(cacheNoteOf({ kind: 'unavailable' }), '', '拿不到数据时不给缓存口径')
  assert.equal(cacheNoteOf(null), '')
})

test('stamp：脚注时间一律 MM-DD HH:mm（补零，不用 toLocaleString 的默认输出）', () => {
  // 用**本地时间**构造：断言与宿主时区无关（双时区跑两遍都成立）
  assert.equal(stamp(new Date(2026, 9, 9, 9, 5).getTime()), '10-09 09:05')
})

test('D4：宿主自标降级的 K 线也必须走同一句（不许再出现「缓存数据（上游暂不可用）」）', () => {
  const note = cacheNoteOf({ kind: 'kline', kline: { stale: true, days: [{ date: '2026-10-08' }] } })
  assert.equal(note, ' · 上次成功数据（10-08）')
  assert.ok(!note.includes('上游暂不可用'), '旧说法已删除')
})
