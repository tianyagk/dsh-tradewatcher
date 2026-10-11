/**
 * 筹码分布取数（抽屉用）。
 *
 * **筹码只随 secid 变**：不依赖页签 / 复权 / 图表重试计数（切页签要保持数据与滑杆位置、不发请求、不闪）。
 * 取数走 `chipsLoader`（按 secid 缓存 + 并发合并）；宿主给 `why`（指数/期货/样本不足）时直接展示原因。
 */
import { useEffect, useRef, useState } from 'react'
import { api } from './api.ts'
import { loadChips } from './chipsLoader.ts'
import type { ChipsPayload } from './api.ts'

export interface ChipsState {
  data: ChipsPayload | null
  error: string | null
  loading: boolean
}

const EMPTY: ChipsState = { data: null, error: null, loading: false }

/**
 * `enabled` 只用来"该不该显示"（例如抽屉没开），**不**用来取消已有数据；
 * `refreshKey` 是筹码**自己的**刷新信号（与图表的重试计数无关）。
 */
export function useChips(secid: string, enabled: boolean, refreshKey = 0): ChipsState {
  const [state, setState] = useState<ChipsState>(EMPTY)
  const seq = useRef(0)
  useEffect(() => {
    if (!enabled || secid === '') {
      setState(EMPTY)
      return
    }
    const n = ++seq.current
    // 只有"还没有数据"时才进加载态：已有数据时保持原样（切页签不闪、不回到骨架）
    setState((s) => (s.data === null ? { ...s, loading: true } : s))
    loadChips<ChipsPayload>(secid, { fetch: (id) => api.chips(id) })
      .then((r) => {
        if (n !== seq.current) return
        setState({ data: r, error: null, loading: false })
      })
      .catch((e: Error) => {
        if (n !== seq.current) return
        setState({ data: null, error: e.message, loading: false })
      })
  }, [secid, enabled, refreshKey])
  return state
}

export { clampIndex } from './chipsView.ts'
