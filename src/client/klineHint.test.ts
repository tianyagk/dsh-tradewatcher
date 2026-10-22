/**
 * K 线左下角提示框移除（用户裁决）：
 *   · 键盘提示整段删除（含浮层容器），不得再出现在源码/渲染里；
 *   · 区间 B/S 笔数、净买入、买入/卖出均价并入图上方**那一条**口径行（不新增第二行/浮层）。
 * 本文件同时锚住"图与细节卡不重叠"：细节卡（TipCard）仍在，提示层不得回来。
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { caliberWithStats, rangeStatsText, tradeStatsOf } from './klineStats.ts'

const here = dirname(fileURLToPath(import.meta.url))
const read = (rel: string): string => readFileSync(join(here, rel), 'utf8')
const kline = read('./kline.tsx')
const drawer = read('./QuoteDrawer.tsx')

const KEYBOARD = ['←/→ 平移', 'Shift 加速', 'Home/End', '+/- 缩放']

/** ① 键盘提示（源码任何位置，含注释）必须为零 */
function keyboardHintProblems(src: string): string[] {
  return KEYBOARD.filter((k) => src.includes(k)).map((k) => `仍出现键盘提示「${k}」`)
}

/** ② 不得有 fixed/absolute 的提示浮层容器 */
function overlayProblems(src: string): string[] {
  const bad: string[] = []
  if (/position:\s*'(fixed|absolute)'/.test(src)) bad.push('仍存在 position:fixed/absolute 的提示浮层')
  return bad
}

test('① 源码里不得再出现键盘提示关键词（加回 ⇒ 必败）', () => {
  // K 线提示所在面：图表、统计纯函数、抽屉。其它页面（搜索/复盘）的 Home/End 是各自控件的键盘支持，不属这个提示框
  const files = ['kline.tsx', 'klineStats.ts', 'QuoteDrawer.tsx']
  const hits = files.flatMap((f) => keyboardHintProblems(read(`./${f}`)).map((m) => `${f}: ${m}`))
  assert.deepEqual(hits, [], `键盘提示必须清零：\n${hits.join('\n')}`)
  assert.equal(keyboardHintProblems(kline).length, 0)
  // 反例注入：加回任意一条 ⇒ 判据必须非空
  const injected = `${kline}\nconst bad = '键盘：←/→ 平移（Shift 加速），Home/End 到两端，+/- 缩放'\n`
  assert.notDeepEqual(keyboardHintProblems(injected), [], '⚠ 反例（加回键盘提示）必须被抓到')
  assert.throws(() => assert.deepEqual(keyboardHintProblems(injected), [], '反例'), /反例/, '⚠ 反例注入必须让断言失败')
})

test('② 该区域不得再有浮层容器（恢复 position:fixed/absolute ⇒ 必败）', () => {
  assert.deepEqual(overlayProblems(kline), [], `kline.tsx 不许有提示浮层：${JSON.stringify(overlayProblems(kline))}`)
  // 提示框已删：容器上也没有 title 属性（原生 tooltip 会与细节卡重叠）
  assert.equal(/\btitle:\s*'键盘/.test(kline), false, '键盘提示不得挂 title')
  assert.equal(/\btitle:/.test(kline.slice(kline.indexOf("className: 'tw-kline'"), kline.indexOf("className: 'tw-kline'") + 800)), false, '图表容器不许挂 title')
  // 反例注入：恢复一个 absolute 浮层 + 键盘提示 ⇒ 判据必须非空
  const injected = `${kline}\nconst bad = React.createElement('div', { style: { position: 'absolute', left: 0 } }, '键盘：←/→ 平移')\n`
  assert.notDeepEqual(overlayProblems(injected), [], '⚠ 反例（恢复浮层）必须被抓到')
  assert.throws(() => assert.deepEqual(overlayProblems(injected), [], '反例'), /反例/, '⚠ 反例注入必须失败')
})

test('③ B/S 笔数、净买入、买卖均价仍在口径行（一起删掉 ⇒ 必败）', () => {
  const stats = { buyCount: 27, sellCount: 18, netQty: 12_000, buyAvg: 19.696, sellAvg: 19.527, outCount: 32 }
  assert.equal(
    rangeStatsText(stats),
    '区间内 B 27 笔 / S 18 笔 · 净买入 12000 份/股 · 买入均价 19.696 / 卖出均价 19.527',
  )
  const base = '日K · klt 101 · 前复权 · 截至 10-22 13:08'
  assert.equal(
    caliberWithStats(base, stats),
    '日K · klt 101 · 前复权 · 截至 10-22 13:08 · 区间内 B 27 笔 / S 18 笔 · 净买入 12000 份/股 · 买入均价 19.696 / 卖出均价 19.527',
  )
  // 抽屉确实把它并进口径行（源码级）
  assert.ok(drawer.includes('caliberWithStats(caliberLine(),'), '口径行必须追加区间统计')
  // 反例注入：把净买入/均价一起删掉 ⇒ 判据必须失败
  const dropped = '区间内 B 27 笔 / S 18 笔'
  assert.notEqual(dropped, rangeStatsText(stats))
  assert.throws(() => assert.equal(dropped, rangeStatsText(stats), '反例'), /反例/, '⚠ 反例（删掉净买入/均价）必须失败')
})

test('④ 状态行仍是一行（拆成两行 ⇒ 必败）', () => {
  const stats = { buyCount: 1, sellCount: 2, netQty: -3, buyAvg: 10, sellAvg: 11, outCount: 0 }
  const one = caliberWithStats('日K · klt 101 · 前复权 · 截至 10-22 13:08', stats)
  assert.equal(one.includes('\n'), false, '状态行必须是单行')
  assert.equal(one.split(' · ').length >= 3, true)
  // 反例注入：拆成两行 ⇒ 判据必须失败
  const twoLines = `日K · klt 101\n${rangeStatsText(stats)}`
  assert.throws(() => assert.equal(twoLines.includes('\n'), false, '反例'), /反例/, '⚠ 反例（拆两行）必须失败')
})

test('⑤ 细节卡仍在、提示层已移除（图与细节卡不重叠）', () => {
  assert.ok(kline.includes('function TipCard('), '细节卡必须保留')
  assert.ok(kline.includes('TipCard(tipLines, tipPos, redUp)'), '悬停细节卡仍挂在图上')
  assert.ok(kline.includes("position: 'relative'"), '细节卡的定位容器保留（相对定位）')
  assert.deepEqual(overlayProblems(kline), [], '提示浮层不得回来')
  // 反例注入：把提示层加回图容器 ⇒ 判据必须失败
  const injected = kline.replace("className: 'tw-kline'", "className: 'tw-kline', style: { position: 'absolute' }")
  assert.notDeepEqual(overlayProblems(injected), [], '⚠ 反例（图容器变 absolute 提示层）必须被抓到')
})

test('区间统计的取数口径：笔数/净额/均价/区间外', () => {
  const bars = [{ date: '2026-10-20' }, { date: '2026-10-21' }, { date: '2026-10-22' }]
  const markers = [
    { date: '2026-10-20', kind: 'buy' as const, qty: 3, price: 9 },
    { date: '2026-10-21', kind: 'buy' as const, qty: 10, price: 10 },
    { date: '2026-10-21', kind: 'sell' as const, qty: 4, price: 11 },
  ]
  const st = tradeStatsOf(bars, markers, 1, 3)
  assert.equal(st.buyCount, 1)
  assert.equal(st.sellCount, 1)
  assert.equal(st.netQty, 6)
  assert.equal(st.buyAvg, 10)
  assert.equal(st.sellAvg, 11)
  assert.equal(st.outCount, 1)
  // 空区间：outCount 计全部，文本为「区间内无买卖点」
  const none = tradeStatsOf(bars, markers, 0, 0)
  assert.equal(none.outCount, 3)
  assert.equal(rangeStatsText(none), '区间内无买卖点')
})
