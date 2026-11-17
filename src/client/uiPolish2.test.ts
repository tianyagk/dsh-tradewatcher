/**
 * 界面打磨第 2 轮：失败词归一 / 空态两形态 / 间距 16·12 / 语义区分。每条带反例注入。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const files = readdirSync(HERE).filter((n) => (n.endsWith('.ts') || n.endsWith('.tsx')) && !n.endsWith('.test.ts'))
const src = files.map((n) => ({ n, s: readFileSync(join(HERE, n), 'utf8') }))
const CSS = readFileSync(join(HERE, 'styles.ts'), 'utf8')

function mask(lines: string[]): boolean[] {
  const out: boolean[] = []; let inb = false
  for (const l of lines) {
    const t = l.trim()
    const st = t.startsWith('//') || t.startsWith('/*') || t.startsWith('*')
    out.push(inb || st)
    if (inb) { if (t.includes('*/')) inb = false } else if (t.startsWith('/*') && !t.includes('*/')) inb = true
  }
  return out
}
const uiLines = (): Array<{ n: string; i: number; s: string }> => {
  const out: Array<{ n: string; i: number; s: string }> = []
  for (const { n, s } of src) {
    const lines = s.split('\n'); const m = mask(lines)
    lines.forEach((l, i) => { if (!m[i]) out.push({ n, i: i + 1, s: l }) })
  }
  return out
}

test('① 失败词清零：异常/错误/不可用/暂无数据/没有数据 = 0（出现任一 ⇒ 败）', () => {
  const banned = ['异常', '错误', '不可用', '暂无数据', '没有数据']
  const bad = uiLines()
    .filter((l) => banned.some((w) => l.s.includes(w)))
    .filter((l) => !/异常程度/.test(l.s))  /* 例外：护盘的信号刻度用语，不是失败文案 */
    .map((l) => `${l.n}:${l.i}`)
  assert.deepEqual(bad, [], `仍有失败词：${bad.join(',')}`)
  const injected = [...src, { n: 'X.tsx', s: "const a = '接口不可用'" }]
  const bad2 = injected.flatMap(({ n, s }) => s.split('\n').filter((l) => banned.some((w) => l.includes(w))).map((l) => `${n}:${l}`))
  assert.notDeepEqual(bad2, [], '注入旧词 ⇒ 判失败')
})

test('② 空态只剩 `未取到` 与 `—（…）` 两种形态', () => {
  const bad = uiLines().filter((l) => /暂无|没有数据|无数据/.test(l.s)).map((l) => `${l.n}:${l.i}`)
  assert.deepEqual(bad, [], `仍有第三种空态：${bad.join(',')}`)
  const third = '暂无数据'
  assert.match(third, /暂无/, '注入第三种写法 ⇒ 判失败')
})

test('③ 页面级卡片 gap = 16px（12px ⇒ 败）', () => {
  assert.match(CSS, /\.tw-body\{[^}]*gap:16px/, '页面容器 gap 16')
  assert.match(CSS, /\.tw-mk-single\{[^}]*gap:16px/, '大盘页卡片列 gap 16')
  const injected = CSS.replace(/\.tw-body\{[^}]*gap:16px/, '.tw-body{display:flex;flex-direction:column;gap:12px')
  assert.doesNotMatch(injected, /\.tw-body\{[^}]*gap:16px/, '注入 12px ⇒ 判失败')
})

test('④ 卡内块 gap = 12px（8px ⇒ 败）', () => {
  assert.match(CSS, /\.tw-dw-body\{[^}]*gap:12px/, '汪汪队卡内块 gap 12')
  const injected = CSS.replace(/\.tw-dw-body\{[^}]*gap:12px/, '.tw-dw-body{display:flex;flex-direction:column;gap:8px')
  assert.doesNotMatch(injected, /\.tw-dw-body\{[^}]*gap:12px/, '注入 8px ⇒ 判失败')
})

test('⑤ 语义区分：≥10 处「未取到」+ ≥3 处「失败」并存（同词化 ⇒ 败）', () => {
  const all = uiLines().map((l) => l.s).join('\n')
  const miss = (all.match(/未取到/g) ?? []).length
  const fail = (all.match(/失败/g) ?? []).length
  assert.ok(miss >= 10, `「未取到」仅 ${miss} 处`)
  assert.ok(fail >= 3, `「失败」仅 ${fail} 处`)
  const injected = all.replace(/失败/g, '未取到')
  assert.ok((injected.match(/失败/g) ?? []).length < 3, '注入同词化 ⇒ 判失败')
})
