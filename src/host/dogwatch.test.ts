/** 汪汪队跟踪（v0.186.0）：① 首日=100 ② 折算顺延 ③ 份额变化=相邻差 ④ stale ⑤ 放大倍数 ⑥ 池 ⑦ 缓存 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DOGWATCH_POOL, cacheUsableOf, fetchDogwatch, wanToYi, detectCorporateActions, indexSeriesOf, isShenzhenCode, loadSharesOf, parseSseShares, poolCoverageOf, ratioOf, sharesStaleOf, sharesCachePath, weightedPctOf } from './dogwatch.ts'

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

  const actions = detectCorporateActions(series)
  assert.deepEqual(actions.map((a) => a.day), ['d1', 'd2'], '只有两个折算日（888→448、448→189）')
  assert.equal(actions[0]!.ratio, 448 / 888)
  assert.notEqual(detectCorporateActions(series, { threshold: 0.5 }).length, 2, '阈值 50% 时 888→448(−49.5%) 不该命中 ⇒ 说明阈值真的生效')

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
  assert.equal(detectCorporateActions(redemption).length, 0, '份额 +50%、价格不动 = 大额申购，不得判折算')
  assert.equal(indexSeriesOf(redemption.map((p) => ({ day: p.day, volWan: p.totalWan })), []).at(-1)!.index, 150, '申购必须计入 ⇒ 指数 100→150')
  assert.throws(
    () => assert.equal(detectCorporateActions(redemption).length, 1, '反例上：把申购当折算'),
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
  assert.deepEqual(poolCoverageOf(all), { hit: 14, total: 14, ratio: 1 })
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
  const a = await fetchDogwatch('3m', { now, quotes: async () => ({}) })
  const b = await fetchDogwatch('3m', { now: now + 1000, quotes: async () => ({}) })
  assert.equal(b.stats.fetched, 0, `第二次必须 0 请求（实得 ${b.stats.fetched}）`)
  assert.equal(b.stats.cached, true, '必须命中汇总缓存')
  assert.throws(() => assert.equal(b.stats.fetched, a.stats.fetched + 1, '反例上：重拉'), /反例上/, '⚠ 反例注入必须失败')
})

test('② 5 分钟内重复调用 fetched = 0（重拉 ⇒ 败）', async () => {
  const now = Date.parse('2026-11-17T10:00:00+08:00')
  seedDays(tradingDaysBack(95, now), (i) => 100000 + i * 1000)
  await fetchDogwatch('3m', { now, quotes: async () => ({}) })
  const r = await fetchDogwatch('3m', { now: now + 4 * 60_000, quotes: async () => ({}) })
  assert.equal(r.stats.fetched, 0)
  assert.equal(r.stats.cached, true)
  assert.ok(r.stats.elapsedMs < 50, `命中缓存必须 <50ms（实得 ${r.stats.elapsedMs}）`)
  assert.throws(() => assert.equal(r.stats.elapsedMs, 999, '反例上：整窗重算'), /反例上/, '⚠ 反例注入必须失败')
})

test('③ 换窗口（6m→3m）fetched = 0（复用同一批日文件）', async () => {
  const now = Date.parse('2026-11-18T10:00:00+08:00')
  seedDays(tradingDaysBack(200, now), (i) => 100000 + i * 1000)
  await fetchDogwatch('6m', { now, quotes: async () => ({}) })
  const r = await fetchDogwatch('3m', { now: now + 2000, quotes: async () => ({}) })
  assert.equal(r.stats.fetched, 0, '短窗必须完全复用长窗的日文件')
  assert.throws(() => assert.equal(r.stats.fetched, 1, '反例上：重拉'), /反例上/, '⚠ 反例注入必须失败')
})

test('④ 删掉某一天文件 ⇒ 只补该 1 天（补全窗 ⇒ 败）', async () => {
  const now = Date.parse('2026-11-19T10:00:00+08:00')
  const days = tradingDaysBack(95, now)
  seedDays(days, (i) => 100000 + i * 1000)
  const refill0 = Object.fromEntries(DOGWATCH_POOL.map((p, i) => [p.code, { name: p.name, volWan: 100000 + i * 1000 }]))
  await fetchDogwatch('3m', { now, quotes: async () => ({}), loadShares: async () => new Map(Object.entries(refill0)) })
  const victim = tradingDaysBack(84, now)[10]!
  unlinkSync(sharesCachePath(victim))
  const refill = Object.fromEntries(DOGWATCH_POOL.map((p, i) => [p.code, { name: p.name, volWan: 100000 + i * 1000 }]))
  const r = await fetchDogwatch('3m', { now: now + 6 * 60_000, quotes: async () => ({}), loadShares: async () => new Map(Object.entries(refill)) })
  assert.equal(r.stats.fetched, 1, `只补 1 天（实得 ${r.stats.fetched}）`)
  assert.equal(r.stats.fromDisk, tradingDaysBack(84, now).length - 1, `其余日必须全部命中磁盘（实得 ${r.stats.fromDisk}）`)
  assert.throws(() => assert.equal(r.stats.fetched, days.length, '反例上：补全窗'), /反例上/, '⚠ 反例注入必须失败')
})

test('⑤ 损坏文件 ⇒ 仅重拉该日（整窗重拉 ⇒ 败）', async () => {
  const now = Date.parse('2026-11-20T10:00:00+08:00')
  const days = tradingDaysBack(95, now)
  seedDays(days, (i) => 100000 + i * 1000)
  const refill0b = Object.fromEntries(DOGWATCH_POOL.map((p, i) => [p.code, { name: p.name, volWan: 100000 + i * 1000 }]))
  await fetchDogwatch('3m', { now, quotes: async () => ({}), loadShares: async () => new Map(Object.entries(refill0b)) })
  writeFileSync(sharesCachePath(tradingDaysBack(84, now)[20]!), '{broken json')
  const refill2 = Object.fromEntries(DOGWATCH_POOL.map((p, i) => [p.code, { name: p.name, volWan: 100000 + i * 1000 }]))
  const r = await fetchDogwatch('3m', { now: now + 6 * 60_000, quotes: async () => ({}), loadShares: async () => new Map(Object.entries(refill2)) })
  assert.equal(r.stats.fetched, 1, '损坏只影响该日')
  assert.throws(() => assert.equal(r.stats.fetched, days.length, '反例上：整窗重拉'), /反例上/, '⚠ 反例注入必须失败')
})

test('⑥ 进程内缓存命中 elapsedMs < 50（重算整窗 ⇒ 败）', async () => {
  const now = Date.parse('2026-11-21T10:00:00+08:00')
  seedDays(tradingDaysBack(95, now), (i) => 100000 + i * 1000)
  await fetchDogwatch('3m', { now, quotes: async () => ({}) })
  const r = await fetchDogwatch('3m', { now: now + 60_000, quotes: async () => ({}) })
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
  assert.equal(detectCorporateActions(real).length, 0, '真实跃升都 <20% ⇒ 不得误判为折算（误杀会把真加仓抹掉）')
  // 真折算：份额翻倍、价格 -50%
  const split = [
    { day: 's0', totalWan: 200, priceGapPct: 0.2 },
    { day: 's1', totalWan: 400, priceGapPct: -50 },
  ]
  const acts = detectCorporateActions(split)
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
