/**
 * 信号前瞻表现的断言（口径红线：必须同时给基准与持有期；样本过少要标注；缺失不当 0）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { DailyBarLite } from '../shared/model.ts'
import { FORWARD_MIN_SAMPLES, forwardOf } from './signalForward.ts'

const bars = (pairs: Array<[string, number]>): DailyBarLite[] => pairs.map(([date, close]) => ({ date, close, open: close, high: close, low: close, vol: null }))

test('手算对照：两个事件的涨跌幅与超额必须与手算逐位一致', () => {
  // 标的：01-10 收盘 100 → 01-20 收盘 110（+10%）；基准同期 200 → 210（+5%）
  const stock = bars([['2026-01-09', 98], ['2026-01-10', 100], ['2026-01-15', 105], ['2026-01-20', 110]])
  const bench = bars([['2026-01-09', 198], ['2026-01-10', 200], ['2026-01-15', 205], ['2026-01-20', 210]])
  const ev = [
    { day: '2026-01-10', level: 2, label: '疑似护盘', indicators: '量能 2.4x' },
    { day: '2026-01-15', level: 1, label: '资金异动', indicators: '脉冲 3.1x' },
  ]
  const r = forwardOf(ev, stock, bench, '沪深300')
  // 手算：事件1 100 → 110 = +10.00%；基准 200 → 210 = +5.00%；超额 +5.00%；持有期 01-10→01-20 = 10 自然日
  assert.ok(Math.abs((r.rows[0].retPct ?? 0) - 10) < 1e-9)
  assert.ok(Math.abs((r.rows[0].benchPct ?? 0) - 5) < 1e-9)
  assert.ok(Math.abs((r.rows[0].excess ?? 0) - 5) < 1e-9)
  assert.equal(r.rows[0].holdDays, 10)
  assert.equal(r.rows[1].holdDays, 5)
  // 事件2 105 → 110 = +4.7619%；基准 205 → 210 = +2.4390%；超额 = +2.3229%
  assert.ok(Math.abs((r.rows[1].retPct ?? 0) - (110 / 105 - 1) * 100) < 1e-9)
  assert.ok(Math.abs((r.rows[1].excess ?? 0) - ((110 / 105 - 1) * 100 - (210 / 205 - 1) * 100)) < 1e-9)
  // 持有期的交易日：01-15 → 01-20 之间新增 1 根（01-20）
  assert.equal(r.rows[1].holdTradingDays, 1)
})

test('退化：信号日就是最新数据日 ⇒ 持有期 0、涨跌幅 —（不是 0%）', () => {
  const stock = bars([['2026-01-10', 100]])
  const bench = bars([['2026-01-10', 200]])
  const r = forwardOf([{ day: '2026-01-10', level: 2, label: '疑似护盘', indicators: 'x' }], stock, bench, '沪深300')
  assert.equal(r.rows[0].retPct, null)
  assert.notEqual(r.rows[0].retPct, 0)
  assert.equal(r.rows[0].holdDays, 0)
  assert.equal(r.rows[0].holdTradingDays, 0)
  assert.ok((r.rows[0].why ?? '').includes('持有期 0'))
  assert.equal(r.summary.n, 0)
})

test('红线：基准缺失 ⇒ 超额 — 且原因写明（不把缺失当 0）', () => {
  const stock = bars([['2026-01-10', 100], ['2026-01-20', 110]])
  const r = forwardOf([{ day: '2026-01-10', level: 2, label: '疑似护盘', indicators: 'x' }], stock, [], '沪深300')
  assert.equal(r.rows[0].retPct !== null, true, '标的涨跌幅照给')
  assert.equal(r.rows[0].benchPct, null, '基准缺失 ⇒ null')
  assert.equal(r.rows[0].excess, null, '超额不可算')
  assert.ok((r.rows[0].why ?? '').includes('基准'))
  assert.equal(r.summary.n, 0, '不可算的不计入样本')
})

test('汇总：样本数必须一起给；<10 时显式标注"样本过少，不构成统计结论"', () => {
  // 每个信号日之后都要有 bar（否则起点会落到最后一根 ⇒ 退化成"持有期 0"，不计入样本）
  const mk = (n: number) => Array.from({ length: n }, (_, i) => `2026-01-${String(i + 1).padStart(2, '0')}`)
  const days = [...mk(10), '2026-02-01']
  const stock = bars(days.map((d, i) => [d, 100 + i * 2]))
  const bench = bars(days.map((d, i) => [d, 100 + i]))
  const few = Array.from({ length: 3 }, (_, i) => ({ day: `2026-01-0${i + 1}`, level: 1, label: '资金异动', indicators: 'x' }))
  const r3 = forwardOf(few, stock, bench, '沪深300')
  assert.equal(r3.summary.n, 3, '样本数要一起给')
  assert.ok((r3.summary.note ?? '').includes('样本过少'), `实际 ${String(r3.summary.note)}`)
  assert.ok((r3.summary.note ?? '').includes('不构成统计结论'))
  assert.ok(r3.methodology.includes('样本数'), '口径里说明样本怎么数')
  assert.ok(r3.disclaimer.includes('不许') || r3.disclaimer.includes('不能'), '必须带"不能用来干什么"')
  assert.ok(r3.disclaimer.includes('不是"信号有预测能力"') || r3.disclaimer.includes('不是“信号有预测能力”'), '红线原句要在')
  const many = Array.from({ length: FORWARD_MIN_SAMPLES }, (_, i) => ({ day: `2026-01-${String(i + 1).padStart(2, '0')}`, level: 1, label: '资金异动', indicators: 'x' }))
  const r10 = forwardOf(many, stock, bench, '沪深300')
  assert.equal(r10.summary.note, null, '样本够 ⇒ 不加标注')
  assert.equal(r10.summary.winRate, 100, '全部跑赢基准 ⇒ 胜率 100%')
})
