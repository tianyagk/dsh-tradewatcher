/**
 * **读侧归一**：把"紧凑编码（新宿主）"与"完整编码（老宿主 / 本地缓存 / 归档）"归一成同一种形状
 * （AUDIT-IMPL77 第 2 项）。
 *
 * 为什么必须有这一层：宿主为了省字节，`/kline` 不再发送 `pct:null`、`/trend` 单日序列的逐点
 * `label` 只留 `HH:mm`（日期在 `labelDay`）。**读侧不能把缺省当 0 / 当空**：
 *  - `pct` 缺省 ⇒ `null`（上游没给），不是 0%；
 *  - `label` 缺省日期 ⇒ 用 `labelDay` 补回 `YYYY-MM-DD HH:mm`；没有 `labelDay` 时原样（老宿主本来就是完整标签）。
 *
 * 已写入的旧缓存/归档仍是完整编码 ⇒ 本函数对两种编码都成立（双编码兼容）。
 */

/** K 线单根的涨跌幅：`undefined`（新宿主省掉了 null）⇒ `null`，**绝不补 0** */
export function klinePctOf(day: { pct?: number | null }): number | null {
  const v = day.pct
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

/**
 * 分时逐点标签归一：紧凑编码（`labelFormat === 'hhmm'` + `labelDay`）⇒ 还原成 `YYYY-MM-DD HH:mm`。
 * 老编码（完整 label）⇒ 原样返回；缺 `label` 的脏数据 ⇒ `''`（不编时间）。
 */
export function normalizeTrendLabels<T extends { label?: string }>(
  points: readonly T[],
  labelDay?: string | null,
  labelFormat?: string | null,
): Array<T & { label: string }> {
  const compact = labelFormat === 'hhmm' && typeof labelDay === 'string' && labelDay !== ''
  return points.map((p) => {
    const label = typeof p.label === 'string' ? p.label : ''
    return { ...p, label: compact && !label.includes('-') ? `${labelDay} ${label}` : label }
  })
}

/** `/kline` 的读侧归一（days 逐根：`pct` 缺省 ⇒ null；`vol` 不动） */
export function normalizeKlineDays<T extends { pct?: number | null }>(days: readonly T[]): Array<T & { pct: number | null }> {
  return days.map((d) => ({ ...d, pct: klinePctOf(d) }))
}
