/**
 * icon 简化 + 筹码区块的静态/纯函数断言（task-59 第 2、3 段）。
 *
 * 为什么用静态检查：这两个都是 React 组件（客户端测试跑在 node 里，没有 DOM 与 React 运行时），
 * 能核的是**结构契约**：icon 用原生 button/span（键盘可达）、aria/title 带完整原因、点击走 setRetry、
 * 旧长条不再渲染；筹码区块的滑杆边界与 blur 登记同理。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { clampIndex } from './chipsView.ts'

const here = dirname(fileURLToPath(import.meta.url))
const read = (rel: string): string => readFileSync(join(here, rel), 'utf8')

test('icon：原生 button/span（可聚焦）+ aria/title 带完整原因 + 点击走 setRetry', () => {
  const icon = read('./NoteIcon.tsx')
  assert.ok(icon.includes("type: 'button'"), '有重试动作时用原生 button ⇒ 回车/空格天然可触发')
  assert.ok(icon.includes('onKeyDown'), '显式补 keydown（Enter/Space），让"键盘触发"可核')
  assert.ok(icon.includes("role: 'note'"), '没有重试动作时用可聚焦的 note 角色')
  assert.ok(icon.includes('tabIndex: 0'), '无重试动作的形态也必须能 Tab 到')
  assert.ok(icon.includes("'aria-label': label"), 'aria-label 必须是含原因的完整句子')
  assert.ok(icon.includes('title:'), '悬停要有详情')
  const drawer = read('./QuoteDrawer.tsx')
  assert.ok((drawer.match(/React\.createElement\(NoteIcon/g) ?? []).length >= 3, '三个以上变体统一走 NoteIcon')
  assert.equal(drawer.includes('⚠ 详情不可用 · 上游限流，稍后自动重试'), false, '旧的长条文案不许再出现')
  assert.equal(/React\.createElement\(Btn, \{ onClick: \(\) => setRetry/.test(drawer), false, '旧的「重试」按钮已移除')
  assert.ok((drawer.match(/onRetry: \(\) => setRetry\(\(x\) => x \+ 1\)/g) ?? []).length >= 3, 'icon 点击必须走同一个 setRetry 自增')
})

test('筹码区块：滑杆索引边界 0 / N−1 / 越界都收敛', () => {
  assert.equal(clampIndex(0, 5), 0)
  assert.equal(clampIndex(4, 5), 4)
  assert.equal(clampIndex(99, 5), 4, '越界上界 ⇒ 收敛到 N−1')
  assert.equal(clampIndex(-3, 5), 0, '越界下界 ⇒ 收敛到 0')
  assert.equal(clampIndex(Number.NaN, 5), 4, 'NaN ⇒ 最新一天')
  assert.equal(clampIndex(0, 0), -1, '空序列 ⇒ −1（界面据此不渲染滑杆）')
})

test('筹码区块：默认展开、五日档隐藏并给原因、fqSupported=false 不给结论', () => {
  const panel = read('./ChipsPanel.tsx')
  assert.ok(panel.includes('useState(true)'), '默认展开')
  assert.ok(panel.includes('tw-chips-off'), '隐藏/不可用要有独立样式类（一行说明，不是空白）')
  assert.ok(panel.includes('只在分时/日K 及以上显示'), '五日档要给一行原因')
  assert.ok(panel.includes('d?.why'), '宿主给 why 时直接展示原因（指数/期货/样本不足）')
  assert.ok(panel.includes('dirClass('), '获利/套牢着色走 dirClass（跟随 redUp，不写死红绿）')
  assert.ok(panel.includes('disclaimer'), 'tooltip 必须带"不是预测/不是买卖建议"')
})

test('隐身档：筹码的容器与数字都登记进两条 data-blur 清单', () => {
  const styles = read('./styles.ts')
  assert.equal((styles.match(/tw-chips-nums, \.tw-chips-date, \.tw-chips-bar,/g) ?? []).length, 2, '两条清单都要有筹码数字面')
  assert.equal((styles.match(/\.tw-chips\):hover/g) ?? []).length, 1, '悬停显形容器列表要含筹码容器')
  assert.ok(styles.includes('.tw-noteicon{'), 'icon 样式存在')
  assert.ok(styles.includes('.tw-chips-bar{'), '筹码条形样式存在')
})
