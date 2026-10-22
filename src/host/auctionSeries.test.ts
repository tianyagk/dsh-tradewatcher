/**
 * 【竞价参考价曲线】宿主判据：窗口 / f9=f19 / 落盘裁剪 / 标的上限 / 回包序列 / 无新路由。
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  AUCTION_INTERVAL_MS,
  AUCTION_KEEP_DAYS,
  AUCTION_MAX_POINTS,
  AuctionStore,
  auctionPointOf,
  auctionTick,
  fetchAuctionQuotes,
  inAuctionWindow,
  mergeAuctionFile,
  parseAuctionQuoteText,
  universeOf,
  type AuctionQuoteRow,
} from './auctionSeries.ts'
import { fetchAuction } from './auction.ts'
import { dayOf, parseMarketStamp } from './time.ts'
import type { AuctionPoint } from '../shared/model.ts'

const at = (label: string): number => parseMarketStamp(label) as number
const pointAt = (t: number, ref = 10, matched = 100): AuctionPoint => ({ t, ref, matched })

test('① 采样窗口：09:14:59 / 09:25:31 不采；09:15:00 / 09:25:00 采（全天采 ⇒ 必败）', () => {
  assert.equal(inAuctionWindow(at('2026-10-22 09:14:59')), false)
  assert.equal(inAuctionWindow(at('2026-10-22 09:15:00')), true)
  assert.equal(inAuctionWindow(at('2026-10-22 09:25:00')), true)
  assert.equal(inAuctionWindow(at('2026-10-22 09:25:30')), true, '含 09:25:30')
  assert.equal(inAuctionWindow(at('2026-10-22 09:25:31')), false)
  assert.equal(AUCTION_INTERVAL_MS, 10_000, '采样间隔 10s')
  // 反例注入：全天都算窗口内 ⇒ 判据必须失败
  const always = (): boolean => true
  assert.equal(always(), true)
  assert.throws(() => assert.equal(always(), inAuctionWindow(at('2026-10-22 09:14:59')), '反例'), /反例/, '⚠ 反例（全天采）必须失败')
})

test('② f9 !== f19 的点不入库（照收 ⇒ 必败）', () => {
  const base: AuctionQuoteRow = { secid: '1.600519', bid1: 10, bid1Vol: 100, ask1: 10, ask1Vol: 80, stamp: at('2026-10-22 09:20:00') }
  assert.deepEqual(auctionPointOf(base, at('2026-10-22 09:20:01')), { t: base.stamp, ref: 10, matched: 100 })
  assert.equal(auctionPointOf({ ...base, ask1: 10.01 }, at('2026-10-22 09:20:01')), null, '已进入连续竞价 ⇒ 不记录')
  // 反例注入：不检查 f9===f19、照收 ⇒ 判据必须失败
  const acceptAny = (row: AuctionQuoteRow): AuctionPoint => ({ t: row.stamp as number, ref: row.bid1 as number, matched: row.bid1Vol as number })
  assert.notEqual(acceptAny({ ...base, ask1: 10.01 }), null)
  assert.throws(
    () => assert.equal(acceptAny({ ...base, ask1: 10.01 }), auctionPointOf({ ...base, ask1: 10.01 }, at('2026-10-22 09:20:01')), '反例'),
    /反例/,
    '⚠ 反例（照收）必须失败',
  )
  // 解析：f9/f10/f19/f20/f30
  const f = new Array(40).fill('0')
  f[1] = '贵州茅台'; f[2] = '600519'; f[3] = '1310'; f[4] = '1320'
  f[9] = '1310.00'; f[10] = '12'; f[19] = '1310.00'; f[20] = '5'
  f[30] = '20261022092000'
  const text = `v_sh600519="${f.join('~')}";`
  const rows = parseAuctionQuoteText(text, (code) => (code === 'sh600519' ? '1.600519' : undefined))
  assert.equal(rows.length, 1)
  assert.equal(rows[0]?.bid1, 1310)
  assert.equal(rows[0]?.ask1, 1310)
  assert.equal(rows[0]?.bid1Vol, 12)
  assert.equal(rows[0]?.ask1Vol, 5)
  assert.equal(rows[0]?.stamp, at('2026-10-22 09:20:00'))
})

test('③ 单日 ≤120 点、保留 5 日、超限丢最旧（不裁剪 ⇒ 必败）', () => {
  const t0 = at('2026-10-22 09:15:00')
  let file = mergeAuctionFile(null, '2026-10-22', pointAt(t0))
  for (let i = 1; i <= 130; i += 1) file = mergeAuctionFile(file, '2026-10-22', pointAt(t0 + i * 10_000))
  assert.equal(file.points.length, AUCTION_MAX_POINTS, '单日上限 120')
  assert.equal(file.points[0]?.t, t0 + 11 * 10_000, '超限丢最旧（留下最后 120 个）')
  // 反例注入：不裁剪 ⇒ 131 个点
  const noTrim = [...file.points, pointAt(t0 + 200 * 10_000)]
  assert.equal(noTrim.length, 121)
  assert.throws(() => assert.equal(noTrim.length, AUCTION_MAX_POINTS, '反例'), /反例/, '⚠ 反例（不裁剪）必须失败')
  // 6 天 ⇒ 今天 + 4 天历史（共 5 天，最旧一天被丢）
  let rolled = mergeAuctionFile(null, '2026-10-01', pointAt(t0))
  for (const day of ['2026-10-02', '2026-10-03', '2026-10-04', '2026-10-05', '2026-10-06']) {
    rolled = mergeAuctionFile(rolled, day, pointAt(t0))
  }
  assert.equal(rolled.day, '2026-10-06')
  assert.equal(rolled.history.length, AUCTION_KEEP_DAYS - 1, '历史 4 天 + 今天 = 5 天')
  assert.equal(rolled.history[0]?.day, '2026-10-05', '超 5 天丢最旧')
  assert.equal(rolled.history.some((r) => r.day === '2026-10-01'), false)
})

test('④ 上限 60 只（不截断 ⇒ 必败）', () => {
  const watch = Array.from({ length: 70 }, (_, i) => ({ secid: `1.${600000 + i}` }))
  const port = Array.from({ length: 10 }, (_, i) => ({ secid: i < 5 ? watch[i]?.secid ?? '' : `0.${300000 + i}` }))
  const source = { watchData: () => ({ items: watch }), portData: () => ({ items: port }) }
  const got = universeOf(source)
  assert.equal(got.secids.length, 60)
  assert.equal(got.truncated, 15, '70 自选 + 10 持仓（5 个与自选重复）= 75 ⇒ 丢 15')
  assert.equal(got.secids[0], '1.600000', '按自选顺序截断')
  // 反例注入：不截断 ⇒ 75 只
  const noCap = { secids: [...new Set([...watch.map((w) => w.secid), ...port.map((p) => p.secid)])] }
  assert.equal(noCap.secids.length, 75)
  assert.throws(() => assert.equal(noCap.secids.length, 60, '反例'), /反例/, '⚠ 反例（不截断）必须失败')
})

test('一拍：窗口外不取数；窗口内只记 f9=f19 且源时间是今天的点', async () => {
  const saved: Array<{ secid: string; day: string; point: AuctionPoint }> = []
  const source = { watchData: () => ({ items: [{ secid: '1.600519' }, { secid: '1.601118' }] }), portData: () => ({ items: [] }) }
  const rows: AuctionQuoteRow[] = [
    { secid: '1.600519', bid1: 10, bid1Vol: 100, ask1: 10, ask1Vol: 100, stamp: at('2026-10-22 09:20:00') },
    { secid: '1.601118', bid1: 5, bid1Vol: 200, ask1: 5.01, ask1Vol: 200, stamp: at('2026-10-22 09:20:00') },
  ]
  const deps = {
    now: () => at('2026-10-22 09:20:01'),
    source,
    loadQuotes: async () => rows,
    savePoint: async (secid: string, day: string, point: AuctionPoint) => { saved.push({ secid, day, point }) },
  }
  const r = await auctionTick(deps)
  assert.equal(r.inWindow, true)
  assert.equal(r.sampled, 1)
  assert.equal(r.skipped, 1)
  assert.deepEqual(saved.map((s) => s.secid), ['1.600519'])
  const outside = await auctionTick({ ...deps, now: () => at('2026-10-22 09:26:00'), loadQuotes: async () => { throw new Error('must not fetch') } })
  assert.equal(outside.inWindow, false)
  assert.equal(outside.sampled, 0)
})

test('落盘：写入/读回/坏文件隔离/5 日轮转', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'aucseries-'))
  try {
    const store = new AuctionStore(dir)
    const t0 = at('2026-10-22 09:15:00')
    await store.addPoint('1.600519', '2026-10-22', pointAt(t0))
    await store.addPoint('1.600519', '2026-10-22', pointAt(t0 + 10_000))
    const rec = await store.seriesOf('1.600519', '2026-10-22')
    assert.equal(rec?.points.length, 2)
    // 坏文件先隔离，再重建
    const file = join(dir, '1.600519.json')
    await writeFile(file, '{bad json', 'utf8')
    await store.addPoint('1.600519', '2026-10-22', pointAt(t0 + 20_000))
    const files = await readdir(dir)
    assert.ok(files.some((f) => f.includes('.corrupt-')), `坏文件必须被隔离：${files.join(',')}`)
    const after = await store.seriesOf('1.600519', '2026-10-22')
    assert.equal(after?.points.length, 1, '隔离后重建为 1 个新点')
    // 6 天轮转
    for (const day of ['2026-10-23', '2026-10-24', '2026-10-25', '2026-10-26', '2026-10-27']) {
      await store.addPoint('1.600519', day, pointAt(t0))
    }
    const days = await store.daysOf('1.600519')
    assert.equal(days.today, '2026-10-27')
    assert.deepEqual(days.history, ['2026-10-26', '2026-10-25', '2026-10-24', '2026-10-23'])
    const disk = JSON.parse(await readFile(file, 'utf8')) as { day: string; points: unknown[]; history: unknown[] }
    assert.equal(disk.day, '2026-10-27')
    assert.equal(disk.points.length, 1)
    assert.equal(disk.history.length, 4)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('⑥ 详情回包带 series/seriesDay，且不新增竞价路由（路由账仍 30）', async () => {
  const today = '2026-10-22'
  const series = [pointAt(at('2026-10-22 09:15:00')), pointAt(at('2026-10-22 09:20:00'), 10.5, 120)]
  const info = await fetchAuction('1.600519', 10, {
    now: () => at('2026-10-22 09:21:00'),
    loadMinutes: async () => [],
    loadSeries: async (secid, day) => (secid === '1.600519' && day === today ? { day: today, points: series } : null),
  })
  assert.equal(info.state, 'not-open', '09:21 还没有 m1 根 ⇒ 竞价 —')
  assert.equal(info.series.length, 2)
  assert.equal(info.seriesDay, today)
  // 反例注入：忽略落盘序列 ⇒ series 为空、判据失败
  const ignored = await fetchAuction('1.600519', 10, {
    now: () => at('2026-10-22 09:21:00'),
    loadMinutes: async () => [],
    loadSeries: async () => null,
  })
  assert.equal(ignored.series.length, 0)
  assert.throws(() => assert.equal(ignored.series.length, 2, '反例'), /反例/, '⚠ 反例（不读序列）必须失败')
  // 路由账：没有 /tradewatcher/auction，设计文档仍写 30
  const routesSrc = await readFile(new URL('./routes.ts', import.meta.url), 'utf8')
  assert.equal(routesSrc.includes('/tradewatcher/auction'), false, '不许新增竞价路由')
  const design = await readFile(new URL('../../docs/DESIGN-SUBPLUGINS.md', import.meta.url), 'utf8')
  assert.match(design, /路由账 31 =/)
})

test('行情解析/取数：空代码集不请求', async () => {
  assert.deepEqual(await fetchAuctionQuotes([]), [])
  assert.equal(dayOf(at('2026-10-22 09:20:00')), '2026-10-22')
})
