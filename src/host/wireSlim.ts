/**
 * **二级瘦身**：`/kline` 的 `pct:null` 与 `/trend` 的逐点 `label`（AUDIT-IMPL77 第 2 项）。
 *
 * 实测（REVIEW-9-PERF §4）：`/kline` 回包里 `"pct":null` 占 2.9 KB（12%），240 根每根 12 B；
 * `/trend` 的 `label` 占 6.1 KB（25%），242 点每点 25 B（`"2026-10-16 10:31"`）。
 *
 * 编码规则（**只裁冗余，语义不变**）：
 *  - `/kline`：`pct === null` 不发送（缺省 ≡ 上游没给；**读侧不得把缺失当 0**）。
 *  - `/trend`：单日序列（所有点的 `label` 都是 `YYYY-MM-DD HH:mm` 且同一天）⇒ 逐点 `label` 只留 `HH:mm`，
 *    日期上移到 `labelDay`，并标 `labelFormat: 'hhmm'`；多日/格式不符 ⇒ **原样不动**（不猜）。
 *
 * 读侧：`src/client/chartWire.ts` 的 `klinePctOf` / `normalizeTrendLabels`，对**新旧两种编码**都成立。
 * ⚠ 只作用于**回包**：内存/落盘/归档里的数据仍是完整形状（老版本回滚可读）。
 */
import type { DayBar, KlineData, TrendData } from '../shared/model.ts'

/** `HH:mm` 或 `YYYY-MM-DD HH:mm` 都认；只有"完整且同一天"的才可以压成紧凑形 */
const FULL_LABEL_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/

/**
 * `pct:null` 不上线（240 根 × 12 B ≈ 2.9 KB）。
 * `pct` 有值（含 0 —— 0 是**真实涨跌幅**，不能省）⇒ 原样保留。
 */
export function wireKline(kline: KlineData | null): KlineData | null {
  if (kline === null) return null
  let changed = false
  const days: DayBar[] = kline.days.map((d) => {
    if (d.pct !== null) return d
    changed = true
    const { pct: _pct, ...rest } = d
    return rest as DayBar
  })
  return changed ? { ...kline, days } : kline
}

/**
 * `/trend` 的紧凑标签：单日序列逐点 `label` 留 `HH:mm`，日期上移到 `labelDay`。
 * 任一点格式不符 / 跨天 ⇒ 原样返回（**不猜**，多日轴还要靠 label 里的日期分段）。
 */
export function wireTrend(trend: TrendData | null): TrendData | null {
  if (trend === null) return null
  const pts = trend.points
  if (pts.length < 2) return trend
  const first = pts[0]?.label ?? ''
  if (!FULL_LABEL_RE.test(first)) return trend
  const day = first.slice(0, 10)
  for (const p of pts) {
    if (!FULL_LABEL_RE.test(p.label ?? '') || p.label.slice(0, 10) !== day) return trend
  }
  return {
    ...trend,
    points: pts.map((p) => ({ ...p, label: p.label.slice(11) })),
    labelDay: day,
    labelFormat: 'hhmm',
  }
}
