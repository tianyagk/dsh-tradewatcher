/**
 * 筹码分布的断言（含**手算对照**：自造 4 根序列，桶分摊/权重/平均成本/P5/P95 逐位算出）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CHIPS_BUCKETS, CHIPS_DECAY_DEFAULT, CHIPS_MIN_SAMPLES, allocate, allocateSpread, bucketCenters, chipSeriesOf, normalizeChipPrefs, percentilePrice } from './chips.ts'

/** 手算用的 4 根序列：10 / 20 / 30 / 40（等量），桶数 4 ⇒ 中心 13.75 / 26.25 / 38.75 / 51.25 */
const HAND = [
  { date: '2026-01-01', close: 10, vol: 100 },
  { date: '2026-01-02', close: 20, vol: 100 },
  { date: '2026-01-03', close: 30, vol: 100 },
  { date: '2026-01-04', close: 40, vol: 100 },
]

test('手算对照：桶中心、单价分摊与守恒', () => {
  const centers = bucketCenters(10, 40, 4)
  assert.deepEqual(centers, [13.75, 21.25, 28.75, 36.25], '区间 [10,40] 四等分的中点（桶宽 7.5）')
  // 价格 20 落在中心 13.75 与 21.25 之间：t = (20−13.75)/7.5 = 0.8333 ⇒ 0.1667 / 0.8333
  const w = [0, 0, 0, 0]
  allocate(w, centers, 20, 1)
  assert.deepEqual(w.map((x) => Math.round(x * 1e4) / 1e4), [0.1667, 0.8333, 0, 0])
  // 守恒：分摊前后总权重相等（这是"别差一分钱换一桶"的核心）
  const before = w.reduce((s, x) => s + x, 0)
  allocate(w, centers, 21, 0.3)
  assert.ok(Math.abs(w.reduce((s, x) => s + x, 0) - before - 0.3) < 1e-12, '分摊不创造也不丢失权重')
  // 低于最低中心/高于最高中心 ⇒ 落两端桶
  const w2 = [0, 0, 0, 0]
  allocate(w2, centers, 5, 1)
  assert.deepEqual(w2, [1, 0, 0, 0])
  allocate(w2, centers, 99, 1)
  assert.deepEqual(w2, [1, 0, 0, 1])
})

test('手算对照：换手率 × k 递推（三角形分布），逐日 chips_t 与程序输出对齐', () => {
  // 自造 3 根：收盘 10 / 20 / 30，当日 high=low=close（区间退化成一点 ⇒ 三角形=单点，便于手算）
  const bars = [
    { date: '2026-01-01', close: 10, vol: 100 },
    { date: '2026-01-02', close: 20, vol: 100 },
    { date: '2026-01-03', close: 30, vol: 100 },
  ]
  // floatMv 取到"换手率 = 0.01"：成交额 = vol×100×close ⇒ 第一天 100×100×10 = 100,000
  //   t_1 = 100000 / 10,000,000 = 0.01；k = 1.5 ⇒ 因子 = 1 − 0.015 = 0.985
  const floatMv = 10_000_000
  const k = 1.5
  const r = chipSeriesOf(bars, { fqSupported: true, floatMv, decay: k, spread: 'triangle', buckets: 4, minSamples: 1 })
  assert.equal(r.decay, 'turnover')
  // 手算：每天都把历史 ×0.985 再加当日换手权重（t 每天不同：10 → 20 → 30 元 ⇒ t = 0.01 / 0.02 / 0.03）
  const centers = bucketCenters(10, 30, 4) // [12.5, 17.5, 22.5, 27.5]
  let hist = [0, 0, 0, 0]
  const ts = [0.01, 0.02, 0.03]
  for (let i = 0; i < bars.length; i += 1) {
    const f = Math.max(0, 1 - ts[i] * k)
    hist = hist.map((x) => x * f)
    // 三角形退化到单点（high=low=close）⇒ 全给最接近该价的桶
    const peak = bars[i].close
    const best = centers.reduce((bi, c, ci) => (Math.abs(c - peak) < Math.abs(centers[bi] - peak) ? ci : bi), 0)
    hist[best] += ts[i]
  }
  const total = hist.reduce((a, b) => a + b, 0)
  const mine = hist.map((x) => Math.round((x / total) * 1e6) / 1e6)
  assert.deepEqual(r.latest?.buckets, mine, `桶权重必须与手算逐位一致（手算 ${JSON.stringify(mine)}）`)
  // 手算平均值：Σ(桶价×权重)
  const avg = centers.reduce((a, c, i) => a + c * (mine[i] ?? 0), 0)
  assert.ok(Math.abs((r.avgCost ?? 0) - avg) < 5e-4, `平均成本应≈手算 ${avg.toFixed(4)}（实际 ${String(r.avgCost)}）`)
  assert.ok(r.methodology.includes(`k=${k}`), '口径必须写明 k')
  assert.ok(r.methodology.includes('三角形分布'), '口径必须写明形状')
  assert.ok(r.methodology.includes('(high+low+close)/3'), '口径必须写明均价定义')
})

test('极端换手：t×k > 1 ⇒ 因子夹到 0（旧筹码全清），methodology 写明生效值', () => {
  // 换手率 0.25（cap）× k=3 ⇒ 1−0.75 = 0.25 ✗ 还不到负；要造负：cap 上限 0.25、k 最大 3 ⇒ 最多 0.75
  //  ⇒ 用 cap 覆盖（cap=1）+ k=3 ⇒ 1−1×3 = −2 ⇒ 必须夹到 0
  const r = chipSeriesOf(
    [{ date: 'a', close: 10, vol: 1 }, { date: 'b', close: 11, vol: 1 }, { date: 'c', close: 12, vol: 1 }],
    { fqSupported: true, floatMv: 1, decay: 3, cap: 1, buckets: 4, minSamples: 1 },
  )
  const all = r.latest?.buckets ?? []
  assert.equal(all.every((x) => x >= 0), true, '不许出现负权重')
  assert.equal(Math.abs(all.reduce((a, b) => a + b, 0) - 1) < 1e-6, true, '归一化后和为 1')
  assert.ok(r.methodology.includes('夹到 0'), `口径要写明夹取（实际 ${r.methodology.slice(0, 120)}…）`)
  assert.ok(r.methodology.includes('最小生效因子'), '要给出实际生效的因子')
})

test('形状守恒与三角峰：两种形状总权重相等；三角峰值落在均价附近', () => {
  const centers = bucketCenters(10, 30, 8)
  const tri = new Array<number>(8).fill(0)
  const uni = new Array<number>(8).fill(0)
  allocateSpread(tri, centers, 10, 30, 0.3, 'triangle', (30 + 10 + 20) / 3)
  allocateSpread(uni, centers, 10, 30, 0.3, 'uniform', (30 + 10 + 20) / 3)
  assert.ok(Math.abs(tri.reduce((a, b) => a + b, 0) - 0.3) < 1e-9, '三角形守恒')
  assert.ok(Math.abs(uni.reduce((a, b) => a + b, 0) - 0.3) < 1e-9, '均匀守恒')
  assert.ok(Math.abs(tri.reduce((a, b) => a + b, 0) - uni.reduce((a, b) => a + b, 0)) < 1e-12, '两种形状总权重相等')
  const peakIdx = tri.indexOf(Math.max(...tri))
  const peakPrice = centers[peakIdx]
  assert.ok(Math.abs(peakPrice - 20) <= 2.5, `三角峰应落在均价 20 附近（实际 ${peakPrice}）`)
  assert.ok(Math.abs(uni[0] - uni[7]) < 1e-9, '均匀分布两端相等')
})

test('默认值与非法值：k=1.5/triangle 为默认；越界与未知形状回落默认并如实记录', () => {
  assert.equal(CHIPS_DECAY_DEFAULT, 1.5)
  assert.deepEqual(normalizeChipPrefs({}), { decay: 1.5, spread: 'triangle', notes: [] }, '缺键 ⇒ 默认（老 profile 向后兼容）')
  const bad = normalizeChipPrefs({ decay: 9, spread: 'blob' })
  assert.equal(bad.decay, 1.5, '超范围 ⇒ 回落默认')
  assert.equal(bad.spread, 'triangle', '未知形状 ⇒ 回落默认')
  assert.equal(bad.notes.length, 2, '两处回落都要如实记录（不静默）')
  const neg = normalizeChipPrefs({ decay: -1 })
  assert.equal(neg.decay, 1.5)
  assert.ok(neg.notes[0].includes('超出'), neg.notes[0])
  const ok = normalizeChipPrefs({ decay: 2.5, spread: 'uniform' })
  assert.deepEqual({ decay: ok.decay, spread: ok.spread }, { decay: 2.5, spread: 'uniform' })
})

test('k 的语义：k 越大，近期筹码权重占比单调上升', () => {
  const bars = Array.from({ length: 12 }, (_, i) => ({ date: `d${i}`, close: 10 + i, vol: 100, low: 10 + i, high: 10 + i }))
  // 用"最近一天的成交价桶"的权重占比近似衡量"近期筹码占比"
  const share = (k: number): number => {
    // floatMv 取小一些让换手率有意义（t 会被 cap 夹到 0.25）：k 越大衰减越快，近期占比越高
    const r = chipSeriesOf(bars, { fqSupported: true, floatMv: 1e5, decay: k, buckets: 8, minSamples: 1 })
    const last = r.latest
    if (last === null) return 0
    const target = bars[bars.length - 1].close
    // argmin：找最接近最后一天收盘价的桶中心（别用 indexOf(minDiff) —— 那是在 centers 上找差值，找不到）
    const idx = last.centers.reduce((bi, c, ci) => (Math.abs(c - target) < Math.abs(last.centers[bi] - target) ? ci : bi), 0)
    return last.buckets[idx] ?? 0
  }
  const a = share(1.0)
  const b = share(2.0)
  assert.ok(b > a, `k 从 1.0 升到 2.0，近期筹码占比必须上升（${a} → ${b}）`)
})

test('手算对照：P5/P95 在累积分布上的插值', () => {
  // 构造一个只落在两端的分布：权重 [0.5,0,0,0.5]，中心 13.75 / 26.25 / 38.75 / 51.25
  const centers = bucketCenters(10, 40, 4)
  const buckets = [0.5, 0, 0, 0.5]
  // P5（target=0.05）落在第 0 桶内：lo=13.75（i=0 取自身）→ hi=13.75 ⇒ 13.75
  assert.equal(percentilePrice(buckets, centers, 0.05), 13.75)
  // P95（target=0.95）落在第 3 桶内：[28.75, 36.25]，frac=(0.95−0.5)/0.5=0.9 ⇒ 28.75+7.5×0.9=35.5
  assert.ok(Math.abs((percentilePrice(buckets, centers, 0.95) ?? 0) - 35.5) < 1e-9)
})

test('回落口径：港股必须走半衰期并写明原因；缺 floatMv 同样回落', () => {
  const hk = chipSeriesOf(HAND, { isHk: true, floatMv: 1e12, buckets: 4, minSamples: 1 })
  assert.equal(hk.decay, 'half-life', '港股 vol/amount 单位未标定 ⇒ 必须回落')
  assert.ok((hk.decayReason ?? '').includes('9926') || (hk.decayReason ?? '').includes('未标定'), `原因要写清（实际 ${String(hk.decayReason)}）`)
  assert.ok(hk.methodology.includes('固定半衰期'), '口径字符串要说明用了哪一档')
  const noMv = chipSeriesOf(HAND, { floatMv: null, buckets: 4, minSamples: 1 })
  assert.equal(noMv.decay, 'half-life')
  assert.ok((noMv.decayReason ?? '').includes('流通市值'), noMv.decayReason ?? '')
  // A股 + 有 floatMv ⇒ 走换手率口径
  const cn = chipSeriesOf(HAND, { floatMv: 1e12, buckets: 4, window: 45, minSamples: 1 })
  assert.equal(cn.decay, 'turnover')
  assert.equal(cn.decayReason, null)
  assert.ok(cn.methodology.includes('换手率'), cn.methodology)
})

test('不提供模块的三种情形：指数/期货、样本不足、价格无变化', () => {
  const idx = chipSeriesOf(HAND, { fqSupported: false })
  assert.equal(idx.why !== null, true)
  assert.ok((idx.why ?? '').includes('指数/期货'), idx.why ?? '')
  assert.equal(idx.latest, null)
  const few = chipSeriesOf(HAND.slice(0, CHIPS_MIN_SAMPLES - 1), { fqSupported: true, buckets: 4 })
  assert.ok((few.why ?? '').includes('样本不足'), few.why ?? '')
  const flat = chipSeriesOf(Array.from({ length: 12 }, (_, i) => ({ date: `2026-02-${i + 1}`, close: 10, vol: 1 })), { fqSupported: true, buckets: 4 })
  assert.ok((flat.why ?? '').includes('没有变化'), flat.why ?? '')
})

test('现价缺失 ⇒ 盈利比例 —，但平均成本仍给；现价给出 ⇒ 用 < 现价 的权重', () => {
  const noPrice = chipSeriesOf(HAND, { fqSupported: true, buckets: 4, price: null, minSamples: 1 })
  assert.equal(noPrice.profitRatio, null, '现价缺失 ⇒ 盈利比例 —')
  assert.equal(noPrice.avgCost !== null, true, '平均成本与现价无关，仍要给')
  // 现价 = 21.25（第二桶中心）⇒ 只算中心 < 21.25 的桶（第一桶）
  const withPrice = chipSeriesOf(HAND, { fqSupported: true, buckets: 4, price: 21.25, minSamples: 1 })
  const below = (withPrice.latest?.buckets ?? []).slice(0, 1).reduce((s, x) => s + x, 0) * 100
  assert.ok(Math.abs((withPrice.profitRatio ?? 0) - below) < 0.02, `盈利比例应=第一桶权重（实际 ${String(withPrice.profitRatio)} vs ${below}）`)
  assert.equal(withPrice.profitRatio === 0, false, '恰好相等的桶不算盈利（用 <）')
})

test('默认桶数与窗口：32 桶、45 根，不足时按实际根数', () => {
  // 12 根（过 10 根下限）⇒ 正常出数，桶数默认 32
  const twelve = Array.from({ length: 12 }, (_, i) => ({ date: `2026-03-${String(i + 1).padStart(2, '0')}`, close: 10 + i, vol: 100 }))
  const r = chipSeriesOf(twelve, { fqSupported: true })
  assert.equal(r.bucketCount, CHIPS_BUCKETS)
  assert.equal(r.latest?.buckets.length, CHIPS_BUCKETS)
  assert.equal(r.samples, 12)
  assert.ok(r.methodology.includes('近 12 根'), '不足时要写"近 N 根"，不能假装 45 根')
  const short = chipSeriesOf(HAND, { fqSupported: true })
  assert.ok((short.why ?? '').includes('样本不足'), '4 根 < 10 ⇒ 样本不足')
  assert.ok(r.disclaimer.includes('不是支撑/压力的预测'), '合规文案必须在')
  assert.ok(r.disclaimer.includes('不是买卖建议'))
})

test('task-61 ④：累积窗口 180 / 展示窗口 45 —— 同一天两种窗口算出的分布必须不同', () => {
  // 造 180 根：前 135 根在低价区（10 元附近），后 45 根在 20 元附近
  const bars = Array.from({ length: 180 }, (_, i) => ({
    date: `d${String(i).padStart(3, '0')}`,
    close: i < 135 ? 10 + (i % 3) * 0.1 : 20 + (i % 3) * 0.1,
    vol: 100,
  }))
  const wide = chipSeriesOf(bars, { fqSupported: true, floatMv: 1e8, decay: 1.5, window: 180, display: 45, minSamples: 1 })
  const narrow = chipSeriesOf(bars, { fqSupported: true, floatMv: 1e8, decay: 1.5, window: 45, display: 45, minSamples: 1 })
  assert.equal(wide.displayWindow, 45)
  assert.equal(wide.days.length, 45, '展示状态数 = 45（滑杆范围）')
  assert.equal(narrow.days.length, 45)
  // ① 同一个展示日（各自 days[0] 是不同日期，用最新的同一天：最后一天）对比分布
  const a = wide.latest
  const b = narrow.latest
  assert.ok(a !== null && b !== null)
  assert.notDeepEqual(a.buckets, b.buckets, '180 日累积 vs 45 日累积，同一天分布必须不同（证明窗口生效）')
  // ② 最早展示日的分布 ≠ "只有当天新增"（确实用了历史）
  const first = wide.days[0]
  const oneDayOnly = chipSeriesOf([bars[bars.length - 45]], { fqSupported: true, floatMv: 1e8, decay: 1.5, window: 180, display: 45, minSamples: 1 })
  if (oneDayOnly.latest !== null) {
    assert.notDeepEqual(first.buckets, oneDayOnly.latest.buckets, '最早展示日不能等于"只有当天新增"')
  }
  // ③ 守恒
  for (const d of wide.days) {
    const sum = d.buckets.reduce((x, y) => x + y, 0)
    assert.ok(Math.abs(sum - 1) < 1e-6, `每天权重和应为 1（实际 ${sum}）`)
  }
  // ④ 老调用（只给 days=45 的语义）不破坏：window=45、displayWindow=45、结构完整
  assert.equal(narrow.window, 45)
  assert.equal(narrow.displayWindow, 45)
  assert.ok(typeof narrow.methodology === 'string' && narrow.methodology.includes('近 45 根'))
})

test('task-61 ④：不足 180 根时如实写"近 N 根"（不假装够）', () => {
  const bars = Array.from({ length: 60 }, (_, i) => ({ date: `d${i}`, close: 10 + i * 0.1, vol: 100 }))
  const r = chipSeriesOf(bars, { fqSupported: true, floatMv: 1e8, window: 180, display: 45, minSamples: 1 })
  assert.equal(r.samples, 60)
  assert.ok(r.methodology.includes('用了近 60 根'), r.methodology.slice(0, 160))
  assert.equal(r.days.length, 45, '展示 45 天（少于实际根数时按展示窗口给）')
})
