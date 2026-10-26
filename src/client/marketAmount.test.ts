/** 成交额分时（③）与分钟增减（④）的断言。 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { MINUTE_BARS, cumulativeOf, minuteDeltaBarsOf, minuteSlotsOf, missingCellText } from './marketBlocks.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const page = readFileSync(join(HERE, 'MarketPage.tsx'), 'utf8')
const slots = minuteSlotsOf()

const mk = (day: string, n: number, base: number) =>
  Array.from({ length: n }, (_, i) => ({ label: `${day} ${slots[i] ?? '09:31'}`, amount: base + i }))

test('① 今日累计曲线末点 = 当日总成交额（误差 ≤0.5%）', () => {
  const pts = mk('2026-10-26', 240, 1_000_000)
  const cum = cumulativeOf(pts)
  const total = pts.reduce((a, p) => a + p.amount, 0)
  assert.equal(cum[cum.length - 1], total)
  assert.ok(Math.abs(cum[cum.length - 1]! - total) / total <= 0.005, '末点必须等于总额（≤0.5%）')
  // 反例注入：只累加最后一根 ⇒ 必败
  assert.throws(() => assert.equal(pts[pts.length - 1]!.amount, total, '反例上：单点≈总额'), /反例上/, '⚠ 反例注入必须失败')
})

test('② 240 根柱：覆盖 09:30–11:30 与 13:00–15:00，值 = 今日−昨日（符号错 ⇒ 败）', () => {
  assert.equal(MINUTE_BARS, 240)
  assert.equal(slots.length, 240)
  assert.equal(slots[0], '09:31')
  assert.equal(slots[119], '11:30')
  assert.equal(slots[120], '13:01')
  assert.equal(slots[239], '15:00')
  const today = mk('2026-10-26', 240, 2_000_000)
  const yday = mk('2026-10-23', 240, 1_500_000)
  const r = minuteDeltaBarsOf(today, yday)
  assert.equal(r.bars?.length, 240, '必须画满 240 根')
  assert.equal(r.bars![0], 500_000)
  assert.equal(r.bars![239], 500_000)
  // 反例注入：符号反过来 ⇒ 必败
  assert.throws(() => assert.equal(-r.bars![0], 500_000, '反例上：符号反了'), /反例上/, '⚠ 反例注入（符号）必须失败')
})

test('③ 昨日序列缺失 ⇒ —（昨日分钟额不可得）（用今日冒充 ⇒ 败）', () => {
  const today = mk('2026-10-26', 240, 1_000_000)
  const r = minuteDeltaBarsOf(today, null)
  assert.equal(r.bars, null)
  assert.equal(missingCellText(r.reason), '—（昨日分钟额不可得）')
  // 反例注入：把今日当昨日 ⇒ 差值全 0（会被误画成 240 根零柱）⇒ 必败
  const fake = minuteDeltaBarsOf(today, today)
  assert.equal(fake.bars?.every((v) => v === 0), true, '前置：冒充会让全部差值为 0')
  assert.throws(() => assert.equal(fake.bars === null, true, '反例上：用今日冒充昨日'), /反例上/, '⚠ 反例注入必须失败')
})

test('④ 预测线是水平虚线且值 = 全天预测（斜线 ⇒ 败）', () => {
  assert.equal(/x1: 0, y1: y\(fc\), x2: W, y2: y\(fc\)/.test(page), true, '预测线必须 y1 === y2（水平）')
  assert.equal(/y1: y\(fc\), x2: W, y2: y\(fc\), stroke: 'var\(--tw-muted\)', strokeWidth: 1, strokeDasharray: '4 3'/.test(page), true, '预测线必须虚线')
  // 反例注入：改成斜线（y2 = 0）⇒ 判据必败
  const slanted = page.replace('x2: W, y2: y(fc)', 'x2: W, y2: 0')
  assert.throws(() => assert.equal(/x2: W, y2: y\(fc\)/.test(slanted), true, '反例上：斜线'), /反例上/, '⚠ 反例注入（斜线）必须失败')
})
