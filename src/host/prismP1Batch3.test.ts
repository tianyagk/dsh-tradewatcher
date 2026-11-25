/** 审计 D2/B2：同日净值点只由更晚的写；取价失败不写净值点 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { upsertEquity } from './prismAccount.ts'
import type { PrismEquityPoint } from '../shared/prism.ts'

const pt = (day: string, at: number, equity: number): PrismEquityPoint => ({ day, at, equity, capital: 1_800_000, cash: 0, positionsValue: 0, realized: 0, unrealized: 0, benchmarkClose: null } as PrismEquityPoint)

test('① 同日旧点不得覆盖新点（GET 晚到不倒退）', () => {
  const list = [pt('2026-11-25', 200, 1_500_000)]
  const out = upsertEquity(list, pt('2026-11-25', 100, 1_400_000))
  assert.equal(out[0]!.equity, 1_500_000, '旧快照（at=100）不得覆盖 at=200')
})

test('② 更晚的点正常覆盖', () => {
  const out = upsertEquity([pt('2026-11-25', 100, 1_400_000)], pt('2026-11-25', 200, 1_500_000))
  assert.equal(out[0]!.equity, 1_500_000)
})

test('③ matchTick 取价失败 ⇒ 不写净值点', () => {
  const src = readFileSync(new URL('./prismAccount.ts', import.meta.url), 'utf8')
  const block = src.slice(src.indexOf('// 取价失败 ⇒ 不写净值点'), src.indexOf('return { filled, rejected, skipped, rejects: skipped }'))
  assert.match(block, /quoteMap === null/)
  assert.match(block, /store\.equity\(\)/)
})
