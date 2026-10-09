/**
 * 图表光标层的断言：像素→点、卡片摆放、卡片内容（缺失一律 `—`，MA/MACD 与图上同源）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { klineReadout, nearestIndex, timeCell, tipPlacement, trendReadout } from './chartCursor.ts'
import { macd } from './indicators.ts'

test('nearestIndex：两端 / 中点 / 越界 / 空 / 单点都有确定行为', () => {
  const xs = [0, 0.25, 0.5, 0.75, 1]
  const padX = 8
  const innerW = 200
  assert.equal(nearestIndex(padX, xs, padX, innerW), 0, '最左端 ⇒ 第一个点')
  assert.equal(nearestIndex(padX + innerW, xs, padX, innerW), 4, '最右端 ⇒ 最后一个点')
  assert.equal(nearestIndex(padX + innerW * 0.5, xs, padX, innerW), 2, '正中 ⇒ 中点')
  assert.equal(nearestIndex(padX + innerW * 0.3, xs, padX, innerW), 1, '30% ⇒ 最近的 0.25')
  // 越界夹到两端（不返回 -1 / length）
  assert.equal(nearestIndex(padX - 500, xs, padX, innerW), 0, '远在左侧 ⇒ 仍是第一个点')
  assert.equal(nearestIndex(padX + innerW + 500, xs, padX, innerW), 4, '远在右侧 ⇒ 仍是最后一个点')
  // 空 / 单点 / 非法宽度
  assert.equal(nearestIndex(10, [], padX, innerW), null, '空数组 ⇒ null（调用方不显示卡片）')
  assert.equal(nearestIndex(10, [0.5], padX, innerW), 0, '单点 ⇒ 恒 0')
  assert.equal(nearestIndex(10, xs, padX, 0), null, '图宽为 0 ⇒ null')
})

test('nearestIndex：两种轴（时段网格 xs 与压缩轴 eff/span）都能用', () => {
  // 时段网格：只有上午数据 ⇒ xs 止于 0.5，右半幅留白 —— 右半区应吸到最后一个点
  const sessionXs = [0, 0.25, 0.5]
  assert.equal(nearestIndex(8 + 200 * 0.9, sessionXs, 8, 200), 2, '留白区吸到最后一个点')
  // 压缩轴：eff/span
  const eff = [0, 60, 120, 180, 240]
  const span = 240
  const compressed = eff.map((v) => v / span)
  assert.equal(nearestIndex(8 + 200 * (60 / 240), compressed, 8, 200), 1)
})

test('tipPlacement：默认右侧、靠右翻左、上下收进图内', () => {
  // 左上角：右侧、top 夹到 0
  const tl = tipPlacement(10, 5, 400, 300, 120, 80)
  assert.deepEqual(tl, { left: 22, top: 0, flipped: false })
  // 右上角：翻到左侧、top 夹到 0
  const tr = tipPlacement(380, 5, 400, 300, 120, 80)
  assert.equal(tr.flipped, true, '右侧放不下 ⇒ 翻边')
  assert.equal(tr.left, 380 - 12 - 120)
  assert.equal(tr.top, 0)
  // 左下角：右侧、top 夹到底
  const bl = tipPlacement(10, 295, 400, 300, 120, 80)
  assert.equal(bl.flipped, false)
  assert.equal(bl.top, 220, '下越界 ⇒ 收进图内')
  // 中间：跟随光标（右侧、垂直居中）
  const mid = tipPlacement(200, 150, 400, 300, 120, 80)
  assert.deepEqual(mid, { left: 212, top: 110, flipped: false })
})

test('tipPlacement：图比卡片还小 ⇒ 夹到 0（宁可压住图，也不丢到图外）', () => {
  const tiny = tipPlacement(50, 40, 100, 60, 200, 150)
  assert.deepEqual(tiny, { left: 0, top: 0, flipped: true })
})

test('timeCell：五日档必须带日期（否则 09:35 会被读成今天）', () => {
  assert.equal(timeCell('2026-10-09 09:35', false), '09:35')
  assert.equal(timeCell('2026-10-09 09:35', true), '10-09 09:35')
  assert.equal(timeCell('2026-09-24 15:00', true), '09-24 15:00')
})

test('trendReadout：缺失一律 —（无昨收 / 无均价 / 无成交额都不许写 0）', () => {
  const points = [
    { label: '2026-10-09 09:30', price: 3755.05, avg: null, vol: null, amount: null },
    { label: '2026-10-09 09:31', price: 3760.1, avg: 3758.2, vol: 120000, amount: 4.5e8 },
  ]
  const noBase = trendReadout({ points, i: 0, baseline: null, macd: null })
  const get = (ls: ReturnType<typeof trendReadout>, k: string): string => ls.find((l) => l.label === k)?.value ?? ''
  assert.equal(get(noBase, '时间'), '09:30')
  assert.equal(get(noBase, '价格'), '3755.05')
  assert.equal(get(noBase, '涨跌幅'), '—', '无昨收 ⇒ 不可算，写 —（不是 0.00%）')
  assert.equal(get(noBase, '均价'), '—', '均价缺失 ⇒ —（不是 0）')
  assert.equal(get(noBase, '成交量'), '—')
  assert.equal(get(noBase, '成交额'), '—')
  const withBase = trendReadout({ points, i: 1, baseline: 3755.05, macd: null })
  assert.equal(get(withBase, '均价'), '3758.20')
  assert.equal(get(withBase, '成交量'), '12.0万')
  assert.equal(get(withBase, '成交额'), '4.50亿')
  assert.ok(get(withBase, '涨跌幅').includes('%') && get(withBase, '涨跌幅').includes('▲'), '有昨收 ⇒ 给出方向与百分比')
  assert.equal(withBase.some((l) => l.value === '0' || l.value === '0.00'), false, '不许出现 0 顶替')
})

test('trendReadout：五日档时间列带日期；MACD 行取自传入的同一份系列', () => {
  const points = [
    { label: '2026-10-08 15:00', price: 100, avg: 99, vol: 1, amount: 1 },
    { label: '2026-10-09 09:35', price: 101, avg: 100.5, vol: 1, amount: 1 },
  ]
  const m = macd([100, 101])
  const lines = trendReadout({ points, i: 1, baseline: null, multiDay: true, macd: m })
  const get = (k: string): string => lines.find((l) => l.label === k)?.value ?? ''
  assert.equal(get('时间'), '10-09 09:35', '五日档必须带日期')
  assert.equal(get('DIF'), m.dif[1].toFixed(4), 'DIF 与传入系列一致（不另算一套）')
  assert.equal(get('DEA'), m.dea[1].toFixed(4))
  assert.equal(get('MACD'), m.hist[1].toFixed(4))
})

test('klineReadout：MA/MACD 与传入序列同源（图上与卡片不许各算一套）', () => {
  const bars = Array.from({ length: 6 }, (_, i) => ({
    date: `2026-10-0${i + 1}`,
    open: 10 + i,
    close: 10.5 + i,
    high: 11 + i,
    low: 9.5 + i,
    vol: 1000 + i,
    amount: 1e6 + i,
  }))
  const closes = bars.map((b) => b.close)
  const mas = [{ period: 5, values: [null, null, null, null, 12.5, 13.5] }]
  const m = macd(closes)
  const lines = klineReadout({ bars, i: 5, mas, macd: m })
  const get = (k: string): string => lines.find((l) => l.label === k)?.value ?? ''
  assert.equal(get('时间'), '2026-10-06')
  assert.equal(get('MA5'), '13.50', 'MA 取自传入序列（13.5，而不是另算的数）')
  assert.equal(get('DIF'), m.dif[5].toFixed(4))
  assert.equal(get('DEA'), m.dea[5].toFixed(4))
  assert.equal(get('MACD'), m.hist[5].toFixed(4))
  // 涨跌幅按前一根收盘算
  const expectPct = ((bars[5].close - bars[4].close) / bars[4].close) * 100
  assert.equal(get('涨跌幅'), `${expectPct >= 0 ? '▲' : '▼'}${Math.abs(expectPct).toFixed(2)}%`)
})

test('klineReadout：首根无前收盘 ⇒ 涨跌幅 —；MA/量额缺失 ⇒ —（不用 0）', () => {
  const bars = [
    { date: '2026-10-01', open: 1, close: 1, high: 1, low: 1, vol: null, amount: null },
    { date: '2026-10-02', open: 1, close: 1, high: 1, low: 1, vol: 2, amount: 3 },
  ]
  const lines = klineReadout({ bars, i: 0, mas: [{ period: 5, values: [null, 1] }], macd: null })
  const get = (k: string): string => lines.find((l) => l.label === k)?.value ?? ''
  assert.equal(get('涨跌幅'), '—', '第一根没有前收盘 ⇒ —')
  assert.equal(get('MA5'), '—')
  assert.equal(get('成交量'), '—')
  assert.equal(get('成交额'), '—')
  assert.equal(lines.some((l) => l.value === '0'), false, '不许出现 0 顶替')
  assert.deepEqual(klineReadout({ bars, i: 9, macd: null }), [], '下标越界 ⇒ 空卡片（调用方不显示）')
})
