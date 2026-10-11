/**
 * 位置类指标的断言（52 周区间位置% / 距高低点%）与组合构成的断言。
 * 红线：缺失一律 null + 原因（不用 0/50 冒充）；窗口口径随结果返回；组合权重合计 = 100%±0.01。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { DayBar } from '../shared/model.ts'
import { POSITION_WINDOW, positionLabel, positionOfBars, windowBars } from './position.ts'
import { compositionOf, marketOf } from './composition.ts'

const bars = (n: number, hi: number, lo: number, last = '2026-10-10'): DayBar[] => {
  const out: DayBar[] = []
  for (let i = 0; i < n; i += 1) {
    const d = new Date(Date.parse(`${last}T00:00:00+08:00`) - (n - 1 - i) * 86_400_000)
    const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    out.push({ date, open: lo, close: lo, high: hi, low: lo, vol: null, pct: null })
  }
  return out
}

test('区间位置：0/50/100 三个位置与标签边界', () => {
  const b = bars(60, 200, 100)
  assert.equal(positionOfBars('t', b, 100, { fq: 1, fqSupported: true }).posPct, 0)
  assert.equal(positionOfBars('t', b, 100, { fq: 1, fqSupported: true }).label, '极接近低点')
  assert.equal(positionOfBars('t', b, 150, { fq: 1, fqSupported: true }).posPct, 50)
  assert.equal(positionOfBars('t', b, 150, { fq: 1, fqSupported: true }).label, '区间内')
  assert.equal(positionOfBars('t', b, 200, { fq: 1, fqSupported: true }).posPct, 100)
  assert.equal(positionOfBars('t', b, 200, { fq: 1, fqSupported: true }).label, '极接近高点')
  // 标签边界
  assert.equal(positionLabel(10), '极接近低点')
  assert.equal(positionLabel(30), '接近低点')
  assert.equal(positionLabel(69.99), '区间内')
  assert.equal(positionLabel(70), '接近高点')
  assert.equal(positionLabel(90), '极接近高点')
})

test('距高低点%：低于高点为负、高于低点为正；现价越界时位置夹取但百分比如实', () => {
  const b = bars(60, 200, 100)
  const mid = positionOfBars('t', b, 150, { fq: 1, fqSupported: true })
  assert.ok(Math.abs((mid.fromHighPct ?? 0) - -25) < 1e-9, '距高点 −25%')
  assert.ok(Math.abs((mid.fromLowPct ?? 0) - 50) < 1e-9, '距低点 +50%')
  const over = positionOfBars('t', b, 250, { fq: 1, fqSupported: true })
  assert.equal(over.posPct, 100, '超出窗口高点 ⇒ 位置夹到 100')
  assert.ok((over.fromHighPct ?? 0) > 0, '但距高点%是真实的正数（现价确实高于高点）')
  assert.ok((over.why ?? '').includes('高于窗口最高价'), '越界必须如实说明')
})

test('窗口与样本：口径随结果返回，样本数按窗口内交易日数给', () => {
  const b = bars(300, 200, 100)
  const r = positionOfBars('t', b, 150, { fq: 1, fqSupported: true })
  assert.equal(r.window, POSITION_WINDOW.label, '窗口口径来自单一常量')
  assert.ok((r.samples ?? 0) > 200 && r.samples <= 300, `365 天窗口内应约 250 根（实际 ${r.samples}）`)
  assert.ok(r.from !== null && r.to !== null, '窗口起止日期要给出来（读者才知道样本范围）')
  assert.equal(r.fq, 1, '复权口径随结果返回')
})

test('窗口口径只由常量决定：更短窗口会改变位置与样本数', () => {
  const b = bars(300, 200, 100)
  const wide = positionOfBars('t', b, 150, { fq: 1, fqSupported: true })
  const narrow = positionOfBars('t', b, 150, { fq: 1, fqSupported: true, days: 30 })
  assert.ok(narrow.samples < wide.samples, '窗口越小样本越少')
  assert.equal(narrow.window, POSITION_WINDOW.label, '窗口标签仍来自同一常量（label 描述的是默认窗口）')
  assert.deepEqual(windowBars(b, 30).length, narrow.samples)
})

test('红线：现价缺失 / 样本不足 ⇒ 全部 null + 原因（不是 0% 或 50%）', () => {
  const b = bars(60, 200, 100)
  const noPrice = positionOfBars('t', b, null, { fq: 1, fqSupported: true })
  assert.equal(noPrice.posPct, null)
  assert.notEqual(noPrice.posPct, 0)
  assert.ok((noPrice.why ?? '').includes('现价未取到'))
  const few = positionOfBars('t', bars(1, 200, 100), 150, { fq: 1, fqSupported: true })
  assert.equal(few.posPct, null, '窗口内 <2 根 ⇒ 不给数')
  assert.ok((few.why ?? '').includes('样本不足'))
  const flat = positionOfBars('t', bars(60, 100, 100), 100, { fq: 1, fqSupported: true })
  assert.equal(flat.posPct, null, '最高=最低 ⇒ 无区间可言')
})

test('组合构成：权重合计 100%±0.01，行业拿不到是 —（不许猜）', () => {
  const rows = [
    { id: 'p1', name: 'A', secid: '1.600519', market: marketOf('1.600519'), qty: 100, price: 10, groupName: '白酒' },
    { id: 'p2', name: 'B', secid: '0.300750', market: marketOf('0.300750'), qty: 200, price: 20, groupName: null },
    { id: 'p3', name: 'C', secid: '116.00700', market: marketOf('116.00700'), qty: 50, price: 4, groupName: null },
  ]
  const c = compositionOf(rows)
  const sum = c.rows.reduce((n, r) => n + (r.weightPct ?? 0), 0)
  assert.ok(Math.abs(sum - 100) <= 0.01, `权重合计应为 100%±0.01（实际 ${sum}）`)
  assert.equal(c.rows[0].weightPct !== null, true)
  assert.equal(c.rows[1].sector, null, '分组名没有 ⇒ 行业是 null（界面显示 —）')
  assert.equal(c.rows[0].sector, '白酒', '本地有分组名 ⇒ 直接用（不按代码猜）')
  assert.deepEqual(c.markets.map((m) => m.key), ['A股', '港股'], '市场切片按权重降序（A股 5000 > 港股 200）')
  assert.equal(c.markets.length, 2, '按 shared marketOf 的粒度：A股（沪+深）一片、港股一片')
  assert.ok(c.concentration.hhi > 0 && c.concentration.top1 > 0, '集中度：HHI 与第一大权重')
  // 价格缺失 ⇒ 不参与权重，且如实标注
  const withMissing = compositionOf([...rows, { id: 'p4', name: 'D', secid: '105.TLT', market: marketOf('105.TLT'), qty: 10, price: null, groupName: null }])
  assert.equal(withMissing.rows.length, 4)
  assert.equal(withMissing.rows[3].weightPct, null, '缺价 ⇒ 权重 —（不计入分母）')
  const sum2 = withMissing.rows.reduce((n, r) => n + (r.weightPct ?? 0), 0)
  assert.ok(Math.abs(sum2 - 100) <= 0.01, '缺价的行不进分母，合计仍是 100%±0.01')
  assert.equal(withMissing.unpriced, 1, '缺价条数要如实报')
})

test('市场映射：复用 shared 的确定性映射（沪/深同属 A股，期货与商品同组）', () => {
  assert.equal(marketOf('1.600519'), 'A股')
  assert.equal(marketOf('0.300750'), 'A股')
  assert.equal(marketOf('116.00700'), '港股')
  assert.equal(marketOf('105.TLT'), '美股')
  assert.equal(marketOf('114.lhm'), '期货/商品')
  assert.equal(marketOf('122.XAU'), '期货/商品')
  assert.equal(marketOf('100.SPX'), '国际指数')
  assert.equal(marketOf('999.x'), '其它')
})

test('出处的滞后时长人话化：不编、不写"刚刚"当缺失', async () => {
  const { lagHumanOf } = await import('../shared/model.ts')
  const now = Date.parse('2026-10-11T12:00:00+08:00')
  assert.equal(lagHumanOf(null, now), null, '拿不到时刻 ⇒ null（不编）')
  assert.equal(lagHumanOf(now - 30_000, now), '刚刚')
  assert.equal(lagHumanOf(now - 5 * 60_000, now), '5 分钟前')
  assert.equal(lagHumanOf(now - 3 * 3_600_000, now), '3 小时前')
  assert.equal(lagHumanOf(now - 11 * 86_400_000, now), '11 天前', '报告要求的人话：「11 天前的快照」')
})

test('每股费用影响（P2-6）：总费用 ÷ 数量；数量 0 ⇒ null（不是 Infinity）', async () => {
  const { assemblePortfolio } = await import('./portfolio.ts')
  const led = (qty: number, fee: number) => ({
    id: `e${qty}-${fee}`, ts: 1_700_000_000_000, verb: 'buy' as const, actor: 'web' as const,
    posId: 'p1', groupId: 'g1', qty, price: 10, fee, note: '',
  })
  const groups = [{ id: 'g1', name: '主要持仓', createdAt: 0, archived: false }] as never
  const items = [{ id: 'p1', groupId: 'g1', secid: '1.600519', name: 'X', createdAt: 0 }] as never
  const a = assemblePortfolio(groups, items, [led(100, 30), led(100, 10)] as never, { '1.600519': { secid: '1.600519', price: 20, chg: 0, pct: 0 } } as never)
  const row = a.view.positions[0]
  // 累计买入费用 40 ÷ 200 股 = 0.2 元/股
  assert.equal(row.feePerShare, 0.2, `每股费用（实际 ${String(row.feePerShare)}）`)
  assert.equal(row.feePerShareQty, 200, '分母（数量）也要给出来，便于复核')
  // 数量 0（清仓）⇒ null（不是 Infinity/NaN）
  const b = assemblePortfolio(groups, items, [led(100, 30), led(100, 10), { ...led(200, 0), id: 's1', verb: 'sell' as const }] as never, { '1.600519': { secid: '1.600519', price: 20, chg: 0, pct: 0 } } as never)
  const closed = b.view.positions[0]
  assert.equal(closed.qty, 0)
  assert.equal(closed.feePerShare, null, '数量 0 ⇒ null（界面 —），绝不给 Infinity')
  assert.equal(closed.feePerShareQty, 0)
})
