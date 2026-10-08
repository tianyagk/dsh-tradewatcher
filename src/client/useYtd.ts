/**
 * 年初至今（YTD）取数（客户端侧）。
 *
 * 跟随**共享行情引擎的更新节拍**拉取（与自选异动的做法一致）：YTD 的分子是现价，
 * 行情没更新时重算没有意义。宿主的这个路由很便宜 —— 现价走行情 TTL 缓存，
 * 基准按 (secid, 交易日) memo 一天一次，因此"每次轮询拉一次"不会变成取数压力。
 *
 * 失败不清空上一次的结果（否则数字会在"有 / —"之间闪烁），只把错误单独标出来：
 * 数据有没有、这次成不成功，是两件事。
 */
import { useEffect, useRef, useState } from 'react'
import type { MissingField, YtdRow } from '../shared/model.ts'
import { api } from './api.ts'

export interface YtdState {
  map: Record<string, YtdRow>
  /** 行情（现价）被观测到的时刻 */
  asOf: number | null
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

const EMPTY: YtdState = { map: {}, asOf: null, missing: [], truncated: false, limit: 0, loaded: false, error: null }

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
        setState({ map, asOf: r.asOf, missing: r.missing, truncated: r.truncated, limit: r.limit, loaded: true, error: null })
      })
      .catch((e: Error) => {
        if (n !== seq.current) return
        // 保留上一次的数字，只报告这次失败（不把已有结果清空成 —）
        setState((prev) => ({ ...prev, error: e.message }))
      })
  }, [key, quoteTs, enabled])

  return state
}
