/**
 * 图表光标层的断言：像素→点、卡片摆放、卡片内容（缺失一律 `—`，MA/MACD 与图上同源）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { klineReadout, nearestIndex, timeCell, tipPlacement, toneClass, trendPctLine, trendReadout } from './chartCursor.ts'
import { SESSION_CN } from './sessionAxis.ts'
import { dirClass } from './format.ts'
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
  // 口径已改为"距开盘/距首点"（可见标签一律「涨跌幅」，口径进 hint）：第 0 点是相对自身 ⇒ 0.00%（真实值）
  assert.equal(get(noBase, '涨跌幅'), '0.00%', '首点对自身 ⇒ 0.00%（这里 0 是真实值）')
  assert.equal(get(noBase, '均价'), '—', '均价缺失 ⇒ —（不是 0）')
  assert.equal(get(noBase, '成交量'), '—')
  assert.equal(get(noBase, '成交额'), '—')
  const withBase = trendReadout({ points, i: 1, baseline: 3755.05, macd: null })
  assert.equal(get(withBase, '均价'), '3758.20')
  assert.equal(get(withBase, '成交量'), '12.0万')
  assert.equal(get(withBase, '成交额'), '4.50亿')
  const pctLine = withBase.find((l) => l.label.startsWith('涨跌'))
  assert.ok(pctLine !== undefined && pctLine.value.includes('%') && pctLine.value.includes('▲'), '给出方向与百分比')
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

test('距开盘口径：首点 100 → 当前 105 ⇒ +5.00%；首点缺失或为 0 ⇒ —（不是 0）', () => {
  const pts = [
    { label: '2026-10-09 09:30', price: 100, avg: null, vol: null, amount: null },
    { label: '2026-10-09 10:00', price: 105, avg: null, vol: null, amount: null },
  ]
  const ok = trendPctLine(pts, 1, { session: SESSION_CN })
  assert.equal(ok.label, '涨跌幅', '可见标签一律「涨跌幅」')
  assert.ok(ok.hint.includes('相对当日开盘价'), '首点正是 09:30 ⇒ 口径是"距开盘"（进 hint）')
  assert.equal(ok.pct, 5, '+5%')
  const lines = trendReadout({ points: pts, i: 1, session: SESSION_CN })
  assert.equal(lines.find((l) => l.label === '涨跌幅')?.value, '▲5.00%')
  // 首点为 0 / 首点缺失 ⇒ 不可算
  const zero = trendPctLine([{ label: '2026-10-09 09:30', price: 0 }, { label: '2026-10-09 10:00', price: 5 }], 1, { session: SESSION_CN })
  assert.equal(zero.pct, null, '首点为 0 ⇒ 不可算')
  const noFirst = trendPctLine([{ label: '2026-10-09 10:00', price: 5 }], 0, { session: SESSION_CN })
  assert.equal(noFirst.pct, 0, '整条序列就是这一点 ⇒ 相对自身 0%（不是 null）')
  const empty = trendReadout({ points: [], i: 0 })
  assert.deepEqual(empty, [], '空序列 ⇒ 空卡片')
})

test('口径进 hint：可见标签一律「涨跌幅」，而 hint 必须区分三种口径（读屏也读得到）', () => {
  const atOpen = [{ label: '2026-10-09 09:30', price: 100 }, { label: '2026-10-09 09:31', price: 101 }]
  const open = trendPctLine(atOpen, 1, { session: SESSION_CN })
  assert.equal(open.label, '涨跌幅')
  assert.ok(open.hint.includes('相对当日开盘价') && !open.hint.includes('首点'), '距开盘的口径句')
  // 无时段表（美股/商品/期货）：122.XAU 首点 06:00 —— 那不是开盘
  const xau = [{ label: '2026-10-09 06:00', price: 4274.05 }, { label: '2026-10-09 06:05', price: 4280 }]
  const first = trendPctLine(xau, 1, { session: null })
  assert.equal(first.label, '涨跌幅')
  assert.ok(first.hint.includes('相对该序列首点'), '无表 ⇒ 口径句只能写"首点"')
  // 有表但首点不在开盘（数据从 09:45 开始）⇒ 同样退化，且 hint 要说明原因
  const late = [{ label: '2026-10-09 09:45', price: 100 }, { label: '2026-10-09 09:50', price: 101 }]
  assert.ok(trendPctLine(late, 1, { session: SESSION_CN }).hint.includes('首点不是开盘时刻'), '说明为什么不能称距开盘')
  // 调用方给了真实开盘价 ⇒ 用它
  const withOpen = trendPctLine(late, 1, { session: SESSION_CN, open: 99 })
  assert.ok(withOpen.hint.includes('相对当日开盘价'), '有真实开盘价 ⇒ 口径是距开盘')
  assert.ok(Math.abs((withOpen.pct ?? 0) - ((101 - 99) / 99) * 100) < 1e-9, '用传入的开盘价算')
  // 三种口径的 hint 互不相同（否则读者区分不出来）
  const dayOpen = trendPctLine(
    [{ label: '2026-10-08 09:30', price: 100 }, { label: '2026-10-09 09:30', price: 200 }, { label: '2026-10-09 10:00', price: 210 }],
    2, { multiDay: true, session: SESSION_CN })
  const hints = new Set([open.hint, first.hint, dayOpen.hint])
  assert.equal(hints.size, 3, '三种口径的 hint 必须互不相同')
  // 卡片行：可见标签一律「涨跌幅」
  const card = trendReadout({ points: xau, i: 1, session: null })
  assert.equal(card.filter((l) => l.label.startsWith('涨跌')).length, 1)
  assert.equal(card.find((l) => l.label.startsWith('涨跌'))?.label, '涨跌幅')
  assert.ok((card.find((l) => l.label === '涨跌幅')?.hint ?? '').length > 0, 'hint 必须有内容（title/aria 要用）')
})

test('五日档：与"同一天的首点"比（跨天比五天前没有意义）', () => {
  const pts = [
    { label: '2026-10-08 09:30', price: 100 },
    { label: '2026-10-08 15:00', price: 110 },
    { label: '2026-10-09 09:30', price: 200 },
    { label: '2026-10-09 10:00', price: 210 },
  ]
  const r = trendPctLine(pts, 3, { multiDay: true, session: SESSION_CN })
  assert.equal(r.label, '涨跌幅', '可见标签仍是「涨跌幅」')
  assert.ok(r.hint.includes('同日开盘'), '多日档口径进 hint')
  assert.equal(r.pct, 5, '210 对**当天**首点 200 = +5%（而不是对 10-08 的 100 = +110%）')
})

test('toneClass：redUp=true 时 up→tw-up；false 时互换；undefined/0 ⇒ 中性', () => {
  assert.equal(toneClass('up', true), 'tw-up')
  assert.equal(toneClass('down', true), 'tw-down')
  assert.equal(toneClass('up', false), 'tw-down', '绿涨红跌档：涨要显示为"跌"色')
  assert.equal(toneClass('down', false), 'tw-up')
  assert.equal(toneClass(undefined, true), 'tw-muted')
  assert.equal(toneClass('muted', false), 'tw-muted')
})

test('回归：翻转 redUp 只改颜色、不改数值与文案（卡片内容与开关无关）', () => {
  const pts = [
    { label: '2026-10-09 09:30', price: 100, avg: 100.1, vol: 1000, amount: 1e6 },
    { label: '2026-10-09 10:00', price: 105, avg: 102.3, vol: 2000, amount: 2e6 },
  ]
  const lines = trendReadout({ points: pts, i: 1, session: SESSION_CN })
  const probe = JSON.stringify(lines)
  // 同一份 lines 在两种配色下渲染出的 class 不同，但 lines 本身必须逐字相同
  const upCls = lines.map((l) => toneClass(l.tone, true))
  const downCls = lines.map((l) => toneClass(l.tone, false))
  assert.equal(JSON.stringify(lines), probe)
  assert.notDeepEqual(upCls, downCls, '配色确实翻转了')
  assert.deepEqual(lines, trendReadout({ points: pts, i: 1, session: SESSION_CN }), '重新计算也逐字相同')
  // K 线档同样：口径与配色无关
  const bars = [{ date: '2026-10-01', open: 1, close: 1, high: 1, low: 1, vol: null }, { date: '2026-10-02', open: 1, close: 2, high: 2, low: 1, vol: null }]
  assert.deepEqual(klineReadout({ bars, i: 1, macd: null }), klineReadout({ bars, i: 1, macd: null }))
})

test('K 线档口径**未被改动**：仍对前收盘；首根无前收盘 ⇒ —（不是 0）', () => {
  const bars = [
    { date: '2026-10-01', open: 10, close: 10, high: 11, low: 9, vol: 1 },
    { date: '2026-10-02', open: 10, close: 11, high: 12, low: 9.5, vol: 1 },
  ]
  const l1 = klineReadout({ bars, i: 1, macd: null })
  const get = (ls: typeof l1, k: string): string => ls.find((x) => x.label === k)?.value ?? ''
  assert.equal(get(l1, '涨跌幅'), '▲10.00%', '(11-10)/10 —— 对**前收盘**，不是对首点/开盘')
  const l0 = klineReadout({ bars, i: 0, macd: null })
  assert.equal(get(l0, '涨跌幅'), '—', '第一根没有前收盘 ⇒ —')
  assert.equal(l1.some((x) => x.value === '0' || x.value === '0.00%'), false, '不许 0 顶替')
})

test('一致性：卡片着色与全站 dirClass 对同一个值给出同一个颜色', () => {
  // dirClass 的口径（format.ts）：n>0 且 redUp ⇒ tw-up，否则 tw-down；0 ⇒ tw-flat
  assert.equal(dirClass(1.2, true), 'tw-up')
  assert.equal(dirClass(-1.2, true), 'tw-down')
  assert.equal(dirClass(1.2, false), 'tw-down', '绿涨红跌：上涨用"跌"色')
  assert.equal(dirClass(-1.2, false), 'tw-up', '绿涨红跌：下跌用"涨"色')
  // 卡片侧：tone 由 pct 的方向决定 ⇒ 两条路径必须一致（同一个下跌值 ⇒ 同一个类）
  for (const redUp of [true, false]) {
    assert.equal(toneClass('down', redUp), dirClass(-1.2, redUp), `redUp=${String(redUp)} 时下跌色必须一致`)
    assert.equal(toneClass('up', redUp), dirClass(1.2, redUp), `redUp=${String(redUp)} 时上涨色必须一致`)
  }
  // 中性：dirClass 对 0 给 tw-flat，卡片的中性行给 tw-muted —— 都是中性色，但**刻意不同物**
  // （tw-flat 是"涨跌为零"的语义色，tw-muted 是"这一行不表示涨跌"）。故这里只断言两者都不落在涨跌类上。
  assert.equal(dirClass(0, true), 'tw-flat')
  assert.equal(toneClass(undefined, true), 'tw-muted')
  assert.ok(!['tw-up', 'tw-down'].includes(toneClass(undefined, true)))
})
