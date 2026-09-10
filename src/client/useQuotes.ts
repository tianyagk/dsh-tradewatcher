/** Quote polling engine shared by the topbar & watch page. */
import { useEffect, useMemo, useRef, useState } from 'react'
import type { QuoteRow } from '../shared/model.ts'
import { api } from './api.ts'

/**
 * Page-session quote store: survives component remounts (inner-tab switches,
 * panel re-open) so a re-mount never starts from a blank screen — it shows
 * the last readings immediately and refreshes on top.
 */
const clientLkg = new Map<string, QuoteRow>()

export interface QuoteEngine {
  quotes: Record<string, QuoteRow>
  ts: number | null
  error: string | null
  refreshing: boolean
  refresh: () => void
}

export function useQuoteEngine(secids: string[], intervalMs: number, enabled: boolean): QuoteEngine {
  const key = useMemo(() => [...new Set(secids)].sort().join(','), [secids])
  const ids = useMemo(() => (key === '' ? [] : key.split(',')), [key])
  const [quotes, setQuotes] = useState<Record<string, QuoteRow>>(() => {
    const initial: Record<string, QuoteRow> = {}
    clientLkg.forEach((row, secid) => {
      initial[secid] = row
    })
    return initial
  })
  const [ts, setTs] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const inFlight = useRef(false)
  const alive = useRef(true)

  const load = (): void => {
    if (ids.length === 0 || !enabled) return
    if (inFlight.current) return
    inFlight.current = true
    setRefreshing(true)
    api
      .quotes(ids)
      .then((r) => {
        if (!alive.current) return
        setQuotes((prev) => {
          const next = { ...prev }
          for (const [k, v] of Object.entries(r.items)) {
            // Never blank a good reading: a null-price sample only refreshes
            // the entry when we have nothing better.
            const have = clientLkg.get(k)
            if (v.price === null && have !== undefined && have.price !== null) continue
            next[k] = v
            if (v.price !== null) clientLkg.set(k, v)
          }
          // Keep entries when a symbol leaves the active set (page/tab
          // switches must show the last reading instantly, not "—"); prune
          // only when the map grows unreasonably.
          if (Object.keys(next).length > 600) {
            for (const k of Object.keys(next)) if (!ids.includes(k)) delete next[k]
          }
          return next
        })
        setTs(r.ts)
        setError(null)
      })
      .catch((e: Error) => {
        if (alive.current) setError(e.message)
      })
      .finally(() => {
        inFlight.current = false
        if (alive.current) setRefreshing(false)
      })
  }

  useEffect(() => {
    alive.current = true
    load()
    if (!enabled || ids.length === 0) return () => { alive.current = false }
    const t = setInterval(load, intervalMs)
    return () => {
      alive.current = false
      clearInterval(t)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, intervalMs, enabled])

  return { quotes, ts, error, refreshing, refresh: load }
}
