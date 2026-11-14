/** 汪汪队跟踪（v0.186.0）：① 首日=100 ② 折算顺延 ③ 份额变化=相邻差 ④ stale ⑤ 放大倍数 ⑥ 池 ⑦ 缓存 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DOGWATCH_POOL, detectCorporateActions, indexSeriesOf, isShenzhenCode, loadSharesOf, ratioOf, sharesStaleOf, sharesCachePath } from './dogwatch.ts'

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
  writeFileSync(sharesCachePath(day), JSON.stringify({ day, rows: { '510300': { name: '沪深300ETF华泰柏瑞', volWan: 4562328.77 } } }))
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
