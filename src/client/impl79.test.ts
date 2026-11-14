/**
 * IMPL-79（用户 2026-10-19 要求）：护盘面板三段常驻披露收进「一行入口 + 悬停/读屏」。
 *
 * 这条改动的红线是**事实不能消失**（口径 / Wilson 区间含义 / 不是胜率概率预测 /
 * 形态不参与校准 / 位置低 ≠ 见底），所以判据分两侧：
 *   ① 常驻区**不得**再出现三段的特征串（版面真的收干净了）；
 *   ② 悬停/读屏**必须**逐条读到同一批事实（一个字都没丢），且 `build.mjs` 的两条锁定字面量仍在源码里。
 * 每条都配反例注入：把披露删掉 / 把事实删掉 ⇒ 判据必须非空。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { RESCUE_CALIBER_DISCLOSURE, RESCUE_CALIBER_ENTRY, caliberEntryOf, caliberHoverTextOf } from './rescueView.ts'

/** 宿主 `model` 的真实形状（`host/rescue.ts` 的 bottom.view.model）——第一段就是它 */
const MODEL =
  '近 60 日收盘分位 ≤ 25% 且 当日量能 ≥ 前 20 日均量 × 1（逐通道判定，跨通道合并统计）；' +
  '口径为前向 5 日内最高价达到当日收盘 × (1+目标) 的历史频率，同类样本 120（基线 480，覆盖 6 个通道）；' +
  '前向收盘收益中位数 0.34%，期间最大回撤中位数 -2.45%'

/** 三段里**必须仍然读得到**的事实（逐条查关键词，缺一条就算丢事实） */
const FACTS = [
  '近 60 日收盘分位 ≤ 25%',
  '当日量能 ≥ 前 20 日均量 × 1',
  '逐通道判定，跨通道合并统计',
  '前向 5 日内最高价达到当日收盘 × (1+目标) 的历史频率',
  '同类样本 120（基线 480，覆盖 6 个通道）',
  '前向收盘收益中位数 0.34%',
  '期间最大回撤中位数 -2.45%',
  '历史同类情形的出现频率',
  '不是胜率、概率或预测',
  '95% 区间是 Wilson 区间',
  '样本越小区间越宽',
  '区间跨过基线时，这个差异不具备可辨识性',
  '日内形态（回升/下影线/收回前低）没有可回算的历史分钟数据',
  '不参与概率校准',
  '位置低 ≠ 见底',
  '护盘也可能发生在下跌半程，请结合资金流与量价背离一起判断',
]

/**
 * 常驻区**不许**出现的特征串（出现即说明"还在占版面"）。
 *
 * ⚠ 注意 `期间最大回撤中位数` **不在**这个清单里：它是「历史频率」那一行的**数据标签**
 * （`期间最大回撤中位数 -2.45%`），本来就是紧凑的数字行、不属于被搬走的三段文字；
 * 第一段（宿主 `model` 口径句）是否还在用唯一的 `口径为前向 …（1+目标）` 来判。
 */
const SIGNATURES = ['Wilson 区间', '不参与概率校准', '位置低 ≠ 见底', '历史同类情形的出现频率', '口径为前向', '(1+目标)']

/** 缺事实检查（返回问题列表；空数组 = 全部读到） */
function lostFacts(text: string): string[] {
  return FACTS.filter((f) => !text.includes(f))
}

test('① 常驻区只剩一行入口，三段特征串一个都不许留', () => {
  const entry = caliberEntryOf(MODEL)
  assert.equal(entry.label, RESCUE_CALIBER_ENTRY, '常驻文本必须是那行入口常量')
  assert.ok(entry.label.length <= 16, `入口文案要短（实际 ${entry.label.length} 字）`)
  for (const sig of SIGNATURES) {
    assert.equal(entry.label.includes(sig), false, `常驻文案里还有「${sig}」⇒ 没搬干净`)
  }
  // 反例注入：把披露直接塞回常驻文本（= 用户在抱怨的状态）⇒ 判据必须失败
  const injectedLabel = `${entry.label}\n${RESCUE_CALIBER_DISCLOSURE}`
  assert.throws(
    () => assert.equal(SIGNATURES.some((s) => injectedLabel.includes(s)), false, '反例上"常驻区不许出现特征串"必须失败'),
    /反例上/,
    '⚠ 反例注入（披露又常驻）必须让断言失败',
  )
})

test('② 悬停/读屏必须逐条读到同一批事实（含「不是胜率、概率或预测」）', () => {
  const entry = caliberEntryOf(MODEL)
  assert.equal(entry.title, entry.ariaLabel, '鼠标与读屏读到的必须是同一份文字（不许两套）')
  assert.deepEqual(lostFacts(entry.title), [], `悬停里丢了事实：${lostFacts(entry.title).join(' ／ ')}`)
  assert.ok(entry.title.includes(MODEL), '宿主口径句必须原样搬进去（不缩写、不改写）')
  assert.ok(entry.title.includes('不是胜率、概率或预测'), '「不是胜率、概率或预测」必须在（悬停文案不带 Markdown `**`，仓库有扫描断言）')
  // 反例注入 A：悬停里只剩宿主口径句（把两段红线删掉）⇒ 必须被抓到
  const onlyModel = { label: RESCUE_CALIBER_ENTRY, title: MODEL, ariaLabel: MODEL }
  assert.notDeepEqual(lostFacts(onlyModel.title), [], '⚠ 反例（删掉两段红线）必须被抓到')
  assert.throws(
    () => assert.deepEqual(lostFacts(onlyModel.title), [], '反例上"事实一条不少"必须失败'),
    /反例上/,
    '⚠ 反例注入（删披露）必须让断言失败',
  )
  // 反例注入 B：只删「Wilson 区间」那半句 ⇒ 也必须被抓到
  const noWilson = RESCUE_CALIBER_DISCLOSURE.replace(/给出的 95% 区间是 Wilson 区间[^。]*。/, '')
  assert.notEqual(noWilson, RESCUE_CALIBER_DISCLOSURE)
  assert.equal(noWilson.includes('Wilson 区间'), false)
  assert.notDeepEqual(lostFacts(noWilson), [], '⚠ 反例（删 Wilson 说明）必须被抓到')
})

test('③ 没有宿主口径句时不补编：只给客户端两段，且不凭空出现"期间最大回撤"', () => {
  for (const empty of ['', '   ', null, undefined]) {
    const text = caliberHoverTextOf(empty)
    assert.equal(text, RESCUE_CALIBER_DISCLOSURE, `model=${String(empty)} 时只给两段静态披露`)
    assert.equal(text.includes('期间最大回撤中位数'), false, '没有模型句就不许出现"期间最大回撤中位数"')
    assert.ok(text.includes('Wilson 区间'), '静态两段仍在')
  }
})

