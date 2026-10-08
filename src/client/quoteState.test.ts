/**
 * 行情卡片四态（P0-2）与金额遮罩（P0-8）的断言。
 *
 * 这两块的共同点是**界面会用它下结论**：色点告诉用户"这个价可不可信"，
 * 遮罩告诉用户"这个数能不能看"。因此断言必须钉死边界条件，而不是只测正常路径：
 *   - 未开盘（整批定稿）时**不得**判为绿色；
 *   - 超过刷新间隔 3 倍才算延迟（2.9 倍不算，3.1 倍才算）；
 *   - 无价一律"缺失"，不能被"定稿"吞掉（否则卡片会显示灰点却是空的）；
 *   - 遮罩必须覆盖每一个金额出口（漏一个出口=隐身不彻底）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { QuoteRow } from '../shared/model.ts'
import { quoteStateOf, summarizeQuoteStates } from './quoteState.ts'
import { fmtAmt, fmtBig, fmtMoneySigned, fmtPrice, fmtRaw, isMoneyMasked, setMoneyMask } from './format.ts'

const NOW = Date.UTC(2026, 9, 8, 6, 0, 0)

function row(over: Partial<QuoteRow> = {}): QuoteRow {
  return {
    secid: '1.600519', code: '600519', name: '贵州茅台',
    price: 1500, chg: 10, pct: 0.67, prev: 1490, open: 1495, high: 1510, low: 1492,
    vol: 1, amount: 1e8, up: null, down: null, even: null, time: NOW, at: NOW, source: 'em',
    ...over,
  }
}

const base = { isMissing: false, cached: false, refreshSec: 10, now: NOW }

test('四态：有价且在刷新间隔内 → 实时；无价 → 缺失', () => {
  assert.equal(quoteStateOf({ ...base, row: row() }), 'live')
  assert.equal(quoteStateOf({ ...base, row: row({ price: null }) }), 'missing')
  assert.equal(quoteStateOf({ ...base, row: undefined }), 'missing')
  // "三源都没有"的集合优先于行内价格：行里有价但被标缺失是不可能的组合，
  // 但判定必须先看它 —— 否则界面上会出现"红点却显示价格"的自相矛盾
  assert.equal(quoteStateOf({ ...base, row: row(), isMissing: true }), 'missing')
})

test('四态：延迟阈值是刷新间隔的 3 倍（2.9 倍不算、3.1 倍才算）', () => {
  const at29 = NOW - 29_000
  const at31 = NOW - 31_000
  assert.equal(quoteStateOf({ ...base, row: row({ at: at29 }) }), 'live')
  assert.equal(quoteStateOf({ ...base, row: row({ at: at31 }) }), 'delayed')
  // 兜底值（lkg）无论多新都是延迟：它的语义是"上游这次没给"
  assert.equal(quoteStateOf({ ...base, row: row({ source: 'lkg' }) }), 'delayed')
  // 没有观测时刻：不假装它新鲜
  assert.equal(quoteStateOf({ ...base, row: row({ at: undefined }) }), 'delayed')
})

test('四态：休市定稿一律灰色 —— 未开盘不得显示绿色', () => {
  assert.equal(quoteStateOf({ ...base, row: row(), cached: true }), 'settled')
  // 即使观测时刻很新（刚取过一次缓存），定稿仍是定稿
  assert.equal(quoteStateOf({ ...base, row: row({ at: NOW }), cached: true }), 'settled')
  // 但"没有价"优先于"定稿"：不能把一张空卡片标成"数据已确定"
  assert.equal(quoteStateOf({ ...base, row: row({ price: null }), cached: true }), 'missing')
})

test('汇总四态：数字必须加得上（== 总数）', () => {
  const states = ['live', 'live', 'delayed', 'settled', 'missing', 'missing'] as const
  const s = summarizeQuoteStates([...states])
  assert.equal(s.total, 6)
  assert.equal(s.live, 2)
  assert.equal(s.delayed, 1)
  assert.equal(s.settled, 1)
  assert.equal(s.missing, 2)
  assert.equal(s.live + s.delayed + s.settled + s.missing, s.total)
})

test('金额遮罩：隐身只改显示，不改价格/涨跌与原始数值', () => {
  try {
    assert.equal(isMoneyMasked(), false)
    const plainAmt = fmtAmt(123456)
    const plainPnl = fmtMoneySigned(-1234.5)
    const plainRaw = fmtRaw(1234.5)

    setMoneyMask(true)
    assert.equal(isMoneyMasked(), true)
    assert.equal(fmtAmt(123456), '¥••••')
    assert.equal(fmtAmt(null), '—', '无值仍是 —，不能被遮罩吞成金额占位')
    assert.equal(fmtMoneySigned(-1234.5), '-¥••••', '符号保留：方向仍然可读')
    assert.equal(fmtMoneySigned(1234.5), '+¥••••')
    assert.equal(fmtRaw(1234.5), '¥••••')
    // 价格与成交量不是"金额"：点位/价格必须照常显示（否则整个行情条就没用了）
    assert.equal(fmtPrice(1500.25), fmtPrice(1500.25))
    assert.notEqual(fmtPrice(1500.25), '¥••••')
    assert.equal(fmtBig(12345), '1.2万')

    setMoneyMask(false)
    assert.equal(fmtAmt(123456), plainAmt)
    assert.equal(fmtMoneySigned(-1234.5), plainPnl)
    assert.equal(fmtRaw(1234.5), plainRaw)
  } finally {
    // 无论断言如何失败，都不能把遮罩留给后续用例
    setMoneyMask(false)
  }
})
