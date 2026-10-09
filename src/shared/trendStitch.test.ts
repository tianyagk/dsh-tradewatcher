/**
 * 本地多日拼接的断言（不补、不猜、不假装）。
 *
 * 场景：`五日` 在非沪/深市场没有真实多日分钟源，改为把每日归档的分时拼起来 ——
 * 因此"到底有几天、缺哪几天"必须与点数是同一批数据算出来的，且缺失的**如实列出**。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { TrendPoint } from './model.ts'
import { stitchTrendDays } from './trendStitch.ts'

const pt = (t: number, label: string, price: number): TrendPoint => ({ t, label, price, avg: null, vol: null })

const day = (d: string, n: number): { day: string; points: TrendPoint[] } => ({
  day: d,
  points: Array.from({ length: n }, (_, i) => pt(Date.parse(`${d}T01:${String(i).padStart(2, '0')}:00Z`), `${d} 09:${String(i).padStart(2, '0')}`, 10 + i)),
})

test('拼接：按日期升序、日分隔线落在每天第一个点、点数连续', () => {
  const r = stitchTrendDays([day('2026-10-08', 3), day('2026-10-07', 2), day('2026-10-09', 2)], { limitDays: 5, today: '2026-10-09' })
  assert.deepEqual(r.coverage.have, ['2026-10-07', '2026-10-08', '2026-10-09'])
  assert.equal(r.points.length, 7)
  assert.deepEqual(r.breaks, [0, 2, 5], '每天第一个点的位置')
  assert.deepEqual(r.points.map((p) => p.label.slice(0, 10)), [
    '2026-10-07', '2026-10-07', '2026-10-08', '2026-10-08', '2026-10-08', '2026-10-09', '2026-10-09',
  ])
})

test('覆盖报告：缺的工作日如实列出（不补），周末不算缺', () => {
  // 10-07(三) 有、10-08(四) 缺、10-09(五) 有、10-10/11 周末 → 只有 10-08 该被列出
  const r = stitchTrendDays([day('2026-10-07', 2), day('2026-10-09', 2)], { limitDays: 5, today: '2026-10-10' })
  assert.deepEqual(r.coverage.have, ['2026-10-07', '2026-10-09'])
  assert.deepEqual(r.coverage.missing, ['2026-10-08'], '只列工作日里缺的那天')
  assert.equal(r.coverage.limit, 5, '分母是请求天数：界面显示 2/5 天')
})

test('今天只有 1 天：have=[今天]、missing 为空（界面的"仅当日"就靠这个）', () => {
  const r = stitchTrendDays([day('2026-10-09', 5)], { limitDays: 5, today: '2026-10-09' })
  assert.deepEqual(r.coverage.have, ['2026-10-09'])
  assert.deepEqual(r.coverage.missing, [], '刚开始累积时不该报"缺"')
  assert.equal(r.points.length, 5)
  assert.deepEqual(r.breaks, [0])
})

test('空序列 / 点不足 2 个的日期不计入覆盖（不拿 1 个点充一天）', () => {
  const r = stitchTrendDays([day('2026-10-07', 0), day('2026-10-08', 1), day('2026-10-09', 2)], { limitDays: 5, today: '2026-10-09' })
  assert.deepEqual(r.coverage.have, ['2026-10-09'])
  assert.equal(r.points.length, 2)
})

test('同一天只保留一份（后到的覆盖先到的）', () => {
  const r = stitchTrendDays([day('2026-10-09', 2), day('2026-10-09', 4)], { limitDays: 5, today: '2026-10-09' })
  assert.equal(r.coverage.have.length, 1)
  assert.equal(r.points.length, 4, '用后传入的那份（归档是覆盖写，后到的更完整）')
})

test('非法日期 / 非法价格被丢弃：拼接结果里不得出现不可用的点', () => {
  const bad = { day: 'not-a-day', points: [pt(1, 'x', 10), pt(2, 'y', 11)] }
  const dirty: TrendPoint[] = [
    pt(1, '2026-10-09 09:30', 0),
    pt(2, '2026-10-09 09:31', 10.5),
    pt(3, '2026-10-09 09:32', Number.NaN),
    pt(4, '2026-10-09 09:33', 10.6),
    pt(5, '2026-10-09 09:34', 10.7),
  ]
  const r = stitchTrendDays([bad, { day: '2026-10-09', points: dirty }], { limitDays: 5, today: '2026-10-09' })
  assert.deepEqual(r.coverage.have, ['2026-10-09'])
  assert.equal(r.points.length, 3, 'price=0 与 NaN 都不是有效分时点，只剩 3 个有效点')
})
