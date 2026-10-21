/**
 * 【竞价】四项的宿主侧判据（纯函数 + 永不抛的取数壳）。
 * 断言编号对应用户裁决：① 四项齐全/② 无今日根 ⇒ not-open/③ 占比用当日总量/④ 溢价用昨收。
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { auctionOfMinutePoints, fetchAuction } from './auction.ts'
import { parseMarketStamp } from './time.ts'
import type { TencentMinutePoint } from './tencent.ts'

const at = (label: string): number => parseMarketStamp(label) as number

const firstToday: TencentMinutePoint = { ts: at('2026-10-21 09:30'), price: 1331.88, cumVol: 516, amount: 68_000_000 }
const lastToday: TencentMinutePoint = { ts: at('2026-10-21 15:00'), price: 1340, cumVol: 33_500, amount: 4_400_000_000 }
const firstYesterday: TencentMinutePoint = { ts: at('2026-10-20 09:30'), price: 1320.5, cumVol: 800, amount: 100_000_000 }
const lastYesterday: TencentMinutePoint = { ts: at('2026-10-20 15:00'), price: 1325, cumVol: 40_000, amount: 5_000_000_000 }

test('① 有今日 m1 根 ⇒ 四项齐全（价/量/占比/溢价）', () => {
  const a = auctionOfMinutePoints([firstToday, lastToday], 1320.5, '2026-10-21')
  assert.equal(a.state, 'ok')
  assert.equal(a.price, 1331.88)
  assert.equal(a.volLots, 516)
  assert.ok(a.volSharePct !== null && Math.abs(a.volSharePct - (516 / 33_500) * 100) < 1e-9, '占比 = 竞价量 ÷ 当日总量')
  assert.ok(a.premiumPct !== null && Math.abs(a.premiumPct - (1331.88 / 1320.5 - 1) * 100) < 1e-9, '溢价 = 竞价价 ÷ 昨收 − 1')
  assert.equal(a.reason, null)
  // 反例注入：少一项（把量拿掉）⇒ 判据必须失败
  const broken = { ...a, volLots: null }
  assert.throws(() => assert.equal(broken.volLots !== null, true, '反例'), /反例/, '⚠ 反例（少一项）必须让“四项齐全”失败')
})

test('② 无今日根 ⇒ not-open（拿昨日根顶替 ⇒ 必败）', () => {
  const a = auctionOfMinutePoints([firstYesterday, lastYesterday], 1320.5, '2026-10-21')
  assert.equal(a.state, 'not-open')
  assert.equal(a.price, null)
  assert.equal(a.volLots, null)
  assert.equal(a.volSharePct, null)
  assert.equal(a.premiumPct, null)
  assert.equal(a.reason, null, '未开盘不给原因（界面只显示「—」）')
  // 反例注入：把 today 改成昨天（等于接受昨日根）⇒ 状态变成 ok、判据失败
  const wrong = auctionOfMinutePoints([firstYesterday, lastYesterday], 1320.5, '2026-10-20')
  assert.equal(wrong.state, 'ok')
  assert.throws(() => assert.equal(wrong.state, 'not-open', '反例'), /反例/, '⚠ 反例（昨日顶替）必须让 not-open 失败')
})

test('③ 占全日量比用**当日**总量（用昨日总量 ⇒ 必败）', () => {
  const a = auctionOfMinutePoints([firstToday, lastToday], 1320.5, '2026-10-21')
  const todayTotal = 516 / ((a.volSharePct as number) / 100)
  assert.equal(Math.round(todayTotal), 33_500, '必须除的是当日末根累计量')
  const wrongShare = (516 / 40_000) * 100 // 昨日总量
  assert.notEqual(Number((a.volSharePct as number).toFixed(6)), Number(wrongShare.toFixed(6)))
  assert.throws(
    () => assert.equal(Number((a.volSharePct as number).toFixed(6)), Number(wrongShare.toFixed(6)), '反例'),
    /反例/,
    '⚠ 反例（用昨日总量）必须让占比判据失败',
  )
})

test('④ 溢价用昨收（用今开 vs 今收 ⇒ 必败）', () => {
  const a = auctionOfMinutePoints([firstToday, lastToday], 1320.5, '2026-10-21')
  const expected = (1331.88 / 1320.5 - 1) * 100
  assert.ok(Math.abs((a.premiumPct as number) - expected) < 1e-9)
  const wrong = (lastToday.price as number) / 1320.5 - 1
  assert.notEqual(Number((a.premiumPct as number).toFixed(6)), Number((wrong * 100).toFixed(6)))
  assert.throws(
    () => assert.equal(Number((a.premiumPct as number).toFixed(6)), Number((wrong * 100).toFixed(6)), '反例'),
    /反例/,
    '⚠ 反例（今收当竞价价）必须让溢价判据失败',
  )
})

test('取数壳：非沪深给原因；m1 抛错 → unavailable（永不抛）', async () => {
  const hk = await fetchAuction('116.00700', 400)
  assert.equal(hk.state, 'unavailable')
  assert.match(String(hk.reason), /仅沪深提供竞价/)

  const ok = await fetchAuction('1.600519', 1320.5, { loadMinutes: async () => [firstToday, lastToday], now: () => at('2026-10-21 10:00') })
  assert.equal(ok.state, 'ok')
  assert.equal(ok.price, 1331.88)

  const failed = await fetchAuction('1.600519', 1320.5, {
    loadMinutes: async () => { throw new Error('boom') },
    now: () => at('2026-10-21 10:00'),
  })
  assert.equal(failed.state, 'unavailable')
  assert.match(String(failed.reason), /腾讯 m1 取数失败/)
})
