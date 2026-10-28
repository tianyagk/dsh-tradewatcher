/**
 * 日K「今日柱」缺失（v0.180.0）：① 盘中回包最后一日=今日 ② 09:20 的缓存盘中必须失效
 * ③ 收盘后今日 OHLC 与收盘价一致 ④ 前复权下今日与前一日连续。每条配反例注入（必败）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { klineTtlOf, liveDayBarOf, shouldAppendLiveBar } from './em.ts'
import { isSettledOffline } from './time.ts'

const T = (local: string): number => Date.parse(local)
const OPEN_1009 = T('2026-10-28T10:09:00+08:00')
const PREOPEN_0920 = T('2026-10-28T09:20:00+08:00')
const CLOSE_1505 = T('2026-10-28T15:05:00+08:00')
const QUOTE = { open: 1354.98, high: 1354.98, low: 1323.11, price: 1324.77, vol: 22012, amount: 2_951_090_000 }

test('① 盘中（10:09）序列止于昨日 ⇒ 必须补出今日柱（回包止于昨日 ⇒ 败）', () => {
  assert.equal(shouldAppendLiveBar('2026-10-27', OPEN_1009), true, '盘中且序列止于昨日 ⇒ 必须补')
  const bar = liveDayBarOf(QUOTE, OPEN_1009)
  assert.ok(bar !== null)
  assert.equal(bar.date, '2026-10-28', '补出来的柱必须是今天')
  const days = [{ date: '2026-10-27' }, bar]
  assert.equal(days[days.length - 1].date, '2026-10-28', '回包最后一日必须是今日')
  // 已经含今日 ⇒ 不许重复补
  assert.equal(shouldAppendLiveBar('2026-10-28', OPEN_1009), false, '已有今日柱 ⇒ 不补（否则同一天两根）')
  // 反例注入：不补 ⇒ 最后一日停在昨天
  const without = [{ date: '2026-10-27' }]
  assert.throws(() => assert.equal(without[without.length - 1].date, '2026-10-28', '反例上：止于昨日'), /反例上/, '⚠ 反例注入（不补今日柱）必须失败')
})

test('② 09:20 写入的缓存，盘中 10:09 必须重新请求（命中旧缓存 ⇒ 败）', () => {
  // 旧实现：全量 TTL 1 小时 ⇒ 09:20 的序列能活到 10:20
  assert.equal(klineTtlOf({ needFull: false, inSession: true }), 5 * 60_000, '盘中 TTL 必须是 5 分钟')
  assert.ok(klineTtlOf({ needFull: false, inSession: true }) < 3_600_000, '盘中不许再用 1 小时 TTL')
  assert.ok(klineTtlOf({ needFull: true, inSession: true }) <= 5 * 60_000, '全量取数盘中同样 5 分钟')
  assert.equal(klineTtlOf({ needFull: true, inSession: false }), 3_600_000, '收盘后全量仍可 1 小时')
  // 磁盘侧：09:20 的缓存不算"定稿"（交易时段内一律不算）
  assert.equal(isSettledOffline(PREOPEN_0920, OPEN_1009), false, '盘中不许把 09:20 的缓存当收盘定稿')
  // 反例注入：按旧的 1 小时 TTL 算 ⇒ 10:09 时 09:20 的条目仍未过期（正是缺陷）
  const oldTtl = 3_600_000
  assert.equal(PREOPEN_0920 + oldTtl > OPEN_1009, true, '旧 TTL 下 09:20 的缓存 10:09 还没过期（证明判据能抓住缺陷）')
  assert.throws(() => assert.ok(oldTtl <= 5 * 60_000, '反例上：1 小时 TTL'), /反例上/, '⚠ 反例注入（1h TTL）必须失败')
})

test('③ 收盘后 15:05：今日 bar 的 OHLC 与收盘价一致（不一致 ⇒ 败）', () => {
  const bar = liveDayBarOf(QUOTE, CLOSE_1505)
  assert.ok(bar !== null)
  assert.equal(bar.date, '2026-10-28')
  assert.equal(bar.close, QUOTE.price, '收盘价必须等于快照现价')
  assert.equal(bar.open, QUOTE.open)
  assert.ok(bar.high >= Math.max(bar.open, bar.close), '最高价必须 ≥ 开/收')
  assert.ok(bar.low <= Math.min(bar.open, bar.close), '最低价必须 ≤ 开/收')
  assert.ok(bar.vol !== null && bar.vol > 0)
  // 反例注入：把 open 当 close ⇒ 必败
  const wrong = { ...bar, close: QUOTE.open }
  assert.throws(() => assert.equal(wrong.close, QUOTE.price, '反例上：OHLC 与收盘价不一致'), /反例上/, '⚠ 反例注入（close 写成 open）必须失败')
})

test('④ 前复权口径：今日与前一日价格连续（跳空 >5% 且无除权 ⇒ 败）', () => {
  const prevClose = 1355.9
  const bar = liveDayBarOf(QUOTE, OPEN_1009)!
  const gap = Math.abs(bar.close / prevClose - 1) * 100
  assert.ok(gap <= 5, `今日与前收必须连续（实际跳空 ${gap.toFixed(2)}%）`)
  // 反例注入：把前复权因子再乘一次（等价于"对今日柱又做了一遍复权"）⇒ 跳空被放大到 >5%
  const doubleAdjusted = { ...bar, close: bar.close * 0.94 }
  const badGap = Math.abs(doubleAdjusted.close / prevClose - 1) * 100
  assert.ok(badGap > 5, `反例：重复复权后跳空 ${badGap.toFixed(2)}%（证明判据非空）`)
  assert.throws(() => assert.ok(badGap <= 5, '反例上：重复复权'), /反例上/, '⚠ 反例注入（重复复权）必须失败')
})

test('⑤ 快照缺价 ⇒ 不造柱（不编数字）', () => {
  assert.equal(liveDayBarOf({ open: null, high: 1, low: 1, price: 1, vol: 1 }, OPEN_1009), null)
  assert.equal(liveDayBarOf({ open: 1, high: null, low: 1, price: 1, vol: 1 }, OPEN_1009), null)
  assert.equal(liveDayBarOf(undefined, OPEN_1009), null)
  // 非交易日/09:15 前不补
  assert.equal(shouldAppendLiveBar('2026-10-25', T('2026-10-25T10:00:00+08:00')), false, '周六不补')
  assert.equal(shouldAppendLiveBar('2026-10-27', T('2026-10-28T09:10:00+08:00')), false, '09:15 前不补')
})
