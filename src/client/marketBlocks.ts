/**
 * 大盘页 V1 的**纯数据整形**（结构照 `docs/mockups/market-v1.html` A 单列）。
 * 只做"把已有接口的数字排成 5 格 / 11 档 / 240 根"；**不编数**：没有序列就返回 null + 原因。
 */

/** 涨跌 5 格（顺序固定） */
export const BREADTH_CELLS = ['上涨', '平盘', '下跌', '涨停', '跌停'] as const
export const MINUTE_BARS = 240

/** 北交所口径（分布只统计沪深A股；北交所行情未接入）——卡头常驻的短标记 */
export const DIST_BJ_NOTE = '北交所 未接入'

/**
 * 涨跌分布卡的副标题（口径随数据走）：
 *   · 全覆盖   ⇒ `9 档 · 覆盖 N 只`（N = 有报价只数）
 *   · 覆盖不足 ⇒ `9 档 · 已扫 k/N 批`（**不写"覆盖 N 只"**，避免把少扫的批次读成全市场）
 *   · 没拿到覆盖信息 ⇒ 只写档数
 * 档数取**本轮实际返回的档名数**（今天 9 档；11 档是另一张单），不写死常量。
 */
export function distTitleOf(input: {
  buckets: number
  coverage: { codes: number; quoted: number; suspended: number } | null
  partial: boolean
  scannedBatches: number
  totalBatches: number
}): string {
  const head = `${input.buckets} 档`
  if (input.coverage === null) return head
  if (input.partial) return `${head} · 已扫 ${input.scannedBatches}/${input.totalBatches} 批`
  return `${head} · 覆盖 ${input.coverage.quoted} 只`
}

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