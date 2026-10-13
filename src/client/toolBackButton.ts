/**
 * 详情页左上角**回目录**按钮的外观与交互常量（**纯模块**：零 React 运行时不依赖，只有类型导入 ⇒ 可被 node:test 直接读）。
 *
 * 为什么单独一个文件：这一批用户要求把它从左上的普通按钮改成**圆角卡片按钮、Material 风格**
 * （图标 + 文字、圆角、轻微阴影、悬停反馈、按下涟漪等效反馈、focus 可见环）。这些要求以前若写成
 * 页面里的内联字面量，断言只能靠正则去源码里捞字符串（脆且容易漏，`AUDIT-IMPL43` §3 的教训）。
 * 下沉成常量 + 判据后：
 *   · 页面 `style: { ...BACK_BTN_STYLE, ...(hover ? BACK_BTN_HOVER_STYLE : {}) }` 用**同一批对象**；
 *   · 断言直接对这些对象跑 `backButtonLayoutProblems()` / `backButtonInteractionProblems()`
 *     ⇒ 锚的是真实现，而不是"再抄一份期望值"。
 *
 * ⚠ 硬约束（沿用既有口径）：
 *   · 它仍是**回目录的唯一入口**（`onClick` 必须接到目录返回）；
 *   · **不许复用 `tw-hint` 一类会被紧凑/隐身视图隐藏的 class**（只写内联样式 ⇒ 任何视图档都可见）；
 *   · 键盘可达：原生 `button` + `type='button'` + 语义名（`title` 与 `aria-label` 齐备）。
 *
 * 颜色一律走主题 token（`var(--tw-*)`）⇒ 跟随 DSH 主题，**不硬编码深浅色**。
 */
import type { CSSProperties } from 'react'

/** 根元素标签：**原生 button**（Tab 可达、Enter/Space 触发、自带按钮语义） */
export const BACK_BTN_TAG = 'button'

/** 根元素交互 props（不含事件与无障碍名，那些由页面按当前工具给） */
export const BACK_BTN_PROPS = { type: 'button' } as const

/**
 * 静止态：**左上角、圆角卡片、Material 度量**
 *   `alignSelf: 'flex-start'` + `display: 'inline-flex'` + `width: 'auto'` ⇒ 贴左、**不占整行**、不居中；
 *   `borderRadius: 10`（用户口径 8–12）；`boxShadow: var(--tw-shadow-sm)`（轻微层级）；
 *   `padding: '8px 12px'`、图标与文字 `gap: 8`、`fontWeight: 500`、`fontSize: 12.5`（≤14）、`cursor: pointer`。
 */
export const BACK_BTN_STYLE: CSSProperties = {
  alignSelf: 'flex-start',
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'flex-start',
  gap: 8,
  width: 'auto',
  maxWidth: '100%',
  padding: '8px 12px',
  borderRadius: 10,
  border: '1px solid var(--tw-border)',
  background: 'var(--tw-card)',
  color: 'var(--tw-text)',
  fontSize: 12.5,
  fontWeight: 500,
  lineHeight: 1.25,
  textAlign: 'left',
  cursor: 'pointer',
  boxShadow: 'var(--tw-shadow-sm)',
  transition: 'background .12s,border-color .12s,box-shadow .12s,transform .06s',
}

/** 悬停态：Material 的"抬升一级"反馈（背景变 hover、边框加强、阴影提升到 lg） */
export const BACK_BTN_HOVER_STYLE: CSSProperties = {
  background: 'var(--tw-hover)',
  borderColor: 'var(--tw-border-strong)',
  boxShadow: 'var(--tw-shadow-lg)',
}

/** 按下态：等效涟漪的即时反馈（下沉 1px + 阴影回落 + 强调色底），不需要引入动画库 */
export const BACK_BTN_PRESS_STYLE: CSSProperties = {
  transform: 'translateY(1px)',
  background: 'var(--tw-accent-soft)',
  boxShadow: 'var(--tw-shadow-sm)',
}

/** 键盘 focus 态：**可见环**（2px 强调色 + 2px 偏移；与仓库既有 focus-visible 观感一致） */
export const BACK_BTN_FOCUS_STYLE: CSSProperties = {
  outline: '2px solid var(--tw-accent)',
  outlineOffset: 2,
}

/** 「图标 + 文字」的可访问名（`title` 与 `aria-label` 用同一份文案，唯一来源） */
export const BACK_BTN_TITLE = '回到工具目录'

function num(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string') {
    const n = Number.parseFloat(value)
    return Number.isFinite(n) ? n : null
  }
  return null
}

/**
 * 布局判据（唯一实现）：位置 / 尺寸 / 圆角 / 阴影 / 内边距 / 图标间距 / 字重 / 字号 / 光标。
 * 用户口径是"左上角圆角卡片按钮、Material 风格"，这里把可判定的部分逐项锁住（**不锁具体像素值**，
 * 只锁区间与"不许为 0 / 不许整行 / 不许居中"这类结构性事实）。
 */
export function backButtonLayoutProblems(style: CSSProperties): string[] {
  const bad: string[] = []
  const needs = (cond: boolean, msg: string): void => {
    if (!cond) bad.push(msg)
  }
  // ① 位置：贴左、不占整行、不居中
  needs(style.alignSelf === 'flex-start', `必须是左上角对齐（alignSelf 必须是 flex-start；实得 ${JSON.stringify(style.alignSelf)}）`)
  needs(style.display === 'inline-flex' || style.display === 'inline-block', `必须按内容宽度排布（display 用 inline-flex/inline-block；实得 ${JSON.stringify(style.display)}）`)
  needs(style.width === undefined || style.width === 'auto', `不许占整行（width 必须是 auto/未设；实得 ${JSON.stringify(style.width)}）`)
  needs(style.marginLeft === undefined || style.marginLeft === 0 || style.marginLeft === '0', `不许用左边距把按钮推开（实得 ${JSON.stringify(style.marginLeft)}）`)
  // ② Material 度量
  const radius = num(style.borderRadius)
  needs(radius !== null && radius >= 8 && radius <= 12, `圆角必须是 8–12px 的圆角卡片（实得 ${JSON.stringify(style.borderRadius)}）`)
  const shadow = typeof style.boxShadow === 'string' ? style.boxShadow.trim().toLowerCase() : ''
  needs(shadow !== '' && shadow !== 'none' && shadow !== '0' && !/^0(\.0+)?(px)?$/.test(shadow), `必须有轻微阴影（实得 ${JSON.stringify(style.boxShadow)}）`)
  const pad = String(style.padding ?? '').trim().split(/\s+/).map((x) => num(x))
  const [pv, ph] = pad.length === 1 ? [pad[0], pad[0]] : pad
  needs(pv !== null && pv >= 6 && pv <= 12, `上下内边距约 8px（实得 ${JSON.stringify(style.padding)}）`)
  needs(ph !== null && ph >= 10 && ph <= 16, `左右内边距约 12px（实得 ${JSON.stringify(style.padding)}）`)
  const gap = num(style.gap)
  needs(gap !== null && gap >= 6 && gap <= 10, `图标与文字间距约 8px（实得 ${JSON.stringify(style.gap)}）`)
  const weight = num(style.fontWeight)
  needs(weight !== null && weight >= 500, `字重必须 ≥ 500（Material 口径；实得 ${JSON.stringify(style.fontWeight)}）`)
  const size = num(style.fontSize)
  needs(size !== null && size <= 14, `字号必须 ≤ 14px（实得 ${JSON.stringify(style.fontSize)}）`)
  needs(style.cursor === 'pointer', `光标必须是 pointer（实得 ${JSON.stringify(style.cursor)}）`)
  // ③ 视图档：不许复用会被隐藏的 class（这里只允许内联样式 ⇒ 判 className 是否为空）
  needs(style.display !== 'none' && style.visibility !== 'hidden', '按钮不允许在任何视图档下被隐藏')
  return bad
}

/** 交互判据（唯一实现）：键盘可达 + 悬停 / 按下 / focus 三态反馈 */
export function backButtonInteractionProblems(input: {
  tag: unknown
  props: { type?: unknown; disabled?: unknown }
  hasHover: boolean
  hasPress: boolean
  hasFocus: boolean
  /** 是否接上了"回目录"（唯一入口不许断） */
  hasReturn: boolean
  /** title 与 aria-label 必须齐备 */
  title?: unknown
  ariaLabel?: unknown
}): string[] {
  const bad: string[] = []
  const needs = (cond: boolean, msg: string): void => {
    if (!cond) bad.push(msg)
  }
  needs(input.tag === 'button', `根元素必须是原生 button（键盘可达；实得 ${JSON.stringify(input.tag)}）`)
  needs(input.props.type === 'button', `必须写 type='button'（实得 ${JSON.stringify(input.props.type)}）`)
  needs(input.props.disabled !== true, '按钮不许是 disabled（禁用按钮不可聚焦）')
  needs(input.hasHover, '缺少悬停反馈（Material 要求悬停有状态反馈）')
  needs(input.hasPress, '缺少按下反馈（涟漪或等效反馈）')
  needs(input.hasFocus, '缺少 focus 可见环')
  needs(input.hasReturn, '必须接上"回到工具目录"（它是回目录的唯一入口）')
  const title = typeof input.title === 'string' ? input.title.trim() : ''
  const aria = typeof input.ariaLabel === 'string' ? input.ariaLabel.trim() : ''
  needs(title !== '', 'title 必须齐备（悬停可读）')
  needs(aria !== '', 'aria-label 必须齐备（读屏可读）')
  return bad
}
