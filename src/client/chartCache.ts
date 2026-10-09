/**
 */
import type { FqMode, KlineData, MissingField, TrendData } from '../shared/model.ts'
import { FQ_LABEL } from '../shared/model.ts'
import { cacheNoteOf as noteOf, settled as noteSettled } from './chartNote.ts'
import { api } from './api.ts'

export type ChartTab = 'trend' | '5d' | 'day' | 'week' | 'month' | 'year'
export type KlineTab = 'day' | 'week' | 'month' | 'year'

export const TAB_LABEL: Record<ChartTab, string> = {
  trend: '分时',
  '5d': '五日',
  day: '日K',
  week: '周K',
  month: '月K',
  year: '年K',
}

/** 每个周期的请求计划：klt 是东财周期号，lmt 是首次拉取根数 */
export const KLINE_PLAN: Record<KlineTab, { klt: 101 | 102 | 103 | 104; lmt: number }> = {
  day: { klt: 101, lmt: 240 },
  week: { klt: 102, lmt: 200 },
  month: { klt: 103, lmt: 120 },
  year: { klt: 104, lmt: 20 },
}

export const isKlineTab = (t: ChartTab): t is KlineTab =>
  t === 'day' || t === 'week' || t === 'month' || t === 'year'

/** payload 记住自己属于哪个 tab —— 切周期时旧数据不会被拿去渲染新周期 */
export type ChartPayload =
  | { kind: 'trend'; tab: 'trend' | '5d'; trend: TrendData; fromCache?: boolean; fallback?: boolean }
  | { kind: 'kline'; tab: KlineTab; kline: KlineData; fromCache?: boolean; fallback?: boolean }
  /**
   * 宿主明确说"这份数据拿不到"，且**带了原因**（no-source / transient）。
   *
   * 以前这种情况一律返回 null，抽屉只剩一句「该周期暂无数据（停牌/新股/接口限流）」——
   * 把"该市场本来就没有分时源"和"东财这会儿被限流"混成同一句，用户无从判断该不该等。
   */
  | {
      kind: 'unavailable'
      tab: ChartTab
      missing: MissingField[]
      /** 与上面两种 payload 同形：缓存返回时同样标 fromCache/fallback，界面不必特判 */
      fromCache?: boolean
      fallback?: boolean
    }

/** 盘中 TTL：分时 30s（宿主每 60s 才重算一次），五日 2min，K 线 10min */
const TTL_MS: Record<ChartTab, number> = {
  trend: 30_000,
  '5d': 120_000,
  day: 600_000,
  week: 600_000,
  month: 600_000,
  year: 600_000,
}

/** 宿主判定"休市定稿"（cached=true）时的 TTL：收盘期间没有必要再问 */
const TTL_SETTLED_MS: Record<ChartTab, number> = {
  trend: 300_000,
  '5d': 600_000,
  day: 3_600_000,
  week: 3_600_000,
  month: 3_600_000,
  year: 3_600_000,
}

/** 请求失败时旧值的保底 TTL：图不空，但 20s 后会再试一次 */
const TTL_FALLBACK_MS = 20_000

/** 单次请求：把 secid+tab(+复权口径) 变成一个 payload（宿主负责兜底与落盘缓存） */
export async function fetchChartPayload(secid: string, tab: ChartTab, fqt: FqMode = 1): Promise<ChartPayload | null> {
  if (tab === 'trend' || tab === '5d') {
    const { trend, missing } = await api.trend(secid, tab === 'trend' ? 1 : 5)
    if (trend === null) return { kind: 'unavailable', tab, missing: missing ?? [] }
    return { kind: 'trend', tab, trend }
  }
  const plan = KLINE_PLAN[tab]
  const { kline, missing } = await api.kline(secid, plan.klt, plan.lmt, fqt)
  if (kline === null) return { kind: 'unavailable', tab, missing: missing ?? [] }
  return { kind: 'kline', tab, kline }
}

export interface ChartCacheStats {
  /** 已缓存键数 */
  entries: number
  /** 正在执行的请求数 */
  inflight: number
  /** 本实例累计发出的请求数（命中缓存的调用不计） */
  requests: number
}

export interface ChartCache {
  /** 同步查缓存（未过期才有值）；用于切周期时先出图，避免骨架闪烁 */
  peek(secid: string, tab: ChartTab, fqt?: FqMode): ChartPayload | null
  /** 取数据：命中缓存零请求，否则请求；同键并发合并 */
  get(secid: string, tab: ChartTab, fqt?: FqMode): Promise<ChartPayload | null>
  stats(): ChartCacheStats
  clear(): void
}

type Loader = (secid: string, tab: ChartTab, fqt: FqMode) => Promise<ChartPayload | null>

/** 宿主是否已经把这份数据冻结（休市定稿）；"拿不到"不是定稿，给短 TTL 让它有机会恢复。
 *  判据与脚注共用同一处实现（`chartNote.settled`），避免"缓存用一套、文案用另一套" */
function settled(value: ChartPayload | null): boolean {
  if (value === null || value.kind === 'unavailable') return false
  return noteSettled(value as unknown as Parameters<typeof noteSettled>[0])
}

export function createChartCache(load: Loader = fetchChartPayload): ChartCache {
  const memo = new Map<string, { exp: number; value: ChartPayload | null }>()
  const inflight = new Map<string, Promise<ChartPayload | null>>()
  let requests = 0

  const keyOf = (secid: string, tab: ChartTab, fqt: FqMode): string =>
    // 复权口径只对 K 线有意义：分时/五日没有复权序列，共用同一个键，
    // 否则切一次口径会白白重拉一份一模一样的当日分时
    isKlineTab(tab) ? `${secid}|${tab}|${fqt}` : `${secid}|${tab}`

  const ttlOf = (tab: ChartTab, value: ChartPayload | null): number =>
    settled(value) ? TTL_SETTLED_MS[tab] : TTL_MS[tab]

  return {
    peek(secid, tab, fqt) {
      const hit = memo.get(keyOf(secid, tab, fqt ?? 1))
      return hit !== undefined && Date.now() < hit.exp ? hit.value : null
    },

    get(secid, tab, fqt) {
      const key = keyOf(secid, tab, fqt ?? 1)
      const hit = memo.get(key)
      if (hit !== undefined && Date.now() < hit.exp) {
        return Promise.resolve(hit.value === null ? null : { ...hit.value, fromCache: true })
      }
      const running = inflight.get(key)
      if (running !== undefined) return running
      requests += 1
      const p = load(secid, tab, isKlineTab(tab) ? fqt ?? 1 : 1)
        .then((value) => {
          memo.set(key, { exp: Date.now() + ttlOf(tab, value), value })
          return value
        })
        .catch((e: unknown) => {
          // 上游失败：保留上一份成功值（短 TTL），图不变空
          const prev = memo.get(key)?.value
          if (prev !== undefined && prev !== null) {
            memo.set(key, { exp: Date.now() + TTL_FALLBACK_MS, value: prev })
            return { ...prev, fromCache: true, fallback: true } as ChartPayload
          }
          throw e
        })
        .finally(() => {
          if (inflight.get(key) === p) inflight.delete(key)
        })
      inflight.set(key, p)
      return p
    },

    stats() {
      return { entries: memo.size, inflight: inflight.size, requests }
    },

    clear() {
      memo.clear()
      inflight.clear()
    },
  }
}

/** 全站共用一份：顶栏悬浮卡与抽屉命中同一批缓存条目 */
export const chartCache = createChartCache()

/** 上次查看的周期（模块级记忆：换一只标的或关掉再打开时保持同一周期） */
let lastTab: ChartTab = 'trend'
export const rememberedTab = (): ChartTab => lastTab
export const rememberTab = (t: ChartTab): void => {
  lastTab = t
}

/**
 * 复权口径：默认前复权（除权跳空会让历史 K 线出现无解释的暴跌，前复权序列连续），
 * 全局记住上一次的选择，同时按标的记住各自的口径 —— 换回某只股票时回到它上次的选择。
 */
let lastFqt: FqMode = 1
const fqBySymbol = new Map<string, FqMode>()

/** 段控顺序：前复权（默认）→ 后复权 → 不复权 */
export const FQ_ORDER: readonly FqMode[] = [1, 2, 0]

export const fqFor = (secid: string): FqMode => fqBySymbol.get(secid) ?? lastFqt

export function rememberFq(secid: string, fqt: FqMode): void {
  lastFqt = fqt
  fqBySymbol.set(secid, fqt)
}

/** 图表脚注里的复权口径说明（不适用时必须说明原因，不能只显示"不复权"让人以为是选择） */
export function fqNoteOf(kline: KlineData): string {
  if (kline.fqSupported === false) return ' · 不复权（指数/期货无除权除息）'
  const mode: FqMode = kline.fqt ?? 1
  return mode === 0 ? ' · 不复权' : ` · ${FQ_LABEL[mode]}（详情头为真实成交价）`
}

/** 图表脚注说明：实现与用词统一在 `chartNote.ts`（E1：降级复用一律带日期） */
export function cacheNoteOf(payload: ChartPayload | null): string {
  return noteOf(payload as unknown as Parameters<typeof noteOf>[0])
}
