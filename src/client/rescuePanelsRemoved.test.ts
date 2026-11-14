/**
 * v0.184.0：护盘卡内五块按用户要求下线（底部位置表 / 历史概率行 / 口径入口 / 今日信号时间线 / 历史回顾）。
 * ① 六个字面量不得出现 ② 今日 5 分钟抽样仍在 ③ 六卡/因子/分时量能仍在 ④ 无空容器。均带反例注入。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const read = (f: string): string => readFileSync(join(HERE, f), 'utf8')
const strip = (t: string): string => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
const panel = (): string => strip(read('RescuePanel.tsx'))

test('① 六个字面量（底部位置/触发后对照/历史概率/今日信号时间线/历史回顾/口径与边界）不得出现', () => {
  const src = panel()
  for (const word of ['底部位置', '触发后对照', '历史概率', '今日信号时间线', '历史回顾', '口径与边界']) {
    assert.equal(src.includes(word), false, `不得再出现「${word}」`)
  }
  const injected = `${src}\n'底部位置'\n`
  assert.throws(() => assert.equal(injected.includes('底部位置'), false, '反例上：字面量残留'), /反例上/, '⚠ 反例注入必须失败')
})

test('② 「今日 5 分钟抽样」仍渲染（删多 ⇒ 败）', () => {
  const src = panel()
  assert.equal(src.includes('今日 5 分钟抽样'), true, '抽样条必须保留')
  assert.equal(src.includes('tw-rescue-intraday'), true, '抽样条容器必须保留')
  assert.throws(() => assert.equal(src.split('今日 5 分钟抽样').join('').includes('今日 5 分钟抽样'), true, '反例上：删多了'), /反例上/, '⚠ 反例注入必须失败')
})

test('③ 六张 ETF 卡 / 因子明细 / 分时量能仍在（删多 ⇒ 败）', () => {
  const src = panel()
  assert.equal(src.includes('RESCUE_ETF_CATALOG') || src.includes('etfs.map'), true, 'ETF 卡必须保留')
  assert.equal(src.includes('tw-rescue-factor'), true, '因子明细表必须保留')
  assert.equal(src.includes('分时量能'), true, '分时量能必须保留')
  assert.equal(src.includes('共振'), true, '共振行必须保留')
  assert.throws(() => assert.equal(src.split('共振').join('').includes('共振'), true, '反例上：删多了'), /反例上/, '⚠ 反例注入必须失败')
})

test('④ 无空容器：删除块不留空 div / 空 panel（残留 ⇒ 败）', () => {
  const raw = read('RescuePanel.tsx')
  const src = strip(raw)
  // 删除位置附近不得留下 "React.createElement('div', { className: 'tw-panel' }, )" 这类空体
  assert.equal(/React\.createElement\('div', \{\s*className: 'tw-panel'[^}]*\},\s*\)/.test(src), false, '不得留空 panel')
  assert.equal(src.includes('tw-rescue-caliber-entry'), false, '口径入口（标记+样式）必须删干净')
  assert.equal(src.includes('tw-rescue-timeline'), false, '时间线类名必须删干净')
  assert.throws(() => assert.equal(`${src}\n'tw-rescue-timeline'`.includes('tw-rescue-timeline'), false, '反例上：类名残留'), /反例上/, '⚠ 反例注入必须失败')
})
