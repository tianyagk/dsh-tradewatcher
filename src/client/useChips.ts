/**
 * 筹码分布取数（抽屉用）。
 *
 * 只在**支持的档位**取（分时/日K 及以上；五日档与 K 线以外的周期不取）：
 * 宿主返回 `why`（指数/期货/样本不足）时不重试、直接展示原因。
 */
import { useEffect, useRef, useState } from 'react'
import { api } from './api.ts'
import type { ChipsPayload } from './api.ts'

export interface ChipsState {
  data: ChipsPayload | null
  error: string | null
  loading: boolean
}

const EMPTY: ChipsState = { data: null, error: null, loading: false }

export function useChips(secid: string, enabled: boolean, retry = 0): ChipsState {
  const [state, setState] = useState<ChipsState>(EMPTY)
  const seq = useRef(0)
  useEffect(() => {
    if (!enabled || secid === '') {
      setState(EMPTY)
      return
    }
    const n = ++seq.current
    setState((s) => ({ ...s, loading: true }))
    api
      .chips(secid)
      .then((r) => {
        if (n !== seq.current) return
        setState({ data: r, error: null, loading: false })
      })
      .catch((e: Error) => {
        if (n !== seq.current) return
        setState({ data: null, error: e.message, loading: false })
      })
  }, [secid, enabled, retry])
  return state
}

export { clampIndex } from './chipsView.ts'
