/**
 * P1-4 / P1-8 的断言。
 *
 * 这两块的共同风险是**把"没判定"当成"正常"**、以及**把没参照物的数当结论**：
 *   - 异动：样本不足 / 非交易时段必须与"判定过且无异常"分开；
 *   - 静默：30 分钟内不重复提醒，但"它正在异动"这个事实不能被抹掉；
 *   - 分位：样本 < 5 不给分位（要用 null，不是 0）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { CalEvent, DayBar, LedgerEntry, PortGroup, PortItem, QuoteRow } from '../shared/model.ts'
import { normalizeFxRate, normalizeFxRates } from '../shared/model.ts'
import { assemblePortfolio } from './portfolio.ts'
import { BASELINE_DAYS, MIN_SAMPLES, VOLUME_MULT_ALERT, judgeAnomaly } from './anomaly.ts'
import { BREADTH_MIN_DAYS, percentileOf, upRatio } from './breadth.ts'
import { withChangeHistory } from './calendar.ts'

/** 构造一段日线：前 n 根量能恒为 base，最后一根为 todayVol（date = today） */
function bars(n: number, base: number, todayVol: number, today = '2026-10-08'): DayBar[] {
  const out: DayBar[] = []
  for (let i = n; i >= 1; i -= 1) {
    out.push({ date: `2026-09-${String(i).padStart(2, '0')}`, open: 1, close: 1, high: 1, low: 1, vol: base, pct: 0 })
  }
  out.push({ date: today, open: 1, close: 1, high: 1, low: 1, vol: todayVol, pct: 0 })
  return out
}

const OPEN = { hhmm: '10:00', inSessionNow: true, today: '2026-10-08' }

/** 极简行情构造（P1-11 用例用；只关心价格） */
function q(secid: string, price: number, prev: number): QuoteRow {
  return {
    secid, code: secid, name: secid, price, chg: price - prev, pct: ((price - prev) / prev) * 100,
    prev, open: price, high: price, low: price, vol: 1, amount: 1, up: null, down: null, even: null,
    time: null, at: Date.now(), source: 'em',
  }
}

test('P1-4 量能异动：同时点口径 —— 早盘同样的量比尾盘更"异常"', () => {
  // 20 日基线 100，今日量 200 → 到尾盘（进度 1.0）是 2.0x，未越 2.5x
  const late = judgeAnomaly({ bars: bars(20, 100, 200), pct: 0.5, ...OPEN, hhmm: '15:00' })
  assert.equal(late.kind, null)
  assert.ok(late.mult !== null && late.mult > 1.9 && late.mult < 2.1, `尾盘量能倍数应约 2.0，实际 ${late.mult}`)
  // 同一份数据在 10:00（进度约 0.4）→ 倍数约 5x，越线
  const early = judgeAnomaly({ bars: bars(20, 100, 200), pct: 0.5, ...OPEN })
  assert.equal(early.kind, 'volume')
  assert.ok(early.mult !== null && early.mult > VOLUME_MULT_ALERT, `早盘量能倍数应远超阈值，实际 ${early.mult}`)
  assert.ok(early.reasons[0].includes('放量'))
})

test('P1-4 样本不足 / 非交易时段：不给判定，且与"无异常"分开', () => {
  const few = judgeAnomaly({ bars: bars(MIN_SAMPLES - 2, 100, 900), pct: 0.1, ...OPEN })
  assert.equal(few.kind, null)
  assert.equal(few.reasons.length, 0)
  assert.equal(few.skip.length, 1, '必须给出"为什么不判定"')
  assert.ok(few.skip[0].includes('样本不足'))

  const closed = judgeAnomaly({ bars: bars(20, 100, 900), pct: 9.9, hhmm: '16:00', inSessionNow: false, today: '2026-10-08' })
  assert.equal(closed.kind, null)
  assert.equal(closed.reasons.length, 0)
  assert.ok(closed.skip.length === 1 && closed.skip[0].includes('非交易时段'))

  // 判定过且无异常：skip 与 reasons 都为空 —— 这是唯一能说"正常"的情形。
  // 注意必须用**收盘时点**：同时点口径下同一份"今日量"在 10:00 意味着 ~2.9 倍
  // （进度才 0.33），在 15:00 才意味着 0.95 倍。这不是实现问题，正是这条口径的意义。
  const calm = judgeAnomaly({ bars: bars(20, 100, 95), pct: 0.2, ...OPEN, hhmm: '15:00' })
  assert.equal(calm.kind, null)
  assert.deepEqual(calm.skip, [])
  assert.deepEqual(calm.reasons, [])
})

test('P1-4 日线里还没有今天这一根 / 今日量缺失：不拿"旧的那根"顶替', () => {
  const stale = judgeAnomaly({ bars: bars(20, 100, 500, '2026-10-07'), pct: 0.1, ...OPEN })
  assert.equal(stale.kind, null)
  assert.ok(stale.skip[0].includes('还没有 2026-10-08'))

  const noVol = bars(20, 100, 300)
  noVol[noVol.length - 1] = { ...noVol[noVol.length - 1], vol: null }
  const missing = judgeAnomaly({ bars: noVol, pct: 0.1, ...OPEN })
  assert.equal(missing.kind, null)
  assert.ok(missing.skip[0].includes('成交量暂缺'))
})

test('P1-4 价格异动与量价共振：单条越线与组合越线都能区分', () => {
  const price = judgeAnomaly({ bars: bars(20, 100, 90), pct: -6.2, ...OPEN, hhmm: '15:00' })
  assert.equal(price.kind, 'price')
  assert.ok(price.reasons[0].includes('-6.20%'))

  // 涨 3.5%（未达 5%）且量能 2.2x（未达 2.5x）→ 单条都不越线，但组合越线
  const combo = judgeAnomaly({ bars: bars(20, 100, 220), pct: 3.5, ...OPEN, hhmm: '15:00' })
  assert.equal(combo.kind, 'both')
  assert.ok(combo.reasons[0].includes('量价共振'))

  // 两条都越线 → both，两条原因都在
  const bothHit = judgeAnomaly({ bars: bars(20, 100, 300), pct: 6, ...OPEN, hhmm: '15:00' })
  assert.equal(bothHit.kind, 'both')
  assert.equal(bothHit.reasons.length, 2)
})

test('P1-4 基线只用有量的那几根，窗口上限是 BASELINE_DAYS', () => {
  const long = bars(BASELINE_DAYS + 15, 100, 100)
  const r = judgeAnomaly({ bars: long, pct: 0.5, ...OPEN, hhmm: '15:00' })
  assert.equal(r.samples, BASELINE_DAYS, '参与均量的应被截到窗口上限')
  assert.ok(r.mult !== null && Math.abs(r.mult - 1) < 0.05, `量能与基线相同应约 1.0x，实际 ${r.mult}`)
})

// ── P1-8 涨跌家数分位 ─────────────────────────────────────────────────────

test('P1-8 上涨占比：总数为 0 时是 null（不做 0/0 的假值）', () => {
  assert.equal(upRatio({ up: 3000, down: 1000, even: 0 }), 0.75)
  assert.equal(upRatio({ up: 0, down: 0, even: 0 }), null)
})

test('P1-8 分位：样本不足不给分位（null，而不是 0）', () => {
  const hist = Array.from({ length: BREADTH_MIN_DAYS - 1 }, (_, i) => ({ up: i, down: 10, even: 0 }))
  const r = percentileOf(0.5, hist)
  assert.equal(r.sampleSmall, true)
  assert.equal(r.pct, null)
  assert.equal(r.n, hist.length)
  assert.ok(r.metric.includes('上涨家数占比'), '口径说明必须随结果一起给出')
})

test('P1-8 分位：定义是「历史中 ≤ 当前值的比例」，两端取 0 与 100', () => {
  const hist = [
    { up: 10, down: 90, even: 0 }, // 0.10
    { up: 30, down: 70, even: 0 }, // 0.30
    { up: 50, down: 50, even: 0 }, // 0.50
    { up: 70, down: 30, even: 0 }, // 0.70
    { up: 90, down: 10, even: 0 }, // 0.90
  ]
  assert.equal(percentileOf(0.05, hist).pct, 0, '比所有历史都低 → 0')
  assert.equal(percentileOf(0.95, hist).pct, 100, '比所有历史都高 → 100')
  assert.equal(percentileOf(0.5, hist).pct, 60, '≤0.5 的历史有 3 个（含等于）→ 60%')
  assert.equal(percentileOf(0.5, hist).n, 5)
})

test('P1-8 分位：坏样本被剔除，不参与计算也不虚增样本量', () => {
  const hist = [
    { up: 10, down: 90, even: 0 },
    { up: 0, down: 0, even: 0 }, // 占比不可算 → 剔除
    { up: 20, down: 80, even: 0 },
    { up: 30, down: 70, even: 0 },
    { up: 40, down: 60, even: 0 },
    { up: 50, down: 50, even: 0 },
  ]
  const r = percentileOf(0.15, hist)
  assert.equal(r.n, 5, '不可算的那条不算进样本')
  assert.equal(r.sampleSmall, false)
  assert.equal(r.pct, 20, '≤0.15 的只有 0.10 一个 → 1/5 = 20%')
  assert.deepEqual(r.samples, [0.1, 0.2, 0.3, 0.4, 0.5])
})

// ── P1-10 日历改期留痕 ────────────────────────────────────────────────────

test('P1-10 改期留痕：日期变化记 from→to，未变化不留痕', () => {
  const prev: CalEvent[] = [
    { id: 'auto:a', date: '2026-10-09', title: '长鑫科技 上市首日', category: 'ipo' as const, importance: 3 as const, source: 'auto' as const, autoKey: 'ipo:688825:listing' },
  ]
  const freshSame: CalEvent[] = [
    { id: 'auto:a', date: '2026-10-09', title: '长鑫科技 上市首日', category: 'ipo' as const, importance: 3 as const, source: 'auto' as const, autoKey: 'ipo:688825:listing' },
  ]
  const unchanged = withChangeHistory(prev, freshSame, 1000)
  assert.equal(unchanged[0].changes, undefined, '没变就不该留痕（否则人人都是"可能变更"）')

  const freshMoved: CalEvent[] = [{ ...freshSame[0], date: '2026-10-16' }]
  const moved = withChangeHistory(prev, freshMoved, 2000)
  assert.equal(moved[0].date, '2026-10-16', '以最新日期为准')
  assert.equal(moved[0].changes?.length, 1)
  assert.deepEqual(moved[0].changes?.[0], { at: 2000, field: 'date', from: '2026-10-09', to: '2026-10-16' })
})

test('P1-10 改期留痕：多次改期累积，且只保留最近 5 条', () => {
  let prev: CalEvent[] = [
    { id: 'auto:a', date: '2026-10-01', title: 'x', category: 'ipo' as const, importance: 3 as const, source: 'auto' as const, autoKey: 'k' },
  ]
  for (let i = 1; i <= 8; i += 1) {
    const fresh: CalEvent[] = [{ ...prev[0], date: `2026-10-${String(i + 1).padStart(2, '0')}` }]
    prev = withChangeHistory(prev, fresh, 1000 + i)
  }
  assert.equal(prev[0].changes?.length, 5, '上限 5 条（再多也没有可操作性）')
  assert.equal(prev[0].changes?.[4].to, '2026-10-09', '保留的是最近几次')
})

test('P1-10 改期留痕：手动事件与没有 autoKey 的事件不受影响', () => {
  const manual: CalEvent[] = [
    { id: 'm1', date: '2026-10-01', title: '手动', category: 'other' as const, importance: 2 as const, source: 'manual' as const },
  ]
  const fresh: CalEvent[] = [{ ...manual[0], date: '2026-10-02' }]
  const out = withChangeHistory(manual, fresh, 1000)
  assert.equal(out[0].changes, undefined, '手动事件由用户自己维护，不做自动改期记录')
})

// ── P1-11 跨市场折算 ─────────────────────────────────────────────────────

test('P1-11 折算：不折算时不折算、开了固定汇率才折，且缺汇率照样排除', () => {
  const groups: PortGroup[] = [{ id: 'g1', name: '主仓', order: 1 }]
  const items: PortItem[] = [
    { id: 'p1', groupId: 'g1', secid: '1.600519', name: 'A股', createdAt: 1 },
    { id: 'p2', groupId: 'g1', secid: '116.00700', name: '港股', createdAt: 2 },
    { id: 'p3', groupId: 'g1', secid: '105.AAPL', name: '美股', createdAt: 3 },
  ]
  const entries: LedgerEntry[] = [
    { id: 'e1', ts: 1, actor: 'web', verb: 'buy', posId: 'p1', groupId: 'g1', secid: '1.600519', name: 'A股', qty: 100, price: 100 },
    { id: 'e2', ts: 2, actor: 'web', verb: 'buy', posId: 'p2', groupId: 'g1', secid: '116.00700', name: '港股', qty: 200, price: 300 },
    { id: 'e3', ts: 3, actor: 'web', verb: 'buy', posId: 'p3', groupId: 'g1', secid: '105.AAPL', name: '美股', qty: 10, price: 400 },
  ]
  const quotes = {
    '1.600519': q('1.600519', 120, 110),
    '116.00700': q('116.00700', 320, 310),
    '105.AAPL': q('105.AAPL', 400, 400),
  }

  // ① 不折算：总额只有 A股 100×120
  const none = assemblePortfolio(groups, items, entries, quotes)
  assert.equal(none.view.fxMode, 'none')
  assert.equal(none.view.grand.totalMv, 12000)
  assert.equal((none.view.unpriced ?? []).length, 2, '港股与美股都逐项说明')
  assert.deepEqual(none.view.fxRates, {})

  // ② 只给港元汇率：港股折算进总额（200×320×0.92），美股仍被排除
  const hkOnly = assemblePortfolio(groups, items, entries, quotes, { mode: 'fixed', rates: { HKD: 0.92 } })
  assert.equal(hkOnly.view.fxMode, 'fixed')
  assert.equal(hkOnly.view.grand.totalMv, 12000 + 64000 * 0.92)
  const rest = hkOnly.view.unpriced ?? []
  assert.equal(rest.length, 1, '只剩美股未折算')
  assert.equal(rest[0].secid, '105.AAPL')
  assert.ok(rest[0].note.includes('美元'), '要说明缺的是哪个币种的汇率')
  assert.ok(rest[0].note.includes('不是按 1:1'), '必须写清不是按 1:1 加进去')
  assert.deepEqual(hkOnly.view.fxRates, { HKD: 0.92 }, '实际生效的汇率要能回读')

  // ③ 两个都给：全部折算
  const both = assemblePortfolio(groups, items, entries, quotes, { mode: 'fixed', rates: { HKD: 0.92, USD: 7.15 } })
  assert.equal(both.view.grand.totalMv, Math.round((12000 + 64000 * 0.92 + 4000 * 7.15) * 100) / 100)
  assert.equal((both.view.unpriced ?? []).length, 0)
})

test('P1-11 汇率归一化：越界或非数字一律拒绝（宁可不折算也不填错数量级）', () => {
  assert.equal(normalizeFxRate(7.15), 7.15)
  assert.equal(normalizeFxRate(0.92), 0.92)
  assert.equal(normalizeFxRate(715), undefined, '数量级填错必须拒绝')
  assert.equal(normalizeFxRate(0.001), undefined)
  assert.equal(normalizeFxRate(-1), undefined)
  assert.equal(normalizeFxRate('7.15'), undefined, '字符串不隐式转换')
  assert.equal(normalizeFxRate(NaN), undefined)
  assert.deepEqual(normalizeFxRates({ HKD: 0.92, USD: 715, EUR: 7.8 }), { HKD: 0.92 }, '越界与未知币种都被剔除')
  assert.deepEqual(normalizeFxRates(null), {})
})

test('P1-11 无法折算的市场（指数/期货）即使开了固定汇率也不进总额', () => {
  const groups: PortGroup[] = [{ id: 'g1', name: '主仓', order: 1 }]
  const items: PortItem[] = [{ id: 'p1', groupId: 'g1', secid: '100.KOSPI200', name: '韩国指数', createdAt: 1 }]
  const entries: LedgerEntry[] = [
    { id: 'e1', ts: 1, actor: 'web', verb: 'buy', posId: 'p1', groupId: 'g1', secid: '100.KOSPI200', name: '韩国指数', qty: 1, price: 1000 },
  ]
  const { view } = assemblePortfolio(groups, items, entries, { '100.KOSPI200': q('100.KOSPI200', 1088, 1000) }, { mode: 'fixed', rates: { HKD: 0.92, USD: 7.15 } })
  assert.equal(view.grand.totalMv, 0, '指数没有可折算的币种')
  assert.equal((view.unpriced ?? []).length, 1)
  assert.ok((view.unpriced ?? [])[0].note.includes('没有可折算的币种'))
})
