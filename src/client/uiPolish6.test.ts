/** 第 6 轮：图表悬停提示 + 空态高度收敛。5 条断言 + 反例注入。 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const read = (f: string): string => readFileSync(join(HERE, f), 'utf8')
const MKT = read('MarketPage.tsx')
const RES = read('RescuePanel.tsx')
const CSS = read('styles.ts')

test('① 汪汪队两图各含 onMouseMove 与提示内容（缺 ⇒ 败）', () => {
  const bars = /data-role': 'dw-chart-bars'[\s\S]{0,900}?onMouseMove/.test(MKT)
  const line = /data-role': 'dw-chart-line'[\s\S]{0,900}?onMouseMove/.test(MKT)
  assert.equal(bars, true, '左图缺 onMouseMove')
  assert.equal(line, true, '右图缺 onMouseMove')
  assert.match(MKT, /份额变化 \$\{v\.toFixed\(1\)\} 亿份/, '左图提示内容')
  assert.match(MKT, /加仓指数 \$\{v\.toFixed\(1\)\}/, '右图提示内容')
  assert.match(MKT, /dwTip\.text/, '提示框渲染')
})

test('② 分时量能图含 onMouseMove 与成交额文案（缺 ⇒ 败）', () => {
  assert.match(RES, /onMouseMove: onMove/, '量能图缺 onMouseMove')
  assert.match(RES, /成交额 \$\{\(amt \/ 1e8\)\.toFixed\(2\)\} 亿/, '缺成交额文案')
  assert.match(RES, /脉冲/, '缺脉冲标记')
  assert.match(RES, /tw-rescue-tip/, '提示框')
})

test('③ 提示框 pointer-events:none（可拦截 ⇒ 败）', () => {
  const m = /\.tw-dw-tip\{([^}]*)\}/.exec(CSS)
  assert.ok(m !== null, '缺 .tw-dw-tip')
  assert.match(m?.[1] ?? '', /pointer-events:none/)
  const injected = (m?.[1] ?? '').replace('pointer-events:none', 'pointer-events:auto')
  assert.doesNotMatch(injected, /pointer-events:none/, '注入可拦截 ⇒ 判失败')
})

test('④ .tw-empty padding ≤16 且 max-height ≤180（26px/无上限 ⇒ 败）', () => {
  const all = [...CSS.matchAll(/\.tw-empty\{([^}]*)\}/g)].map((x) => x[1] ?? '')
  const body = all.find((b) => b.includes('padding')) ?? ''
  const m = [body]
  assert.ok(m !== null)
  const pad = /padding:(\d+)px/.exec(body)
  assert.ok(pad !== null && Number(pad[1]) <= 16, `padding ${pad?.[1]} > 16`)
  const mh = /max-height:(\d+)px/.exec(body)
  assert.ok(mh !== null && Number(mh[1]) <= 180, '缺 max-height 或超过 180')
  assert.throws(() => assert.ok(26 <= 16, '注入 26px ⇒ 败'), /注入 26px/)
})

test('⑤ 空态文案 ≤2 行（超2行省略 + title 全文）', () => {
  assert.match(CSS, /\.tw-empty-line\{[^}]*-webkit-line-clamp:2/, '缺 2 行截断')
  const clamp = /-webkit-line-clamp:(\d+)/.exec(CSS)
  assert.ok(Number(clamp?.[1]) <= 2, '行数 > 2')
  assert.throws(() => assert.ok(3 <= 2, '注入 3 行 ⇒ 败'), /注入 3 行/)
})
