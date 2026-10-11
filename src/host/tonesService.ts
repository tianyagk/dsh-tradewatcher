/**
 * 五档状态的**取数与按日 memo**（口径在 `host/tones.ts`，纯函数）。
 *
 * 三条与 `host/ytd.ts` 同构的约定：
 *  1. **每日一个**：按 `(secid, 交易日)` memo，盘中不随价格抖动改档；
 *  2. **失败冷却 10 分钟**：不重试轰炸，也不把一个瞬时失败判成"整天都没有"；
 *  3. **复用 `em.fetchKline` 的磁盘缓存**（不新建缓存层），只拉 250 根。
 *
 * 另：**只用已收盘的日线**（当根未收盘不入算），与 README「当根未收盘」一致。
 */
import type { DayBar, MissingField } from '../shared/model.ts'
import * as em from './em.ts'
import { dayOf } from './time.ts'
import { TONE_BANDS, TONE_WINDOWS, TONES_METHODOLOGY, toneOfBars, type ToneComputation, type ToneLevel } from './tones.ts'

/** 标准化窗口上限（与 `TONE_WINDOWS[0]` 一致）：250 根优先 */
export const TONE_BARS = 250
export const TONE_FAIL_COOLDOWN_MS = 10 * 60_000
export const TONE_CONCURRENCY = 4
export const TONE_MAX_IDS = 60

export interface ToneRowOut {
  secid: string
  /** 五档词；未发布时 null */
  level: ToneLevel | null
  pct: number | null
  r30: number | null
  momentum: number | null
  samples: number
  bars: number
  kind: 'yield' | 'price'
  /** 未发布档位的原因（人话）；已发布时 null */
  why: string | null
  window: number
  insufficient: boolean
  /** 档位对应的分位区间（标签型输出必须给边界） */
  band: string | null
}

interface MemoEntry {
  day: string
  at: number
  result: ToneComputation & { failed: boolean }
}

/** 按日 memo（与 `YtdMemo` 同构：成功当天有效，失败冷却期内不重问） */
export class ToneMemo {
  private readonly map = new Map<string, MemoEntry>()

  get(secid: string, day: string, now: number): (ToneComputation & { failed: boolean }) | null {
    const e = this.map.get(secid)
    if (e === undefined) return null
    if (e.day === day && !e.result.failed) return e.result
    if (e.result.failed && now - e.at < TONE_FAIL_COOLDOWN_MS) return e.result
    return null
  }

  set(secid: string, day: string, now: number, result: ToneComputation & { failed: boolean }): void {
    this.map.set(secid, { day, at: now, result })
  }

  get size(): number {
    return this.map.size
  }
}

export type ToneKlineFetcher = typeof em.fetchKline

export interface ToneDeps {
  fetchKline?: ToneKlineFetcher
  now?: () => number
  concurrency?: number
  memo?: ToneMemo
}

const defaultMemo = new ToneMemo()

/** 只保留**已收盘**的日线：最后一根若是今天，去掉（当根未收盘） */
export function closedBars(bars: readonly DayBar[], today: string): DayBar[] {
  const last = bars[bars.length - 1]
  return last !== undefined && last.date === today ? bars.slice(0, -1) : [...bars]
}

async function toneOf(secid: string, kind: 'yield' | 'price', day: string, deps: ToneDeps): Promise<ToneComputation & { failed: boolean }> {
  const fetchKline = deps.fetchKline ?? em.fetchKline
  const memo = deps.memo ?? defaultMemo
  const now = (deps.now ?? Date.now)()
  const hit = memo.get(secid, day, now)
  if (hit !== null) return hit
  try {
    // 不复权（fqt=0）：五档只看价格位置，复权在这里没有意义，也不该额外触发前复权序列
    const k = await fetchKline(secid, 101, TONE_BARS, 0)
    if (k === null || k.days.length === 0) {
      const miss: ToneComputation & { failed: boolean } = {
        level: null, pct: null, r30: null, momentum: null, samples: 0, bars: 0, window: 0,
        why: '日线本次未取到（上游不可达或无该标的），稍后随轮询重试', insufficient: false, failed: true,
      }
      memo.set(secid, day, now, miss)
      return miss
    }
    const bars = closedBars(k.days, day)
    const res = toneOfBars(bars, { isYield: kind === 'yield' })
    const out = { ...res, failed: false }
    memo.set(secid, day, now, out)
    return out
  } catch (error) {
    const miss: ToneComputation & { failed: boolean } = {
      level: null, pct: null, r30: null, momentum: null, samples: 0, bars: 0, window: 0,
      why: `日线取数异常：${String(error).slice(0, 60)}`, insufficient: false, failed: true,
    }
    memo.set(secid, day, now, miss)
    return miss
  }
}

export interface ToneBatchResult {
  rows: ToneRowOut[]
  missing: MissingField[]
  day: string
  /** 实际用到的窗口集合（自检/报告用） */
  windows: readonly number[]
  /** 口径字符串（随结果返回，与算法同源） */
  methodology: string
}

/** 批量：4-worker 池（与 anomaly/ytd 同口径） */
export async function computeTones(
  items: readonly { secid: string; kind: 'yield' | 'price' }[],
  deps: ToneDeps = {},
): Promise<ToneBatchResult> {
  const day = dayOf((deps.now ?? Date.now)())
  const memo = deps.memo ?? defaultMemo
  const rows: ToneRowOut[] = []
  const missing: MissingField[] = []
  const queue = [...items]
  const workers = Array.from({ length: Math.max(1, deps.concurrency ?? TONE_CONCURRENCY) }, async () => {
    for (;;) {
      const it = queue.shift()
      if (it === undefined) return
      const r = await toneOf(it.secid, it.kind, day, { ...deps, memo })
      rows.push({
        secid: it.secid, level: r.level, pct: r.pct, r30: r.r30, momentum: r.momentum,
        samples: r.samples, bars: r.bars, kind: it.kind, why: r.why, window: r.window, insufficient: r.insufficient,
        band: r.level === null ? null : TONE_BANDS[r.level],
      })
      if (r.level === null) {
        // 失败分档沿用两档口径：取不到 ⇒ transient（等上游）；样本/基准不足 ⇒ no-source（重试无用）
        missing.push({
          what: it.secid,
          why: r.insufficient ? 'no-source' : 'transient',
          note: r.why ?? '未发布档位',
        })
      }
    }
  })
  await Promise.all(workers)
  // 行序按**请求顺序**（与 ytd.ts 同写法：先建索引 Map，避免 sort 里 findIndex 的 O(n²)）
  const order = new Map(items.map((it, i) => [it.secid, i]))
  rows.sort((a, b) => (order.get(a.secid) ?? 0) - (order.get(b.secid) ?? 0))
  return { rows, missing, day, windows: TONE_WINDOWS, methodology: TONES_METHODOLOGY }
}
