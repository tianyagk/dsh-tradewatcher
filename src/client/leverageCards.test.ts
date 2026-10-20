/**
 * 杠杆温度计 · **卡片行（两行 × 四列，8 张）**的可检查判据（R3 批）。
 *
 * 用户要求：温度从大字区**搬进卡片行**，并新增第二行四张卡 ——
 *   第一行：温度（带 `/ 100` 与 `截至 …`）/ 显性融资 / 杠杆率 / 当日融资净买入；
 *   第二行：融资余额 / 融券余额 / 流通市值 / 窗口累计净买入（随窗口变）。
 *
 * 仓库惯例：**纯函数判据 + 反例注入**（每条注入都必须让判据非空）。判据的唯一实现是
 * `tools/leverageView.ts` 的 `leverageCardsProblems()` / `windowNetSum()`；本文件只驱动它们。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { LeveragePayloadDto } from './api.ts'
import {
  DASH,
  LEVERAGE_CARD_KEYS,
  LEVERAGE_CARD_LABELS,
  fmtAmountYi,
  leverageCards,
  leverageCardsProblems,
  windowNetSum,
  type LeverageCard,
} from './tools/leverageView.ts'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const read = (rel: string): string => readFileSync(join(ROOT, 'src/client', rel), 'utf8')
const strip = (src: string): string => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1')
const PAGE = 'leveragePage.tsx'

/** 造一条 n 天的载荷（每日净买入固定为 `each`，便于算"窗口累计"的精确期望值） */
function shape(n: number, each: number, over: Partial<LeveragePayloadDto> = {}): LeveragePayloadDto {
  const dates: string[] = []
  const net: Array<number | null> = []
  const temp: Array<number | null> = []
  const ratio: Array<number | null> = []
  for (let i = 0; i < n; i += 1) {
    const d = new Date(Date.UTC(2020, 0, 1) + i * 86400000)
    dates.push(d.toISOString().slice(0, 10))
    net.push(each)
    temp.push(60)
    ratio.push(2.5)
  }
  return {
    asOf: dates[dates.length - 1] as string,
    temperature: 90.4,
    ratioPct: 2.65,
    ratioWithShortPct: 2.69,
    marginBalance: 2453374239917,
    shortBalance: 29167627323,
    floatMv: 92416865855823.71,
    netBuy: -6331355686,
    thresholds: { p80: 80, p95: 95 },
    dates,
    temp,
    ratio,
    net,
    ...over,
  }
}

/* ────────────────────────────── ① 恰好 8 张卡 ────────────────────────────── */

test('① 恰好 8 张卡（两行 × 四列）—— 多一张/少一张必败', () => {
  const cards = leverageCards(shape(750, 1e8))
  assert.equal(cards.length, 8, `必须恰好 8 张卡（实得 ${cards.length}）`)
  assert.deepEqual(cards.map((c) => c.key), [...LEVERAGE_CARD_KEYS], '键的顺序 = 从左到右、从上到下')
  assert.deepEqual(leverageCardsProblems(cards), [], `卡片行判据：${leverageCardsProblems(cards).join(' ／ ')}`)
  // 注入 ①：多一张 ⇒ 必败
  const nine: LeverageCard[] = [...cards, { key: 'windowNet', label: '多出来的', value: '1.00 亿' }]
  assert.match(leverageCardsProblems(nine).join(' ／'), /恰好 8 张|多出来的卡片必须删掉/, '⚠ 反例（多一张卡）必须被抓住')
  // 注入 ②：少一张 ⇒ 必败
  assert.match(leverageCardsProblems(cards.slice(0, 7)).join(' ／'), /恰好 8 张/, '⚠ 反例（少一张卡）必须被抓住')
  // 页面真的渲染了整份模型（不是自己拼 4 张）
  const page = strip(read(PAGE))
  assert.equal(/model_card_placeholder/.test(page), false, '页面不许有第二套卡片数据源')
  assert.equal(page.includes('leverageCards('), true, '页面必须渲染 leverageCards() 给出的整份卡片模型')
  assert.equal(page.includes("'data-role': 'leverage-card'"), true, '每张卡必须有结构锚点')
  // ⚠ 必须逐张渲染**整份**模型：`cards.slice(...)`/`filter(...)` 等于偷偷砍掉几张卡（8 张的判据就失效了）
  assert.equal(/cards\.map\(\(card\)/.test(page), true, '页面必须 cards.map 逐张渲染')
  assert.equal(/cards\.(slice|filter|splice)\(/.test(page), false, '页面不许裁剪卡片模型（少渲染几张 = 布局契约失效）')
})

/* ────────────────────────────── ② 温度卡在第一行第一张 ────────────────────────────── */

test('② 温度卡在第一行第一张，含 `/ 100` 与 `截至` —— 注入搬到末尾必败', () => {
  const payload = shape(750, 1e8)
  const cards = leverageCards(payload)
  const temp = cards[0]
  assert.equal(temp?.key, 'temperature', '第一张必须是温度卡')
  assert.equal(temp?.label, '温度')
  assert.equal(temp?.value, '90.4', '主值 1 位小数')
  assert.equal(temp?.suffix, '/ 100', '卡内后缀 `/ 100`')
  assert.equal('note' in (temp ?? {}), false, 'R4：温度卡不再有日期小字（note 字段已删除）')
  // 除这三样外不许有其他文字（卡片模型只有 label/value/suffix 三个文案位）
  assert.deepEqual(Object.keys(temp ?? {}).sort(), ['key', 'label', 'suffix', 'value'], '温度卡不许有第四个文案字段')
  // `asOf` 不再渲染（R4）⇒ 换掉 asOf 也不影响任何一张卡的文案
  assert.deepEqual(leverageCards({ ...payload, asOf: '' }), leverageCards(payload), '`asOf` 不参与渲染（缺它也不会有日期小字）')
  // 注入：把温度卡挪到末尾 ⇒ 顺序判据必败
  const moved = [...cards.slice(1), cards[0] as LeverageCard]
  assert.match(leverageCardsProblems(moved).join(' ／'), /第 1 张卡必须是 temperature/, '⚠ 反例（温度卡搬家）必须被抓住')
})

/* ────────────────────────────── ③ 第二行顺序 ────────────────────────────── */

test('③ 第二行依次为 融资余额 / 融券余额 / 流通市值 / 窗口累计净买入 —— 换位即败', () => {
  const cards = leverageCards(shape(750, 1e8))
  assert.deepEqual(cards.slice(4).map((c) => c.label), ['融资余额', '融券余额', '流通市值', '窗口累计净买入'], '第二行四张卡的顺序是用户口径')
  assert.deepEqual([...LEVERAGE_CARD_LABELS], ['温度', '显性融资', '杠杆率', '当日融资净买入', '融资余额', '融券余额', '流通市值', '窗口累计净买入'])
  // 注入：把第二行前两张互换位置（模拟实现按错顺序产出）⇒ 必败
  const swapped = [cards[0], cards[1], cards[2], cards[3], cards[5], cards[4], cards[6], cards[7]] as LeverageCard[]
  assert.match(leverageCardsProblems(swapped).join(' ／'), /第 5 张卡必须是 short|第 6 张卡必须是|标签必须逐字是/, '⚠ 反例（第二行换位）必须被抓住')
})

/* ────────────────────────────── ④ 金额格式 ────────────────────────────── */

test('④ 金额格式：亿 / 万亿、2 位小数；余额类不带符号、净买入类带符号', () => {
  const cards = leverageCards(shape(750, 1e8))
  // 余额/市值：元 → 亿/万亿，2 位小数，**不带符号**
  assert.equal(cards[4]?.value, '2.45 万亿', '融资余额 2,453,374,239,917 元 = 2.45 万亿（≥1 万亿换单位）')
  assert.equal(cards[5]?.value, '291.68 亿', '融券余额 291.68 亿')
  assert.equal(cards[6]?.value, '92.42 万亿', '流通市值 92.42 万亿（≥1 万亿换单位）')
  // 净买入类：带符号
  assert.match(cards[3]?.value ?? '', /^-63\.31 亿$/, '当日净买入带负号')
  assert.match(cards[7]?.value ?? '', /^\+750\.00 亿$/, '窗口累计净买入带正号')
  // 格式化单元：单位阶梯 / 2 位小数 / 零
  assert.equal(fmtAmountYi(1.5e12), '1.50 万亿')
  assert.equal(fmtAmountYi(3.2e8), '3.20 亿')
  assert.equal(fmtAmountYi(0), '0.00 亿')
  assert.equal(fmtAmountYi(null), DASH, '缺 ⇒ `—`（不写 0）')
  // 注入：去掉 2 位小数 ⇒ 与期望不同
  const rough = (v: number): string => `${Math.round(v / 1e8)} 亿`
  assert.notEqual(rough(2453374239917), cards[4]?.value, '⚠ 反例（四舍五入到整数）必须与期望值不同')
})

/* ────────────────────────────── ⑤ 窗口累计随 range 变化 ────────────────────────────── */

test('⑤ 窗口累计净买入随窗口变化（1 年 / 3 年 / 全历史各不同）—— 写成常量必败', () => {
  const windows: Array<[number, number]> = [
    [250, 1e8], // 250 天 × 1 亿 = 250 亿
    [750, 1e8], // 750 天 × 1 亿 = 750 亿
    [4018, -2e8], // 4018 天 × -2 亿
  ]
  const values = windows.map(([n, each]) => leverageCards(shape(n, each))[7]?.value)
  assert.deepEqual(values, ['+250.00 亿', '+750.00 亿', '-8036.00 亿'], '三档窗口的累计值必须各自算出来')
  assert.equal(new Set(values).size, 3, '三档窗口的累计值必须互不相同（否则等于没随窗口变）')
  // 与 model 里的窗口一致：同样的 net 序列换长度 ⇒ 值变
  assert.notEqual(windowNetSum(shape(250, 1e8)), windowNetSum(shape(750, 1e8)), '累计必须真的对整窗求和')
  // 注入：写成固定常量 ⇒ 必败
  const constant = (): string => '+250.00 亿'
  assert.notDeepEqual(windows.map(() => constant()), values, '⚠ 反例（固定常量）必须与三档实测值不同')
})

/* ────────────────────────────── ⑥ 窗口内有 null ⇒ `—` ────────────────────────────── */

test('⑥ 窗口内只要有一个 `null` ⇒ 累计显示 `—`（不静默少算）—— 注入忽略 null 必败', () => {
  const withNull = shape(250, 1e8, { net: [1e8, 2e8, null, 3e8] })
  assert.equal(windowNetSum(withNull), null, '有 null ⇒ 整列算不出')
  assert.equal(leverageCards(withNull)[7]?.value, DASH, '界面显示 `—`')
  // 全空序列 / 没有载荷
  assert.equal(windowNetSum(shape(3, 1e8, { net: [] })), null, '空窗口 ⇒ null（不写 0）')
  assert.equal(windowNetSum(null), null, '没有载荷 ⇒ null')
  // 注入：忽略 null 求和（"跳过缺的那天照算"）⇒ 会得到 6 亿，必须与 `—` 不同
  const skipNull = (p: LeveragePayloadDto | null): number | null => {
    const nets = (p?.net ?? []).filter((v): v is number => typeof v === 'number' && Number.isFinite(v))
    return nets.length === 0 ? null : nets.reduce((s, v) => s + v, 0)
  }
  assert.notEqual(skipNull(withNull), null, '⚠ 反例（忽略 null）确实算出了一个数（否则这条证明无效）')
  assert.notEqual(leverageCards(withNull)[7]?.value, `+6.00 亿`, '⚠ 反例（忽略 null）的结果不许出现在界面上')
})

/* ────────────────────────────── ⑦ 页面无口径/解释文字 ────────────────────────────── */

test('⑦ 卡片行不得出现口径/解释文字（只有标签 + 数值 + 温度卡的后缀 `/ 100`）—— 注入必败', () => {
  const cards = leverageCards(shape(750, 1e8))
  assert.deepEqual(leverageCardsProblems(cards), [], `卡片行判据：${leverageCardsProblems(cards).join(' ／ ')}`)
  // 注入 ①：给第二行某张卡加一句说明（R4 起用后缀位塞文字）⇒ 必败
  const noted = cards.map((c, i) => (i === 4 ? { ...c, suffix: '近 3 年' } : c))
  assert.match(leverageCardsProblems(noted).join(' ／'), /不许带后缀/, '⚠ 反例（余额卡加说明）必须被抓住')
  // 注入 ②：给净买入卡加后缀（例如 `亿元`）⇒ 必败
  const suffixed = cards.map((c, i) => (i === 3 ? { ...c, suffix: '亿元' } : c))
  assert.match(leverageCardsProblems(suffixed).join(' ／'), /不许带后缀/, '⚠ 反例（净买入卡加后缀）必须被抓住')
  // 注入 ③：把数值换成一句解释 ⇒ 必败
  const explained = cards.map((c, i) => (i === 7 ? { ...c, value: '累计净买入见上方说明' } : c))
  assert.match(leverageCardsProblems(explained).join(' ／'), /数值形态不符/, '⚠ 反例（数值变文案）必须被抓住')
  // 页面侧：卡片区不许出现 `tw-hint`（紧凑/隐身档会藏）或任何额外文案位
  const page = strip(read(PAGE))
  assert.equal(page.includes("'data-role': 'leverage-card-suffix'"), true, '卡片必须有后缀锚点（R4：小字锚点已删除）')
  assert.equal(page.includes("'data-role': 'leverage-card-note'"), false, '卡片小字锚点必须已删除')
  assert.equal((page.match(/card\.suffix/g) ?? []).length >= 1, true, '后缀必须来自模型（页面不另写文案）')
  assert.equal((page.match(/card\.note/g) ?? []).length, 0, '页面不许再渲染卡片小字（R4）')
})
