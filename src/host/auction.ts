/**
 * 【竞价】四项（价格 / 量 / 占全日量比 / 溢价）—— 详情抽屉头部的一行。
 *
 * **数据来源（唯一，复用既有链路，不接新源）**：腾讯 `m1` 序列的**当日第一根**（标签 09:30）。
 * 实测（2026-10-21，`600519` 等三日对拍）：该根 O=H=L=C 等于日线 `open`，累计量即竞价量（手），
 * 末根累计量即当日总量 ⇒ 占比与溢价都可从这一条序列直接算。
 *
 * 不变量：
 *   · 当日没有 m1 根 ⇒ `state:'not-open'`，四项全 null（**不许拿昨日根顶替**）；
 *   · m1 取数失败/字段缺 ⇒ `state:'unavailable'` + 一句原因；
 *   · 只有沪深（secid 市场 0/1）提供竞价；其它市场直接 `unavailable`（不猜语义）。
 */
import { dayOf } from './time.ts'
import { fetchTencentMinutes, type TencentMinutePoint } from './tencent.ts'
import type { AuctionInfo } from '../shared/model.ts'
import { AuctionStore, type AuctionDayRecord } from './auctionSeries.ts'

/** 竞价不可用（一句原因；界面显示 `—（原因）`） */
export function auctionUnavailable(reason: string): AuctionInfo {
  return { state: 'unavailable', price: null, volLots: null, volSharePct: null, premiumPct: null, reason, series: [], seriesDay: null }
}

/** 当日还没有 m1 根：四项全 null、**无原因**（界面只显示 `竞价 —`） */
export function auctionNotOpen(): AuctionInfo {
  return { state: 'not-open', price: null, volLots: null, volSharePct: null, premiumPct: null, reason: null, series: [], seriesDay: null }
}

/**
 * 纯函数：m1 序列 → 竞价四项。
 *
 * @param points 腾讯 m1（累计量，手）；只取 `dayOf(ts) === today` 的根
 * @param prev   昨收（必须 > 0，否则溢价不可算）
 * @param today  `YYYY-MM-DD`（Asia/Shanghai）
 */
export function auctionOfMinutePoints(
  points: readonly TencentMinutePoint[],
  prev: number | null,
  today: string,
): AuctionInfo {
  const todayPoints = points.filter((p) => dayOf(p.ts) === today)
  if (todayPoints.length === 0) return auctionNotOpen()
  const first = todayPoints[0] as TencentMinutePoint
  const last = todayPoints[todayPoints.length - 1] as TencentMinutePoint
  const price = first.price ?? null
  const volLots = first.cumVol ?? null
  const total = last.cumVol ?? null
  if (price === null || !(price > 0)) return auctionUnavailable('腾讯 m1 首根缺竞价价')
  if (volLots === null || !(volLots > 0)) return auctionUnavailable('腾讯 m1 首根缺竞价量')
  if (total === null || !(total > 0)) return auctionUnavailable('腾讯 m1 缺当日总量')
  if (prev === null || !(prev > 0)) return auctionUnavailable('缺昨收 ⇒ 溢价不可算')
  return {
    state: 'ok',
    price,
    volLots,
    volSharePct: (volLots / total) * 100,
    premiumPct: (price / prev - 1) * 100,
    reason: null,
    series: [],
    seriesDay: null,
  }
}

export interface AuctionDeps {
  loadMinutes?: (secid: string) => Promise<TencentMinutePoint[]>
  /** 竞价时段采样序列（默认读 `auction/<secid>.json`；测试可注入） */
  loadSeries?: (secid: string, day: string) => Promise<AuctionDayRecord | null>
  now?: () => number
}

const CACHE_TTL_MS = 15_000
const cache = new Map<string, { at: number; value: AuctionInfo }>()

let seriesStore: AuctionStore | null = null
const defaultSeries = async (secid: string, day: string): Promise<AuctionDayRecord | null> => {
  seriesStore ??= new AuctionStore()
  return seriesStore.seriesOf(secid, day)
}

/** m1 四项（15s 缓存；不含序列 —— 序列每拍都可能变，不进缓存） */
async function baseAuction(secid: string, prev: number | null, deps: AuctionDeps): Promise<AuctionInfo> {
  const now = deps.now ?? Date.now
  if (deps.loadMinutes === undefined) {
    const hit = cache.get(secid)
    if (hit !== undefined && now() - hit.at < CACHE_TTL_MS) return hit.value
  }
  let value: AuctionInfo
  try {
    const points = await (deps.loadMinutes ?? fetchTencentMinutes)(secid)
    value = auctionOfMinutePoints(points, prev, dayOf(now()))
  } catch (error) {
    value = auctionUnavailable(`腾讯 m1 取数失败（${String(error).slice(0, 60)}）`)
  }
  if (deps.loadMinutes === undefined) {
    cache.set(secid, { at: now(), value })
    if (cache.size > 64) {
      const oldest = [...cache.entries()].sort((a, b) => a[1].at - b[1].at)[0]
      if (oldest !== undefined) cache.delete(oldest[0])
    }
  }
  return value
}

/**
 * 取竞价（永不抛）：非沪深直接给原因；m1 失败也变成一句原因；
 * 竞价时段序列从落盘读（当天没有 ⇒ `series: []`，界面曲线显示 `—`）。
 */
export async function fetchAuction(secid: string, prev: number | null, deps: AuctionDeps = {}): Promise<AuctionInfo> {
  if (!/^[01]\./.test(secid)) return auctionUnavailable('仅沪深提供竞价')
  const now = deps.now ?? Date.now
  const base = await baseAuction(secid, prev, deps)
  const today = dayOf(now())
  let record: AuctionDayRecord | null = null
  try {
    record = await (deps.loadSeries ?? defaultSeries)(secid, today)
  } catch {
    record = null
  }
  const series = record !== null && record.day === today ? record.points : []
  return { ...base, series, seriesDay: series.length > 0 ? today : null }
}
