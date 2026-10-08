/**
 * P1-4 提醒策略（静默窗口）的断言。
 *
 * 最容易写错的一点：静默**只压制提醒**，不能把"它正在异动"这个事实也抹掉 ——
 * 否则用户会看到"明明在放量，徽标却是 0"，然后不再相信这个徽标。
 * 另一半风险是把"没判定"混进"正常"，见 judgeAlerts 的 calm/skipped 分家。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { SILENCE_MS, judgeAlerts, pruneSeen, type RawAlertRow } from './alertRules.ts'

const NOW = 1_800_000_000_000

function hit(secid: string, kind: 'volume' | 'price' | 'both' = 'volume'): RawAlertRow {
  return { secid, name: secid, kind, mult: 3.1, samples: 20, pct: 1.2, reasons: ['放量：同时点量能 3.10x'], skip: [] }
}
function calm(secid: string): RawAlertRow {
  return { secid, name: secid, kind: null, mult: 0.9, samples: 20, pct: 0.1, reasons: [], skip: [] }
}
function notJudged(secid: string): RawAlertRow {
  return { secid, name: secid, kind: null, mult: null, samples: 2, pct: null, reasons: [], skip: ['可用均量样本仅 2 个交易日（需 ≥ 5）'] }
}

test('静默窗口：首次提醒、30 分钟内不再提醒、超时后再次提醒', () => {
  const first = judgeAlerts([hit('1.600519')], {}, NOW)
  assert.equal(first.alerts.length, 1)
  assert.equal(first.suppressed.length, 0)
  assert.equal(first.nextSeen['1.600519'], NOW, '提醒后要记下时刻')

  const again = judgeAlerts([hit('1.600519')], first.nextSeen, NOW + 60_000)
  assert.equal(again.alerts.length, 0, '1 分钟后不该再提醒')
  assert.equal(again.suppressed.length, 1, '但必须仍标为"异动中（静默）"')
  assert.equal(again.suppressed[0].kind, 'volume')
  assert.equal(again.nextSeen['1.600519'], NOW, '静默期间不刷新时刻')

  const later = judgeAlerts([hit('1.600519')], first.nextSeen, NOW + SILENCE_MS)
  assert.equal(later.alerts.length, 1, '窗口边界（正好 30 分钟）应重新提醒')
  assert.equal(later.suppressed.length, 0)
})

test('静默窗口：多条目各自独立，互不影响', () => {
  const seen = { '1.600519': NOW }
  const r = judgeAlerts([hit('1.600519'), hit('0.300750')], seen, NOW + 1000)
  assert.deepEqual(r.alerts.map((a) => a.secid), ['0.300750'])
  assert.deepEqual(r.suppressed.map((a) => a.secid), ['1.600519'])
})

test('「判定过且无异常」与「根本没判定」必须分开计数', () => {
  const r = judgeAlerts([calm('a'), calm('b'), notJudged('c'), hit('d')], {}, NOW)
  assert.equal(r.calm, 2, '判定过且无异常')
  assert.equal(r.skipped.length, 1, '没判定的单独列')
  assert.equal(r.skipped[0].secid, 'c')
  assert.ok(r.skipped[0].skip[0].includes('可用均量样本'), '原因原样透传，不能被改写')
  assert.equal(r.alerts.length, 1)
})

test('静默记录裁剪：只留窗口内的，未来时间戳要保留', () => {
  const pruned = pruneSeen({ old: NOW - SILENCE_MS - 1, fresh: NOW - 1000, future: NOW + 60_000 }, NOW)
  assert.equal(pruned.old, undefined, '过期记录应被裁掉')
  assert.equal(pruned.fresh, NOW - 1000)
  assert.equal(pruned.future, NOW + 60_000, '未来时间戳（改过系统时钟）必须保留，否则会立刻重复提醒')
})
