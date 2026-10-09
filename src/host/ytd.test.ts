/**
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { DayBar, KlineData } from '../shared/model.ts'
import { YTD_BARS, YTD_FAIL_COOLDOWN_MS, YtdMemo, computeYtds, ytdBaseFromBars, ytdPctOf } from './ytd.ts'

const bar = (date: string, close: number): DayBar => ({ date, open: close, close, high: close, low: close, vol: 1, pct: null })

const OCT = Date.parse('2025-10-08T02:00:00Z') // 北京时间 2025-10-08 10:00

test('ytdBaseFromBars：基准取本年内第一个交易日的收盘价', () => {
  const bars = [bar('2024-12-30', 10), bar('2024-12-31', 11), bar('2025-01-02', 12), bar('2025-06-30', 20)]
  assert.deepEqual(ytdBaseFromBars(bars, '2025-10-08', YTD_BARS), { baseDate: '2025-01-02', baseClose: 12, baseKind: 'year' })
})

test('ytdBaseFromBars：年内第一个交易日就是今天时不给基准（口径要求的是收盘价，不是未收盘价）', () => {
  const bars = [bar('2024-12-31', 11), bar('2025-01-02', 12)]
  assert.equal(ytdBaseFromBars(bars, '2025-01-02', YTD_BARS), null)
})

test('ytdBaseFromBars：序列里还没有今年的交易日（今年未开市）时不给基准', () => {
  assert.equal(ytdBaseFromBars([bar('2024-12-31', 11)], '2025-01-01', YTD_BARS), null)
  assert.equal(ytdBaseFromBars([], '2025-01-01', YTD_BARS), null)
})

test('ytdBaseFromBars：本年内上市 → 基准是上市首日，必须标成 listing（按"年初至今"读会高估）', () => {
  const bars = [bar('2025-03-03', 8), bar('2025-03-04', 9)]
  assert.deepEqual(ytdBaseFromBars(bars, '2025-10-08', YTD_BARS), { baseDate: '2025-03-03', baseClose: 8, baseKind: 'listing' })
  // 取数窗口没被取满才算"序列起点就是它"；取满窗口时同样的两根只能是年内第一个交易日
  assert.deepEqual(ytdBaseFromBars(bars, '2025-10-08', 2), { baseDate: '2025-03-03', baseClose: 8, baseKind: 'year' })
})

test('ytdPctOf：现价或基准缺失/基准非正数一律 null（不用 0 顶替）', () => {
  assert.equal(ytdPctOf(12, 10), 20)
  assert.equal(ytdPctOf(7.5, 10), -25)
  assert.equal(ytdPctOf(10, 10), 0)
  assert.equal(ytdPctOf(null, 10), null)
  assert.equal(ytdPctOf(10, null), null)
  assert.equal(ytdPctOf(10, 0), null)
  assert.equal(ytdPctOf(Number.NaN, 10), null)
  assert.equal(ytdPctOf(9.999, 10), -0.01, '两位小数四舍五入')
})

test('computeYtds：并发有界、按入参顺序返回、现价缺失不去打日线', async () => {
  let inflight = 0
  let maxInflight = 0
  const asked: string[] = []
  const fetchKline = async (secid: string): Promise<KlineData | null> => {
    asked.push(secid)
    inflight += 1
    maxInflight = Math.max(maxInflight, inflight)
    await new Promise((r) => setTimeout(r, 3))
    inflight -= 1
    return { secid, days: [bar('2024-12-31', 10), bar('2025-01-02', 12), bar('2025-10-07', 15)], fqt: 1, fqSupported: true, asOf: OCT }
  }
  const items = Array.from({ length: 9 }, (_, i) => ({ secid: `1.${i}`, name: `标的${i}`, price: 12 + i }))
  items.push({ secid: '1.noprice', name: '无价标的', price: null })
  const r = await computeYtds(items, { fetchKline, now: () => OCT, memo: new YtdMemo() })

  assert.equal(r.rows.length, items.length)
  assert.deepEqual(r.rows.map((x) => x.secid), items.map((x) => x.secid), '行顺序必须与入参一致（"沉底"语义依赖它）')
  assert.ok(maxInflight <= 4, `并发必须 ≤4（实测 ${maxInflight}）`)
  assert.ok(!asked.includes('1.noprice'), '现价缺失时不去打日线（算不出来，还白触发一次全量 K 线）')
  const first = r.rows[0]
  assert.equal(first.baseDate, '2025-01-02')
  assert.equal(first.baseKind, 'year')
  assert.equal(first.ytd, Math.round(((12 - 12) / 12) * 10000) / 100)
  assert.equal(first.why, null)
  const nop = r.rows.at(-1)
  assert.equal(nop?.ytd, null)
  assert.match(nop?.why ?? '', /未取到现价/)
  assert.equal(r.missing.length, 1)
  assert.equal(r.missing[0].why, 'transient')
})

test('computeYtds：日线取不到 → 显示 — + transient 原因；按日 memo 不重算，失败有冷却', async () => {
  let nowMs = OCT
  let calls = 0
  const memo = new YtdMemo()
  const deps = {
    now: () => nowMs,
    memo,
    fetchKline: async (secid: string): Promise<KlineData | null> => {
      calls += 1
      if (secid === '1.bad') throw new Error('upstream timeout')
      return { secid, days: [bar('2024-12-31', 10), bar('2025-01-02', 12), bar('2025-10-07', 15)], fqt: 1, fqSupported: true, asOf: nowMs }
    },
  }
  const bad = [{ secid: '1.bad', name: '坏标的', price: 15 }]

  const r1 = await computeYtds(bad, deps)
  assert.equal(calls, 1)
  assert.equal(r1.rows[0].ytd, null)
  assert.match(r1.rows[0].why ?? '', /日线本次取不到/)
  assert.equal(r1.missing[0].why, 'transient')
  assert.match(r1.missing[0].note, /稍后自动重试/)

  const r2 = await computeYtds(bad, deps)
  assert.equal(calls, 1, '冷却期内不重打上游（不重试轰炸）')
  assert.equal(r2.rows[0].ytd, null)

  nowMs += YTD_FAIL_COOLDOWN_MS + 1000
  const r3 = await computeYtds(bad, deps)
  assert.equal(calls, 2, '过了冷却允许再试一次（不把一个瞬时失败钉死一整天）')
  assert.equal(r3.rows[0].ytd, null)

  const ok = [{ secid: '1.ok', name: '好标的', price: 15 }]
  const r4 = await computeYtds(ok, deps)
  assert.equal(calls, 3)
  assert.equal(r4.rows[0].ytd, 25, '(15 − 12) / 12 = 25%')
  await computeYtds(ok, deps)
  assert.equal(calls, 3, '成功结果当天有效：同一交易日内不再取基准')
})

test('computeYtds：今年还没有已收盘交易日 → no-source（重试无用，得等下一个交易日）', async () => {
  const memo = new YtdMemo()
  const r = await computeYtds(
    [{ secid: '1.a', name: '甲', price: 12 }],
    {
      now: () => Date.parse('2025-01-02T02:00:00Z'),
      memo,
      fetchKline: async (secid: string): Promise<KlineData | null> => ({
        secid, days: [bar('2024-12-31', 11), bar('2025-01-02', 12)], fqt: 1, fqSupported: true, asOf: 1,
      }),
    },
  )
  assert.equal(r.rows[0].ytd, null)
  assert.match(r.rows[0].why ?? '', /本年内还没有已收盘的交易日/)
  assert.equal(r.missing[0].why, 'no-source')
})

test('YtdMemo：容量上限内按最近使用淘汰，旧交易日的结果不复用', () => {
  const memo = new YtdMemo(2)
  const base = { baseDate: '2025-01-02', baseClose: 12, baseKind: 'year' as const, fq: 1 as const, fqSupported: true, asOf: 1, why: null, failed: false }
  memo.set('1.a', '2025-10-08', OCT, base)
  memo.set('1.b', '2025-10-08', OCT, base)
  memo.set('1.c', '2025-10-08', OCT, base)
  assert.equal(memo.size, 2)
  assert.equal(memo.peek('1.a', '2025-10-08', OCT), undefined, '超过上限时淘汰最早写入的')
  assert.equal(memo.peek('1.c', '2025-10-08', OCT)?.baseClose, 12)
  assert.equal(memo.peek('1.c', '2025-10-09', OCT), undefined, '换一天必须重算（基准是"本年内第一个交易日"）')
})
