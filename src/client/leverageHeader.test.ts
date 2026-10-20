/**
 * 杠杆温度计 · **R4 三项**的可检查判据（删日期小字 / 卡片值字号降档 / 工具名标题）。
 *
 * 用户要求（只在 `src/client/**`）：
 *   ① 删掉温度卡里的日期小字（原文「截至 …」），页面上**不再出现那个词**；`asOf` 仍留在数据里、不渲染；
 *   ② 卡片值字号整体降一档：温度 28px、其余 26px（都 ≥ 15 ⇒ 展示级；**不得低于 26**）；
 *   ③ 卡片行上方加工具名标题（单行、左对齐、复用既有 section 标题层级、**整页只出现一次**）。
 *
 * 仓库惯例：**纯函数判据 + 反例注入**（每条注入都必须让判据非空）。判据的唯一实现是
 * `tools/leverageView.ts` 的 `leverageCardsProblems()` / `leverageCardValueSizeProblems()`；本文件只驱动它们。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { LeveragePayloadDto } from './api.ts'
import { catalogModel } from './toolRegistry.ts'
import { leverageTool } from './tools/leverage.ts'
import { CHART_TYPE, typeScaleProblems } from './toolDetailTheme.ts'
import {
  LEVERAGE_CARD_KEYS,
  LEVERAGE_CARD_VALUE_MIN_PX,
  LEVERAGE_CARD_VALUE_PX,
  leverageCardValueSizeProblems,
  leverageCards,
  leverageCardsProblems,
  type LeverageCard,
} from './tools/leverageView.ts'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const read = (rel: string): string => readFileSync(join(ROOT, 'src/client', rel), 'utf8')
const strip = (src: string): string => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1')
const PAGE = 'leveragePage.tsx'
const VIEW = 'tools/leverageView.ts'
/** 页面 + 视图模块（**剥注释**：注释里讲历史不算渲染） */
const sources = (): string => `${strip(read(PAGE))}\n${strip(read(VIEW))}`

function payload(): LeveragePayloadDto {
  const dates: string[] = []
  const net: Array<number | null> = []
  for (let i = 0; i < 750; i += 1) {
    const d = new Date(Date.UTC(2023, 0, 2) + i * 86400000)
    dates.push(d.toISOString().slice(0, 10))
    net.push(1e8)
  }
  return {
    asOf: '2026-01-20',
    temperature: 90.4,
    ratioPct: 2.65,
    ratioWithShortPct: 2.69,
    marginBalance: 2453374239917,
    shortBalance: 29167627323,
    floatMv: 92416865855823.71,
    netBuy: -6331355686,
    thresholds: { p80: 80, p95: 95 },
    dates,
    temp: dates.map(() => 60),
    ratio: dates.map(() => 2.5),
    net,
  }
}

/** 日期小字判据（唯一实现）：页面与视图模块里都不许再有那个词 / 那个常量。返回失败原因。 */
function asofRenderProblems(src: string): string[] {
  const bad: string[] = []
  if (src.includes('截至')) bad.push('页面不许出现「截至」（日期小字已按用户要求删除）')
  if (src.includes('ASOF_PREFIX')) bad.push('`ASOF_PREFIX` 渲染链必须整条删除')
  if (/leverage-card-note/.test(src)) bad.push('卡片小字的渲染锚点必须删除')
  return bad
}

/** 标题接线判据（唯一实现）：恰好一处、在卡片行之前、复用 section 标题层级、文案来自 props。 */
function titleWiringProblems(pageSrc: string): string[] {
  const bad: string[] = []
  const page = strip(pageSrc)
  const anchor = "'data-role': 'leverage-title'"
  const count = page.split(anchor).length - 1
  if (count !== 1) bad.push(`工具名标题必须恰好一处（实得 ${count}）`)
  const titleAt = page.indexOf(anchor)
  const cardsAt = page.indexOf("'data-role': 'leverage-cards'")
  const chartAt = page.indexOf("'data-role': 'leverage-chart-card'")
  if (titleAt < 0) bad.push('缺少工具名标题（data-role="leverage-title"）')
  if (cardsAt < 0) bad.push('缺少卡片行锚点（无法判定标题位置）')
  if (titleAt >= 0 && cardsAt >= 0 && !(titleAt < cardsAt)) bad.push('标题必须在卡片行**之前**（不在图下面、不在卡片行之后）')
  if (titleAt >= 0 && chartAt >= 0 && !(titleAt < chartAt)) bad.push('标题必须排在主图卡之前')
  if (titleAt < 0) return bad
  // 语义标题 + 自己的 props 对象（只看 h2 自己的 `{ … }`，不往后多切字符）
  const h2At = page.lastIndexOf("React.createElement('h2'", titleAt)
  if (h2At < 0) bad.push('标题必须是语义标题（h2）')
  const propsAt = h2At < 0 ? -1 : page.indexOf('{', h2At)
  const propsEnd = propsAt < 0 ? -1 : page.indexOf('}', propsAt)
  const block = propsAt >= 0 && propsEnd > propsAt ? page.slice(propsAt, propsEnd) : ''
  if (block === '') bad.push('找不到标题的 props 对象（样式/文案判据会失效）')
  if (/className:/.test(block)) bad.push('标题不许带 className（只能复用既有 token）')
  if (!block.includes('CHART_TYPE.cardTitle')) bad.push('标题必须复用既有 section 标题层级（CHART_TYPE.cardTitle）')
  const children = propsEnd < 0 ? '' : page.slice(propsEnd, page.indexOf(')', propsEnd))
  if (!children.includes('props.title')) bad.push('标题文案必须来自工具条目（props.title），页面不许写死')
  return bad
}

/* ────────────────────────────── ① 页面不再出现「截至」 ────────────────────────────── */

test('① 页面不得出现「截至」/ `ASOF_PREFIX` 渲染（R4）—— 加回必败', () => {
  assert.deepEqual(asofRenderProblems(sources()), [], `日期小字未删干净：${asofRenderProblems(sources()).join(' ／ ')}`)
  // 数据侧仍在（契约字段保留）——删的是渲染，不是数据
  assert.equal(Object.prototype.hasOwnProperty.call(payload(), 'asOf'), true, '`asOf` 仍在契约里（只是不渲染）')
  // 注入 ①：把日期小字加回视图模块 ⇒ 必败
  const back = `${sources()}\nconst note = \`截至 \${payload.asOf}\``
  assert.match(asofRenderProblems(back).join(' ／'), /截至/, '⚠ 反例（加回「截至」）必须被抓住')
  // 注入 ②：把常量加回 ☆
  assert.match(asofRenderProblems(`${sources()}\nconst ASOF_PREFIX = 'x'`).join(' ／'), /ASOF_PREFIX/, '⚠ 反例（加回 ASOF_PREFIX）必须被抓住')
  // 注入 ③：把卡片小字锚点加回页面 ⇒ 必败
  assert.match(asofRenderProblems(`${sources()}\nReact.createElement('div', { 'data-role': 'leverage-card-note' })`).join(' ／'), /卡片小字/, '⚠ 反例（加回小字锚点）必须被抓住')
})

/* ────────────────────────────── ② 8 张卡回归 ────────────────────────────── */

test('② 8 张卡的数量与顺序不变（R3 回归）', () => {
  const cards = leverageCards(payload())
  assert.equal(cards.length, 8, '必须仍是 8 张（两行 × 四列）')
  assert.deepEqual(cards.map((c) => c.key), [...LEVERAGE_CARD_KEYS], '键顺序不变')
  assert.deepEqual(cards.map((c) => c.label), ['温度', '显性融资', '杠杆率', '当日融资净买入', '融资余额', '融券余额', '流通市值', '窗口累计净买入'], '标签顺序不变')
  assert.deepEqual(leverageCardsProblems(cards), [], `卡片行判据：${leverageCardsProblems(cards).join(' ／ ')}`)
  // 注入：多一张 ⇒ 必败
  const nine: LeverageCard[] = [...cards, { key: 'windowNet', label: '多余', value: '1.00 亿' }]
  assert.notDeepEqual(leverageCardsProblems(nine), [], '⚠ 反例（多一张卡）必须被抓住')
})

/* ────────────────────────────── ③ 卡片值字号 ────────────────────────────── */

test('③ 卡片值字号：温度 28px、其余 26px（R4 降档）—— 改回 34px 必败', () => {
  assert.equal(LEVERAGE_CARD_VALUE_PX.temperature, 28, '温度值 28px')
  assert.equal(LEVERAGE_CARD_VALUE_PX.other, 26, '其余 7 张 26px')
  assert.equal(LEVERAGE_CARD_VALUE_MIN_PX, 26, '下限锁定在 26px')
  assert.deepEqual(leverageCardValueSizeProblems(LEVERAGE_CARD_VALUE_PX), [], `字号判据：${leverageCardValueSizeProblems(LEVERAGE_CARD_VALUE_PX).join(' ／ ')}`)
  // 两者都是展示级（≥15 ⇒ 不参与密集阶梯），且都不低于 26
  for (const [k, px] of Object.entries(LEVERAGE_CARD_VALUE_PX)) {
    assert.ok(px >= 26, `${k} 不得低于 26px（实得 ${px}）`)
    assert.deepEqual(typeScaleProblems(px, `卡片值字号 ${k}`), [], `${k}=${px}px 必须是展示级（≥15）`)
  }
  // 页面真的用这两个值（不是写死别的数），且不再用 34px
  const page = strip(read(PAGE))
  assert.equal(page.includes('LEVERAGE_CARD_VALUE_PX.temperature') && page.includes('LEVERAGE_CARD_VALUE_PX.other'), true, '页面必须按卡片键取这两个字号')
  assert.equal(/fontSize:\s*34/.test(page), false, '页面不许再用 34px 的卡片值字号')
  // 注入：改回 34 / 34 ⇒ 必败（顺序 + 数值都不对）
  const back = { temperature: 34, other: 34 }
  assert.notDeepEqual(back, LEVERAGE_CARD_VALUE_PX, '⚠ 反例（34/34）必须与契约不同')
  assert.notDeepEqual(leverageCardValueSizeProblems(back), [], '⚠ 反例（34/34：温度不再最大）必须被抓住')
  // 注入：降到 24px（低于下限）⇒ 必败
  assert.match(leverageCardValueSizeProblems({ temperature: 28, other: 24 }).join(' ／'), /不得低于 26/, '⚠ 反例（24px）必须被抓住')
  // label 层级不动（既有 SUMMARY_TYPE.label）
  assert.equal(page.includes('SUMMARY_TYPE.label'), true, '标签层级必须继续用既有令牌')
})

/* ────────────────────────────── ④ 工具名标题 ────────────────────────────── */

test('④ 工具名标题恰好一次、在卡片行之前、复用既有标题层级 —— 放图下/出现两次必败', () => {
  assert.deepEqual(titleWiringProblems(read(PAGE)), [], `标题接线未通过：${titleWiringProblems(read(PAGE)).join(' ／ ')}`)
  // 文案单一来源：页面里不许再写死工具名（标题来自 ToolEntry.name）
  assert.equal(strip(read(PAGE)).includes('杠杆温度计'), false, '页面不许写死工具名（必须来自 props.title）')
  // 标题层级用既有的（17px/700），不新造样式
  assert.equal(CHART_TYPE.cardTitle.fontSize, 17)
  assert.equal(CHART_TYPE.cardTitle.fontWeight, 700)
  // 注入 ①：把标题挪到主图下面 ⇒ 必败
  const src = read(PAGE)
  const h2Line = /\n( *React\.createElement\('h2', \{ 'data-role': 'leverage-title'[^\n]*\n)/.exec(src)?.[1] ?? ''
  assert.notEqual(h2Line, '', '找不到标题行（注入会失效）')
  const moved = src.replace(`\n${h2Line}`, '\n').replace('      error === null\n', `      ${h2Line}      error === null\n`)
  assert.notEqual(moved, src, '注入必须真的改到了源码')
  assert.match(titleWiringProblems(moved).join(' ／'), /标题必须在卡片行/, '⚠ 反例（标题挪到图下面）必须被抓住')
  // 注入 ②：标题写两遍 ⇒ 必败
  const twice = `${src}\n${h2Line}`
  assert.match(titleWiringProblems(twice).join(' ／'), /恰好一处/, '⚠ 反例（标题出现两次）必须被抓住')
  // 注入 ③：标题文案写死（不走 props）⇒ 必败
  const hardcoded = src.replace('}, props.title),', "}, '杠杆温度计'),")
  assert.notEqual(hardcoded, src, '注入必须真的改到了源码')
  assert.match(titleWiringProblems(hardcoded).join(' ／'), /props\.title/, '⚠ 反例（写死工具名）必须被抓住')
})

/* ────────────────────────────── ⑤ 仍无口径/解释文字 ────────────────────────────── */

/** 用户可见文案白名单（**逐字**）：页面与视图模块里每个含汉字的字符串字面量都必须在表内 */
const COPY_ALLOW = new Set([
  '显性融资', '杠杆率', '当日融资净买入', '温度', '显性融资比例', '净买入',
  '融资余额', '融券余额', '流通市值', '窗口累计净买入',
  '1 年', '3 年', '全历史', '窗口', '重试',
  '亿', '万亿',
])

function stringLiteralsOf(src: string): string[] {
  return [...strip(src).matchAll(/'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|`(?:[^`\\]|\\.)*`/g)].map((m) => m[0].slice(1, -1))
}

/** 页面文案判据：返回白名单外的中文文案（视图模块只看判据段之前 —— 那之后的字符串是诊断文案） */
function explanatoryProblems(files: { page: string; view: string }): string[] {
  const bad: string[] = []
  for (const [name, raw] of Object.entries(files)) {
    let src = raw
    if (name === 'view') {
      const at = raw.indexOf('4. 结构判据')
      if (at < 0) bad.push('视图模块里找不到判据段横幅（文案扫描会失效）')
      src = at < 0 ? raw : raw.slice(0, Math.max(0, raw.lastIndexOf('/*', at)))
    }
    for (const text of stringLiteralsOf(src)) {
      const normalized = text.replace(/\$\{[^}]*\}/g, '').trim()
      if (normalized === '' || !/[\u4e00-\u9fff]/.test(normalized)) continue
      if (!COPY_ALLOW.has(normalized)) bad.push(`${name} 出现了清单外的说明文案：${JSON.stringify(text)}`)
    }
  }
  return bad
}

test('⑤ 仍无口径/解释文字（R3 回归）—— 注入一句说明必败', () => {
  const files = { page: read(PAGE), view: read(VIEW) }
  assert.deepEqual(explanatoryProblems(files), [], `文案判据：${explanatoryProblems(files).join(' ／ ')}`)
  // 八张卡的文案位只有 label / value / suffix（判据已在 leverageCardsProblems 里）
  assert.deepEqual(leverageCardsProblems(leverageCards(payload())), [])
  // 注入 ①：给卡片加一句说明 ⇒ 必败
  const noted = leverageCards(payload()).map((c, i) => (i === 6 ? { ...c, suffix: '近 3 年' } : c))
  assert.match(leverageCardsProblems(noted).join(' ／'), /不许带后缀/, '⚠ 反例（流通市值卡加说明）必须被抓住')
  // 注入 ②：页面里加一段口径 ⇒ 必败
  const withCopy = { ...files, page: `${files.page}\nconst _leak = '温度 = 全历史分位 × 100'\n` }
  assert.notDeepEqual(explanatoryProblems(withCopy), [], '⚠ 反例（加一段口径）必须被抓住')
  // 注入 ③：标题里塞说明 ⇒ 必败（标题文案来自 props，页面写死一句就被抓）
  const withTitleCopy = { ...files, page: `${files.page}\nconst _t = '杠杆温度计（全历史分位）'\n` }
  assert.notDeepEqual(explanatoryProblems(withTitleCopy), [], '⚠ 反例（标题带解释）必须被抓住')
})

/* ────────────────────────────── R5 ① 目录名（全角括号口径） ────────────────────────────── */

test('R5 ① 目录卡名字恰为 `杠杆温度计（锚定 2024）`（全角括号）—— 少括号/半角括号必败', () => {
  const card = catalogModel().cards.find((c) => c.id === 'leverage')
  assert.notEqual(card, undefined, '目录里必须有 leverage 这张卡')
  assert.equal(card?.title, '杠杆温度计（锚定 2024）', `目录卡名字必须逐字等于「杠杆温度计（锚定 2024）」（实得 ${JSON.stringify(card?.title)}）`)
  assert.equal(leverageTool.name, '杠杆温度计（锚定 2024）', '工具条目里的 name 必须是同一份字面量（单一来源）')
  // 括号必须是**全角**、且恰好一对
  assert.equal(card?.title.includes('（') === true && card?.title.includes('）') === true, true, '括号必须是全角（ ）')
  assert.equal(/[()]/.test(card?.title ?? ''), false, '不许出现半角括号')
  assert.equal((card?.title.match(/（/g) ?? []).length, 1, '左括号恰好一个')
  assert.equal((card?.title.match(/）/g) ?? []).length, 1, '右括号恰好一个')
  // 注入 ①：半角括号 ⇒ 与期望不同，且判据能抓到
  const half = '杠杆温度计(锚定 2024)'
  assert.notEqual(half, card?.title, '⚠ 反例（半角括号）必须与期望不同')
  assert.equal(/[()]/.test(half), true, '⚠ 半角括号确实被判据拒掉')
  // 注入 ②：少括号（= 旧名字）⇒ 与期望不同
  assert.notEqual('杠杆温度计', card?.title, '⚠ 反例（少括号）必须与期望不同')
  // 注入 ③：把括号里的口径改掉 ⇒ 与期望不同
  assert.notEqual('杠杆温度计（锚定 2025）', card?.title, '⚠ 反例（口径年份改错）必须与期望不同')
})

/* ────────────────────────────── R5 ② 标题与目录名同源 + ③ 恰好一处 ────────────────────────────── */

test('R5 ② 详情页标题与目录名同源（页面不写死）—— 注入写死必败；③ 标题仍恰好一处', () => {
  const tools = strip(read('ToolsPage.tsx'))
  assert.equal(/title:\s*entry\.name/.test(tools), true, 'ToolsPage 必须把 `entry.name` 传给专用详情页（同源）')
  const page = strip(read(PAGE))
  assert.equal(page.includes('杠杆温度计'), false, '页面不许写死工具名（必须来自 props.title）')
  assert.equal(page.includes('锚定'), false, '页面不许写死括号里的口径')
  assert.equal(page.includes('2024'), false, '页面不许写死口径年份')
  // ③ 标题恰好一处
  assert.equal(page.split("'data-role': 'leverage-title'").length - 1, 1, '标题仍恰好一处')
  // 注入 ①：页面写死名字 ⇒ 必败
  const hardcoded = `${page}\nconst _t = '杠杆温度计（锚定 2024）'`
  assert.equal(hardcoded.includes('杠杆温度计'), true, '⚠ 反例（页面写死名字）必须能被抓到')
  assert.equal(hardcoded.includes('锚定'), true, '⚠ 反例（页面写死口径）必须能被抓到')
  // 注入 ②：页面写死标题文案（不走 props）⇒ titleWiringProblems 必败
  const src = read(PAGE)
  const hard = src.replace('}, props.title),', "}, '杠杆温度计（锚定 2024）'),")
  assert.notEqual(hard, src, '注入必须真的改到了源码')
  assert.match(titleWiringProblems(hard).join(' ／'), /props\.title/, '⚠ 反例（写死标题文案）必须被抓住')
  // 注入 ③：标题写两遍 ⇒ 必败
  const titleLine = /\n( *React\.createElement\('h2', \{ 'data-role': 'leverage-title'[^\n]*\n)/.exec(src)?.[1] ?? ''
  assert.notEqual(titleLine, '', '找不到标题行（注入会失效）')
  assert.match(titleWiringProblems(`${src}\n${titleLine}`).join(' ／'), /恰好一处/, '⚠ 反例（标题两遍）必须被抓住')
})
