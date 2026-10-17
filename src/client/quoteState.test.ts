/**
 * 遮罩告诉用户"这个数能不能看"。因此断言必须钉死边界条件，而不是只测正常路径：
 *   - 未开盘（整批定稿）时**不得**判为绿色；
 *   - 无价一律"缺失"，不能被"定稿"吞掉（否则卡片会显示灰点却是空的）；
 *   - 遮罩必须覆盖每一个金额出口（漏一个出口=隐身不彻底）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { QuoteRow } from '../shared/model.ts'
import {
  type QuoteState as QState,
  PENDING_LABEL,
  PENDING_TITLE,
  QUOTE_STATE_LABEL,
  quoteStateOf,
  quoteStateTitle,
  stripSummaryTitle,
  summarizeQuoteStates,
  summarizeStrip,
} from './quoteState.ts'
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

test('五态：有价且在刷新间隔内 → 实时；无价 → 缺失；**没这一行 → 未取到**', () => {
  assert.equal(quoteStateOf({ ...base, row: row() }), 'live')
  assert.equal(quoteStateOf({ ...base, row: row({ price: null }) }), 'missing')
  // row === undefined = 本轮没请求它 / 首拍还没回来 ⇒ 「未取到」，**不是**「三源都没有」
  assert.equal(quoteStateOf({ ...base, row: undefined }), 'pending')
  // "三源都没有"的集合优先于行内价格：行里有价但被标缺失是不可能的组合，
  // 但判定必须先看它 —— 否则界面上会出现"红点却显示价格"的自相矛盾
  assert.equal(quoteStateOf({ ...base, row: row(), isMissing: true }), 'missing')
  // 服务端说"三源都没有"时，即使这一行缺失（未请求）也不能说成"未取到"：结论优先
  assert.equal(quoteStateOf({ ...base, row: undefined, isMissing: true }), 'missing')
  // 五个状态各有**唯一**名字（同一状态不许两种叫法）
  assert.equal(QUOTE_STATE_LABEL.pending, PENDING_LABEL, 'pending 复用 PENDING_LABEL，不新增文案概念')
  assert.equal(new Set(Object.values(QUOTE_STATE_LABEL)).size, 5, '五个状态必须是五个不同的词')
})

test('「未取到」的 title 不冒充三源结论（P0-2/P1-5）', () => {
  const t = quoteStateTitle('pending', undefined, 10)
  assert.ok(t.includes(PENDING_TITLE), '未取到必须用既有 PENDING_TITLE，而不是"三源都没有"')
  assert.equal(/三源都没有给出可用价格/.test(t), false, '⚠ "未取到"时不许断言三源都没有')
  assert.ok(quoteStateTitle('missing', undefined, 10).includes('三源都没有给出可用价格'), '真·缺失才给三源结论')
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

test('汇总五态：数字必须加得上（== 总数）', () => {
  const states = ['live', 'live', 'delayed', 'settled', 'pending', 'missing', 'missing'] as const
  const s = summarizeQuoteStates([...states])
  assert.equal(s.total, 7)
  assert.equal(s.live, 2)
  assert.equal(s.delayed, 1)
  assert.equal(s.settled, 1)
  assert.equal(s.pending, 1)
  assert.equal(s.missing, 2)
  assert.equal(s.live + s.delayed + s.settled + s.pending + s.missing, s.total)
})

/**
 * P0-2：行情条汇总的分母必须是**屏幕上的卡片数**。
 *
 * 旧实现在 `TW_ROWS` 全量上求值：用户隐藏 1 张后，那张卡既不请求（`engineIds`）也就永远没有回包
 * ⇒ 徽标常驻「27/28 实时 · 1 缺失」，把"你让我别取"说成"三源都没有"，还和相邻的
 * 「无行情源 N」互相打脸。断言的注入形态就是"改用全量行计算"。
 */
test('汇总分母 = 屏幕卡片数（隐藏卡不计入、永不出现在"缺失/未取到"里）', () => {
  const screenIds = Array.from({ length: 27 }, (_, i) => `1.${600000 + i}`)
  const hiddenSecid = '1.000012'
  const allIds = [...screenIds, hiddenSecid]
  const quotesLike: Record<string, QuoteRow> = {}
  for (const id of screenIds) quotesLike[id] = row({ secid: id })
  // 隐藏的那张卡**不在**回包里（engineIds 不请求它）⇒ 若按全量算，它会变成 pending
  const stateOfIn = (ids: readonly string[]) => (secid: string): QState =>
    quoteStateOf({ ...base, row: ids.includes(secid) ? quotesLike[secid] : undefined })
  const rowsOf = (ids: readonly string[]) => [{ items: ids.map((secid) => ({ secid })) }]

  const fixed = summarizeStrip({
    screen: rowsOf(screenIds),
    hiddenCount: 1,
    missing: new Set<string>(),
    stateOf: stateOfIn(screenIds),
  })
  assert.equal(fixed.screen, 27, '分母必须是屏幕上的 27 张')
  assert.equal(fixed.summary.total, 27)
  assert.equal(fixed.summary.live, 27)
  assert.equal(fixed.summary.pending, 0)
  assert.equal(fixed.summary.missing, 0)
  assert.equal(fixed.noSourceOnScreen, 0)
  assert.equal(fixed.hidden, 1)
  assert.equal(/缺失|无行情源|未取到/.test(fixed.badgeText), false, `徽标不许出现缺失/未取到计数（实际 ${fixed.badgeText}）`)
  const title = stripSummaryTitle({ summary: fixed.summary, screen: fixed.screen, hidden: fixed.hidden, asOfText: '14:32:05', sourcesText: 'em 27' })
  assert.ok(title.includes('屏幕 27 张卡片'), 'title 必须说清屏幕张数')
  assert.ok(title.includes('另有 1 张已隐藏'), 'title 必须说清隐藏张数（不请求、不计入）')

  // ⚠ 反例注入：用**全量行**（含隐藏卡）计算 ⇒ 分母变 28、且多出一个"未取到"，判据必须失败
  const injected = summarizeStrip({
    screen: rowsOf(allIds),
    hiddenCount: 1,
    missing: new Set<string>(),
    stateOf: stateOfIn(screenIds),
  })
  assert.equal(injected.summary.total, 28, '⚠ 反例必须真的把隐藏卡算进来')
  assert.equal(injected.summary.pending, 1)
  assert.throws(
    () => assert.equal(injected.screen, 27, '反例上"分母 = 屏幕张数"必须失败'),
    /反例上/,
    '⚠ 反例注入（用全量行计算）必须让断言失败',
  )
})

test('相邻的「无行情源 N」也只数屏幕上的卡（隐藏卡不请求 ⇒ 不可能是"无行情源"）', () => {
  const screenIds = ['1.000001', '0.399001']
  const stateOf = (secid: string): 'live' | 'missing' => (secid === '0.399001' ? 'missing' : 'live')
  const summary = summarizeStrip({
    screen: [{ items: screenIds.map((secid) => ({ secid })) }],
    hiddenCount: 2,
    // 服务端集合里混进了已隐藏的 secid（未来若宿主改口径就会出现）⇒ 也不许计入
    missing: new Set(['0.399001', '1.000012', '171.US10Y']),
    stateOf,
  })
  assert.equal(summary.noSourceOnScreen, 1, '只有屏幕上那张真的无源')
  assert.equal(summary.summary.missing, 1)
  assert.equal(summary.hidden, 2)
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
    // 旧写法是自己等于自己（恒真）。改成固定字面量：价格/点位照常显示，且**不是**遮罩占位
    assert.equal(fmtPrice(1500.25), '1500.25')
    assert.equal(fmtPrice(9.5), '9.500', '小于 10 的价格保留三位小数（口径未变）')
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
