/**
 * 五日档口径行的断言（滞后优先、语义诚实、陈旧近似判据、缺口短形）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { approxWorkdaysBetween, trendCaliberOf } from './trendCaliber.ts'
import { missingBrief } from './trendStitch.ts'

const NOW = Date.parse('2026-10-11T12:00:00+08:00')

test('① 最新数据日 = 预期交易日（今天）⇒ 不加滞后前缀（非恒输出）', () => {
  const c = trendCaliberOf({ lastDay: '10-11', now: NOW, have: 5, limit: 5, missing: [], snapshotAt: '10-11 14:30' })
  assert.equal(c.stale, false)
  assert.equal(c.lagPrefix, '', '不陈旧 ⇒ 滞后前缀必须是空串')
  assert.equal(c.staleNote, '', '不陈旧 ⇒ 不给陈旧提示')
  assert.equal(c.only, '', '满档 ⇒ 不写"仅 N 天可画"')
  assert.equal(c.gaps, '', '无缺口 ⇒ 缺口段为空')
  assert.equal(c.text, '归档 5 天（本插件无多日源，逐日累积）', '满档仍说明来源与累积方式（一句话），但没有任何滞后/陈旧字样')
})

test('② 差 17 天 ⇒ 滞后前缀与"仅 N 天可画"都在（122.XAU 的真实形态）', () => {
  const c = trendCaliberOf({ lastDay: '09-24', now: NOW, have: 1, limit: 5, missing: ['09-25', '09-28', '09-29', '09-30'], snapshotAt: '09-24 13:41' })
  assert.equal(c.stale, true)
  assert.equal(c.naturalDays, 17)
  assert.ok(c.approxWorkdays >= 10, `近似工作日数应显著 >2（实际 ${c.approxWorkdays}）`)
  assert.ok(c.lagPrefix.startsWith('数据滞后 17 天'), c.lagPrefix)
  assert.ok(c.lagPrefix.includes('最近一次成功快照 09-24 13:41'), '滞后前缀要带快照时刻')
  assert.ok(c.text.includes('仅 1 天可画'), c.text)
  assert.ok(c.text.startsWith('数据滞后'), '滞后必须排在最前（用户第一眼看到的就是它）')
  assert.ok(c.text.includes('归档 1 天（本插件无多日源，逐日累积）'))
  assert.ok(c.text.includes('陈旧：图表按真实点画，不插值、不延长'))
  assert.equal(c.text.includes('1/5 天'), false, '旧的 `1/5 天` 写法不许再出现（会被读成"5 天里只取到 1 天"）')
})

test('③ 差 1 个自然日（周末情形）⇒ 不误报陈旧', () => {
  // 2026-10-10 是周六、10-11 是周日：自然日差 1，工作日差 0
  const c = trendCaliberOf({ lastDay: '10-10', now: NOW, have: 3, limit: 5, missing: [], snapshotAt: '10-10 14:30' })
  assert.equal(c.naturalDays, 1)
  assert.equal(c.approxWorkdays, 0)
  assert.equal(c.stale, false, '周末 1 天不该算陈旧')
  assert.equal(c.lagPrefix, '')
  // 差 1 个工作日的场景也不该算陈旧（阈值 ≥2）
  const c2 = trendCaliberOf({ lastDay: '10-08', now: Date.parse('2026-10-09T12:00:00+08:00'), have: 2, limit: 5, missing: [], snapshotAt: '10-08 14:30' })
  assert.equal(c2.approxWorkdays, 1)
  assert.equal(c2.stale, false, '差 1 个工作日不陈旧（阈值 ≥2）')
})

test('④ 缺口用 missingBrief 短形，仍 ≤40 字', () => {
  const many = ['09-25', '09-28', '09-29', '09-30', '10-01', '10-02', '10-05', '10-06', '10-07', '10-08', '10-09']
  const c = trendCaliberOf({ lastDay: '09-24', now: NOW, have: 1, limit: 5, missing: many, snapshotAt: '09-24 13:41' })
  assert.ok(c.gaps.length <= 40, `缺口段要短（实际 ${c.gaps.length} 字：${c.gaps}）`)
  assert.ok(c.gaps.includes('另有 8 天'), `短形要用"另有多少天"收口（实际 ${c.gaps}）`)
  assert.equal(c.gaps.includes('10-09'), false, '短形不铺全部日期（只列前 3 个）')
  assert.ok(missingBrief(many).length <= 40)
})

test('近似工作日数：跳过周末，节假日不跳（如实说这是近似）', () => {
  // 2026-09-25（周五）→ 2026-10-11（周日）：含 09-25~10-09 里的工作日
  const from = Date.parse('2026-09-25T00:00:00+08:00')
  const to = Date.parse('2026-10-11T00:00:00+08:00')
  const n = approxWorkdaysBetween(Date.UTC(2026, 8, 25), Date.UTC(2026, 9, 11))
  assert.ok(n >= 10 && n <= 13, `工作日近似应在合理区间（实际 ${n}）`)
  void from
  void to
  // 国庆假期（10-01~10-07）在近似里仍算工作日 —— 近似这件事在 caliberExplain 里讲一次，
  // 短形（≤40 字）里不重复；这里只钉住"拿不到快照时刻就不写那一段"（不编）。
  const c = trendCaliberOf({ lastDay: '09-24', now: NOW, have: 1, limit: 5, missing: manyHelper(), snapshotAt: null })
  assert.equal(c.lagPrefix.includes('快照'), false, '拿不到快照时刻就不写这一段（不编）')
  assert.ok(c.gaps.length <= 40, `短形要短（实际 ${c.gaps.length} 字）`)
})

function manyHelper(): string[] {
  return ['09-25', '09-28']
}

test('日期解析要接受完整时间戳（界面不许自己 slice —— 截错位置会让滞后判定静默失效）', async () => {
  const { dayNumberOf } = await import('./trendCaliber.ts')
  const now = Date.parse('2026-10-11T12:00:00+08:00')
  assert.notEqual(dayNumberOf('2026-09-24 13:41', now), null, '完整标签要能解析')
  assert.equal(dayNumberOf('09-24', now), Date.UTC(2026, 8, 24), 'MM-DD 也能解析（按 now 的年份）')
  assert.equal(dayNumberOf('2026-', now), null, '被截断的 `2026-` 解析不出来 —— 这正是界面 slice(0,5) 踩过的坑')
  const c = trendCaliberOf({ lastDay: '2026-09-24 13:41', now, have: 1, limit: 5, missing: [], snapshotAt: '09-24 13:41' })
  assert.equal(c.stale, true)
  assert.equal(c.naturalDays, 17)
  const broken = trendCaliberOf({ lastDay: '2026-', now, have: 1, limit: 5, missing: [], snapshotAt: '09-24 13:41' })
  assert.equal(broken.stale, false, '解析不出日期 ⇒ 不给滞后前缀（但也不该发生：界面传原始 label）')
  assert.equal(broken.only, '仅 1 天可画', '"仅 N 天可画"与滞后判定相互独立，不受解析失败影响')
})
