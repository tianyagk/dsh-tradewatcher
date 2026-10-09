/**
 * 分时图坐标域与均价/成交量可用性的断言（图表 bug 的回归锁）。
 *
 * 缺陷形态：国际指数/外盘商品的分时 `avg/vol/amount` 全被回成 0，
 * 0 作为"真实值"进入 y 轴域 ⇒ 4274~4303 的走势被压进 0~4303 的轴（看着是平线），
 * 成交量窗格的 `max` 又兜底成 1 ⇒ 印出 `成交量 1.00`。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { normalizeTrendSeries, trendDayCount, type TrendPoint } from '../shared/model.ts'
import { hasVolumeSeries, isUsableAvg, trendScale } from './trendView.ts'

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
