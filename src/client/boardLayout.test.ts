/**
 * 大盘页布局/密度的断言（设计规范 `docs/DESIGN-DASHBOARD.md` §5 的"可执行断言"）。
 *
 * 锁三件事：① 12 栏档位（1440 与 2142 同档、<1080 单列）；② 家数缺失塌成一格、真 0 不被误判为缺失；
 * ③ 分布条空样本时给 `{ok:false}` 而不是全 0 数组（全 0 会被画成一条"有内容"的条）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { amountMetric, boardSpans, breadthMetrics, percentileBar, shortReason } from './boardLayout.ts'

test('12 栏档位：<1080 全单列；≥1080 为 5/7/12/7/5；1440 与 2142 同档', () => {
  assert.deepEqual(boardSpans(1079), { single: true, b1: 12, b2: 12, b3: 12, b4: 12, b5: 12 })
  const wide = { single: false, b1: 5, b2: 7, b3: 12, b4: 7, b5: 5 }
  assert.deepEqual(boardSpans(1080), wide)
  assert.deepEqual(boardSpans(1440), wide)
  assert.deepEqual(boardSpans(2142), wide, '2142 不许出现第三档')
  assert.deepEqual(boardSpans(Number.NaN), boardSpans(0), '非数按单列处理（不猜宽度）')
})

test('家数缺失 ⇒ 塌成一格且不带 0；原因随那一格给出', () => {
  const items = breadthMetrics({ countsOk: false, up: null, down: null, even: null, reason: '沪市上涨家数未取到' })
  assert.equal(items.length, 1, '三格必须合并成一格（V4：缺失态高度 ≤25px）')
  assert.equal(items[0].label, '涨跌家数')
  assert.equal(items[0].value, null, '缺失不许拿 0 顶替')
  assert.equal(items[0].reason, '沪市上涨家数未取到')
})

test('家数为真 0 时照样出三格、显示 0（真 0 不得被误判为缺失）', () => {
  const items = breadthMetrics({ countsOk: true, up: 0, down: 0, even: 0, reason: null })
  assert.equal(items.length, 3)
  assert.deepEqual(items.map((i) => i.value), ['0', '0', '0'])
  assert.ok(items.every((i) => i.reason === null), '可得时不该有原因')
})

test('成交额分项独立判定：某一市缺失只影响那一格', () => {
  assert.equal(amountMetric('sh', '沪市成交额', 1234).value, '1234')
  const missing = amountMetric('sz', '深市成交额', null)
  assert.equal(missing.value, null)
  assert.ok((missing.reason ?? '').length > 0, '缺失要能说明原因')
})

test('可见原因压缩：只截断不编造，且保留完整原文的入口（title 用）', () => {
  assert.equal(shortReason('沪市上涨家数未取到；深市下跌家数未取到'), '沪市上涨家数未取到')
  const long = shortReason('自统计未成功：东财 clist（fetch failed）；降序分页扫描（HTTP 403）', 16)
  assert.ok(long.endsWith('…') && long.length <= 17, `截断结果要短：${long}`)
  assert.equal(shortReason('已取到'), '已取到')
})

test('分布条：空样本给 {ok:false}，绝不返回全 0 数组', () => {
  const empty = percentileBar([], 0.5)
  assert.equal(empty.ok, false)
  assert.deepEqual(empty.bars, [], '空样本不许造一条全 0 的条')
  assert.ok((empty.reason ?? '').length > 0)
  assert.equal(percentileBar([0.4, 0.6], null).ok, false, '当前值不可得时也不画')
})

test('分布条：升序、长度 ≤ 60、当前位置落在 [0,1]', () => {
  const samples = Array.from({ length: 80 }, (_, i) => 0.2 + i * 0.005)
  const bar = percentileBar(samples, 0.35)
  assert.equal(bar.ok, true)
  assert.equal(bar.bars.length, 60, '最多 60 根（窗口内）')
  assert.deepEqual([...bar.bars].sort((a, b) => a - b), bar.bars, '必须升序，画出来才单调')
  assert.ok(bar.at !== null && bar.at >= 0 && bar.at <= 1, `位置要在 [0,1]：${bar.at}`)
  // 样本全相等时不除以 0
  assert.equal(percentileBar([0.5, 0.5, 0.5], 0.5).at, 0.5)
})
