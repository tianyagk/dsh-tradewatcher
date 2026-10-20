/**
 * 杠杆温度计 · **图 1 结构六项**的可检查判据（R2 批）。
 *
 * 用户反馈：界面与参考图 1 差距过大 ⇒ 六项**结构性**修正（都不改口径）：
 *   ① 主图占屏比（绘图区约占整页 55–60%）
 *   ② 阈值线**右端彩色胶囊**标签（脱离左轴刻度，不再与 `100` 叠字）
 *   ③ 悬停**紧凑读数框**（该日 温度 / 显性融资比例 / 净买入 三个数；无十字光标、无解释文字）
 *   ④ X 轴 **≥ 6 个**等距刻度（按窗口自动选月 / 季度 / 半年 / 年）
 *   ⑤ 水平**网格线**（每 25 一个温度刻度、浅色虚线、不标文字）
 *   ⑥ 底部柱区**独立小轴**（只在零轴两侧给最大 / 最小值）+ 柱宽自适应
 *
 * 仓库惯例：**纯函数判据 + 反例注入**（每条注入都必须让判据非空）。判据的唯一实现在
 * `tools/leverageView.ts`（`leveragePlotHeightProblems` / `leverageChartProblems`），本文件只驱动它们。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { LeveragePayloadDto } from './api.ts'
import {
  LEVERAGE_HEIGHT_MIN_PX,
  LEVERAGE_PLOT_HEIGHT,
  LEVERAGE_REFERENCE_VIEWPORT_PX,
  leverageChart,
  leverageChartProblems,
  leveragePlotHeightProblems,
  leverageReadout,
} from './tools/leverageView.ts'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const read = (rel: string): string => readFileSync(join(ROOT, 'src/client', rel), 'utf8')
const strip = (src: string): string => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1')
const PAGE = 'leveragePage.tsx'

/**
 * 造一条 n 天的假序列（只用于几何判据，不是"看起来像真数据"的假读数）：
 * 温度在 30–95 之间来回、比例 1.9–3.1、净买入正负交替且每 17 天缺一次（缺值不得画柱）。
 */
function longFixture(n: number): LeveragePayloadDto {
  const dates: string[] = []
  const temp: Array<number | null> = []
  const ratio: Array<number | null> = []
  const net: Array<number | null> = []
  const start = Date.UTC(2023, 0, 2)
  for (let i = 0; i < n; i += 1) {
    const d = new Date(start + i * 86400000)
    dates.push(d.toISOString().slice(0, 10))
    temp.push(30 + ((i * 7) % 66))
    ratio.push(1.9 + ((i % 121) / 100))
    net.push(i % 17 === 0 ? null : (i % 2 === 0 ? 1 : -1) * (1e8 + (i % 13) * 5e7))
  }
  return {
    asOf: dates[dates.length - 1] as string,
    temperature: 91.2,
    ratioPct: 2.65,
    ratioWithShortPct: 2.69,
    marginBalance: 2.45e12,
    shortBalance: 2.9e10,
    floatMv: 9.24e13,
    netBuy: -6.3e9,
    thresholds: { p80: 80, p95: 95 },
    dates,
    temp,
    ratio,
    net,
  }
}

/* ────────────────────────────── ① 主图占屏比 ────────────────────────────── */

test('① 主图高度 ≥ 阈值（图层占整页 55–60%）—— 注入写死 300px 必败', () => {
  // 契约本身必须过判据
  assert.deepEqual(leveragePlotHeightProblems(LEVERAGE_PLOT_HEIGHT), [], `高度契约不合规：${leveragePlotHeightProblems(LEVERAGE_PLOT_HEIGHT).join(' ／ ')}`)
  assert.equal(LEVERAGE_PLOT_HEIGHT, 'min(58vh, 520px)')
  // 参考视口（900px 高）下的**有效高度**必须 ≥ 下限
  const effective = Math.min((58 / 100) * LEVERAGE_REFERENCE_VIEWPORT_PX, 520)
  assert.ok(effective >= LEVERAGE_HEIGHT_MIN_PX, `参考视口下有效高度 ${effective}px 必须 ≥ ${LEVERAGE_HEIGHT_MIN_PX}px`)
  // 页面真的用它（绘图区 + 骨架两处）
  const page = strip(read(PAGE))
  assert.equal((page.match(/height:\s*LEVERAGE_PLOT_HEIGHT/g) ?? []).length, 2, '绘图区与加载骨架都必须走同一条高度契约')
  // 注入 ①：写死 300px ⇒ 必败
  const fixed = leveragePlotHeightProblems('300px')
  assert.notDeepEqual(fixed, [], '⚠ 反例（写死 300px）必须被抓住')
  assert.match(fixed.join(' ／'), /写死像素|低于下限/, `⚠ 报的原因要能指认"写死像素"：${fixed.join(' ／ ')}`)
  // 注入 ②：视口比例不够（40vh）⇒ 即使像素上限够也必败
  const lowVh = leveragePlotHeightProblems('min(40vh, 520px)')
  assert.notDeepEqual(lowVh, [], '⚠ 反例（40vh）必须被抓住')
  assert.match(lowVh.join(' ／'), /视口比例|低于下限/, `⚠ 报的原因要能指认"占屏比不够"：${lowVh.join(' ／ ')}`)
  // 注入 ③：像素上限不够（min(58vh, 300px)）⇒ 必败
  assert.match(leveragePlotHeightProblems('min(58vh, 300px)').join(' ／'), /像素上限/, '⚠ 反例（上限 300px）必须被抓住')
  // clamp 形态也接受（上下界都要够）
  assert.deepEqual(leveragePlotHeightProblems('clamp(320px, 58vh, 520px)'), [], 'clamp(320px, 58vh, 520px) 应当合规')
})

/* ────────────────────────────── ② 阈值右端胶囊 ────────────────────────────── */

test('② 阈值标签在**右端胶囊**里、不与左轴刻度重叠 —— 注入放回左轴必败', () => {
  const payload = longFixture(750)
  const chart = leverageChart(payload, 1200, 520)
  assert.deepEqual(leverageChartProblems(chart, payload), [], `主图结构必须自洽：${leverageChartProblems(chart, payload).join(' ／ ')}`)
  const caps = chart.capsules.filter((c) => c.role === 'threshold-capsule')
  const labels = chart.texts.filter((t) => t.role === 'threshold-label')
  const leftTicks = chart.texts.filter((t) => t.role === 'left-tick')
  assert.equal(caps.length, 2, '两条阈值线各一个胶囊')
  assert.deepEqual(labels.map((t) => t.text), ['80', '95'], '胶囊里只有数字')
  const plotRight = 1200 - 58
  for (const cap of caps) {
    assert.ok(cap.x + cap.w >= plotRight - 4, `胶囊必须右端对齐（实得 x+w=${Math.round(cap.x + cap.w)} / 右缘=${plotRight}）`)
    // 与左轴刻度的最小间距：至少 200px（完全脱离左轴，不可能叠字）
    for (const tick of leftTicks) assert.ok(cap.x - tick.x >= 200, `胶囊与左轴刻度至少隔 200px（实得 ${Math.round(cap.x - tick.x)}px）`)
  }
  // 每个数字都落在自己的胶囊里（几何包含关系，而不是靠"看起来在右边"）
  for (const label of labels) {
    assert.equal(caps.some((c) => label.y >= c.y && label.y <= c.y + c.h && label.x >= c.x && label.x <= c.x + c.w), true, `阈值数字 ${label.text} 必须写在胶囊里`)
  }
  // 注入 ①：胶囊挪回左轴旁 ⇒ 必败，且原因要能指认"贴在左轴"
  const capLeft = { ...chart, capsules: caps.map((c) => ({ ...c, x: 40 })) }
  assert.match(leverageChartProblems(capLeft, payload).join(' ／'), /不许贴在左轴旁|必须右端|必须写在胶囊里/, '⚠ 反例（胶囊放回左轴）必须被抓住')
  // 注入 ②：只把数字挪回左轴（胶囊留在右端）⇒ 必败
  const labelLeft = { ...chart, texts: chart.texts.map((t) => (t.role === 'threshold-label' ? { ...t, x: 40 } : t)) }
  assert.match(leverageChartProblems(labelLeft, payload).join(' ／'), /必须写在胶囊里/, '⚠ 反例（数字放回左轴）必须被抓住')
})

/* ────────────────────────────── ③ 悬停读数框 ────────────────────────────── */

/** 读数框接线判据（唯一实现）：页面必须渲染它、必须有鼠标事件、且不许有十字光标。返回失败原因。 */
function readoutWiringProblems(pageSrc: string): string[] {
  const bad: string[] = []
  const page = strip(pageSrc)
  const need = (cond: boolean, msg: string): void => {
    if (!cond) bad.push(msg)
  }
  need(page.includes("'data-role': 'leverage-readout'"), '悬停必须有读数框（data-role="leverage-readout"）')
  need(page.includes('onMouseMove'), '读数框必须跟随鼠标（onMouseMove）')
  need(page.includes('onMouseLeave'), '移出画布必须收起读数框（onMouseLeave）')
  need(page.includes('leverageReadout('), '读数必须来自模型 leverageReadout()（页面不许自己拼三个数）')
  need(page.includes('leverageIndexAt('), '取点必须走 leverageIndexAt()（与主图同一套 x 映射）')
  need(page.includes('readout.rows.map('), '读数框必须逐行渲染三个数（readout.rows）')
  for (const gone of ['tool-crosshair', 'leverage-crosshair', 'tool-hover-tip']) {
    need(page.includes(gone) === false, `读数框旁边不许有十字光标/旧浮框：${gone}`)
  }
  return bad
}

test('③ 悬停读数框存在且含三个数（温度 / 比例 / 净买入）—— 注入删掉必败', () => {
  const payload = longFixture(750)
  const readout = leverageReadout(payload, 10)
  assert.notEqual(readout, null)
  assert.equal(readout?.rows.length, 3, '读数框是三个数（不加第四行）')
  assert.deepEqual(readout?.rows.map((r) => r.name), ['温度', '显性融资比例', '净买入'], '三行分别是温度 / 比例 / 净买入')
  // 数值格式与卡片同一套格式化（缺值仍是 `—`）
  for (const row of readout?.rows ?? []) assert.equal(/^([+-]?\d+\.\d+%?|—|[+-]?\d+\.\d{2} (?:亿|万亿))$/.test(row.text), true, `读数必须是数值或 —：${row.text}`)
  assert.match(readout?.rows[0]?.text ?? '', /^\d+\.\d$/, '温度 1 位小数')
  assert.match(readout?.rows[1]?.text ?? '', /^\d+\.\d{2}%$/, '比例 2 位小数 %')
  assert.match(readout?.rows[2]?.text ?? '', /^[+-]?\d+\.\d{2} (?:亿|万亿)$/, '净买入 亿/万亿 + 符号')
  // 页面接线
  assert.deepEqual(readoutWiringProblems(read(PAGE)), [], `读数框接线未通过：${readoutWiringProblems(read(PAGE)).join(' ／ ')}`)
  // 注入：删掉读数框 ⇒ 必败
  const noReadout = read(PAGE).split("'data-role': 'leverage-readout'").join("'data-role': 'leverage-x'")
  assert.notEqual(noReadout, read(PAGE), '注入必须真的改到了源码')
  assert.match(readoutWiringProblems(noReadout).join(' ／'), /读数框/, '⚠ 反例（删读数框）必须被抓住')
  // 注入：把十字光标加回来 ⇒ 必败
  const withCross = `${read(PAGE)}\nconst _cross = { 'data-role': 'tool-crosshair' }\n`
  assert.match(readoutWiringProblems(withCross).join(' ／'), /十字光标/, '⚠ 反例（加回十字光标）必须被抓住')
})

/* ────────────────────────────── ④ X 轴多刻度 ────────────────────────────── */

test('④ X 轴刻度 ≥ 6（按窗口自动选月/季度）—— 注入只给首末必败', () => {
  for (const n of [120, 250, 750, 4018]) {
    const payload = longFixture(n)
    const chart = leverageChart(payload, 1200, 520)
    const ticks = chart.texts.filter((t) => t.role === 'x-tick')
    assert.ok(ticks.length >= 6, `窗口 ${n} 天的 X 轴必须有 ≥ 6 个刻度（实得 ${ticks.length}）`)
    assert.ok(ticks.length <= 10, `窗口 ${n} 天的 X 轴不许挤到 10 个以上（实得 ${ticks.length}）`)
    for (const t of ticks) assert.match(t.text, /^\d{4}-\d{2}$/, `刻度标签必须是年月：${t.text}`)
    // 递增、落在绘图区内、且**相邻间距相同**（"等距"是图 1 的结构特征，不是大概齐）
    for (let i = 1; i < ticks.length; i += 1) assert.ok((ticks[i]?.x ?? 0) > (ticks[i - 1]?.x ?? 0), '刻度必须按时间递增')
    const gaps = ticks.slice(1).map((t, i) => Number(((t.x - (ticks[i] as { x: number }).x) as number).toFixed(2)))
    const spread = Math.max(...gaps) - Math.min(...gaps)
    assert.ok(spread <= 0.5, `X 轴刻度必须等距（实得间距 ${JSON.stringify(gaps)}）`)
    // 个数随窗口变：一年 7 / 三年 8 / 全历史 9（步长自然落成 月 / 季度 / 年）
    if (n === 250) assert.equal(ticks.length, 7, '一年窗口 7 个刻度')
    if (n === 750) assert.equal(ticks.length, 8, '三年窗口 8 个刻度')
    if (n === 4018) assert.equal(ticks.length, 9, '全历史 9 个刻度')
    assert.deepEqual(leverageChartProblems(chart, payload), [], `窗口 ${n} 天的主图结构必须自洽`)
  }
  // 注入：只给首末两个刻度 ⇒ 必败
  const payload = longFixture(750)
  const chart = leverageChart(payload, 1200, 520)
  const ticks = chart.texts.filter((t) => t.role === 'x-tick')
  const keep = new Set([ticks[0]?.text, ticks[ticks.length - 1]?.text])
  const two = { ...chart, texts: chart.texts.filter((t) => t.role !== 'x-tick' || keep.has(t.text)) }
  const problems = leverageChartProblems(two, payload)
  assert.notDeepEqual(problems, [], '⚠ 反例（只给首末）必须被抓住')
  assert.match(problems.join(' ／'), /X 轴刻度必须 ≥ 6/, `⚠ 报的原因要能指认刻度数量：${problems.join(' ／ ')}`)
})

/* ────────────────────────────── ⑤ 水平网格线 ────────────────────────────── */

test('⑤ 水平网格线存在（每 25 一个温度刻度、浅色虚线、不标文字）—— 注入删掉必败', () => {
  const payload = longFixture(750)
  const chart = leverageChart(payload, 1200, 520)
  const grid = chart.lines.filter((l) => l.role === 'grid')
  assert.equal(grid.length, 5, '每 25 一个温度刻度 ⇒ 0 / 25 / 50 / 75 / 100 共五条')
  for (const g of grid) {
    assert.equal(g.dash, true, '网格线必须是虚线（浅色）')
    assert.equal(g.color, 'var(--tw-border)', '网格线颜色必须走主题 token')
    assert.equal(g.x1 < g.x2, true, '网格线必须横跨绘图区')
  }
  // 等距（相邻 y 差相同 ⇒ 真的是"每 25 一格"）
  const ys = grid.map((g) => g.y1)
  const gaps = ys.slice(1).map((y, i) => Number((y - (ys[i] as number)).toFixed(4)))
  assert.equal(new Set(gaps).size, 1, `网格线必须等距（实得间距 ${JSON.stringify(gaps)}）`)
  // 不标文字：模型里没有网格文本角色（文字角色白名单在判据里）
  assert.equal(chart.texts.some((t) => (t.role as string) === 'grid-label'), false, '网格线不标文字')
  // 注入 ①：删掉网格线 ⇒ 必败
  const noGrid = { ...chart, lines: chart.lines.filter((l) => l.role !== 'grid') }
  assert.match(leverageChartProblems(noGrid, payload).join(' ／'), /水平网格线必须每 25/, '⚠ 反例（删网格）必须被抓住')
  // 注入 ②：网格线改实线 ⇒ 必败
  const solid = { ...chart, lines: chart.lines.map((l) => (l.role === 'grid' ? { ...l, dash: false } : l)) }
  assert.match(leverageChartProblems(solid, payload).join(' ／'), /浅色虚线/, '⚠ 反例（实线网格）必须被抓住')
  // 注入 ③：给网格线加文字 ⇒ 必败（文字角色白名单）
  const withLabel = { ...chart, texts: [...chart.texts, { role: 'grid-label' as never, x: 100, y: 100, text: '25', anchor: 'start' as const }] }
  assert.match(leverageChartProblems(withLabel, payload).join(' ／'), /文字只允许/, '⚠ 反例（网格加文字）必须被抓住')
})

/* ────────────────────────────── ⑥ 柱区独立刻度 ────────────────────────────── */

test('⑥ 柱区独立小轴（零轴两侧最大/最小）+ 柱宽自适应 —— 注入删掉必败', () => {
  const payload = longFixture(750)
  const chart = leverageChart(payload, 1200, 520)
  const barMax = chart.texts.filter((t) => t.role === 'bar-max')
  const barMin = chart.texts.filter((t) => t.role === 'bar-min')
  assert.equal(barMax.length, 1, '柱区上界只有一个数字')
  assert.equal(barMin.length, 1, '柱区下界只有一个数字')
  for (const t of [...barMax, ...barMin]) assert.match(t.text, /^[+-]?\d+\.\d{2} (?:亿|万亿)$/, `柱区刻度必须是金额：${t.text}`)
  // 上下界的位置：一个在柱区顶、一个在柱区底（都贴着左内边距，anchor=end）
  const zero = chart.lines.find((l) => l.role === 'zero')
  assert.notEqual(zero, undefined, '有柱必须有零轴')
  assert.ok((barMax[0]?.y ?? 0) < (zero?.y1 ?? 0), '上界必须在零轴上方')
  assert.ok((barMin[0]?.y ?? 0) > (zero?.y1 ?? 0) - 1, '下界必须在零轴下方（或重合）')
  assert.equal(barMax[0]?.anchor, 'end', '柱区刻度必须右对齐到左内边距')
  // 柱宽自适应：短窗口最粗 6px、长窗口细到亚像素但 > 0
  const short = leverageChart(longFixture(30), 1200, 520)
  const long = leverageChart(payload, 1200, 520)
  const wShort = short.bars[0]?.w ?? 0
  const wLong = long.bars[0]?.w ?? 0
  assert.ok(wShort > wLong, `短窗口的柱必须比长窗口粗（实得 ${wShort} / ${wLong}）`)
  assert.ok(wShort <= 6.01 && wLong > 0, `柱宽必须有上下界（实得 ${wShort} / ${wLong}）`)
  // 注入 ①：删掉柱区小轴 ⇒ 必败
  const noAxis = { ...chart, texts: chart.texts.filter((t) => t.role !== 'bar-max' && t.role !== 'bar-min') }
  assert.match(leverageChartProblems(noAxis, payload).join(' ／'), /柱区必须有独立的/, '⚠ 反例（删柱区小轴）必须被抓住')
  // 注入 ②：柱宽改成"窗口越长越粗"（不设上限）⇒ 必败
  const fatBars = { ...chart, bars: chart.bars.map((b) => ({ ...b, w: 18 })) }
  assert.match(leverageChartProblems(fatBars, payload).join(' ／'), /柱宽必须自适应/, '⚠ 反例（柱宽不设上限）必须被抓住')
})
