/**
 * v0.81.0（task-51）：【涨跌分布】模块按参考版（Arkvol）重排的结构与红线断言。
 *
 * 参考版结构：左列三段（每段小色条 + 标题）—— 涨跌趋势（**一行 5 个内联统计**）/ 成交量（**一行 4 个内联统计**）/
 * 两融走势（副标题 + 图例行）；右列两块 —— 柱状直方图（**带纵轴与网格线**）/ 日内双序列折线。
 *
 * ⚠ 只做**源码结构 + 纯函数**断言：本仓库的 `node_modules` 里没有 `react`/`react-dom`
 * （客户端半区由宿主提供）⇒ 测试进程里无法真渲染组件。"真渲染"那一层用一次性 harness
 * （`/tmp` + 符号链接的 react）另行验证，见 `docs/AUDIT-IMPL51.md`。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { distAxisOf, distBarPctOf } from './distView.ts'

const here = dirname(fileURLToPath(import.meta.url))
// 分布图的标记已抽到 `distCardRender.tsx`（两处布局共用一棵树）⇒ 结构断言要把渲染层一起读
const page = (): string =>
  readFileSync(join(here, 'MarketPage.tsx'), 'utf8') + '\n' + readFileSync(join(here, 'distCardRender.tsx'), 'utf8')
/** 去注释再断言（注释里会**提到**被删/被禁的字样） */
const strip = (t: string): string => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

// ── ① 结构：两列 / 左三段 / 右两块 ─────────────────────────────────────────

test('① 结构：两列容器 + 左列三段（趋势/成交量/两融）+ 右列两块（涨跌分布/日内家数）', () => {
  const src = strip(page())
  assert.ok(src.includes("'data-role': 'dist-cols', 'data-cols': '2'"), '两列容器必须在（带 data-role/data-cols）')
  // 五个分段：seg(标题, role, …) —— 三个在左列、两个在右列，role 固定
  const segs: Array<[string, string]> = [
    ['涨跌趋势', 'trend'], ['成交量', 'volume'], ['两融走势', 'margin'],
    ['涨跌分布', 'hist'], ['日内家数', 'intraday'],
  ]
  for (const [title, role] of segs) {
    assert.ok(src.includes(`seg('${title}', '${role}'`), `分段「${title}」必须以 seg('${title}', '${role}') 渲染`)
  }
  assert.equal((src.match(/seg\('/g) ?? []).length, segs.length, '分段恰好五个（不多不少）')
  // 左右两列各一个 tw-dist-col；右列必须包含 hist 与 intraday
  const cols = src.split("className: 'tw-dist-col'").length - 1
  assert.equal(cols, 2, `两列各一个 tw-dist-col（实际 ${cols} 个）`)
  const histIdx = src.indexOf("seg('涨跌分布', 'hist'")
  const intraIdx = src.indexOf("seg('日内家数', 'intraday'")
  const colIdx = src.lastIndexOf("className: 'tw-dist-col'", histIdx)
  assert.ok(colIdx > 0 && colIdx < histIdx && histIdx < intraIdx, 'hist 与 intraday 必须同处右列、且顺序为 分布→日内')
})

// ── ② 涨跌趋势是内联行，不是大磁贴 ─────────────────────────────────────────

test('② 涨跌趋势：一行 5 个**内联**统计（不再渲染大磁贴）；反例注入（还原磁贴）必败', () => {
  const src = strip(page())
  const start = src.indexOf("seg('涨跌趋势', 'trend'")
  const end = src.indexOf("seg('成交量', 'volume'")
  assert.ok(start > 0 && end > start, '涨跌趋势那一段必须存在')
  const trend = src.slice(start, end)
  // 内联：本段必须用 inline(...) 渲染，且**不得**出现磁贴类名/构造器
  assert.ok(trend.includes('inline('), '涨跌趋势必须用内联行渲染')
  for (const tile of ['tw-statrow', 'tw-stat ', "className: 'tw-stat'", 'statCell(']) {
    assert.equal(trend.includes(tile), false, `涨跌趋势不该再出现磁贴写法：${tile}`)
  }
  // 一行 5 个内联统计：上涨/平盘/下跌/涨停/跌停
  for (const k of ['上涨', '平盘', '下跌', '涨停', '跌停']) {
    assert.ok(new RegExp(`item\\(\\s*'${k}'`).test(trend), `内联项「${k}」必须在涨跌趋势段里`)
  }
  // 只数**第一行**（后面的内联行是"上涨占比 + 样本/快照"那行小字，不属于这 5 个）
  // 第一行 = 从第一个 inline( 到第二个 inline( 之间（第二个是"上涨占比 + 样本/快照"那行小字）
  const i1 = trend.indexOf('inline(')
  const i2 = trend.indexOf('inline(', i1 + 1)
  const firstRow = trend.slice(i1, i2)
  assert.equal((firstRow.match(/item\(/g) ?? []).length, 5, '这一行恰好 5 个内联项（多行 item(...) 也算）')
  assert.ok(trend.includes("item('上涨占比'"), '上涨占比那行小字必须保留（用户决定）')
  // 反例注入：把内联行换回磁贴 ⇒ 判据必须非空
  const injected = src.slice(0, start) + trend.replace('inline(', "React.createElement('div', { className: 'tw-statrow' },") + src.slice(end)
  const injectedTrend = injected.slice(start, injected.indexOf("seg('成交量', 'volume'"))
  assert.notEqual(injected, src, '反例注入必须真改到源码')
  assert.ok(injectedTrend.includes('tw-statrow'), '⚠ 反例（还原磁贴）必须能被判据抓住')
  assert.throws(
    () => assert.equal(injectedTrend.includes('tw-statrow'), false, '反例上"不该有磁贴"必须失败'),
    /反例上/,
    '⚠ 反例注入（还原磁贴）必须让断言失败',
  )
})

test('②b 成交量：一行 4 个内联统计（当日/昨日/较昨日/预测），变动带涨跌色', () => {
  const src = strip(page())
  const start = src.indexOf("seg('成交量', 'volume'")
  const end = src.indexOf("seg('两融走势', 'margin'")
  const vol = src.slice(start, end)
  for (const k of ['当日成交额', '昨日成交', '较昨日变动', '预测全天']) {
    assert.ok(new RegExp(`item\\(\\s*'${k}'`).test(vol), `内联项「${k}」必须在成交量段里`)
  }
  assert.equal((vol.match(/item\(/g) ?? []).length, 4, '这一行恰好 4 个内联项（预测全天已是行外预算，不再多一个）')
  assert.ok(/delta >= 0 \? \(redUp \? 'tw-up' : 'tw-down'\)/.test(vol), '「较昨日变动」必须按涨跌色（跟随 redUp）着色')
  assert.equal(vol.includes('tw-dist-kv'), false, '成交量不该再用"竖排列表"写法')
})

// ── ③ 无源项仍是「未取到」+ 原因 ───────────────────────────────────────────

test('③ 无源项：常驻只写「未取到」，原因进 title/aria（不许渲染成 0 或 —）；反例注入必败', () => {
  const src = strip(page())
  // 六处无源项（涨停/跌停/昨日成交/较昨日变动/预测全天/两融/日内），逐项要求"未取到 + 同调用点的原因"
  const expects: Array<[string, string]> = [
    // v0.81.2：涨停/跌停/预测全天已接真值 ⇒ 判据改成"**缺数时**回落未取到 + 原因"
    ["extras.limits.up.count === null ? '未取到'", 'LIMIT_REASON'],
    ["extras.limits.down.count === null ? '未取到'", 'LIMIT_REASON'],
    ["{ value: '未取到', cls: 'tw-dim', note: FORECAST_REASON }", 'FORECAST_REASON'],
    ["{ value: '未取到', note: MARGIN_REASON }", 'MARGIN_REASON'],
    ["value: '未取到', note: INTRADAY_REASON", 'INTRADAY_REASON'],
  ]
  for (const [snippet, reason] of expects) {
    assert.ok(src.includes(snippet), `无源项必须以「未取到」渲染：${snippet}`)
    const near = src.slice(Math.max(0, src.indexOf(snippet) - 200), src.indexOf(snippet) + 260)
    assert.ok(near.includes(reason), `同一调用点必须带上原因常量 ${reason}`)
  }
  // 昨日成交/较昨日变动在无快照时也是「未取到」
  assert.ok(/item\('昨日成交', prevAmt === null \? '未取到'/.test(src), '昨日成交缺快照 ⇒ 未取到')
  assert.ok(/item\('较昨日变动', delta === null \? '未取到'/.test(src), '较昨日变动缺昨日 ⇒ 未取到')
  // 反例注入：把某一项渲染成 0 ⇒ 判据必须非空
  const anchor = "{ value: '未取到', cls: 'tw-dim', note: FORECAST_REASON }"
  const injected = src.replace(anchor, "{ value: '0', cls: 'tw-dim', note: FORECAST_REASON }")
  assert.notEqual(injected, src, '反例注入必须真改到源码')
  assert.equal(injected.includes(anchor), false, '⚠ 反例（渲染成 0）必须能被判据抓住')
  assert.throws(
    () => assert.equal(injected.includes(anchor), true, '反例上"必须显示未取到"必须失败'),
    /反例上/,
    '⚠ 反例注入（渲染成 0）必须让断言失败',
  )
})

// ── ④ 直方图：纵轴 + 网格线 ───────────────────────────────────────────────

test('④ 直方图：纵轴刻度与网格线必须渲染；值域按数据取整；反例注入（去掉纵轴）必败', () => {
  const src = strip(page())
  assert.ok(src.includes("'data-role': 'dist-axis'"), '纵轴容器必须渲染（data-role=dist-axis）')
  assert.ok(src.includes("'data-role': 'dist-ytick'"), '纵轴刻度必须渲染')
  assert.ok(src.includes("'data-role': 'dist-gridline'"), '网格线必须渲染')
  assert.ok(src.includes('distAxisOf(d.counts)'), '轴值域必须由数据算出（纯函数）')
  assert.ok(src.includes('distBarPctOf('), '柱高必须按轴的上界换算（与网格线对齐）')
  // 纯函数语义：4 条上下的整洁刻度、含 0、上界 ≥ 峰值、比例 ≤ 100
  const a = distAxisOf([1234, 900, 300])
  assert.equal(a.ticks[0], 0, '刻度必须含 0')
  assert.ok(a.max >= 1234, `上界必须 ≥ 峰值（实际 ${a.max}）`)
  for (const t of a.ticks) assert.equal(t % (a.ticks[1] - a.ticks[0]), 0, `刻度必须是整洁步长的整数倍（${t}）`)
  assert.ok(distBarPctOf(1234, a.max) <= 100 && distBarPctOf(1234, a.max) > 50, '峰值柱的高度应在 50%~100% 之间')
  assert.equal(distBarPctOf(0, a.max), 0, '计数 0 ⇒ 柱高 0（不是 1 或 NaN）')
  assert.deepEqual(distAxisOf([0, 0]).ticks, [0, 1], '全 0 数据给最小可用轴（不崩）')
  // 反例注入：去掉纵轴 ⇒ 判据必须非空
  const injected = src.replace("'data-role': 'dist-axis'", "'data-role': 'x'")
  assert.notEqual(injected, src, '反例注入必须真改到源码')
  assert.equal(injected.includes("'data-role': 'dist-axis'"), false, '⚠ 反例（无纵轴）必须能被判据抓住')
  assert.throws(
    () => assert.equal(injected.includes("'data-role': 'dist-axis'"), true, '反例上"必须有纵轴"必须失败'),
    /反例上/,
    '⚠ 反例注入（去掉纵轴）必须让断言失败',
  )
})

// ── ⑤ 指数表移出本模块（仍可达）────────────────────────────────────────────

test('⑤ 【指数行情】模块已整块删除：页内没有该标题/表格结构/数据取用；反例注入（加回）必败', () => {
  const src = strip(page())
  // 只认**该块独有**的痕迹（`tw-table`/`幅度`/`成交额` 这类是板块/资金/ETF 表**共用**的，不能当依据）
  for (const gone of ["'t' }, '指数行情'", 'index-table', 'cnIndices', '点行看详情', 'minWidth: 560']) {
    assert.equal(src.includes(gone), false, `已删模块的独有痕迹必须清干净：${gone}`)
  }
  // 但"点行看详情"的通路不能跟着消失：板块/资金/ETF 表仍在用它
  assert.ok(src.includes('openDetail'), 'openDetail 仍被板块/资金/ETF 表使用（不是这张表的专属接线）')
  assert.ok(src.includes("'板块 / 资金 / ETF'"), '板块/资金/ETF 区块必须仍在')
  // 反例注入：把已删模块加回 ⇒ 判据必须非空
  const injected = src.replace("React.createElement(RescuePanel",
    "React.createElement('div', { 'data-role': 'index-table' }, '指数行情'),\n    React.createElement(RescuePanel")
  assert.notEqual(injected, src, '反例注入必须真改到源码')
  assert.ok(injected.includes('index-table'), '⚠ 反例（加回模块）必须能被判据抓住')
  assert.throws(
    () => assert.equal(injected.includes('index-table'), false, '反例上"不该有 index-table"必须失败'),
    /反例上/,
    '⚠ 反例注入（加回指数表）必须让断言失败',
  )
})

// ── ⑥ 样式必须在（标记 ↔ 样式一一对应，避免"写了类名但没样式"）─────────────

test('⑥ 重排用到的样式类都在 styles.ts 里（标记与样式不许脱节）；反例注入（删样式）必败', () => {
  const src = strip(page())
  const css = readFileSync(join(here, 'styles.ts'), 'utf8')
  const used = [
    'tw-dist-seg', 'tw-dist-seg-bar', 'tw-dist-seg-t', 'tw-dist-seg-sub',
    'tw-dist-inline', 'tw-dist-legend', 'tw-dist-chart', 'tw-dist-axis', 'tw-dist-grid',
  ]
  for (const cls of used) {
    assert.ok(src.includes(`'${cls}'`) || src.includes(`tw-dist-inline`) && cls === 'tw-dist-inline',
      `标记里必须用到 ${cls}`)
    assert.ok(new RegExp(`\\.${cls}[\\s{,.:]`).test(css), `styles.ts 里必须有 .${cls} 的样式`)
  }
  // 反例注入：把纵轴样式删掉 ⇒ 判据必须非空
  const injected = css.replace('.tw-dist-axis{', '.tw-dist-axis-x{')
  assert.notEqual(injected, css, '反例注入必须真改到源码')
  assert.equal(/\\.tw-dist-axis[\\s{,.:]/.test(injected), false, '⚠ 反例（纵轴无样式）必须能被判据抓住')
  assert.throws(
    () => assert.equal(/\\.tw-dist-axis[\\s{,.:]/.test(injected), true, '反例上"必须有样式"必须失败'),
    /反例上/,
    '⚠ 反例注入（删掉纵轴样式）必须让断言失败',
  )
})

// ── ①b 上证/深成两张大卡：直接删除（用户决定），且**不再以任何形式回填** ────

test('①b 「上证/深成」两张大卡不再渲染，页内也不得再出现这两个值；反例注入（加回）必败', () => {
  const src = strip(page())
  const start = src.indexOf("seg('涨跌趋势', 'trend'")
  const end = src.indexOf("seg('成交量', 'volume'")
  const trend = src.slice(start, end)
  // 趋势段内不得再有 上证/深成 的内联项（"并入"也被用户否掉了）
  assert.equal(trend.includes("item('上证'"), false, '「上证」卡不得再渲染（用户决定：直接删除）')
  assert.equal(trend.includes("item('深成'"), false, '「深成」卡不得再渲染（用户决定：直接删除）')
  // 全页范围内也不该再有这两张卡（磁贴/内联都不行）
  for (const doomed of ["item('上证'", "item('深成'", 'tw-statrow']) {
    assert.equal(src.includes(doomed), false, `全页不该再出现：${doomed}`)
  }
  // v0.81.1：原来"值在指数表里仍可见"这条退路也没了（【指数行情】模块已删）⇒
  // 这两个值在页内**彻底不再出现** —— 这正是用户要的结果，**不许**回填（见 ⑤）
  assert.equal(src.includes('1.000001'), true, '（1.000001 仍被 breadthCells 用着，是另一件事）')
  assert.equal(/item\(['"]上证指数['"]/.test(src), false, '不得以"上证指数"为名回填这一格')
  // 反例注入：把「上证」卡加回趋势段 ⇒ 判据必须非空
  const card = "item('上证', fmtPrice(1), 'dir', 'x')"
  const injected = src.replace("seg('涨跌趋势', 'trend'", `seg('涨跌趋势', 'trend', ${card}`)
  assert.notEqual(injected, src, '反例注入必须真改到源码')
  const injTrend = injected.slice(injected.indexOf("seg('涨跌趋势', 'trend'"), injected.indexOf("seg('成交量', 'volume'"))
  assert.ok(injTrend.includes("item('上证'"), '⚠ 反例（加回大卡）必须能被判据抓住')
  assert.throws(
    () => assert.equal(injTrend.includes("item('上证'"), false, '反例上"不该有大卡"必须失败'),
    /反例上/,
    '⚠ 反例注入（加回两张大卡）必须让断言失败',
  )
})
