/** 第 9 轮：深色边框对比度余量。3 条断言 + 注入。 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const CSS = readFileSync(new URL('./styles.ts', import.meta.url), 'utf8')
const all = (name: string): string[] => [...CSS.matchAll(new RegExp(`--tw-${name}:(#[0-9a-fA-F]{6})`, 'g'))].map((m) => m[1] as string)
const tok = (blk: 'light' | 'dark', name: string): string => (blk === 'light' ? all(name)[0] : all(name)[1]) ?? ''
const lum = (hex: string): number => {
  const v = hex.replace('#', '')
  const ch = [0, 2, 4].map((i) => parseInt(v.slice(i, i + 2), 16) / 255).map((x) => (x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4))
  return 0.2126 * ch[0]! + 0.7152 * ch[1]! + 0.0722 * ch[2]!
}
const ratio = (a: string, b: string): number => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p) as [number, number]; return (x + 0.05) / (y + 0.05) }

test('① 深色边框对比度 ≥ 1.7（回落 1.54 ⇒ 败）', () => {
  const border = tok('dark', 'border-strong')
  assert.equal(border.toLowerCase(), '#3c3c45', `深色边框为 ${border}`)
  const r = ratio(border, tok('dark', 'card'))
  assert.ok(r >= 1.7, `对比度 ${r.toFixed(2)} < 1.7`)
  assert.throws(() => assert.ok(ratio('#34343a', '#0f1011') >= 1.7, '注入旧值 ⇒ 败'), /注入旧值/)
})

test('② 浅色边框未变（改 ⇒ 败）', () => {
  assert.equal(tok('light', 'border').toLowerCase(), '#e2e5ea')
  assert.equal(tok('light', 'border-strong').toLowerCase(), '#cfd3dc')
})

test('③ 其余令牌未变（逐条对照 v0.200.0）', () => {
  const L = ['--tw-text:#16181d', '--tw-dim:#4c535f', '--tw-muted:#6f7787', '--tw-up:#e5484d', '--tw-down:#0e8f5c', '--tw-card:#ffffff']
  for (const k of L) assert.ok(CSS.includes(k), `浅色缺 ${k}`)
  const D = ['--tw-text:#f7f8f8', '--tw-dim:#c8ced8', '--tw-muted:#8a8f98', '--tw-up:#ff5f6d', '--tw-down:#27a644', '--tw-card:#0f1011']
  for (const k of D) assert.ok(CSS.includes(k), `深色缺 ${k}`)
})
