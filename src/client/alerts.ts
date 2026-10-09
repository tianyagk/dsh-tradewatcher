/**
 */
import { useEffect, useRef, useState } from 'react'
import { api } from './api.ts'
import { judgeAlerts, pruneSeen, type AlertRow, type RawAlertRow, type SkippedRow } from './alertRules.ts'

export type { AlertRow, SkippedRow } from './alertRules.ts'
export { SILENCE_MS } from './alertRules.ts'

export interface AlertState {
  /** 需要提醒的（已过静默窗口） */
  alerts: AlertRow[]
  /** 本轮被静默压制的（异动着，但 30 分钟内已提醒过） */
  suppressed: AlertRow[]
  /** 判定过且无异常 */
  calm: number
  /** 本轮**没有判定**的条目及原因（不能与 calm 混为一谈） */
  skipped: SkippedRow[]
  asOf: number | null
  missing: Array<{ what: string; why: string; note: string }>
  error: string | null
}

const SEEN_KEY = 'tw.alerts.seen'

function loadSeen(): Record<string, number> {
  try {
    const raw = window.localStorage.getItem(SEEN_KEY)
    if (raw === null) return {}
    const parsed = JSON.parse(raw) as unknown
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const out: Record<string, number> = {}
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v === 'number' && Number.isFinite(v)) out[k] = v
    }
    return out
  } catch {
    return {}
  }
}

function saveSeen(seen: Record<string, number>): void {
  try {
    // 只保留仍在静默窗口内的，避免无限增长（裁剪规则在纯模块里，可单测）
    window.localStorage.setItem(SEEN_KEY, JSON.stringify(pruneSeen(seen, Date.now())))
  } catch {
    /* 隐私模式等：静默降级为"本次会话内有效" */
  }
}

const EMPTY: AlertState = { alerts: [], suppressed: [], calm: 0, skipped: [], asOf: null, missing: [], error: null }

/**
 * 每次行情刷新（`quotes` 变化）后拉一次异动判定。
 * 依赖 `quotes` 而不是自己起定时器：异动是基于行情的，行情没更新就重复判定没有意义
 * （而且会白白触发 K 线增量请求）。
 */
export function useWatchAlerts(secids: string[], quoteTs: number | null, enabled: boolean): AlertState {
  const [state, setState] = useState<AlertState>(EMPTY)
  const seen = useRef<Record<string, number>>(loadSeen())
  const key = [...new Set(secids)].sort().join(',')
  const seq = useRef(0)

  useEffect(() => {
    if (!enabled || key === '' || quoteTs === null) return
    const n = ++seq.current
    const ids = key.split(',')
    api
      .anomaly(ids)
      .then((r) => {
        if (n !== seq.current) return
        const judged = judgeAlerts(r.rows as RawAlertRow[], seen.current, Date.now())
        seen.current = judged.nextSeen
        saveSeen(judged.nextSeen)
        setState({
          alerts: judged.alerts,
          suppressed: judged.suppressed,
          calm: judged.calm,
          skipped: judged.skipped,
          asOf: r.asOf,
          missing: r.missing,
          error: null,
        })
      })
      .catch((e: Error) => {
        if (n !== seq.current) return
        setState((prev) => ({ ...prev, error: e.message }))
      })
    // quoteTs 是"行情已更新"的信号：它变一次就重判一次
  }, [key, quoteTs, enabled])

  return state
}
