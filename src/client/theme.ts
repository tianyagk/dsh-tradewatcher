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
  up: '#ff5f6d',
  down: '#27a644',
  flat: '#6f7787',
} as const

/**
 * 徽标底色：涨跌两档**跟随 `prefs.redUp`**，中性档与色义无关。
 *
 * 为什么要有这个函数而不是直接查表：徽标渲染在主题容器之外（拿不到 `--tw-up`/`--tw-down`），
 * 只写死一套色就等于假设 `redUp === true` —— 用户把色义切成"绿涨红跌"时，徽标会把涨跌**画反**
 * （面板里换得动、侧栏换不动，是最难被发现的那类不一致）。
 *
 * ⚠ 曾经还有一档 `rescue`（护盘橙，`#d97706`）：那是"护盘 ≥ 疑似就在徽标显示「护」"的残留，
 * 2026-10-16 按用户要求删除（见 `badgeView.ts` 文件头）。**不要**为了给别的东西上色而复活它 ——
 * 那等于把等级文案重新接回这个 18px 的位置。
 */
export function badgeToneColor(tone: 'up' | 'down' | 'flat', redUp: boolean): string {
  if (tone === 'flat') return BADGE_TONE_COLOR.flat
  const colorUp = redUp ? BADGE_TONE_COLOR.up : BADGE_TONE_COLOR.down
  const colorDown = redUp ? BADGE_TONE_COLOR.down : BADGE_TONE_COLOR.up
  return tone === 'up' ? colorUp : colorDown
}

/** 四态色点（与徽标同源同色） */
export const QUOTE_STATE_COLOR = {
  live: '#27a644',
  delayed: '#e0a94a',
  settled: '#8a8f98',
  missing: '#ff5f6d',
} as const

/**
 * 筹码三条语义线的**主题 token 名**（值定义在 `styles.ts` 的深浅两套变量里）。
 *
 * 为什么是语义线：平均成本/压力(P95)/支撑(P5) 描述的是**筹码分布的位置**，不是涨跌 ⇒
 * **不许**用红/绿（那两色在本插件里是涨跌语义），也别跟获利/套牢两色混。
 * 三条线一律只引用 token 名，源码里不出现任何硬编码色值。
 */
export const CHIPS_LINE_TOKENS = {
  avg: 'var(--tw-chip-avg)',
  resistance: 'var(--tw-chip-res)',
  support: 'var(--tw-chip-sup)',
  grid: 'var(--tw-chips-grid)',
} as const

