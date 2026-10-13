/**
 * 「已隐藏的标的仍在每一拍被请求」的回归断言（AUDIT-CACHE-2 §3.11 / 命题 C11）。
 *
 * 断言的是**请求集合**（`quoteEngineIds` 的返回值就是交给 `useQuoteEngine` 去轮询的那份），
 * 不是渲染；渲染侧仍由 `visibleCards` 决定，两者必须一致（E3）。
 * 反例注入放在 E2：把修前的实现（TW_ROWS 全量）拿来跑同一条断言，必须**失败**。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { TW_ROWS } from '../shared/model.ts'
import { visibleCards } from './stripTone.ts'
import { MARKET_PAGE_SECIDS, pageExtraIds, quoteEngineIds } from './engineIds.ts'

/** 全部卡片 secid（＝修复前的 `baseIds`） */
function allCardIds(): string[] {
  return TW_ROWS.flatMap((r) => (r.items as ReadonlyArray<{ secid: string }>).map((i) => i.secid))
}

/**
 * 用户 `prefs.json` 里**实测**的隐藏集合（AUDIT-CACHE-2 §3.11 原文摘录）。
 * 注意口径：调用点传的是 `prefs.stripCfg?.hidden` **数组本身**（与 TopBar/配置窗同一处），
 * 不是 `{ hidden }` 对象 —— 传错层级会让 `effectiveHidden` 按"非数组 ⇒ 空"宽容处理，
 * 于是"全可见"看起来像是通过（E4 专门钉住这个宽容规则）。
 */
const USER_HIDDEN: string[] = ['1.000012', '171.US10Y', '171.JP10Y', '171.DE10Y', '171.GB10Y']

test('E1 隐藏的卡片不再进入请求集合（用户实测的 5 个债券标的）', () => {
  const ids = quoteEngineIds(TW_ROWS, USER_HIDDEN)
  for (const secid of USER_HIDDEN) {
    assert.ok(!ids.includes(secid), `${secid} 仍在请求集合里 ⇒ 每一拍都白打一次上游，而结果永远不会被渲染`)
  }
  assert.equal(ids.length, allCardIds().length - USER_HIDDEN.length, '恰好少掉隐藏的那几张')
})

test('E2 反例注入：修前的实现（TW_ROWS 全量）必须命中 1.000012 —— 证明 E1 不是空断言', () => {
  const before = allCardIds() // ← 修复前 index.tsx 的 baseIds 就是它
  assert.ok(before.includes('1.000012'), '修前必须命中（否则 E1 断言的是"本来就不在的东西"）')
  assert.ok(!quoteEngineIds(TW_ROWS, USER_HIDDEN).includes('1.000012'), '修后必须不命中')
  // 再钉一个"隐藏集合不许被请求集合反推成空集"的下界：其余 23 张仍在
  assert.equal(quoteEngineIds(TW_ROWS, USER_HIDDEN).length, 23)
})

test('E3 请求集合 == 渲染集合（隐藏语义只有一处来源，不另立一套）', () => {
  const cases: unknown[] = [undefined, null, [], 'nonsense', USER_HIDDEN, ['unknown.secid'], ['1.000001']]
  for (const hidden of cases) {
    const rendered = visibleCards(TW_ROWS, hidden).flatMap((view) => view.items.map((i) => i.secid))
    assert.deepEqual(
      quoteEngineIds(TW_ROWS, hidden),
      rendered,
      `hidden=${JSON.stringify(hidden)} 时请求集合与渲染集合必须一致（不一致就会出现"取的不用、用的不取"）`,
    )
  }
})

test('E4 老 profile（缺 stripCfg / hidden 非数组）⇒ 全量请求，不许被收窄', () => {
  assert.deepEqual(quoteEngineIds(TW_ROWS, undefined), allCardIds(), '缺键 = 全可见（存隐藏集合的约定）')
  assert.deepEqual(quoteEngineIds(TW_ROWS, 'nonsense'), allCardIds(), '非数组 = 全可见（effectiveHidden 的宽容规则）')
})

test('E5 页面需要的标的**不因隐藏**被剔除（那一行仍要显示，取不到就是凭空空值）', () => {
  const hidden = ['1.000012']
  assert.deepEqual(pageExtraIds({ page: 'watch', watchIds: ['1.000012'], posIds: ['9.9'] }), ['1.000012'])
  assert.deepEqual(pageExtraIds({ page: 'portfolio', watchIds: ['1.000012'], posIds: ['9.9'] }), ['9.9'])
  assert.deepEqual(pageExtraIds({ page: 'calendar', watchIds: ['1.000012'], posIds: ['9.9'] }), [])
  const ids = quoteEngineIds(TW_ROWS, hidden, pageExtraIds({ page: 'watch', watchIds: ['1.000012'], posIds: [] }))
  assert.ok(ids.includes('1.000012'), '自选页里真的有这一行 ⇒ 必须继续取数（隐藏只作用于行情条卡片）')
})

test('E6 大盘页直接读的 2 个指数（上证/深证）：在 TW_ROWS 里存在，且被隐藏也断不了供', () => {
  // v0.81.1：【指数行情】模块（原 6 个 A 股指数行）已删 ⇒ 大盘页只剩这两格的分量要用它们
  const needed: Array<[string, string]> = [['上证指数', '1.000001'], ['深证成指', '0.399001']]
  const cards = TW_ROWS.flatMap((r) => (r.items as ReadonlyArray<{ secid: string; name: string }>))
  for (const [name, secid] of needed) {
    const hit = cards.find((i) => i.name === name)
    assert.ok(hit !== undefined, `TW_ROWS 里找不到「${name}」：MarketPage 改了要读的标的？回来核对 MARKET_PAGE_SECIDS`)
    assert.equal(hit.secid, secid, `「${name}」的 secid 与 MARKET_PAGE_SECIDS 不一致（漂移必须红）`)
  }
  assert.deepEqual([...MARKET_PAGE_SECIDS], needed.map(([, id]) => id))
  assert.deepEqual(pageExtraIds({ page: 'market', watchIds: [], posIds: [] }), needed.map(([, id]) => id))
  // 大盘页要读的这 2 个即使被用户隐藏，也必须继续取数（那一页真的在读它们）
  const hiddenAll = needed.map(([, id]) => id)
  const ids = quoteEngineIds(TW_ROWS, hiddenAll, pageExtraIds({ page: 'market', watchIds: [], posIds: [] }))
  for (const [, secid] of needed) assert.ok(ids.includes(secid), `${secid}：大盘页要读它 ⇒ 不能因为隐藏就断供`)
  // 已删掉的 6 行里，其余 4 个不再享受"隐藏也取数"的额外保证（它们只是行情条上的卡片）
  for (const gone of ['0.399006', '1.000688', '1.000300', '1.000905']) {
    assert.equal(MARKET_PAGE_SECIDS.includes(gone), false, `${gone} 不该再在 MARKET_PAGE_SECIDS 里（页面已不显示）`)
  }
})
