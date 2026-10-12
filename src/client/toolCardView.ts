/**
 * 工具卡片的外观与交互常量（**纯模块**：零 React 运行时依赖，只有类型导入 ⇒ 可被 node:test 直接读）。
 *
 * 为什么单独一个文件：用户这一批要求"卡片要能看出是控件（悬浮阴影 + 圆角）、整卡可点（真实按钮语义）"。
 * 这两件事以前是**写在 JSX 里的内联字面量** ⇒ 断言只能靠正则去源码里捞字符串（脆且容易漏）。
 * 把它们下沉成常量后：
 *   · 页面 `{ ...CARD_PROPS, style: CARD_STYLE }` 直接用**同一个对象**；
 *   · 断言直接读这个对象（`toolCardView.test.ts` / `toolsPage.test.ts`），因此断言锚的是真实现而不是期望值。
 *
 * ⚠ 颜色/阴影一律走主题 token（`var(--tw-*)`）：跟随 DSH 主题，**不硬编码深色**。
 */
import type { CSSProperties } from 'react'

/** 卡片根元素标签：**原生 button** ⇒ 自带按钮语义（Tab 可达、Enter/Space 触发），不需要 role 补丁 */
export const CARD_TAG = 'button'

/**
 * 卡片根元素的交互 props（不含 `key` / 事件 / 无障碍名，那些由页面按卡片给）。
 *
 * `tabIndex: 0` 对原生 button 来说是默认值，这里显式写出来是为了**可断言**：
 * "整卡可点 + 键盘可达"这条用户要求必须能被测试读出来，而不是靠"按钮本来就该能 Tab"的约定。
 * `type: 'button'` 防止将来这张卡被放进表单里变成提交按钮。
 */
export const CARD_PROPS = { type: 'button', tabIndex: 0 } as const

/**
 * 卡片外观：**悬浮阴影 + 圆角**的卡片控件（内联样式，覆盖 `.tw-panel` 的扁平观感）。
 *
 * `boxShadow` 用 `--tw-shadow-lg`：深浅两套主题里都有定义（`styles.ts`），且**不是** none；
 * `borderRadius` 12 ⇒ 明确的圆角（`.tw-panel` 的 10px 会被内联值覆盖，取值差异见下一条注释）。
 */
export const CARD_STYLE: CSSProperties = {
  background: 'var(--tw-card)',
  border: '1px solid var(--tw-border)',
  borderRadius: 12,
  boxShadow: 'var(--tw-shadow-lg)',
  padding: '10px 12px',
  textAlign: 'left',
  display: 'flex',
  flexDirection: 'column',
  gap: 6,
  cursor: 'pointer',
  minHeight: 104,
  width: '100%',
}

/**
 * 卡片外观判据（**唯一实现**，页面/断言共用）：阴影与圆角必须真的存在。
 *
 * 用户口径是"要有悬浮阴影 + 圆角"，**不锁具体像素值** ⇒ 这里只判"非空、非 none、非零"。
 * 写法上也刻意不允许 `0` / `0px` / `''`：那等于把这条要求关掉了。
 */
export function cardBoxProblems(style: { boxShadow?: unknown; borderRadius?: unknown }): string[] {
  const bad: string[] = []
  const shadow = typeof style.boxShadow === 'string' ? style.boxShadow.trim().toLowerCase() : ''
  if (shadow === '' || shadow === 'none' || shadow === '0' || shadow === '0 0') bad.push(`卡片缺少 box-shadow（用户要求悬浮阴影；实得 ${JSON.stringify(style.boxShadow)}）`)
  const raw = style.borderRadius
  const radius = typeof raw === 'number' ? String(raw) : typeof raw === 'string' ? raw.trim() : ''
  if (radius === '' || /^0(\.0+)?(px|em|rem|%|vw|vh)?$/.test(radius) || radius === 'none') bad.push(`卡片缺少 border-radius（用户要求圆角；实得 ${JSON.stringify(raw)}）`)
  return bad
}

/**
 * 卡片无障碍/可点判据（唯一实现）：必须是**原生按钮语义**且键盘可达。
 *
 * 键盘可达 = ① 根元素是 `button`（隐式 role=button、隐式 tabIndex=0、Enter/Space 触发）；
 *            ② 显式 `tabIndex >= 0`（不被 -1 踢出 Tab 序列）；③ 不是 disabled（禁用按钮不可聚焦）。
 */
export function cardA11yProblems(tag: unknown, props: { type?: unknown; tabIndex?: unknown; disabled?: unknown }): string[] {
  const bad: string[] = []
  if (tag !== 'button') bad.push(`卡片根元素必须是原生 button（真实按钮语义 + 键盘可达；实得 ${JSON.stringify(tag)}）`)
  if (props.type !== 'button') bad.push(`卡片必须写 type='button'（实得 ${JSON.stringify(props.type)}）`)
  const ti = props.tabIndex
  const focusable = typeof ti === 'number' && ti >= 0
  if (!focusable) bad.push(`卡片必须在 Tab 序列里（tabIndex 必须 >= 0；实得 ${JSON.stringify(ti)}）`)
  if (props.disabled === true) bad.push('卡片不许是 disabled（禁用按钮不可聚焦，等于键盘不可达）')
  return bad
}
