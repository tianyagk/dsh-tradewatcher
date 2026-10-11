/**
 * 分组一屏排序 / 分档统计 / 文本分位 的断言。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { DailyBarLite } from '../shared/model.ts'
import { bucketOf, rankOf, returnBucketOf, textPercentile } from './groupRank.ts'

test('药丸各档之和 = 总数（含"未取到"一档），缺失沉底', () => {
  const rows = [
    { secid: 'a', name: 'A', value: 5, label: '过冷' },
    { secid: 'b', name: 'B', value: 20, label: '偏冷' },
    { secid: 'c', name: 'C', value: 50, label: '适中' },
    { secid: 'd', name: 'D', value: 80, label: '偏热' },
    { secid: 'e', name: 'E', value: 95, label: '过热' },
    { secid: 'f', name: 'F', value: null, label: null, why: '行情未取到' },
  ]
  const r = rankOf(rows)
  assert.equal(r.total, rows.length, '各档之和必须等于总数')
  assert.equal(r.pills.reduce((n, p) => n + p.count, 0), rows.length)
  assert.equal(r.rows[r.rows.length - 1].secid, 'f', '缺失沉底')
  assert.equal(r.rows[0].secid, 'e', '按指标从高到低')
  assert.equal(r.bucketLine, '1 只极冷 / 1 只偏冷 / 1 只中性 / 1 只偏热 / 1 只极热 / 未取到 1 只', '分档行按冷→热读序')
})

test('分档边界：10/30/70/90 与缺失', () => {
  assert.equal(bucketOf(null), '未取到')
  assert.equal(bucketOf(9.99), '极冷')
  assert.equal(bucketOf(10), '偏冷')
  assert.equal(bucketOf(30), '中性')
  assert.equal(bucketOf(70), '偏热')
  assert.equal(bucketOf(90), '极热')
})

test('文本分位：只用能算出来的东西（新高/变化量算不出就不写）', () => {
  // 单调上涨：最后一天是窗口新高 ⇒ 分位 100%，带"新高"
  // 用**等比**上涨（线性上涨的百分比涨幅是递减的，最后一天反而是窗口内最弱的一天）
  const up: DailyBarLite[] = Array.from({ length: 40 }, (_, i) => {
    const c = 100 * 1.01 ** i
    return { date: `2026-01-${String(i + 1).padStart(2, '0')}`, close: c, open: c, high: c, low: c, vol: null }
  })
  const t = textPercentile(up, 30)
  assert.ok(t !== null)
  assert.ok((t?.pct ?? 0) >= 90, `等比上涨的分位应接近 100%（实际 ${String(t?.pct)}）`)
  assert.equal(t?.extreme, 'high')
  assert.ok((t?.text ?? '').includes('日新高'), `实际 ${String(t?.text)}`)
  assert.ok((t?.text ?? '').startsWith('近 30 日分位'), `实际 ${String(t?.text)}`)
  assert.ok((t?.text ?? '').includes('分位 9'), '分位是十位数，格式稳定')
  // 震荡（先涨后跌再涨）：既不是新高也不是新低 ⇒ 文本里**不写**新高/新低那一段
  const wave: DailyBarLite[] = [100, 105, 103, 107, 104, 106, 102, 108, 105, 103, 101, 104, 107, 106, 109, 105, 102, 100, 103, 106, 104, 108, 105, 107, 103, 106, 104, 106, 105, 106].map((c, i) => ({ date: `2026-02-${String(i + 1).padStart(2, '0')}`, close: c, open: c, high: c, low: c, vol: null }))
  const w = textPercentile(wave, 30)
  assert.ok(w !== null)
  assert.equal(w?.extreme, null)
  assert.equal((w?.text ?? '').includes('新高'), false, '算不出新高就不写')
  assert.equal((w?.text ?? '').includes('新低'), false, '算不出新低就不写')
  // 样本不足 ⇒ 返回 null（界面就不显示这一段，不编）
  assert.equal(textPercentile([{ date: '2026-01-01', close: 100, open: 100, high: 100, low: 100, vol: null }], 30), null)
})

test('滞后告警：超阈值才给一行，不超返回 null（不许恒输出）', async () => {
  const { lagAlertOf } = await import('../shared/model.ts')
  const now = Date.parse('2026-10-11T15:00:00+08:00')
  // 日频：3 天阈值
  assert.equal(lagAlertOf(now - 2 * 86_400_000, now, { source: '家数归档', isDaily: true }), null, '2 天 ⇒ 不告警')
  assert.equal(
    lagAlertOf(now - 11 * 86_400_000, now, { source: '家数归档', isDaily: true }),
    '数据更新滞后：家数归档 最新 2026-09-30，落后 11 天',
    '11 天 ⇒ 自动一行',
  )
  // 实时档：30 分钟阈值
  assert.equal(lagAlertOf(now - 5 * 60_000, now, { source: '行情' }), null, '5 分钟 ⇒ 不告警')
  assert.equal(lagAlertOf(now - 45 * 60_000, now, { source: '行情' }), '数据更新滞后：行情 最新 14:15:00，落后 45 分钟')
  // 没有时刻 ⇒ 不告警（未知不是滞后）
  assert.equal(lagAlertOf(null, now, { source: '行情' }), null)
  assert.equal(lagAlertOf(now + 60_000, now, { source: '行情' }), null, '时钟偏差不给告警')
})

test('涨跌幅必须用三档（上涨/平盘/下跌），不能套分位桶', () => {
  const rows = [
    { secid: 'a', name: 'A', value: 3.14, label: '上涨' },
    { secid: 'b', name: 'B', value: 0, label: '平盘' },
    { secid: 'c', name: 'C', value: -6.52, label: '下跌' },
    { secid: 'd', name: 'D', value: null, label: null, why: '行情未取到' },
  ]
  const r = rankOf(rows, {}, returnBucketOf)
  assert.deepEqual(r.rows.map((x) => x.bucket), ['上涨', '平盘', '下跌', '未取到'])
  assert.equal(r.total, 4)
  assert.equal(r.pills.reduce((n, p) => n + p.count, 0), 4, '各档之和 = 总数')
  // 反例（这就是实测抓到的静默错答）：分位桶会把 +3.14% 判成「极冷」
  assert.equal(bucketOf(3.14), '极冷', '分位桶不适合涨跌幅 —— 所以必须显式传 returnBucketOf')
  assert.notDeepEqual(rankOf(rows).rows.map((x) => x.bucket), ['上涨', '平盘', '下跌', '未取到'])
})
