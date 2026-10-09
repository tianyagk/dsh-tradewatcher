/**
 * 又必须能被断言锁住 —— 塞在 React 组件里就只能靠肉眼。组件与测试共用同一份实现。
 */

/** 有效均价：不是 `null`、且 `> 0`（真实 VWAP 不可能为 0 或负） */
export function isUsableAvg(v: number | null | undefined): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0
}

/** 这条序列到底有没有成交量数据（全 `null` ⇒ 该市场不提供，界面应明说而不是画一条假量） */
export function hasVolumeSeries(vols: readonly (number | null | undefined)[]): boolean {
  return vols.some((v) => typeof v === 'number' && Number.isFinite(v) && v > 0)
}

/**
 * 主图纵轴域。只由**有效**价格与**有效**均价（+ 昨收基准线）决定；
 * 均价缺失时域就等于价格域 —— 这正是"国际指数/外盘商品被压成平线"的修复点。
 *
 * `pad` 与原实现一致：上下各留 6% 的呼吸位；全程无波动时给 ±1 兜底（避免除以 0）。
 */
/**
 * 基准价（昨收）是否可用：**必须是有限正数**。
 *
 * 为什么单列一条判据：`baseline = 0` 会被当成真实值并进纵轴域 ⇒ 域从 0 起，
 * 几千点的价格波动被压成顶部一条平线（指数卡片缩略图实测就是这样，底部那条浅色横线
 * 就是画在 0 上的基准虚线）。昨收/基准价不可能是 0 或负数 —— 0 只代表"上游没给"。
 * 宿主侧也做归一（见 `em.ts`），但跑着的宿主可能是旧构建 ⇒ **客户端判据才是主修复**。
 */
export function isUsableBaseline(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0
}

/**
 * 缩略图（`Sparkline`）的纵轴域与基准线位置 —— 抽成纯函数是为了让"域"与"虚线"共用**同一个判据**。
 *
 * 返回 `baselineY === null` 表示基准不可用（域 = 纯价格域，虚线不画）。
 */
export function chartDomain(
  values: readonly number[],
  baseline?: number | null,
  /** 上下呼吸位（与 Sparkline 原实现一致：6%） */
  padRatio = 0.06,
): { lo: number; hi: number; baselineY: number | null } {
  const nums = values.filter((v) => typeof v === 'number' && Number.isFinite(v))
  if (nums.length === 0) return { lo: -1, hi: 1, baselineY: null }
  let min = Math.min(...nums)
  let max = Math.max(...nums)
  const usable = isUsableBaseline(baseline)
  if (usable) {
    min = Math.min(min, baseline)
    max = Math.max(max, baseline)
  }
  const span = max - min
  const lo = span > 0 ? min - span * padRatio : min - 1
  const hi = span > 0 ? max + span * padRatio : max + 1
  const range = hi - lo || 1
  const baselineY = usable ? (hi - baseline) / range : null
  return { lo, hi, baselineY }
}

export function trendScale(
  values: readonly number[],
  avgs: readonly (number | null | undefined)[] = [],
  baseline?: number | null,
): { lo: number; hi: number } {
  const candidates: number[] = []
  for (const v of values) if (typeof v === 'number' && Number.isFinite(v)) candidates.push(v)
  for (const v of avgs) if (isUsableAvg(v)) candidates.push(v)
  if (isUsableBaseline(baseline)) candidates.push(baseline)
  if (candidates.length === 0) return { lo: -1, hi: 1 }
  const min = Math.min(...candidates)
  const max = Math.max(...candidates)
  const pad = (max - min) * 0.06 || 1
  return { lo: min - pad, hi: max + pad }
}

// ── 五日/多日分时：底部"按天"轴（读不出天 = 用户看不懂这张图）──────────────────

/** 一个交易日对应的点区间（左闭右闭，都是点数组下标） */
export interface TrendDaySegment {
  /** 该天第一个点的下标（日分隔线画在这里；0 表示就是图的左端，不画线） */
  startIndex: number
  /** 该天最后一个点的下标 */
  endIndex: number
  /** `YYYY-MM-DD`：取自点里的 `label`，不是自己算的日期 */
  day: string
  /** 底部轴上的文字：该天第一个点 `label` 的 `MM-DD` 段（**不造日期**） */
  text: string
}

/**
 * 把多日点序列切成"每天一段"，并挑出底部轴要显示的标签。
 *
 * 为什么需要：五日档此前只在**内部**日边界画虚线 + 图内左上角 9px 小字，且 `brk <= 0` 被跳过
 * ⇒ 第一天永远没有标签、底部轴只有首末两个时间戳，用户读不出"哪一段是哪一天"。
 *
 * 规则：
 *  - 只有 1 天（或 0 天）⇒ `segments`/`labels` 都为空数组，调用方走原来的时间轴（单日不看"天"）；
 *  - `labels` 是 `segments` 的子集：超过 `maxLabels` 时**均匀抽样且首末必留**（不重叠）；
 *  - 标签文字一律取该天第一个点 `label` 的 `MM-DD`（`label` 太短就留空，绝不用别处日期顶替）。
 */
export function trendDayAxis(
  points: readonly { label: string }[],
  maxLabels: number,
): { segments: TrendDaySegment[]; labels: TrendDaySegment[] } {
  const segments: TrendDaySegment[] = []
  for (let i = 0; i < points.length; i += 1) {
    const label = points[i]?.label ?? ''
    const day = label.slice(0, 10)
    const text = label.slice(5, 10)
    const last = segments[segments.length - 1]
    if (last !== undefined && last.day === day) {
      last.endIndex = i
      continue
    }
    segments.push({ startIndex: i, endIndex: i, day, text })
  }
  if (segments.length <= 1) return { segments: [], labels: [] }
  const cap = Math.max(1, Math.floor(maxLabels))
  if (segments.length <= cap) return { segments, labels: segments }
  // 均匀抽样：首末必留（i=0 → 第 0 段；i=cap-1 → 最后一段）
  const labels: TrendDaySegment[] = []
  const used = new Set<number>()
  for (let i = 0; i < cap; i += 1) {
    const idx = Math.round((i * (segments.length - 1)) / (cap - 1))
    if (used.has(idx)) continue
    used.add(idx)
    labels.push(segments[idx])
  }
  return { segments, labels }
}
