/**
 * 工具卡片的**外观与交互**断言（用户 v0.74.0 第 ③ 条）。
 *
 * 为什么能直接断言：外观（阴影/圆角）与交互（按钮语义/键盘可达）都下沉到纯模块
 * `toolCardView.ts` 的常量里，页面用的是**同一个对象** ⇒ 断言读的就是真实现。
 * 判据不锁具体像素值（用户只说"要有阴影 + 圆角"）⇒ 只判"非空 / 非 none / 非零"。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CARD_PROPS, CARD_STYLE, CARD_TAG, cardA11yProblems, cardBoxProblems } from './toolCardView.ts'

test('③-1 卡片有悬浮阴影 + 圆角（判据不锁像素值：非空 / 非 none / 非零）', () => {
  const bad = cardBoxProblems(CARD_STYLE)
  assert.deepEqual(bad, [], `卡片外观判据未通过：${bad.join(' ／ ')}`)
  // 把实际值打出来当证据（它们不参与判据）
  const shadow = String(CARD_STYLE.boxShadow)
  const radius = String(CARD_STYLE.borderRadius)
  assert.equal(shadow.trim().toLowerCase() === 'none', false, `阴影不能是 none（实得 ${shadow}）`)
  assert.equal(Number(radius) > 0, true, `圆角必须大于零（实得 ${radius}）`)
  // 反例注入（关掉行为 ⇒ 判据必须非空）：这是"断言非恒真"的证据，跑在同一个判据上
  assert.notDeepEqual(cardBoxProblems({ ...CARD_STYLE, boxShadow: 'none' }), [], '⚠ 去掉阴影必须被抓到')
  assert.notDeepEqual(cardBoxProblems({ ...CARD_STYLE, boxShadow: '' }), [], '⚠ 阴影给空串必须被抓到')
  assert.notDeepEqual(cardBoxProblems({ ...CARD_STYLE, borderRadius: 0 }), [], '⚠ 圆角归零必须被抓到')
  assert.notDeepEqual(cardBoxProblems({ ...CARD_STYLE, borderRadius: '0px' }), [], '⚠ 圆角写成 0px 必须被抓到')
  // 反向（不许把判据写成"只认某一种写法"）：换一种合理的非零写法仍应通过
  assert.deepEqual(cardBoxProblems({ boxShadow: '0 1px 2px rgba(0,0,0,.12)', borderRadius: '12px' }), [], '合理的另一种写法必须通过（判据不锁具体值）')
})

test('③-2 卡片是真实按钮语义且键盘可达（原生 button + type=button + tabIndex>=0 + 非 disabled）', () => {
  const bad = cardA11yProblems(CARD_TAG, CARD_PROPS)
  assert.deepEqual(bad, [], `卡片交互判据未通过：${bad.join(' ／ ')}`)
  assert.equal(CARD_TAG, 'button', '根元素必须是原生 button（隐式 role=button、Enter/Space 触发、Tab 可达）')
  assert.equal(CARD_PROPS.type, 'button', 'type=button（不许变成表单里的提交按钮）')
  assert.equal(typeof CARD_PROPS.tabIndex === 'number' && CARD_PROPS.tabIndex >= 0, true, 'tabIndex 必须 >= 0（留在 Tab 序列里）')
  // 反例注入（关掉任一条件 ⇒ 判据必须非空）
  assert.notDeepEqual(cardA11yProblems('div', CARD_PROPS), [], '⚠ 换成 div 必须被抓到（没有按钮语义）')
  assert.notDeepEqual(cardA11yProblems(CARD_TAG, { ...CARD_PROPS, type: 'submit' }), [], '⚠ 改成 submit 必须被抓到')
  assert.notDeepEqual(cardA11yProblems(CARD_TAG, { ...CARD_PROPS, tabIndex: -1 }), [], '⚠ 踢出 Tab 序列必须被抓到')
  assert.notDeepEqual(cardA11yProblems(CARD_TAG, { ...CARD_PROPS, disabled: true }), [], '⚠ disabled 必须被抓到（不可聚焦）')
  assert.notDeepEqual(cardA11yProblems(CARD_TAG, { type: 'button' }), [], '⚠ 缺 tabIndex 必须被抓到')
})
