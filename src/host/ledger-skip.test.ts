/**
 * 账本重放"跳过条目"必须可读（P1-5）的断言。
 *
 * 缺陷形态：`replayPosition` 对未能应用的流水 `catch {}` 静默保留前值 ——
 * 账本里能看到 5 笔、持仓快照却少一块，而没有任何标记说明"有 N 条流水没被应用"。
 * 这是账务口径的静默降级：用户对不上账时无从下手。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { LedgerEntry, PortGroup, PortItem, QuoteRow } from '../shared/model.ts'
import { assemblePortfolio, derivePosition } from './portfolio.ts'
import { replayPosition, replayPositionWithSkips } from './store.ts'

const pos: PortItem = { id: 'p1', groupId: 'g1', secid: '1.600519', name: '贵州茅台', createdAt: 1 }
const group: PortGroup = { id: 'g1', name: '长期', order: 1 }
const quote: QuoteRow = {
  secid: '1.600519', code: '600519', name: '贵州茅台', price: 12.5, chg: 0.5, pct: 4.17, prev: 12,
  open: null, high: null, low: null, vol: null, amount: null, up: null, down: null, even: null, time: null,
}

const buy = (qty: number, price: number): LedgerEntry => ({ id: 'b1', ts: 1, actor: 'web', verb: 'buy', posId: 'p1', qty, price })
const oversell: LedgerEntry = { id: 's9', ts: 2, actor: 'web', verb: 'sell', posId: 'p1', qty: 500, price: 12 }
const broken: LedgerEntry = { id: 'x1', ts: 3, actor: 'web', verb: 'buy', posId: 'p1', qty: 100 }

test('replayPositionWithSkips：超出持仓的卖出被记为 skipped（含原因），后续流水照常应用', () => {
  const entries = [buy(100, 10), oversell, buy(50, 11)]
  const r = replayPositionWithSkips(entries, 'p1')
  assert.equal(r.skipped.length, 1)
  assert.equal(r.skipped[0].id, 's9')
  assert.equal(r.skipped[0].verb, 'sell')
  assert.match(r.skipped[0].reason, /超过持仓/)
  // 坏流水不影响后面的流水：100 + 50 = 150（那笔 500 的卖出没有被算进去）
  assert.equal(r.state.qty, 150)
  // 只要状态的旧入口行为不变（其它调用方不受影响）
  assert.deepEqual(replayPosition(entries, 'p1'), r.state)
})

test('replayPositionWithSkips：缺数量/价格的流水同样被记下（不是静默丢弃）', () => {
  const r = replayPositionWithSkips([buy(100, 10), broken], 'p1')
  assert.equal(r.skipped.length, 1)
  assert.match(r.skipped[0].reason, /缺少数量或价格/)
  assert.equal(r.state.qty, 100)
  // 其它持仓的流水不受影响
  const other: LedgerEntry = { id: 'o1', ts: 4, actor: 'web', verb: 'buy', posId: 'p2', qty: 10, price: 1 }
  assert.equal(replayPositionWithSkips([buy(100, 10), other], 'p1').skipped.length, 0)
})

test('derivePosition / assemblePortfolio：跳过条数与原因进持仓行（界面与工具据此报出）', () => {
  const row = derivePosition([buy(100, 10), oversell], pos, quote, Date.now() - 86_400_000)
  assert.equal(row.skippedLedger, 1)
  assert.equal(row.skippedNotes?.length, 1)
  assert.match(row.skippedNotes?.[0] ?? '', /^\[s9\]/)
  assert.match(row.skippedNotes?.[0] ?? '', /超过持仓/)
  assert.equal(row.qty, 100, '快照仍然给得出来（用能应用的那部分）')

  const { view } = assemblePortfolio([group], [pos], [buy(100, 10), oversell], { '1.600519': quote })
  const p = view.positions[0]
  assert.equal(p.skippedLedger, 1)
  assert.equal(p.mv, 1250)

  // 全部能应用时不出现该字段的告警（界面只在 > 0 时提示）
  const clean = derivePosition([buy(100, 10)], pos, quote, Date.now() - 86_400_000)
  assert.equal(clean.skippedLedger, 0)
  assert.deepEqual(clean.skippedNotes, [])
})
