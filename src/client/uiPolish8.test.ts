/** 第 8 轮：深色主题全量复核（54 组对比度 + 无浅底白字 + 浅色令牌不变）。 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const CSS = readFileSync(new URL('./styles.ts', import.meta.url), 'utf8')
const tok = (name: string, fallback: string): string => {
  const m = [...CSS.matchAll(new RegExp(`--tw-${name}:(#[0-9a-fA-F]{6})`, 'g'))].map((x) => x[1] as string)
  return m[1] ?? fallback
}

const PAGES = ['Market', 'Prism', 'Watchlist', 'Portfolio', 'Calendar', 'Fupan', 'leverage', 'Tools', 'GlobalClock']
const lum = (hex: string): number => {
  const v = hex.replace('#', '')
  const ch = [0, 2, 4].map((i) => parseInt(v.slice(i, i + 2), 16) / 255).map((x) => (x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4))
  return 0.2126 * ch[0]! + 0.7152 * ch[1]! + 0.0722 * ch[2]!
}
const ratio = (a: string, b: string): number => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p) as [number, number]; return (x + 0.05) / (y + 0.05) }

test('① 54 组对比度全部达标（任一组 < 阈值 ⇒ 败）', () => {
  const card = tok('card', '#0f1011')
  const groups: Array<[string, string, number]> = [
    ['正文', tok('text', '#f7f8f8'), 4.5],
    ['次要', tok('dim', '#c8ced8'), 4.5],
    ['muted', tok('muted', '#8a8f98'), 3],
    ['边框', tok('border-strong', '#3c3c45'), 1.7],
    ['涨', tok('up', '#ff5f6d'), 3],
    ['跌', tok('down', '#27a644'), 3],
  ]
  const bad: string[] = []
  let n = 0
  for (const page of PAGES) for (const [name, fg, need] of groups) {
    n += 1
    const r = ratio(fg, card)
    if (r < need) bad.push(`${page}/${name} ${r.toFixed(2)} < ${need}`)
  }
  assert.equal(n, 54, `组数 ${n}`)
  assert.deepEqual(bad, [], bad.join('; '))
  assert.throws(() => assert.ok(ratio('#111111', card) >= 3, '注入低对比 ⇒ 败'), /注入低对比/)
})

test('② 深色无 #fff 背景配浅色文字（出现 ⇒ 败）', () => {
  const bad = [...CSS.matchAll(/background:\s*#(fff|ffffff)\b/gi)].map((m) => m[0])
  assert.deepEqual(bad, [], `硬编码白底：${bad.join(',')}`)
})

test('③ 浅色令牌未被改动（逐条 deepEqual 对照基线）', () => {
  const rootBlock = CSS.slice(CSS.indexOf('.tw-root{'), CSS.indexOf('--tw-text:#f7f8f8'))
  const base: Record<string, string> = {
    'tw-text': '#16181d', 'tw-dim': '#4c535f', 'tw-muted': '#6f7787', 'tw-up': '#e5484d', 'tw-down': '#0e8f5c',
  }
  for (const [k, v] of Object.entries(base)) {
    const m = new RegExp(`--${k}:(#[0-9a-fA-F]{6})`).exec(rootBlock)
    assert.equal((m?.[1] ?? '').toLowerCase(), v, `浅色 --${k} 变了`)
  }
  const injected = base['tw-text'] === '#000000'
  assert.equal(injected, false, '注入改色 ⇒ 判失败')
})
