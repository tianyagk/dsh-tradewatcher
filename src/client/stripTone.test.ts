/**
 * badge 视图 + 配置窗生效集合的断言（纯函数）。
 *
 * 两条红线：① 缺失 ⇒ **没有 badge**（不是「适中」）；② 老 profile 缺 `stripCfg` 键 ⇒ 全部可见
 * （存隐藏集合的目的：将来新增的卡片默认可见）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  SELECT_ALL_HIDDEN, effectiveHidden, invertHidden, selectedCount, toneBadgeView, toggleCardHidden, toggleGroupHidden, visibleCards,
  type StripRowLike, type ToneRow,
} from './stripTone.ts'

const ROWS: StripRowLike[] = [
  { key: 'cn', label: 'A股指数', items: [{ secid: '1.000001', name: '上证指数' }, { secid: '0.399001', name: '深证成指' }] },
  { key: 'bond', label: '国债', items: [{ secid: '1.000012', name: '中国国债' }, { secid: '171.US10Y', name: '美国10Y' }] },
]
const row = (over: Partial<ToneRow>): ToneRow => ({
  secid: '1.000001', level: '适中', pct: 50, r30: 1.2, momentum: 0.3, samples: 120, bars: 250, kind: 'price', why: null, ...over,
})

test('badge 视图：五档各给一个词，data-tone 与可见文字一致', () => {
  for (const level of ['过冷', '偏冷', '适中', '偏热', '过热'] as const) {
    const v = toneBadgeView(row({ level }))
    assert.equal(v.text, level, '可见文字就是档位词（不放数字）')
    assert.equal(v.dataTone, level)
    assert.ok(v.detail.includes('近 30 日涨跌幅分位'), '口径长句进 title')
    assert.ok(v.detail.includes('有效样本'), '口径里要给有效样本数')
  }
})

test('红线：缺失/样本不足 ⇒ 没有 badge、也不写「适中」', () => {
  const bad = toneBadgeView(row({ level: null, pct: null, samples: 0, bars: 20, insufficient: true, why: '样本不足（现有 20 根日线，R30 需 ≥31 根）' }))
  assert.equal(bad.text, null, '不显示 badge')
  assert.equal(bad.dataTone, 'insufficient')
  assert.ok(bad.detail.includes('样本不足'), '原因要能读出来')
  assert.notEqual(bad.detail.includes('适中'), true, '绝不用「适中」冒充缺失')
  const noData = toneBadgeView(row({ level: null, samples: 0, bars: 0, insufficient: false, why: '日线本次未取到' }))
  assert.equal(noData.text, null)
  assert.equal(noData.dataTone, 'none')
  assert.equal(toneBadgeView(undefined).dataTone, 'none', '连数据都没有 ⇒ none（不渲染）')
})

test('收益率类的 title 必须写明"已取负＝价格方向"（否则读者按价格直觉理解）', () => {
  const y = toneBadgeView(row({ level: '偏热', kind: 'yield' }))
  assert.ok(y.detail.includes('收益率'), '类型写进口径')
  assert.ok(y.detail.includes('已取负'), '方向换算要写明')
  const p = toneBadgeView(row({ level: '偏热', kind: 'price' }))
  assert.ok(p.detail.includes('价格'), '价格型也标类型')
})

test('配置向后兼容：缺 stripCfg 键 / 非数组 ⇒ 全部可见（老 profile）', () => {
  const cards = visibleCards(ROWS, undefined)
  assert.equal(cards.length, 2, '两组都渲染')
  assert.deepEqual(cards.map((c) => c.items.length), [2, 2], '每组两张都在')
  assert.deepEqual(visibleCards(ROWS, 'nonsense').flatMap((c) => c.items).length, 4, '非数组 ⇒ 回退全可见')
  assert.deepEqual(effectiveHidden(['1.000001', '1.000001'], ['1.000001']), ['1.000001'], '去重且过滤未知')
  assert.deepEqual(effectiveHidden(['9.999999'], ['1.000001']), [], '未知 secid 被过滤（装载宽容）')
})

test('生效集合：隐藏整组 ⇒ 组头不渲染；隐藏单张 ⇒ 只少那一张', () => {
  const hideCn = visibleCards(ROWS, ['1.000001', '0.399001'])
  assert.deepEqual(hideCn.map((c) => c.row.key), ['bond'], '整组全隐藏 ⇒ 不渲染空组头')
  const one = visibleCards(ROWS, ['0.399001'])
  assert.deepEqual(one[0].items.map((i) => i.secid), ['1.000001'])
  assert.equal(selectedCount(ROWS, ['0.399001']).on, 3)
  assert.equal(selectedCount(ROWS, undefined).total, 4)
})

test('组/卡开关与反选：只动对应部分，顺序保持 TW_ROWS 固定顺序', () => {
  assert.deepEqual(toggleGroupHidden(ROWS, [], 'cn', false), ['1.000001', '0.399001'], '整组取消 ⇒ 两张进隐藏集')
  assert.deepEqual(toggleGroupHidden(ROWS, ['1.000001', '0.399001'], 'cn', true), [], '整组勾上 ⇒ 清掉隐藏')
  assert.deepEqual(toggleCardHidden(ROWS, [], '171.US10Y', false), ['171.US10Y'])
  assert.deepEqual(toggleCardHidden(ROWS, ['171.US10Y'], '171.US10Y', true), [])
  assert.deepEqual(invertHidden(ROWS, []), ['1.000001', '0.399001', '1.000012', '171.US10Y'], '反选＝隐藏当前可见')
  assert.deepEqual(invertHidden(ROWS, ['1.000001']), ['0.399001', '1.000012', '171.US10Y'], '再反选回来')
  assert.deepEqual(SELECT_ALL_HIDDEN, [], '全选/恢复默认＝空隐藏集')
})
