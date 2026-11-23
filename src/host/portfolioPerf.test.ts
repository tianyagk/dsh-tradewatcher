/**
 * P2-1（AUDIT-HOST-PERF）：`assemblePortfolio` 不再对每个持仓把全量流水扫三遍。
 *
 * 夹具：`fixtures/ledger-367-10pos.json` —— 367 条流水（形状取自本机真实 `ledger.json`，
 * posId / secid / name / id 已脱敏，数量/价格/费用/时间戳原样），`items` = 当前 10 个持仓。
 * `fixtures/portfolio-golden-367.json` 是**旧实现（v0.216.0，每仓全表三遍）**在同一份夹具
 * 上生成的完整视图 —— 新实现必须逐字段 deepEqual。
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { assemblePortfolio, derivePosition, groupLedgerByPos } from './portfolio.ts'
import { replayEntriesWithSkips } from './store.ts'
import type { LedgerEntry, PortGroup, PortItem, QuoteRow } from '../shared/model.ts'

interface Fixture {
  entries: LedgerEntry[]
  groups: PortGroup[]
  items: PortItem[]
}
interface Golden {
  note: string
  now: number
  quotes: Record<string, QuoteRow>
  fxMode: string
  stale: number
  view: Record<string, unknown>
}

const readJson = <T>(name: string): T => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8')) as T
const fixture = readJson<Fixture>('ledger-367-10pos.json')
const golden = readJson<Golden>('portfolio-golden-367.json')

test('P2-1 ① 367 条真实形状流水 × 10 持仓：新实现与旧实现 golden 逐字段 deepEqual', () => {
  const { view, stale } = assemblePortfolio(fixture.groups, fixture.items, fixture.entries, golden.quotes, { mode: 'none', rates: {} }, golden.now)
  // `generatedAt` 是墙钟（本来就每次不同），其余字段必须完全一致
  const { generatedAt: _ignored, ...rest } = view as unknown as { generatedAt: number } & Record<string, unknown>
  assert.deepEqual(JSON.parse(JSON.stringify(rest)), golden.view)
  assert.equal(stale, golden.stale)
  // 夹具自检：10 个持仓、367 条流水（不是"跑了个空循环"）
  assert.equal(view.positions.length, 10)
  assert.equal(fixture.entries.length, 367)
})

test('P2-1 ② 分组一次遍历：桶内保持原顺序，无 posId 的流水不进任何桶', () => {
  const entries = fixture.entries
  const byPos = groupLedgerByPos(entries)
  const ids = new Set(entries.map((e) => e.posId).filter((x): x is string => x !== undefined))
  assert.equal(byPos.size, ids.size)
  for (const [posId, own] of byPos) {
    assert.ok(own.every((e) => e.posId === posId))
    // 与"过滤全表"的旧路径逐条相同（顺序也相同）
    assert.deepEqual(own.map((e) => e.id), entries.filter((e) => e.posId === posId).map((e) => e.id))
  }
  // 无 posId 的分组操作流水不占桶
  assert.equal([...byPos.values()].reduce((n, list) => n + list.length, 0), entries.filter((e) => e.posId !== undefined).length)
})

test('P2-1 ③ 单仓入口 derivePosition 与分组路径逐字段一致（同一份夹具，10 个持仓全比）', () => {
  const { view } = assemblePortfolio(fixture.groups, fixture.items, fixture.entries, golden.quotes, { mode: 'none', rates: {} }, golden.now)
  const dayStart = Date.parse('2026-11-23T00:00:00+08:00')
  for (const row of view.positions) {
    const item = fixture.items.find((p) => p.id === row.posId)
    assert.ok(item !== undefined)
    const single = derivePosition(fixture.entries, item, golden.quotes[item.secid], dayStart)
    assert.deepEqual(single, row, `${row.posId} 单仓入口与分组路径必须一致`)
  }
})

test('P2-1 ④ 100 持仓 × 5 000 条：CPU 中位耗时 < 20ms（旧实现同口径 23.51ms，墙钟 47.66→7.29ms）', () => {
  const P = 100
  const E = 5_000
  const now = Date.parse('2026-11-23T14:00:00+08:00')
  const groups: PortGroup[] = [{ id: 'g1', name: '默认', order: 0 }]
  const items: PortItem[] = Array.from({ length: P }, (_, i) => ({ id: `p${i}`, groupId: 'g1', secid: `1.${600000 + i}`, name: `标的${i}`, createdAt: i }))
  const entries: LedgerEntry[] = []
  for (let i = 0; i < E; i += 1) {
    const p = i % P
    const verb = i % 3 === 2 ? 'sell' : 'buy'
    entries.push({ id: `e${String(i).padStart(5, '0')}`, ts: now - (E - i) * 60_000, actor: 'web', verb, groupId: 'g1', posId: `p${p}`, secid: `1.${600000 + p}`, qty: 10, price: 10 })
  }
  const quotes: Record<string, QuoteRow> = {}
  for (const it of items) quotes[it.secid] = { secid: it.secid, name: it.name, price: 10.5, prev: 10, pct: 5, chg: 0.5 } as never

  // 预热 3 轮（JIT），再取 5 个样本
  for (let i = 0; i < 3; i += 1) assemblePortfolio(groups, items, entries, quotes, { mode: 'none', rates: {} }, now)
  const cpu: number[] = []
  const wall: number[] = []
  let last = assemblePortfolio(groups, items, entries, quotes, { mode: 'none', rates: {} }, now)
  for (let i = 0; i < 5; i += 1) {
    const c0 = process.cpuUsage()
    const t0 = performance.now()
    last = assemblePortfolio(groups, items, entries, quotes, { mode: 'none', rates: {} }, now)
    wall.push(performance.now() - t0)
    const used = process.cpuUsage(c0)
    cpu.push((used.user + used.system) / 1000)
  }
  cpu.sort((a, b) => a - b)
  wall.sort((a, b) => a - b)
  const cpuMedian = cpu[2] as number
  assert.equal(last.view.positions.length, P)
  // 正确性（不只看快）：每仓 qty/avgCost 必须与"独立逐仓重放"一致
  const byPos = groupLedgerByPos(entries)
  for (const row of last.view.positions) {
    const replay = replayEntriesWithSkips(byPos.get(row.posId) ?? []).state
    assert.equal(row.qty, replay.qty, `${row.posId} qty`)
    assert.equal(row.avgCost, Math.round(replay.avgCost * 10_000) / 10_000, `${row.posId} avgCost`)
  }
  /**
   * 口径：纯 CPU 函数 ⇒ 用 `process.cpuUsage()`（user+system）计时。
   * `npm test` 以 `--test-concurrency=8` 并行跑，墙钟会被同机其它用例挤占（实测同一份代码
   * 冷/热、空闲/满载能从 3ms 飘到 21ms）；CPU 时间才是这段代码真正的成本。
   * 旧实现同口径：CPU 中位 23.51ms、墙钟 47.66ms；新实现 CPU 中位 3.45ms、墙钟 7.29ms。
   */
  assert.ok(cpuMedian < 20, `100 持仓 × 5 000 条 CPU 中位耗时 ${cpuMedian.toFixed(2)}ms 应 < 20ms（墙钟中位 ${(wall[2] as number).toFixed(2)}ms；旧实现 CPU 23.51ms）`)
})
