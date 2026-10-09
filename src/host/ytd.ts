/**
 * 三条实现约定（都是"宁可显示 — 也不给一个看着正常的错数"）：
 *  1. **基准必须已收盘**：年内第一个交易日的**收盘价**才是基准。若该日就是今天
 */
import type { DayBar, FqMode, KlineData, MissingField, YtdBaseKind, YtdRow } from '../shared/model.ts'
import * as em from './em.ts'
import { dayOf } from './time.ts'
import { MISSING_TIER_ADVICE } from '../shared/model.ts'

/** 年内第一个交易日收盘价的取数窗口：一年约 245 个交易日，400 根足够覆盖，且命中缓存后只增量拉最新几根 */
export const YTD_BARS = 400
/** 失败冷却：失败不重试轰炸，但也不把一个瞬时失败判成"整天都没有" */
export const YTD_FAIL_COOLDOWN_MS = 10 * 60_000
/** 批量取数并发上限（与 anomaly.ts 同口径） */
export const YTD_CONCURRENCY = 4
/**
 * 单次请求的标的数上限。YTD 的基准要读**日线**：每个标的第一次会触发一次全量日线拉取
 * （之后进磁盘缓存 + 增量，休市时零回源），因此上限比行情的 160 更低，
 * 多出的部分如实报 `truncated`（不静默截断）。
 */
export const YTD_MAX_IDS = 60

/** 一个标的的基准（年内第一个交易日收盘价 / 上市首日收盘价） */
export interface YtdBase {
  baseDate: string | null
  baseClose: number | null
  baseKind: YtdBaseKind | null
  /** **实际生效**的复权口径（指数/期货恒为 0） */
  fq: FqMode
  fqSupported: boolean
  /** 基准序列被观测/落盘的时刻 */
  asOf: number | null
  /** 取不到基准时的原因（人话）；成功时为 null */
  why: string | null
  /** 这次是失败结果（冷却用；成功结果当天有效） */
  failed: boolean
}

/** K 线取数入口（可注入，便于测试打桩 —— 测试一律不打上游） */
export type KlineFetcher = (secid: string, klt: 101 | 102 | 103 | 104, lmt: number, fqt: FqMode) => Promise<KlineData | null>

export interface YtdDeps {
  fetchKline?: KlineFetcher
  now?: () => number
  concurrency?: number
  memo?: YtdMemo
}

/**
 * 纯函数：从日线序列里取"本年内第一个交易日收盘价"。
 *
 * 返回 null 的两种情形含义完全不同，由调用方分别给原因：
 *   - 序列里没有今年的 bar（今年还没开市）；
 *   - 今年第一个 bar 就是今天（基准尚未收盘 —— 不拿未收盘价当收盘价）。
 */
export function ytdBaseFromBars(bars: readonly DayBar[], today: string, requestedBars: number): { baseDate: string; baseClose: number; baseKind: YtdBaseKind } | null {
  const year = today.slice(0, 4)
  const idx = bars.findIndex((b) => b.date.startsWith(year) && Number.isFinite(b.close))
  if (idx < 0) return null
  const bar = bars[idx]
  if (bar.date === today) return null
  // 年内第一个 bar 就是整个序列的第一根（且序列没被取满）→ 该标的本年内上市，基准是上市首日
  const baseKind: YtdBaseKind = idx === 0 && bars.length < requestedBars ? 'listing' : 'year'
  return { baseDate: bar.date, baseClose: bar.close, baseKind }
}

/** 纯函数：YTD（%）。基准缺失或非正数、现价缺失时返回 null —— **不用 0 顶替** */
export function ytdPctOf(price: number | null, baseClose: number | null): number | null {
  if (price === null || baseClose === null || !Number.isFinite(price) || !Number.isFinite(baseClose) || baseClose <= 0) return null
  return Math.round(((price - baseClose) / baseClose) * 10000) / 100
}

/**
 * 基准 memo（按交易日）。
 *
 * 成功结果当天有效（年内第一个交易日的收盘价一天之内不会变）；
 * 失败结果带冷却，冷却期内不再打上游，过了冷却允许再试一次 ——
 * 既不"每个轮询周期重算"，也不把一个瞬时失败钉死一整天。
 */
export class YtdMemo {
  private readonly map = new Map<string, { day: string; at: number; base: YtdBase }>()
  private readonly max: number

  // 不用 TS 参数属性：node --test 的 strip-only 模式不支持（测试要能直接跑源码）
  constructor(max = 800) {
    this.max = max
  }

  get size(): number {
    return this.map.size
  }

  peek(secid: string, day: string, now: number): YtdBase | undefined {
    const hit = this.map.get(secid)
    if (hit === undefined || hit.day !== day) return undefined
    if (!hit.base.failed) return hit.base
    return now - hit.at < YTD_FAIL_COOLDOWN_MS ? hit.base : undefined
  }

  set(secid: string, day: string, at: number, base: YtdBase): void {
    if (!this.map.has(secid) && this.map.size >= this.max) {
      const oldest = this.map.keys().next().value
      if (oldest !== undefined) this.map.delete(oldest)
    }
    this.map.set(secid, { day, at, base })
  }

  clear(): void {
    this.map.clear()
  }
}

/** 取一个标的的基准（命中 memo 则零请求；否则走 `em.fetchKline`，其内部已有磁盘缓存/增量/单飞） */
export async function ytdBaseOf(secid: string, day: string, deps: YtdDeps = {}): Promise<YtdBase> {
  const fetchKline = deps.fetchKline ?? em.fetchKline
  const now = deps.now ?? Date.now
  const memo = deps.memo ?? defaultMemo
  const hit = memo.peek(secid, day, now())
  if (hit !== undefined) return hit

  const supported = em.fqSupported(secid)
  let k: KlineData | null = null
  let failure: string | null = null
  try {
    // 请求口径前复权（1）：除权跳空会污染真实收益；指数/期货由 em 收敛为 0 并在回包里说明
    k = await fetchKline(secid, 101, YTD_BARS, 1)
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error)
  }
  const at = now()
  if (k === null) {
    const base: YtdBase = {
      baseDate: null,
      baseClose: null,
      baseKind: null,
      fq: supported ? 1 : 0,
      fqSupported: supported,
      asOf: null,
      why: failure === null
        ? `日线本次取不到（上游限流或超时）—— ${MISSING_TIER_ADVICE.transient}`
        : `日线本次取不到：${failure} —— ${MISSING_TIER_ADVICE.transient}`,
      failed: true,
    }
    memo.set(secid, day, at, base)
    return base
  }
  const found = ytdBaseFromBars(k.days, day, YTD_BARS)
  const base: YtdBase = {
    baseDate: found?.baseDate ?? null,
    baseClose: found?.baseClose ?? null,
    baseKind: found?.baseKind ?? null,
    fq: k.fqt ?? (supported ? 1 : 0),
    fqSupported: k.fqSupported ?? supported,
    asOf: k.asOf ?? null,
    why: found === null
      ? '本年内还没有已收盘的交易日（今天就是年内第一个交易日）：口径要求以"年内第一个交易日「收盘价」"为基准，本轮不拿未收盘价当基准'
      : null,
    failed: false,
  }
  memo.set(secid, day, at, base)
  return base
}

/** 默认 memo（进程级，按日粒度；路由与 agent 工具共用同一份，避免各算一遍） */
const defaultMemo = new YtdMemo()

export interface YtdItem {
  secid: string
  name: string
  /** 现价（来自行情；缺失传 null） */
  price: number | null
}

export interface YtdBatchResult {
  rows: YtdRow[]
  missing: MissingField[]
}

/**
 * 批量计算（并发有界 ≤4；逐条失败只影响那一条）。
 *
 * 只依赖入参里的现价与 K 线基准 —— 行情取数由调用方完成（路由里与其它面板共用同一次行情），
 * 这样"界面显示的 YTD"与"agent 工具给的 YTD"必然同源。
 */
export async function computeYtds(items: readonly YtdItem[], deps: YtdDeps = {}): Promise<YtdBatchResult> {
  const day = dayOf((deps.now ?? Date.now)())
  const memo = deps.memo ?? defaultMemo
  const rows: YtdRow[] = []
  const missing: MissingField[] = []
  const queue = [...items]
  const workers = Array.from({ length: Math.max(1, deps.concurrency ?? YTD_CONCURRENCY) }, async () => {
    for (;;) {
      const it = queue.shift()
      if (it === undefined) return
      const supported = em.fqSupported(it.secid)
      // 现价缺失时**不去打日线**：算不出数，还白白触发一次全量 K 线拉取
      const base = it.price === null
        ? null
        : await ytdBaseOf(it.secid, day, { ...deps, memo })
      if (base === null) {
        const why = '未取到现价，YTD 无法计算：稍后随行情轮询自动重试'
        rows.push({
          secid: it.secid,
          name: it.name,
          ytd: null,
          baseDate: null,
          baseClose: null,
          price: null,
          baseKind: null,
          fq: supported ? 1 : 0,
          fqSupported: supported,
          asOf: null,
          why,
        })
        missing.push({ what: it.secid, why: 'transient', note: why })
        continue
      }
      const ytd = ytdPctOf(it.price, base.baseClose)
      const why = base.why
      rows.push({
        secid: it.secid,
        name: it.name,
        ytd,
        baseDate: base.baseDate,
        baseClose: base.baseClose,
        price: it.price,
        baseKind: base.baseKind,
        fq: base.fq,
        fqSupported: base.fqSupported,
        asOf: base.asOf,
        why,
      })
      if (why !== null) {
        missing.push({
          // what 用 secid：与行情出处契约同一种写法，工具层合并两处缺失时才能去重
          what: it.secid,
          // 基准取不到分两类：日线这次失败（稍后可恢复）vs 今年还没有已收盘的交易日（上游此刻确实没有这份数据）
          why: base.failed ? 'transient' : 'no-source',
          note: why,
        })
      }
    }
  })
  await Promise.all(workers)
  // 保持入参顺序：界面的默认顺序与"沉底"语义都依赖它
  const order = new Map(items.map((it, i) => [it.secid, i]))
  rows.sort((a, b) => (order.get(a.secid) ?? 0) - (order.get(b.secid) ?? 0))
  return { rows, missing }
}
