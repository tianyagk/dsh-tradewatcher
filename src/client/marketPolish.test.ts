/** 大盘页打磨（市场稿 4 类差异）。 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { shortSignalOf } from './rescueView.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const read = (p: string): string => readFileSync(join(HERE, p), 'utf8')

test('① 时间线每条 ≤40 字且无 ｜ 长串（恢复长段落 ⇒ 败）', () => {
  const e = { hhmm: '14:32', level: 2 as const, score: 72, families: 3, reason: '护盘信号｜疑似护盘｜评分 72｜量能放大 2.46△ 且超大单净流入' }
  const s = shortSignalOf(e)
  assert.ok(s.length <= 40, `短句超 40 字（${s.length}）：${s}`)
  assert.equal(s.includes('｜'), false)
  assert.ok(s.startsWith('14:32 · 疑似护盘 · 3族 · 72分'), s)
  const panel = read('RescuePanel.tsx')
  assert.ok(panel.includes('shortSignalOf(e)'), '时间线必须用短句')
  assert.equal(/e\.reason\)/.test(panel), false, '不得直接渲染 e.reason 长段落')
})

test('② 页面不含「口径说明：」', () => {
  assert.equal(read('RescuePanel.tsx').includes('口径说明：'), false)
  assert.equal(read('MarketPage.tsx').includes('口径说明：'), false)
})

test('③ 三个小格容器 5/4/3 等分（拉伸或 auto-fit ⇒ 败）', () => {
  const css = read('styles.ts')
  for (const n of [5, 4, 3]) {
    assert.equal(new RegExp(`\\.tw-mk-grid${n}\\{display:grid;grid-template-columns:repeat\\(${n},minmax\\(0,1fr\\)\\)`).test(css), true, `grid${n} 必须 ${n} 等分`)
  }
  const page = read('MarketPage.tsx')
  assert.ok(page.indexOf("className: 'tw-mk-l'") < page.indexOf("className: 'tw-mk-v'"), '标签必须在数值之前（上/下排布）')
  assert.throws(() => assert.equal(/repeat\(5,1fr\)/.test(css), true, '反例上：拉伸'), /反例上/, '⚠ 反例注入必须失败')
})

test('④ 两张图高度 ≥180 / ≥160 且有轴刻度（无轴 ⇒ 败）', () => {
  const page = read('MarketPage.tsx')
  assert.ok(/const W = 320, H = 180/.test(page), '成交额分时高度必须 ≥180')
  assert.ok(/const W = 320, H = 160/.test(page), '分钟量能高度必须 ≥160')
  assert.ok(/X 09:30–15:00 · Y 亿元/.test(page), '必须有 X/Y 轴说明')
})

test('⑤ 无数据时仍有坐标系 + 原因（空白 ⇒ 败）', () => {
  const page = read('MarketPage.tsx')
  assert.ok(/'aria-label': '分钟成交额增减坐标系'/.test(page), '空态必须有坐标系')
  assert.ok(/missingCellText\(noAmountReason \?\? delta\.reason\)/.test(page), '空态必须给原因')
})

test('⑥ 四类数据块各有一个「重试」按钮（缺 ⇒ 败）', () => {
  const page = read('MarketPage.tsx')
  assert.ok(page.includes("}, '重试')"), '缺少重试按钮')
  assert.ok(/const \[mkRetry, setMkRetry\]/.test(page), '缺少重试令牌')
  assert.ok(page.includes('setMkRetry((n) => n + 1)'), '按钮必须重新拉取')
})
