/**
 * 失败不清空上一次的结果（否则数字会在"有 / —"之间闪烁），只把错误单独标出来：
 */
import { useEffect, useRef, useState } from 'react'
import type { MissingField, YtdRow } from '../shared/model.ts'
import { api } from './api.ts'

export interface YtdState {
  map: Record<string, YtdRow>
  /** 行情（现价）被观测到的时刻 */
  asOf: number | null
  /**
   * 回包是否降级（基准按日 memo + 失败冷却 ⇒ "这个数其实是冷启动前的旧基准 + 现价"是常态）。
   * 没有它，界面与 agent 都会把旧基准当成这一轮的新鲜数据。
   */
  stale: boolean
  /** 这一轮基准/数字的来源（宿主回包的 `source`，如 em / none） */
  source: string
  /** 本次没算出 YTD 的条目与原因（含 no-source / transient 分类） */
  missing: MissingField[]
  /** 是否因单次上限被截断 */
  truncated: boolean
  /** 单次上限（宿主给的常量） */
  limit: number
  /** 是否至少成功取到过一次（用于区分"还没结果"与"真的没有"） */
  loaded: boolean
  error: string | null
}

const EMPTY: YtdState = { map: {}, asOf: null, stale: false, source: 'none', missing: [], truncated: false, limit: 0, loaded: false, error: null }

export function useYtd(secids: string[], quoteTs: number | null, enabled: boolean): YtdState {
  const [state, setState] = useState<YtdState>(EMPTY)
  const key = [...new Set(secids)].sort().join(',')
  const seq = useRef(0)

  useEffect(() => {
    if (!enabled || key === '' || quoteTs === null) return
    const n = ++seq.current
    const ids = key.split(',')
    api
      .ytd(ids)
      .then((r) => {
        if (n !== seq.current) return
        const map: Record<string, YtdRow> = {}
        for (const row of r.rows) map[row.secid] = row
        setState({ map, asOf: r.asOf, stale: r.stale === true, source: r.source, missing: r.missing, truncated: r.truncated, limit: r.limit, loaded: true, error: null })
      })
      .catch((e: Error) => {
        if (n !== seq.current) return
        // 保留上一次的数字，只报告这次失败（不把已有结果清空成 —）
        setState((prev) => ({ ...prev, error: e.message }))
      })
  }, [key, quoteTs, enabled])

  return state
}
