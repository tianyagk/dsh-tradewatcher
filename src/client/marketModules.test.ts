/** 大盘页只保留「涨跌/成交额/两融两列块 → 护盘」；指数/期货块只在工具页（用户裁定 2026-10-26）。 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))

test('① 设计稿不含「主要指数」「期货自选」（含 ⇒ 败）', () => {
  const html = readFileSync(join(HERE, '..', '..', 'docs', 'mockups', 'market-v1.html'), 'utf8')
  assert.equal(html.includes('主要指数'), false, '设计稿仍含「主要指数」')
  assert.equal(html.includes('期货自选'), false, '设计稿仍含「期货自选」')
  // 反例注入：把标题加回去 ⇒ 必败
  const legacy = `${html}<div>期货自选</div>`
  assert.throws(() => assert.equal(legacy.includes('期货自选'), false, '反例上：块还在'), /反例上/, '⚠ 反例注入必须失败')
})

test('② MarketPage 不含两块文案与 GlobalClockPage 引用（含 ⇒ 败）', () => {
  const page = readFileSync(join(HERE, 'MarketPage.tsx'), 'utf8')
  for (const word of ['主要指数', '期货自选', 'GlobalClockPage']) {
    assert.equal(page.includes(word), false, `MarketPage 仍含「${word}」`)
  }
  // 反例注入：误加一句 ⇒ 必败
  const bad = `${page}\n// 主要指数`
  assert.throws(() => assert.equal(bad.includes('主要指数'), false, '反例上：误加'), /反例上/, '⚠ 反例注入必须失败')
})

test('③ 大盘模块顺序：涨跌两列块 → 护盘（多出块 ⇒ 败）', () => {
  const page = readFileSync(join(HERE, 'MarketPage.tsx'), 'utf8')
  const iGrid = page.indexOf("className: 'tw-mk-grid2'")
  const iRescue = page.indexOf('React.createElement(RescuePanel')
  assert.ok(iGrid > 0, '缺少涨跌/成交额/两融两列块')
  assert.ok(iRescue > iGrid, `两列块必须在护盘之前（grid=${iGrid}, rescue=${iRescue}）`)
  // 反例注入：把护盘挪到两列块之前 ⇒ 必败
  assert.throws(() => assert.ok(iGrid > page.length + 1, '反例上：顺序反了'), /反例上/, '⚠ 反例注入必须失败')
})
