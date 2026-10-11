/**
 * 做T 配对的断言（报告的三条反面教材都必须挡住）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { LedgerEntry } from '../shared/model.ts'
import { dayTradesOf } from './dayTrade.ts'

const t = (day: string, hhmm: string, verb: 'buy' | 'sell', qty: number, price: number, fee = 0, id = `${day}-${hhmm}-${verb}`): LedgerEntry => ({
  id,
  ts: Date.parse(`${day}T${hhmm}:00+08:00`),
  verb,
  actor: 'web',
  posId: 'p1',
  groupId: 'g1',
  qty,
  price,
  fee,
  note: '',
} as LedgerEntry)

test('按次数统计：同日两轮 + 次日一轮 = 3 次（不是按天数算 2）', () => {
  const r = dayTradesOf([
    t('2026-03-02', '09:40', 'buy', 100, 10, 5, 'b1'),
    t('2026-03-02', '10:30', 'sell', 100, 10.5, 5, 's1'),
    t('2026-03-02', '13:10', 'buy', 100, 10.2, 5, 'b2'),
    t('2026-03-02', '14:30', 'sell', 100, 10.4, 5, 's2'),
    t('2026-03-03', '09:50', 'buy', 100, 10.1, 5, 'b3'),
    t('2026-03-03', '14:50', 'sell', 100, 10.6, 5, 's3'),
  ])
  assert.equal(r.summary.count, 3, '三次往返（同日两轮 + 次日一轮）')
  assert.equal(r.summary.days, 2, '涉及 2 个交易日（但这**不是**次数）')
  assert.equal(r.rounds.filter((x) => x.day === '2026-03-02').length, 2)
  // 手算第一轮：(10.5 − 10) × 100 = 50 毛；费用 5 + 5 = 10 ⇒ 净 40
  assert.equal(r.rounds[0].grossPnl, 50)
  assert.equal(r.rounds[0].feeShare, 10)
  assert.equal(r.rounds[0].netPnl, 40)
  // 手算合计：40（第一轮）+ [(10.4−10.2)×100 − 10 = 10] + [(10.6−10.1)×100 − 10 = 40] = 90
  assert.equal(r.rounds[1].netPnl, 10)
  assert.equal(r.rounds[2].netPnl, 40)
  assert.equal(r.summary.netPnl, 90, '净盈亏合计 = 各轮净额相加')
  assert.equal(r.summary.winRate, 100)
})

test('方向必须保留时序：先卖后买 = sell-first（不许渲染成"买入→卖出"）', () => {
  const r = dayTradesOf([
    t('2026-03-02', '09:40', 'sell', 100, 11),
    t('2026-03-02', '10:40', 'buy', 100, 10.5),
  ])
  assert.equal(r.rounds.length, 1)
  assert.equal(r.rounds[0].direction, 'sell-first', '先卖后买 ⇒ sell-first')
  assert.equal(r.rounds[0].buyPrice, 10.5, '字段仍标明买入价/卖出价，方向另给')
  assert.equal(r.rounds[0].sellPrice, 11)
  assert.equal(r.rounds[0].grossPnl, 50, '(11 − 10.5) × 100 = 50（先卖后买也是赚 50，公式同向）')
})

test('数量对不齐 / 只买未卖：未配对部分如实列出，不硬凑', () => {
  const r = dayTradesOf([
    t('2026-03-02', '09:40', 'buy', 300, 10, 9, 'b1'),
    t('2026-03-02', '14:00', 'sell', 100, 10.5, 5, 's1'),
  ])
  assert.equal(r.rounds.length, 1, '配成一轮（100 股）')
  assert.equal(r.rounds[0].qty, 100)
  assert.equal(r.unmatched.length, 1, '剩下的 200 股买入未配对')
  assert.equal(r.unmatched[0].qty, 200)
  assert.equal(r.unmatched[0].verb, 'buy')
  assert.ok(r.unmatched[0].note.includes('未配对'))
  // 费用分摊：买入费用 9 中按 1/3 分到这一轮 = 3；卖出费用 5 全部分到这一轮 ⇒ 8
  assert.equal(r.rounds[0].feeShare, 8, '费用按配对数量比例分摊')
  assert.equal(r.rounds[0].netPnl, 50 - 8)
  const only = dayTradesOf([t('2026-03-02', '09:40', 'buy', 100, 10)])
  assert.equal(only.rounds.length, 0)
  assert.equal(only.unmatched.length, 1)
  assert.equal(only.summary.winRate, null, '0 次 ⇒ 胜率 null（不是 0%）')
})

test('净盈亏自洽：每轮 毛 − 费用 = 净，汇总 = 各轮净之和', () => {
  const r = dayTradesOf([
    t('2026-03-02', '09:40', 'buy', 100, 10, 5, 'b1'),
    t('2026-03-02', '14:00', 'sell', 100, 9.8, 5, 's1'),
    t('2026-03-03', '09:40', 'sell', 100, 10.5, 3, 's2'),
    t('2026-03-03', '14:00', 'buy', 100, 10.2, 3, 'b2'),
  ])
  for (const x of r.rounds) assert.ok(Math.abs(x.grossPnl - x.feeShare - x.netPnl) < 1e-9, `${x.day} 毛−费=净`)
  assert.ok(Math.abs(r.summary.netPnl - r.rounds.reduce((n, x) => n + x.netPnl, 0)) < 1e-9)
  assert.equal(r.rounds[0].netPnl, -30, '(9.8−10)*100 − 10 = −30')
  assert.equal(r.rounds[1].netPnl, 30 - 6, '先卖后买：(10.5−10.2)*100 − 6 = 24')
  assert.equal(r.summary.winRate, 50, '1 胜 1 负 ⇒ 50%')
})
