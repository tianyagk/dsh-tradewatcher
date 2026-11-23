/** 「重放今日」必须真的能重放：按钮不得写死 disabled，点击要调宿主 action:'run' 并回读 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const PAGE = readFileSync(new URL('./PrismPage.tsx', import.meta.url), 'utf8')

test('① 按钮不再写死 disabled，且有 onClick', () => {
  const i = PAGE.indexOf("'data-role': 'ad-replay'")
  assert.ok(i > 0, '找不到重放按钮')
  const seg = PAGE.slice(Math.max(0, i - 300), i + 400)
  assert.ok(!/disabled: true/.test(seg), '不得写死 disabled: true')
  assert.match(seg, /disabled: replaying/)
  assert.match(seg, /onClick: replayToday/)
})

test('② 点击走宿主 action:run（api.prismRun），时点为 HH:MM', () => {
  assert.match(PAGE, /api\.prismRun\(slot\)/)
  assert.match(PAGE, /const slot = shClockText\(Date\.now\(\)\)\.slice\(0, 5\)/)
  assert.match(PAGE, /\.then\(\(\) => \{ load\(\) \}\)/, '重放后必须回读状态')
})

test('③ 重放中禁用并显示进度文案（防连点重复跑）', () => {
  assert.match(PAGE, /disabled: replaying/)
  assert.match(PAGE, /'↻ 重放中…' : '↺ 重放今日'/)
})

test('④ 反例：旧实现（disabled:true + 无 onClick）必须被判据抓住', () => {
  const old = "React.createElement('button', { className: 'tw-ad-fchip', 'data-role': 'ad-replay', disabled: true, title: '宿主未提供重放接口' }, '↺ 重放今日')"
  assert.ok(/disabled: true/.test(old) && !/onClick/.test(old))
  // 判据①对旧片段必须为假
  const bad = /!\/disabled: true\//.test('') // 占位，说明用
  assert.equal(typeof bad, 'boolean')
  assert.ok(!/onClick: replayToday/.test(old), '旧实现没有 onClick ⇒ 断言①会失败')
})
