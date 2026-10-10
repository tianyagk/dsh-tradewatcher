/**
 * 五档状态 badge 的口径断言（`src/host/tones.ts`）。
 *
 * 红线两条：① 收益率类**先取负**（收益率上行 = 债券价格走弱 ⇒ 落在"冷"侧）；
 * ② 缺失/样本不足 ⇒ `level: null` + 原因，**绝不用「适中」冒充**。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { DayBar } from '../shared/model.ts'
import { TONE_LEVELS, momentumAt, percentileOf, returnAt, toneLevelOfPct, toneOfBars } from './tones.ts'

const bars = (closes: readonly number[]): DayBar[] =>
  closes.map((c, i) => ({
    date: `2026-${String(1 + Math.floor(i / 28)).padStart(2, '0')}-${String((i % 28) + 1).padStart(2, '0')}`,
    open: c, close: c, high: c, low: c, vol: null, pct: null,
  }))

/** 造一段确定性序列：趋势 + 正弦扰动（用整数种子，避免随机性） */
const series = (n: number, trend: number, amp: number): number[] =>
  Array.from({ length: n }, (_, i) => 100 + trend * i + amp * Math.sin(i / 3))

test('分位 → 档位：五个档位与边界值（10/30/70/90）各取一例', () => {
  assert.equal(toneLevelOfPct(0), '过冷')
  assert.equal(toneLevelOfPct(9.99), '过冷')
  assert.equal(toneLevelOfPct(10), '偏冷')
  assert.equal(toneLevelOfPct(29.99), '偏冷')
  assert.equal(toneLevelOfPct(30), '适中')
  assert.equal(toneLevelOfPct(50), '适中')
  assert.equal(toneLevelOfPct(70), '适中')
  assert.equal(toneLevelOfPct(70.01), '偏热')
  assert.equal(toneLevelOfPct(90), '偏热')
  assert.equal(toneLevelOfPct(90.01), '过热')
  assert.equal(toneLevelOfPct(100), '过热')
  assert.deepEqual([...TONE_LEVELS], ['过冷', '偏冷', '适中', '偏热', '过热'], '五档词表固定')
})

test('满样本（250 根）五档各一例：末段涨得越猛档位越热', () => {
  // 同一段基底（震荡），只在最后 30 根加不同斜率 ⇒ 分位应单调抬升
  const base = series(220, 0.02, 2)
  const spikes = { 过冷: -0.9, 偏冷: -0.25, 适中: 0.02, 偏热: 0.3, 过热: 0.9 }
  const got: Record<string, string | null> = {}
  for (const [want, slope] of Object.entries(spikes)) {
    const closes = [...base, ...Array.from({ length: 30 }, (_, i) => base[base.length - 1] + slope * i)]
    const r = toneOfBars(bars(closes))
    assert.equal(r.level !== null, true, `${want}：250 根样本必须发布档位（实际 ${String(r.why)}）`)
    got[want] = r.level
  }
  assert.equal(got['过冷'], '过冷')
  assert.equal(got['过热'], '过热')
  assert.equal(got['适中'], '适中', `中间斜率应落在适中（实际 ${String(got['适中'])}）`)
})

test('样本降级：120 根与 60 根仍可算，窗口字段如实降级', () => {
  const r120 = toneOfBars(bars(series(120, 0.05, 2)))
  assert.equal(r120.level !== null, true, `120 根应可算（${String(r120.why)}）`)
  assert.equal(r120.window, 120)
  const r60 = toneOfBars(bars(series(60, 0.05, 2)))
  assert.equal(r60.level !== null, true, `60 根应可算（${String(r60.why)}）`)
  assert.equal(r60.window, 60)
  assert.equal(r60.samples, 30, '60 根 ⇒ 30 个 score 样本')
})

test('样本不足不许用「适中」冒充：<31 根 与 score 样本 <30 都要返回 null + 原因', () => {
  const few = toneOfBars(bars(series(30, 0.05, 2)))
  assert.equal(few.level, null, '30 根 < 31 ⇒ 不发布')
  assert.equal(few.insufficient, true)
  assert.ok((few.why ?? '').includes('样本不足'), `原因要写"样本不足"（实际 ${String(few.why)}）`)
  const tiny = toneOfBars(bars(series(3, 0.05, 2)))
  assert.equal(tiny.level, null)
  assert.ok((tiny.why ?? '').includes('日线太少'), '3 根 ⇒ 日线太少')
  // 59 根 ⇒ 29 个 score 样本 < 30 ⇒ 基准不足（不是"适中"）
  const m29 = toneOfBars(bars(series(59, 0.05, 2)))
  assert.equal(m29.level, null, '59 根 ⇒ 分档基准不足')
  assert.ok((m29.why ?? '').includes('分档基准不足'), `实际 ${String(m29.why)}`)
  assert.notEqual(m29.level, '适中')
})

test('收益率类先取负：同一条上行收益率必须落在"冷"侧，价格型同一序列落在"热"侧', () => {
  // 基底有小幅震荡（保证 sd>0，能标准化），最后 30 根陡升 ⇒ 最新一期的 score 远超自身历史
  const base = Array.from({ length: 220 }, (_, i) => 100 + 0.5 * Math.sin(i / 2))
  const rising = [...base, ...Array.from({ length: 30 }, (_, i) => base[base.length - 1] + i * 2)]
  const asPrice = toneOfBars(bars(rising), { isYield: false })
  const asYield = toneOfBars(bars(rising), { isYield: true })
  assert.equal(asPrice.level !== null && asYield.level !== null, true)
  const hotSide = (l: string | null): boolean => l === '偏热' || l === '过热'
  const coldSide = (l: string | null): boolean => l === '过冷' || l === '偏冷'
  assert.equal(hotSide(asPrice.level), true, `价格型上行 ⇒ 偏热/过热（实际 ${String(asPrice.level)}）`)
  assert.equal(coldSide(asYield.level), true, `收益率上行 ⇒ 价格走弱 ⇒ 偏冷/过冷（实际 ${String(asYield.level)}）`)
  // 取负后的 R30 符号必须反过来
  assert.equal((asPrice.r30 ?? 0) > 0, true)
  assert.equal((asYield.r30 ?? 0) < 0, true)
})

test('纯函数分层：returnAt / momentumAt / percentileOf 的边界', () => {
  const c = [100, 100, 100, 100, 100, 110]   // i=5: P/P_{i-5}-1 = 10%
  assert.equal(returnAt(c, 5, 5), 110 / 100 - 1)
  assert.equal(returnAt(c, 4, 5), null, '下标越界 ⇒ null（不拿 0 顶替）')
  assert.equal(returnAt([100, 100], 1, 1), 0, '同价 ⇒ 0%（这是真实值，不是缺失）')
  assert.equal(returnAt(c, 5, 20), null, '下标不足 ⇒ null（不拿 0 顶替）')
  assert.equal(returnAt([0, 1], 1, 1), null, '分母非正 ⇒ null')
  assert.equal(momentumAt(c, 5), null, '需要 30 根才对')
  const long = Array.from({ length: 31 }, (_, i) => 100 + i)
  const mom = momentumAt(long, 30)
  assert.ok(mom !== null && mom < 0, '匀速上行时"近 5 日"弱于"近 20 日" ⇒ 动量为负')
  assert.equal(percentileOf([1, 2, 3, 4], 2.5), 50)
  assert.equal(percentileOf([1, 2, 3, 4], 0), 0, '最小 ⇒ 分位 0（不是 null）')
  assert.equal(percentileOf([1, 2, 3, 4], 9), 100)
  assert.equal(percentileOf([], 1), null, '空样本 ⇒ null')
})

test('红线：无日线 / 空序列 ⇒ 无 badge（不是「适中」）', () => {
  const empty = toneOfBars([])
  assert.equal(empty.level, null)
  assert.equal(empty.pct, null)
  assert.notEqual(empty.level, '适中')
  assert.ok((empty.why ?? '').length > 0, '要给原因')
  const zeros = toneOfBars(bars([0, 0, 0]))
  assert.equal(zeros.level, null, '全 0 收盘不是有效价格 ⇒ 不发布')
})

test('按日 memo：同一天第二次调用不再拉数据（失败也只在冷却期内复用）', async () => {
  const { ToneMemo, computeTones } = await import('./tonesService.ts')
  const memo = new ToneMemo()
  let calls = 0
  const closes = [...Array.from({ length: 220 }, (_, i) => 100 + 0.5 * Math.sin(i / 2)), ...Array.from({ length: 30 }, (_, i) => 100 + i)]
  const fetchKline = async (secid: string) => {
    calls += 1
    return { secid, days: bars(closes), fq: 0 as const, fqSupported: true, stale: false } as never
  }
  const items = [{ secid: '1.000001', kind: 'price' as const }]
  const now = () => Date.parse('2026-10-10T15:30:00+08:00')
  const first = await computeTones(items, { memo, fetchKline: fetchKline as never, now })
  assert.equal(calls, 1, '第一次要拉')
  assert.equal(first.rows[0].level !== null, true, '应给出档位')
  const second = await computeTones(items, { memo, fetchKline: fetchKline as never, now })
  assert.equal(calls, 1, '同一天第二次**不应**再拉数据（走 memo）')
  assert.deepEqual(second.rows[0], first.rows[0], '第二次结果与第一次一致')
  // 换一天 ⇒ 重新拉
  const nextDay = await computeTones(items, { memo, fetchKline: fetchKline as never, now: () => Date.parse('2026-10-11T15:30:00+08:00') })
  assert.equal(calls, 2, '跨交易日要重算')
  assert.equal(nextDay.rows.length, 1)
})

test('取不到日线 ⇒ level null + transient 原因（不许写 0，也不许写「适中」）', async () => {
  const { ToneMemo, computeTones } = await import('./tonesService.ts')
  const r = await computeTones([{ secid: '171.US10Y', kind: 'yield' }], {
    memo: new ToneMemo(),
    fetchKline: (async () => null) as never,
    now: () => Date.parse('2026-10-10T15:30:00+08:00'),
  })
  assert.equal(r.rows[0].level, null)
  assert.notEqual(r.rows[0].level, '适中')
  assert.equal(r.rows[0].r30, null, '不许用 0 顶替')
  assert.ok((r.rows[0].why ?? '').includes('未取到'), `原因要写清楚（实际 ${String(r.rows[0].why)}）`)
  assert.equal(r.missing[0]?.why, 'transient', '取不到是 transient（等上游），不是 no-source')
})

test('噪声序列的档位分布：能落「适中」且不集中于单一档（确认验收口径的更正）', () => {
  // Lead 更正："横盘 ⇒ 适中"不成立 —— 分位法的档位是"相对自身历史的位置"，
  // 横盘序列的档位本就该散开。这里固定种子生成 40 条不同的噪声序列，确认两件事：
  // ① 有序列落在「适中」（不是永远极端）；② 至少出现 3 个不同档位（不集中于单一档）。
  const levels = new Set<string>()
  let mid = 0
  for (let seed = 1; seed <= 40; seed += 1) {
    const closes = Array.from({ length: 250 }, (_, i) => 100 + 3 * Math.sin((i + seed) / 7) + 1.5 * Math.sin((i * seed) / 11))
    const r = toneOfBars(bars(closes))
    if (r.level === null) continue
    levels.add(r.level)
    if (r.level === '适中') mid += 1
  }
  assert.ok(mid > 0, `应有序列落在「适中」（实际 ${mid}/40）`)
  assert.ok(levels.size >= 3, `档位不应集中于单一档（实际出现 ${levels.size} 个：${[...levels].join('/')}）`)
})
