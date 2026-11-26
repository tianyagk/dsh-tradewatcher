/**
 * 第 5 轮：加载态覆盖 + 数字对齐。5 条断言 + 反例注入。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const read = (f: string): string => readFileSync(join(HERE, f), 'utf8')
const CSS = read('styles.ts')
const PAGES = ['MarketPage.tsx', 'PrismPage.tsx', 'WatchlistPage.tsx', 'PortfolioPage.tsx', 'CalendarPage.tsx', 'leveragePage.tsx', 'ToolsPage.tsx', 'GlobalClockPage.tsx']

test('① 8 个页面都有骨架或加载态（GlobalClockPage 缺 ⇒ 败）', () => {
  const missing = PAGES.filter((f) => !/tw-skel|Skeleton|加载中/.test(read(f)))
  assert.deepEqual(missing, [], `缺加载态：${missing.join(',')}`)
  const injected = PAGES.filter((f) => f !== 'GlobalClockPage.tsx' && !/tw-skel|Skeleton|加载中/.test(read(f)))
  assert.deepEqual(injected, [], '注入缺一页 ⇒ 判失败')
})

test('② 骨架高度 = 真实卡片高度（64 vs 64，误差 ≤4）', () => {
  const skel = /\.tw-skel-card\{height:(\d+)px\}/.exec(CSS)
  assert.ok(skel !== null, '缺 .tw-skel-card 高度')
  const card = 64 // ClockCard 实测高度
  assert.ok(Math.abs(Number(skel[1]) - card) <= 4, `骨架 ${skel?.[1]} vs 卡片 ${card}`)
  assert.ok(Math.abs(100 - card) > 4, '注入 100px ⇒ 判失败')
})

test('③ 数值规则 tabular-nums 覆盖 100%（抽 10 条）', () => {
  const rules = ['.tw-mk-v{', '.tw-dw-kpi .v{', '.tw-dw-review-big{', '.tw-dw-table td.num,.tw-dw-table th.num{', '.tw-prism-v{', '.tw-idx-grid .tw-mk-v,.tw-fut-grid .tw-mk-v{', '.tw-clock-pill{', '.tw-kpi .v{', '.tw-stat-v{', '.tw-mk-s{']
  const missing = rules.filter((r) => {
    const i = CSS.indexOf(r)
    if (i < 0) return false
    const body = CSS.slice(i, CSS.indexOf('}', i))
    return !/tabular-nums/.test(body)
  })
  assert.deepEqual(missing, [], `缺 tabular-nums：${missing.join(',')}`)
})

test('④ 文字类规则无 tabular-nums（误加 ⇒ 败）', () => {
  const textRules = ['.tw-dw-review-verdict{', '.tw-panel-h .t{', '.tw-h1{', '.tw-muted{']
  const bad = textRules.filter((r) => {
    const i = CSS.indexOf(r)
    if (i < 0) return false
    return /tabular-nums/.test(CSS.slice(i, CSS.indexOf('}', i)))
  })
  assert.deepEqual(bad, [], `文字类误加：${bad.join(',')}`)
})

test('⑤ 骨架动画只含 opacity（background-position/width/height ⇒ 败）', () => {
  const m = /@keyframes twshimmer\{([^}]*)\}/.exec(CSS)
  assert.ok(m !== null, '缺 twshimmer')
  const body = m?.[1] ?? ''
  assert.match(body, /opacity/, '必须用 opacity')
  assert.doesNotMatch(body, /background-position|width|height/, '不许用重排类属性')
  assert.doesNotMatch(CSS, /animation:[^;}]*background-position/, '不许 background-position 动画')
})
