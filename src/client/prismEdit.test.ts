/** 行内编辑 + 约束字段级错误（12 条）。 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { positionErrorOf } from './prismForm.ts'

const PAGE = readFileSync(new URL('./PrismPage.tsx', import.meta.url), 'utf8')
const CSS = readFileSync(new URL('./styles.ts', import.meta.url), 'utf8')

test('① 编辑态进入：编辑按钮设置 editSecid 与初值', () => {
  assert.match(PAGE, /onClick: \(\) => \{ setEditSecid\(p\.secid\); setEditDraft\(\{ shares: String\(p\.qty\), cost: String\(p\.cost\) \}\)/)
})
test('② 编辑态退出：取消按钮', () => {
  assert.match(PAGE, /onClick: \(\) => \{ setEditSecid\(null\); setRowErr\(null\) \}/)
})
test('③ 保存请求体：op update + shares + cost', () => {
  assert.match(PAGE, /api\.prismPosition\(\{ op: 'update', secid: editSecid, shares: Number\(editDraft\.shares\), cost: Number\(editDraft\.cost\) \}\)/)
})
test('④ 非法输入禁用保存（disabled: saving || editError !== null）', () => {
  assert.match(PAGE, /disabled: saving \|\| editError !== null/)
})
test('⑤ 行内错误展示（编辑条 tw-ad-rowerr，不再用表格 colSpan）', () => {
  assert.match(PAGE, /className: 'tw-ad-editbar tw-ad-rowerr'/)
  assert.match(PAGE, /editError \?\? rowErr/)
  assert.match(CSS, /\.tw-ad-rowerr\{color:var\(--tw-danger\);font-size:12px/)
})
test('⑥ 约束字段级错误映射', () => {
  assert.match(PAGE, /const hit = LIMITS\.find\(\(\[k\]\) => msg\.includes\(k\)\)/)
  assert.match(PAGE, /setFieldErr\(\{ \[hit\[0\]\]: msg \}\)/)
})
test('⑦ 退化路径：未命中字段写卡片底部', () => {
  assert.match(PAGE, /if \(hit === undefined\) setSaveErr\(msg\)/)
})
test('⑧ 成功后刷新', () => {
  assert.match(PAGE, /if \(r\.ok\) \{ setEditSecid\(null\); load\(\) \}/)
})
test('⑨ 成本必须正数', () => { assert.match(PAGE, /'成本必须是正数'/) })
test('⑩ 股数校验沿用纯函数', () => {
  assert.equal(positionErrorOf('510300', 150), '股数必须是 100 的整数倍')
  assert.equal(positionErrorOf('510300', 200), null)
})
test('⑪ 字段错误样式 12px 红字', () => { assert.match(CSS, /\.tw-ad-fielderr\{color:var\(--tw-danger\);font-size:12px\}/) })
test('⑫ 行内输入样式 + 焦点', () => {
  assert.match(CSS, /\.tw-ad-inline\{[^}]*font-size:12px/)
  assert.match(CSS, /\.tw-ad-inline:focus-visible\{outline:2px solid var\(--tw-accent\)/)
})
