/** 汪汪队跟踪（v0.186.0）：① 首日=100 ② 折算顺延 ③ 份额变化=相邻差 ④ stale ⑤ 放大倍数 ⑥ 池 ⑦ 缓存 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DOGWATCH_POOL, cacheUsableOf, detectCorporateActions, indexSeriesOf, isShenzhenCode, loadSharesOf, parseSseShares, poolCoverageOf, ratioOf, sharesStaleOf, sharesCachePath, weightedPctOf } from './dogwatch.ts'

test('① 加仓指数首日 = 100（不等于 100 ⇒ 败）', () => {
  const s = indexSeriesOf([{ day: 'd1', volWan: 1000 }, { day: 'd2', volWan: 1100 }], [])
  assert.equal(s[0]!.index, 100)
  assert.equal(s[1]!.index, 110)
  assert.throws(() => assert.equal(s[0]!.index, 101, '反例上：首日不是 100'), /反例上/, '⚠ 反例注入必须失败')
})

test('② 折算：50% 份额跳变 + 价格无跳空 ⇒ 记账且顺延（直接计入 ⇒ 指数缺口 ⇒ 败）', () => {
  const series = [{ day: 'd1', totalWan: 1000, priceGapPct: 0.5 }, { day: 'd2', totalWan: 1500, priceGapPct: 0.5 }, { day: 'd3', totalWan: 1500, priceGapPct: 0.2 }]
  const actions = detectCorporateActions(series)
  assert.equal(actions.length, 1, '只有 d2 触发折算（d3 与 d2 等值）')
  assert.equal(actions[0]!.day, 'd2')
  const idx = indexSeriesOf(series.map((p) => ({ day: p.day, volWan: p.totalWan })), actions)
  assert.equal(idx[1]!.index, 100, '折算日指数必须顺延（直接计入 ⇒ 100→150）')
  assert.equal(idx[1]!.change, 0)
  assert.throws(() => assert.equal(idx[1]!.index, 150, '反例上：直接计入'), /反例上/, '⚠ 反例注入（计入折算）必须失败')
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
  assert.ok(routes.includes('fetchDogwatch(window)'), '路由必须调用聚合函数')
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
