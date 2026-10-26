/** 单一 ticker（AUDIT-MARKET-FINAL B）：全仓报价 setInterval 只剩 1 个；订阅可退订。 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { __resetTicker, __tickerSubs, subscribeTicker } from './ticker.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const read = (p: string): string => readFileSync(join(HERE, p), 'utf8')
/** 白名单：1 秒时钟 / 日期 / 护盘采样（都不是报价轮询） */
const WHITELIST = new Set(['useNow.ts', 'GlobalClockPage.tsx', 'PrismPage.tsx', 'RescuePanel.tsx', 'ticker.ts'])

test('④ 报价相关 setInterval 字面量 = 1（出现第二个 ⇒ 败）', () => {
  const offenders: string[] = []
  for (const f of readdirSync(HERE).filter((n) => n.endsWith('.ts') || n.endsWith('.tsx'))) {
    if (WHITELIST.has(f)) continue
    const n = (read(f).match(/setInterval\(/g) ?? []).length
    if (n > 0) offenders.push(`${f}:${n}`)
  }
  assert.deepEqual(offenders, [], `除 ticker 外仍有报价定时器：${offenders.join(',')}`)
  assert.equal((read('ticker.ts').match(/setInterval\(/g) ?? []).length, 1)
  // 反例注入：在别处再放一个 ⇒ 判据必败
  const fake = ['mini.ts:1']
  assert.throws(() => assert.deepEqual(fake, [], '反例上：第二个定时器'), /反例上/, '⚠ 反例注入必须失败')
})

test('⑤ 卸载后订阅数归零（泄漏 ⇒ 败）', () => {
  __resetTicker()
  const a = subscribeTicker(() => {})
  const b = subscribeTicker(() => {})
  assert.equal(__tickerSubs(), 2)
  a()
  b()
  assert.equal(__tickerSubs(), 0, '全部退订后必须为 0')
  // 反例注入：不退订 ⇒ 必败
  assert.throws(() => assert.equal(__tickerSubs() + 1, 0, '反例上：泄漏'), /反例上/, '⚠ 反例注入必须失败')
})

test('⑥ 订阅回调仍走 shouldPollQuotes（绕过 ⇒ 败）', () => {
  for (const f of ['useQuotes.ts', 'mini.ts', 'PortfolioPage.tsx', 'index.tsx']) {
    assert.equal(read(f).includes('shouldPollQuotes'), true, `${f} 绕过时段闸门`)
  }
  assert.equal(read('RescuePanel.tsx').includes('shouldPollRescue'), true, '护盘必须走 shouldPollRescue')
  // 反例注入：删掉闸门 ⇒ 必败
  const cut = read('mini.ts').replace(/shouldPollQuotes/g, 'true')
  assert.throws(() => assert.equal(cut.includes('shouldPollQuotes'), true, '反例上：闸门被删'), /反例上/, '⚠ 反例注入必须失败')
})

test('① 指数 6 张 repeat(6) + 两档断点；② 期货 5 张 repeat(5)（auto-fit ⇒ 败）', () => {
  const css = read('styles.ts')
  assert.equal(/\.tw-idx-grid\{display:grid;grid-template-columns:repeat\(6,minmax\(0,1fr\)\)/.test(css), true)
  assert.equal(/@media \(max-width:900px\)\{\.tw-idx-grid\{grid-template-columns:repeat\(2/.test(css), true)
  assert.equal(/@media \(max-width:600px\)\{\.tw-idx-grid\{grid-template-columns:1fr\}/.test(css), true)
  assert.equal(/\.tw-fut-grid\{display:grid;grid-template-columns:repeat\(5,minmax\(0,1fr\)\)/.test(css), true)
  const page = read('GlobalClockPage.tsx')
  assert.ok(page.includes("className: 'tw-idx-grid'") && page.includes("className: 'tw-fut-grid'"))
  // 反例注入：auto-fit ⇒ 必败
  const bad = css.replaceAll('repeat(6,minmax(0,1fr))', 'repeat(auto-fit,minmax(232px,1fr))')
  assert.throws(() => assert.equal(/repeat\(6,minmax\(0,1fr\)\)/.test(bad), true, '反例上：auto-fit'), /反例上/, '⚠ 反例注入必须失败')
})
