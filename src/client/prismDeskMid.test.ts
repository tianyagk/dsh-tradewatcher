/**
 * 第二批（中栏：个股详情 + 决策流）对拍断言。
 *
 * 口径来源：`docs/PRISM-DESIGN-DIFF.md` §6–§7 + 本批任务书「中栏要求」。
 * 原则与第一批一致：格式化/派生走纯函数单测；DOM/CSS 走源码对拍 + 反例注入。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  FLOW_RENDER_MAX, FLOW_TABS, aiVerdictOf, amountTextOf, amplitudeOf, digestOf,
  fillMarksOf, flowChipsOf, flowCountsOf, flowEntriesOf, flowFilterOf, flowTimeOf, flowWindowOf,
  pct2, quoteHeadOf, quoteToneOf, signed2, statCellsOf, type FlowOrderInput, type FlowRunInput,
} from './prismDeskMid.ts'

const PAGE = readFileSync(new URL('./PrismPage.tsx', import.meta.url), 'utf8')
const CSS = readFileSync(new URL('./styles.ts', import.meta.url), 'utf8')

/* ───────────── ① 行情头 ───────────── */

test('① 行情头：真实 招商轮船 15.38 / 昨收 16.05 ⇒ -0.67 / -4.17%（跌）', () => {
  const h = quoteHeadOf({ price: 15.38, prev: 16.05, pct: -4.17, open: 15.8, high: 15.8, low: 15.22, amount: 1.411e9, turnover: 1.13, volumeRatio: null })
  assert.equal(h.priceText, '15.38')
  assert.equal(h.chgText, '-0.67')
  assert.equal(h.pctText, '-4.17%')
  assert.equal(h.tone, 'down')
})

test('② 涨跌幅缺失 ⇒ 由 现价/昨收 现算（不是写 0）', () => {
  const h = quoteHeadOf({ price: 10, prev: 8, pct: null, open: null, high: null, low: null, amount: null, turnover: null, volumeRatio: null })
  assert.equal(h.pctText, '+25.00%')
  assert.equal(h.chgText, '+2.00')
  assert.equal(h.tone, 'up')
})

test('③ 现价/昨收缺失 ⇒ — 且 title 说明缺哪个（不猜）', () => {
  const h = quoteHeadOf({ price: null, prev: null, pct: null, open: null, high: null, low: null, amount: null, turnover: null, volumeRatio: null })
  assert.equal(h.priceText, '—')
  assert.equal(h.chgText, '—')
  assert.equal(h.pctText, '—')
  assert.equal(h.tone, 'flat')
  assert.match(h.title, /缺现价、昨收/)
})

test('④ 涨跌色三态：>0 up / <0 down / 0 与缺失 flat', () => {
  assert.equal(quoteToneOf(0.01), 'up')
  assert.equal(quoteToneOf(-0.01), 'down')
  assert.equal(quoteToneOf(0), 'flat')
  assert.equal(quoteToneOf(null), 'flat')
})

test('⑤ 带符号两位：+0.24 / -0.31 / —', () => {
  assert.equal(signed2(0.24), '+0.24')
  assert.equal(signed2(-0.31), '-0.31')
  assert.equal(signed2(null), '—')
  assert.equal(pct2(1.23), '+1.23%')
})

/* ───────────── ② 九项口径 ───────────── */

test('⑥ 振幅 =（最高−最低）/ 昨收：15.80/15.22/16.05 ⇒ 3.61%', () => {
  assert.equal(amplitudeOf(15.8, 15.22, 16.05)?.toFixed(2), '3.61')
  assert.equal(amplitudeOf(null, 15.22, 16.05), null)
  assert.equal(amplitudeOf(15.8, 15.22, 0), null)
  assert.equal(amplitudeOf(15.22, 15.8, 16.05), null, '最高 < 最低 ⇒ 不可算')
})

test('⑦ 成交额：≥1亿 ⇒ 10.09亿；≥1万 ⇒ 3,400.00万；缺失 ⇒ —', () => {
  assert.equal(amountTextOf(1_008_550_000), '10.09亿')
  assert.equal(amountTextOf(34_000_000), '3400.00万')
  assert.equal(amountTextOf(null), '—')
})

test('⑧ 九项口径：两行 5+4，顺序与标签 = 设计稿', () => {
  const cells = statCellsOf({ price: 15.38, prev: 16.05, pct: -4.17, open: 15.8, high: 15.8, low: 15.22, amount: 1.411e9, turnover: 1.13, volumeRatio: null }, 12_200)
  assert.equal(cells.length, 9)
  assert.deepEqual(cells.filter((c) => c.row === 'a').map((c) => c.label), ['昨收', '今开', '最高', '最低', '持仓'])
  assert.deepEqual(cells.filter((c) => c.row === 'b').map((c) => c.label), ['成交额', '换手率', '量比', '振幅'])
  assert.equal(cells.find((c) => c.key === 'qty')?.value, '12,200')
  assert.equal(cells.find((c) => c.key === 'turnover')?.value, '1.13%', '换手率不带正号')
  assert.equal(cells.find((c) => c.key === 'amplitude')?.value, '3.61%')
})

test('⑨ 量比缺失 ⇒ — + title（宿主该标的量比无源）', () => {
  const cells = statCellsOf({ price: 1, prev: 1, pct: 0, open: 1, high: 1, low: 1, amount: 1, turnover: 1, volumeRatio: null }, 100)
  const vr = cells.find((c) => c.key === 'volumeRatio')
  assert.equal(vr?.value, '—')
  assert.match(vr?.title ?? '', /量比无源/)
})

test('⑩ 持仓缺失 ⇒ —（该标的已不在持仓明细）', () => {
  const cells = statCellsOf({ price: 1, prev: 1, pct: 0, open: 1, high: 1, low: 1, amount: 1, turnover: 1, volumeRatio: 1 }, null)
  assert.equal(cells.find((c) => c.key === 'qty')?.value, '—')
})

/* ───────────── ③ 成交标记 / AI 研判 ───────────── */

const FILLS = [
  { at: 1_795_070_000_000, side: 'sell' as const, shares: 124, price: 15.28, secid: '1.601872' },
  { at: 1_795_070_060_000, side: 'sell' as const, shares: 81, price: 15.28, secid: '1.601872' },
  { at: 1_795_070_120_000, side: 'buy' as const, shares: 200, price: 15.3, secid: '1.601872' },
  { at: 1_795_070_000_000, side: 'buy' as const, shares: 100, price: 9.9, secid: '1.510300' },
]

test('⑪ 成交标记：只取该标的最近 2 笔，格式 `B/S HH:MM 买入|卖出 N @价`', () => {
  const marks = fillMarksOf(FILLS, '1.601872')
  assert.equal(marks.length, 2)
  assert.match(marks[0].text, /^S \d{2}:\d{2} 卖出 81 @15\.28$/)
  assert.match(marks[1].text, /^B \d{2}:\d{2} 买入 200 @15\.30$/)
  assert.equal(marks[0].side, 'sell')
})

test('⑫ 成交标记：该标的无成交 ⇒ 空数组（整行不渲染，不写 —）', () => {
  assert.deepEqual(fillMarksOf(FILLS, '1.600938'), [])
})

test('⑬ AI 研判无源 ⇒ `—（无研判）` + 置信度 —（不从长文截一句冒充结论）', () => {
  const v = aiVerdictOf(null)
  assert.equal(v.text, '—（无研判）')
  assert.equal(v.confidence, '—')
  assert.equal(v.has, false)
})

test('⑭ AI 研判有源 ⇒ 结论 + 0.68；反例：只有 confidence 没有结论 ⇒ 仍 —', () => {
  const v = aiVerdictOf({ verdict: '维持低仓位，回避高 beta', confidence: 0.68 })
  assert.equal(v.text, '维持低仓位，回避高 beta')
  assert.equal(v.confidence, '0.68')
  assert.equal(v.has, true)
  const half = aiVerdictOf({ confidence: 0.91 })
  assert.equal(half.text, '—（无研判）')
  assert.equal(half.has, false)
})

/* ───────────── ④ 决策流派生 ───────────── */

const RUNS: FlowRunInput[] = [
  {
    slot: '14:35', day: '2026-11-19', startedAt: 1_795_070_109_000, finishedAt: 1_795_070_109_000 + 67_283,
    analyses: [
      { key: 'a-macro', label: 'A股宏观', text: '# 标题\n**判断**：政策空窗期。', error: null },
      { key: 'overseas', label: '外盘', text: null, error: '上游超时' },
    ],
    decision: { note: '减仓 2 笔', orders: [{}, {}], cancel: [], rejects: [{ secid: '1.600938', side: 'buy', price: 30, shares: 100, reason: '超单票上限' }], clampEvents: [{ at: 1_795_070_110_000, secid: '1.511090', dimension: 'total', before: 300, after: 0, basis: '总仓 69.94%' }], parseError: null },
  },
  {
    slot: '13:10', day: '2026-11-19', startedAt: 1_795_065_000_000, finishedAt: 1_795_065_050_000,
    analyses: [],
    decision: { note: null, orders: [], cancel: [], rejects: [], clampEvents: [], parseError: null },
  },
]

const ORDERS: FlowOrderInput[] = [
  { id: 'o1', secid: '1.601872', name: '招商轮船', side: 'sell', price: 15.28, shares: 2600, status: 'filled', decidedAt: 1_795_070_100_000, filledAt: 1_795_070_140_000, filledShares: 2600, reason: '减仓', origin: 'auto' },
  { id: 'o2', secid: '1.600938', name: '中国海油', side: 'buy', price: 30, shares: 100, status: 'rejected', decidedAt: 1_795_060_000_000, rejectReason: '盘后不下单' },
]

test('⑮ 决策流四类徽标齐全（ORDER/SCAN/ANALYZE/RISK）', () => {
  const kinds = new Set(flowEntriesOf({ runs: RUNS, orders: ORDERS }).map((e) => e.kind))
  assert.deepEqual([...kinds].sort(), ['ANALYZE', 'ORDER', 'RISK', 'SCAN'])
})

test('⑯ 时间倒序：最新一条在最上；同一时刻按 seq 稳定', () => {
  const list = flowEntriesOf({ runs: RUNS, orders: ORDERS })
  const at = list.map((e) => e.at)
  assert.deepEqual(at, [...at].sort((a, b) => b - a), '必须严格倒序')
  // 报告落盘时间 = run.finishedAt（晚于同一轮里的成交），所以最上面是 ANALYZE
  assert.equal(list[0].at, RUNS[0].finishedAt)
  assert.equal(list[0].kind, 'ANALYZE')
  assert.equal(list.at(-1)?.kind, 'ORDER', '最旧的是 13:05 之前那笔被拒委托')
})

test('⑰ SCAN 用真实耗时（finishedAt − startedAt = 67283ms ⇒ 67.3 s）', () => {
  const scan = flowEntriesOf({ runs: RUNS, orders: [] }).find((e) => e.kind === 'SCAN' && e.at === RUNS[0].startedAt)
  assert.equal(scan?.ms, 67_283)
  assert.deepEqual(flowChipsOf(scan!).map((c) => c.text), ['67.3 s'])
})

test('⑱ ANALYZE：每份报告一条；失败的报告写「失败」且依据给错误原因', () => {
  const list = flowEntriesOf({ runs: RUNS, orders: [] }).filter((e) => e.kind === 'ANALYZE')
  assert.equal(list.length, 2)
  const bad = list.find((e) => e.title.includes('外盘'))
  assert.match(bad?.action ?? '', /失败/)
  assert.match(bad?.basis ?? '', /上游超时/)
})

test('⑲ RISK：引擎拒绝与确定性裁剪各一条；裁剪同时属「约束」tab', () => {
  const list = flowEntriesOf({ runs: RUNS, orders: [] }).filter((e) => e.kind === 'RISK')
  assert.equal(list.length, 2)
  const clamp = list.find((e) => e.title.includes('约束裁剪'))
  assert.deepEqual(clamp?.cats, ['risk', 'cons'])
  assert.match(clamp?.action ?? '', /总仓位 300 → 0/)
  assert.equal(clamp?.verdict, 'block')
})

test('⑳ ORDER：被拒绝的委托同时进「挂单」「风控」两个视图，并带拦截原因', () => {
  const rej = flowEntriesOf({ runs: [], orders: ORDERS }).find((e) => e.id === 'order-o2')
  assert.deepEqual(rej?.cats, ['order', 'risk'])
  assert.equal(rej?.verdict, 'block')
  assert.match(rej?.risk ?? '', /风控拦截：盘后不下单/)
  assert.equal(rej?.basis, '盘后不下单')
})

test('㉑ ORDER 动作行含来源（auto ⇒ 自动）与状态中文', () => {
  const filled = flowEntriesOf({ runs: [], orders: ORDERS }).find((e) => e.id === 'order-o1')
  assert.match(filled?.action ?? '', /卖出 2,600 股 @15\.28 · 已成交 · 自动/)
  assert.equal(filled?.verdict, 'pass')
})

test('㉒ 六 tab 计数：全部=去重条数；挂单/风控/约束各按视图计（被拒绝委托计两次）', () => {
  const entries = flowEntriesOf({ runs: RUNS, orders: ORDERS })
  const c = flowCountsOf(entries)
  assert.equal(c.all, entries.length)
  assert.equal(c.all, 2 + 2 + 2 + 2, 'SCAN2 + ANALYZE2 + ORDER2 + RISK2')
  assert.equal(c.scan, 2)
  assert.equal(c.analyze, 2)
  assert.equal(c.order, 2)
  assert.equal(c.risk, 3, '被拒绝委托 1 + 引擎拒绝 1 + 裁剪 1')
  assert.equal(c.cons, 1)
})

test('㉓ 过滤：六个 tab 的 id 与设计稿一致', () => {
  assert.deepEqual(FLOW_TABS.map((t) => t.label), ['全部', '选股', '分析', '挂单', '风控', '约束'])
  const entries = flowEntriesOf({ runs: RUNS, orders: ORDERS })
  assert.equal(flowFilterOf(entries, 'all').length, flowCountsOf(entries).all)
  assert.equal(flowFilterOf(entries, 'cons').length, 1)
  assert.equal(flowFilterOf(entries, 'scan').every((e) => e.kind === 'SCAN'), true)
})

test('㉔ 列表窗口：超上限截断并给出 total/shown（不静默丢）', () => {
  const many = Array.from({ length: FLOW_RENDER_MAX + 12 }, (_, i) => ({ ...ORDERS[0], id: `x${i}`, decidedAt: 1000 + i }))
  const w = flowWindowOf(flowEntriesOf({ runs: [], orders: many }), 'all')
  assert.equal(w.rows.length, FLOW_RENDER_MAX)
  assert.equal(w.total, FLOW_RENDER_MAX + 12)
  assert.equal(w.truncated, true)
  assert.equal(w.shown, FLOW_RENDER_MAX)
})

test('㉕ chips：复审/耗时/token 有源才出现；全无源 ⇒ 空（不写 — 占位）', () => {
  const base = flowEntriesOf({ runs: [], orders: ORDERS })[0]
  assert.deepEqual(flowChipsOf({ ...base, review: null, ms: null, tok: null }), [])
  assert.deepEqual(flowChipsOf({ ...base, review: 0.71, ms: 702, tok: 1120 }).map((c) => c.text), ['复审 0.71', '702 ms', '1,120 tok'])
})

test('㉖ 依据摘要：去 markdown 记号 + 截断 + 空串 ⇒ null', () => {
  assert.equal(digestOf('# 标题\n\n**判断**：政策空窗期。'), '标题 判断 ：政策空窗期。')
  assert.equal(digestOf('   '), null)
  assert.equal(digestOf(null), null)
  assert.equal(digestOf('一'.repeat(100), 10)?.length, 11)
})

test('㉗ 时间列：HH:MM:SS；非法 ⇒ —（不输出 NaN）', () => {
  assert.match(flowTimeOf(1_795_070_140_000), /^\d{2}:\d{2}:\d{2}$/)
  assert.equal(flowTimeOf(0), '—')
})

test('㉘ 空输入：无 runs / 无 orders ⇒ 零条（页面走「决策记录未取到」空态）', () => {
  assert.deepEqual(flowEntriesOf({ runs: [], orders: [] }), [])
  assert.equal(flowCountsOf([]).all, 0)
})

/* ───────────── ⑤ DOM / CSS 对拍 ───────────── */

test('㉙ 页面：六个 tab 由 FLOW_TABS 渲染 + 真实计数 + 「只读 · N 条留痕」', () => {
  assert.match(PAGE, /FLOW_TABS\.map/)
  assert.match(PAGE, /只读 · \$\{flowCounts\.all\} 条留痕/)
  assert.match(PAGE, /flowCounts\[t\.id\]/)
})

test('㉚ 页面：「重放今日」无接口 ⇒ disabled + title 说明', () => {
  assert.match(PAGE, /'↺ 重放今日'/)
  assert.match(PAGE, /'data-role': 'ad-replay', disabled: true, title: '宿主未提供重放接口'/)
})

test('㉛ 页面：图失败 ⇒ `—（图未取到）`，并走既有 trend/kline（无新路由）', () => {
  assert.match(PAGE, /'—（图未取到）'/)
  assert.match(PAGE, /api\.trend\(picked, 1\)/)
  assert.match(PAGE, /api\.kline\(picked, 101, 120, 1\)/)
  assert.ok(!/\/tradewatcher\/prismTrend/.test(PAGE))
})

test('㉜ 页面：分时/日K 切换 + AI 研判块 + 成交标记整行条件渲染', () => {
  assert.match(PAGE, /'分时'/)
  assert.match(PAGE, /'日K'/)
  assert.match(PAGE, /'AI 研判'/)
  assert.match(PAGE, /marks\.length === 0\s*\n\s*\? null/)
})

test('㉝ 页面：三栏骨架仍是 392 / 1fr / 374，≤1100 单列（本批未改栅格）', () => {
  assert.match(CSS, /\.tw-ad-board\{[^}]*grid-template-columns:392px minmax\(0,1fr\) 374px/)
  assert.match(CSS, /@media \(max-width:1100px\)\{\.tw-ad-board\{grid-template-columns:minmax\(0,1fr\)\}\}/)
})

test('㉞ 样式：26px 现价 / 26px 时间轴轨道 / 决策流列表可滚动', () => {
  assert.match(CSS, /\.tw-ad-q-price\{[^}]*font-size:26px/)
  assert.match(CSS, /\.tw-ad-ev\{display:grid;grid-template-columns:26px minmax\(0,1fr\)/)
  assert.match(CSS, /\.tw-ad-feed-list\{[^}]*overflow:auto/)
})

test('㉟ 样式：中栏字号全部 ≥12（设计稿 9–11.5px 统一抬到 12px）', () => {
  const block = CSS.slice(CSS.indexOf('/* ── 中栏 · 个股详情'), CSS.indexOf('/* B3/B4') < 0 ? undefined : CSS.length)
  const sizes = [...block.matchAll(/font-size:(\d+(?:\.\d+)?)px/g)].map((m) => Number(m[1]))
  assert.ok(sizes.length > 10, `扫描到的字号太少：${sizes.length}`)
  assert.deepEqual(sizes.filter((n) => n < 12), [])
})

test('㊱ 动效纪律：中栏没有 transition:width/height/left（只用 transform/opacity）', () => {
  for (const bad of ['transition:width', 'transition:height', 'transition:left', 'animation:evIn']) {
    assert.ok(!CSS.includes(bad), `违反动效纪律：${bad}`)
  }
})
