/** v0.194.0：实机 6 症状的回归断言（复盘日期 / 序列长度 / scale≠sharesYi / 单位 / 份额变化 / 排序） */
import { test } from 'node:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, join as joinPath } from 'node:path'
import { DOGWATCH_POOL, fetchDogwatch, sharesCachePath, tradingDaysBack } from './dogwatch.ts'
// 独立 DSH_HOME：避免与其它测试文件共享 dogwatch 缓存目录
process.env.DSH_HOME = mkdtempSync(joinPath(tmpdir(), 'dw-rows-'))
import { dwReview, dwTable } from '../client/dogwatchView.ts'

const NOW = Date.parse('2026-11-17T10:00:00+08:00')

async function payload(): Promise<Awaited<ReturnType<typeof fetchDogwatch>>> {
  const days = tradingDaysBack(95, NOW)
  mkdirSync(join(sharesCachePath(days[0]!), '..'), { recursive: true })
  days.forEach((d, i) => {
    const rows = Object.fromEntries(DOGWATCH_POOL.map((p, k) => [p.code, { name: p.name, volWan: (k === 0 ? 456.23 : 200 + k * 10 + i * 0.5) * 1e4 }]))
    writeFileSync(sharesCachePath(d), JSON.stringify({ day: d, rows }))
  })
  const nav: Record<string, number> = { '510300': 4.082, '510310': 3.5, '510330': 4.1, '510350': 1.2 }
  return fetchDogwatch('3m', {
    now: NOW,
    bypassCache: true,
    loadShares: undefined,
    quotes: async (codes) => Object.fromEntries(codes.map((c) => [c, { amount: 1e9, pct: -0.5, nav: nav[c.slice(2)] ?? 2, outer: 60, inner: 40 }])),
  })
}

test('① 复盘日期 = series 最后一天（用 baseDate ⇒ 败）', async () => {
  const p = await payload()
  const lastDay = p.series[p.series.length - 1]!.day
  assert.ok(dwReview(lastDay, p.summary).day.includes(lastDay), '复盘条必须显示最后一天')
  assert.notEqual(lastDay, p.summary.baseDate, '最后一天与基期不同（否则本断言无意义）')
  assert.throws(() => assert.ok(dwReview(p.summary.baseDate!, p.summary).day.includes(lastDay), '反例上：用 baseDate'), /反例上/, '⚠ 反例注入必须失败')
})

test('② series.length ≥ 20（3m）且 change 非全 0（全 0 ⇒ 败）', async () => {
  const p = await payload()
  assert.ok(p.series.length >= 20, `3m 至少 20 个点（实得 ${p.series.length}）`)
  assert.ok(p.series.filter((s) => s.change !== 0).length > 1, 'change 不得全 0')
  assert.throws(() => assert.equal(p.series.filter((s) => s.change !== 0).length, 0, '反例上：全 0'), /反例上/, '⚠ 反例注入必须失败')
})

test('③ rows[0].scale !== rows[0].sharesYi（相等 ⇒ 字段复用 ⇒ 败）', async () => {
  const p = await payload()
  const r = p.rows[0]!
  assert.notEqual(r.scale, r.sharesYi, '规模（金额）与份额（份数）不得是同一个数')
  assert.throws(() => assert.equal(r.scale, r.sharesYi, '反例上：字段复用'), /反例上/, '⚠ 反例注入必须失败')
})

test('④ 510300：scale ∈ [1500,2200] 亿、sharesYi ∈ [450,460]（取错单位 ⇒ 败）', async () => {
  const p = await payload()
  const r = p.rows.find((x) => x.secid === '1.510300')!
  assert.ok(r.sharesYi! >= 450 && r.sharesYi! <= 460, `sharesYi ≈ 456（实得 ${r.sharesYi}）`)
  assert.ok(r.scale! >= 1500 && r.scale! <= 2200, `scale ≈ 1862 亿（实得 ${r.scale}）`)
  assert.ok(Math.abs(r.scale! - r.sharesYi! * 4.082) < 1, 'scale = 份额 × 净值')
  assert.throws(() => assert.equal(r.scale, r.sharesYi, '反例上：把份额当规模'), /反例上/, '⚠ 反例注入必须失败')
})

test('⑤ sharesDelta 非 null 行数 ≥ 13（全 null ⇒ 败）', async () => {
  const p = await payload()
  const n = p.rows.filter((r) => r.sharesDelta !== null).length
  assert.ok(n >= 13, `份额变化必须有值（实得 ${n}/14）`)
  assert.throws(() => assert.equal(n, 0, '反例上：全 null'), /反例上/, '⚠ 反例注入必须失败')
})

test('⑥ 表格按 scale 降序（升序 ⇒ 败）', async () => {
  const p = await payload()
  const t = dwTable(p.rows, p.summary, p.sharesStale)
  const scales = p.rows.map((r) => r.scale ?? -1).sort((a, b) => b - a)
  const firstRowScale = p.rows.find((r) => r.secid === p.rows[0]!.secid)!.scale!
  assert.equal(t.rows[0]!.cells[0], p.rows.slice().sort((a, b) => (b.scale ?? -1) - (a.scale ?? -1))[0]!.name, '第一行必须是规模最大的')
  assert.ok(firstRowScale > 0 && scales.length === p.rows.length)
  assert.throws(() => assert.equal(t.rows[0]!.cells[0], p.rows.slice().sort((a, b) => (a.scale ?? 0) - (b.scale ?? 0))[0]!.name, '反例上：升序'), /反例上/, '⚠ 反例注入必须失败')
})
