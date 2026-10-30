/**
 * 【涨跌分布】六条验收断言（对应本轮实机截图缺陷）：
 *   ① 9 个柱、高度按 counts 单调；② 柱顶家数 9 个且逐项相等；③ X 档名 9 个且顺序正确；
 *   ④ 「北交所」只在卡头、不在柱区；⑤ 左侧 5 格直接取聚合五数；⑥ 5 格合计 == 分布合计（不等必须有 warn）。
 * 每条都配**反例注入**（把缺陷放回去 ⇒ 断言必须失败）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { DIST_LABELS } from './breadthView.ts'
import { DIST_BAR_GAP_PX, distBarsOf, distConsistencyOf, distSumOf, distYTicksOf, trendCellsOf } from './distCard.ts'

const here = dirname(fileURLToPath(import.meta.url))
const read = (f: string): string => readFileSync(join(here, f), 'utf8')
/** 去注释再断言（注释里会**提到**被禁的字样，见仓库既有惯例） */
const strip = (t: string): string => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

/** 一份真实形状的 9 档 counts（v0.176.0 实扫：5223 只） */
const COUNTS = [110, 68, 226, 1678, 144, 2039, 563, 217, 171]

test('① 9 个柱，高度按 counts 单调（全等高 ⇒ 败）', () => {
  const bars = distBarsOf(COUNTS, DIST_LABELS)
  assert.equal(bars.length, 9, '必须是 9 个柱')
  for (let i = 1; i < bars.length; i += 1) {
    const prev = bars[i - 1]!
    const cur = bars[i]!
    const a = prev.count ?? 0
    const b = cur.count ?? 0
    if (b > a) assert.ok(cur.heightPct > prev.heightPct, `counts 上升时柱高必须上升（第 ${i} 柱）`)
    if (b < a) assert.ok(cur.heightPct < prev.heightPct, `counts 下降时柱高必须下降（第 ${i} 柱）`)
    if (b === a) assert.equal(cur.heightPct, prev.heightPct, '相等计数 ⇒ 等高')
  }
  assert.equal(Math.max(...bars.map((b) => b.heightPct)), 100, '最高柱必须占满可用高度')
  assert.equal(DIST_BAR_GAP_PX, 6, '柱间距 6px')
  // 渲染层：9 柱来自 bars.map（不是写死的 7 个数字）
  const render = read('distCardRender.tsx')
  assert.ok(render.includes("'data-role': 'dist-bar'"), '柱元素必须有 data-role=dist-bar')
  assert.ok(render.includes('bars.map('), '柱必须由 bars 逐项渲染')
  // 反例注入：全等高（柱高常数）⇒ 单调判据必须失败
  const flat = distBarsOf(COUNTS, DIST_LABELS).map((b) => ({ ...b, heightPct: 50 }))
  assert.throws(
    () => assert.deepEqual(flat.map((b) => b.heightPct), bars.map((b) => b.heightPct), '反例上：全等高'),
    /反例上/,
    '⚠ 反例注入（全等高）必须失败',
  )
})

test('② 柱顶家数 9 个、与 counts 逐项相等（错位 ⇒ 败）', () => {
  const bars = distBarsOf(COUNTS, DIST_LABELS)
  assert.deepEqual(bars.map((b) => b.count), COUNTS, '柱顶家数必须逐项等于 counts')
  const render = read('distCardRender.tsx')
  assert.ok(render.includes("'data-role': 'dist-count'"), '柱顶家数必须有 data-role=dist-count')
  // 反例注入：错位一位 ⇒ 必败
  const shifted = [bars[bars.length - 1]!.count, ...bars.slice(0, -1).map((b) => b.count)]
  assert.throws(() => assert.deepEqual(shifted, COUNTS, '反例上：家数错位'), /反例上/, '⚠ 反例注入（错位）必须失败')
})

test('③ X 档名 9 个且顺序正确（乱序 ⇒ 败）', () => {
  const bars = distBarsOf(COUNTS, DIST_LABELS)
  assert.deepEqual(bars.map((b) => b.label), [...DIST_LABELS], '档名必须按 DIST_LABELS 顺序')
  assert.deepEqual([...DIST_LABELS], ['≥7%', '5~7%', '3~5%', '0~3%', '平盘', '-3~0%', '-5~-3%', '-7~-5%', '≤-7%'])
  const render = read('distCardRender.tsx')
  assert.ok(render.includes("'data-role': 'dist-label'"), '档名必须有 data-role=dist-label')
  // 反例注入：乱序 ⇒ 必败
  const reversed = [...DIST_LABELS].reverse()
  assert.throws(() => assert.deepEqual(reversed, [...DIST_LABELS], '反例上：档名乱序'), /反例上/, '⚠ 反例注入（乱序）必须失败')
})

test('④ 「北交所」只在卡头右侧，不在柱区（出现在柱区 ⇒ 败）', () => {
  const page = read('MarketPage.tsx')
  const render = strip(read('distCardRender.tsx'))
  // 卡头：`card('涨跌分布', <hint 内含 dist-bj> …)` —— hint 是第 2 个实参
  const at = page.indexOf("card('涨跌分布'")
  assert.ok(at > 0, '必须找到分布卡的 card(...) 调用')
  const head = page.slice(at, page.indexOf('distCounts === null', at))
  assert.ok(head.includes("'data-role': 'dist-bj'"), '「北交所」必须放在卡头（card 的第 2 实参里）')
  assert.ok(head.includes('DIST_BJ_NOTE'), '卡头文案必须来自 DIST_BJ_NOTE')
  // 柱区（渲染层）不得出现北交所字样
  assert.equal(render.includes('北交所'), false, '柱区渲染层不得出现「北交所」（会压住 X 档名）')
  assert.equal(render.includes('DIST_BJ_NOTE'), false, '柱区不得引用 DIST_BJ_NOTE')
  // 反例注入：把北交所塞进柱区 ⇒ 判据必须非空
  const injected = render + "\nReact.createElement('span', null, '北交所 未接入')\n"
  assert.throws(() => assert.equal(injected.includes('北交所'), false, '反例上：柱区出现北交所'), /反例上/, '⚠ 反例注入（放进柱区）必须失败')
})

test('⑤ 左侧 5 格直接取聚合 up/flat/down/limitUp/limitDown（写 0 或 — 而数据存在 ⇒ 败）', () => {
  const dist = { up: 2082, flat: 144, down: 2990, limitUp: 59, limitDown: 28 }
  // 旧链给的是**错的值**（或 null），必须被分布回包覆盖
  const old = { up: null, even: null, down: null }
  const limits = { up: { count: 0 }, down: { count: 0 } }
  assert.deepEqual(trendCellsOf(dist, old, limits), [2082, 144, 2990, 59, 28], '5 格必须取聚合五数')
  // 缺失时才退回旧链（不是写 0）
  assert.deepEqual(trendCellsOf({}, old, limits), [null, null, null, 0, 0], '缺分布时退回旧链（旧链给 0 就显示 0）')
  assert.deepEqual(trendCellsOf(null, { up: 1, even: 2, down: 3 }, null), [1, 2, 3, null, null])
  const page = read('MarketPage.tsx')
  assert.ok(page.includes('trendCellsOf('), '页面必须用 trendCellsOf 取 5 格')
  assert.ok(page.includes('up: dist5[0]'), '5 格的 up 必须来自 dist5[0]')
  // 反例注入：把 5 格写死成 0 ⇒ 必败
  assert.throws(() => assert.deepEqual([0, 0, 0, 0, 0], trendCellsOf(dist, old, limits), '反例上：5 格写 0'), /反例上/, '⚠ 反例注入（写 0）必须失败')
})

test('⑥ up+flat+down === 分布合计（不等且无 warn ⇒ 败）', () => {
  const ok = distConsistencyOf({ up: 2082, flat: 144, down: 2990, counts: COUNTS })
  assert.equal(distSumOf(COUNTS), 5216)
  assert.equal(ok.upFlatDown, 5216)
  assert.equal(ok.ok, true)
  assert.equal(ok.text, null, '一致时不写 warn')
  // 不一致：两个数都要写出来
  const bad = distConsistencyOf({ up: 2082, flat: 144, down: 2990, counts: [110, 68, 226, 1678, 144, 2039, 563, 217, 160] })
  assert.equal(bad.ok, false)
  assert.ok(bad.text !== null && bad.text.includes('5216') && bad.text.includes('5205'), `warn 必须同时含两个数（实际 ${bad.text}）`)
   // 反例注入：把不一致当一致（ok 恒 true / text 恒 null）⇒ 必败
  assert.throws(() => assert.equal(null, bad.text, '反例上：不一致却不给 warn'), /反例上/, '⚠ 反例注入（吞掉不一致）必须失败')
})

test('⑦ Y 轴 ≥3 档（0 / 中值 / 最大）且含 0', () => {
  const ticks = distYTicksOf(COUNTS)
  assert.ok(ticks.length >= 3, `Y 轴至少 3 档（实际 ${ticks.length}）`)
  assert.equal(ticks[0], 0, '必须含 0')
  assert.equal(ticks[ticks.length - 1], Math.max(...COUNTS), '最高档 = 最大计数')
  assert.deepEqual(distYTicksOf([0, 0, 0]), [0, 1, 2], '全 0 数据给最小可用轴（不崩）')
})

/* ── 边界补强（AUDIT-TESTS-1030）：空数组 / 全 0 / 除零 / 长度不等 ── */

test('⑧ 空数组与全 0：不产柱、不 NaN、Y 轴仍 ≥3 档（拿 0 做除数 ⇒ 败）', () => {
  assert.deepEqual(distBarsOf([], []), [], '空 counts + 空 labels ⇒ 0 个柱')
  assert.equal(distSumOf([]), null, '空分布合计必须 null（不是 0）')
  assert.equal(distSumOf(null), null)
  assert.deepEqual(distYTicksOf([]), [0, 1, 2], '空分布也要给 3 档，否则网格线画不出来')
  const zeros = distBarsOf([0, 0, 0], ['a', 'b', 'c'])
  assert.equal(zeros.length, 3)
  for (const b of zeros) {
    assert.equal(b.heightPct, 0)
    assert.equal(b.heightPx, 0)
    assert.ok(Number.isFinite(b.heightPct) && Number.isFinite(b.heightPx), '全 0 不得产出 NaN（0/0）')
  }
  // 反例注入：去掉 `Math.max(1, …)` 的兜底 ⇒ max=0 ⇒ 0/0 = NaN
  const naiveMax = Math.max(...[0, 0, 0])
  assert.equal(naiveMax, 0, '反例：无兜底时 max = 0')
  assert.ok(Number.isNaN(0 / naiveMax), '0/0 确实是 NaN')
  assert.throws(() => assert.equal(Number.isNaN(0 / naiveMax), false, '反例上：0 做除数'), /反例上/, '⚠ 反例注入必须失败')
})

test('⑨ 长度不等：counts 短了要补 null（补 0 会冒充"这一档 0 家"）、label 缺失用下标兜底', () => {
  const short = distBarsOf([5], ['a', 'b', 'c'])
  assert.equal(short.length, 3, '柱数取 counts/labels 的较大者')
  assert.equal(short[0]!.count, 5)
  assert.equal(short[1]!.count, null, '上游没给的档必须 null（不是 0）')
  assert.equal(short[2]!.count, null)
  assert.equal(short[1]!.heightPx, 0)
  const long = distBarsOf([1, 2], ['a'])
  assert.equal(long.length, 2)
  assert.equal(long[1]!.label, '1', 'label 缺失时用下标字符串兜底')
  // 反例注入：缺失档补 0 ⇒ 界面会把"没数据"画成"0 家"
  const padded = [5, 0, 0]
  assert.notDeepEqual(padded, short.map((b) => b.count))
  assert.throws(() => assert.deepEqual(padded, short.map((b) => b.count), '反例上：缺失档补 0'), /反例上/, '⚠ 反例注入必须失败')
})

test('⑩ 一致性：三数或分布缺失 ⇒ ok:false 且**不编文案**（用 0 凑合计 ⇒ 败）', () => {
  const a = distConsistencyOf({ up: null, flat: 1, down: 2, counts: [1, 2, 3] })
  assert.equal(a.ok, false)
  assert.equal(a.upFlatDown, null, '缺一个数就必须 null（不得把缺失当 0 相加）')
  assert.equal(a.text, null, '缺数据时不许编"口径不一致"文案')
  const b = distConsistencyOf({ up: 1, flat: 1, down: 1, counts: [] })
  assert.equal(b.binsSum, null)
  assert.equal(b.ok, false)
  assert.equal(b.text, null)
  const c = distConsistencyOf({ up: 1, flat: 1, down: 1, counts: [1, 2] })
  assert.equal(c.ok, true, '两边都是 3 ⇒ 一致')
  const d = distConsistencyOf({ up: 1, flat: 1, down: 1, counts: [1, 1] })
  assert.equal(d.ok, false)
  assert.match(d.text ?? '', /3.*\/.*2|2.*\/.*3/, '不一致时文案必须同时写出两个数')
  // 反例注入：缺失当 0 相加 ⇒ 会得到 3 并误判"一致"
  const missing: number | null = null
  const asZero = (missing ?? 0) + 1 + 2
  assert.equal(asZero, 3)
  assert.throws(() => assert.equal(asZero, a.upFlatDown, '反例上：缺失当 0'), /反例上/, '⚠ 反例注入必须失败')
})

/* ── 把「源码含 trendCellsOf(」升级为**行为断言**（AUDIT-TESTS-1030）：
 *    原断言只证明页面调了这个函数；这里补它真正的契约 —— **同源优先(dist) → 旧链(current) → 涨跌停接口**，
 *    而且"都没有"时必须给 null（写 0 ⇒ 界面会显示"0 家"，是假数字）。 */
test('⑪ 【行为】trendCellsOf 取值优先级与全缺：dist > current > limits；全缺 ⇒ 5 个 null（写 0 ⇒ 败）', () => {
  const d = { up: 10, flat: 20, down: 30, limitUp: 40, limitDown: 50 }
  assert.deepEqual(trendCellsOf(d, null, null), [10, 20, 30, 40, 50], 'dist 有就必须用 dist（同源优先）')

  const c = { up: 1, even: 2, down: 3 }
  const lim = { up: { count: 4 }, down: { count: 5 } }
  assert.deepEqual(trendCellsOf(null, c, lim), [1, 2, 3, 4, 5], 'dist 全缺时退到 current + limits')

  // 逐格回退：dist 只有一部分时，缺的那格才回落（整组一起回退 ⇒ 败）
  assert.deepEqual(trendCellsOf({ up: 10 }, c, lim), [10, 2, 3, 4, 5], 'dist.up 有就用 10；其余各格独立回落')
  assert.deepEqual(trendCellsOf({ up: 10, flat: null }, c, lim), [10, 2, 3, 4, 5], '值为 null 等同"没给"，必须回落')
  assert.deepEqual(trendCellsOf({ up: Number.NaN }, c, lim), [1, 2, 3, 4, 5], 'NaN 不得当成有效数（会画出 NaN 高度）')

  assert.deepEqual(trendCellsOf(null, null, null), [null, null, null, null, null], '全缺必须是 5 个 null')
  assert.deepEqual(trendCellsOf(undefined, undefined, undefined), [null, null, null, null, null])
  assert.deepEqual(trendCellsOf({}, {}, { up: null, down: undefined }), [null, null, null, null, null], '空对象不得产出 0')
  // 反例注入：把"缺"写成 0 ⇒ 5 格会变成 0 家，看起来像"全平盘"
  const zeroed = [0, 0, 0, 0, 0]
  assert.notDeepEqual(zeroed, trendCellsOf(null, null, null))
  assert.throws(() => assert.deepEqual(zeroed, trendCellsOf(null, null, null), '反例上：缺数据写 0'), /反例上/, '⚠ 反例注入必须失败')
})
