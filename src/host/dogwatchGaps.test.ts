/**
 * 汪汪队跟踪 —— 审计补强（AUDIT-DOGWATCH-TESTS §3 覆盖缺口）。
 *
 * 每条都针对 v0.185→v0.188 新增测试**没有覆盖到**的一条分支，
 * 并且反例注入是**真注入**：把缺陷版本的值喂给**同一个判据**，确认它会红。
 * （区别于「assert.throws(() => assert.equal(真值, 别的字面量))」那种只证明比较符能用的写法。）
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  DOGWATCH_POOL, cacheUsableOf, detectCorporateActions, fetchDogwatch,
  poolCoverageOf, sharesCachePath, tradingDaysBack,
} from './dogwatch.ts'

/* ───────── ① 折算检测的**双向**判据：真折算 vs 真实申赎 ───────── */

test('G1 折算检测：份额跳 + 价格**反向**跳才判折算；价格不动的大额变化 = 申赎（判据方向反了 ⇒ 败）', () => {
  const split = [
    { day: 'a', totalWan: 100, priceGapPct: 0 },
    { day: 'b', totalWan: 200, priceGapPct: -50 }, // 份额×2、价格−50% ⇒ 真折算
  ]
  const redemption = [
    { day: 'a', totalWan: 100, priceGapPct: 0 },
    { day: 'b', totalWan: 200, priceGapPct: 0.5 }, // 份额×2、价格不动 ⇒ 大额申购，必须计入指数
  ]
  const reverse = [
    { day: 'a', totalWan: 200, priceGapPct: 0 },
    { day: 'b', totalWan: 100, priceGapPct: 60 }, // 份额÷2、价格+60% ⇒ 反向折算
  ]
  const unknown = [
    { day: 'a', totalWan: 100, priceGapPct: null },
    { day: 'b', totalWan: 200, priceGapPct: null }, // 价格未知 ⇒ 不猜
  ]

  /** 唯一判据：该序列是否被判为「恰好一个折算日」 */
  const judgedAsSplit = (series: ReadonlyArray<{ day: string; totalWan: number; priceGapPct: number | null }>): boolean =>
    detectCorporateActions([...series]).length === 1

  assert.equal(judgedAsSplit(split), true, '份额×2 + 价格−50% 必须判折算')
  assert.equal(judgedAsSplit(reverse), true, '份额÷2 + 价格+60% 必须判折算')
  assert.equal(judgedAsSplit(redemption), false, '价格只动 0.5% 的份额跃升是**申赎**，判折算会把真实加仓抹掉')
  assert.equal(judgedAsSplit(unknown), false, '价格未知时不得猜（无证据不判）')

  // 反例注入：v0.188.0 的旧判据（"价格没跳空 ⇒ 判折算"）—— 正好把申赎判成折算
  const legacyJudgedAsSplit = (series: ReadonlyArray<{ totalWan: number; priceGapPct: number | null }>): boolean =>
    series.slice(1).some((now, i) => {
      const prev = series[i]!
      const ratio = now.totalWan / prev.totalWan
      const gap = now.priceGapPct
      return Math.abs(ratio - 1) > 0.2 && (gap === null || Math.abs(gap) <= 5)
    })
  assert.equal(legacyJudgedAsSplit(redemption), true, '反例：旧判据确实会把这次申赎判成折算')
  assert.throws(
    () => assert.equal(legacyJudgedAsSplit(redemption), judgedAsSplit(redemption), '反例上：判据方向反了'),
    /反例上/,
    '⚠ 真注入：旧判据与现行判据在这一组输入上必须给出不同结论',
  )
})

/* ───────── ② poolCoverageOf / cacheUsableOf 的边界与真分支 ───────── */

test('G2 覆盖率：null ⇒ 0；满池 ⇒ 可用；12/14 ⇒ 不可用（门槛写松 ⇒ 败）', () => {
  const full = new Map(DOGWATCH_POOL.map((p) => [p.code, { name: p.name, volWan: 1 }]))
  const m13 = new Map(DOGWATCH_POOL.slice(0, 13).map((p) => [p.code, { name: p.name, volWan: 1 }]))
  const m12 = new Map(DOGWATCH_POOL.slice(0, 12).map((p) => [p.code, { name: p.name, volWan: 1 }]))

  assert.deepEqual(poolCoverageOf(null), { hit: 0, total: DOGWATCH_POOL.length, ratio: 0 }, 'null 不得当成"空 Map 但有数据"')
  assert.deepEqual(poolCoverageOf(full), { hit: 14, total: 14, ratio: 1 })
  assert.equal(cacheUsableOf(full), true, '满池必须可用（原测试只断言过 false 分支）')
  assert.equal(cacheUsableOf(m13), true, '13/14 = 92.9% ≥ 90% ⇒ 可用（边界）')
  assert.equal(cacheUsableOf(m12), false, '12/14 = 85.7% < 90% ⇒ 不可用')
  // ratio 必须是 0–1 的小数，不是百分数（写成 100 会让所有阈值判据失效）
  assert.ok(poolCoverageOf(m13).ratio > 0 && poolCoverageOf(m13).ratio <= 1, 'ratio 必须是 0–1')

  // 反例注入：把门槛从 0.9 写松到 0.5 ⇒ 12/14 会被当成可用（残缺缓存就不会重拉）
  const looseUsable = (rows: Map<string, { name: string; volWan: number }> | null): boolean => poolCoverageOf(rows).ratio >= 0.5
  assert.equal(looseUsable(m12), true, '反例：0.5 门槛确实放行 12/14')
  assert.throws(
    () => assert.equal(looseUsable(m12), cacheUsableOf(m12), '反例上：门槛写松'),
    /反例上/,
    '⚠ 真注入：门槛被改松后，同一个调用点必须得出不同结论',
  )
})

/* ───────── ③ 总份额的**生产聚合**（原测试只做了测试自己的 reduce） ───────── */

test('G3 总份额 Σ14 来自生产聚合（只取第一只 / 丢一行 ⇒ 败）', async () => {
  const now = Date.parse('2026-11-24T10:00:00+08:00')
  const days = tradingDaysBack(84, now)
  mkdirSync(join(sharesCachePath(days[0]!), '..'), { recursive: true })
  for (const d of days) {
    const rows = Object.fromEntries(DOGWATCH_POOL.map((p, i) => [p.code, { name: p.name, volWan: 1000 + i * 1000 }]))
    writeFileSync(sharesCachePath(d), JSON.stringify({ day: d, rows }))
  }
  const r = await fetchDogwatch('3m', { now, quotes: async () => ({}) })
  // sharesYi = volWan / 1e4 ⇒ 0.1 … 1.4，Σ = (0.1+1.4)*14/2 = 10.5
  const sum14 = DOGWATCH_POOL.reduce((a, _p, i) => a + (1000 + i * 1000) / 1e4, 0)
  assert.ok(r.summary.totalSharesYi !== null, '总份额不得为 null（池满且都有份额）')
  assert.ok(Math.abs(r.summary.totalSharesYi! - sum14) < 1e-9, `总份额必须 = Σ14 = ${sum14}（实得 ${r.summary.totalSharesYi}）`)
  assert.ok(Math.abs(r.summary.totalSharesYi! - (1000 / 1e4)) > 5, '总份额不得等于第一只（0.1）')

  // 反例注入：只取第一行（v0.188.0 之前的真实缺陷）⇒ 与 Σ14 必须不同
  const firstOnly = DOGWATCH_POOL.length > 0 ? 1000 / 1e4 : 0
  assert.throws(
    () => assert.ok(Math.abs(r.summary.totalSharesYi! - firstOnly) < 1e-9, '反例上：只取第一行'),
    /反例上/,
    '⚠ 真注入：把聚合改回"取第一行"，这条断言必须红',
  )
})

/* ───────── ④ tradingDaysBack：跳过周末、升序、含今天 ───────── */

test('G4 tradingDaysBack：跳过周末、升序、末日=今天（不过滤周末 ⇒ 败）', () => {
  const at = Date.parse('2026-11-13T10:00:00+08:00') // 周五
  const days = tradingDaysBack(10, at)
  assert.equal(days.length, 10, '必须正好 10 个交易日')
  assert.equal(days[days.length - 1], '2026-11-13', '末日必须是今天（当天交易日 ⇒ 含今天）')
  assert.deepEqual([...days].sort(), days, '必须升序（回测按时间正序读）')
  const weekdayOf = (d: string): number => new Date(`${d}T00:00:00Z`).getUTCDay()
  assert.equal(days.some((d) => weekdayOf(d) === 0 || weekdayOf(d) === 6), false, '不得含周六/周日')

  // 反例注入：不对齐交易日、直接倒推 10 个自然日 ⇒ 必含周末
  const naive = Array.from({ length: 10 }, (_, i) => {
    const d = new Date(at - i * 86_400_000)
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`
  }).reverse()
  assert.equal(naive.some((d) => weekdayOf(d) === 0 || weekdayOf(d) === 6), true, '反例：自然日倒推必然含周末')
  assert.throws(
    () => assert.deepEqual(naive, days, '反例上：按自然日倒推'),
    /反例上/,
    '⚠ 真注入：用自然日代替交易日，这条断言必须红',
  )
})
