import { shClockText, shStampText } from './marketTime.ts'

/** Client-side formatting helpers (pure). */

export function fmtPrice(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—'
  const abs = Math.abs(n)
  let digits = 2
  if (abs > 0 && abs < 10) digits = 3
  return n.toFixed(digits)
}

export function fmtSigned(n: number | null | undefined, digits = 2): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—'
  const sign = n > 0 ? '+' : n < 0 ? '-' : ''
  return `${sign}${Math.abs(n).toFixed(digits)}`
}

/** Direction glyph for double-encoded semantics (▲/▼ + color). */
export function pctArrow(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n) || n === 0) return ''
  return n > 0 ? '▲' : '▼'
}

/** Percent with double encoding: arrow + magnitude (direction implied by the
 *  arrow, color by the theme semantic tokens). */
export function fmtPct(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—'
  // 与 `pctArrow` 同源（同一套方向语义只许有一份实现）
  return `${pctArrow(n)}${Math.abs(n).toFixed(2)}%`
}

/**
 * 隐身模式的**唯一开关**（P0-8）。
 *
 * 金额必须走同一个出口，否则"隐身不彻底"是必然的：新增一个显示金额的地方只要
 * 忘了判断，就会在隐身视图下漏出真实数字。因此遮罩做在格式化函数内部，
 * 调用方不需要知道当前是哪个视图。
 *
 * 只影响**显示**：取数、告警、agent 工具返回完全不受影响（工具层根本不引这里）。
 */
let moneyMasked = false

export function setMoneyMask(on: boolean): void {
  moneyMasked = on
}

export function isMoneyMasked(): boolean {
  return moneyMasked
}

/** 金额（元）：受隐身模式影响 —— 隐身时输出等长的模糊占位（不是空字符串，布局不塌） */
export function fmtAmt(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—'
  if (moneyMasked) return '¥••••'
  const abs = Math.abs(n)
  if (abs >= 1e8) return `${(n / 1e8).toFixed(2)}亿`
  if (abs >= 1e4) return `${(n / 1e4).toFixed(2)}万`
  return n.toFixed(2)
}

/** 精确到分的金额（不做亿/万缩写）：同样受隐身模式影响 */
export function fmtRaw(n: number | null | undefined, digits = 2): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—'
  if (moneyMasked) return '¥••••'
  return n.toFixed(digits)
}

/** 金额（带符号）：盈亏/已实现等。同样受隐身模式影响（符号保留，方向仍可读） */
export function fmtMoneySigned(n: number | null | undefined, digits = 2): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—'
  if (moneyMasked) return n >= 0 ? '+¥••••' : '-¥••••'
  return fmtSigned(n, digits)
}

export function fmtBig(n: number | null | undefined): string {
  // raw integer-ish quantities (volume etc.)
  if (n === null || n === undefined || !Number.isFinite(n)) return '—'
  const abs = Math.abs(n)
  if (abs >= 1e8) return `${(n / 1e8).toFixed(2)}亿`
  if (abs >= 1e4) return `${(n / 1e4).toFixed(1)}万`
  return String(Math.round(n))
}

/**
 * 北京时间的 `HH:mm:ss`（**与浏览器时区无关**）。
 *
 * 旧实现用 `getHours()` 等本地取值 ⇒ 同一 epoch 在 UTC 浏览器显示 01:42、纽约 21:42，
 * 而这些时刻全都是**市场时间**（R5 红线）。现在统一走 `marketTime.ts` 的固定时区出口。
 */
export function fmtClock(ts: number): string {
  return shClockText(ts)
}

/** Direction class given redUp convention (CN red-up / international flipped). */
export function dirClass(n: number | null | undefined, redUp: boolean): string {
  if (n === null || n === undefined || !Number.isFinite(n) || n === 0) return 'tw-flat'
  const up = n > 0
  const redIsUp = redUp
  return (up === redIsUp) ? 'tw-up' : 'tw-down'
}

/**
 * 跨日历史时间戳 `MM-DD HH:mm`（用词表）。禁写 `toLocaleString('zh-CN')` 的默认输出
 * （`2026/10/9 14:32:05` —— 同一页既有 `14:32:05` 又有 `2026/10/9 14:32:05` 会被读成两种东西）。
 */
export function fmtStamp(ts: number | null | undefined): string {
  if (ts === null || ts === undefined || !Number.isFinite(ts)) return '—'
  // 同样是市场时间 ⇒ 固定北京时间（见 fmtClock 的说明）
  return shStampText(ts)
}

/** 绝对日期 `YYYY-MM-DD`（文件名/日界用） */
