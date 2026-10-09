/**
 * 客户端**必须用字面量色值**的两处色板（侧栏徽标 / 四态色点）。
 *
 * 为什么不能直接用 `var(--tw-up)`：这两处渲染在**主题容器之外**（徽标挂在 DSH 侧栏、
 * 色点有自己的宿主），拿不到 `.tw-root` 上的 CSS 变量作用域，只能写字面量。
 *
 * ⚠ 这里的值是**深色主题**下的近似值，与面板内的 `--tw-up`/`--tw-down` 不是同一个色。
 * 要彻底一致需要宿主把主题变量暴露给插件（或改成渲染进面板容器）——本轮不做，
 * 集中到一处是为了**下轮改的时候只改一个地方**（审计 S6）。
 */
export const BADGE_TONE_COLOR = {
  rescue: '#d97706',
  up: '#ff5f6d',
  down: '#27a644',
  flat: '#6f7787',
} as const

/** 四态色点（与徽标同源同色） */
export const QUOTE_STATE_COLOR = {
  live: '#27a644',
  delayed: '#e0a94a',
  settled: '#8a8f98',
  missing: '#ff5f6d',
} as const
