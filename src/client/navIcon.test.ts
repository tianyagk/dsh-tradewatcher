/**
 * 导航/入口图标必须**钉住**（v0.99.0）。
 *
 * 起因：用户报告侧栏「盯盘」图标"被改成了趋势上升箭头"、且从未提过要改图标。
 * 追因结论（见 `docs/AUDIT-IMPL64.md`）：
 *   · 侧栏图标的字形自 `314f7d2`（v0.24.0 适配 Slots 契约）起就是现在这套 SVG（折线 + 右上箭头），
 *     `git log -S` 两个 path 串都只命中那一次提交；再往前是 `📈`（**同样是趋势字形**）；
 *   · 最近 8 个改过 `index.tsx` 的提交里**没有任何**图标改动；构建产物与源码一致。
 * ⇒ 本次"无需求却改动"在本仓库里**追不到**；但按纪律，导航图标自此**由断言钉死**：
 *   任何改动都必须同时改这条断言（改断言 = 显式声明"这是有意的"）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const read = (p: string): string => readFileSync(join(here, p), 'utf8')

/** **已批准**的侧栏字形（v0.24.0 起的现状；改它必须同时改这里） */
const APPROVED_SIDEBAR_PATHS = [
  'M1.6 10.4 5.9 5.6l2.7 2.4 5.4-5', // 走势折线
  'M10.6 3h4.2v4.2', // 右上箭头（**现状**：用户觉得它像"趋势上升箭头"）
]

/** 其它导航/入口字形（现状值，同样钉住） */
const APPROVED_GLYPHS: Array<[string, string]> = [
  ['配置（齿轮）', "'⚙'"],
  ['截图', "'▣'"],
  ['主题：自动', "'◐'"],
  ['主题：浅色', "'☀'"],
  ['主题：深色', "'☾'"],
]

test('侧栏图标：字形必须是已批准的那两个 path（不许被无声换掉）', () => {
  const src = read('index.tsx')
  for (const d of APPROVED_SIDEBAR_PATHS) {
    assert.ok(src.includes(`d: '${d}'`), `侧栏图标必须保留已批准的字形：${d}`)
  }
  assert.ok(/'svg'/.test(src), '侧栏图标是 SVG（不是 emoji：emoji 在不同平台字形不一致）')
  // 反例注入：把箭头那一段换成"光秃秃的上升箭头"（用户报告里看到的那种）⇒ 判据必败
  const injected = src.replace("d: 'M10.6 3h4.2v4.2'", "d: 'M8 13V3M4 7l4-4 4 4'")
  assert.notEqual(injected, src, '反例注入必须真改到源码')
  assert.ok(injected.includes("d: 'M8 13V3M4 7l4-4 4 4'"), '⚠ 反例（换成纯上升箭头）确实改掉了字形')
  assert.throws(
    () => assert.equal(injected.includes("d: 'M10.6 3h4.2v4.2'"), true, '反例上"必须是已批准字形"必须失败'),
    /反例上/,
    '⚠ 反例注入（侧栏图标换成上升箭头）必须让断言失败',
  )
})

test('其它导航/入口字形：也必须是已批准的字面量（改 = 必须显式改断言）', () => {
  const top = read('TopBar.tsx')
  for (const [name, lit] of APPROVED_GLYPHS) {
    assert.ok(top.includes(lit), `${name} 字形必须保留：${lit}`)
  }
  // 反例注入：齿轮换成另一个字形 ⇒ 判据必败
  const injected = top.replace("'⚙'", "'⚙️'")
  assert.throws(
    () => assert.equal(injected.includes("'⚙'"), true, '反例上"齿轮字形必须不变"必须失败'),
    /反例上/,
    '⚠ 反例注入（换掉已批准字形）必须让断言失败',
  )
})
