/**
 * 分时均价回填（VWAP）的断言（AUDIT-VWAP）：逐点累计、精确/近似两条口径、零量沿用、做T 可用性。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { backfillTrendAvg, lastAvgOf } from './trendVwap.ts'
import { tWindowOf } from '../client/tWindowView.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const read = (p: string): string => readFileSync(join(HERE, '..', 'host', p), 'utf8')

const bar = (t: number, price: number, vol: number | null, amount: number | null = null, high: number | null = null, low: number | null = null) =>
  ({ t, price, vol, amount, high, low, avg: null })

test('① 有 amount ⇒ 逐点累计 Σamount ÷ Σvolume（用最后一根单点算 ⇒ 必败）', () => {
  const r = backfillTrendAvg([
    bar(1, 10, 100, 1000),
    bar(2, 11, 200, 2200),
    bar(3, 12, 300, 3600),
  ])
  const last = r.points[2]?.avg as number
  assert.ok(Math.abs(last - 6800 / 600) < 1e-9, `末点 avg 必须 = 6800/600 = 11.333（实际 ${last}）`)
  assert.equal(r.approx, false, '④ 有成交额 ⇒ 精确，不得标近似')
  // 反例注入：只拿最后一根算 ⇒ 3600/300 = 12 ⇒ 必败
  assert.throws(() => assert.equal(3600 / 300, last, '反例上：单点算不等于累计'), /反例上/, '⚠ 反例注入（单点）必须失败')
})

test('② 无 amount ⇒ 典型价加权（写死 close ⇒ 必败）', () => {
  const r = backfillTrendAvg([
    bar(1, 10, 100, null, 12, 9),   // 典型 31/3 ≈ 10.333
    bar(2, 11, 100, null, 13, 10),  // 典型 34/3 ≈ 11.333
    bar(3, 12, 100, null, 14, 11),  // 典型 37/3 ≈ 12.333
  ])
  assert.equal(r.approx, true, '缺成交额 ⇒ 必须标 avgApprox')
  const last = r.points[2]?.avg as number
  const expect = (31 / 3 + 34 / 3 + 37 / 3) / 3
  assert.ok(Math.abs(last - expect) < 1e-9, `典型价加权应得 ${expect.toFixed(4)}（实际 ${last}）`)
  // 反例注入：写死 close（三个收盘价平均 = 11）⇒ 与典型价加权不同
  assert.throws(() => assert.ok(Math.abs((10 + 11 + 12) / 3 - last) < 1e-9, '反例上：close 平均不等于典型价加权'), /反例上/, '⚠ 反例注入（close）必须失败')
})

test('③ volume=0 的点沿用前值；首点 volume=0 ⇒ null（写 0 ⇒ 必败）', () => {
  const r = backfillTrendAvg([
    bar(1, 10, 0, 0),          // 首点无量 ⇒ null
    bar(2, 11, 100, 1100),     // ⇒ 11
    bar(3, 12, 0, 0),          // 沿用 11
  ])
  assert.equal(r.points[0]?.avg, null, '首点无量 ⇒ null（不是 0）')
  assert.equal(r.points[1]?.avg, 11)
  assert.equal(r.points[2]?.avg, 11, '无量点必须沿用前值')
  assert.throws(() => assert.equal(r.points[2]?.avg, 0, '反例上：写 0'), /反例上/, '⚠ 反例注入（写 0）必须失败')
})

test('④ 有 amount ⇒ avgApprox=false（误标近似 ⇒ 必败）', () => {
  const exact = backfillTrendAvg([bar(1, 10, 100, 1000), bar(2, 10, 100, 1000)])
  assert.equal(exact.approx, false)
  const approx = backfillTrendAvg([bar(1, 10, 100, null)])
  assert.equal(approx.approx, true)
  assert.throws(() => assert.equal(exact.approx, true, '反例上：精确源被误标近似'), /反例上/, '⚠ 反例注入（误标）必须失败')
})

test('⑤ 全序列无 avg ⇒ 做T 给原因；部分点有 ⇒ 正常（整组禁用 ⇒ 必败）', () => {
  const none = lastAvgOf([{ avg: null }, { avg: null }])
  assert.equal(none, null)
  const w = tWindowOf({ atrPct: 3, avg: none })
  assert.ok('reason' in w)
  const partial = lastAvgOf([{ avg: null }, { avg: 10 }])
  assert.equal(partial, 10)
  const ok = tWindowOf({ atrPct: 3, avg: partial })
  assert.ok(!('reason' in ok), '部分点有 avg ⇒ 做T 必须正常')
  // 反例注入：把"全无"当成"整组禁用"的分支写成"任一点缺就禁用" ⇒ 部分点有也会被禁
  assert.throws(() => assert.ok('reason' in tWindowOf({ atrPct: 3, avg: partial }), '反例上：误禁用'), /反例上/, '⚠ 反例注入（整组禁用）必须失败')
})

test('接线：新浪分钟链回填 avg 并标 avgApprox；口径行追加近似说明', () => {
  const em = read('em.ts')
  assert.equal(/backfillTrendAvg\(points, \{ lotSize: 100 \}\)/.test(em), true, '新浪分钟必须回填 avg（量是手 ⇒ lotSize=100）')
  assert.equal(/bf\.approx \? \{ avgApprox: true \}/.test(em), true, '缺成交额时必须标 avgApprox')
  const drawer = readFileSync(join(HERE, '..', 'client', 'QuoteDrawer.tsx'), 'utf8')
  assert.equal(drawer.includes('均价为近似（缺成交额）'), true, '口径行必须追加近似说明')
  assert.equal(/lastAvgOf\(payload\.trend\.points\)/.test(drawer), true, '做T 基准必须用最后一个非空 avg')
})

test('lotSize=100：量是手、额是元 ⇒ 均价落在价格量级（漏乘 ⇒ 差 100× 被域判据丢掉）', () => {
  const r = backfillTrendAvg([bar(1, 4.15, 545889, 226803266)], { lotSize: 100 })
  const avg = r.points[0]?.avg as number
  assert.ok(Math.abs(avg - 226803266 / (545889 * 100)) < 1e-9)
  assert.ok(avg > 4 && avg < 4.3, `均价必须在价格量级（实际 ${avg}）`)
  // 反例注入：漏乘 100 ⇒ 415.5（差 100×）⇒ 必败
  assert.throws(() => assert.ok(Math.abs(226803266 / 545889 - avg) < 1e-9, '反例上：漏乘 100 不等于正确值'), /反例上/, '⚠ 反例注入必须失败')
})
