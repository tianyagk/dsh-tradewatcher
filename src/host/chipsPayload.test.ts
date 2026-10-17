/**
 * 筹码回包的**形状与成本**断言（REVIEW-9-PERF §2.1① / §2.1② / §4）。
 *
 * 三条纪律：
 *  - **轴只发一份**：档中心价是整段序列的同一个数组 ⇒ 顶层 `centers` 一份，逐日不再重复。
 *    旧形状（45 天各拷一份 242 元数组）让回包从 84 KB 涨到 166 KB（实测），且 50% 的字节
 *    与序列化时间花在同一个数组的 45 份拷贝上。
 *  - **非展示日不算统计量**：`total/norm/avg/support/resistance/profitRatio` 只服务于被记录的天；
 *    旧写法把它们写在 `continue` 之前 ⇒ 180 天窗/45 天展示里白算 135 天（实测 display=45 比
 *    display=1 慢 2.27 ms）。判据用**调用次数**（`__chipStatsDaysOf`）而不是耗时：耗时会随机器
 *    负载抖，次数不会。
 *  - 两条判据都配**反例注入**：把 centers 改回逐日重复、把统计量算回非展示日 ⇒ 必须失败。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  CHIPS_DISPLAY, CHIPS_PAYLOAD_MAX_BYTES, bucketCenters, chipSeriesOf, __chipStatsDaysOf, __resetChipStatsDays,
} from './chips.ts'

/** 行情形状：真实价格区间（不是常数）——常数会让"高=低"早退，测不到分布 */
function barsOf(n: number, mid: number, half: number, vol = 1000): Array<{ date: string; close: number; low: number; high: number; vol: number }> {
  return Array.from({ length: n }, (_, i) => {
    const close = mid + half * Math.sin(i / 17)
    return { date: `2026-${String(1 + Math.floor(i / 30)).padStart(2, '0')}-${String(1 + (i % 30)).padStart(2, '0')}`, close, low: close - half * 0.01, high: close + half * 0.01, vol }
  })
}

/** 判据：回包里 `"centers":` 出现几次（1 = 只在顶层；>1 = 有人又逐日拷了一份） */
function centersOccurrences(json: string): number {
  return (json.match(/"centers":/g) ?? []).length
}

/** 与实现共用的判据（正例与反例注入都走它，避免两处口径） */
function assertSingleAxis(json: string): void {
  const n = centersOccurrences(json)
  assert.equal(n, 1, `轴必须只在顶层出现一次（实际 ${n} 次）—— 逐日再拷一份会让回包多出约一倍字节`)
}

test('① 轴只发一份：顶层 centers 恰好出现 1 次，逐日不带 centers，且与 bucketCenters 同源', () => {
  const bars = barsOf(200, 100, 20)
  const r = chipSeriesOf(bars, { fqSupported: true, floatMv: 1e10, window: 200, display: 45, minSamples: 1 })
  assert.ok(r.days.length > 1, `前置：要有多个展示日（实际 ${r.days.length}）`)
  assert.equal(r.centers.length, r.bucketCount, `顶层轴长度必须 == 档数（${r.centers.length} vs ${r.bucketCount}）`)
  for (const d of r.days) assert.equal('centers' in d, false, `${d.date}：逐日不许再带 centers`)
  // 与纯函数同源：轴 == bucketCenters(窗口 low, high, 档数)，逐个 4 位小数一致
  const closes = bars.map((b) => b.close)
  const expect = bucketCenters(Math.min(...closes), Math.max(...closes), r.bucketCount).map((c) => Math.round(c * 1e4) / 1e4)
  assert.deepEqual(r.centers, expect, '顶层轴必须等于 bucketCenters(low, high, 档数) 的 4 位小数结果（不是另算一套）')
  // 单调递增（价格轴）
  for (let i = 1; i < r.centers.length; i += 1) assert.ok(r.centers[i] > r.centers[i - 1], `轴必须单调递增（第 ${i} 档）`)
  // 序列化：只出现一次
  const json = JSON.stringify(r)
  assertSingleAxis(json)
  // 反例注入：把轴逐日拷回去 ⇒ 同一条判据必须失败
  const injected = JSON.stringify({ ...r, days: r.days.map((d) => ({ ...d, centers: r.centers })) })
  assert.equal(centersOccurrences(injected), r.days.length + 1)
  assert.throws(() => assertSingleAxis(injected), /轴必须只在顶层出现一次/, '⚠ 反例注入（逐日重复轴）必须被同一条判据抓住')
})

test('② 体积预算：轴本身 ≤ 4 KB（不是 45 份），逐日重复的形状至少多 60 KB 且 > 1.5×', () => {
  const bars = barsOf(360, 100, 60)
  const r = chipSeriesOf(bars, { fqSupported: true, floatMv: 1e10, window: 360, display: CHIPS_DISPLAY, minSamples: 1 })
  assert.ok(r.bucketCount >= 200, `前置：长窗口应自适应出较多档（实际 ${r.bucketCount}）`)
  const axisBytes = Buffer.byteLength(JSON.stringify(r.centers))
  const bytes = Buffer.byteLength(JSON.stringify(r))
  const injectedBytes = Buffer.byteLength(JSON.stringify({ ...r, days: r.days.map((d) => ({ ...d, centers: r.centers })) }))
  // ① 轴自己只占一份：≤ 4 KB（242 档 × 约 7 字符）。旧形状下它在回包里占 45 份。
  assert.ok(axisBytes <= 4 * 1024, `轴本身必须 ≤ 4 KB（实际 ${axisBytes} B）`)
  // ② 与生产预算的关系：回包仍须落在 CHIPS_PAYLOAD_MAX_BYTES 之内（档数自适应按它夹）
  assert.ok(bytes < CHIPS_PAYLOAD_MAX_BYTES, `回包必须 < 预算 ${CHIPS_PAYLOAD_MAX_BYTES} B（实际 ${bytes} B）`)
  // ③ 逐日重复轴的形状：至少多 60 KB、且至少是 1.5 倍（实测真机 166→84 KB ≈ 1.98×）
  assert.ok(injectedBytes - bytes > 60 * 1024, `重复轴至少多 60 KB（实际 ${((injectedBytes - bytes) / 1024).toFixed(1)} KB）`)
  assert.ok(injectedBytes > bytes * 1.5, `重复轴至少 1.5×（实际 ${(injectedBytes / bytes).toFixed(2)}×）`)
})

test('③ 跨市场一致：A股/港股/美股/指数都能给出「同一份轴」，无分布的标的给空轴 + 原因（不编档位）', () => {
  const bars = barsOf(240, 50, 8)
  const cn = chipSeriesOf(bars, { fqSupported: true, floatMv: 1e10, window: 240, display: 45, minSamples: 1 })
  const hk = chipSeriesOf(bars, { fqSupported: true, isHk: true, floatMv: 1e10, window: 240, display: 45, minSamples: 1 })
  for (const [name, r] of [['A股', cn], ['港股', hk]] as const) {
    assert.equal(r.centers.length, r.bucketCount, `${name}：轴长度 == 档数`)
    assert.equal('centers' in (r.days[0] ?? {}), false, `${name}：逐日不带轴`)
    assertSingleAxis(JSON.stringify(r))
    assert.equal(r.centers[0] !== undefined && Number.isFinite(r.centers[0]), true, `${name}：轴首档必须是有限数`)
  }
  // 港股口径回落半衰期（vol/amount 未标定），但轴仍然是一份
  assert.equal(hk.decay, 'half-life')
  // 不支持前复权（指数/期货/美股）⇒ 空轴 + why，且不给假档位
  const off = chipSeriesOf(bars, { fqSupported: false, minSamples: 1 })
  assert.deepEqual(off.days, [])
  assert.deepEqual(off.centers, [], '无分布 ⇒ 空轴（不编档位）')
  assert.ok((off.why ?? '').includes('前复权'), `必须给原因：${off.why}`)
})

test('④ 非展示日不算统计量：180 天窗 / 45 天展示 ⇒ 统计天数恰好 45（旧写法 180）', () => {
  const bars = barsOf(200, 100, 20)
  __resetChipStatsDays()
  const r = chipSeriesOf(bars, { fqSupported: true, floatMv: 1e10, window: 180, display: 45, minSamples: 1 })
  const calls = __chipStatsDaysOf()
  assert.equal(r.days.length, 45, `前置：展示日必须是 45（实际 ${r.days.length}）`)
  assert.equal(calls, 45, `只有展示日算统计量（实际 ${calls} 天；旧写法会把 180 天全算一遍）`)
  assert.notEqual(calls, 180, '⚠ 反例：若把统计量算回非展示日，这里会是 180 ⇒ 必败')
})

test('⑤ 展示窗口越小、统计天数越少（成本随展示天数线性，不随累积窗口线性）', () => {
  const bars = barsOf(200, 100, 20)
  for (const display of [1, 12, 45]) {
    __resetChipStatsDays()
    chipSeriesOf(bars, { fqSupported: true, floatMv: 1e10, window: 180, display, minSamples: 1 })
    assert.equal(__chipStatsDaysOf(), display, `display=${display} ⇒ 恰好 ${display} 天算统计量`)
  }
})
