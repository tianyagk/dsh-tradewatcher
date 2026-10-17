/**
 * 筹码分布的断言（含**手算对照**：自造 4 根序列，桶分摊/权重/平均成本/P5/P95 逐位算出）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CHIPS_BUCKETS_AUTO_MAX, CHIPS_BUCKETS_AUTO_MIN, CHIPS_DECAY_DEFAULT, CHIPS_MIN_SAMPLES, allocate, allocateSpread, bucketCenters, chipSeriesOf, normalizeChipPrefs, percentilePrice } from './chips.ts'

/** 手算用的 4 根序列：10 / 20 / 30 / 40（等量），桶数 4 ⇒ 中心 13.75 / 26.25 / 38.75 / 51.25 */
const HAND = [
  { date: '2026-01-01', close: 10, vol: 100 },
  { date: '2026-01-02', close: 20, vol: 100 },
  { date: '2026-01-03', close: 30, vol: 100 },
  { date: '2026-01-04', close: 40, vol: 100 },
]

test('手算对照：桶中心、单价分摊与守恒', () => {
  const centers = bucketCenters(10, 40, 16)
  assert.deepEqual(centers.slice(0, 2), [10.9375, 12.8125], '区间 [10,40] 十六等分的中点（桶宽 1.875）')
  // 价格 20 落在相邻两中心之间：按位置线性分摊（守恒）
  const w = new Array(centers.length).fill(0)
  allocate(w, centers, 20, 1)
  assert.ok(Math.abs(w.reduce((a, b) => a + b, 0) - 1) < 1e-12, '分摊守恒')
  assert.equal(w.filter((x) => x > 0).length, 2, '只落在相邻两桶')
  // 守恒：分摊前后总权重相等（这是"别差一分钱换一桶"的核心）
  const before = w.reduce((s, x) => s + x, 0)
  allocate(w, centers, 21, 0.3)
  assert.ok(Math.abs(w.reduce((s, x) => s + x, 0) - before - 0.3) < 1e-12, '分摊不创造也不丢失权重')
  // 低于最低中心/高于最高中心 ⇒ 落两端桶
  const w2 = new Array(centers.length).fill(0)
  allocate(w2, centers, 5, 1)
  assert.deepEqual(w2, [1, ...new Array(centers.length - 1).fill(0)], '低于最低中心 ⇒ 落第一桶')
  allocate(w2, centers, 99, 1)
  assert.equal(w2[0], 1)
  assert.equal(w2[w2.length - 1], 1, '高于最高中心 ⇒ 落最后一桶')
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
  const r = chipSeriesOf(bars, { fqSupported: true, floatMv, decay: k, spread: 'triangle', buckets: 16, minSamples: 1 })
  assert.equal(r.decay, 'turnover')
  // 手算：每天都把历史 ×0.985 再加当日换手权重（t 每天不同：10 → 20 → 30 元 ⇒ t = 0.01 / 0.02 / 0.03）
  const centers = bucketCenters(10, 30, 16) // [12.5, 17.5, 22.5, 27.5]
  let hist = new Array(centers.length).fill(0)
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
  const mine = hist.map((x) => Math.round((x / total) * 1e8) / 1e8)
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
    { fqSupported: true, floatMv: 1, decay: 3, cap: 1, buckets: 16, minSamples: 1 },
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
    const idx = r.centers.reduce((bi, c, ci) => (Math.abs(c - target) < Math.abs(r.centers[bi] - target) ? ci : bi), 0)
    return last.buckets[idx] ?? 0
  }
  const a = share(1.0)
  const b = share(2.0)
  assert.ok(b > a, `k 从 1.0 升到 2.0，近期筹码占比必须上升（${a} → ${b}）`)
})

test('手算对照：P5/P95 在累积分布上的插值', () => {
  // 构造一个只落在两端的分布：权重 [0.5,0,0,0.5]，中心 13.75 / 26.25 / 38.75 / 51.25
  const centers = bucketCenters(10, 40, 16)
  const buckets = [0.5, ...new Array(14).fill(0), 0.5]
  // P5（target=0.05）落在第 0 桶内：lo=hi=第一桶中心 ⇒ 就是它
  assert.equal(percentilePrice(buckets, centers, 0.05), centers[0])
  // P95（target=0.95）落在最后一桶内：[上一中心, 末中心]，frac=(0.95−0.5)/0.5=0.9
  const lo = centers[centers.length - 2]
  const hi = centers[centers.length - 1]
  assert.ok(Math.abs((percentilePrice(buckets, centers, 0.95) ?? 0) - (lo + (hi - lo) * 0.9)) < 1e-9)
})

test('回落口径：港股必须走半衰期并写明原因；缺 floatMv 同样回落', () => {
  const hk = chipSeriesOf(HAND, { isHk: true, floatMv: 1e12, buckets: 16, minSamples: 1 })
  assert.equal(hk.decay, 'half-life', '港股 vol/amount 单位未标定 ⇒ 必须回落')
  assert.ok((hk.decayReason ?? '').includes('9926') || (hk.decayReason ?? '').includes('未标定'), `原因要写清（实际 ${String(hk.decayReason)}）`)
  assert.ok(hk.methodology.includes('固定半衰期'), '口径字符串要说明用了哪一档')
  const noMv = chipSeriesOf(HAND, { floatMv: null, buckets: 16, minSamples: 1 })
  assert.equal(noMv.decay, 'half-life')
  assert.ok((noMv.decayReason ?? '').includes('流通市值'), noMv.decayReason ?? '')
  // A股 + 有 floatMv ⇒ 走换手率口径
  const cn = chipSeriesOf(HAND, { floatMv: 1e12, buckets: 16, window: 45, minSamples: 1 })
  assert.equal(cn.decay, 'turnover')
  assert.equal(cn.decayReason, null)
  assert.ok(cn.methodology.includes('换手率'), cn.methodology)
})

test('不提供模块的三种情形：指数/期货、样本不足、价格无变化', () => {
  const idx = chipSeriesOf(HAND, { fqSupported: false })
  assert.equal(idx.why !== null, true)
  assert.ok((idx.why ?? '').includes('指数/期货'), idx.why ?? '')
  assert.equal(idx.latest, null)
  const few = chipSeriesOf(HAND.slice(0, CHIPS_MIN_SAMPLES - 1), { fqSupported: true, buckets: 16 })
  assert.ok((few.why ?? '').includes('样本不足'), few.why ?? '')
  const flat = chipSeriesOf(Array.from({ length: 12 }, (_, i) => ({ date: `2026-02-${i + 1}`, close: 10, vol: 1 })), { fqSupported: true, buckets: 16 })
  assert.ok((flat.why ?? '').includes('没有变化'), flat.why ?? '')
})

test('现价缺失 ⇒ 盈利比例 —，但平均成本仍给；现价给出 ⇒ 用 < 现价 的权重', () => {
  const noPrice = chipSeriesOf(HAND, { fqSupported: true, buckets: 16, price: null, minSamples: 1 })
  assert.equal(noPrice.profitRatio, null, '现价缺失 ⇒ 盈利比例 —')
  assert.equal(noPrice.avgCost !== null, true, '平均成本与现价无关，仍要给')
  // 现价 = 第二桶中心 ⇒ 只算中心 < 它的桶（第一桶）
  const centers1Price = bucketCenters(10, 30, 16)[1]
  const withPrice = chipSeriesOf(HAND, { fqSupported: true, buckets: 16, price: centers1Price, minSamples: 1 })
  const below = (withPrice.latest?.buckets ?? []).slice(0, 1).reduce((s, x) => s + x, 0) * 100
  assert.ok(Math.abs((withPrice.profitRatio ?? 0) - below) < 0.02, `盈利比例应=第一桶权重（实际 ${String(withPrice.profitRatio)} vs ${below}）`)
  assert.equal(withPrice.profitRatio === 0, false, '恰好相等的桶不算盈利（用 <）')
})

test('默认档数自适应（档数由价格区间定）、45 根展示窗口，不足时按实际根数', () => {
  // 12 根（过 10 根下限）⇒ 正常出数；档数由 planBuckets 按区间算（不再恒为 96）
  const twelve = Array.from({ length: 12 }, (_, i) => ({ date: `2026-03-${String(i + 1).padStart(2, '0')}`, close: 10 + i, vol: 100 }))
  const r = chipSeriesOf(twelve, { fqSupported: true })
  assert.ok(r.bucketCount >= CHIPS_BUCKETS_AUTO_MIN && r.bucketCount <= CHIPS_BUCKETS_AUTO_MAX, `档数必须在 [${CHIPS_BUCKETS_AUTO_MIN}, ${CHIPS_BUCKETS_AUTO_MAX}]（实际 ${r.bucketCount}）`)
  assert.equal(r.latest?.buckets.length, r.bucketCount)
  assert.ok(r.bucketWidth !== null && r.bucketWidth > 0, '档宽随结果给出')
  assert.ok(r.methodology.includes('档数') && r.methodology.includes('档宽'), '口径串必须写档数与档宽（分辨率可读）')
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

/**
 * v0.57.0（task-5）：`ChipDay.price` —— 逐日盈亏边界价，且**与 profitRatio 同源**。
 *
 * 背景：界面原先统一用顶层 `priceUsed`（现价）给筹码柱上色，而宿主算 `profitRatio` 时
 * **历史展示日用当日收盘价** ⇒ 拖到历史日会看到"柱色一套边界、盈利比例另一套边界"。
 */
test('逐日 price：历史日=当日收盘价、最新日=priceUsed；且与该日 profitRatio **同源**（可复算）', () => {
  // 三天：收盘 10 / 20 / 30；现价给 25（刻意**不等于**任何一天收盘，便于分辨用了哪天的价）
  const bars = [
    { date: '2026-01-01', close: 10, vol: 100 },
    { date: '2026-01-02', close: 20, vol: 100 },
    { date: '2026-01-03', close: 30, vol: 100 },
  ]
  const r = chipSeriesOf(bars, { fqSupported: true, floatMv: 1e5, decay: 1.5, spread: 'triangle', buckets: 16, minSamples: 1, price: 25 })
  assert.equal(r.days.length, 3, '三天都在（display 默认覆盖）')
  // ① 边界价：前两天 = 各自收盘价；最后一天 = 顶层现价
  assert.equal(r.days[0].price, 10, '第 1 天（历史）⇒ 当日收盘价 10')
  assert.equal(r.days[1].price, 20, '第 2 天（历史）⇒ 当日收盘价 20')
  assert.equal(r.days[2].price, 25, '第 3 天（最新）⇒ 顶层现价 25')
  assert.equal(r.priceUsed, 25, '顶层 priceUsed 仍然保留（别的消费方在用）')
  // ② **同源**：用该日 price 复算"低于该价的权重占比"，必须等于该日 profitRatio（百分比，2 位小数）
  for (const d of r.days) {
    const redo = d.buckets.reduce((s, w, i) => (r.centers[i] < (d.price as number) ? s + w : s), 0)
    const expect = Math.round(redo * 100 * 100) / 100
    assert.ok(Math.abs((d.profitRatio as number) - expect) <= 0.01,
      `${d.date}：用 price=${d.price} 复算的占比 ${expect}% 必须等于宿主给的 profitRatio ${d.profitRatio}%`)
  }
  // ③ 缺 priceUsed（现价不可得）⇒ 最新日 price 为 null（不猜一个价），历史日仍给收盘价
  const noQuote = chipSeriesOf(bars, { fqSupported: true, floatMv: 1e5, decay: 1.5, spread: 'triangle', buckets: 16, minSamples: 1, price: null })
  assert.equal(noQuote.days[2].price, null, '现价不可得 ⇒ 最新日 price 为 null（界面按"未取到"处理）')
  assert.equal(noQuote.days[0].price, 10, '历史日不受现价缺失影响')
  // ④ 三种价不同 ⇒ 翻转点必须跟着展示日走（这条是"随日移动"的宿主侧证据）
  const flips = r.days.map((d) => d.price)
  assert.deepEqual(flips, [10, 20, 25], '逐日边界价必须是 [10, 20, 25]（不是三天同一个价）')
  assert.ok(new Set(flips).size === 3, '三天三个不同的价 ⇒ 若客户端统一用顶层价，翻转点就不会移动')
})

/**
 * v0.57.0（task-5）端到端：**宿主产出的 DTO → 客户端取价 → 柱色翻转点**必须与该日 `profitRatio` 一致。
 *
 * 这条跨了宿主/客户端两侧（`chips.buckets.test.ts` 已有先例），因为要证明的正是"两侧同源"：
 * 只测一侧都可能是"各自自洽、合起来矛盾"。
 */
test('端到端同源：宿主 days[].price → 客户端 chipProfitDirOf，翻转点 == 该日 profitRatio 的分界', async () => {
  const { chipsDayPriceOf, chipProfitDirOf } = await import('../client/chipsView.ts')
  const bars = Array.from({ length: 10 }, (_, i) => ({ date: `2026-02-${String(i + 1).padStart(2, '0')}`, close: 12 + i * 1.3, vol: 100 + i * 7 }))
  const r = chipSeriesOf(bars, { fqSupported: true, floatMv: 1e5, decay: 1.5, spread: 'triangle', buckets: 16, minSamples: 1, price: 26.75 })
  let checked = 0
  for (const d of r.days) {
    // ① 客户端必须原样取用该日的价（有 price 就不许回退）
    const picked = chipsDayPriceOf({ dayPrice: d.price, topPriceUsed: r.priceUsed })
    assert.equal(picked.fallback, false, `${d.date}：有逐日 price 时不许回退`)
    assert.equal(picked.price, d.price, `${d.date}：客户端取价必须等于该日 price`)
    // ② 翻转点方向：价下方=获利(tw-up)、价上方=套牢(tw-down)
    assert.equal(chipProfitDirOf({ center: (d.price as number) - 0.01, priceUsed: d.price, redUp: true }), 'tw-up', `${d.date}：价下方=获利`)
    assert.equal(chipProfitDirOf({ center: (d.price as number) + 0.01, priceUsed: d.price, redUp: true }), 'tw-down', `${d.date}：价上方=套牢`)
    // ③ 同源：用该日 price 复算的分界 == 宿主给的 profitRatio
    const redo = Math.round(d.buckets.reduce((s2, w, i) => (r.centers[i] < (d.price as number) ? s2 + w : s2), 0) * 10000) / 100
    assert.ok(Math.abs(redo - (d.profitRatio as number)) <= 0.01,
      `${d.date}：客户端按 price=${d.price} 得到的分界 ${redo}% 必须等于宿主 profitRatio ${d.profitRatio}%`)
    checked += 1
  }
  assert.ok(checked >= 5, `至少核到 5 天（实际 ${checked}）`)
  // 逐日价不全相同 ⇒ "统一用顶层现价"一定会在某些天出错
  assert.ok(new Set(r.days.map((d) => d.price)).size > 1, '逐日价必须真的逐日不同（否则这条断言证明不了什么）')
})

/**
 * v0.63.0（task-11）端到端：**盘上有历史、上游挂了 ⇒ 不许报"样本不足"**。
 *
 * 走真的 `fetchKline`（真磁盘缓存 + 真回源失败路径），再把拿到的 bar 喂给真的 `chipSeriesOf`
 * —— 这正是用户看到的那条链路（`/chips` → `fetchKline` → `chipSeriesOf`）。
 * 上游用桩挡住：`globalThis.fetch` 一律 reject ⇒ 不碰网络、结果确定。
 */
test('端到端：缓存 40 根 + 最后一根未完成超 TTL + 回源失败 ⇒ samples ≥ 10（不是"样本不足"）', async () => {
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { fetchKline, klineCacheStatusOf } = await import('./em.ts')
  const home = mkdtempSync(join(tmpdir(), 'tw-chips-degrade-'))
  const prevHome = process.env.DSH_HOME
  const prevFetch = globalThis.fetch
  /**
   * ⚠ **必须钉住时钟**：这条用例的前提是"最后一根未完成 bar 已超过 60s TTL、需要回源"，
   * 而 `isSettledOffline(cacheUpdatedAt)` 在**收盘后**会把任何晚于最近收盘（15:05）的缓存判成
   * "已定稿" ⇒ 根本不回源、也不标 `stale`。也就是说：**不钉时钟时这条用例只在 09:25–15:05 之间成立**
   * （2026-10-12 15:57 实测：干净 HEAD 上就红；同一天 14:14 的"全绿"是假绿，见 AUDIT-IMPL41 §7）。
   * 钉在北京时间 2026-10-12（周一）10:30 —— 连续竞价中。
   */
  const realNow = Date.now
  const FAKE_NOW = Date.parse('2026-10-12T10:30:00+08:00')
  Date.now = () => FAKE_NOW
  process.env.DSH_HOME = home
  // 上游一律失败（不碰网络）
  globalThis.fetch = (() => Promise.reject(new Error('offline (test)'))) as typeof fetch
  try {
    const secid = '1.600519'
    const dir = join(home, 'dsh-tradewatcher', 'klines')
    mkdirSync(dir, { recursive: true })
    const bars = Array.from({ length: 40 }, (_, i) => ({
      date: `2026-0${Math.floor(i / 28) + 1}-${String((i % 28) + 1).padStart(2, '0')}`,
      open: 10 + i * 0.1, close: 10.1 + i * 0.1, high: 10.2 + i * 0.1, low: 9.9 + i * 0.1, vol: 1000 + i, pct: 0.5,
    }))
    // 最后一根是盘中未完成 bar，且落盘时间已超过 60s TTL（用户遇到的那种缓存）
    writeFileSync(join(dir, `${secid}_101_1.json`), JSON.stringify({
      v: 3, secid, klt: 101, fqt: 1, updatedAt: Date.now() - 10 * 60_000, partial: true, bars,
    }))

    const k = await fetchKline(secid, 101, 360, 1)
    assert.ok(k !== null, '⚠ 有 40 根历史时**不许**返回 null（老实现这里就是 null ⇒ 样本不足）')
    const kk = k as NonNullable<typeof k>
    assert.equal(kk.stale, true, '回源失败 + 用缓存 ⇒ stale 必须为 true')
    assert.equal(kk.days.length, 39, '40 根里丢掉不可信的最后一根 ⇒ 39 根')
    assert.ok(typeof kk.staleReason === 'string' && kk.staleReason.includes('未完成'), `说明要点明最后一根未完成（实际 ${kk.staleReason}）`)
    assert.ok((kk.staleReason ?? '').includes('已完成 bar'), '说明还要点明用的是"已完成 bar"')
    const st = klineCacheStatusOf(secid, 101, 1)
    assert.equal(st?.degraded, true, '状态里要如实标"降级采用"')
    assert.equal(st?.exists, true, '缓存存在（不是"没有缓存"）')
    // ② 喂给真的筹码模块 ⇒ 样本数必须够（用户报的"样本不足"就此消失）
    const series = chipSeriesOf(kk.days.map((d) => ({ date: d.date, close: d.close, vol: d.vol })), {
      fqSupported: true, floatMv: null, decay: 1.5, spread: 'triangle', buckets: 16, minSamples: 1, price: kk.days[kk.days.length - 1].close,
    })
    assert.ok(series.latest !== null, '筹码序列必须算得出来')
    assert.ok(series.latest.samples >= 10, `样本数必须 ≥ 10（实际 ${series.latest.samples}）—— 这就是用户报的"样本不足"被修好`)
  } finally {
    Date.now = realNow
    globalThis.fetch = prevFetch
    if (prevHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = prevHome
    rmSync(home, { recursive: true, force: true })
  }
})

test('端到端：缓存只有 5 根（丢最后一根后不足下限）⇒ 如实不采用（不硬凑样本）', async () => {
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { fetchKline, klineCacheStatusOf, klineMissingReason } = await import('./em.ts')
  const home = mkdtempSync(join(tmpdir(), 'tw-chips-toofew-'))
  const prevHome = process.env.DSH_HOME
  const prevFetch = globalThis.fetch
  process.env.DSH_HOME = home
  globalThis.fetch = (() => Promise.reject(new Error('offline (test)'))) as typeof fetch
  try {
    const secid = '0.300750'
    const dir = join(home, 'dsh-tradewatcher', 'klines')
    mkdirSync(dir, { recursive: true })
    const bars = Array.from({ length: 5 }, (_, i) => ({
      date: `2026-09-2${i + 1}`, open: 100, close: 100 + i, high: 101, low: 99, vol: 1000, pct: 0.5,
    }))
    writeFileSync(join(dir, `${secid}_101_1.json`), JSON.stringify({
      v: 3, secid, klt: 101, fqt: 1, updatedAt: Date.now() - 10 * 60_000, partial: true, bars,
    }))
    const k = await fetchKline(secid, 101, 360, 1)
    assert.equal(k, null, '4 根 < 10 ⇒ 不采用（返回 null，如实走"样本不足"）')
    const st = klineCacheStatusOf(secid, 101, 1)
    assert.equal(st?.exists, true, '但状态里必须承认"缓存是存在的"（note 才能说实话）')
    assert.equal(st?.degraded, false, '没有被降级采用')
    const reason = klineMissingReason(secid, 101, { emDown: true, cache: st })
    assert.ok(reason.note.includes('本地有该周期的缓存') && reason.note.includes('被判不可用'),
      `note 必须说"有缓存但不可用"，不许说"本地没有该周期的缓存"（实际 ${reason.note}）`)
    assert.equal(reason.note.includes('本地没有该周期的缓存'), false, '⚠ 那句与事实不符的话不许再出现')
  } finally {
    globalThis.fetch = prevFetch
    if (prevHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = prevHome
    rmSync(home, { recursive: true, force: true })
  }
})
