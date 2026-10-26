/** Quote polling engine shared by the topbar & watch page. */
import { useEffect, useMemo, useRef, useState } from 'react'
import type { QuoteRow } from '../shared/model.ts'
import { planQuotePoll } from './quotePoll.ts'
import { QUOTE_POLL_MS, shouldPollQuotes } from '../shared/pollGate.ts'
import { api } from './api.ts'
import { createRequestGen } from './requestGen.ts'

/** 纯东财标的（无腾讯/新浪映射）：熔断 open 时跳过轮询 */
const pureEmOnly = (secid: string): boolean => !/^(113|101|118)\./.test(secid)

/**
 * Page-session quote store: survives component remounts (inner-tab switches,
 * panel re-open) so a re-mount never starts from a blank screen — it shows
 * the last readings immediately and refreshes on top.
 */
const clientLkg = new Map<string, QuoteRow>()
/** 上限：LKG 只增不减会随会话里出现过的标的无限增长（Map 保持插入序，超出丢最旧） */
const CLIENT_LKG_MAX = 800

export interface QuoteEngine {
  quotes: Record<string, QuoteRow>
  /** 响应时刻（触发下游页面重取），不是数据时刻 */
  ts: number | null
  /** 数据被真实观测到的时刻（null = 还没有过有效行情） */
  asOf: number | null
  /** 至少一行是兜底/过期值 */
  stale: boolean
  /** 不新鲜行数（用于界面标注"其中 N 个为旧值"） */
  staleCount: number
  /** 按来源计数（em/tencent/sina/lkg） */
  sources: Record<string, number>
  /** 没有任何源给出价格的标的（大写键集合，便于按 secid 判定） */
  missing: Set<string>
  /** 请求被 160 项上限截断（界面需提示） */
  truncated: boolean
  /** 休市定稿（非交易时段且无兜底行）：定稿复用是"数据已确定"，不是降级 */
  cached: boolean
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
  const [asOf, setAsOf] = useState<number | null>(null)
  const [stale, setStale] = useState(false)
  const [staleCount, setStaleCount] = useState(0)
  const [sources, setSources] = useState<Record<string, number>>({})
  const [missing, setMissing] = useState<Set<string>>(() => new Set())
  const [truncated, setTruncated] = useState(false)
  const [cached, setCached] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const inFlight = useRef(false)
  const alive = useRef(true)
  /** 请求代号（P2-2）：旧代响应整体丢弃（见 `requestGen.ts`） */
  const gen = useRef(createRequestGen())

  const load = (): void => {
    if (ids.length === 0 || !enabled) return
    if (inFlight.current) return
    inFlight.current = true
    setRefreshing(true)
    const my = gen.current.next()
    api
      .quotes(ids)
      .then((r) => {
        // 旧代（key 变了/卸载）⇒ 丢弃：否则会拿上一轮的缺失集合与时刻标注新页面
        if (!alive.current || gen.current.stale(my)) return
        setQuotes((prev) => {
          const next = { ...prev }
          for (const [k, v] of Object.entries(r.items)) {
            // Never blank a good reading: a null-price sample only refreshes
            // the entry when we have nothing better.
            const have = clientLkg.get(k)
            if (v.price === null && have !== undefined && have.price !== null) continue
            next[k] = v
            if (v.price !== null) {
              clientLkg.set(k, v)
              while (clientLkg.size > CLIENT_LKG_MAX) {
                const oldest = clientLkg.keys().next()
                if (oldest.done === true) break
                clientLkg.delete(oldest.value)
              }
            }
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
        // 真实数据时刻与新鲜度：上游全挂时 asOf 会停在最后一次成功观测，
        // stale=true 让行情条显示"滞后"而不是"刚刚更新"（此前用的是响应时刻）
        setAsOf(r.asOf ?? null)
        setStale(r.stale === true)
        setStaleCount(r.staleCount ?? 0)
        setSources(r.sources ?? {})
        setMissing(new Set((r.missing ?? []).map((s) => s.toUpperCase())))
        setTruncated(r.truncated === true)
        setCached(r.cached === true)
        setError(null)
      })
      .catch((e: Error) => {
        // 旧代的错误同样丢弃（它描述的是另一组 id 的这一次尝试）
        if (alive.current && !gen.current.stale(my)) setError(e.message)
      })
      .finally(() => {
        // ⚠ 这里**必须无条件**复位：只在 alive 时复位会让一次失败把轮询永久卡死
        inFlight.current = false
        if (alive.current) setRefreshing(false)
      })
  }

  useEffect(() => {
    alive.current = true
    // 新 key/新 enabled：开新一代 ⇒ 在途的旧请求落地时会被 stale() 丢弃
    gen.current.next()
    // 统一 60s 轮询：只有连续竞价时段才发起；熔断 open 时只留有备用源的标的
    const tick = (): void => {
      if (!shouldPollQuotes(Date.now())) return
      void planQuotePoll(ids, pureEmOnly).then((plan) => { if (plan.ids.length > 0) load() })
    }
    load()
    if (!enabled || ids.length === 0) return () => { alive.current = false }
    const t = setInterval(tick, QUOTE_POLL_MS)
    return () => {
      alive.current = false
      clearInterval(t)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, intervalMs, enabled])

  return { quotes, ts, asOf, stale, staleCount, sources, missing, truncated, cached, error, refreshing, refresh: load }
}
