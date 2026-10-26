/**
 * 大盘页 V1 的**纯数据整形**（结构照 `docs/mockups/market-v1.html` A 单列）。
 * 只做"把已有接口的数字排成 5 格 / 11 档 / 240 根"；**不编数**：没有序列就返回 null + 原因。
 */

/** 涨跌 5 格（顺序固定） */
export const BREADTH_CELLS = ['上涨', '平盘', '下跌', '涨停', '跌停'] as const
/** 涨跌分布档数（用户定稿 11 档） */
export const DIST_BUCKETS = 11
/** 分钟成交额柱数（用户定稿 240 根；48 根就是错的） */
export const MINUTE_BARS = 240

export interface BreadthCell { label: string; value: number | null; pct: number | null }

/** 5 格 + 占比（占比分母 = 上涨+平盘+下跌；取不到 ⇒ null，不写 0） */
export function breadthCellsOf(input: {
  up: number | null
  even: number | null
  down: number | null
  limitUp: number | null
  limitDown: number | null
}): BreadthCell[] {
  const total = [input.up, input.even, input.down].every((v) => typeof v === 'number' && v > 0)
    ? (input.up as number) + (input.even as number) + (input.down as number)
    : null
  const pctOf = (v: number | null): number | null => (v === null || total === null || total <= 0 ? null : (v / total) * 100)
  return [
    { label: BREADTH_CELLS[0], value: input.up, pct: pctOf(input.up) },
    { label: BREADTH_CELLS[1], value: input.even, pct: pctOf(input.even) },
    { label: BREADTH_CELLS[2], value: input.down, pct: pctOf(input.down) },
    { label: BREADTH_CELLS[3], value: input.limitUp, pct: pctOf(input.limitUp) },
    { label: BREADTH_CELLS[4], value: input.limitDown, pct: pctOf(input.limitDown) },
  ]
}

/**
 * 分钟成交额"较昨日同分钟"的增减序列。
 *
 * 需要**今日与昨日**两份逐分钟成交额；现网只有今日的（`trends2` 的每分钟 `amount`），
 * 昨日的分钟序列没有留存 ⇒ 返回 `null` + 原因（界面 `—`，不画 48 根假柱）。
 */
export function minuteDeltaOf(
  today: ReadonlyArray<{ amount?: number | null }> | null,
  yesterday: ReadonlyArray<{ amount?: number | null }> | null,
): { bars: number[]; reason: null } | { bars: null; reason: string } {
  if (today === null || yesterday === null) return { bars: null, reason: '缺昨日同分钟序列（本地未留存）⇒ 无法比较' }
  const n = Math.min(today.length, yesterday.length)
  if (n < MINUTE_BARS) return { bars: null, reason: `分钟序列不足 ${MINUTE_BARS} 根（实际 ${n} 根）` }
  const bars: number[] = []
  for (let i = 0; i < MINUTE_BARS; i += 1) {
    const a = today[i]?.amount
    const b = yesterday[i]?.amount
    if (typeof a !== 'number' || typeof b !== 'number') return { bars: null, reason: '分钟成交额有缺口 ⇒ 不给部分柱' }
    bars.push(a - b)
  }
  return { bars, reason: null }
}

/** 缺数据格的统一显示：`—` + 一句短原因（**绝不 0.00**） */
export function missingCellText(reason: string | null | undefined): string {
  const r = typeof reason === 'string' && reason.trim() !== '' ? reason.trim() : '未取到'
  return `—（${r}）`
}

/** A股分钟槽（240 根）：09:31–11:30 + 13:01–15:00 */
export function minuteSlotsOf(): string[] {
  const out: string[] = []
  const push = (h0: number, m0: number, n: number): void => {
    let t = h0 * 60 + m0
    for (let i = 0; i < n; i += 1) {
      t += 1
      out.push(`${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`)
    }
  }
  push(9, 30, 120)   // 09:31 … 11:30
  push(13, 0, 120)   // 13:01 … 15:00
  return out
}

export interface AmountPoint { t?: number; label: string; amount?: number | null }
export interface DaySeries { day: string; points: AmountPoint[] }

/** 按 `YYYY-MM-DD HH:mm` 标签切日（兼容只到 `HH:mm` 的单日序列） */
export function daySeriesOf(points: readonly AmountPoint[], day: string): DaySeries {
  const out: AmountPoint[] = []
  for (const p of points) {
    const d = p.label.slice(0, 10)
    if (d === day) out.push(p)
  }
  return { day, points: out }
}

/** 累计成交额（逐分钟 Σamount）；缺额度的点跳过（不写 0） */
export function cumulativeOf(points: readonly AmountPoint[]): number[] {
  const out: number[] = []
  let acc = 0
  for (const p of points) {
    if (typeof p.amount === 'number' && Number.isFinite(p.amount) && p.amount > 0) acc += p.amount
    out.push(acc)
  }
  return out
}

/** 按分钟槽对齐取"同刻"值：`label` 的 HH:mm 落在槽里；缺槽 ⇒ 前值（首槽缺 ⇒ null） */
export function bySlotOf(points: readonly AmountPoint[]): Array<number | null> {
  const slots = minuteSlotsOf()
  const map = new Map<string, number>()
  for (const p of points) {
    const hhmm = p.label.slice(-5)
    if (typeof p.amount === 'number' && Number.isFinite(p.amount) && p.amount > 0) map.set(hhmm, p.amount)
  }
  let prev: number | null = null
  return slots.map((s) => {
    const v = map.get(s)
    if (typeof v === 'number') { prev = v; return v }
    return prev
  })
}

/**
 * 分钟成交额较昨日增减（240 根）：`今日 − 昨日同分钟`。
 * 昨日序列缺失 ⇒ `null` + 原因（**不用今日数据冒充昨日**）。
 */
export function minuteDeltaBarsOf(
  today: readonly AmountPoint[],
  yesterday: readonly AmountPoint[] | null,
): { bars: number[]; reason: null } | { bars: null; reason: string } {
  if (yesterday === null || yesterday.length === 0) return { bars: null, reason: '昨日分钟额不可得' }
  const a = bySlotOf(today)
  const b = bySlotOf(yesterday)
  if (b.every((v) => v === null)) return { bars: null, reason: '昨日分钟额不可得' }
  const bars: number[] = []
  for (let i = 0; i < a.length; i += 1) {
    const x = a[i]
    const y = b[i]
    if (x === null || y === null) return { bars: null, reason: '分钟额有缺口 ⇒ 不给部分柱' }
    bars.push(x - y)
  }
  return { bars, reason: null }
}

/** 两张图统一的 X 刻度（用户 2026-10-26 定稿的 7 个时刻） */
export const X_TICKS = ['09:30', '10:06', '10:42', '11:18', '13:24', '14:00', '14:36'] as const

/** Y 轴刻度（≥3 档，含首末）：等分 `lo..hi`，按有效位数取整 */
export function yTicksOf(lo: number, hi: number, count = 4): number[] {
  const n = Math.max(3, Math.round(count))
  const a = Number.isFinite(lo) ? lo : 0
  const b = Number.isFinite(hi) && hi > a ? hi : a + 1
  const step = (b - a) / (n - 1)
  return Array.from({ length: n }, (_, i) => a + step * i)
}

/** 网格线的 y 坐标（与刻度同源；返回 SVG 内部坐标） */
export function gridYsOf(lo: number, hi: number, top: number, bottom: number, count = 4): number[] {
  return yTicksOf(lo, hi, count).map((v) => bottom - ((v - lo) / Math.max(1e-9, hi - lo)) * (bottom - top))
}
