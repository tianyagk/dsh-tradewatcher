/**
 * 这是**新的持久化**，长期运行 + 逐日累积，因此必须锁住三件事：
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { TrendPoint } from '../shared/model.ts'
import { archiveTrendDays, decodeTrendDay, encodeTrendDay, loadTrendArchive, trendArchiveDir } from './trendArchive.ts'

function freshHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'tw-archive-'))
  process.env.DSH_HOME = home
  return home
}

const pts = (n: number, price = 10): TrendPoint[] =>
  Array.from({ length: n }, (_, i) => ({ t: 1_790_000_000_000 + i * 60_000, label: `2026-10-09 09:${String(i).padStart(2, '0')}`, price: price + i, avg: null, vol: null, amount: null }))

test('归档往返：写入 → 读出，label/价格/缺失字段都能还原', async () => {
  freshHome()
  const r = await archiveTrendDays('122.XAU', [{ day: '2026-10-09', points: pts(3) }])
  assert.deepEqual(r.saved, ['2026-10-09'])
  assert.deepEqual(r.skipped, [])
  const load = await loadTrendArchive('122.XAU')
  assert.equal(load.unreadable.length, 0)
  assert.equal(load.days.length, 1)
  assert.equal(load.days[0].day, '2026-10-09')
  assert.equal(load.days[0].points.length, 3)
  assert.equal(load.days[0].points[0].label, '2026-10-09 09:00', 'label 必须能还原（拼接与日分隔都靠它）')
  assert.equal(load.days[0].points[0].price, 10)
  assert.equal(load.days[0].points[0].avg, null, '缺失字段不许被写成 0')
})

test('幂等：同一天写两次只留一份，且是后写的那份（覆盖，不追加）', async () => {
  freshHome()
  await archiveTrendDays('1.600519', [{ day: '2026-10-09', points: pts(2, 10) }])
  await archiveTrendDays('1.600519', [{ day: '2026-10-09', points: pts(5, 20) }])
  const load = await loadTrendArchive('1.600519')
  assert.equal(load.days.length, 1, '一天一个文件')
  assert.equal(load.days[0].points.length, 5, '后到的更完整 ⇒ 生效的是它')
  assert.equal(load.days[0].points[0].price, 20)
  const dir = trendArchiveDir('1.600519')
  assert.ok(dir !== null)
  assert.deepEqual(readdirSync(dir).filter((n) => n.endsWith('.json')), ['2026-10-09.json'])
})

test('滚动清理：只保留最近 N 个交易日，且只删自己目录里的日期文件', async () => {
  freshHome()
  const days = ['2026-10-01', '2026-10-02', '2026-10-03', '2026-10-06', '2026-10-07', '2026-10-08', '2026-10-09']
  for (const day of days) await archiveTrendDays('1.600519', [{ day, points: pts(2) }], { keepDays: 3 })
  const load = await loadTrendArchive('1.600519')
  assert.deepEqual(load.days.map((d) => d.day), ['2026-10-07', '2026-10-08', '2026-10-09'], '只留最近 3 个交易日')
  // 别人放进去的文件不许被清掉
  const dir = trendArchiveDir('1.600519')
  assert.ok(dir !== null)
  writeFileSync(join(dir, 'notes.txt'), 'user file', 'utf8')
  await archiveTrendDays('1.600519', [{ day: '2026-10-10', points: pts(2) }], { keepDays: 1 })
  assert.ok(readdirSync(dir).includes('notes.txt'), '非日期文件一律不碰')
  assert.deepEqual((await loadTrendArchive('1.600519')).days.map((d) => d.day), ['2026-10-10'])
})

test('体积保护：单日超限 / 总量超限都不写，并如实报原因（不静默）', async () => {
  freshHome()
  const single = await archiveTrendDays('122.XAU', [{ day: '2026-10-09', points: pts(200) }], { maxFileBytes: 200 })
  assert.deepEqual(single.saved, [])
  assert.equal(single.skipped.length, 1)
  assert.match(single.skipped[0].reason, /上限/)
  assert.equal((await loadTrendArchive('122.XAU')).days.length, 0, '没写就是没写')

  const total = await archiveTrendDays('122.XAU', [{ day: '2026-10-10', points: pts(50) }], { maxTotalBytes: 64 })
  assert.deepEqual(total.saved, [])
  assert.match(total.skipped[0].reason, /总量/)
})

test('点数不足 / secid 非法：跳过并说明，不写半个文件', async () => {
  freshHome()
  const few = await archiveTrendDays('1.600519', [{ day: '2026-10-09', points: pts(1) }])
  assert.deepEqual(few.saved, [])
  assert.match(few.skipped[0].reason, /点数不足/)
  const bad = await archiveTrendDays('not-a-secid', [{ day: '2026-10-09', points: pts(5) }])
  assert.deepEqual(bad.saved, [])
  assert.match(bad.skipped[0].reason, /secid 非法/)
})

test('坏文件 / 缺目录：缺目录=还没归档；坏文件带原因进 unreadable，其余日子照常读', async () => {
  const home = freshHome()
  // 缺目录
  const empty = await loadTrendArchive('101.HG00Y')
  assert.deepEqual(empty, { days: [], unreadable: [] }, '还没归档过不是错误，今天就是第 1 天')
  // 写一天好的，再手工塞两个坏文件
  await archiveTrendDays('101.HG00Y', [{ day: '2026-10-09', points: pts(3) }])
  const dir = join(home, 'dsh-tradewatcher', 'trends', '101.HG00Y')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, '2026-10-08.json'), '{ not json', 'utf8')
  writeFileSync(join(dir, '2026-10-07.json'), JSON.stringify({ v: 9, day: '2026-10-07', points: [] }), 'utf8')
  const load = await loadTrendArchive('101.HG00Y')
  assert.deepEqual(load.days.map((d) => d.day), ['2026-10-09'], '好的那天照常可用（不影响其余）')
  assert.deepEqual(load.unreadable.map((u) => u.day).sort(), ['2026-10-07', '2026-10-08'])
  assert.ok(load.unreadable.every((u) => u.reason.length > 0), '每个坏文件都要有原因')
})

test('编解码：结构不对 / 价格非法一律判坏（不让坏数据进拼接）', () => {
  const good = encodeTrendDay('122.XAU', '2026-10-09', pts(2))
  assert.equal(decodeTrendDay(good)?.points.length, 2)
  assert.equal(decodeTrendDay({ v: 2, day: '2026-10-09', points: [] }), null, '版本不对')
  assert.equal(decodeTrendDay({ v: 1, day: 'x', points: [] }), null, '日期非法')
  assert.equal(decodeTrendDay('nope'), null)
  // price <= 0 的行被丢；全丢光 ⇒ 该日不可用
  const zero = encodeTrendDay('122.XAU', '2026-10-09', [{ t: 1, label: '2026-10-09 09:30', price: 0, avg: 0, vol: 0, amount: 0 }])
  assert.equal(decodeTrendDay(zero), null)
})
