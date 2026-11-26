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
  FLOW_MISSING, FLOW_RENDER_MAX, FLOW_TABS, amountTextOf, amplitudeOf, digestOf,
  fillMarksOf, firstSentenceOf, flowChipsOf, flowCountsOf, flowEntriesOf, flowFilterOf, flowTimeOf, flowTimeTitleOf, flowWindowOf,
  pct2, plainOf, quoteHeadOf, quoteToneOf, signed2, statCellsOf, thesisViewOf, threeOf,
  type FlowOrderInput, type FlowRunInput,
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

test('⑬ AI 研判无源 ⇒ `—（该股暂无研判）` + 置信度 —（含宿主无字段原因）', () => {
  const v = thesisViewOf(null)
  assert.equal(v.text, '—（该股暂无研判）')
  assert.equal(v.confidence, '—')
  assert.equal(v.confidenceTitle, '宿主无置信度字段')
  assert.equal(v.has, false)
  assert.equal(v.title, null)
})

test('⑭ AI 研判有源 ⇒ 原文 + 来源 + 时间；置信度恒 —（不编 0.68，反例注入必败）', () => {
  const v = thesisViewOf({ text: '红利端补位第二批，银行板块暴露仍仅约1.4%', at: 1_795_156_226_684, kind: 'order' })
  assert.equal(v.text, '红利端补位第二批，银行板块暴露仍仅约1.4%')
  assert.equal(v.confidence, '—')
  assert.equal(v.source, '委托理由')
  assert.equal(v.at, '11-20 14:30')
  assert.equal(v.has, true)
  assert.equal(v.title, v.text)
  assert.throws(() => assert.equal(v.confidence, '0.68', '反例上：编造置信度'), /反例上/, '⚠ 反例注入必须失败')
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

test('⑰ SCAN 用真实耗时（finishedAt − startedAt = 67283ms ⇒ 67.3 s），且时间戳取结束时刻', () => {
  const scan = flowEntriesOf({ runs: RUNS, orders: [] }).find((e) => e.kind === 'SCAN')
  assert.equal(scan?.ms, 67_283)
  assert.equal(scan?.at, RUNS[0].finishedAt, 'SCAN 是「分析完成后的决策」，时间戳必须是 finishedAt（否则看起来比分析还早）')
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

test('㉒ 七 tab 计数：全部=去重条数；挂单/风控/约束各按视图计（被拒绝委托计两次）；持仓=持仓数', () => {
  const entries = flowEntriesOf({ runs: RUNS, orders: ORDERS })
  const c = flowCountsOf(entries)
  assert.equal(c.all, entries.length)
  assert.equal(c.all, 2 + 2 + 2 + 2, 'SCAN2 + ANALYZE2 + ORDER2 + RISK2')
  assert.equal(c.scan, 2)
  assert.equal(c.analyze, 2)
  assert.equal(c.holding, 0, '没有持仓分析 ⇒ 0（不写假数）')
  assert.equal(c.order, 2)
  assert.equal(c.risk, 3, '被拒绝委托 1 + 引擎拒绝 1 + 裁剪 1')
  assert.equal(c.cons, 1)
})

test('㉓ 过滤：七个 tab 的 id 与设计稿一致', () => {
  assert.deepEqual(FLOW_TABS.map((t) => t.label), ['全部', '决策', '分析', '持仓', '挂单', '做T', '风控', '约束'])
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

test('㉗ 时间列：MM-DD HH:MM（北京时间，一律带月日）；非法 ⇒ —（不输出 NaN）', () => {
  // 2026-11-20 06:51:48Z = 北京时间 14:51:48
  assert.equal(flowTimeOf(Date.parse('2026-11-20T06:51:48Z')), '11-20 14:51')
  assert.equal(flowTimeOf(0), '—')
  assert.equal(flowTimeOf(Number.NaN), '—')
  assert.throws(() => assert.equal(flowTimeOf(Date.parse('2026-11-20T06:51:48Z')), '14:51', '反例上：省略月日'), /反例上/, '⚠ 反例注入必须失败')
})

test('㉗b 跨日：UTC 11-20 17:30 = 北京 11-21 01:30 ⇒ 必须写 `11-21 01:30`（机器时区为 UTC 也正确）', () => {
  const ts = Date.parse('2026-11-20T17:30:05Z')
  assert.equal(flowTimeOf(ts), '11-21 01:30', '不得按本机时区渲染，也不得省掉月日')
  assert.equal(flowTimeTitleOf(ts), '2026-11-21 01:30:05')
  assert.equal(flowTimeTitleOf(0), '—')
  assert.throws(() => assert.equal(flowTimeOf(ts), '01:30', '反例上：跨日省略月日'), /反例上/, '⚠ 反例注入必须失败')
})

test('㉘ 空输入：无 runs / 无 orders ⇒ 零条（页面走「决策记录未取到」空态）', () => {
  assert.deepEqual(flowEntriesOf({ runs: [], orders: [] }), [])
  assert.equal(flowCountsOf([]).all, 0)
})

/* ───────────── ⑤ DOM / CSS 对拍 ───────────── */

test('㉙ 页面：七个 tab 由 FLOW_TABS 渲染 + 真实计数 + 「只读 · N 条留痕」', () => {
  assert.match(PAGE, /FLOW_TABS\.map/)
  assert.match(PAGE, /只读 · \$\{flowCounts\.all\} 条留痕/)
  assert.match(PAGE, /flowCounts\[t\.id\]/)
})

test('㉚ 页面：「重放今日」接宿主既有 action:run（v0.218.3 起可点，不再是 disabled 占位）', () => {
  assert.match(PAGE, /'↺ 重放今日'/)
  assert.match(PAGE, /'data-role': 'ad-replay'/)
  assert.match(PAGE, /onClick: replayToday/)
  assert.match(PAGE, /api\.prismRun\(slot\)/)
  assert.ok(!/disabled: true, title: '宿主未提供重放接口'/.test(PAGE), '不得再写死 disabled')
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

test('㉟ 样式：中栏字号全部 ≥12（tab 计数 11px 为唯一附注例外）', () => {
  // 仅 `.tw-ad-fchip .cn`（计数）允许 11px；其余 11px 及以下仍判败
  const block = CSS.slice(CSS.indexOf('/* ── 中栏 · 个股详情'), CSS.indexOf('/* B3/B4') < 0 ? undefined : CSS.length)
    .replace(/\.tw-ad-fchip \.cn\{[^}]*\}/g, '')
  const sizes = [...block.matchAll(/font-size:(\d+(?:\.\d+)?)px/g)].map((m) => Number(m[1]))
  assert.ok(sizes.length > 10, `扫描到的字号太少：${sizes.length}`)
  assert.deepEqual(sizes.filter((n) => n < 12), [])
})

test('㊱ 动效纪律：中栏没有 transition:width/height/left（只用 transform/opacity）', () => {
  for (const bad of ['transition:width', 'transition:height', 'transition:left', 'animation:evIn']) {
    assert.ok(!CSS.includes(bad), `违反动效纪律：${bad}`)
  }
})


/* ───────────── ⑥ 决策流三要素 / 展开收起 / tab 按钮（v0.207.2） ───────────── */

test('㊲ threeOf：观察←依据、推理←判断、结论←总判断，且去 markdown 符号', () => {
  const md = [
    '# 宏观报告',
    '',
    '- **依据**：**沪深300** −0.59%，`成交额` 缩量。',
    '- **判断**：这是缩圈，不是崩盘。',
    '',
    '**总判断：结构偏多，不追高。**',
  ].join('\n')
  const t = threeOf(md)
  assert.equal(t.observation, '沪深300 −0.59%，成交额 缩量。')
  assert.equal(t.reasoning, '这是缩圈，不是崩盘。')
  assert.equal(t.conclusion, '结构偏多，不追高。')
  for (const v of [t.observation, t.reasoning, t.conclusion]) {
    assert.ok(!v.includes('**'), `残留粗体符号：${v}`)
    assert.ok(!v.includes('##') && !v.startsWith('#'), `残留标题符号：${v}`)
    assert.ok(!v.startsWith('-'), `残留列表符号：${v}`)
  }
})

test('㊳ threeOf：观察缺失严格 —；结论优先本报告判断句（v0.220.1 起，不再跳到 summary）', () => {
  const t = threeOf('- **判断**：只有推理，没有观察。')
  assert.equal(t.observation, FLOW_MISSING)
  assert.equal(t.reasoning, '只有推理，没有观察。')
  assert.equal(t.conclusion, '只有推理，没有观察。')
  assert.ok(!t.observation.includes('推理'), '观察缺失时不得用判断段顶替')
})

test('㊴ threeOf：没有总判断 ⇒ 取 summary 第一句（跳过标题，不取第二句）', () => {
  const summary = '## 一页汇总（5 条）\n\n**1｜风险暴露：结论是不主动降，只做结构修正。** 第二句不得出现。'
  assert.equal(threeOf('- **依据**：x\n- **判断**：y', summary).conclusion, 'y', '有本报告判断句时不用 summary')
  assert.equal(threeOf('纯文本，无任何判断行。', summary).conclusion, '1｜风险暴露：结论是不主动降，只做结构修正。')
  assert.equal(firstSentenceOf(summary), '1｜风险暴露：结论是不主动降，只做结构修正。')
  assert.equal(firstSentenceOf('### 只有标题'), null)
})

test('㊵ 总判断三种写法（粗体包整段 / 冒号在粗体内 / 粗体只包标签）均可抽取', () => {
  assert.equal(threeOf('**总判断：外盘处在兑现期。**').conclusion, '外盘处在兑现期。')
  assert.equal(threeOf('**总判断：** 今日主线是半导体。').conclusion, '今日主线是半导体。')
  assert.equal(threeOf('**总判断**：贵金属分化，不追。').conclusion, '贵金属分化，不追。')
  const bold = threeOf('**总判断：** **结构**偏多。').conclusion
  assert.ok(!bold.includes('**'), '结论必须去掉粗体符号')
})

test('㊶ ANALYZE 条目带三要素；缺观察时保留 —（本条未给出），不跨段顶替', () => {
  const full = flowEntriesOf({ runs: [{
    slot: '14:35', startedAt: 10, finishedAt: 20,
    summary: '## 汇总\n\n**总判断：** 本轮只减仓。',
    analyses: [{ key: 'a', label: '宏观', text: '- **依据**：沪深300 跌 0.59%。\n- **判断**：缩圈。', error: null }],
  }] }).find((e) => e.kind === 'ANALYZE')
  assert.equal(full?.three?.observation, '沪深300 跌 0.59%。')
  assert.equal(full?.three?.reasoning, '缩圈。')
  assert.equal(full?.three?.conclusion, '缩圈。', 'v0.220.1：结论优先本报告判断句')
  const missing = flowEntriesOf({ runs: [{
    startedAt: 30, finishedAt: 40,
    analyses: [{ key: 'b', label: '外盘', text: '**判断**：只有推理。', error: null }],
  }] }).find((e) => e.kind === 'ANALYZE')
  assert.equal(missing?.three?.observation, FLOW_MISSING)
  assert.equal(missing?.three?.conclusion, '只有推理。', '有判断句就用它，没有才 —')
})

test('㊷ ORDER / RISK 仍是动作 / 依据 / 风控三段，不注入 three', () => {
  const entries = flowEntriesOf({ runs: RUNS, orders: ORDERS })
  const order = entries.find((e) => e.id === 'order-o2')
  assert.equal(order?.action.includes('买入'), true)
  assert.equal(order?.basis, '盘后不下单')
  assert.equal(order?.risk.includes('风控拦截'), true)
  assert.equal(order?.three, undefined, 'ORDER 不得带 ANALYZE 三要素')
  const risk = entries.find((e) => e.kind === 'RISK' && e.title.includes('拦截'))
  assert.equal(risk?.three, undefined)
})

test('㊸ 数据层不截断：长依据完整进 DOM 字段（… 只允许出现在视觉层）', () => {
  const long = '长'.repeat(300)
  const scan = flowEntriesOf({ runs: [{ startedAt: 1, finishedAt: 2, decision: { note: long, orders: [], cancel: [], rejects: [], clampEvents: [], parseError: null } }], orders: [] })
    .find((e) => e.kind === 'SCAN')
  assert.equal(scan?.basis, long)
  assert.equal(scan?.basis?.length, 300)
  assert.equal(scan?.basis?.includes('…'), false, '数据层不得插省略号')
  assert.equal(plainOf(long), long)
  assert.ok(!PAGE.includes('digestOf'), '页面不得再对决策流文本做摘要截断')
  assert.match(PAGE, /title: text/, '文本节点必须带完整 title')
})

test('㊹ 展开 / 收起：原生 button + aria-expanded，展开后去掉 is-clamp', () => {
  assert.match(PAGE, /'data-role': 'ad-flow-expand'/)
  assert.match(PAGE, /'aria-expanded': open/)
  assert.match(PAGE, /open \? '收起' : '展开'/)
  assert.match(PAGE, /!open && overflow \? ' is-clamp' : ''/)
})

test('㊺ 截断只在视觉层：-webkit-line-clamp 3 行，行高 1.55 不随展开改变', () => {
  assert.match(CSS, /\.tw-ad-ev-r \.v\.is-clamp\{[^}]*-webkit-line-clamp:3/)
  assert.match(CSS, /\.tw-ad-ev-r \.v\{[^}]*line-height:1\.55/)
  assert.ok(!/is-open[^{]*\{[^}]*line-height:/.test(CSS), '展开态不得改行高')
})

test('㊻ tab 按钮样式：4px 10px / 圆角 6 / 边框 / card2 / 12px / nowrap / gap 6', () => {
  const rule = CSS.match(/\.tw-ad-fchip\{([^}]*)\}/)?.[1] ?? ''
  for (const want of ['padding:4px 10px', 'border-radius:6px', 'border:1px solid var(--tw-border)', 'background:var(--tw-card2)', 'font-size:12px', 'white-space:nowrap', 'gap:6px']) {
    assert.ok(rule.includes(want), `tab 缺少 ${want}`)
  }
  assert.match(PAGE, /react\.createElement\('button'/i)
  assert.match(PAGE, /type: 'button', role: 'tab'/)
})

test('㊼ tab 选中态：accent 边框 + rgba(91,140,255,.16) 背景 + 正文色', () => {
  const on = CSS.match(/\.tw-ad-fchip\.on\{([^}]*)\}/)?.[1] ?? ''
  assert.match(on, /border-color:var\(--tw-accent\)/)
  assert.match(on, /background:rgba\(91,140,255,\.16\)/)
  assert.match(on, /color:var\(--tw-text\)/)
})

test('㊽ 计数用 <b>、11px、同色淡一档', () => {
  const cn = CSS.match(/\.tw-ad-fchip \.cn\{([^}]*)\}/)?.[1] ?? ''
  assert.match(cn, /font-size:11px/)
  assert.match(cn, /color:inherit/)
  assert.match(cn, /opacity:\.7\d?/)
  assert.match(PAGE, /react\.createElement\('b', \{ className: 'cn'/i)
})

test('㊾ tab 容器 flex-wrap + gap 6（374px / 890px 靠换行不溢出）', () => {
  const bar = CSS.match(/\.tw-ad-flow-bar\{([^}]*)\}/)?.[1] ?? ''
  assert.match(bar, /flex-wrap:wrap/)
  assert.match(bar, /gap:6px/)
  assert.ok(!bar.includes('overflow:hidden'), '不得用 overflow:hidden 硬裁')
})

test('㊿ 键盘可达：tab / 展开都是原生 button，:focus-visible 有描边', () => {
  assert.match(CSS, /\.tw-ad-fchip:focus-visible\{[^}]*outline:2px solid var\(--tw-accent\)/)
  assert.match(CSS, /\.tw-ad-ev-more:focus-visible\{[^}]*outline:2px solid var\(--tw-accent\)/)
  assert.match(PAGE, /className: 'tw-ad-ev-more'/)
  assert.ok(!/tabIndex: -1/.test(PAGE), '不得把 tab 从键盘序列里移除')
})

test('51 threeOf 空输入：三段全部 —（本条未给出），不抛错', () => {
  for (const v of [threeOf(null), threeOf(''), threeOf(undefined, null)]) {
    assert.equal(v.observation, FLOW_MISSING)
    assert.equal(v.reasoning, FLOW_MISSING)
    assert.equal(v.conclusion, FLOW_MISSING)
  }
})

test('52 threeOf 兼容真实报告的“标签独占一行”写法（冒号可省略）', () => {
  const md = '**依据**\n- 第一条依据。\n\n**判断**\n推理正文。\n\n**总判断**\n结论正文。'
  const t = threeOf(md)
  assert.equal(t.observation, '第一条依据。')
  assert.equal(t.reasoning, '推理正文。')
  assert.equal(t.conclusion, '结论正文。')
})

/* ───────────── ⑥ v0.212.0 持仓分析 HOLD + 时间戳（含反例注入） ───────────── */

const HOLDS = [
  {
    secid: '1.518880', name: '黄金ETF华安', at: Date.parse('2026-11-20T06:30:00Z'),
    observation: '权重 50.0%（单票上限 15%） · 浮盈 +25.00% · 当日 +2.04% · 持仓市值 50.0万',
    reasoning: '超单票上限（权重 50.0% > 单票上限 15%）', conclusion: '继续持有。', verdict: 'over',
  },
  {
    secid: '1.510300', name: '沪深300ETF', at: null,
    observation: '权重 10.0%（单票上限 —） · 浮盈 +5.00% · 当日 —（缺昨收） · 持仓市值 10.0万',
    reasoning: '—（约束未设置，无法判定）', conclusion: '—（该股暂无研判）', verdict: 'no-constraint',
  },
]

test('53 HOLD：每个持仓一条，kind=HOLD / scope=holding / 只进「持仓」视图（少一条 ⇒ 败）', () => {
  const list = flowEntriesOf({ runs: [], orders: [], holdings: HOLDS })
  assert.equal(list.length, HOLDS.length, '每个持仓一条')
  assert.deepEqual(list.map((e) => e.kind), ['HOLD', 'HOLD'])
  assert.deepEqual(list.map((e) => e.scope), ['holding', 'holding'])
  assert.deepEqual(list.map((e) => e.cats), [['holding'], ['holding']])
  assert.ok(!list.some((e) => e.scope === 'run'), 'HOLD 不得挂在 runs 上')
  assert.throws(() => assert.equal(list.length, 1, '反例上：漏一条'), /反例上/, '⚠ 反例注入必须失败')
})

test('54 持仓 tab 计数 = 持仓数；「全部」包含这些条目（只数不并 ⇒ 败）', () => {
  const entries = flowEntriesOf({ runs: RUNS, orders: ORDERS, holdings: HOLDS })
  const c = flowCountsOf(entries)
  assert.equal(c.holding, HOLDS.length, '持仓 tab 计数 = 持仓数')
  assert.equal(c.all, 2 + 2 + 2 + 2 + HOLDS.length, '全部 = 原有 8 条 + 2 条 HOLD')
  assert.equal(flowFilterOf(entries, 'holding').length, HOLDS.length)
  assert.ok(flowFilterOf(entries, 'all').some((e) => e.kind === 'HOLD'), '「全部」必须含 HOLD')
  assert.throws(() => assert.equal(c.all, 8, '反例上：全部漏掉 HOLD'), /反例上/, '⚠ 反例注入必须失败')
})

test('55 HOLD 三要素与时间：观察/推理/结论原样进 flow；at 缺失 ⇒ 时间列 —', () => {
  const list = flowEntriesOf({ runs: [], orders: [], holdings: HOLDS })
  const gold = list.find((e) => e.id === 'hold-1.518880')!
  assert.equal(gold.three?.observation, HOLDS[0].observation)
  assert.equal(gold.three?.reasoning, HOLDS[0].reasoning)
  assert.equal(gold.three?.conclusion, HOLDS[0].conclusion)
  assert.equal(gold.verdict, 'block', '超单票上限 ⇒ 风险态')
  assert.equal(gold.verdictLabel, '超单票上限')
  assert.equal(flowTimeOf(gold.at), '11-20 14:30')
  const noAt = list.find((e) => e.id === 'hold-1.510300')!
  assert.equal(noAt.at, 0, '无时刻 ⇒ 0 哨兵')
  assert.equal(flowTimeOf(noAt.at), '—', '显示 —，不编时间')
  assert.equal(noAt.verdict, 'pass')
  assert.equal(noAt.verdictLabel, '约束未设置')
  assert.throws(() => assert.equal(flowTimeOf(noAt.at), '00:00', '反例上：编一个时间'), /反例上/, '⚠ 反例注入必须失败')
})

test('56 页面：HOLD 走「观察/推理/结论」三行；时间带完整 title；holdings 已接线', () => {
  assert.match(PAGE, /e\.kind === 'ANALYZE' \|\| e\.kind === 'HOLD'/)
  assert.match(PAGE, /title: flowTimeTitleOf\(e\.at\)/)
  assert.match(PAGE, /'data-role': 'ad-flow-time'/)
  assert.match(PAGE, /holdings: desk\?\.holdingAnalyses \?\? \[\]/)
  assert.match(CSS, /\.tw-ad-tag\.is-hold\{[^}]*var\(--tw-human\)/)
  assert.throws(() => assert.match(PAGE.replace(/title: flowTimeTitleOf\(e\.at\), /, ''), /title: flowTimeTitleOf\(e\.at\)/, '反例上：时间不带 title'), /反例上/, '⚠ 反例注入必须失败')
})

test('57 页面：只读派生 —— 持仓分析不写 runs、不参与「重放今日」', () => {
  const before = JSON.stringify(RUNS)
  const fn = flowEntriesOf({ runs: RUNS, orders: [], holdings: HOLDS })
  assert.equal(JSON.stringify(RUNS), before, 'flowEntriesOf 不得改写 runs 入参')
  const runCount = fn.filter((e) => e.kind === 'SCAN').length
  assert.equal(runCount, RUNS.length, 'HOLD 不改写 runs 派生条数')
  // 重放按钮从 v0.218.3 起可用：只读派生仍不得把 HOLD 写进 runs
  assert.match(PAGE, /onClick: replayToday/)
  assert.throws(() => assert.equal(runCount, RUNS.length + HOLDS.length, '反例上：把 HOLD 混进 runs'), /反例上/, '⚠ 反例注入必须失败')
})

test('做T 委托进「做T」筛选，普通委托不进', () => {
  const base = { secid: '1.600938', name: '中国海油', side: 'buy' as const, price: 30, shares: 100, status: 'pending', decidedAt: 1, filledAt: 2 }
  const entries = flowEntriesOf({ orders: [
    { ...base, id: 'o1', channel: 'autoT' },
    { ...base, id: 'o2' },
  ] })
  const t = entries.find((e) => e.id === 'order-o1')!
  const normal = entries.find((e) => e.id === 'order-o2')!
  assert.equal(t.cats.includes('autoT'), true)
  assert.equal(normal.cats.includes('autoT'), false)
})
