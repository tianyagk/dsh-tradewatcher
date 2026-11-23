/**
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { subscribeTicker } from './ticker.ts'
import { shouldPollQuotes } from '../shared/pollGate.ts'
import { api } from './api.ts'
import { isUsableAvg } from './trendView.ts'
import { createFrameBatch, type FrameBatch } from './commitBatch.ts'

export interface MiniData {
  values: number[]
  /** day direction vs the session open (null when unknown) */
  up: boolean | null
  /** 分时均价线（P1-1；上游缺该字段时为 null，界面就不画这条线而不是画一条假线） */
  avg?: Array<number | null>
  /**
   * 分时**抽样点**的首笔 / 极值（P1-11，hover 用）。
   *
   * ⚠ 这**不是**交易所口径的「今开/最高/最低」：分时序列的首点通常晚于 09:30，上游分钟点
   * 还可能被抽样/压缩。字段名与展示文案都必须带「分时」二字 —— 否则会被读成官方开高低
   * （"字段名对、语义差一档"的典型）。官方开高低在 `/detail`，详情抽屉里用的就是它。
   */
  sampleFirst?: number | null
  sampleHigh?: number | null
  sampleLow?: number | null
  /** 上游给的昨收/昨结基准（振幅分母） */
  prePrice?: number | null
}

const miniCache = new Map<string, { exp: number; data: MiniData | null }>()
/**
 * 缩略图 TTL（AUDIT-CLIENT-PERF P2-8）。
 *
 * 旧值 90s：ticker 60s 一拍 ⇒ 每个标的**每两拍**回源一次，80 行 ≈ 40 次 `/trend`/分钟，
 * 且每回一行就 `setData` 一次（最多 80 次整页重渲染）。
 * 缩略图是 56×20 的趋势提示，不是报价本身：5 分钟粒度足够，回源降到 ≈16 次/分钟（-60%）。
 * 逐行提交已改为**每帧合并一次**（见 `commitBatch.ts`），重渲染从 ≤80 次/拍到 ≤1 次/帧。
 */
export const MINI_TTL = 5 * 60_000
/** 失败结果的短缓存：只挡住同一轮里的重复请求，不长时间污染显示 */
const MINI_FAIL_TTL = 15_000
const MAX_ROWS = 80

async function fetchMini(secid: string): Promise<MiniData | null> {
  const hit = miniCache.get(secid)
  if (hit !== undefined && Date.now() < hit.exp) return hit.data
  try {
    const { trend } = await api.trend(secid, 1)
    if (trend !== null && trend.points.length >= 2) {
      const values = trend.points.map((p) => p.price)
      const first = values[0]
      const last = values[values.length - 1]
      const data: MiniData = {
        values,
        up: last >= first,
        // 均价线只在**整段都有值**时才画：中间缺点的折线会在图上造成假的跳变
        // 均价线只在**每个点都有有效均价**时才画（`avg` 缺失/null 就整体不画，不画半条线）
        avg: trend.points.length > 0 && trend.points.every((p) => isUsableAvg(p.avg))
          ? trend.points.map((p) => p.avg ?? null)
          : undefined,
        // 分时抽样点口径（不是官方开/高/低，见 MiniData 的注释）
        sampleFirst: first,
        sampleHigh: Math.max(...values),
        sampleLow: Math.min(...values),
        prePrice: trend.prePrice,
      }
      miniCache.set(secid, { exp: Date.now() + MINI_TTL, data })
      return data
    }
  } catch {
    /* 交给下面的兜底 */
  }
  // 失败：保留上一次 good（若有），仅在完全没数据时记录短失败缓存
  const prev = miniCache.get(secid)
  if (prev !== undefined && prev.data !== null) {
    miniCache.set(secid, { exp: Date.now() + MINI_FAIL_TTL, data: prev.data })
    return prev.data
  }
  miniCache.set(secid, { exp: Date.now() + MINI_FAIL_TTL, data: null })
  return null
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
  /**
   * 行结果按帧合并（P2-8）：4 并发池逐行回包时，同一帧内最多提交一次；
   * 合并时保持"null 删除条目 / 新值覆盖"的旧语义，`setData` 的引用不变性也照旧。
   */
  const batchRef = useRef<FrameBatch<MiniData | null> | null>(null)
  if (batchRef.current === null) {
    batchRef.current = createFrameBatch<MiniData | null>((merged) => {
      setData((prev) => {
        let next = prev
        for (const [secid, value] of merged) {
          if (value === null) {
            if (next[secid] === undefined) continue
            if (next === prev) next = { ...prev }
            delete next[secid]
            continue
          }
          if (next[secid] === value) continue
          if (next === prev) next = { ...prev }
          next[secid] = value
        }
        return next
      })
    })
  }
  useEffect(() => () => { batchRef.current?.dispose() }, [])

  useEffect(() => {
    if (!enabled || ids.length === 0) return
    let alive = true
    const sink = (secid: string, value: MiniData | null): void => {
      if (!alive) return
      batchRef.current?.push(secid, value)
    }
    // Seed from the module cache instantly, then refresh whatever is stale.
    const seed = (): void => {
      for (const secid of ids) {
        const hit = miniCache.get(secid)
        if (hit !== undefined && hit.data !== null) sink(secid, hit.data)
      }
    }
    seed()
    let retries = 0
    let retryTimer = 0
    // 首轮拉取；若仍有缺口（首次就撞上上游抖动），20s 后补拉，最多两次，
    // 避免冷启动失败的缩略图要等 150s 的常规刷新才出现
    const fill = async (): Promise<void> => {
      await runPool(ids, sink)
      if (!alive) return
      const missing = ids.filter((secid) => miniCache.get(secid)?.data == null)
      if (missing.length > 0 && retries < 2) {
        retries += 1
        retryTimer = window.setTimeout(() => void fill(), 20_000)
      }
    }
    void fill()
    const off = subscribeTicker(() => {
      if (!shouldPollQuotes(Date.now())) return
      retries = 0
      void fill()
    })
    return () => {
      alive = false
      off()
      if (retryTimer !== 0) window.clearTimeout(retryTimer)
    }
  }, [key, enabled, ids.join('|')]) // eslint-disable-line react-hooks/exhaustive-deps

  return data
}
