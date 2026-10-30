/** 腾讯聚合扫描核心（AUDIT-PROBE-BREADTH）。 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { BATCH_GAP_MS, BATCH_SIZE, MAX_CONCURRENCY, SINA_CODE_HOST, __resetCodePoolCache, aggregateOf, batchesOf, bucketIndexOf, nineBucketsOf, parseSinaCodePage, parseTencentQuoteText, scanBatches, tencentBreadthAggregate } from './breadthScan.ts'

test('① 11 档合计 + 停牌 = 全量（差一只 ⇒ 败）', () => {
  const rows = [
    ...Array.from({ length: 5 }, (_, i) => ({ pct: [12, 8, 6, 4, 1][i] as number })),
    { pct: 0 },
    ...Array.from({ length: 5 }, (_, i) => ({ pct: [-1, -4, -6, -8, -12][i] as number })),
    { pct: null, suspended: true },
  ]
  const a = aggregateOf(rows)
  assert.deepEqual(a.buckets, [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1])
  assert.equal(a.total, rows.length)
  assert.equal(a.total, 12)
  // 反例注入：漏掉一只（把停牌当不存在）⇒ 必败
  assert.throws(() => assert.equal(a.total, 11, '反例上：少一只'), /反例上/, '⚠ 反例注入必须失败')
})

test('② 停牌计入平盘 ⇒ 败', () => {
  const a = aggregateOf([{ pct: null, suspended: true }, { pct: 0 }])
  assert.equal(a.suspended, 1)
  assert.equal(a.flat, 1, '停牌不得计入平盘')
  assert.deepEqual(a.buckets, [0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0])
  assert.throws(() => assert.equal(a.flat, 2, '反例上：停牌算平盘'), /反例上/, '⚠ 反例注入必须失败')
})

test('③ 单批失败 ⇒ 其余批仍返回 + failedBatches 非空（整轮失败 ⇒ 败）', async () => {
  const batches = batchesOf(Array.from({ length: 5 }, (_, i) => `s${i}`), 2)
  const r = await scanBatches({
    batches, sleep: async () => {},
    fetchBatch: async (codes, i) => { if (i === 1) throw new Error('boom'); return codes.map(() => ({ pct: 1 })) },
  })
  assert.equal(r.failedBatches.length, 1)
  assert.equal(r.rows.length, 3, '其余两批必须返回（2+1 行）')
  assert.throws(() => assert.equal(r.rows.length, 0, '反例上：整轮作废'), /反例上/, '⚠ 反例注入必须失败')
})

test('④ 代码池当日缓存：同一天第二次扫描 0 次代码表请求（跨日必须重翻）', async () => {
  __resetCodePoolCache()
  let tableCalls = 0
  const run = (now: number) => tencentBreadthAggregate({
    now, sleep: async () => {},
    fetchText: async (host, url) => {
      if (host === SINA_CODE_HOST) {
        tableCalls += 1
        return /page=1&/.test(url) ? JSON.stringify([{ symbol: 'sh600000' }]) : '[]'
      }
      return qtLine('sh600000', { price: 11, prev: 10, vol: 100, pct: 10, up: 11, down: 9 })
    },
  })
  const day1 = Date.parse('2026-10-26T10:00:00+08:00')
  await run(day1)
  const afterFirst = tableCalls
  await run(day1 + 60_000)
  assert.equal(tableCalls, afterFirst, '同一天第二次扫描不得再翻代码表')
  await run(day1 + 86_400_000)
  assert.ok(tableCalls > afterFirst, '跨日必须重翻（新股/退市会让池子漂移）')
  assert.throws(() => assert.equal(tableCalls, afterFirst, '反例上：跨日仍用旧池'), /反例/, '⚠ 反例注入必须失败')
  __resetCodePoolCache()
})

test('⑤ 批间延迟 ≥120ms、并发 >4 ⇒ 败', () => {
  assert.equal(BATCH_GAP_MS, 120)
  assert.equal(MAX_CONCURRENCY, 4)
  assert.equal(BATCH_SIZE, 600)
  assert.throws(() => assert.ok((MAX_CONCURRENCY as number) === 8, '反例上：并发 8'), /反例上/, '⚠ 反例注入必须失败')
})

test('⑥ 断点续扫：已完成批不再请求', async () => {
  const batches = batchesOf(['a', 'b', 'c', 'd'], 1)
  const seen: number[] = []
  const state = { poolVersion: 'v1', done: [0, 1], failedBatches: [] }
  const r = await scanBatches({
    batches, sleep: async () => {}, state,
    fetchBatch: async (_codes, i) => { seen.push(i); return [{ pct: 0 }] },
  })
  assert.deepEqual(seen.sort(), [2, 3])
  assert.deepEqual(r.state.done, [0, 1, 2, 3])
})

/** 造一行腾讯报价：49 个字段里只填用到的 6 个（其余空串，与真实回包形状一致） */
function qtLine(code: string, v: { price: number | null; prev: number | null; vol?: number | null; pct: number | null; up?: number | null; down?: number | null }): string {
  const f = new Array<string>(49).fill('')
  f[3] = v.price === null ? '' : String(v.price)
  f[4] = v.prev === null ? '' : String(v.prev)
  f[6] = String(v.vol ?? 0)
  f[32] = v.pct === null ? '' : String(v.pct)
  f[47] = v.up === null || v.up === undefined ? '' : String(v.up)
  f[48] = v.down === null || v.down === undefined ? '' : String(v.down)
  return `v_${code}="${f.join('~')}";`
}

test('⑦ 11 桶 → 9 档：只合并两个开口边界档（其余一一对应）', () => {
  const b = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11] // >10 / 7~10 / 5~7 / 3~5 / 0~3 / 平 / -3~0 / -5~-3 / -7~-5 / -10~-7 / <-10
  assert.deepEqual(nineBucketsOf(b), [3, 3, 4, 5, 6, 7, 8, 9, 21])
  assert.equal(nineBucketsOf(b).reduce((a, c) => a + c, 0), b.reduce((a, c) => a + c, 0), '合并不许丢数')
  assert.throws(() => nineBucketsOf([1, 2, 3]), /长度应为 11/, '桶数不对必须抛错（不静默补 0）')
  assert.throws(() => assert.deepEqual(nineBucketsOf(b), [1, 2, 3, 4, 5, 6, 7, 8, 9], '反例上：11 桶当成 9 档'), /反例/, '⚠ 反例注入必须失败')
})

test('⑧ 腾讯报价解析：f32 涨跌幅 / f47 涨停价 / f48 跌停价 / f6 量', () => {
  const text = [
    qtLine('sh600000', { price: 11, prev: 10, vol: 1000, pct: 10, up: 11, down: 9 }),
    qtLine('sz000001', { price: 9.8, prev: 10, vol: 500, pct: -2, up: 11, down: 9 }),
    qtLine('sh600519', { price: 0, prev: 0, vol: 0, pct: 0 }),
  ].join('\n')
  const qs = parseTencentQuoteText(text)
  assert.equal(qs.length, 3)
  assert.equal(qs[0]?.pct, 10)
  assert.equal(qs[0]?.upLimit, 11)
  assert.equal(qs[0]?.downLimit, 9)
  assert.equal(qs[1]?.vol, 500)
  assert.equal(qs[2]?.price, 0, '停牌行的 0 必须原样读出（由聚合层判停牌，不在这里抹掉）')
  assert.throws(() => assert.equal(qs.length, 0, '反例上：一条都没解析'), /反例上/, '⚠ 反例注入必须失败')
})

test('⑨ 代码表解析：只留 sh/sz，北交所 bj 一律剔除', () => {
  const page = JSON.stringify([
    { symbol: 'bj920000' }, { symbol: 'sh600000' }, { symbol: 'sz000001' }, { symbol: 'SH600519' },
  ])
  assert.deepEqual(parseSinaCodePage(page).codes, ['sh600000', 'sz000001', 'sh600519'])
  assert.deepEqual(parseSinaCodePage('[]'), { codes: [], rows: 0 })
  assert.deepEqual(parseSinaCodePage('not json'), { codes: [], rows: 0 })
  assert.throws(() => assert.deepEqual(parseSinaCodePage(page).codes, ['bj920000', 'sh600000', 'sz000001', 'sh600519'], '反例上：bj 混进池'), /反例/, '⚠ 反例注入必须失败（bj 不许进池）')
})

test('⑩ 端到端聚合：代码池 → 分批 → 11 桶 → 9 档 + 覆盖三数', async () => {
  const pages: Record<number, string> = {
    1: JSON.stringify([{ symbol: 'sh600000' }, { symbol: 'sz000001' }, { symbol: 'bj920000' }]),
    2: JSON.stringify([{ symbol: 'sz000002' }]),
    3: '[]',
  }
  const quotes: Record<string, string> = {
    // 涨停 1 只、上涨 1 只、平盘 1 只（有量）、停牌 1 只（无量且平盘）
    'sh600000': qtLine('sh600000', { price: 11, prev: 10, vol: 1000, pct: 10, up: 11, down: 9 }),
    'sz000001': qtLine('sz000001', { price: 10.2, prev: 10, vol: 800, pct: 2, up: 11, down: 9 }),
    'sz000002': qtLine('sz000002', { price: 10, prev: 10, vol: 600, pct: 0, up: 11, down: 9 }),
  }
  const calls: string[] = []
  const r = await tencentBreadthAggregate({
    sleep: async () => {},
    pool: undefined,
    fetchText: async (host, url) => {
      calls.push(`${host} ${url}`)
      if (host === 'vip.stock.finance.sina.com.cn') {
        const m = /page=(\d+)/.exec(url)
        return pages[Number(m?.[1] ?? 0)] ?? '[]'
      }
      return Object.values(quotes).join('\n')
    },
  })
  assert.equal(r.codes, 3, '池内代码 = 沪深 3 只（bj 已剔除）')
  assert.equal(r.quoted, 3)
  assert.equal(r.suspendedCount, 0, '三只都有量 ⇒ 无停牌')
  assert.equal(r.up, 2)
  assert.equal(r.down, 0)
  assert.equal(r.flat, 1)
  assert.equal(r.limitUp, 1, '涨停价触碰 ⇒ limitUp=1')
  assert.equal(r.counts.length, 9)
  assert.equal(r.counts.reduce((a, c) => a + c, 0), 3)
  assert.equal(r.totalBatches, 1, '3 只 = 1 批（≤600）')
  assert.equal(r.failedBatches.length, 0)
  assert.ok(calls.some((c) => c.startsWith('qt.gtimg.cn')), '必须真的打腾讯报价')
  assert.throws(() => assert.equal(r.counts.length, 11, '反例上：给 11 档'), /反例上/, '⚠ 反例注入必须失败')
})

/* ── 边界补强（AUDIT-TESTS-1030）：分桶边界、空池、非法 pct、批量切分 ── */

test('⑨ 分桶边界：±7 / ±10 / 0 的归属与 9 档合并的不变性（合并表被改 ⇒ 败）', () => {
  const nine = (pct: number): number[] => nineBucketsOf(aggregateOf([{ pct }]).buckets)
  assert.deepEqual(nine(7), [1, 0, 0, 0, 0, 0, 0, 0, 0], '7.00% 属「≥7%」')
  assert.deepEqual(nine(10), [1, 0, 0, 0, 0, 0, 0, 0, 0], '+10.00% 也必须并入「≥7%」（11 桶里它在 >10 档）')
  assert.deepEqual(nine(0), [0, 0, 0, 0, 1, 0, 0, 0, 0], '0 ⇒ 平盘档')
  assert.deepEqual(nine(-7), [0, 0, 0, 0, 0, 0, 0, 1, 0], 'v0.183.0 左闭：-7.00% 属「-7~-5」（≤-7% 是 (-∞,-7)）')
  assert.deepEqual(nine(-7.01), [0, 0, 0, 0, 0, 0, 0, 0, 1], '-7.01% 才落「≤-7%」')
  assert.deepEqual(nine(-10), [0, 0, 0, 0, 0, 0, 0, 0, 1], '-10.00% 也必须并入「≤-7%」（11 桶里它在 <-10 档）')
  assert.deepEqual(nine(-0.01), [0, 0, 0, 0, 0, 1, 0, 0, 0], '微跌属 -3~0（不是平盘）')
  // v0.183.0：两侧统一为**左闭右开**（此前 +10 落「7~10」、-10 落「<-10」，方向相反）
  assert.equal(bucketIndexOf(10), 0, '11 桶：+10.00% 落在「>10」（左闭）')
  assert.equal(bucketIndexOf(-10), 10, '11 桶：-10.00% 落在「≤-10」（左闭）')
  assert.equal(bucketIndexOf(10), 10 - bucketIndexOf(-10), '两侧边界方向必须对称')
  // 反例注入：把「≥7%」的合并从 [0,1] 改成 [0] ⇒ 7.00% 会掉出该档
  const wrongMerge = [[0], [1], [2], [3], [4], [5], [6], [7], [8, 9, 10]]
  const wrongNine = wrongMerge.map((idx) => idx.reduce((s, i) => s + (aggregateOf([{ pct: 7 }]).buckets[i] ?? 0), 0))
  assert.notDeepEqual(wrongNine, nine(7))
  assert.throws(() => assert.deepEqual(wrongNine, nine(7), '反例上：合并表漏一桶'), /反例上/, '⚠ 反例注入必须失败')
})

test('⑩ 空池 / 非法 pct：空数组不产桶、不产批；NaN/null 行不计入 total（写 0 冒充平盘 ⇒ 败）', () => {
  const empty = aggregateOf([])
  assert.deepEqual(empty.buckets, [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0])
  assert.equal(empty.total, 0)
  assert.deepEqual(batchesOf([], BATCH_SIZE), [], '空池不得产出空批')
  assert.deepEqual(batchesOf(['a'], BATCH_SIZE), [['a']], '单元素必须成一批')
  assert.deepEqual(batchesOf(['a', 'b', 'c'], 2), [['a', 'b'], ['c']], '最后一批可以不满')
  const withBad = aggregateOf([{ pct: NaN }, { pct: null }, { pct: 1 }, { pct: 0, suspended: true }])
  assert.equal(withBad.total, 2, '只有「可计价的一只 + 停牌的一只」进 total；NaN/null 不得冒充平盘')
  assert.equal(withBad.flat, 0, 'NaN 不得被算成平盘')
  // 反例注入：把 NaN 当 0（平盘）⇒ flat 会变成 2
  assert.throws(() => assert.equal(withBad.flat, 2, '反例上：NaN 记平盘'), /反例上/, '⚠ 反例注入必须失败')
})

test('⑪ 11 桶长度不符 ⇒ 抛错（静默补 0 ⇒ 败）', () => {
  assert.throws(() => nineBucketsOf([1, 2, 3]), /长度应为 11/)
  assert.throws(() => nineBucketsOf(new Array(10).fill(0)), /长度应为 11/)
  assert.equal(nineBucketsOf(new Array(11).fill(1)).reduce((a, b) => a + b, 0), 11, '11 桶全 1 ⇒ 9 档合计仍是 11')
  // 反例注入：静默补 0 会让短数组返回全 0（看起来"没有涨跌"，其实数据坏了）
  const silent = Array.from({ length: 9 }, () => 0)
  assert.notDeepEqual(silent, nineBucketsOf(new Array(11).fill(1)))
  assert.throws(() => assert.deepEqual(silent, nineBucketsOf(new Array(11).fill(1)), '反例上：静默补 0'), /反例上/, '⚠ 反例注入必须失败')
})
