/**
 * 自选页的纯视图逻辑（不 import react ⇒ 能在 node 里直接断言）。
 */

/**
 * 行业/板块取数失败时给**受影响控件**的悬停原因（v0.69.1）。
 *
 * 面板级那一行已按用户要求删除，但降级事实（上游状态 / 失败时刻 / 会不会自动重试）**不许丢** ⇒
 * 统一由这个纯函数产出，挂在「板块 —」「α —」两格的 `title` 与 `aria-label` 上（键盘/触屏也拿得到）。
 */
export function indReasonOf(state: { at: number | null; error: string | null }): string {
  // ⚠ 时刻**一律北京时间**（`timeZone` 写死）：宿主机不在东八区时，用宿主本地时区会把 17:38 显示成别的钟点
  // （项目既有规矩：`marketTime.ts` 同样写死 `Asia/Shanghai`；这条以前那行常驻文案是宿主本地时区，顺手修掉）
  const at = state.at === null
    ? '时刻未知'
    : new Date(state.at).toLocaleTimeString('zh-CN', { hour12: false, timeZone: 'Asia/Shanghai' })
  return `板块涨跌与 α 本次未取到 · ${at} · ${state.error ?? '上游不可用'}；下一次行情轮询会自动重试`
}
