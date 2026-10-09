/**
 * P1 批次（共同功能补强）的宿主侧断言。
 *
 * 覆盖：T+0/T+1 判定与可用数量、费用占比、以及"不拿 0 顶替不可算的量"。
 * 这些都是账面数字，错一个就会被当成真实盈亏，因此边界必须钉死。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { LedgerEntry, PortGroup, PortItem } from '../shared/model.ts'
import { isT0Secid } from '../shared/model.ts'
import { assemblePortfolio } from './portfolio.ts'

test('P1-5 T+0 判定：场内基金/港股/美股为 T+0，A股股票为 T+1', () => {
  // 沪深 ETF/LOF（T+0）
  for (const s of ['1.510300', '1.588000', '1.510050', '0.159915', '0.160632']) {
    assert.equal(isT0Secid(s), true, `${s} 应判为 T+0`)
  }
  // A股股票（T+1）
  for (const s of ['1.600519', '0.300750', '1.688825', '0.000858']) {
    assert.equal(isT0Secid(s), false, `${s} 应判为 T+1`)
  }
  // 港股/美股/国际指数/期货（T+0 或不适用 T+1 限制）
  for (const s of ['116.00700', '105.AAPL', '100.KOSPI200', '114.lhm']) {
    assert.equal(isT0Secid(s), true, `${s} 应判为 T+0`)
  }
  // 拿不准的市场按 T+1（保守：绝不说"今天买的能卖"）
  assert.equal(isT0Secid('999.ABC'), false)
})

function buy(ts: number, qty: number, price: number, fee: number, posId = 'p1', secid = '1.600519'): LedgerEntry {
  return { id: `e${ts}`, ts, actor: 'web', verb: 'buy', posId, groupId: 'g1', secid, name: 'x', qty, price, fee }
}

const GROUPS: PortGroup[] = [{ id: 'g1', name: '主仓', order: 1 }]

test('P1-5 可用数量：A股当日买入部分不计入可用（T+1）', () => {
  // 昨天买 1000、今天再买 200 → 持有 1200、可用 1000。
  // 时点用相对时间构造：assemblePortfolio 内部按"北京当日 00:00"切分当日成交，
  // 因此"昨日"取 now-36h、"今日买入"取 max(今日 00:00, now-1h) —— 两者都晚于各自的日界。
  const now = Date.now()
  const day0 = Date.parse(new Date(now - 8 * 3_600_000).toISOString().slice(0, 10) + 'T00:00:00+08:00')
  const entries: LedgerEntry[] = [buy(day0 - 86_400_000, 1000, 10, 5), buy(Math.max(day0, now - 3_600_000), 200, 11, 5)]
  const items: PortItem[] = [{ id: 'p1', groupId: 'g1', secid: '1.600519', name: '贵州茅台', createdAt: 1 }]
  const { view } = assemblePortfolio(GROUPS, items, entries, {})
  const row = view.positions[0]
  assert.equal(row.qty, 1200)
  assert.equal(row.t0, false)
  assert.equal(row.availableQty, 1000, '今日买入的 200 不可卖')
  assert.equal(row.fees, 10)
  assert.equal(row.turnover, 1000 * 10 + 200 * 11)
  assert.ok(row.feeShare !== null && row.feeShare > 0 && row.feeShare < 1, `费用占比应为一个小的百分数，实际 ${row.feeShare}`)
})

test('P1-5 可用数量：ETF（T+0）当日买入即可用', () => {
  const now = Date.now()
  const entries: LedgerEntry[] = [buy(now - 3_600_000, 500, 3.5, 0, 'p1', '1.510300')]
  const items: PortItem[] = [{ id: 'p1', groupId: 'g1', secid: '1.510300', name: '沪深300ETF', createdAt: 1 }]
  const { view } = assemblePortfolio(GROUPS, items, entries, {})
  const row = view.positions[0]
  assert.equal(row.t0, true)
  assert.equal(row.availableQty, row.qty, 'T+0 时可用等于持仓')
})

test('P1-5 费用占比：没有成交时不编数（null 而不是 0）', () => {
  // 只有 adjust（不产生成交额）→ 占比必须为 null
  const entries: LedgerEntry[] = [
    { id: 'a1', ts: 1, actor: 'web', verb: 'adjust', posId: 'p1', groupId: 'g1', secid: '1.600519', name: 'x', qty: 100, price: 10 },
  ]
  const items: PortItem[] = [{ id: 'p1', groupId: 'g1', secid: '1.600519', name: '贵州茅台', createdAt: 1 }]
  const { view } = assemblePortfolio(GROUPS, items, entries, {})
  const row = view.positions[0]
  assert.equal(row.turnover, 0)
  assert.equal(row.feeShare, null, '成交额为 0 时占比不可算，必须是 null —— 0 会被读成"没有手续费"')
  assert.equal(row.availableQty, 100)
})
