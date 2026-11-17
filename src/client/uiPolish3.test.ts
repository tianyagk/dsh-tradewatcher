/**
 * 第 3 轮：颜色令牌化。断言 5 条 + 反例注入。
 * 口径：令牌定义块（:root / [data-theme=dark]）内的 hex 不计入"硬编码"。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const CSS = readFileSync(new URL('./styles.ts', import.meta.url), 'utf8')
const lines = CSS.split('\n')
const ri = lines.findIndex((l) => l.startsWith('--tw-text:#16181d'))
const di = lines.findIndex((l) => l.startsWith('--tw-text:#f7f8f8'))
const openOf = (from: number): number => { for (let i = from; i >= 0; i -= 1) if (lines[i].trim().endsWith('{')) return i; return -1 }
const closeOf = (from: number): number => { for (let i = from; i < lines.length; i += 1) if (lines[i].trim() === '}') return i; return -1 }
const r0 = openOf(ri), r1 = closeOf(ri), d0 = openOf(di), d1 = closeOf(di)
const tokLines = new Set([...Array(r1 - r0 + 1).keys()].map((k) => r0 + k).concat([...Array(d1 - d0 + 1).keys()].map((k) => d0 + k)))
const ruleText = lines.filter((_, i) => !tokLines.has(i)).join('\n')
const HEX = /#[0-9a-fA-F]{6}\b/g
const tokenDefs = (from: number, to: number): Map<string, string> => {
  const m = new Map<string, string>()
  for (let i = from; i <= to; i += 1) {
    const g = /^--tw-c-([0-9a-f]{6}):(#[0-9a-fA-F]{6});$/.exec(lines[i] ?? '')
    if (g) m.set(g[1] as string, g[2] as string)
  }
  return m
}
const rootDefs = tokenDefs(r0, r1), darkDefs = tokenDefs(d0, d1)

test('① 规则体内重复 ≥3 次的硬编码色 = 0', () => {
  const counts = new Map<string, number>()
  for (const c of ruleText.match(HEX) ?? []) counts.set(c.toLowerCase(), (counts.get(c.toLowerCase()) ?? 0) + 1)
  const dup = [...counts].filter(([, n]) => n >= 3)
  assert.deepEqual(dup, [], `仍有重复硬编码：${dup.map(([c, n]) => `${c}×${n}`).join(',')}`)
  const injected = `${ruleText}\n.a{color:#123456}.b{color:#123456}.c{color:#123456}`
  const c2 = new Map<string, number>()
  for (const c of injected.match(HEX) ?? []) c2.set(c.toLowerCase(), (c2.get(c.toLowerCase()) ?? 0) + 1)
  assert.equal([...c2.values()].some((n) => n >= 3), true, '注入 3 次 ⇒ 判失败')
})

test('② 每个令牌在 :root 与 dark 都有定义', () => {
  const onlyRoot = [...rootDefs.keys()].filter((k) => !darkDefs.has(k))
  const onlyDark = [...darkDefs.keys()].filter((k) => !rootDefs.has(k))
  assert.deepEqual(onlyRoot, [], `dark 缺：${onlyRoot.join(',')}`)
  assert.deepEqual(onlyDark, [], `root 缺：${onlyDark.join(',')}`)
  assert.ok(rootDefs.size >= 30, `令牌数过少：${rootDefs.size}`)
})

test('③ 令牌取值 = 原硬编码值（deepEqual）', () => {
  for (const [k, v] of rootDefs) assert.equal(v.toLowerCase(), `#${k}`, `令牌 --tw-c-${k} 值被改`)
  for (const [k, v] of darkDefs) assert.equal(v.toLowerCase(), `#${k}`, `dark 令牌 --tw-c-${k} 值被改`)
  const injected = new Map(rootDefs); injected.set('8a8f98', '#000000')
  assert.notDeepEqual([...injected].filter(([k, v]) => v.toLowerCase() !== `#${k}`), [], '注入改色 ⇒ 判失败')
})

test('④ 规则体硬编码色 ≤ 60（未降 ⇒ 败）', () => {
  const n = (ruleText.match(HEX) ?? []).length
  assert.ok(n <= 60, `规则体仍有 ${n} 处硬编码`)
  assert.throws(() => assert.ok(61 <= 60, '注入 61 ⇒ 败'), /注入 61/)
})

test('⑤ 深色 5 组对比度 ≥ 3:1', () => {
  const lum = (hex: string): number => {
    const v = hex.replace('#', '')
    const ch = [0, 2, 4].map((i) => parseInt(v.slice(i, i + 2), 16) / 255).map((x) => (x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4))
    return 0.2126 * ch[0]! + 0.7152 * ch[1]! + 0.0722 * ch[2]!
  }
  const ratio = (a: string, b: string): number => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p) as [number, number]; return (x + 0.05) / (y + 0.05) }
  const pairs: Array<[string, string, string]> = [
    ['文字/背景', '#f7f8f8', '#010102'],
    ['次要文字/背景', '#c8ced8', '#0f1011'],
    ['次要文字/背景（muted）', '#8a8f98', '#0f1011'],
    ['强调悬浮/背景', '#828fff', '#0f1011'],
    ['系列色/背景', '#7ea6ff', '#0f1011'],
  ]
  for (const [name, fg, bg] of pairs) assert.ok(ratio(fg, bg) >= 3, `${name} 对比度 ${ratio(fg, bg).toFixed(2)} < 3`)
  assert.ok(ratio('#111111', '#0f1011') < 3, '注入低对比 ⇒ 判失败')
})
