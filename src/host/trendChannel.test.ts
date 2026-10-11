/**
 * 多日渠道解耦的断言（task-50）。
 *
 * 背景：`fetchMultiDayTrend` 首行曾用 `sinaSymbol(secid)` 把非沪/深全挡死，而腾讯档又复用同一个符号
 * ⇒ 港股/国际/商品/期货在结构上永远进不去。这里钉住"两条渠道各用自己的符号"+ "判据不放宽"。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { tencentCode } from './tencent.ts'
import { isMultiDayTrend } from '../shared/trendStitch.ts'

test('符号解耦：腾讯档用自己的符号（覆盖港股），不再复用新浪那套', () => {
  // 解耦的要点：腾讯档的符号来自 `tencentCode`，它对港股有效（`hk00700`）。
  // 注意 `em.ts` 里那个"东财 secid → 新浪代码"的私有映射只认沪/深（研究结论即指它），
  // 这里不去断言私有实现的细节，只钉住"两条渠道各用自己的符号"这一可观测事实。
  assert.equal(tencentCode('116.00700'), 'hk00700')
  assert.equal(tencentCode('116.02513'), 'hk02513')
  assert.notEqual(tencentCode('1.600519'), null, '沪市')
  assert.notEqual(tencentCode('0.300750'), null, '深市')
  // 国际/商品/期货：腾讯档也没有 ⇒ 只能落到本地归档（这是"我们没覆盖"，不是"上游没有"）
  for (const secid of ['100.SPX', '122.XAU', '101.HG00Y', '114.lhm', '113.rbm']) {
    assert.equal(tencentCode(secid), null)
  }
})

test('判据未被放宽：只有 1 天（哪怕点数几百）不算多日', () => {
  const oneDay = Array.from({ length: 272 }, (_, i) => ({ t: i, label: '2026-10-09 09:31', price: 100, avg: null, vol: null }))
  assert.equal(isMultiDayTrend(oneDay), false, '港股回包就是这种形态（272 点但只有 1 天）⇒ 必须回落归档')
  const twoDay = [...oneDay.slice(0, 100), ...oneDay.slice(0, 100).map((p) => ({ ...p, label: '2026-10-08 09:31' }))]
  assert.equal(isMultiDayTrend(twoDay), true, '两个不同日期才算多日（判据仍是 ≥2）')
})
