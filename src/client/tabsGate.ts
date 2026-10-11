/**
 * 侧栏 tab 的行门控（纯函数，便于断言）。
 *
 * 规则（`docs/DESIGN-SUBPLUGINS.md` §3）：
 *  ① 行被停用 ⇒ tab **直接不渲染**（不是灰显）；
 *  ② **端点不可达/解析失败 ⇒ 失败放行**（`rows === null` 视为"全开"，别让网络抖动把界面整块弄没）；
 *  ③ 全被关掉 ⇒ 调用方不渲染 tab 条；当前页被停用 ⇒ 回落到首个可用 tab（否则白屏）。
 */
export interface TabLike<K extends string> {
  key: K
  label: string
  full: string
  row: string
}

export interface TabGate<K extends string> {
  visible: Array<TabLike<K>>
  /** 当前页不可用时的回落页（全关时为 null） */
  fallback: K | null
  /** 是否整条隐藏（tab 条不渲染） */
  hideBar: boolean
}

export function gateTabs<K extends string>(tabs: readonly TabLike<K>[], rows: ReadonlySet<string> | null, current: K): TabGate<K> {
  const visible = tabs.filter((t) => rows === null || rows.has(t.row))
  const currentRow = tabs.find((t) => t.key === current)?.row
  const currentOk = rows === null || (currentRow !== undefined && rows.has(currentRow))
  return {
    visible,
    fallback: currentOk ? null : (visible[0]?.key ?? null),
    hideBar: visible.length === 0,
  }
}
