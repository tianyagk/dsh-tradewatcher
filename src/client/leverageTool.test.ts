/**
 * 工具箱第二个工具「杠杆温度计」的**客户端**可检查判据。
 *
 * 用户口径（页面规格九条，逐条对应下面的用例）：目录项与副标题 / 大字与唯一的 `截至` / 三张卡 /
 * 双轴与两条线与阈值数字 / 缺值 `—` / 窗口只换参数 / 无口径长文案 / 无网格线无浮框 / 字号与间距合规。
 *
 * 仓库惯例：**真源码 + 纯函数 + 反例注入**（每条注入都必须让判据非空 / 断言抛错）。
 * 页面渲染层没有 DOM 测试环境（devDependencies 里没有 jsdom）⇒ 渲染行为下沉到
 * `tools/leverageView.ts` 的纯函数（页面只渲染它），页面本身用**源码接线断言**（与本仓库其它页面同款）。
 *
 * 报告：`docs/AUDIT-LEVERAGE-UI.md`（宿主侧是 `docs/AUDIT-LEVERAGE-HOST.md`）。
 * （文件名：`AUDIT-IMPL*` 的编号已用到 `IMPL88`，任务书写的 `AUDIT-IMPL81` 也被历史审计占用 ⇒
 *  按 Lead 口径改用描述式文件名，**未覆盖任何既有审计文档**。）
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { LeveragePayloadDto } from './api.ts'
import { TOOL_ENTRIES, catalogModel } from './toolRegistry.ts'
import {
  CARD_SURFACE,
  CHART_STACK,
  CHART_TYPE,
  LEGEND_DOT,
  LEGEND_ROW,
  PLOT,
  RANGE_BOX,
  RANGE_OFF,
  RANGE_ON,
  RANGE_TYPE,
  SUMMARY_TYPE,
  TOOL_SPACE,
  typeScaleProblems,
  spaceScaleProblems,
} from './toolDetailTheme.ts'
import { leverageTool } from './tools/leverage.ts'
import {
  DASH,
  LEVERAGE_DEFAULT_RANGE,
  LEVERAGE_PLOT_HEIGHT,
  LEVERAGE_LEGEND,
  LEVERAGE_RANGES,
  fmtNetYi,
  fmtRatioPct,
  fmtTemperature,
  leverageAsOfText,
  leverageCards,
  leverageChart,
  leverageChartProblems,
  leverageReadout,
  netBarColor,
} from './tools/leverageView.ts'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const read = (rel: string): string => readFileSync(join(ROOT, 'src/client', rel), 'utf8')
const strip = (src: string): string => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1')
const stripImports = (src: string): string => src.replace(/^import[\s\S]*?from '[^']+'\n/gm, '').replace(/^import '[^']+'\n/gm, '')

const PAGE = 'leveragePage.tsx'
const VIEW = 'tools/leverageView.ts'

/**
 * 断言用的固定载荷（形状 = 冻结契约；数值取 `docs/PROBE-LEVERAGE.md` 的实测读数）。
 * 序列里**故意留两个 `null`**：温度序列第 2 天缺、净买入第 2 天缺 —— 缺口行为要能被断言。
 */
function fixture(over: Partial<LeveragePayloadDto> = {}): LeveragePayloadDto {
  return {
    asOf: '2026-10-19',
    temperature: 91.234,
    ratioPct: 2.654682,
    ratioWithShortPct: 2.6862,
    marginBalance: 2453374239917,
    shortBalance: 29167627323,
    floatMv: 92416865855823.71,
    netBuy: -6331355686,
    thresholds: { p80: 80, p95: 95 },
    dates: ['2026-10-15', '2026-10-16', '2026-10-19'],
    temp: [88.2, null, 91.234],
    ratio: [2.61, 2.63, 2.654682],
    net: [1.2e9, null, -6331355686],
    ...over,
  }
}

/* ────────────────────────────── ① 目录项 ────────────────────────────── */

test('① 目录出现「杠杆温度计」且副标题逐字「A股融资杠杆热度」—— 反例注入必败', () => {
  const catalog = catalogModel()
  const card = catalog.cards.find((c) => c.id === 'leverage')
  assert.notEqual(card, undefined, '目录里必须有 leverage 这张卡（只在工具目录新增一项，不加顶部页签）')
  assert.equal(card?.title, '杠杆温度计', `卡片标题必须逐字等于「杠杆温度计」（实得 ${JSON.stringify(card?.title)}）`)
  assert.equal(card?.blurb, 'A股融资杠杆热度', `目录副标题必须逐字等于「A股融资杠杆热度」（实得 ${JSON.stringify(card?.blurb)}）`)
  // 工具文件里也必须是同一份字面量（防止只改卡片模型、不改条目）
  assert.equal(leverageTool.name, '杠杆温度计')
  assert.equal(leverageTool.blurb, 'A股融资杠杆热度')
  assert.equal(leverageTool.page, 'leverage', '工具项必须声明专用版式（通用三段式与"唯一说明文字"冲突）')
  assert.equal(leverageTool.load, undefined, '专用详情页自己取数（走通用 load() 会拿到通用骨架的语义）')
  assert.deepEqual(catalog.cards.map((c) => c.id), ['cake', 'leverage'], '新工具只追加在末尾，既有卡片不挪位')
  assert.equal(TOOL_ENTRIES.length, 2)
  // 页面接线：按判别位分支，而不是按 id 硬编码
  const page = strip(read('ToolsPage.tsx'))
  assert.equal(/entry\.page === 'leverage'/.test(page), true, 'ToolsPage 必须按 `page` 判别位路由到专用详情页')
  assert.equal(/entry\.id === 'leverage'/.test(page), false, '不许按 id 硬编码版式（下一个人会继续抄分支）')
  // 反例注入：改名 ⇒ 逐字断言必须失败
  assert.throws(() => assert.equal({ ...card, blurb: '两融热度' }.blurb, 'A股融资杠杆热度', '反例上必须失败'), /反例上/, '⚠ 反例（改副标题）必须让断言失败')
  assert.throws(() => assert.equal({ ...card, title: '杠杆' }.title, '杠杆温度计', '反例上必须失败'), /反例上/, '⚠ 反例（改工具名）必须让断言失败')
})

/* ────────────────────────────── ② 大字 + 唯一的「截至」 ────────────────────────────── */

test('② 温度卡 = 1 位小数 + `/ 100` + `截至`；页面唯一的说明文字就是它', () => {
  const payload = fixture()
  assert.equal(fmtTemperature(payload.temperature), '91.2', '温度必须是 1 位小数')
  assert.match(fmtTemperature(payload.temperature), /^\d+\.\d$/, '温度只允许「整数.一位小数」这一种形态')
  assert.equal(fmtTemperature(null), DASH, '温度缺 ⇒ `—`（不写 0）')
  assert.equal(leverageAsOfText(payload), '截至 2026-10-19', '唯一的说明文字必须逐字是「截至 YYYY-MM-DD」')
  // `asOf` 为空串 = 整块不可用（宿主约定）⇒ **只给 `—`**，页面上不出现「截至」二字
  assert.equal(leverageAsOfText(fixture({ asOf: '' })), DASH, '`asOf` 为空 ⇒ 只显示 `—`（**不渲染「截至 」**）')
  assert.equal(leverageAsOfText(null), DASH, '没有载荷同样只给 `—`')
  assert.equal(leverageAsOfText(fixture({ asOf: '' })).includes('截至'), false, '`asOf` 为空时不许出现「截至」字样')
  // 温度卡带着后缀与小字（R3：原大字搬进卡片行）
  const temp = leverageCards(payload)[0]
  assert.equal(temp.key, 'temperature')
  assert.equal(temp.value, '91.2')
  assert.equal(temp.suffix, '/ 100', '后缀必须是 `/ 100`')
  assert.equal(temp.note, '截至 2026-10-19', '卡内小字就是「截至 …」')
  assert.equal(leverageCards(fixture({ asOf: '' }))[0]?.note, DASH, '`asOf` 空 ⇒ 卡内小字只给 `—`')
  // 页面源码：后缀与截至小字各一处；`截至` 只来自模型（页面不另写一份）
  const page = strip(read(PAGE))
  assert.equal(page.includes("'/ 100'"), false, '`/ 100` 必须来自模型（页面不另写一份文案）')
  assert.equal((page.match(/leverage-card-suffix/g) ?? []).length, 1, '后缀只有一个锚点')
  assert.equal((page.match(/leverage-card-note/g) ?? []).length, 1, '`截至 …` 小字只有一个锚点')
  assert.equal(page.includes('leverage-hero'), false, '大字区必须已删除（R3：搬进卡片行）')
  const sources = `${strip(read(PAGE))}\n${strip(read(VIEW))}`
  assert.equal((sources.match(/截至/g) ?? []).length, 1, `「截至」在整个工具面上只允许出现一次（实得 ${(sources.match(/截至/g) ?? []).length}）`)
  // 反例注入 ①：asOf 为空时照渲染「截至 」⇒ 必败（日期缺失却硬写一个"截至"）
  const alwaysPrefix = (day: string): string => `截至 ${day}`
  assert.match(alwaysPrefix(''), /^截至 $/, '⚠ 反例（空日期也渲染「截至 」）确实产出了 `截至 `')
  assert.notEqual(alwaysPrefix(''), DASH, '⚠ 上一条反例必须与「只给 `—`」的期望不同')
  // 反例注入 ②：再写一句说明（例如「上一交易日」）⇒ "只出现一次"的判据必然失败
  const injected = `${sources}\nconst more = \`截至 \${payload.asOf}（上一交易日）\``
  assert.throws(() => assert.equal((injected.match(/截至/g) ?? []).length, 1, '反例上必须失败'), /反例上/, '⚠ 反例（多一处「截至」）必须让断言失败')
})

/* ────────────────────────────── ③ 三张摘要卡 ────────────────────────────── */

test('③ 第一行其余三张：显性融资 / 杠杆率 / 当日融资净买入（亿/万亿、2 位小数、正负号）', () => {
  const cards = leverageCards(fixture())
  assert.deepEqual(cards.slice(1, 4).map((c) => c.label), ['显性融资', '杠杆率', '当日融资净买入'], '第一行第 2–4 张的标签与顺序是用户口径')
  assert.equal(cards[1].value, '2.65%', '显性融资 = ratioPct，2 位小数 + %')
  assert.equal(cards[2].value, '2.69%', '杠杆率 = ratioWithShortPct，2 位小数 + %')
  assert.equal(cards[3].value, '-63.31 亿', '净买入 = netBuy（元→亿，2 位小数，带负号）')
  // 单位阶梯与符号：亿 / 万亿 / 正 / 零
  assert.equal(fmtNetYi(1.5e12), '+1.50 万亿', '≥1 万亿改用「万亿」，保留正号')
  assert.equal(fmtNetYi(3.2e8), '+3.20 亿')
  assert.equal(fmtNetYi(0), '0.00 亿', '恰好为 0 ⇒ 不写符号（避免 `+0.00` 看起来像涨）')
  assert.equal(fmtNetYi(-4e5), '0.00 亿', '四舍五入到 0 之后不许留负号（`-0.00` 会被读成错值）')
  assert.equal(fmtRatioPct(2.6), '2.60%', '2 位小数补零')
  // 反例注入：去掉正负号 ⇒ 上面的逐字断言必败
  const unsigned = (v: number): string => `${Math.abs(v / 1e8).toFixed(2)} 亿`
  assert.notEqual(unsigned(-6331355686), cards[3].value, '⚠ 反例（丢了负号）必须与期望值不同')
})

/* ────────────────────────────── ④ 双轴 + 两条线 + 阈值数字 ────────────────────────────── */

test('④ 主图：双轴（左温度 0–100 / 右比例 %）+ 温度与比例两条线 + 阈值 80/95 只标数字', () => {
  const payload = fixture()
  const chart = leverageChart(payload, 960, 320)
  assert.deepEqual(leverageChartProblems(chart, payload), [], `主图结构必须自洽：${leverageChartProblems(chart, payload).join(' ／ ')}`)
  // 两条线
  assert.deepEqual(chart.paths.map((p) => p.role).sort(), ['ratio', 'temp'], '温度与显性融资比例各一条线')
  // 左轴 = 温度 0–100
  assert.deepEqual(chart.texts.filter((t) => t.role === 'left-tick').map((t) => t.text), ['0', '50', '100'], '左轴固定 0–100')
  // 右轴 = 比例 %（三个刻度）
  const right = chart.texts.filter((t) => t.role === 'right-tick')
  assert.equal(right.length, 3, '右轴必须有刻度')
  for (const tick of right) assert.match(tick.text, /^\d+\.\d{2}%$/, `右轴刻度必须是百分比：${tick.text}`)
  // 阈值线：两条，只标数字 80 / 95
  const thrLines = chart.lines.filter((l) => l.role === 'threshold')
  assert.equal(thrLines.length, 2, '阈值线必须两条（80 / 95）')
  assert.deepEqual(chart.texts.filter((t) => t.role === 'threshold-label').map((t) => t.text), ['80', '95'], '阈值只标数字（不带文字）')
  assert.ok(thrLines[0].y1 > thrLines[1].y1, '80 的线必须在 95 下方（温度轴上越低越冷）')
  // 阈值线画在温度轴上（与左轴同一套映射）⇒ 两条线都必须落在绘图区内
  for (const line of thrLines) assert.ok(line.y1 > 0 && line.y1 < 320, `阈值线必须落在绘图区内（实得 y=${line.y1}）`)
  // R2 ②：阈值数字写在**右端胶囊**里，且胶囊在绘图区右缘、远离左轴刻度
  const capsules = chart.capsules.filter((c) => c.role === 'threshold-capsule')
  assert.equal(capsules.length, 2, '两条阈值线各带一个胶囊')
  const plotRight = 960 - 58
  for (const cap of capsules) {
    assert.ok(cap.x + cap.w >= plotRight - 4, `胶囊必须右端对齐（实得 x+w=${Math.round(cap.x + cap.w)} / 右缘=${plotRight}）`)
    assert.ok(cap.x > 960 * 0.8, `胶囊不许落在左半区（会压左轴刻度；实得 x=${Math.round(cap.x)}）`)
  }
  // 反例注入 ①：给阈值线加文字标签 ⇒ 必败
  const labelled = {
    ...chart,
    texts: chart.texts.map((t) => (t.role === 'threshold-label' && t.text === '80' ? { ...t, text: '80 高杠杆' } : t)),
  }
  assert.notDeepEqual(leverageChartProblems(labelled, payload), [], '⚠ 反例（阈值带文字）必须被抓住')
  assert.match(leverageChartProblems(labelled, payload).join(' ／'), /阈值线只许标数字/, '⚠ 报的原因要能指认"只标数字"')
  // 反例注入 ①b：把阈值数字放回左轴旁 ⇒ 胶囊判据必败（R2 ② 的核心回归）
  const backToAxis = { ...chart, texts: chart.texts.map((t) => (t.role === 'threshold-label' ? { ...t, x: 34 } : t)) }
  assert.match(leverageChartProblems(backToAxis, payload).join(' ／'), /阈值数字必须写在胶囊里/, '⚠ 反例（阈值放回左轴）必须被抓住')
  // 反例注入 ②：删掉右轴 ⇒ 双轴缺一条 ⇒ 必败
  const singleAxis = { ...chart, texts: chart.texts.filter((t) => t.role !== 'right-tick') }
  assert.match(leverageChartProblems(singleAxis, payload).join(' ／'), /右轴/, '⚠ 反例（单轴）必须被抓住')
  // 反例注入 ③：删掉左轴 100 ⇒ 0–100 契约破了 ⇒ 必败
  const noHundred = { ...chart, texts: chart.texts.filter((t) => !(t.role === 'left-tick' && t.text === '100')) }
  assert.match(leverageChartProblems(noHundred, payload).join(' ／'), /左轴/, '⚠ 反例（左轴缺 100）必须被抓住')
})

/* ────────────────────────────── ⑤ 缺值 `—` ────────────────────────────── */

test('⑤ 任何数值缺失 ⇒ `—`（不加文字、不进悬停、不写 0）；注入 `?? 0` 必败', () => {
  const blank = fixture({ asOf: '', temperature: null, ratioPct: null, ratioWithShortPct: null, netBuy: null })
  assert.equal(fmtTemperature(blank.temperature), DASH)
  const blankValues = leverageCards(blank).map((c) => c.value)
  assert.deepEqual(blankValues.slice(0, 4), [DASH, DASH, DASH, DASH], '第一行的四张卡缺值全部是 `—`')
  assert.equal(blankValues[7], DASH, '窗口累计净买入：窗口里有 `null` ⇒ `—`')
  assert.equal(leverageAsOfText(blank), DASH, '`asOf` 为空 ⇒ 只给 `—`（不是「截至 —」）')
  // 柱：该日缺值就不画柱（三天里只有两天有净买入）
  const chart = leverageChart(blank, 960, 320)
  assert.equal(chart.bars.length, 2, '缺值那天没有柱子')
  assert.deepEqual(netBarColor(1), 'var(--tw-up)', '正 ⇒ 涨 token')
  assert.deepEqual(netBarColor(-1), 'var(--tw-down)', '负 ⇒ 跌 token')
  assert.equal(netBarColor(null), 'var(--tw-flat)', '缺值不参与配色（中性）')
  // 反例注入：把 null 当 0 ⇒ 柱子多出一根 ⇒ 柱数判据必败
  const zeroed = leverageChart(
    { ...blank, net: blank.net.map((v) => (v === null ? 0 : v)) },
    960,
    320,
  )
  assert.equal(zeroed.bars.length, 3, '注入后确实多画了一根柱（否则这条证明无效）')
  assert.match(leverageChartProblems(zeroed, blank).join(' ／'), /有值的交易日数/, '⚠ 反例（`?? 0`）必须被柱数判据抓住')
  // 反例注入：卡片里 `?? 0` ⇒ 不再是 `—`
  const zeroedCards = leverageCards({ ...blank, ratioPct: blank.ratioPct ?? 0 })
  assert.notDeepEqual(zeroedCards.map((c) => c.value), [DASH, DASH, DASH], '⚠ 反例（卡片 `?? 0`）必须与期望值不同')
})

/* ────────────────────────────── ⑥ 窗口只换参数 ────────────────────────────── */

/** 端点判据（唯一实现）：同一条路由、只换 `range` 参数；页面只有一处调用。返回失败原因。 */
function endpointProblems(apiSrc: string, pageSrc: string): string[] {
  const bad: string[] = []
  const api = strip(apiSrc)
  const hits = [...api.matchAll(/\/tradewatcher\/leverage[^\s`'"]*/g)].map((m) => m[0])
  if (hits.length !== 1) bad.push(`只允许一个杠杆数据路由字面量（实得 ${hits.length}：${hits.join('、')}）`)
  const hit = hits[0] ?? ''
  const [base, query] = hit.split('?')
  if (base !== '/tradewatcher/leverage') bad.push(`路由路径必须固定为 /tradewatcher/leverage（实得 ${JSON.stringify(base)}）`)
  if (query !== 'range=${range}') bad.push(`窗口切换必须只换 range 查询参数（实得查询串 ${JSON.stringify(query ?? '')}）`)
  const page = strip(pageSrc)
  // ⚠ 页面里的调用点写成方法链（`api` 换行后 `.leverage(range)`）⇒ 正则必须允许 `api` 与 `.` 之间有空白
  const calls = [...page.matchAll(/api\s*\.\s*leverage\(([^)]*)\)/g)].map((m) => m[1].trim())
  if (calls.length !== 1) bad.push(`页面只允许一处 leverage 取数调用（实得 ${calls.length} 处）`)
  for (const arg of calls) if (arg !== 'range') bad.push(`取数参数必须就是窗口值（实得 ${JSON.stringify(arg)}）`)
  for (const gone of ['range=250', 'range=750', 'range=all', '?all', 'window=']) {
    if (page.includes(gone)) bad.push(`页面里不许把窗口写死在别处（命中 ${JSON.stringify(gone)}）`)
  }
  return bad
}

test('⑥ 窗口三档只换 `range` 查询参数（另发新接口 / 多一个参数 ⇒ 必败）', () => {
  assert.deepEqual(LEVERAGE_RANGES.map((o) => o.label), ['1 年', '3 年', '全历史'], '档位标签是用户口径')
  assert.deepEqual(LEVERAGE_RANGES.map((o) => o.range), ['250', '750', 'all'], '档位 = 三个范围参数')
  assert.equal(LEVERAGE_DEFAULT_RANGE, '750', '默认档 = 3 年（用户口径）')
  assert.deepEqual(endpointProblems(read('api.ts'), read(PAGE)), [], `端点判据：${endpointProblems(read('api.ts'), read(PAGE)).join(' ／ ')}`)
  // 取数三件套（单飞 + 代号丢弃旧响应 + 超时）都在页面上真的用了
  const page = strip(read(PAGE))
  for (const token of ['createRequestGen()', 'inFlight', 'gen.current.stale(', 'api\n      .leverage(range)']) {
    assert.equal(page.includes(token), true, `取数必须复用既有做法：缺少 ${JSON.stringify(token)}`)
  }
  // 反例注入 ①：多一个查询参数 ⇒ 必败
  const extraParam = read('api.ts').replace('?range=${range}', '?range=${range}&win=${range}')
  assert.notEqual(extraParam, read('api.ts'), '注入必须真的改到了源码')
  assert.match(endpointProblems(extraParam, read(PAGE)).join(' ／'), /只换 range/, '⚠ 反例（多参数）必须被抓住')
  // 反例注入 ②：另发一条新接口 ⇒ 必败
  const secondRoute = `${read('api.ts')}\n// @ts-expect-error 注入用\nconst _bad = () => request('/tradewatcher/leverage/alt')\n`
  assert.match(endpointProblems(secondRoute, read(PAGE)).join(' ／'), /只允许一个杠杆数据路由字面量/, '⚠ 反例（第二条接口）必须被抓住')
  // 反例注入 ③：页面把窗口写死（本地切片）⇒ 必败
  const hardcoded = `${read(PAGE)}\nconst _slice = 'range=250'\n`
  assert.match(endpointProblems(read('api.ts'), hardcoded).join(' ／'), /写死/, '⚠ 反例（本地写死窗口）必须被抓住')
})

/* ────────────────────────────── ⑦ 无口径长文案 ────────────────────────────── */

/**
 * 用户可见文案白名单（**逐字**）：页面与视图模块里出现的每个含汉字的字符串字面量都必须在表内。
 * 这就是"页面上唯一的说明文字是 `截至 YYYY-MM-DD`"的可执行判据 —— 多写一句解释，表里就没有它。
 */
const COPY_ALLOW = new Set([
  // 工具名 / 卡片标签 / 图例名 / 档位标签 / 唯一的说明文字 / 控件与错误态文案
  '杠杆温度计', '显性融资', '杠杆率', '当日融资净买入', '温度', '显性融资比例', '净买入',
  '融资余额', '融券余额', '流通市值', '窗口累计净买入',
  '1 年', '3 年', '全历史', '截至', '窗口', '重试',
  // 金额单位（不是说明文字）
  '亿', '万亿',
])

/** 结构判据段的分隔横幅（那之后的字符串是**给开发者看的诊断文案**，不是页面文案） */
const JUDGE_BANNER = '4. 结构判据'

/** 抽出源码里的字符串字面量文本（含引号内的一切；不处理嵌套模板） */
function stringLiterals(src: string): string[] {
  return [...strip(src).matchAll(/'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|`(?:[^`\\]|\\.)*`/g)].map((m) => m[0].slice(1, -1))
}

/** 页面文案判据（唯一实现）：返回表外的中文文案。 */
function explanatoryProblems(files: { page: string; view: string }): string[] {
  const bad: string[] = []
  for (const [name, raw] of Object.entries(files)) {
    // 视图模块只看"判据段"之前的部分（判据段的字符串是诊断文案，不上页面）
    let src = raw
    if (name === 'view') {
      const at = raw.indexOf(JUDGE_BANNER)
      if (at < 0) bad.push('视图模块里找不到结构判据段的分隔横幅（文案扫描会失效）')
      // 切到那段注释的**开头**再剥注释：从横幅中间切会留下一个没有配对的 `*/`
      src = at < 0 ? raw : raw.slice(0, Math.max(0, raw.lastIndexOf('/*', at)))
    }
    for (const text of stringLiterals(src)) {
      const normalized = text.replace(/\$\{[^}]*\}/g, '').trim()
      if (normalized === '') continue
      if (!/[\u4e00-\u9fff]/.test(normalized)) continue
      if (!COPY_ALLOW.has(normalized)) bad.push(`${name} 出现了清单外的说明文案：${JSON.stringify(text)}`)
    }
  }
  return bad
}

test('⑦ 页面不得出现口径/解释性长文案（唯一的说明文字是 `截至`）—— 注入一段说明必败', () => {
  const files = { page: read(PAGE), view: read(VIEW) }
  assert.deepEqual(explanatoryProblems(files), [], `文案判据：${explanatoryProblems(files).join(' ／ ')}`)
  // 用户可见文案集合就是这几处（卡片标签 / 图例名 / 档位标签 / 唯一的说明文字）
  assert.deepEqual(leverageCards(null).map((c) => c.label), ['温度', '显性融资', '杠杆率', '当日融资净买入', '融资余额', '融券余额', '流通市值', '窗口累计净买入'])
  assert.deepEqual(LEVERAGE_LEGEND.map((l) => l.name), ['温度', '显性融资比例', '净买入'])
  assert.deepEqual(LEVERAGE_RANGES.map((o) => o.label), ['1 年', '3 年', '全历史'])
  // 反例注入：加一段口径说明（页面里）⇒ 必败
  const withNote = { ...files, page: `${files.page}\nconst _note = '显性融资比例的分位口径：全历史分位 × 100，阈值取 P80 / P95'\n` }
  assert.notDeepEqual(explanatoryProblems(withNote), [], '⚠ 反例（加一段口径）必须被抓住')
  // 反例注入：加一段边界声明（视图里，且在判据段之前）⇒ 必败
  const withBoundary = { ...files, view: `${files.view.split(JUDGE_BANNER)[0]}\nconst _b = '分位是描述统计，不是买卖信号'\n` }
  assert.notDeepEqual(explanatoryProblems(withBoundary), [], '⚠ 反例（加一条边界）必须被抓住')
  // 反例注入：缺值处写「未取到」（用户口径要求只写 `—`）⇒ 同样在表外 ⇒ 必败
  const withMissing = { ...files, page: `${files.page}\nconst _dash = '未取到'\n` }
  assert.notDeepEqual(explanatoryProblems(withMissing), [], '⚠ 反例（缺值写成「未取到」）必须被抓住')
})

/* ────────────────────────────── ⑧ 读数框 / 无十字光标 ────────────────────────────── */

test('⑧ 悬停只给读数框：无十字光标、无 title 悬停说明（R2 ③ 的源码侧）', () => {
  const payload = fixture()
  const chart = leverageChart(payload, 960, 320)
  // 悬停读数：该日三个数（缺值仍 `—`），行名与图例同源
  const readout = leverageReadout(payload, 2)
  assert.notEqual(readout, null)
  assert.deepEqual(readout?.rows.map((r) => r.name), LEVERAGE_LEGEND.map((l) => l.name), '读数框行名必须与图例同源（不新增文案）')
  assert.deepEqual(readout?.rows.map((r) => r.text), ['91.2', '2.65%', '-63.31 亿'])
  const blank = leverageReadout(fixture({ temp: [null, null, null], ratio: [null, null, null], net: [null, null, null] }), 1)
  assert.deepEqual(blank?.rows.map((r) => r.text), [DASH, DASH, DASH], '读数框缺值同样只给 `—`')
  assert.equal(leverageReadout(null, 0), null, '没有载荷就没有读数框')
  // 源码级：页面必须有读数框与鼠标事件；**不许**有十字光标，也不许把文案挂到 title
  const page = strip(read(PAGE))
  for (const token of ["'data-role': 'leverage-readout'", 'onMouseMove', 'onMouseLeave', 'leverageReadout(', 'leverageIndexAt(']) {
    assert.equal(page.includes(token), true, `悬停读数框缺少 ${JSON.stringify(token)}`)
  }
  for (const gone of ['tool-crosshair', 'leverage-crosshair', 'tool-hover-tip', 'title:']) {
    assert.equal(page.includes(gone), false, `不许出现 ${JSON.stringify(gone)}（R2：无十字光标、无悬停说明）`)
  }
  // 模型里也没有十字线这种图元（水平线只有三种角色）
  assert.equal([...new Set(chart.lines.map((l) => l.role))].every((r) => ['grid', 'threshold', 'zero'].includes(r)), true, '水平线只有网格 / 阈值 / 零轴')
  // 反例注入：把读数框删掉 ⇒ 上面的源码判据必败
  const withoutReadout = page.split("'data-role': 'leverage-readout'").join("'data-role': 'leverage-x'")
  assert.equal(withoutReadout.includes("'data-role': 'leverage-readout'"), false, '⚠ 反例（删读数框）必须能被抓到')
})

/* ────────────────────────────── ⑨ 字号 / 间距 / 令牌 ────────────────────────────── */

test('⑨ 字号落在密集阶梯、间距落在 1px 刻度、几何全部复用既有令牌（注入 11px 必败）', () => {
  // 字号：两个文件的 `fontSize:` 字面量都必须在 12 / 12.5 / 13 / 13.5 / 14 或 ≥15 的展示级
  let seen = 0
  for (const rel of [PAGE, VIEW]) {
    for (const m of strip(read(rel)).matchAll(/fontSize:\s*([0-9.]+)/g)) {
      seen += 1
      assert.deepEqual(typeScaleProblems(Number(m[1]), `${rel} 的字号`), [], `${rel} 有越格字号 ${m[1]}px`)
    }
  }
  assert.ok(seen >= 1, `应当扫到至少一处字号（实际 ${seen}）—— 否则这条是空跑`)
  // 间距：页面里的数值型 gap / padding 必须落在 1px 刻度
  for (const m of strip(read(PAGE)).matchAll(/(?:gap|paddingTop|paddingLeft)\s*:\s*([0-9.]+)/g)) {
    assert.deepEqual(spaceScaleProblems(Number(m[1]), '间距'), [], `页面有非整数间距 ${m[1]}`)
  }
  for (const [k, v] of Object.entries(TOOL_SPACE)) assert.deepEqual(spaceScaleProblems(v, `TOOL_SPACE.${k}`), [])
  // 几何令牌：页面必须**真的用上**同一批常量（只 import 不算），且这些常量本身仍是详情页的契约值
  const used = stripImports(read(PAGE))
  for (const token of [
    'CHART_TYPE.tileValue',
    'CHART_TYPE.legend',
    'SUMMARY_TYPE.label',
    'SUMMARY_TYPE.value',
    'SUMMARY_TYPE.note',
    'CARD_SURFACE',
    'LEGEND_ROW',
    'LEGEND_DOT',
    'RANGE_BOX',
    'RANGE_ON',
    'RANGE_OFF',
    'RANGE_TYPE',
    'PLOT.fallbackWidth',
    'PLOT.heightMin',
    'LEVERAGE_PLOT_HEIGHT',
    'TOOL_SPACE.sectionGap',
    'TOOL_SPACE.cardHeadGap',
    'TOOL_SPACE.tileGap',
    'CHART_STACK',
    'tw-lev-cards',
  ]) {
    assert.equal(used.includes(token), true, `页面必须真的用上 toolDetailTheme 的 ${token}`)
  }
  // 令牌本身的值（详情页的几何契约，本页面的"专门化"不许把它们改掉）
  assert.equal(SUMMARY_TYPE.value.fontSize, 34, '卡片数值沿用既有层级（温度搬进卡片后也用它）')
  assert.equal(SUMMARY_TYPE.label.fontSize, 12.5)
  assert.equal(CHART_TYPE.tileValue.fontSize, 20)
  assert.equal(CHART_TYPE.legend.fontSize, 12)
  assert.equal(CARD_SURFACE.border, '1px solid var(--tw-border-strong)', '摘要卡边框 = 既有卡片表面令牌')
  assert.equal(LEGEND_ROW.justifyContent, 'center', '图例居中')
  assert.equal(LEGEND_DOT.borderRadius, '50%', '图例是圆点')
  assert.equal(RANGE_ON.fontWeight, 600, '选中档是浅底圆角块')
  assert.equal(RANGE_OFF.background, 'transparent')
  assert.equal(RANGE_TYPE.fontSize, 12.5)
  assert.equal(RANGE_BOX.background, 'var(--tw-bg2)', '窗口控件是凹陷容器（既有几何）')
  assert.equal(Number(RANGE_BOX.borderRadius), 10)
  assert.deepEqual([...CHART_STACK], ['legend', 'plot'], '图例在上、画布在下（规格 7 保留图例）')
  assert.equal(
    /\.\.\.CHART_STACK\.map\(\(slot\) =>/.test(strip(read(PAGE))),
    true,
    '主图卡必须按 CHART_STACK 渲染（顺序的唯一来源，不许在页面里另写一份）',
  )
  assert.equal(PLOT.heightCss, 'clamp(280px, 26vh, 380px)')
  assert.equal(LEVERAGE_PLOT_HEIGHT, 'min(58vh, 520px)', 'R2 ①：主图高度 = min(58vh, 520px)')
  // 不新增依赖：页面的外部模块只能是 react（其余一律相对路径）
  const specs = [...read(PAGE).matchAll(/from '([^']+)'/g)].map((m) => m[1])
  assert.ok(specs.length >= 4, '页面应当有若干 import（否则扫描是空跑）')
  for (const spec of specs) assert.equal(spec === 'react' || spec.startsWith('./'), true, `不许引入新依赖：${spec}`)
  // 反例注入：塞一个 11px / 11.5px 间距 ⇒ 判据必须非空
  assert.notDeepEqual(typeScaleProblems(11, '注入'), [], '⚠ 反例（11px）必须被抓到')
  assert.notDeepEqual(typeScaleProblems(13.2, '注入'), [], '⚠ 反例（13.2px）必须被抓到')
  assert.notDeepEqual(spaceScaleProblems(11.5, '注入'), [], '⚠ 反例（11.5px 间距）必须被抓到')
  // 绘图区高度契约：既有 clamp(280–380) 那一份，不许写死/塌陷
  assert.equal(PLOT.heightCss, 'clamp(280px, 26vh, 380px)')
  // 绘图区走**本工具自己的**高度契约（R2 ①：占整页 55–60%）；详情页通用的 PLOT.heightCss 不许被改
  assert.equal(
    /position:\s*'relative',\s*width:\s*'100%',\s*height:\s*LEVERAGE_PLOT_HEIGHT/.test(strip(read(PAGE))),
    true,
    '绘图区高度必须走 LEVERAGE_PLOT_HEIGHT（写死像素要被拦住）',
  )
  assert.equal(
    /style:\s*\{\s*height:\s*LEVERAGE_PLOT_HEIGHT/.test(strip(read(PAGE))),
    true,
    '加载骨架也必须占住同一份高度契约（否则骨架→图之间会跳一下）',
  )
})
