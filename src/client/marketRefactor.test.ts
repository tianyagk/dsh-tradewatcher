/**
 * v0.65.0（task-14）：大盘组件重构的三处断言 —— 删查询框 / 涨跌分布重构 / 护盘紧凑化。
 *
 * 锚点：真源码文本 + 纯函数语义 + 真实回包形状；每条都配**反例注入**（注入后判据必须非空）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { DIST_EDGES, DIST_LABELS, distributionBinsOf } from './breadthView.ts'
import { breakerBadgeOf } from './rescueView.ts'

const here = dirname(fileURLToPath(import.meta.url))
const read = (rel: string): string => readFileSync(join(here, rel), 'utf8')
/** 去注释再断言（说明性注释里会**提到**被删的字面量） */
const strip = (t: string): string => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

// ── ① 查询块已删 + 归属复核 ────────────────────────────────────────────────

test('① 查询块已删：常驻里没有搜索框与那句说明；行点击详情的通路仍在（DetailModal）', () => {
  const page = strip(read('./MarketPage.tsx'))
  const bad: string[] = []
  for (const s of ['个股 / 基金查询', '搜索 A股/港股/ETF/基金/指数', '点击指数、ETF 行或搜索后显示详情']) {
    if (page.includes(s)) bad.push(`仍含被删文案：${s}`)
  }
  if (page.includes('SuggestInput')) bad.push('仍引用 SuggestInput')
  assert.deepEqual(bad, [], `查询块必须已删干净（实际 ${JSON.stringify(bad)}）`)
  // 详情仍可达：DetailModal 仍在渲染，行点击仍走 openDetail（不是"顺手把详情也删了"）
  assert.ok(page.includes("React.createElement(DetailModal,"), 'DetailModal 必须仍在')
  assert.ok(/onClick: clickable[^\n]*openDetail\(/.test(page) || /openDetail\(r\.secid as string\)/.test(page), '行点击仍要能打开详情')
  // 反例注入：把查询块标题加回常驻 ⇒ 判据必须非空
  const injected = `${page}\nReact.createElement('span', null, '个股 / 基金查询')`
  assert.notDeepEqual(
    ['个股 / 基金查询', '搜索 A股/港股/ETF/基金/指数'].filter((s) => injected.includes(s)),
    [],
    '⚠ 反例（查询块加回）必须被判据抓住',
  )
})

test('① 归属复核：/suggest 仍有 ≥2 个客户端消费者 + agent 工具在用搜索能力 ⇒ 保留在 core，不重定归属', () => {
  // 消费者（grep 证据）：PortfolioPage / WatchlistPage 仍在用 SuggestInput
  for (const f of ['./PortfolioPage.tsx', './WatchlistPage.tsx']) {
    assert.ok(strip(read(f)).includes('SuggestInput'), `${f} 仍消费搜索（⇒ 路由不该因为大盘页删了它而失去消费者）`)
  }
  // host 侧 agent 工具仍在用同一份搜索能力（`em.searchSymbols`）
  const tools = read('../host/tools.ts')
  assert.ok(tools.includes("name: `${PREFIX}search`"), 'tradewatcher_search 工具仍在')
  assert.ok(/searchSymbols/.test(read('../host/em.ts')), '搜索能力（em.searchSymbols）仍在 host 侧')
  // 路由仍在 core（不在任何功能行的独占清单里）——即"只删 UI、不动归属"
  const index = read('../index.ts')
  const market = /market: \[([^\]]*)\]/.exec(index)?.[1] ?? ''
  const watchlist = /watchlist: \[([^\]]*)\]/.exec(index)?.[1] ?? ''
  assert.equal(/suggest/.test(market), false, '/suggest 不该被塞进 market 行')
  assert.equal(/suggest/.test(watchlist), false, '/suggest 不该被塞进 watchlist 行')
})

// ── ② 涨跌分布：名字、两列、分档语义、未取到不许编数 ──────────────────────

test('② 命名与布局：标题由「A股全景」改为「涨跌分布」，两列结构 + 五个小节标题都在', () => {
  const page = strip(read('./MarketPage.tsx'))
  assert.ok(page.includes("'涨跌分布'"), '区块标题必须是「涨跌分布」')
  assert.equal(page.includes('A股全景'), false, '「A股全景」不许再作为标题出现')
  for (const t of ['涨跌趋势', '成交量', '两融走势', '日内家数']) {
    assert.ok(page.includes(`'${t}'`), `小节「${t}」必须在`)
  }
  assert.ok(page.includes('tw-dist-cols') && page.includes('tw-dist-col'), '两列容器必须在（样式见 styles.ts）')
  const css = read('./styles.ts')
  assert.ok(/\.tw-dist-cols\{[^}]*display:flex/.test(css), '两列容器样式必须真的定义在 styles.ts')
})

test('② 分档语义：对称 9 档、平盘单独一档；**无涨跌幅的行不计入任何档**（不许当 0）', () => {
  // 边界值逐点验（正负对称）
  const { counts, blank, total } = distributionBinsOf([7, 6, 4, 1, 0, -1, -4, -6, -7, null, Number.NaN])
  assert.equal(counts.length, DIST_LABELS.length, '档数 = 档名数')
  assert.deepEqual(counts, [1, 1, 1, 1, 1, 1, 1, 1, 1], '9 个样本各落一档（≥7/5~7/3~5/0~3/平/-3~0/-5~-3/-7~-5/≤-7）')
  assert.equal(blank, 2, 'null 与 NaN 各记一次 blank —— **不计入任何档**')
  assert.equal(total, 11)
  // 边界归属：7 落"≥7"、5 落"5~7"、3 落"3~5"、0 落"平盘"、-3 落"-3~0"（半开区间，写死在断言语义里）
  const edge = distributionBinsOf([7, 5, 3, 0, -3, -5, -7])
  assert.equal(edge.counts[0], 1, '7 ⇒ ≥7%')
  assert.equal(edge.counts[1], 1, '5 ⇒ 5~7%')
  assert.equal(edge.counts[2], 1, '3 ⇒ 3~5%')
  assert.equal(edge.counts[6], 1, '-3 ⇒ -5~-3%（正负对称：与 3 同一幅度档的另一侧）')
  assert.equal(edge.counts[7], 1, '-5 ⇒ -7~-5%')
  assert.equal(edge.counts[4], 1, '0 ⇒ 平盘')
  assert.equal(edge.counts[8], 1, '-7 ⇒ ≤-7%')
  assert.equal(DIST_EDGES.length, 7, '阈值表就是 7 / 5 / 3 / 0 / -3 / -5 / -7')
  // 反例注入：把"无涨跌幅"当 0（老毛病）⇒ 平盘档会凭空 +2 ⇒ 这条断言必须失败
  const wrong = (() => {
    const c = [...counts]
    c[4] += blank // 把 blank 当平盘
    return c
  })()
  assert.notDeepEqual(wrong, counts, '⚠ 反例（blank 当平盘）与真实现不同 ⇒ 断言必然抓住它')
  assert.throws(() => assert.deepEqual(wrong, counts, '反例上"不许把 blank 当 0"必须失败'), /反例上/,
    '⚠ 反例注入（无涨跌幅当 0）必须让断言失败')
})

test('② 未取到的格子：常驻只写「未取到」，原因进 title/aria；四处原因必须都在，且不许用 0 顶替', () => {
  const page = strip(read('./MarketPage.tsx'))
  for (const [name, reason] of [
    ['涨停/跌停', 'LIMIT_REASON'],
    ['预测全天', 'FORECAST_REASON'],
    ['两融', 'MARGIN_REASON'],
    ['日内家数', 'INTRADAY_REASON'],
  ] as Array<[string, string]>) {
    const m = new RegExp(`const ${reason} = '([^']+)'`).exec(page)
    assert.ok(m !== null, `${name}的原因常量必须在（${reason}）`)
    assert.ok(m[1].length > 20, `${name}的原因必须说清而不是"未取到"三个字`)
    // v0.81.0 重排后，"未取到"由 `item()`（内联项）与 `legendRow()`（图例行）渲染 ⇒ 原因必须以
    // **调用点实参**的形式出现（`..., ${REASON})` 或 `note: ${REASON}`），不能靠通用兜底掩盖漏传。
    assert.ok(
      // 形态一：`, REASON)`（item/legendRow 实参）；形态二：`note: REASON,`（图例对象）；
      // 形态三：`? REASON`（v0.81.2 起涨停/跌停/预测全天走"有数据 ? 真值 : 未取到+原因"的三元回落）
      new RegExp(`(?:,\\s*${reason}\\)|note:\\s*${reason}\\s*[,}]|\\?\\s*${reason}\\b)`).test(page),
      `${name}的原因必须由一条 item()/legendRow() 调用点实际传入`,
    )
    const uses = page.split(reason).length - 1
    assert.ok(uses >= 2, `${name}的原因常量必须被真正用到（声明 + 至少一处实参；实际出现 ${uses} 次）`)
  }
  // 常驻可见的只有「未取到」四个字（没有把原因铺成正文）：值一律以实参形式给出
  assert.ok(/'未取到'/.test(page), '未取到的常驻文本就是四个字')
  assert.equal(/'未取到'\s*\+/.test(page), false, '常驻里不许把原因拼在"未取到"后面')
  // 反例注入：把预测全天写成编的数 ⇒ 判据必须非空
  // v0.81.2：预测全天接了真值 ⇒ "没数据时"的回落分支就是这里（`forecastCell` 的 else 分支）
  const anchor = "{ value: '未取到', cls: 'tw-dim', note: FORECAST_REASON }"
  assert.ok(page.includes(anchor), '反例锚点必须还在（预测全天没数据时的回落分支）')
  const injected = page.replace(anchor, "{ value: '1.23 万亿', cls: 'tw-dim', note: FORECAST_REASON }")
  assert.notEqual(injected, page, '反例注入必须真改到源码')
  assert.ok(injected.includes("'1.23 万亿'"), '⚠ 反例（编一个预测数）必须能被识别出来')
  assert.throws(
    () => assert.equal(injected.includes(anchor), true, '反例上"必须显示未取到"必须失败'),
    /反例上/,
    '⚠ 反例注入（给预测全天编数）必须让断言失败',
  )
})

test('② 路由：分布是 `/breadth?dist=1` 的可选字段；没扫全 ⇒ counts: null（不给部分分布冒充全市场）', () => {
  const routes = read('../host/routes.ts')
  assert.ok(routes.includes("queryOf(req).get('dist') === '1'"), 'dist 必须是显式开关（别的调用方不付扫描成本）')
  assert.ok(routes.includes('const full = reason === null && total !== null && pcts.length >= total'), '必须判"扫全了没有"')
  assert.ok(routes.includes('counts: full ? bins.counts : null'), '没扫全 ⇒ counts 必须为 null')
  assert.ok(routes.includes('不给部分分布冒充全市场'), '原因文案要写清为什么不给部分分布')
  assert.ok(routes.includes('BREADTH_PAGES_MAX'), '页数上限必须写死（成本可预期）')
  const api = read('./api.ts')
  assert.ok(api.includes("opts.dist === true ? '/tradewatcher/breadth?dist=1'"), '客户端只在需要时才带 dist=1')
})

// ── ③ 护盘：紧凑标记 + 原因可达 ────────────────────────────────────────────

test('③ 护盘提示：常驻只留紧凑标记；长句仍在 title/aria（降级事实不丢）', () => {
  const badge = breakerBadgeOf({
    openHosts: 3, hosts: 3, allOpen: true, minutesLeft: 1, allMinutesLeft: 14,
    closed: false, flowSource: 'tencent', stale: false, fallback: undefined,
  })
  assert.equal(badge.marker, '备用源', '备用源兜底时标记就是「备用源」（≤6 字）')
  assert.ok(badge.marker.length <= 6, `常驻标记必须很短（实际 ${badge.marker.length} 字）`)
  assert.equal(badge.fromAlt, true)
  // 完整原因仍然包含三件事实：熔断台数 / 最早可重试 / 备用源兜底后哪些算不出
  assert.ok(badge.reason.includes('东财行情主机 3/3 台熔断'), '原因要含熔断台数')
  assert.ok(badge.reason.includes('最早约 1 分钟可重试'), '原因要含最早可重试')
  assert.ok(badge.reason.includes('腾讯备用源兜底') && badge.reason.includes('超大单'), '原因要含"备用源兜底 + 超大单无法计算"')
  // 非备用源时标记是熔断台数（不是长句）
  const em = breakerBadgeOf({ openHosts: 1, hosts: 3, allOpen: false, minutesLeft: 5, allMinutesLeft: 9, closed: false, flowSource: 'em', stale: false, fallback: undefined })
  assert.equal(em.marker, '熔断 1/3')
  assert.equal(em.fromAlt, false)
  // 渲染处：常驻孩子必须是 marker，长句只进 title/aria
  const panel = strip(read('./RescuePanel.tsx'))
  // 常驻孩子 = 紧跟在 props 对象之后的那一个参数（长句只许出现在 props 的 title/aria 里）
  // props 对象闭合后紧跟的那一个参数就是常驻孩子（形如 `},\n  badge.marker,\n)`）
  const childAfterProps = /\n\s*\},\s*\n\s*(badge\.\w+),\s*\n\s*\)/
  assert.equal(childAfterProps.exec(panel)?.[1], 'badge.marker', '常驻渲染的必须是 badge.marker')
  assert.equal(childAfterProps.exec(panel)?.[1] === 'badge.reason', false, '⚠ 长句不许作为常驻孩子渲染')
  assert.ok(panel.includes("'aria-label': badge.reason"), '完整原因必须进 aria-label（键盘/触屏可读）')
  assert.ok(/title: \[\s*\n\s*badge\.reason,/.test(panel), '完整原因必须在 title 里（悬停可见）')
  // 反例注入：把长句当常驻孩子 ⇒ 判据必须失败
  const injected = panel.replace('\n        badge.marker,\n', '\n        badge.reason,\n')
  assert.notEqual(injected, panel, '反例注入必须真改到源码')
  assert.equal(childAfterProps.exec(injected)?.[1], 'badge.reason', '⚠ 反例（长句回到常驻）必须能被判据抓住')
  assert.throws(
    () => assert.equal(childAfterProps.exec(injected)?.[1], 'badge.marker', '反例上"常驻必须是标记"必须失败'),
    /反例上/,
    '⚠ 反例注入（长句加回常驻位置）必须让断言失败',
  )
})
