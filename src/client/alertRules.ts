/**
 * 的测试必须装 React。
 */

/** 同一条目的静默窗口：30 分钟内只提醒一次 */
export const SILENCE_MS = 30 * 60_000

export interface AlertRow {
  secid: string
  name: string
  kind: 'volume' | 'price' | 'both'
  pct: number | null
  mult: number | null
  reasons: string[]
}

export interface SkippedRow {
  secid: string
  name: string
  /** 为什么不判定（样本不足 / 非交易时段 / 上游未更新） */
  skip: string[]
}

export interface RawAlertRow {
  secid: string
  name: string
  kind: 'volume' | 'price' | 'both' | null
  mult: number | null
  samples: number
  pct: number | null
  reasons: string[]
  skip: string[]
}

export interface JudgedAlerts {
  /** 需要提醒的（已过静默窗口） */
  alerts: AlertRow[]
  /** 异动着但处于静默窗口内的 */
  suppressed: AlertRow[]
  /** 判定过且无异常的条数 */
  calm: number
  /** 本轮**没有判定**的条目及原因（不能与 calm 混为一谈） */
  skipped: SkippedRow[]
  /** 更新后的静默记录（由调用方落盘） */
  nextSeen: Record<string, number>
}

/**
 * 静默判定（纯函数）。`seen` 记录每个 secid 上次提醒的时刻。
 *
 * 「判定过且无异常」计入 `calm`；「根本没判定」（样本不足/非交易时段）进 `skipped`。
 * 这两者合并会让样本不足被显示成"正常"，那是错的信息 —— 前者是结论，后者不是。
 */
export function judgeAlerts(
  rows: readonly RawAlertRow[],
  seen: Readonly<Record<string, number>>,
  now: number,
): JudgedAlerts {
  const alerts: AlertRow[] = []
  const suppressed: AlertRow[] = []
  const skipped: SkippedRow[] = []
  const nextSeen: Record<string, number> = { ...seen }
  let calm = 0
  for (const r of rows) {
    if (r.kind === null) {
      if (r.skip.length > 0) skipped.push({ secid: r.secid, name: r.name, skip: r.skip })
      else calm += 1
      continue
    }
    const alert: AlertRow = { secid: r.secid, name: r.name, kind: r.kind, pct: r.pct, mult: r.mult, reasons: r.reasons }
    const last = seen[r.secid]
    if (last !== undefined && now - last < SILENCE_MS) {
      suppressed.push(alert)
      continue
    }
    alerts.push(alert)
    nextSeen[r.secid] = now
  }
  return { alerts, suppressed, calm, skipped, nextSeen }
}

/** 只保留仍在静默窗口内的记录（避免 localStorage 无限增长） */
export function pruneSeen(seen: Readonly<Record<string, number>>, now: number): Record<string, number> {
  const out: Record<string, number> = {}
  for (const [k, v] of Object.entries(seen)) {
    // 未来时间戳（改过系统时钟）也保留，否则会立刻重复提醒
    if (v > now || now - v < SILENCE_MS) out[k] = v
  }
  return out
}
