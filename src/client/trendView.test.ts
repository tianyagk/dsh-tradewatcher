/**
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { normalizeTrendSeries, trendDayCount, type TrendPoint } from '../shared/model.ts'
import { plausibleAvgs, chartDomain, isUsableBaseline, hasVolumeSeries, isUsableAvg, trendDayAxis, trendScale } from './trendView.ts'

const prices = [4274.05, 4287.4, 4290.72, 4302.99]

test('y 轴域：只有价格、没有均价/量的序列 ⇒ 域等于价格域（不得从 0 起）', () => {
  const { lo, hi } = trendScale(prices, [null, null, null, null])
  assert.ok(lo > 4000, `下界必须贴着价格（实际 ${lo}）—— 从 0 起会把走势压成平线`)
  assert.ok(hi > 4302 && hi < 4400, `上界贴价格上沿（实际 ${hi}）`)
  assert.ok(hi - lo < 200, `价格区间只有 ~29，域不该被拉成 4300 那么宽（实际 ${hi - lo}）`)
})

test('y 轴域：均价缺失被回成 0（老宿主）时也不得把域拉到 0', () => {
  // 纵深防御：即使宿主还没升级、avg 仍是 0，客户端也不能把它当真实值域参与计算
  const { lo } = trendScale(prices, [0, 0, 0, 0])
  assert.ok(lo > 4000, `0 不是有效 VWAP，不能进坐标域（实际下界 ${lo}）`)
})

test('y 轴域：有有效均价时均价参与域（均价线必须与价格线可比）', () => {
  const { lo, hi } = trendScale(prices, [4280, 4285, 4288, 4292])
  assert.ok(lo < 4280 && hi > 4302, '域要同时容下价格与均价')
  // 昨收基准线也要容得下
  const withBase = trendScale(prices, [null, null, null, null], 4310)
  assert.ok(withBase.hi > 4310)
})

test('均价/成交量可用性：null 与 ≤0 一律不算"有"', () => {
  assert.equal(isUsableAvg(null), false)
  assert.equal(isUsableAvg(0), false)
  assert.equal(isUsableAvg(-1), false)
  assert.equal(isUsableAvg(Number.NaN), false)
  assert.equal(isUsableAvg(4287.4), true)
  assert.equal(hasVolumeSeries([null, null, 0]), false, '全无成交量 ⇒ 界面要说"该市场不提供成交量"，不是画一条假量')
  assert.equal(hasVolumeSeries([null, 0, 12]), true, '真的有过成交量 ⇒ 逐个照画（0 是合法的安静分钟）')
})

// ── A 项：宿主回包里的缺失值归一（用实机抓到的 122.XAU 回包做 fixture）──────────

/** 2026-10-09 本机 GET /tradewatcher/trend?secid=122.XAU 的真实点（修复前：全为 0） */
const XAU_RAW: TrendPoint[] = [
  { t: 1790200800000, label: '2026-09-24 06:00', price: 4290.72, avg: 0, vol: 0, amount: 0 },
  { t: 1790200860000, label: '2026-09-24 06:01', price: 4290.72, avg: 0, vol: 0, amount: 0 },
  { t: 1790200920000, label: '2026-09-24 06:02', price: 4290.59, avg: 0, vol: 0, amount: 0 },
  { t: 1790200980000, label: '2026-09-24 06:03', price: 4291.32, avg: 0, vol: 0, amount: 0 },
  { t: 1790201040000, label: '2026-09-24 06:04', price: 4274.05, avg: 0, vol: 0, amount: 0 },
  { t: 1790201100000, label: '2026-09-24 06:05', price: 4302.99, avg: 0, vol: 0, amount: 0 },
]

test('A：实机回包归一后不得再有 avg=0（缺失不许编码成 0），且 y 轴域回到价格域', () => {
  const clean = normalizeTrendSeries(XAU_RAW)
  assert.ok(clean.every((p) => p.avg === null), '均价必须是 null，不能再是 0')
  assert.ok(clean.every((p) => p.vol === null && p.amount === null), '该源不提供量/额 ⇒ 一律 null')
  assert.ok(clean.every((p) => p.price > 4270 && p.price < 4310), '价格本身照常保留（数据没问题）')
  // 归一后：域 = 价格域（不是 0~4303 的假平线）
  const { lo, hi } = trendScale(clean.map((p) => p.price), clean.map((p) => p.avg), 4287.35)
  assert.ok(lo > 4000 && hi < 4400, `域必须贴价格（实际 ${lo} ~ ${hi}）`)
  assert.equal(hasVolumeSeries(clean.map((p) => p.vol)), false, '无量 ⇒ 界面显示"该市场不提供成交量"')
})

test('A：归一按整条序列判量/额（真的有过成交量的序列，0 是合法值，不许被抹掉）', () => {
  const mixed: TrendPoint[] = [
    { t: 1, label: '2026-10-09 09:30', price: 10, avg: 10, vol: 0, amount: 0 },
    { t: 2, label: '2026-10-09 09:31', price: 10.1, avg: 10.05, vol: 1200, amount: 12100 },
  ]
  const clean = normalizeTrendSeries(mixed)
  assert.equal(clean[0].vol, 0, '安静的分钟真的是 0 —— 逐点抹零会把它从"没成交"改成"没数据"')
  assert.equal(clean[1].vol, 1200)
  assert.equal(hasVolumeSeries(clean.map((p) => p.vol)), true)
})

test('B：trendDayCount 如实区分"只有当日"与"真的多日"', () => {
  assert.equal(trendDayCount(XAU_RAW), 1, 'XAU 的 462 个点只覆盖 1 个交易日 ⇒ 五日不可用')
  const twoDays = [
    { label: '2026-10-08 14:59' },
    { label: '2026-10-09 09:30' },
    { label: '2026-10-09 15:00' },
  ]
  assert.equal(trendDayCount(twoDays), 2)
  assert.equal(trendDayCount([]), 0)
})

// ── 五日：底部"按天"轴（读不出天 = 看不懂图）──────────────────────────────────

/** 造 n 天的点：每天 `perDay` 个，label 形如 `2026-10-0X 09:3X` */
const multiDay = (days: string[], perDay: number): Array<{ label: string }> =>
  days.flatMap((d) => Array.from({ length: perDay }, (_, i) => ({ label: `${d} 09:${String(i).padStart(2, '0')}` })))

test('按天轴：3 天 3 个标签，且标签落在各自区段中间（第一天也有）', () => {
  const pts = multiDay(['2026-09-28', '2026-09-29', '2026-09-30'], 4)
  const { segments, labels } = trendDayAxis(pts, 5)
  assert.equal(segments.length, 3)
  assert.deepEqual(segments.map((x) => x.startIndex), [0, 4, 8], '每天第一个点的下标')
  assert.deepEqual(segments.map((x) => x.endIndex), [3, 7, 11])
  assert.deepEqual(labels.map((x) => x.text), ['09-28', '09-29', '09-30'], '第一天必须有标签（此前 brk<=0 被跳过）')
  for (const seg of labels) {
    const center = (seg.startIndex + seg.endIndex) / 2
    assert.equal(center, Math.floor(center) + 0.5, '区段中心落在两点之间 ⇒ 标签居中')
  }
  assert.equal(segments[0].startIndex, 0, '第一天从 0 开始（调用方据此不画左端分隔线）')
})

test('按天轴：只有 1 天（或空）⇒ 返回空，走原来的时间轴', () => {
  assert.deepEqual(trendDayAxis(multiDay(['2026-10-09'], 5), 5), { segments: [], labels: [] })
  assert.deepEqual(trendDayAxis([], 5), { segments: [], labels: [] })
})

test('按天轴：天数超过可容纳数时均匀抽样，且首末必留', () => {
  const days = ['2026-09-25', '2026-09-28', '2026-09-29', '2026-09-30', '2026-10-08', '2026-10-09', '2026-10-10', '2026-10-13']
  const pts = multiDay(days, 3)
  const { segments, labels } = trendDayAxis(pts, 5)
  assert.equal(segments.length, 8, '分隔线用全部 8 天')
  assert.equal(labels.length, 5, '标签只放得下 5 个')
  assert.equal(labels[0].day, days[0], '首个必留')
  assert.equal(labels[labels.length - 1].day, days[days.length - 1], '末个必留')
  // 均匀：相邻被选中的段间隔最多差 1
  const idx = labels.map((l) => segments.indexOf(l))
  const gaps = idx.slice(1).map((v, i) => v - idx[i])
  assert.ok(Math.max(...gaps) - Math.min(...gaps) <= 1, `抽样要均匀（实际间隔 ${gaps.join(',')}）`)
  // 容量为 1 时也不崩：首末只能留一个 ⇒ 至少留一个，且是首或末
  const one = trendDayAxis(pts, 1)
  assert.equal(one.labels.length, 1)
})

test('按天轴：标签文本等于该天点里的 label 前缀（不许自己造日期）', () => {
  // 故意让 label 的日期与"外部传入的日期"不一致：标签只能来自 label
  const pts = [
    { label: '2026-10-07 09:30' }, { label: '2026-10-07 09:31' },
    { label: '2026-10-09 09:30' }, { label: '2026-10-09 09:31' },
  ]
  const { labels } = trendDayAxis(pts, 5)
  assert.deepEqual(labels.map((x) => x.text), ['10-07', '10-09'])
  assert.deepEqual(labels.map((x) => x.day), ['2026-10-07', '2026-10-09'])
  // label 太短时留空（不是"猜一个日期"）
  const shortPts = [{ label: 'x' }, { label: 'y' }, { label: '2026-10-09 09:30' }, { label: '2026-10-09 09:31' }]
  assert.equal(trendDayAxis(shortPts, 5).labels[0].text, '')
})

test('基准 0 ⇒ 域等于价格域、虚线不画（指数卡片被压成平线的那个 bug）', () => {
  const values = [3990, 3995, 4002, 3988, 4006]
  const d = chartDomain(values, 0)
  assert.equal(d.baselineY, null, '基准 0 不是有效基准：虚线不画')
  // 域必须只由价格决定（上下各 6% 呼吸位）
  const min = Math.min(...values)
  const max = Math.max(...values)
  assert.ok(Math.abs(d.lo - (min - (max - min) * 0.06)) < 1e-6, `lo 应为纯价格域：${d.lo}`)
  assert.ok(Math.abs(d.hi - (max + (max - min) * 0.06)) < 1e-6, `hi 应为纯价格域：${d.hi}`)
  assert.ok(d.lo > 3900, '不许把 0 并进域（那就是 0~4000 的平线）')
})

test('基准为负 / NaN / null / undefined ⇒ 一律按不可用（域=价格域，虚线不画）', () => {
  const values = [10, 12, 11]
  for (const bad of [-1, Number.NaN, null, undefined, 0]) {
    const d = chartDomain(values, bad as number | null | undefined)
    assert.equal(d.baselineY, null, `基准 ${String(bad)} 应视为不可用`)
    assert.ok(d.lo >= 10 - 12 * 0.06 - 1e-9 && d.hi <= 12 + 12 * 0.06 + 1e-9, `域不该被 ${String(bad)} 拉宽`)
  }
  assert.equal(isUsableBaseline(0), false)
  assert.equal(isUsableBaseline(-3), false)
  assert.equal(isUsableBaseline(Number.NaN), false)
  assert.equal(isUsableBaseline(null), false)
  assert.equal(isUsableBaseline(12.5), true)
})

test('基准正常（区间内 / 区间外）⇒ 域包含基准，虚线落在对应位置', () => {
  const inside = chartDomain([10, 12, 11], 11.5)
  assert.ok(inside.lo < 11.5 && inside.hi > 11.5, '基准在域里')
  assert.ok(inside.baselineY !== null && inside.baselineY > 0 && inside.baselineY < 1)
  // 基准在价格区间之外：域被撑到包含它，虚线落在靠近上/下边界处（呼吸位使其不正好是 0/1）
  const above = chartDomain([10, 12, 11], 20)
  assert.ok(above.hi > 20, '基准在价格上方 ⇒ 域要包含它')
  assert.ok(above.baselineY !== null && above.baselineY < 0.15, `虚线应贴着上边：${above.baselineY}`)
  const below = chartDomain([10, 12, 11], 2)
  assert.ok(below.lo < 2)
  assert.ok(below.baselineY !== null && below.baselineY > 0.85, `虚线应贴着下边：${below.baselineY}`)
})

test('回归：指数在 3990 附近波动 + 基准为 0 ⇒ 域宽度接近波动幅度，不许变成 0~4000', () => {
  const values = Array.from({ length: 60 }, (_, i) => 3990 + Math.sin(i / 4) * 12)
  const d = chartDomain(values, 0)
  const width = d.hi - d.lo
  assert.ok(width < 60, `域宽度应约为 24±呼吸位，实际 ${width.toFixed(2)}`)
  assert.ok(d.lo > 3900 && d.hi < 4100, `域应贴着 3990 附近，实际 ${d.lo.toFixed(1)}~${d.hi.toFixed(1)}`)
  // 对照：若把 0 当有效基准，域会变成 ~3990 宽（平线的成因）
  const wrong = chartDomain(values, 1e-9)
  assert.ok(wrong.hi - wrong.lo > 3000, '（对照）把极小值当基准就会拉宽域 —— 所以判据必须是 > 0 且有限')
})

test('大图（trendScale）与缩略图（chartDomain）对基准 0 的处理一致', () => {
  const values = [3990, 3995, 4002]
  const big = trendScale(values, [], 0)
  const small = chartDomain(values, 0)
  assert.ok(big.lo > 3900 && big.hi < 4100, `大图也不许把 0 并进域：${big.lo}~${big.hi}`)
  assert.ok(small.lo > 3900, '缩略图同上')
  // 正常基准时两者都包含基准
  assert.ok(trendScale(values, [], 4005).hi > 4005)
  assert.ok(chartDomain(values, 4005).hi > 4005)
})

test('回归（真机那组）：上证指数价格 ~3755–3824 + avg 恒为 ~15 ⇒ 域=价格域、均线不画', () => {
  // 本机运行实例回包实测：1.000001 price[3755.05,3824.07] / avg[15.15,17.05]（量纲不同）
  const values = [3755.05, 3790.4, 3812.3, 3824.07, 3801.6]
  const avgs = [15.15, 16.02, 16.5, 17.05, 16.4]
  const cleaned = plausibleAvgs(values, avgs)
  assert.deepEqual(cleaned, [null, null, null, null, null], '越界均价必须**逐点**置 null')
  const { lo, hi } = trendScale(values, avgs, null)
  const min = 3755.05
  const max = 3824.07
  assert.ok(Math.abs(lo - (min - (max - min) * 0.06)) < 1e-6, `域下界应等于价格域：${lo}`)
  assert.ok(Math.abs(hi - (max + (max - min) * 0.06)) < 1e-6, `域上界应等于价格域：${hi}`)
  assert.ok(lo > 3700, `域下界必须 > 3700（不许把 15 并进来）：${lo}`)
  assert.ok(hi - lo < 100, `域宽应约 75（价格波动 + 呼吸位），实际 ${(hi - lo).toFixed(2)}`)
  // 均线路径：清理后没有任何可信点 ⇒ 折线不画（不是画一条贴底的线）
  assert.equal(cleaned.some((v) => v !== null), false)
})

test('正常市场：均价落在价格区间内 ⇒ 保留、参与域、折线可画', () => {
  const values = [100, 101, 102, 103]
  const avgs = [100.5, 101.2, 101.8, 102.4]
  const cleaned = plausibleAvgs(values, avgs)
  assert.deepEqual(cleaned, avgs, '区间内的均价原样保留')
  const { lo, hi } = trendScale(values, avgs, null)
  assert.ok(lo <= Math.min(...avgs) && hi >= Math.max(...avgs), '域包含均价')
})

test('边界：恰在 lo*0.98 / hi*1.02 之内保留，之外拒绝（±2% 容差）', () => {
  const values = [100, 110]
  const lo = 100 * 0.98      // 98
  const hi = 110 * 1.02      // 112.2
  const cleaned = plausibleAvgs(values, [lo, hi, lo - 0.01, hi + 0.01])
  assert.equal(cleaned[0], lo, '恰在下界上 ⇒ 保留')
  assert.equal(cleaned[1], hi, '恰在上界上 ⇒ 保留')
  assert.equal(cleaned[2], null, '刚越过下界 ⇒ 拒绝')
  assert.equal(cleaned[3], null, '刚越过上界 ⇒ 拒绝')
})

test('部分越界逐点过滤（114.LHM 那种形态）：正常的点照旧、坏的点置 null', () => {
  // 实测 114.LHM price[10345,10570] / avg[0,10558.7] ⇒ 前半段是 0（已被 isUsableAvg 挡），后半段正常
  const values = [10345, 10400, 10500, 10570]
  const avgs = [0, 10405.2, 10498.7, 10560.1]
  const cleaned = plausibleAvgs(values, avgs)
  assert.deepEqual(cleaned, [null, 10405.2, 10498.7, 10560.1], '只丢坏点，不整条丢掉')
})

test('反向保护：isUsableAvg 的语义不变（正数即有效），区间校验只是叠在它之上', () => {
  assert.equal(isUsableAvg(0), false, '0 仍是缺失（老宿主可能回 0）')
  assert.equal(isUsableAvg(-1), false)
  assert.equal(isUsableAvg(1e-9), true, '正数仍算"有值"——区间校验由 plausibleAvgs 负责')
  assert.equal(isUsableAvg(Number.NaN), false)
  // 价格序列为空时，一切均价都视为不可信（没有区间可依据）
  assert.deepEqual(plausibleAvgs([], [1, 2]), [null, null])
})
