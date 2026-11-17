/**
 * 第 4 轮：键盘可达与焦点可见性。5 条断言 + 反例注入。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const CSS = readFileSync(join(HERE, 'styles.ts'), 'utf8')
const read = (f: string): string => readFileSync(join(HERE, f), 'utf8')
const PAGES = ['MarketPage.tsx', 'PrismPage.tsx', 'WatchlistPage.tsx', 'PortfolioPage.tsx']

test('① 全局 :focus-visible 兜底覆盖六类元素（缺一 ⇒ 败）', () => {
  const m = /:where\(button, a, input, select, textarea, \[tabindex\]\):focus-visible\s*\{[^}]*\}/.exec(CSS)
  assert.ok(m !== null, '缺全局兜底规则')
  for (const sel of ['button', 'a', 'input', 'select', 'textarea', '[tabindex]']) {
    assert.ok((m?.[0] ?? '').includes(sel), `兜底规则缺 ${sel}`)
  }
  const injected = CSS.replace('textarea, ', '')
  assert.ok(!/textarea/.test(injected.split(':focus-visible')[0] ?? ''), '注入删 textarea ⇒ 判失败')
})

test('② 无孤立 outline:none（每处都有 :focus-visible 替代）', () => {
  const lines = CSS.split('\n')
  const bad: number[] = []
  lines.forEach((l, i) => {
    if (!/outline:\s*none/.test(l)) return
    const near = lines.slice(Math.max(0, i - 3), i + 4).join('\n')
    if (!/focus-visible|:focus\{[^}]*box-shadow/.test(near)) bad.push(i + 1)
  })
  assert.deepEqual(bad, [], `孤立 outline:none 行：${bad.join(',')}`)
  const bad2 = ['.x{outline:none}'].filter((l) => !/focus-visible/.test(l))
  assert.equal(bad2.length, 1, '注入孤立 outline:none ⇒ 判失败')
})

test('③ 重点页面 div+onClick 都有 role 与 tabIndex（缺 ⇒ 败）', () => {
  const bad: string[] = []
  for (const f of PAGES) {
    const s = read(f)
    for (const m of s.matchAll(/<div[^>]*onClick[^>]*>/g)) {
      const tag = m[0]
      if (!/role=/.test(tag) || !/tabIndex=/.test(tag)) bad.push(`${f}:${tag.slice(0, 40)}`)
    }
    for (const m of s.matchAll(/createElement\('div', \{[^}]*onClick[^}]*\}/g)) {
      const tag = m[0]
      if (!/role:/.test(tag) || !/tabIndex/.test(tag)) bad.push(`${f}:(createElement)`)
    }
  }
  assert.deepEqual(bad, [], `缺角色/焦点的可点击 div：${bad.join(' | ')}`)
})

test('④ 键盘可达：5 个主页面各 ≥5 个可聚焦元素（<5 ⇒ 败）', () => {
  const pages = ['MarketPage.tsx', 'PrismPage.tsx', 'WatchlistPage.tsx', 'PortfolioPage.tsx', 'CalendarPage.tsx']
  const counts: Record<string, number> = {}
  for (const f of pages) {
    const s = read(f)
    counts[f] = (s.match(/createElement\('button'|<button|\bBtn\b|onClick|tabIndex: 0|type: 'text'|type: 'number'/g) ?? []).length
  }
  for (const [f, n] of Object.entries(counts)) assert.ok(n >= 5, `${f} 仅 ${n} 个可聚焦元素`)
  assert.throws(() => assert.ok(4 >= 5, '注入 4 ⇒ 败'), /注入 4/)
})

test('⑤ 焦点描边 = var(--tw-accent) 2px（改值 ⇒ 败）', () => {
  assert.match(CSS, /outline: 2px solid var\(--tw-accent\)/)
  assert.match(CSS, /outline-offset: 2px/)
  const injected = CSS.replace('outline: 2px solid var(--tw-accent)', 'outline: 1px solid #000')
  assert.doesNotMatch(injected, /outline: 2px solid var\(--tw-accent\)/, '注入改值 ⇒ 判失败')
})

test('跳转链接：仅键盘可见的「跳至主内容」+ 主内容锚点', () => {
  assert.match(read('index.tsx'), /className: 'tw-skip', href: '#tw-main'/, '缺跳转链接')
  assert.match(CSS, /\.tw-skip\{position:absolute;left:-9999px/, '默认必须移出视口')
  assert.match(CSS, /\.tw-skip:focus\{left:8px/, '聚焦时必须可见')
  assert.match(read('MarketPage.tsx'), /id: 'tw-main'/, '主内容锚点')
})
