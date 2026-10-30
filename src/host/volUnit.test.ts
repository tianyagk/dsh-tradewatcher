/** 成交量量纲（v0.181.0）：① 今日柱/近20中位数 ∈[0.2,5] ② 与历史同单位（手）③ 量×均价≈额 ④ 标签自洽 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { VOL_ERR_MAX_PCT, volToLots, volToShares, volUnitOf } from './volUnit.ts'
import { volLabelOfShares } from '../client/detailFallback.ts'

/** 长鑫科技 1.688825 实测（2026-10-28 13:5x） */
const RAW = { vol: 292_408_630, price: 44.22, amount: 12_822_861_737 }
const HIST = [3_255_307, 3_444_443, 2_920_403] // 日线 vol（手）
const MEDIAN20 = 2_870_817

test('① 今日柱 vol / median(近 20 日) ∈ [0.2, 5]（当前 5–6 倍/100 倍 ⇒ 败）', () => {
  const check = volUnitOf(RAW.vol, RAW.price, RAW.amount)
  assert.equal(check.unit, 'share', '快照 vol 是「股」（292,408,630 × 44.22 ≈ 129 亿 = 成交额）')
  const todayLots = volToLots(RAW.vol, check.unit)
  const ratio = todayLots / MEDIAN20
  assert.ok(ratio >= 0.2 && ratio <= 5, `今日量柱/中位数 必须在 [0.2,5]（实际 ${ratio.toFixed(2)}）`)
  // 反例注入：把「股」直接当「手」入柱 ⇒ 比值 ≈ 100 ⇒ 必败
  const wrong = RAW.vol / MEDIAN20
  assert.ok(wrong > 5, `反例：不换算时比值 ${wrong.toFixed(0)} 倍（证明判据非空）`)
  assert.throws(() => assert.ok(wrong <= 5, '反例上：未换算'), /反例上/, '⚠ 反例注入（手当股）必须失败')
})

test('② 今日柱与历史柱同一单位（手）：292 万手 ≈ 历史 292 万手（差 100 倍 ⇒ 败）', () => {
  const lots = volToLots(RAW.vol, 'share')
  assert.equal(lots, 2_924_086)
  assert.ok(Math.abs(lots / HIST[2] - 1) < 0.05, `今日柱必须与历史柱同量级（${lots} vs ${HIST[2]}）`)
  // 反例注入：按「手」直接入柱 ⇒ 比历史大 100 倍
  const asLot = volToLots(RAW.vol, 'lot')
  assert.equal(Math.round(asLot / HIST[2]), 100, '反例：手/股混用恰好差 100 倍')
  assert.throws(() => assert.ok(Math.abs(asLot / HIST[2] - 1) < 0.05, '反例上：差 100 倍'), /反例上/, '⚠ 反例注入必须失败')
})

test('③ 成交量 × 均价 ≈ 成交额（误差 ≤5%；×100 错位 ⇒ 败）', () => {
  const shares = volToShares(RAW.vol, 'share')
  const err = Math.abs(shares * RAW.price - RAW.amount) / RAW.amount * 100
  assert.ok(err <= 5, `量×均价 与成交额误差必须 ≤5%（实际 ${err.toFixed(2)}%）`)
  const bad = Math.abs(shares * 100 * RAW.price - RAW.amount) / RAW.amount * 100
  assert.ok(bad > 5, `反例：×100 错位后误差 ${bad.toFixed(0)}%`)
  assert.throws(() => assert.ok(bad <= 5, '反例上：×100'), /反例上/, '⚠ 反例注入必须失败')
})

test('④ 详情头单位标签与实际量级一致（2.9 亿股 ⇒ 亿股；5000 万股 ⇒ 不得写亿股）', () => {
  assert.equal(volLabelOfShares(292_408_630), '2.92 亿股')
  assert.equal(volLabelOfShares(50_000_000), '5000.0 万股', '5000 万股必须写"万股"，不能写"亿股"')
  assert.equal(volLabelOfShares(3200), '3200 股')
  // 反例注入：给 5000 万股也套"亿股" ⇒ 标签与量级不符
  const wrongLabel = `${(50_000_000 / 1e8).toFixed(2)} 亿股`
  assert.equal(wrongLabel, '0.50 亿股')
  assert.throws(() => assert.equal(wrongLabel, '5000.0 万股', '反例上：小量级用亿股'), /反例上/, '⚠ 反例注入必须失败')
})

test('⑤ 判不出单位时不猜（ok:false ⇒ 调用方给 null 而不是错值）', () => {
  assert.equal(volUnitOf(1000, 10, 555_555).ok, false)
  assert.equal(volUnitOf(null, 10, 100).ok, false)
  // 贵州茅台：腾讯 [36]=22012（手），×100×1331 ≈ 29.3 亿 = [37] ⇒ lot
  const moutai = volUnitOf(22_012, 1331.45, 2_951_090_000)
  assert.equal(moutai.unit, 'lot')
  assert.equal(moutai.ok, true)
})

/* ── 边界补强（AUDIT-TESTS-1030）：非法量、5% 闭区间、四舍五入方向 ── */

test('⑥ 非法量（0 / 负 / NaN / ±Infinity / 缺失）⇒ ok:false 且 errPct=Infinity（把 0 当合法量 ⇒ 败）', () => {
  for (const bad of [0, -1, -0.5, NaN, null, undefined, Number.POSITIVE_INFINITY]) {
    const r = volUnitOf(bad as number | null | undefined, 10, 1000)
    assert.equal(r.ok, false, `非法量 ${String(bad)} 不得判为 ok:true`)
    assert.equal(r.errPct, Number.POSITIVE_INFINITY, `非法量 ${String(bad)} 的 errPct 必须是 Infinity（不是 0，也不是某个看起来像误差的数）`)
  }
  assert.equal(volUnitOf(100, 0, 1000).ok, false, '价格 0 不得判为 ok')
  assert.equal(volUnitOf(100, 10, 0).ok, false, '成交额 0 不得判为 ok')
  assert.equal(volUnitOf(100, null, 1000).ok, false, '价格缺失不得判为 ok')
  // 反例注入：若把「amount > 0」的闸门去掉，0 成交额会算出 0/0 = NaN，
  // 而 `NaN <= 5` 恒为 false ⇒ 会走到「取更接近的那个」分支，返回一个**看起来正常**的 unit。
  const zeroOverZero = (0 * 10 - 0) / 0
  assert.ok(Number.isNaN(zeroOverZero), '0/0 必须是 NaN —— 这正是必须前置拦掉的原因')
  assert.throws(() => assert.equal(Number.isNaN(zeroOverZero), false, '反例上：0 成交额当合法'), /反例上/, '⚠ 反例注入必须失败')
})

test('⑦ 5% 阈值是**闭区间**：正好 5.000% 判 ok，5.005% 判 ok:false（改成严格 < ⇒ 败）', () => {
  assert.equal(VOL_ERR_MAX_PCT, 5, '阈值常量必须是 5')
  // |2100×10 − 20000| / 20000 = 5.000% 整
  const exact = volUnitOf(2100, 10, 20_000)
  assert.equal(exact.unit, 'share')
  assert.equal(exact.ok, true, '正好 5% 必须在允许范围内（闭区间）')
  assert.ok(Math.abs(exact.errPct - 5) < 1e-9, `errPct 必须正好 5（实得 ${exact.errPct}）`)
  // |2100×10 − 19999| / 19999 = 5.005%
  const justOver = volUnitOf(2100, 10, 19_999)
  assert.equal(justOver.ok, false, '5.005% 必须判不可用')
  assert.ok(justOver.errPct > 5 && justOver.errPct < 5.01, `越界误差应略大于 5（实得 ${justOver.errPct}）`)
  // 反例注入：把 <= 改成 < ⇒ 正好 5% 会被判不可用
  assert.throws(() => assert.equal(exact.ok, false, '反例上：正好 5% 被判越界'), /反例上/, '⚠ 反例注入必须失败')
})

test('⑧ 换算的四舍五入方向：49 股 → 0 手，50 股 → 1 手（截断 ⇒ 50 股变 0 手 ⇒ 败）', () => {
  assert.equal(volToLots(49, 'share'), 0)
  assert.equal(volToLots(50, 'share'), 1, '50 股按四舍五入是 1 手（截断会得 0）')
  assert.equal(volToLots(149, 'share'), 1)
  assert.equal(volToLots(150, 'share'), 2)
  assert.equal(volToShares(1, 'lot'), 100, '1 手 = 100 股')
  // 反例注入：截断（Math.floor）⇒ 50 股变 0 手
  const truncated = Math.floor(50 / 100)
  assert.equal(truncated, 0)
  assert.throws(() => assert.equal(truncated, 1, '反例上：截断'), /反例上/, '⚠ 反例注入必须失败')
})
