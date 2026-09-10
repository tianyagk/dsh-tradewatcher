/**
 * Row-level mini intraday lines for watch/position lists. One trend fetch per
 * secid with bounded concurrency; results memoized module-wide (90s) so
 * remounting pages doesn't refetch, and a slow 150s refresh keeps them warm
 * while the page stays open.
 */
import { useEffect, useMemo, useState } from 'react'
import { api } from './api.ts'

export interface MiniData {
  values: number[]
  /** day direction vs the session open (null when unknown) */
  up: boolean | null
}

const miniCache = new Map<string, { exp: number; data: MiniData | null }>()
const MINI_TTL = 90_000
const MAX_ROWS = 80

async function fetchMini(secid: string): Promise<MiniData | null> {
  const hit = miniCache.get(secid)
  if (hit !== undefined && Date.now() < hit.exp) return hit.data
  let data: MiniData | null = null
  try {
    const { trend } = await api.trend(secid, 1)
    if (trend !== null && trend.points.length >= 2) {
      const values = trend.points.map((p) => p.price)
      const first = values[0]
      const last = values[values.length - 1]
      data = { values, up: last >= first }
    }
  } catch {
    data = null
  }
  miniCache.set(secid, { exp: Date.now() + MINI_TTL, data })
  return data
}

async function runPool(secids: string[], sink: (secid: string, data: MiniData | null) => void): Promise<void> {
  const queue = [...secids]
  const workers = Array.from({ length: 4 }, async () => {
    for (;;) {
      const secid = queue.shift()
      if (secid === undefined) return
      const data = await fetchMini(secid)
      sink(secid, data)
    }
  })
  await Promise.all(workers)
}

export function useMiniTrends(secids: string[], enabled: boolean): Record<string, MiniData> {
  const key = useMemo(() => [...new Set(secids)].sort().join(','), [secids])
  const ids = useMemo(() => (key === '' ? [] : key.split(',')).slice(0, MAX_ROWS), [key])
  const [data, setData] = useState<Record<string, MiniData>>({})

  useEffect(() => {
    if (!enabled || ids.length === 0) return
    let alive = true
    const sink = (secid: string, value: MiniData | null): void => {
      if (!alive) return
      setData((prev) => {
        if (value === null) {
          if (prev[secid] === undefined) return prev
          const next = { ...prev }
          delete next[secid]
          return next
        }
        if (prev[secid] === value) return prev
        return { ...prev, [secid]: value }
      })
    }
    // Seed from the module cache instantly, then refresh whatever is stale.
    const seed = (): void => {
      for (const secid of ids) {
        const hit = miniCache.get(secid)
        if (hit !== undefined && hit.data !== null) sink(secid, hit.data)
      }
    }
    seed()
    const first = runPool(ids, sink)
    const t = setInterval(() => {
      void first.then(() => runPool(ids, sink))
    }, 150_000)
    return () => {
      alive = false
      clearInterval(t)
    }
  }, [key, enabled, ids.join('|')]) // eslint-disable-line react-hooks/exhaustive-deps

  return data
}
