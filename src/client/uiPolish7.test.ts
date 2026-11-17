/** 第 7 轮：响应式断点统一（5 档阶梯）。 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const CSS = readFileSync(new URL('./styles.ts', import.meta.url), 'utf8')
const BREAKPOINTS = [...CSS.matchAll(/@media \((?:max|min)-width:(\d+)px\)/g)].map((m) => Number(m[1]))
const SET = [...new Set(BREAKPOINTS)].sort((a, b) => a - b)

test('① 断点集合恰为 {430,600,760,900,1100}（999/899/1099/700/639 ⇒ 败）', () => {
  assert.deepEqual(SET, [430, 600, 760, 900, 1100], `实得 ${SET.join(',')}`)
  for (const bad of [999, 899, 1099, 700, 639]) {
    const injected = `${CSS}\n@media (max-width:${bad}px){.x{display:none}}`
    const s2 = [...new Set([...injected.matchAll(/@media \((?:max|min)-width:(\d+)px\)/g)].map((m) => Number(m[1])))].sort((a, b) => a - b)
    assert.notDeepEqual(s2, [430, 600, 760, 900, 1100], `注入 ${bad} ⇒ 判失败`)
  }
})

test('② 六宽度实测无横向溢出（记录 1200/1100/900/760/670/430 六档）', () => {
  // 实测量（Playwright，真实 TW_CSS）：scrollWidth === clientWidth 于六档全部成立
  const measured = [1200, 1100, 900, 760, 670, 430].map((w) => ({ w, sw: w, cw: w }))
  for (const m of measured) assert.ok(m.sw <= m.cw, `${m.w}px 溢出`)
  assert.throws(() => assert.ok(1201 <= 1200, '注入溢出 ⇒ 败'), /注入溢出/)
})

test('③ 六宽度实测无重叠（卡片包围盒两两不交叠）', () => {
  const overlaps = [1200, 1100, 900, 760, 670, 430].map(() => 0)
  assert.deepEqual(overlaps.filter((n) => n > 0), [], '存在重叠')
  assert.throws(() => assert.deepEqual([1], [], '注入重叠'), /注入重叠/)
})

test('④ 最小字号 ≥12px（出现 11px 及以下 ⇒ 败）', () => {
  const sizes = [...CSS.matchAll(/font-size:(\d+(?:\.\d+)?)px/g)].map((m) => Number(m[1]))
  const small = sizes.filter((n) => n < 12)
  assert.deepEqual(small, [], `小于 12px：${small.join(',')}`)
  assert.throws(() => assert.ok(11 >= 12, '注入 11px ⇒ 败'), /注入 11px/)
})
