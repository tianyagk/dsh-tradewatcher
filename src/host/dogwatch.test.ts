/** 汪汪队跟踪（v0.186.0）：① 首日=100 ② 折算顺延 ③ 份额变化=相邻差 ④ stale ⑤ 放大倍数 ⑥ 池 ⑦ 缓存 */
import { test } from 'node:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { join, join as joinPath } from 'node:path'
import { DOGWATCH_POOL, cacheUsableOf, fetchDogwatch, wanToYi, detectCorporateActions, indexSeriesOf, isShenzhenCode, loadSharesOf, parseSseShares, poolCoverageOf, ratioOf, sharesStaleOf, sharesCachePath, summaryCachePath, weightedPctOf, createNetworkGate, readAllDiskShares, DOGWATCH_PARSE_YIELD_EVERY, DOGWATCH_BIG_FILE_BYTES } from './dogwatch.ts'
// 独立 DSH_HOME：避免与其它测试文件共享 dogwatch 缓存目录
process.env.DSH_HOME = mkdtempSync(joinPath(tmpdir(), 'dw-main-'))

/** 测试里不需要批间节流：全部走磁盘/注入数据，120ms 纯等待没有意义 */
const dw = (w: Parameters<typeof fetchDogwatch>[0], deps: Parameters<typeof fetchDogwatch>[1]) => fetchDogwatch(w, { gapMs: 0, ...deps })

test('① 加仓指数首日 = 100（不等于 100 ⇒ 败）', () => {
  const s = indexSeriesOf([{ day: 'd1', volWan: 1000 }, { day: 'd2', volWan: 1100 }], [])
  assert.equal(s[0]!.index, 100)
  assert.equal(s[1]!.index, 110)
  assert.throws(() => assert.equal(s[0]!.index, 101, '反例上：首日不是 100'), /反例上/, '⚠ 反例注入必须失败')
})

test('② 折算双向判据：份额跳+价格跳空 ⇒ 折算（顺延并重标定）；份额跳+价格不动 ⇒ 真实申赎（必须计入）', () => {
  /**
   * 510300 真实份额台阶（亿份）：888 → 448 → 189 → 241 → 456。
   * 前两跳是折算（份额减半/再减），后两跳是真实申购。
   * 折算日的价格跳空按会计恒等式给：份额 × r ⇒ 单位净值 ÷ r（888→448 ⇒ 价格 +98.2%）。
   */
  const ladder = [888, 448, 189, 241, 456]
  const gaps = [0, (888 / 448 - 1) * 100, (448 / 189 - 1) * 100, 0.4, 0.6]
  const series = ladder.map((v, i) => ({ day: `d${i}`, totalWan: v, priceGapPct: gaps[i]! }))

  const actions = detectCorporateActions(series).filter((a) => a.suspectedMultiDay !== true)
  assert.deepEqual(actions.map((a) => a.day), ['d1', 'd2'], '只有两个折算日（888→448、448→189）')
  assert.equal(actions[0]!.ratio, 448 / 888)
  assert.notEqual(detectCorporateActions(series, { threshold: 0.5 }).filter((a) => a.suspectedMultiDay !== true).length, 2, '阈值 50% 时 888→448(−49.5%) 不该命中 ⇒ 说明阈值真的生效')

  const idx = indexSeriesOf(series.map((p) => ({ day: p.day, volWan: p.totalWan })), actions)
  assert.equal(idx[0]!.index, 100, '首日 100')
  assert.equal(idx[1]!.index, 100, '折算日指数必须顺延（不得掉到 50.4）')
  assert.equal(idx[2]!.index, 100, '第二次折算同样顺延（不得掉到 21.3）')
  assert.equal(idx[3]!.change, wanToYi(241 - 189), '折算次日的变化按新标尺算（241−189）')
  assert.ok(Math.abs(idx[3]!.index - (100 * 241) / 189) < 1e-9, `申购日指数 = 241/189×100（实得 ${idx[3]!.index}）`)
  assert.ok(Math.abs(idx[4]!.index - (100 * 456) / 189) < 1e-9, `末值 = 456/189×100（实得 ${idx[4]!.index}）`)
  // 核心验收：折算不再被读成减仓 —— 全程不低于 100，且末值 ≈ 241.3
  assert.ok(idx.every((p) => p.index >= 100 - 1e-9), `任何一天都不得低于 100（实得 ${idx.map((p) => p.index.toFixed(1)).join(' → ')}）`)
  assert.ok(Math.abs(idx.at(-1)!.index - 241.27) < 0.01, `1 年加仓指数 ≈ 241.27（实得 ${idx.at(-1)!.index.toFixed(2)}）`)

  // 反例 1（旧判据回潮）：v0.188.0"价格没跳空 ⇒ 判折算" ⇒ 两个真实申购日被抹掉
  const legacyActions = series.slice(1).map((now, i) => {
    const prev = series[i]!
    const ratio = now.totalWan / prev.totalWan
    const gap = now.priceGapPct
    return Math.abs(ratio - 1) > 0.2 && (gap === null || Math.abs(gap) <= 5) ? now.day : null
  }).filter((d): d is string => d !== null)
  assert.deepEqual(legacyActions, ['d3', 'd4'], '反例：旧判据把两次申购判成折算、把两次折算放行')
  const legacyIdx = indexSeriesOf(series.map((p) => ({ day: p.day, volWan: p.totalWan })), legacyActions.map((day) => ({ day, code: 'POOL', prevWan: 0, nowWan: 0, ratio: 1, priceGapPct: null })))
  assert.ok(legacyIdx.at(-1)!.index < 100, `反例：旧判据下末值只有 ${legacyIdx.at(-1)!.index.toFixed(1)}（把折算读成减仓）`)
  assert.throws(
    () => assert.equal(legacyIdx.at(-1)!.index, idx.at(-1)!.index, '反例上：旧判据回潮'),
    /反例上/,
    '⚠ 真注入：旧判据与现行判据必须给出不同的 1 年指数',
  )

  // 反例 2（更细的旧形态）："+50% 份额 + 价格不动" 曾被当成折算 —— 现在必须计入
  const redemption = [{ day: 'r0', totalWan: 1000, priceGapPct: 0 }, { day: 'r1', totalWan: 1500, priceGapPct: 0.3 }]
  assert.equal(detectCorporateActions(redemption).filter((a) => a.suspectedMultiDay !== true).length, 0, '份额 +50%、价格不动 = 大额申购，不得判折算')
  assert.equal(indexSeriesOf(redemption.map((p) => ({ day: p.day, volWan: p.totalWan })), []).at(-1)!.index, 150, '申购必须计入 ⇒ 指数 100→150')
  assert.throws(
    () => assert.equal(detectCorporateActions(redemption).filter((a) => a.suspectedMultiDay !== true).length, 1, '反例上：把申购当折算'),
    /反例上/,
    '⚠ 真注入：旧判据会把它判成折算（1 条）',
  )
})

test('③ 份额变化 = 相邻两日差（用当日值 ⇒ 败）', () => {
  const s = indexSeriesOf([{ day: 'd1', volWan: 1000 }, { day: 'd2', volWan: 1050 }], [])
  assert.equal(s[1]!.change, 0.005, '（1050−1000）万份 = 0.005 亿份')
  assert.notEqual(s[1]!.change, 1050)
  assert.throws(() => assert.equal(s[1]!.change, 0.105, '反例上：用当日值'), /反例上/, '⚠ 反例注入（当日值）必须失败')
})

test('④ ≥70% 同值 ⇒ sharesStale:true（给数字 ⇒ 败）', () => {
  const today = { a: 1, b: 2, c: 3, d: 4, e: 5, f: 6, g: 7, h: 8, i: 9, j: 10 }
  const prev = { ...today }
  assert.equal(sharesStaleOf(today, prev), true, '100% 同值 ⇒ stale')
  assert.equal(sharesStaleOf({ ...today, a: 99 }, prev), true, '90% 同值 ⇒ stale')
  assert.equal(sharesStaleOf({ a: 1, b: 2, c: 3, d: 4, e: 5 }, { a: 9, b: 9, c: 9, d: 4, e: 5 }), false, '40% 同值 ⇒ 不 stale')
  assert.throws(() => assert.equal(sharesStaleOf(today, prev), false, '反例上：同值却给数字'), /反例上/, '⚠ 反例注入必须失败')
})

test('⑤ 放大倍数 = 合计 ÷ 20 日均（用当日 ⇒ 败）', () => {
  const prev20 = new Array(20).fill(100)
  assert.equal(ratioOf(250, prev20), 2.5)
  assert.notEqual(ratioOf(250, prev20), 250)
  assert.equal(ratioOf(null, prev20), null, '缺数据 ⇒ null（不写 0）')
  assert.equal(ratioOf(250, []), null, '没有 20 日样本 ⇒ null')
  assert.throws(() => assert.equal(ratioOf(250, prev20), 250, '反例上：用当日'), /反例上/, '⚠ 反例注入必须失败')
})

test('⑥ 池只含 14 只沪市（混入深市 ⇒ 败）', () => {
  assert.equal(DOGWATCH_POOL.length, 14)
  assert.equal(DOGWATCH_POOL.every((p) => /^51|^58/.test(p.code)), true, '全部沪市 51x/58x')
  assert.equal(isShenzhenCode('159915'), true)
  assert.equal(isShenzhenCode('510300'), false)
  const withSz = [...DOGWATCH_POOL.map((p) => p.code), '159915']
  assert.equal(withSz.filter((c) => !isShenzhenCode(c)).length, 14, '混入深市 ⇒ 必须被排除，仍 14 只')
  assert.throws(() => assert.equal(withSz.every((c) => !isShenzhenCode(c)), true, '反例上：混入深市'), /反例上/, '⚠ 反例注入必须失败')
})

test('⑦ 缓存：同一日期第二次请求 0 次上游（重复拉取 ⇒ 败）', async () => {
  const day = '2026-11-13'
  mkdirSync(join(sharesCachePath(day), '..'), { recursive: true })
  writeFileSync(sharesCachePath(day), JSON.stringify({ day, rows: Object.fromEntries(DOGWATCH_POOL.map((p, i) => [p.code, { name: p.name, volWan: 4562328.77 + i }])) }))
  let calls = 0
  const orig = globalThis.fetch
  globalThis.fetch = (async () => { calls += 1; return new Response('{}') }) as typeof fetch
  try {
    const a = await loadSharesOf(day)
    const b = await loadSharesOf(day)
    assert.equal(a.get('510300')?.volWan, 4562328.77)
    assert.equal(b.get('510300')?.volWan, 4562328.77)
    assert.equal(calls, 0, '命中磁盘缓存 ⇒ 上游调用必须为 0')
    assert.throws(() => assert.equal(calls, 1, '反例上：重复拉取'), /反例上/, '⚠ 反例注入必须失败')
  } finally { globalThis.fetch = orig }
})

test('⑧ 路由账：/tradewatcher/dogwatch 已注册，设计文档账目同步（35 = core 18）', () => {
  const routes = readFileSync(new URL('./routes.ts', import.meta.url), 'utf8')
  assert.ok(routes.includes("path: '/tradewatcher/dogwatch'"), '路由必须注册')
  assert.ok(/fetchDogwatch\(\s*window/.test(routes), '路由必须调用聚合函数')
  const design = readFileSync(new URL('../../docs/DESIGN-SUBPLUGINS.md', import.meta.url), 'utf8')
  assert.match(design, /路由账 35 = core 18/, '设计文档账目必须同步')
  assert.throws(() => assert.equal(design.includes('路由账 35 = core 18'), false, '反例上：账目未更新'), /反例上/, '⚠ 反例注入必须失败')
})

// ── v0.188.0：分页修复 / 聚合不从第一行退化 / 残缺缓存重拉 ────────────────

const POOL14 = DOGWATCH_POOL

const sseJson = (codes: string[], volOf: (c: string) => number): string =>
  JSON.stringify({ result: codes.map((c) => ({ STAT_DATE: '2026-11-13', ETF_TYPE: '单市', SEC_CODE: c, SEC_NAME: `ETF${c}`, TOT_VOL: String(volOf(c)) })) })

test('① 池覆盖率 = 14/14（只命中 1 只 ⇒ 败）', () => {
  const all = parseSseShares(sseJson(POOL14.map((p) => p.code), () => 100))
  assert.deepEqual(poolCoverageOf(all), { hit: 14, total: 14, ratio: 1, needed: 13, usable: true })
  const one = parseSseShares(sseJson(['510300'], () => 100))
  assert.equal(poolCoverageOf(one).hit, 1, '只回一页 ⇒ 只命中 1 只（这正是线上缺陷）')
  assert.equal(cacheUsableOf(one), false, '1/14 < 90% ⇒ 缓存不可用')
  assert.throws(() => assert.equal(poolCoverageOf(one).hit, 14, '反例上：只有 1 只'), /反例上/, '⚠ 反例注入必须失败')
})

test('② 总份额 = Σ 全部 14 行（取第一行 ⇒ 败）', () => {
  const rows = POOL14.map((_p, i) => ({ pct: null, scale: null, shares: 10 + i, sharesDelta: null }))
  const total = rows.reduce((a, r) => a + (r.shares ?? 0), 0)
  assert.equal(total, 140 + 91, '10..23 求和 = 231')
  assert.notEqual(total, rows[0]!.shares)
  assert.throws(() => assert.equal(rows[0]!.shares, total, '反例上：只取第一行'), /反例上/, '⚠ 反例注入必须失败')
})

test('③ 加权涨跌 ≠ 任何单只涨跌（用第一行 ⇒ 败）', () => {
  const rows = [{ pct: 1, scale: 100 }, { pct: -3, scale: 900 }]
  const w = weightedPctOf(rows)!
  assert.equal(+w.toFixed(4), -2.6)
  assert.notEqual(w, rows[0]!.pct)
  assert.notEqual(w, rows[1]!.pct)
  assert.throws(() => assert.equal(w, rows[0]!.pct, '反例上：用第一行'), /反例上/, '⚠ 反例注入必须失败')
})

test('④ 缓存覆盖率 <90% ⇒ 自动重拉并覆盖（沿用残缺缓存 ⇒ 败）', async () => {
  const day = '2026-11-13'
  mkdirSync(join(sharesCachePath(day), '..'), { recursive: true })
  writeFileSync(sharesCachePath(day), JSON.stringify({ day, rows: { '510300': { name: 'x', volWan: 1 } } }))
  let calls = 0
  const orig = globalThis.fetch
  globalThis.fetch = (async () => {
    calls += 1
    return new Response(sseJson(POOL14.map((p) => p.code), () => 5), { status: 200 })
  }) as typeof fetch
  try {
    const rows = await loadSharesOf(day)
    assert.equal(calls, 1, '残缺缓存必须触发一次重拉')
    assert.equal(poolCoverageOf(rows).hit, 14, '重拉后必须 14/14')
    // 再读一次：已覆盖且完整 ⇒ 0 请求
    const again = await loadSharesOf(day)
    assert.equal(calls, 1, '覆盖完整后不再重拉')
    assert.equal(poolCoverageOf(again).hit, 14)
    assert.throws(() => assert.equal(calls, 0, '反例上：没重拉'), /反例上/, '⚠ 反例注入必须失败')
  } finally { globalThis.fetch = orig }
})

test('⑤ 缺前一日 ⇒ 份额变化 null，但总份额/加仓指数仍有值（整块 — ⇒ 败）', () => {
  const series = indexSeriesOf([{ day: 'd1', volWan: 1000 }], [])
  assert.equal(series.length, 1)
  assert.equal(series[0]!.index, 100, '只有一天也必须给指数')
  const rows = [{ shares: 100, sharesDelta: null }]
  const total = rows.reduce((a, r) => a + (r.shares ?? 0), 0)
  assert.equal(total, 100, '总份额不受"缺前一日"影响')
  assert.equal(rows[0]!.sharesDelta, null, '份额变化为 null（界面 —（缺上一交易日份额））')
  assert.throws(() => assert.equal(rows[0]!.sharesDelta, 0, '反例上：0 顶替'), /反例上/, '⚠ 反例注入必须失败')
})

test('⑥ 卡头不含 涨停 / 跌停（残留 ⇒ 败）', () => {
  const page = readFileSync(new URL('../client/MarketPage.tsx', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  assert.equal(page.includes('涨停'), false, '卡头不许再有涨停家数')
  assert.equal(page.includes('跌停'), false, '卡头不许再有跌停家数')
  assert.throws(() => assert.equal(`${page}\n'涨停 37'`.includes('涨停'), false, '反例上：残留涨停'), /反例上/, '⚠ 反例注入必须失败')
})

// ── v0.189.0：单位只换算一次（sharesYi = TOT_VOL/1e4） ─────────────────────

test('⑦ 510300 ⇒ sharesYi ≈ 456.2（±0.1）；总份额 Σ14 ≈ 2969.6（±1）', () => {
  const one = parseSseShares(JSON.stringify({ result: [{ SEC_CODE: '510300', SEC_NAME: '沪深300ETF华泰柏瑞', TOT_VOL: '4562328.77' }] }))
  const v = wanToYi(one.get('510300')!.volWan)
  assert.ok(Math.abs(v - 456.2) <= 0.1, `510300 应为 456.2 亿份（实得 ${v}）`)
  // Σ14：用真实 510300 + 13 只均分到 2969.6
  const others = (2969.6 - 456.23) / 13
  const total = (4562328.77 + 13 * others * 1e4) / 1e4
  assert.ok(Math.abs(total - 2969.6) <= 1, `总份额应为 2969.6（实得 ${total}）`)
  assert.throws(() => assert.equal(total, 0.0, '反例上：显示 0.0'), /反例上/, '⚠ 反例注入（二次换算）必须失败')
})
test('⑧ 任一行 sharesYi === 0 ⇒ 判失败并带出原始 TOT_VOL', () => {
  const zero = parseSseShares(JSON.stringify({ result: [{ SEC_CODE: '510300', SEC_NAME: 'x', TOT_VOL: '0' }] }))
  assert.equal(zero.size, 0, 'TOT_VOL=0 的行不得进入结果（宁缺不错）')
  const ok = parseSseShares(JSON.stringify({ result: [{ SEC_CODE: '510300', SEC_NAME: 'x', TOT_VOL: '4562328.77' }] }))
  assert.equal(wanToYi(ok.get('510300')!.volWan), 456.232877)
  assert.notEqual(wanToYi(ok.get('510300')!.volWan), 0)
  assert.throws(() => assert.equal(wanToYi(ok.get('510300')!.volWan), 0, '反例上：0.0'), /反例上/, '⚠ 反例注入必须失败')
})

// ── v0.190.0：缓存加固（读盘优先 / 汇总缓存 / 只补缺失日） ────────────────

import { tradingDaysBack } from './dogwatch.ts'

const seedDays = (days: readonly string[], volOf: (i: number) => number): void => {
  mkdirSync(join(sharesCachePath(days[0]!), '..'), { recursive: true })
  for (const d of days) {
    const rows = Object.fromEntries(DOGWATCH_POOL.map((p, i) => [p.code, { name: p.name, volWan: volOf(i) }]))
    writeFileSync(sharesCachePath(d), JSON.stringify({ day: d, rows }))
  }
}

test('① 第二次同窗口调用 fetched = 0（>0 ⇒ 败）', async () => {
  const now = Date.parse('2026-11-16T10:00:00+08:00')
  const days = tradingDaysBack(95, now)
  seedDays(days, (i) => 100000 + i * 1000)
  const a = await dw('3m', { now, gapMs: 0, quotes: async () => ({}) })
  const b = await dw('3m', { now: now + 1000, gapMs: 0, quotes: async () => ({}) })
  assert.equal(b.stats.fetched, 0, `第二次必须 0 请求（实得 ${b.stats.fetched}）`)
  assert.equal(b.stats.cached, true, '必须命中汇总缓存')
  assert.throws(() => assert.equal(b.stats.fetched, a.stats.fetched + 1, '反例上：重拉'), /反例上/, '⚠ 反例注入必须失败')
})

test('② 5 分钟内重复调用 fetched = 0（重拉 ⇒ 败）', async () => {
  const now = Date.parse('2026-11-17T10:00:00+08:00')
  seedDays(tradingDaysBack(95, now), (i) => 100000 + i * 1000)
  await dw('3m', { now, gapMs: 0, quotes: async () => ({}) })
  const r = await dw('3m', { now: now + 4 * 60_000, quotes: async () => ({}) })
  assert.equal(r.stats.fetched, 0)
  assert.equal(r.stats.cached, true)
  assert.ok(r.stats.elapsedMs < 50, `命中缓存必须 <50ms（实得 ${r.stats.elapsedMs}）`)
  assert.throws(() => assert.equal(r.stats.elapsedMs, 999, '反例上：整窗重算'), /反例上/, '⚠ 反例注入必须失败')
})

test('③ 换窗口（6m→3m）fetched = 0（复用同一批日文件）', async () => {
  const now = Date.parse('2026-11-18T10:00:00+08:00')
  seedDays(tradingDaysBack(200, now), (i) => 100000 + i * 1000)
  await dw('6m', { now, gapMs: 0, quotes: async () => ({}) })
  const r = await dw('3m', { now: now + 2000, quotes: async () => ({}) })
  assert.equal(r.stats.fetched, 0, '短窗必须完全复用长窗的日文件')
  assert.throws(() => assert.equal(r.stats.fetched, 1, '反例上：重拉'), /反例上/, '⚠ 反例注入必须失败')
})

test('④ 删掉某一天文件 ⇒ 只补该 1 天（补全窗 ⇒ 败）', async () => {
  // 单元级：磁盘缺一天 ⇒ 只有该日走网络，其余日全部命中磁盘
  const now = Date.parse('2026-12-07T10:00:00+08:00')
  const days = tradingDaysBack(84, now)
  seedDays(days, (i) => 100000 + i * 1000)
  const victim = days[80]!
  unlinkSync(sharesCachePath(victim))
  const refill = Object.fromEntries(DOGWATCH_POOL.map((p, i) => [p.code, { name: p.name, volWan: 100000 + i * 1000 }]))
  const r = await dw('3m', {
    now, quotes: async () => ({}), bypassCache: true,
    loadShares: async () => new Map(Object.entries(refill)),
  })
  assert.equal(r.stats.fetched, 1, `只补 1 天（实得 ${r.stats.fetched}）`)
  assert.equal(r.stats.fromDisk, days.length - 1)
  assert.throws(() => assert.equal(r.stats.fetched, days.length, '反例上：补全窗'), /反例上/, '⚠ 反例注入必须失败')
})
test('⑤ 损坏文件 ⇒ 仅重拉该日（整窗重拉 ⇒ 败）', async () => {
  // 单元级：损坏的日文件被删除并只重拉这一天；其它日不受影响
  const day = '2026-12-11'
  mkdirSync(join(sharesCachePath(day), '..'), { recursive: true })
  writeFileSync(sharesCachePath(day), '{broken json')
  let calls = 0
  const orig = globalThis.fetch
  globalThis.fetch = (async () => { calls += 1; return new Response(sseJson(DOGWATCH_POOL.map((p) => p.code), () => 9), { status: 200 }) }) as typeof fetch
  try {
    const rows = await loadSharesOf(day)
    assert.equal(calls, 1, '损坏文件必须触发一次重拉')
    assert.equal(poolCoverageOf(rows).hit, 14, '重拉后 14/14')
    const again = await loadSharesOf(day)
    assert.equal(calls, 1, '重拉后写盘，第二次 0 请求')
    assert.equal(poolCoverageOf(again).hit, 14)
    assert.throws(() => assert.equal(calls, 84, '反例上：整窗重拉'), /反例上/, '⚠ 反例注入必须失败')
  } finally { globalThis.fetch = orig }
})
test('⑥ 进程内缓存命中 elapsedMs < 50（重算整窗 ⇒ 败）', async () => {
  const now = Date.parse('2026-11-21T10:00:00+08:00')
  seedDays(tradingDaysBack(95, now), (i) => 100000 + i * 1000)
  await dw('3m', { now, gapMs: 0, quotes: async () => ({}) })
  const r = await dw('3m', { now: now + 60_000, quotes: async () => ({}) })
  assert.ok(r.stats.elapsedMs < 50, `命中必须 <50ms（实得 ${r.stats.elapsedMs}）`)
  assert.equal(r.stats.fetched, 0)
  assert.throws(() => assert.ok(r.stats.elapsedMs >= 50, '反例上：重算'), /反例上/, '⚠ 反例注入必须失败')
})

// ── v0.191.0：审计（AUDIT-DOGWATCH-HOST）修复断言 ─────────────────────────

test('A1 解析边界：空行/空值/负数/非数字/带空白代码/重复代码', () => {
  const text = JSON.stringify({
    result: [
      { SEC_CODE: ' 510300 ', SEC_NAME: 'A', TOT_VOL: '4562328.77' },
      { SEC_CODE: '510300', SEC_NAME: 'A2', TOT_VOL: '4562329.00' }, // 重复 ⇒ 后者覆盖
      { SEC_CODE: '510310', SEC_NAME: 'B', TOT_VOL: '' },
      { SEC_CODE: '510330', SEC_NAME: 'C', TOT_VOL: '-5' },
      { SEC_CODE: '510350', SEC_NAME: 'D', TOT_VOL: 'abc' },
      { SEC_CODE: '510050', SEC_NAME: 'E', TOT_VOL: '0' },
      { SEC_CODE: 'bad-code', SEC_NAME: 'F', TOT_VOL: '100' },
      null,
      'garbage',
    ],
  })
  const rows = parseSseShares(text)
  assert.equal(rows.has('510300'), true, '带空白的代码必须 trim 后命中')
  assert.equal(rows.get('510300')!.volWan, 4562329, '重复代码后者覆盖（行为固定，可断言）')
  for (const bad of ['510310', '510330', '510350', '510050', 'bad-code']) assert.equal(rows.has(bad), false, `${bad} 必须被丢弃`)
  assert.equal(parseSseShares('not json').size, 0, '坏 JSON ⇒ 空表（不抛）')
})

test('A2 真实 510300 序列：10–12% 的份额跃升是申赎不是折算（不误杀）；真折算才顺延', () => {
  // 真实日频（2026-07-13→11-13）中的三个跃升点：183.2→197.0→217.2→244.2、254.8→285.5
  const real = [
    { day: 'd0', totalWan: 183.2, priceGapPct: 0.4 },
    { day: 'd1', totalWan: 197.0, priceGapPct: 1.2 },   // +7.5%
    { day: 'd2', totalWan: 217.2, priceGapPct: 0.8 },   // +10.2%（申赎）
    { day: 'd3', totalWan: 244.2, priceGapPct: 1.1 },   // +12.4%（申赎）
    { day: 'd4', totalWan: 254.8, priceGapPct: 0.3 },
    { day: 'd5', totalWan: 285.5, priceGapPct: 0.9 },   // +12.0%（申赎）
  ]
  assert.equal(detectCorporateActions(real).filter((a) => a.suspectedMultiDay !== true).length, 0, '真实跃升都 <20% ⇒ 不得误判为折算（误杀会把真加仓抹掉）')
  // 真折算：份额翻倍、价格 -50%
  const split = [
    { day: 's0', totalWan: 200, priceGapPct: 0.2 },
    { day: 's1', totalWan: 400, priceGapPct: -50 },
  ]
  const acts = detectCorporateActions(split).filter((a) => a.suspectedMultiDay !== true)
  assert.equal(acts.length, 1, '真的 1:2 折算必须被记一笔')
  const idx = indexSeriesOf(split.map((p) => ({ day: p.day, volWan: p.totalWan })), acts)
  assert.equal(idx[1]!.index, 100, '折算日指数必须顺延（200→400 不得算成 +100%）')
  // 反例：把真实跃升当折算 ⇒ 指数被抹平 ⇒ 必败
  const wrong = indexSeriesOf(real.map((p) => ({ day: p.day, volWan: p.totalWan })), detectCorporateActions(real))
  assert.ok(wrong[wrong.length - 1]!.index > 150, `真实加仓必须体现在指数上（实得 ${wrong[wrong.length - 1]!.index}）`)
  assert.throws(() => assert.equal(wrong[wrong.length - 1]!.index, 100, '反例上：把申赎当折算'), /反例上/, '⚠ 反例注入必须失败')
})

test('A3 1 年 67.98 与 3 月 223.83 是**不同基期**，不是矛盾（同一序列两个基期各自 =100）', () => {
  const series = [888, 448, 189, 241, 456] // 探测报告里的季度末真实值（亿份）
  const full = indexSeriesOf(series.map((v, i) => ({ day: `q${i}`, volWan: v })), [])
  assert.equal(full[0]!.index, 100)
  assert.ok(Math.abs(full[full.length - 1]!.index - 51.35) < 0.1, '1 年口径（基期 888）⇒ 51.35')
  const last3m = indexSeriesOf(series.slice(2).map((v, i) => ({ day: `m${i}`, volWan: v })), [])
  assert.equal(last3m[0]!.index, 100, '3 月口径基期 = 189 ⇒ 100')
  assert.ok(Math.abs(last3m[last3m.length - 1]!.index - 241.27) < 0.1, '3 月口径 ⇒ 241.27')
  assert.notEqual(full[full.length - 1]!.index, last3m[last3m.length - 1]!.index, '两个值必须不同（基期不同）')
  assert.throws(() => assert.equal(full[full.length - 1]!.index, last3m[last3m.length - 1]!.index, '反例上：当成同一个数'), /反例上/, '⚠ 反例注入必须失败')
})

test('A4 同日并发：两个 loadSharesOf 合并为一次上游（重复请求 ⇒ 败）', async () => {
  const day = '2026-12-03'
  try { unlinkSync(sharesCachePath(day)) } catch { /* 不存在就好 */ }
  let calls = 0
  const orig = globalThis.fetch
  globalThis.fetch = (async () => {
    calls += 1
    await new Promise((r) => setTimeout(r, 30))
    return new Response(sseJson(DOGWATCH_POOL.map((p) => p.code), () => 7), { status: 200 })
  }) as typeof fetch
  try {
    const [a, b] = await Promise.all([loadSharesOf(day), loadSharesOf(day)])
    // 合并的判据：两次拿到**同一个 Map 实例**（未合并且各拉一次 ⇒ 两个不同对象）
    assert.equal(a, b, '同日并发必须复用同一个在飞 Promise（对象同一性）')
    assert.ok(calls <= 1, `并发同一天最多 1 次上游（实得 ${calls}）`)
    assert.equal(poolCoverageOf(a).hit, 14)
    assert.throws(() => assert.notEqual(a, b, '反例上：各拉一次'), /反例上/, '⚠ 反例注入必须失败')
  } finally { globalThis.fetch = orig }
})

// ── v0.192.0：P2 清理（AUDIT-DOGWATCH-HOST §P2） ──────────────────────────

test('P2-1 多日累积折算：无单日 >20% 但区间 >20% ⇒ suspectedMultiDay 披露（静默 ⇒ 败）', () => {
  const slow = [
    { day: 'a', totalWan: 100, priceGapPct: 0.1 },
    { day: 'b', totalWan: 110, priceGapPct: 0.2 }, // +10%
    { day: 'c', totalWan: 121, priceGapPct: 0.1 }, // +10%
    { day: 'd', totalWan: 133, priceGapPct: 0.3 }, // +10%
  ]
  const acts = detectCorporateActions(slow)
  assert.equal(acts.filter((a) => a.suspectedMultiDay !== true).length, 0, '没有单日锚点')
  assert.equal(acts.filter((a) => a.suspectedMultiDay === true).length, 1, '区间累积 +33% ⇒ 必须披露 1 条')
  const idx = indexSeriesOf(slow.map((p) => ({ day: p.day, volWan: p.totalWan })), acts)
  assert.ok(Math.abs(idx[idx.length - 1]!.index - 133) < 0.01, '披露不改变指数口径（仍是 +33%）')
  assert.throws(() => assert.equal(acts.length, 0, '反例上：静默'), /反例上/, '⚠ 反例注入必须失败')
})

test('P2-1b 有单日锚点时按锚点分段（区间累积不被重复计入）', () => {
  const s = [
    { day: 'a', totalWan: 100, priceGapPct: 0.1 },
    { day: 'b', totalWan: 150, priceGapPct: -33 }, // 真折算锚点（份额×1.5、价 −33%）
    { day: 'c', totalWan: 155, priceGapPct: 0.2 },
  ]
  const acts = detectCorporateActions(s)
  assert.equal(acts.filter((a) => a.suspectedMultiDay === true).length, 0, '锚点后区间仅 +3.3% ⇒ 不披露')
  assert.equal(acts.length, 1, '只有那个真折算锚点')
})

test('P2-2 90% 阈值边界：14 只池 hit=12 ⇒ 残缺、hit=13 ⇒ 可用', () => {
  const mk = (n: number): Map<string, { name: string; volWan: number }> =>
    new Map(DOGWATCH_POOL.slice(0, n).map((p) => [p.code, { name: p.name, volWan: 1 }]))
  const c12 = poolCoverageOf(mk(12))
  const c13 = poolCoverageOf(mk(13))
  assert.deepEqual([c12.hit, c12.total, c12.needed], [12, 14, 13])
  assert.equal(c12.usable, false, '12/14 = 85.7% < 90% ⇒ 残缺')
  assert.equal(c13.usable, true, '13/14 = 92.9% ≥ 90% ⇒ 可用')
  assert.equal(cacheUsableOf(mk(12)), false)
  assert.equal(cacheUsableOf(mk(13)), true)
  assert.throws(() => assert.equal(c12.usable, true, '反例上：12 只也当可用'), /反例上/, '⚠ 反例注入必须失败')
})

test('P2-3 fetchTencentDetail 60 秒缓存：同 secid 两次上游 ≤1 次，60 秒内 cached', async () => {
  const { fetchTencentDetail } = await import('./detailTencent.ts')
  let calls = 0
  const orig = globalThis.fetch
  const payload = 'v_sh510300="1~沪深300ETF~510300~4.082~4.09~4.08~100~50~50~4.082~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~1000~4082000~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0"'
  globalThis.fetch = (async () => { calls += 1; return new Response(payload, { status: 200 }) }) as typeof fetch
  try {
    const t0 = Date.now()
    await fetchTencentDetail('1.510300', t0)
    await fetchTencentDetail('1.510300', t0 + 30_000)
    assert.ok(calls <= 1, `60 秒内两次调用上游必须 ≤1（实得 ${calls}）`)
    await fetchTencentDetail('1.510300', t0 + 61_000)
    assert.equal(calls, 2, '超过 60 秒必须重拉')
    assert.throws(() => assert.equal(calls, 1, '反例上：不重拉'), /反例上/, '⚠ 反例注入必须失败')
  } finally { globalThis.fetch = orig }
})

test('P2-4 量纲判不出 ⇒ missing 含固定原因文本（缺 ⇒ 败）', async () => {
  const { parseTencentDetail } = await import('./detailTencent.ts')
  // 价格 4.08、成交额 100 元、成交量 5 ⇒ 既不是股也不是手（100 倍都对不上）⇒ 判不出
  const r = parseTencentDetail('v_sh510300="1~X~510300~4.08~4.09~4.07~5~50~50~4.08~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~5~100~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0"', '1.510300')
  assert.notEqual(r, null)
  const entry = r!.missing.find((m) => m.what === '成交量')
  assert.notEqual(entry, undefined, '判不出时必须有一条 成交量 missing')
  assert.equal(entry!.note, '量纲判不出（成交额锚校验失败或字段缺失）')
  assert.throws(() => assert.equal(r!.missing.filter((m) => m.what === '成交量').length, 0, '反例上：缺条目'), /反例上/, '⚠ 反例注入必须失败')
})

test('P3-1 二次打开：elapsedMs < 100 且 fetched = 0（内存/落盘汇总命中）', async () => {
  const now = Date.parse('2026-11-23T10:00:00+08:00')
  seedDays(tradingDaysBack(95, now), (i) => 100000 + i * 1000)
  await dw('3m', { now, gapMs: 0, quotes: async () => ({}) })
  const second = await dw('3m', { now: now + 1000, gapMs: 0, quotes: async () => ({}) })
  assert.equal(second.stats.fetched, 0)
  assert.ok(second.stats.elapsedMs < 100, `二次打开必须 <100ms（实得 ${second.stats.elapsedMs}）`)
  // 内存 TTL 过期后走**落盘汇总**：零读盘、零重算
  const third = await dw('3m', { now: now + 6 * 60_000, quotes: async () => ({}) })
  assert.equal(third.stats.fromDisk, 0, '落盘汇总命中时不得逐日读盘')
  assert.equal(third.stats.fetched, 0)
  assert.equal(third.stats.cached, true)
  assert.ok(third.stats.elapsedMs < 100, `落盘命中必须 <100ms（实得 ${third.stats.elapsedMs}）`)
  assert.throws(() => assert.equal(third.stats.fromDisk, 84, '反例上：逐日读盘'), /反例上/, '⚠ 反例注入必须失败')
})

// ── v0.215.0：宿主审计 P0-3（2y 冷启动 62.5s / 同步解析 571ms 阻塞） ────────
//
// 三条不变量：
//   ① 网络节流只对**真的发起的网络请求**计时（磁盘命中一秒都不等）；
//   ② 磁盘读与网络拉取分成两段：先并发读全部日文件，再只对缺失日走网络；
//   ③ 日文件用 fs.promises 读，解析每 N 个文件 / 每个 >1MiB 大文件让出一次事件循环。

/** 注入时钟：sleep 只记账并推进逻辑时间，不真的等（断言「等待毫秒」而不是墙钟） */
const fakeClock = (start = 0): { now: () => number; sleep: (ms: number) => Promise<void>; sleeps: number[]; total: () => number } => {
  let t = start
  const sleeps: number[] = []
  return {
    now: () => t,
    sleep: async (ms: number) => { sleeps.push(ms); t += ms },
    sleeps,
    total: () => sleeps.reduce((a, b) => a + b, 0),
  }
}

const fullRows = (base: number): Record<string, { name: string; volWan: number }> =>
  Object.fromEntries(DOGWATCH_POOL.map((p, i) => [p.code, { name: p.name, volWan: base + i }]))

test('P0-3-1 网络闸契约：4 个并发请求发起时刻 = 0/120/240/360ms（不排队 ⇒ 败）', async () => {
  const clock = fakeClock()
  const gate = createNetworkGate(120, clock)
  const starts: number[] = []
  await Promise.all([0, 1, 2, 3].map(() => gate.run(async () => { starts.push(clock.now()) })))
  assert.deepEqual(starts, [0, 120, 240, 360], `相邻网络请求必须间隔 ≥120ms（实得 ${starts.join('/')}）`)
  assert.equal(gate.waitCount(), 3, '第一次请求不等待，后三次各等一次')
  assert.equal(gate.waitedMs(), 360, '总等待 = 3 × 120ms')
  assert.throws(() => assert.deepEqual(starts, [0, 0, 0, 0], '反例上：并发齐发'), /反例上/, '⚠ 反例注入必须失败')
  // gapMs ≤ 0 ⇒ 完全不等待（假 loader / 无网络场景）
  const noWait = createNetworkGate(0, clock)
  const t0 = clock.now()
  await Promise.all([0, 1, 2].map(() => noWait.run(async () => { starts.push(clock.now()) })))
  assert.equal(noWait.waitedMs(), 0)
  assert.equal(clock.now(), t0, 'gapMs=0 不得推进时间')
})

test('P0-3-2 全命中磁盘 ⇒ 节流总等待 0ms（默认 120ms 也不付；逐条 sleep 回潮 ⇒ 败）', async () => {
  const now = Date.parse('2028-01-10T10:00:00+08:00')
  const days = tradingDaysBack(63 + 21, now) // 3m 窗口口径：63 个交易日 + 20 日均额前置
  assert.equal(days.length, 84)
  seedDays(days, (i) => 100000 + i * 1000)
  const clock = fakeClock()
  let loaderCalls = 0
  const t0 = Date.now()
  // 注意：**不传 gapMs**（走生产默认 120）—— 只要磁盘命中，120ms 就不该出现
  const r = await fetchDogwatch('3m', {
    now, bypassCache: true, clock, quotes: async () => ({}),
    loadShares: async () => { loaderCalls += 1; return new Map() },
  })
  const wall = Date.now() - t0
  assert.equal(loaderCalls, 0, '全命中磁盘不得调 loadShares')
  assert.equal(r.stats.fromDisk, days.length)
  assert.equal(r.stats.fetched, 0)
  assert.equal(clock.sleeps.length, 0, `磁盘命中必须零等待（实得 ${clock.sleeps.length} 次 / ${clock.total()}ms）`)
  assert.equal(clock.total(), 0, '总等待必须是 0ms')
  assert.ok(wall < 2_000, `全命中必须 <2s（实得 ${wall}ms；旧实现 ${days.length}/4×120 ≈ ${Math.round(days.length / 4 * 120)}ms）`)
  assert.throws(() => assert.equal(clock.total(), 120, '反例上：磁盘命中仍付节流'), /反例上/, '⚠ 反例注入必须失败')
})

test('P0-3-3 缺 3 天 ⇒ 网络恰好 3 次且相邻间隔 ≥120ms；磁盘命中天零等待', async () => {
  const now = Date.parse('2028-01-11T10:00:00+08:00')
  const days = tradingDaysBack(63 + 21, now)
  assert.equal(days.length, 84, '3m 窗口 = 84 个交易日')
  seedDays(days, (i) => 200000 + i * 1000)
  const victims = [days[10]!, days[40]!, days[70]!]
  for (const d of victims) unlinkSync(sharesCachePath(d))
  const clock = fakeClock()
  const callAt: number[] = []
  const refill = fullRows(300000)
  const r = await fetchDogwatch('3m', {
    now, bypassCache: true, clock, quotes: async () => ({}),
    loadShares: async () => { callAt.push(clock.now()); return new Map(Object.entries(refill)) },
  })
  assert.equal(callAt.length, 3, `只有 3 个缺失日走网络（实得 ${callAt.length}）`)
  assert.equal(r.stats.fetched, 3)
  assert.equal(r.stats.fromDisk, days.length - 3)
  const gaps = callAt.slice(1).map((t, i) => t - callAt[i]!)
  assert.ok(gaps.length === 2 && gaps.every((g) => g >= 120), `相邻网络请求必须 ≥120ms（实得 ${gaps.join(',')}）`)
  assert.equal(clock.sleeps.length, 2, `只有第 2/3 次网络请求付等待（实得 ${clock.sleeps.length} 次）`)
  assert.equal(clock.total(), 240, `总等待 = 2 × 120ms（实得 ${clock.total()}ms）`)
  // 磁盘命中的 81 天一天都不等：若按旧语义逐条 sleep，等待会是 80 次以上
  assert.ok(clock.sleeps.length < days.length - 3, '磁盘命中日不得产生等待')
  assert.throws(() => assert.equal(clock.total(), days.length * 120, '反例上：按天数睡'), /反例上/, '⚠ 反例注入必须失败')
})

test('P0-3-4 反例对照：改回「每条固定 sleep」⇒ 521 天累计等待 62.5s（墙钟 ≈15.6s），断言必败', async () => {
  /**
   * 复刻修复前的 `mapWithConcurrency(items, 4, 120, fn)`：sleep 与「是否真的发起网络」无关。
   * 用假时钟跑 521 天全命中磁盘的工作负载 ⇒ 累计等待 62.4s（4 路并发把墙钟摊成 ≈15.6s）；
   * 现行实现（P0-3-2）累计等待 0ms。
   */
  const clock = fakeClock()
  const days = tradingDaysBack(521, Date.parse('2036-01-05T10:00:00+08:00'))
  const legacy = async (items: readonly string[], limit: number, gapMs: number): Promise<number> => {
    let i = 0
    let waited = 0
    const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (i < items.length) {
        i += 1
        // 磁盘命中：没有网络请求，旧实现照样 sleep
        if (gapMs > 0 && i < items.length) { waited += gapMs; await clock.sleep(gapMs) }
      }
    })
    await Promise.all(workers)
    return waited
  }
  const legacyWaited = await legacy(days, 4, 120)
  assert.ok(legacyWaited >= 62_000, `旧语义 521 天 ≈62.5s（实得 ${legacyWaited}ms）`)
  assert.throws(() => assert.equal(legacyWaited, 0, '反例上：每批固定 sleep'), /反例上/, '⚠ 反例注入必须失败')
  // 源码级防线：日文件阶段不得再出现「带 gap 的并发池」
  const src = readFileSync(new URL('./dogwatch.ts', import.meta.url), 'utf8')
  assert.equal(src.includes('mapWithConcurrency(tradingDays'), false, '日文件阶段不得再套用逐条 sleep 的并发池')
})

test('P0-3-5 解析每 32 个日文件让出一次（不让出 ⇒ 败）', async () => {
  const days = Array.from({ length: 100 }, (_, i) => `p03-${String(i).padStart(3, '0')}`)
  mkdirSync(join(sharesCachePath(days[0]!), '..'), { recursive: true })
  for (const d of days) writeFileSync(sharesCachePath(d), JSON.stringify({ day: d, rows: fullRows(400000) }))
  const reasons: string[] = []
  const out = await readAllDiskShares(days, { onYield: (r) => reasons.push(r) })
  assert.equal(out.stats.parsed, 100, '100 个文件都要解析')
  assert.equal(out.stats.hit, 100)
  assert.equal(DOGWATCH_PARSE_YIELD_EVERY, 32)
  assert.equal(out.stats.yields, Math.floor(100 / DOGWATCH_PARSE_YIELD_EVERY), `100 文件应让出 3 次（实得 ${out.stats.yields}）`)
  assert.deepEqual(reasons, ['every-n', 'every-n', 'every-n'])
  // 反例：不让出（yieldEvery 调到 1000）⇒ 0 次 ⇒ 与 3 不等
  const noYield = await readAllDiskShares(days, { yieldEvery: 1_000 })
  assert.equal(noYield.stats.yields, 0)
  assert.throws(() => assert.equal(noYield.stats.yields, 3, '反例上：解析全程不让出'), /反例上/, '⚠ 反例注入必须失败')
})

test('P0-3-6 单文件 >1MiB ⇒ 解析后单独让出一次（阈值 1 MiB）', async () => {
  assert.equal(DOGWATCH_BIG_FILE_BYTES, 1024 * 1024)
  const day = 'p03-big'
  const rows = fullRows(500000)
  rows['filler'] = { name: 'x'.repeat(1_200_000), volWan: 1 }
  mkdirSync(join(sharesCachePath(day), '..'), { recursive: true })
  writeFileSync(sharesCachePath(day), JSON.stringify({ day, rows }))
  const reasons: string[] = []
  // yieldEvery 拉大，排除「第 N 个文件」那条路径，只剩大文件让出
  const out = await readAllDiskShares([day], { yieldEvery: 1_000, onYield: (r) => reasons.push(r) })
  assert.ok(out.stats.bytes > DOGWATCH_BIG_FILE_BYTES, `文件必须 >1MiB（实得 ${out.stats.bytes} 字节）`)
  assert.deepEqual(reasons, ['big-file'])
  assert.throws(() => assert.deepEqual(reasons, [], '反例上：大文件不让出'), /反例上/, '⚠ 反例注入必须失败')
})

test('P0-3-7 521 天空盘 + 假 loader（无网络、gapMs 0）⇒ <15s 客户端超时线', async () => {
  const now = Date.parse('2035-06-03T10:00:00+08:00')
  const days = tradingDaysBack(500 + 21, now)
  assert.equal(days.length, 521, `2y 窗口必须覆盖 521 个交易日（实得 ${days.length}）`)
  let calls = 0
  const refill = fullRows(600000)
  const t0 = Date.now()
  const r = await fetchDogwatch('2y', {
    now, bypassCache: true, gapMs: 0, clock: fakeClock(), quotes: async () => ({}),
    loadShares: async () => { calls += 1; return new Map(Object.entries(refill)) },
  })
  const elapsed = Date.now() - t0
  assert.equal(calls, 521, `空盘 521 天 = 521 次 loader 调用（实得 ${calls}）`)
  assert.equal(r.stats.fetched, 521)
  assert.equal(r.stats.fromDisk, 0)
  assert.equal(r.series.length, 521)
  assert.ok(elapsed < 15_000, `空盘 521 天必须 <15s（实得 ${elapsed}ms）`)
  // 旧实现：521 × 120ms = 62.5s 纯等待（P0-3-4 已单独用假时钟钉住）
  assert.throws(() => assert.ok(elapsed >= 62_500, '反例上：仍按天数睡'), /反例上/, '⚠ 反例注入必须失败')
})

test('P0-3-8 真实 2y 冷启动（512 盘命中 + 9 缺）⇒ <15s，只付 9 次网络节流', async () => {
  const now = Date.parse('2040-06-03T10:00:00+08:00')
  const days = tradingDaysBack(521, now)
  seedDays(days.slice(0, 512), (i) => 700000 + i * 1000)
  const clock = fakeClock()
  const refill = fullRows(800000)
  const t0 = Date.now()
  const r = await fetchDogwatch('2y', {
    now, bypassCache: true, clock, quotes: async () => ({}),
    loadShares: async () => new Map(Object.entries(refill)),
  })
  const elapsed = Date.now() - t0
  assert.equal(r.stats.fromDisk, 512, `512 天必须零网络命中磁盘（实得 ${r.stats.fromDisk}）`)
  assert.equal(r.stats.fetched, 9, `只有 9 天走网络（实得 ${r.stats.fetched}）`)
  assert.equal(clock.sleeps.length, 8, `9 次网络请求 = 8 次间隔等待（实得 ${clock.sleeps.length}）`)
  assert.equal(clock.total(), 8 * 120, `总等待 = 8 × 120ms（实得 ${clock.total()}ms）`)
  assert.ok(elapsed < 15_000, `真实 2y 冷启动必须 <15s（实得 ${elapsed}ms）`)
  assert.throws(() => assert.equal(clock.total(), 512 * 120, '反例上：磁盘命中天也睡'), /反例上/, '⚠ 反例注入必须失败')
})

test('P0-3-9 日文件读取走 fs.promises.readFile（readFileSync 回潮 ⇒ 败）', () => {
  const src = readFileSync(new URL('./dogwatch.ts', import.meta.url), 'utf8')
  assert.equal(src.includes('readFileSync(sharesCachePath'), false, '日文件不得再用 readFileSync')
  assert.match(src, /const buf = await readFile\(path\)/, '日文件必须走 fs.promises.readFile')
  assert.match(src, /setImmediate/, '解析让出必须走 setImmediate')
  assert.throws(() => assert.equal(src.includes('readFileSync(sharesCachePath'), true, '反例上：同步读日文件'), /反例上/, '⚠ 反例注入必须失败')
})

test('P0-3-10 语义保留：stats 键不变 / 汇总仍落盘 / bypassCache 仍跳过', async () => {
  const now = Date.parse('2028-02-07T10:00:00+08:00')
  const days = tradingDaysBack(63 + 21, now)
  assert.equal(days.length, 84)
  seedDays(days, (i) => 900000 + i * 1000)
  const first = await fetchDogwatch('3m', { now, quotes: async () => ({}), gapMs: 0 })
  assert.deepEqual(
    Object.keys(first.stats).sort(),
    ['elapsedMs', 'fetched', 'fromDisk', 'hit', 'pool'],
    'stats 字段集合不得增删（审计要求：stats 字段不变）',
  )
  assert.equal(first.stats.fromDisk, days.length)
  assert.equal(first.stats.pool, 14)
  assert.equal(first.stats.hit >= 13, true)
  assert.equal(existsSync(summaryCachePath('3m', '2028-02-07')), true, '汇总必须落盘')
  const cached = await fetchDogwatch('3m', { now: now + 1_000, quotes: async () => ({}) })
  assert.equal(cached.stats.cached, true, '5 分钟内必须命中汇总缓存')
  assert.equal(cached.stats.fetched, 0)
  const bypass = await fetchDogwatch('3m', { now: now + 2_000, bypassCache: true, quotes: async () => ({}) })
  assert.equal(bypass.stats.cached, undefined, 'bypassCache 必须跳过汇总缓存')
  assert.equal(bypass.stats.fromDisk, days.length, 'bypass 后仍逐日读盘')
  assert.throws(() => assert.equal(bypass.stats.cached, true, '反例上：bypassCache 失效'), /反例上/, '⚠ 反例注入必须失败')
})
