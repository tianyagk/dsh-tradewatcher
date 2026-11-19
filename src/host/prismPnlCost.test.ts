/** v0.203.1：持仓成本口径 —— netCost 是总成本、cost 是每股成本，二者不可混用 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { prismPositionViewOf } from './prismData.ts'

const account = {
  day: '2026-11-19', capital: 1_800_000, capitalLimit: 1_800_000, cash: 342_027.68, realized: 0, dayStartEquity: null,
  positions: [{ secid: '1.518880', name: '黄金ETF华安', qty: 7500, available: 7500, cost: 8.46, netCost: 63_450 }],
}

test('① pnl 用每股成本计算，不得把总成本当每股成本（反例：混用 ⇒ 差 7500 倍）', () => {
  const { rows } = prismPositionViewOf(account as never, { '1.518880': 7.612 })
  const r = rows[0]
  const expect = (7.612 - 8.46) * 7500
  assert.ok(r.pnl !== null && Math.abs(r.pnl - expect) < 1, `pnl 应为 ${expect.toFixed(2)}，实际 ${r.pnl}`)
  assert.ok(Math.abs((r.pnl ?? 0)) < 1e6, 'pnl 不得出现 1e8 量级（说明把总成本当成了每股成本）')
})

test('② 回包 cost 字段为每股成本', () => {
  const { rows } = prismPositionViewOf(account as never, { '1.518880': 7.612 })
  assert.equal(rows[0].cost, 8.46)
})

test('③ 只有 netCost 时按 qty 摊回每股（反例：直接用 netCost ⇒ 必败）', () => {
  const acc = { ...account, positions: [{ secid: '1.518880', name: '黄金ETF华安', qty: 7500, available: 7500, netCost: 63_450 }] }
  const { rows } = prismPositionViewOf(acc as never, { '1.518880': 7.612 })
  assert.ok(Math.abs(rows[0].cost - 8.46) < 1e-9)
})
