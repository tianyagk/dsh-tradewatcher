/**
 * **自适应档数**的断言（v0.99.x，`docs/AUDIT-IMPL66.md`）。
 *
 * 要解决的问题：档数固定 96 时，窗口从 45 天扩到 805 天会把价格区间拉宽 ⇒ 档宽从 1.25 元粗到
 * 6.10 元（贵州茅台实测 4.9×）——"筹码覆盖变全"以"价格分辨变粗"为代价。
 *
 * 规则：档数**自适应价格区间**，使档宽 ≈ 中间价 × 0.1%（现状默认 45 天 / 96 档的实测分辨率），
 * 档数落在 `[48, 384]`，且**回包体积**不超 `CHIPS_PAYLOAD_MAX_BYTES`；任何一道限制先撞上，
 * 都必须在 `bucketNote` 里写明，并**出现在界面上**（不许静默变粗）。
 *
 * ⚠ 六组判据各配反例注入（都必败）：① 自适应方向 ② 档宽带 ③ 上下限 ④ 回包字节 ⑤ 夹取标注可见 ⑥ 既有语义回归。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import {
  CHIPS_BUCKETS_AUTO_MAX, CHIPS_BUCKETS_AUTO_MIN, CHIPS_BUCKETS_MAX, CHIPS_PAYLOAD_MAX_BYTES,
  CHIPS_WIDTH_BAND, CHIPS_WIDTH_TARGET_PCT, chipSeriesOf, planBuckets, type BucketPlan,
} from './chips.ts'
import { bucketCaliberOf, caliberDeviates } from '../client/chipsView.ts'

const here = dirname(fileURLToPath(import.meta.url))

/** 造一段真实形状的日线：价格围绕 `mid` 波动、区间半宽 `half`，根数 `n` */
function barsOf(n: number, mid: number, half: number, vol = 1000): Array<{ date: string; close: number; low: number; high: number; vol: number; open: number }> {
  return Array.from({ length: n }, (_, i) => {
    const close = mid + half * Math.sin(i / 17)
    return { date: `2026-${String(1 + Math.floor(i / 30)).padStart(2, '0')}-${String(1 + (i % 30)).padStart(2, '0')}`, open: close, close, low: close - half * 0.01, high: close + half * 0.01, vol }
  })
}

/** 组的判据（返回违规清单；实现与注入共用，避免两处口径） */
function planViolations(plan: BucketPlan): string[] {
  const bad: string[] = []
  if (plan.buckets < CHIPS_BUCKETS_AUTO_MIN || plan.buckets > CHIPS_BUCKETS_AUTO_MAX) bad.push(`档数 ${plan.buckets} 越界 [${CHIPS_BUCKETS_AUTO_MIN}, ${CHIPS_BUCKETS_AUTO_MAX}]`)
  const inBand = plan.widthPct >= CHIPS_WIDTH_BAND[0] && plan.widthPct <= CHIPS_WIDTH_BAND[1]
  if (!inBand && plan.clamped === null) bad.push(`档宽 ${(plan.widthPct * 100).toFixed(3)}% 越出目标带且没有任何夹取留痕（静默变粗）`)
  if (plan.clamped !== null && (plan.note === null || plan.note.trim() === '')) bad.push(`档数被 ${plan.clamped} 夹住却没有说明`)
  return bad
}

// ── ① 档数随区间自适应 ──────────────────────────────────────────────────────

test('① 档数随价格区间自适应：宽区间 ⇒ 档数增加；窄区间 ⇒ 减少（同一中间价）', () => {
  const narrow = planBuckets({ low: 99, high: 101, displayDays: 45 })          // 区间 2 元：目标档宽 0.1 元 ⇒ 只需 20 档 < 下限
  const midRange = planBuckets({ low: 95, high: 105, displayDays: 45 })        // 区间 10 元 ⇒ 100 档（未夹）
  const wide = planBuckets({ low: 92, high: 108, displayDays: 45 })            // 区间 16 元 ⇒ 160 档（未夹）
  assert.equal(wide.mid, narrow.mid, '三者中间价相同（只差区间宽度）')
  assert.equal(narrow.buckets, CHIPS_BUCKETS_AUTO_MIN, '极窄区间被下限接住')
  assert.equal(narrow.clamped, 'min')
  assert.ok(midRange.buckets < wide.buckets, `宽区间档数必须更多（${wide.buckets} > ${midRange.buckets}）`)
  assert.equal(midRange.clamped, null, '中档区间不该被夹（证明档数是"按区间算出来的"）')
  assert.equal(wide.clamped, null)
  // 方向必须来自"档宽 = 区间 ÷ 档数 ≈ 目标"：未夹的两个都贴住同一个目标
  assert.ok(Math.abs(midRange.width - midRange.target) / midRange.target < 0.05, `档宽应贴住目标（${midRange.width} vs ${midRange.target}）`)
  assert.ok(Math.abs(wide.width - wide.target) / wide.target < 0.05, `档宽应贴住目标（${wide.width} vs ${wide.target}）`)
  // 端到端：同一标的不同窗口 ⇒ 长窗口档数更多（这正是"分辨率不随窗口变粗"）
  // 用线性趋势（不是正弦）：最近 45 根的区间天然比 600 根窄，两个窗口的档数差异才来自"区间"本身
  const trend = Array.from({ length: 600 }, (_, i) => {
    const close = 100 + i * (40 / 599)
    return { date: `d${i}`, open: close, close, low: close, high: close, vol: 1000 }
  })
  const short = chipSeriesOf(trend.slice(-45), { fqSupported: true, floatMv: 1e10, window: 45, display: 45, minSamples: 1 })
  const long = chipSeriesOf(trend, { fqSupported: true, floatMv: 1e10, window: 600, display: 45, minSamples: 1 })
  assert.ok(long.bucketCount > short.bucketCount, `长窗口档数必须更多（${long.bucketCount} > ${short.bucketCount}）`)
  // 关键：长窗口的分辨率要比"改造前的固定 96 档"明显细（这就是本改造要解决的问题）
  const oldLong = chipSeriesOf(trend, { fqSupported: true, floatMv: 1e10, window: 600, display: 45, minSamples: 1, buckets: 96 })
  assert.ok(
    (long.bucketWidth ?? 0) < (oldLong.bucketWidth ?? 0) * 0.6,
    `长窗口档宽必须明显细于改造前（自适应 ${long.bucketWidth} vs 固定 96 档 ${oldLong.bucketWidth}）`,
  )
})

// ── ② 档宽落在目标带内 ─────────────────────────────────────────────────────

test('② 档宽必须落在目标带内（越带只能是被夹住且留痕）', () => {
  /** 真实样本的区间（实测自 AUDIT-IMPL66 §2：45 天 / 805 天两种窗口） */
  const cases: Array<[string, number, number]> = [
    ['1.510300 @45d', 4.245, 4.798],
    ['1.510300 @805d', 2.988, 5.080],
    ['1.600519 @45d', 1236.2, 1354.7],
    ['1.600519 @805d', 1160.6, 1740.5],
    ['116.00700 @2000d', 300, 900],
    ['窄：低波动股', 9.8, 10.2],
  ]
  for (const [name, low, high] of cases) {
    const plan = planBuckets({ low, high, displayDays: 45 })
    assert.deepEqual(planViolations(plan), [], `${name}：${JSON.stringify(plan)}`)
  }
  // 目标比例本身也钉一下（0.1% = 现状默认 45 天 / 96 档的实测分辨率）
  assert.equal(CHIPS_WIDTH_TARGET_PCT, 0.001)
  assert.deepEqual(CHIPS_WIDTH_BAND, [0.0005, 0.002])
  // 反例注入：把档数**钉死 96**（改造前的行为）⇒ 长窗口必然越带且无留痕 ⇒ 判据必败
  const nailed: BucketPlan = { ...planBuckets({ low: 1160.6, high: 1740.5, displayDays: 45 }), buckets: 96, clamped: null, note: null }
  nailed.width = (1740.5 - 1160.6) / 96
  nailed.widthPct = nailed.width / nailed.mid
  assert.ok(planViolations(nailed).length > 0, '⚠ 反例（钉死 96）必须被判据抓住')
  assert.throws(
    () => assert.deepEqual(planViolations(nailed), [], '档宽必须落在目标带内'),
    /档宽必须落在目标带内/,
    '⚠ 反例注入（钉死 96）必须让断言失败',
  )
  // 端到端：`chipSeriesOf` 回包里的 bucketWidth 必须等于区间 ÷ 档数（不是另算一个数）
  const r = chipSeriesOf(barsOf(200, 100, 20), { fqSupported: true, floatMv: 1e10, window: 200, display: 45, minSamples: 1 })
  const span = Math.max(...r.days.map((d) => d.centers[d.centers.length - 1])) - Math.min(...r.days.map((d) => d.centers[0]))
  assert.ok(r.bucketWidth !== null && Math.abs(r.bucketWidth - span / r.bucketCount) < 0.02, `档宽必须 = 区间/档数（实际 ${r.bucketWidth} vs ${span / r.bucketCount}）`)
})

// ── ③ 档数上下限生效 ───────────────────────────────────────────────────────

test('③ 上下限生效：极窄区间夹到下限、极宽区间夹到上限（都留痕）', () => {
  const tiny = planBuckets({ low: 10, high: 10.01, displayDays: 45 })
  assert.equal(tiny.buckets, CHIPS_BUCKETS_AUTO_MIN, '极窄区间 ⇒ 下限 48')
  assert.equal(tiny.clamped, 'min')
  assert.ok(tiny.note !== null && tiny.note.includes('下限'), `下限夹取必须留痕（${tiny.note}）`)
  const huge = planBuckets({ low: 1, high: 100000, displayDays: 45 })
  assert.ok(huge.buckets <= CHIPS_BUCKETS_AUTO_MAX, `极宽区间档数必须 ≤ ${CHIPS_BUCKETS_AUTO_MAX}（实际 ${huge.buckets}）`)
  assert.ok(huge.clamped === 'max' || huge.clamped === 'payload', `极宽区间必须留痕（${huge.clamped}）`)
  assert.ok(huge.note !== null && (huge.note.includes('上限') || huge.note.includes('预算')), `上限夹取必须留痕（${huge.note}）`)
  // 档数**上限**要在展示天数少时直接生效（体积预算 ÷ 展示 10 天 = 1092 > 384 ⇒ 由档数上限接住）
  const bigMax = planBuckets({ low: 1, high: 100000, displayDays: 10 })
  assert.equal(bigMax.buckets, CHIPS_BUCKETS_AUTO_MAX, `档数上限必须生效（实际 ${bigMax.buckets}）`)
  assert.equal(bigMax.clamped, 'max')
  assert.ok(bigMax.note !== null && bigMax.note.includes('上限'), `档数上限必须留痕（${bigMax.note}）`)
  // 判据 + 反例注入：去掉上限（直接把 want 当档数）⇒ 越界必败
  const judge = (p: { buckets: number }): boolean => p.buckets <= CHIPS_BUCKETS_AUTO_MAX
  assert.equal(judge(huge), true, '正例：上限生效')
  const unbounded = { buckets: Math.round((100000 - 1) / (50000.5 * CHIPS_WIDTH_TARGET_PCT)) }
  assert.ok(unbounded.buckets > CHIPS_BUCKETS_AUTO_MAX, '⚠ 反例（去掉上限）确实超过上限')
  assert.throws(
    () => assert.equal(judge(unbounded), true, `档数必须 ≤ ${CHIPS_BUCKETS_AUTO_MAX}`),
    new RegExp(`档数必须 ≤ ${CHIPS_BUCKETS_AUTO_MAX}`),
    '⚠ 反例注入（去掉上限）必须让断言失败',
  )
  // 显式档数仍走既有语义（范围夹取 + 留痕），且不参与自适应
  const explicit = planBuckets({ low: 10, high: 20, displayDays: 45, explicit: 96 })
  assert.equal(explicit.buckets, 96, '显式 96 ⇒ 原样（不改成自适应值）')
  assert.equal(explicit.clamped, null)
  const explicitHi = planBuckets({ low: 10, high: 20, displayDays: 45, explicit: 9999 })
  assert.equal(explicitHi.buckets, CHIPS_BUCKETS_MAX, `显式越界 ⇒ 夹到 ${CHIPS_BUCKETS_MAX}`)
  assert.ok(explicitHi.note !== null && explicitHi.note.includes('夹到'), '显式越界也要留痕')
})

// ── ④ 回包字节有上界 ───────────────────────────────────────────────────────

test('④ 回包字节有上界（预算先撞上时降档数并留痕）', () => {
  // 与实测最坏样本同形：高价股（centers 串长）+ 长窗口 + 展示上限 60 天
  const bars = barsOf(1200, 1450, 300)
  const r = chipSeriesOf(bars, { fqSupported: true, floatMv: 1.6e12, window: 1200, display: 60, minSamples: 1 })
  const bytes = JSON.stringify({ secid: '1.600519', ...r, missing: [] }).length
  assert.ok(bytes <= CHIPS_PAYLOAD_MAX_BYTES, `回包 ${bytes} B 必须 ≤ 预算 ${CHIPS_PAYLOAD_MAX_BYTES} B`)
  assert.equal(r.bucketClamped, 'payload', `展示 60 天 + 宽区间 ⇒ 预算应当是先撞上的那道（实际 ${r.bucketClamped}）`)
  assert.ok(r.bucketNote !== null && r.bucketNote.includes('预算'), `降档必须留痕（${r.bucketNote}）`)
  // 判据 + 反例注入：去掉预算（按目标档宽放开到上限）⇒ 字节必超预算
  const judge = (b: number): boolean => b <= CHIPS_PAYLOAD_MAX_BYTES
  const unbounded = chipSeriesOf(bars, { fqSupported: true, floatMv: 1.6e12, window: 1200, display: 60, minSamples: 1, buckets: CHIPS_BUCKETS_AUTO_MAX })
  const unboundedBytes = JSON.stringify({ secid: '1.600519', ...unbounded, missing: [] }).length
  assert.equal(judge(bytes), true, '正例：预算生效')
  assert.ok(unboundedBytes > CHIPS_PAYLOAD_MAX_BYTES, `⚠ 反例（去掉预算）确实超预算：${unboundedBytes} > ${CHIPS_PAYLOAD_MAX_BYTES}`)
  assert.throws(
    () => assert.equal(judge(unboundedBytes), true, `回包必须 ≤ ${CHIPS_PAYLOAD_MAX_BYTES} B`),
    /回包必须 ≤/,
    '⚠ 反例注入（去掉回包预算）必须让断言失败',
  )
})

// ── ⑤ 夹取必须出现在界面（不许静默变粗）────────────────────────────────────

test('⑤ 夹取时界面必须能读到「窗口 N 天 · 档数 M · 档宽 X 元」+ 夹取说明', () => {
  const line = bucketCaliberOf({ window: 805, bucketCount: 242, bucketWidth: 2.2913 })
  assert.equal(line, '窗口 805 天 · 档数 242 · 档宽 2.2913 元')
  assert.ok(/窗口 \d+ 天 · 档数 \d+ · 档宽 [\d.]+ 元/.test(line), '元组形状：窗口 N 天 · 档数 M · 档宽 X 元')
  assert.equal(bucketCaliberOf({ window: 45, bucketCount: 96, bucketWidth: null }), '窗口 45 天 · 档数 96 · 档宽 —', '档宽缺失 ⇒ —（不是 0）')
  // 正常情况下**不出**偏离行（一个字都不显示）
  const pinned = planBuckets({ low: 1160.6, high: 1740.5, displayDays: 45 })
  assert.equal(
    caliberDeviates({ decay: 'turnover', decayReason: null, fqSupported: true, why: null, samples: 805, window: 805, bucketNote: null }),
    null, '没夹取、口径没偏离 ⇒ 零文案',
  )
  // 夹取 ⇒ 那一行**必须**带上说明（可见）：必须写明"分辨率比目标粗"这件事
  const shown = caliberDeviates({ decay: 'turnover', decayReason: null, fqSupported: true, why: null, samples: 805, window: 805, bucketNote: pinned.note ?? '（应有说明）' })
  const judgeNote = (row: string | null): boolean => row !== null && /粗|夹|降到/.test(row) && row.includes('档')
  assert.equal(judgeNote(shown), true, `夹取说明必须可见且写明粗了多少（实际 ${String(shown)}）`)
  // 与其它偏离并存时也要带上（拼接，不是二选一）
  const both = caliberDeviates({ decay: 'half-life', decayReason: '港股回落半衰期', fqSupported: true, why: null, samples: 800, window: 805, bucketNote: pinned.note })
  assert.ok(typeof both === 'string' && both.includes('半衰期') && both.includes('⚠'), `夹取说明必须与其它偏离并存（实际 ${String(both)}）`)
  // 反例注入：夹住了却把说明丢掉（= 静默变粗）⇒ 判据必败
  const silent = caliberDeviates({ decay: 'turnover', decayReason: null, fqSupported: true, why: null, samples: 805, window: 805, bucketNote: null })
  assert.equal(judgeNote(silent), false, '⚠ 反例（静默夹取）确实被判据判为不合格')
  assert.throws(
    () => assert.equal(judgeNote(silent), true, '夹取时界面必须出现档数/档宽标注'),
    /夹取时界面必须出现档数\/档宽标注/,
    '⚠ 反例注入（静默夹取）必须让断言失败',
  )
  // 接线：面板必须把 bucketNote 传给那一行、并把元组塞进悬停（源码级 + 注入）
  const panel = readFileSync(join(here, '..', 'client', 'ChipsPanel.tsx'), 'utf8')
  assert.ok(panel.includes('bucketNote: d.bucketNote ?? null'), '面板必须把宿主给的夹取说明接进那一行')
  assert.ok(panel.includes('bucketCaliberOf({ window: d.window'), '面板必须渲染“窗口/档数/档宽”元组')
  const cut = panel.replace('bucketNote: d.bucketNote ?? null', 'bucketNote: null')
  assert.notEqual(cut, panel, '反例注入必须真改到源码')
  assert.throws(
    () => assert.equal(cut.includes('bucketNote: d.bucketNote ?? null'), true, '面板必须传 bucketNote'),
    /面板必须传 bucketNote/,
    '⚠ 反例注入（面板丢掉夹取说明）必须让断言失败',
  )
})

// ── ⑥ 既有语义回归（同一输入下与改造前一致，差异有界）──────────────────────

test('⑥ 既有语义不变：P5/P95、盈利比例、display 映射与改造前同源（差异 ≤ 一个粗档）', () => {
  const bars = barsOf(400, 100, 30)
  // ⚠ 必须给现价：否则 `profitRatio` 两侧都是 null，"null − null = 0"会让这条断言变成空跑
  const opts = { fqSupported: true, floatMv: 1e10, price: 104, priceSource: 'quote' as const, window: 400, display: 45, minSamples: 1 }
  const before = chipSeriesOf(bars, { ...opts, buckets: 96 })      // 改造前的固定档数
  const after = chipSeriesOf(bars, opts)                            // 自适应
  assert.ok(after.bucketCount !== 96, `自适应档数应当不同于 96（实际 ${after.bucketCount}）`)
  // 展示窗口与逐日结构不变
  assert.equal(after.days.length, before.days.length, '展示天数（display=45 映射）不变')
  assert.equal(after.days.length, 45)
  assert.equal(after.latest?.date, before.latest?.date, '最新展示日不变')
  assert.equal(after.displayWindow, before.displayWindow)
  assert.equal(after.barAlignsWithDisplay, before.barAlignsWithDisplay)
  // P5/P95/均价：允许的差异 = **改造前那套格子的一个档宽**（合并差异的物理上限）
  const coarse = (Math.max(...bars.map((b) => b.close)) - Math.min(...bars.map((b) => b.close))) / 96
  for (const k of ['avgCost', 'support', 'resistance'] as const) {
    const a = before[k] as number | null
    const b2 = after[k] as number | null
    assert.ok(a !== null && b2 !== null, `${k} 两侧都必须算得出`)
    assert.ok(Math.abs(a - b2) <= coarse, `${k} 差异必须 ≤ 一个粗档宽 ${coarse.toFixed(4)}（实际 ${Math.abs(a - b2).toFixed(4)}）`)
  }
  // 盈利比例：**两侧都必须真的算出来**（null 会让差异断言空跑），方向与量级不变（实测远小于 5pp）
  const pa = before.profitRatio
  const pb = after.profitRatio
  assert.ok(typeof pa === 'number' && typeof pb === 'number', `盈利比例两侧都必须算得出（旧 ${String(pa)} / 新 ${String(pb)}）`)
  assert.ok(Math.abs(pa - pb) <= 5, `盈利比例差异必须 ≤ 5pp（实际 ${Math.abs(pa - pb).toFixed(2)}pp）`)
  assert.ok(Math.abs(pa - pb) < 1, `实测差异应远小于上限（实际 ${Math.abs(pa - pb).toFixed(3)}pp）`)
  // 权重守恒与逐日序列（口径未动）
  for (const d of after.days) {
    const sum = d.buckets.reduce((s, x) => s + x, 0)
    assert.ok(Math.abs(sum - 1) < 1e-6, `权重仍守恒（实际 ${sum}）`)
    assert.equal(d.buckets.length, after.bucketCount, '每天都是同一档数')
    assert.equal(d.centers.length, after.bucketCount)
  }
  // 颜色规则的自变量（price / profitRatio）逐日给出且与 profitRatio 同源
  for (const d of after.days) {
    assert.equal(typeof d.price === 'number' || d.price === null, true)
    assert.equal(typeof d.profitRatio === 'number' || d.profitRatio === null, true)
  }
})
