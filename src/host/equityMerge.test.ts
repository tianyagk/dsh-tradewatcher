/** 净值点合并：saveEquity 写入后，saveAll 的旧内存列表不得把它覆盖掉（审计 D3） */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PrismTradingStore, mergeEquityLists } from './prismAccount.ts'
import type { PrismEquityPoint } from '../shared/prism.ts'

const pt = (day: string, at: number, equity: number): PrismEquityPoint => ({ day, at, equity, capital: 1_800_000, cash: 0, positionsValue: 0, realized: 0, unrealized: 0, benchmarkClose: null } as PrismEquityPoint)

test('① 同一天取 at 更大的那条', () => {
  const m = mergeEquityLists([pt('2026-11-25', 100, 1)], [pt('2026-11-25', 200, 2)])
  assert.equal(m[0]!.equity, 2)
})

test('② saveEquity 单独写的点，saveAll 不能覆盖', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'prism-eqmerge-'))
  try {
    const s = new PrismTradingStore(dir); await s.init()
    await s.saveAll({ account: s.account(), orders: [], fills: [], equity: [pt('2026-11-24', 10, 100)] })
    await s.saveEquity([pt('2026-11-24', 10, 100), pt('2026-11-25', 20, 200)])
    // 模拟：内存里仍是旧列表（没有 11-25 的点）
    await s.saveAll({ account: s.account(), orders: [], fills: [], equity: [pt('2026-11-24', 10, 100)] })
    const reread = new PrismTradingStore(dir); await reread.init()
    assert.equal(reread.equity().some((p) => p.day === '2026-11-25'), true, 'saveAll 不得丢掉已单独写入的点')
  } finally { await rm(dir, { recursive: true, force: true }) }
})
