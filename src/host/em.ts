/**
 * Eastmoney (东方财富) quote relay. All endpoints are the free public "延迟行情"
 * JSON feeds; browser CORS blocks them, so the host half fetches on behalf of
 * the GUI and normalizes everything to the shared model.
 *
 * Reliability layout (verified live against the deployed network):
 *  - push2delay.eastmoney.com  — primary quotes/boards host (very tolerant)
 *  - push2.eastmoney.com       — fallback quotes/boards
 *  - push2his.eastmoney.com    — history (intraday trends + daily klines),
 *                                with push2delay/push2 as fallbacks (all three
 *                                served trends2 during probing)
 *  - searchapi.eastmoney.com   — symbol search (suggest)
 */
import type {
  BoardRow,
  DayBar,
  KlineData,
  QuoteRow,
  StockDetail,
  SuggestItem,
  TrendData,
  TrendPoint,
} from '../shared/model.ts'
import { SECID_RE } from '../shared/model.ts'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { dataHome } from './store.ts'

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
const REFERER = 'https://quote.eastmoney.com/'
const SUGGEST_TOKEN = 'D43BF722C8E33BDC906FB84D85E326E8'

const QUOTE_HOSTS = ['push2delay.eastmoney.com', 'push2.eastmoney.com']
const HISTORY_HOSTS = ['push2his.eastmoney.com', 'push2delay.eastmoney.com', 'push2.eastmoney.com']
const SEARCH_HOST = 'searchapi.eastmoney.com'

// ─────────────────────────── tiny TTL cache ───────────────────────────────

interface CacheSlot {
  exp: number
  value: unknown
}

const inflight = new Map<string, Promise<unknown>>()

async function ttlCache<T>(key: string, ttlMs: number, loader: () => Promise<T>): Promise<T> {
  const pending = inflight.get(key)
  if (pending !== undefined) return pending as Promise<T>
  const run = (async () => {
    const value = await loader()
    cache.set(key, { exp: Date.now() + ttlMs, value })
    return value
  })()
  inflight.set(key, run)
  try {
    return await run
  } finally {
    inflight.delete(key)
  }
}

const cache = new Map<string, CacheSlot>()

function peekCache<T>(key: string, maxAgeMs: number): T | undefined {
  const slot = cache.get(key)
  if (slot === undefined) return undefined
  if (Date.now() > slot.exp + maxAgeMs) return undefined
  return slot.value as T
}

// ─────────────────────────── low-level fetch ──────────────────────────────

async function fetchFromHost(host: string, pathAndQuery: string, timeoutMs = 7000): Promise<unknown> {
  const url = `https://${host}${pathAndQuery}`
  const res = await fetch(url, {
    headers: { 'user-agent': UA, referer: REFERER, accept: 'application/json, text/plain, */*' },
    signal: AbortSignal.timeout(timeoutMs),
    redirect: 'follow',
  })
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${host}`)
  const text = await res.text()
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error(`non-JSON reply from ${host}: ${text.slice(0, 80)}`)
  }
  return parsed
}

async function fetchAny(hosts: readonly string[], pathAndQuery: string, timeoutMs = 7000): Promise<unknown> {
  let lastError: unknown = null
  for (const host of hosts) {
    try {
      return await fetchFromHost(host, pathAndQuery, timeoutMs)
    } catch (error) {
      lastError = error
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError))
}

/** Parse an EM scalar: '-' / '' / null → null, else Number. */
function num(v: unknown): number | null {
  if (v === null || v === undefined) return null
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  const s = String(v).trim()
  if (s === '' || s === '-') return null
  const n = Number(s)
  return Number.isFinite(n) ? n : null
}

function normTime(v: unknown): number | null {
  const n = num(v)
  if (n === null) return null
  if (n > 1e12) return n // already ms
  if (n > 1e9) return n * 1000 // seconds
  return null
}

function bodyOf(d: unknown): { data?: { diff?: unknown; total?: unknown } } | undefined {
  if (d !== null && typeof d === 'object') return d as { data?: { diff?: unknown; total?: unknown } }
  return undefined
}

function diffList(d: unknown): Array<Record<string, unknown>> {
  const body = bodyOf(d)
  const diff = body?.data?.diff
  if (Array.isArray(diff)) return diff as Array<Record<string, unknown>>
  if (diff !== null && typeof diff === 'object') return [diff as Record<string, unknown>]
  return []
}

// ─────────────────────────────── quotes ───────────────────────────────────

const QUOTE_FIELDS =
  'f1,f2,f3,f4,f5,f6,f8,f9,f10,f12,f13,f14,f15,f16,f17,f18,f20,f21,f23,f104,f105,f106,f124'

const LKG_MAX = 1500
const LKG_PERSIST_MS = 45_000

/** Per-secid most recent quote that actually carried a price. Persisted to
 *  <dataHome>/quotes-lkg.json so a feed drop-window right after a host
 *  restart can never blank the UI (values survive the process). */
const lastGood = new Map<string, QuoteRow>()
let lkgLoaded: Promise<void> | null = null
let lkgDirty = false
let lkgLastWrite = 0

async function loadLastGood(): Promise<void> {
  if (lkgLoaded !== null) return lkgLoaded
  lkgLoaded = (async () => {
    try {
      const raw = await readFile(join(dataHome(), 'quotes-lkg.json'), 'utf8')
      const parsed = JSON.parse(raw)
      const rows = Array.isArray(parsed?.rows) ? parsed.rows : []
      for (const r of rows) {
        if (r === null || typeof r !== 'object') continue
        const row = r as QuoteRow
        if (typeof row.secid !== 'string' || !SECID_RE.test(row.secid)) continue
        if (typeof row.price !== 'number' || !Number.isFinite(row.price)) continue
        lastGood.set(row.secid, row)
      }
    } catch {
      /* no persisted file yet — first boot */
    }
  })()
  return lkgLoaded
}

function persistLastGood(): void {
  if (!lkgDirty) return
  const now = Date.now()
  if (now - lkgLastWrite < LKG_PERSIST_MS) return
  lkgLastWrite = now
  lkgDirty = false
  if (lastGood.size > LKG_MAX) {
    let drop = lastGood.size - LKG_MAX
    for (const key of lastGood.keys()) {
      if (drop <= 0) break
      lastGood.delete(key)
      drop -= 1
    }
  }
  const rows = [...lastGood.values()]
  void (async () => {
    try {
      await mkdir(dataHome(), { recursive: true })
      await writeFile(join(dataHome(), 'quotes-lkg.json'), JSON.stringify({ ts: Date.now(), rows }), 'utf8')
    } catch (error) {
      console.warn('[tradewatcher] persist quotes-lkg failed:', String(error))
    }
  })()
}

function noteLastGood(row: QuoteRow): void {
  lastGood.set(row.secid, { ...row })
  lkgDirty = true
  persistLastGood()
}

/**
 * Field-level last-known-good fill for one request list. The delay feed
 * occasionally answers a symbol with f2='-' (empty price) or drops it from
 * the diff entirely for tens of seconds; a blank sample must never replace a
 * good reading. Works on any Map (`bank` defaults to the persisted store), so
 * it is also applied to TTL-cache hits and is unit-testable.
 */
export function fillLastGood(
  list: readonly string[],
  rows: Map<string, QuoteRow>,
  bank: Map<string, QuoteRow> = lastGood,
): void {
  for (const secid of list) {
    const row = rows.get(secid)
    const good = bank.get(secid)
    if (row === undefined) {
      if (good !== undefined && good.price !== null) rows.set(secid, { ...good })
      continue
    }
    if (row.price !== null) {
      if (bank === lastGood) noteLastGood(row)
      else bank.set(secid, { ...row })
      continue
    }
    if (good !== undefined && good.price !== null) {
      if (row.price === null) row.price = good.price
      if (row.chg === null) row.chg = good.chg
      if (row.pct === null) row.pct = good.pct
      if (row.prev === null) row.prev = good.prev
      if (row.open === null) row.open = good.open
      if (row.high === null) row.high = good.high
      if (row.low === null) row.low = good.low
      if (row.time === null) row.time = good.time
    }
  }
}

function rowsFrom(json: unknown): Map<string, QuoteRow> {
  const rows = new Map<string, QuoteRow>()
  for (const it of diffList(json)) {
    const market = String(it.f13 ?? '')
    const code = String(it.f12 ?? '')
    if (market === '' || code === '' || code === 'undefined') continue
    const secid = `${market}.${code}`
    rows.set(secid, {
      secid,
      code,
      name: String(it.f14 ?? secid),
      price: num(it.f2),
      chg: num(it.f4),
      pct: num(it.f3),
      prev: num(it.f18),
      open: num(it.f17),
      high: num(it.f15),
      low: num(it.f16),
      vol: num(it.f5),
      amount: num(it.f6),
      up: num(it.f104),
      down: num(it.f105),
      even: num(it.f106),
      time: normTime(it.f124),
    })
  }
  return rows
}

async function rawQuotes(list: string[]): Promise<Map<string, QuoteRow>> {
  const rows = new Map<string, QuoteRow>()
  const q = `secids=${encodeURIComponent(list.join(','))}&fltt=2&invt=2&fields=${QUOTE_FIELDS}`
  // Host-per-request retry: when a host silently drops part of the batch
  // (observed for tens of seconds at a time), try the next host for the
  // remainder before LKG fallback kicks in.
  for (const host of QUOTE_HOSTS) {
    try {
      const json = await fetchFromHost(host, `/api/qt/ulist.np/get?${q}`)
      for (const [secid, row] of rowsFrom(json)) rows.set(secid, row)
    } catch {
      /* next host */
    }
    const missing = list.filter((secid) => !rows.has(secid))
    if (missing.length === 0) break
  }
  return rows
}

function rowsToRecord(rows: Map<string, QuoteRow>): Record<string, QuoteRow> {
  const out: Record<string, QuoteRow> = {}
  for (const row of rows.values()) out[row.secid] = row
  return out
}

/** Batch quotes with a 2.5 s TTL + last-known-good on every return path
 *  (fresh fetch, TTL hit and peek hit alike). */
export async function fetchQuotes(secids: string[]): Promise<Record<string, QuoteRow>> {
  const list = [...new Set(secids)]
  if (list.length === 0) return {}
  await loadLastGood()
  const key = `quotes:${list.join(',')}`
  const quick = peekCache<Record<string, QuoteRow>>(key, 40_000)
  if (quick !== undefined) {
    const map = new Map<string, QuoteRow>()
    for (const [k, v] of Object.entries(quick)) map.set(k, v)
    fillLastGood(list, map)
    return rowsToRecord(map)
  }
  const rows = await ttlCache<Map<string, QuoteRow>>(key, 2500, () => rawQuotes(list))
  fillLastGood(list, rows)
  return rowsToRecord(rows)
}

/** Detail card for one stock/ETF (extra fundamentals; indices return what the feed has). */
export async function fetchStockDetail(secid: string): Promise<StockDetail | null> {
  if (!SECID_RE.test(secid)) return null
  const q = `secid=${encodeURIComponent(secid)}&fltt=2&invt=2&fields=${QUOTE_FIELDS}`
  const json = await ttlCache(`detail:${secid}`, 10_000, () => fetchAny(QUOTE_HOSTS, `/api/qt/ulist.np/get?secids=${encodeURIComponent(secid)}&fltt=2&invt=2&fields=${QUOTE_FIELDS}`))
  const rows = diffList(json)
  const it = rows[0]
  if (it === undefined) return null
  const code = String(it.f12 ?? '')
  const market = String(it.f13 ?? '')
  return {
    secid: `${market}.${code}`,
    code,
    name: String(it.f14 ?? secid),
    price: num(it.f2),
    chg: num(it.f4),
    pct: num(it.f3),
    open: num(it.f17),
    high: num(it.f15),
    low: num(it.f16),
    prev: num(it.f18),
    vol: num(it.f5),
    amount: num(it.f6),
    turnover: num(it.f8),
    volumeRatio: num(it.f10),
    pe: num(it.f9),
    pb: num(it.f23),
    totalMv: num(it.f20),
    floatMv: num(it.f21),
    up: num(it.f104),
    down: num(it.f105),
  }
}

// ───────────────────────────── intraday trend ─────────────────────────────

function parseTrendRow(row: string): TrendPoint | null {
  const parts = row.split(',')
  if (parts.length < 3) return null
  const timeText = parts[0] // "YYYY-MM-DD HH:mm"
  const price = num(parts[2]) // close
  if (price === null) return null
  const t = Date.parse(timeText.replace(' ', 'T'))
  return {
    t: Number.isFinite(t) ? t : 0,
    label: timeText,
    price,
    avg: num(parts[7]),
    vol: num(parts[5]),
  }
}

/** Intraday series for the last `ndays` sessions (1 = today, 5 = five-day).
 *  Empty points → null data. */
export async function fetchTrend(secid: string, ndays = 1): Promise<TrendData | null> {
  if (!SECID_RE.test(secid)) return null
  const days = Math.min(5, Math.max(1, Math.round(ndays)))
  const fields2 = 'f51,f52,f53,f54,f55,f56,f57,f58'
  const key = `trend:${secid}:${days}`
  const json = await ttlCache(key, 60_000, () =>
    fetchAny(
      HISTORY_HOSTS,
      `/api/qt/stock/trends2/get?secid=${encodeURIComponent(secid)}&fields1=f1,f2,f3,f4,f5,f6,f7,f8,f9,f10,f11,f12,f13&fields2=${fields2}&ndays=${days}&iscr=0`,
    ),
  )
  const body = bodyOf(json)
  const data = body?.data as { prePrice?: unknown; preClose?: unknown; trends?: unknown } | undefined
  if (!data) return null
  const raw = Array.isArray(data.trends) ? data.trends : []
  const points: TrendPoint[] = []
  for (const r of raw) {
    if (typeof r !== 'string') continue
    const p = parseTrendRow(r)
    if (p !== null) points.push(p)
  }
  if (points.length === 0) return null
  const pre = num(data.prePrice) ?? num(data.preClose) ?? null
  return { secid, prePrice: pre, points, last: points[points.length - 1]?.price ?? null }
}

// ───────────────────────────── daily kline ────────────────────────────────

// ───────────────────────── kline cache & fetch ───────────────────────────
/**
 * K 线历史在本地按 (secid, 周期) 缓存：首次查看一次性拉全量，之后只拉最新几根
 * 做增量合并，上游失败时直接吃本地缓存 —— 既省请求（push2his 限流严重），
 * 也保证图表永远有数据。
 *   101=日K  102=周K  103=月K  104=年K（由月K本地重采样，上游 104 实际是季K）
 */
const KLINE_FULL_LMT: Record<number, number> = { 101: 800, 102: 400, 103: 240 }
const KLINE_RECENT_LMT: Record<number, number> = { 101: 10, 102: 5, 103: 3 }
const KLINE_CAP: Record<number, number> = { 101: 1200, 102: 800, 103: 600 }

interface KlineEntry {
  bars: DayBar[]
  loaded: boolean
  updatedAt: number
}

const klineMem = new Map<string, KlineEntry>()

function klineFile(secid: string, klt: number): string {
  return join(dataHome(), 'klines', `${secid}_${klt}.json`)
}

async function loadKlineCache(secid: string, klt: number): Promise<KlineEntry> {
  const key = `${secid}|${klt}`
  const hit = klineMem.get(key)
  if (hit !== undefined && hit.loaded) return hit
  const entry: KlineEntry = hit ?? { bars: [], loaded: false, updatedAt: 0 }
  try {
    const raw = await readFile(klineFile(secid, klt), 'utf8')
    const parsed = JSON.parse(raw) as { bars?: DayBar[]; updatedAt?: number }
    if (Array.isArray(parsed.bars) && parsed.bars.length > 0) {
      entry.bars = parsed.bars.filter((b) => b !== null && typeof b.date === 'string' && Number.isFinite(b.close))
      entry.updatedAt = typeof parsed.updatedAt === 'number' ? parsed.updatedAt : 0
    }
  } catch {
    /* 首次：无缓存文件 */
  }
  entry.loaded = true
  klineMem.set(key, entry)
  return entry
}

async function saveKlineCache(secid: string, klt: number, bars: DayBar[]): Promise<void> {
  try {
    await mkdir(join(dataHome(), 'klines'), { recursive: true })
    await writeFile(klineFile(secid, klt), JSON.stringify({ v: 1, secid, klt, updatedAt: Date.now(), bars }), 'utf8')
  } catch (error) {
    console.warn('[tradewatcher] 保存K线缓存失败:', String(error))
  }
}

/** 按日期合并（新覆盖旧、排序、截断）——纯函数，便于测试。 */
export function mergeBars(oldBars: readonly DayBar[], freshBars: readonly DayBar[], cap: number): DayBar[] {
  const byDate = new Map<string, DayBar>()
  for (const b of oldBars) byDate.set(b.date, b)
  for (const b of freshBars) byDate.set(b.date, b)
  const merged = [...byDate.values()].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
  return cap > 0 && merged.length > cap ? merged.slice(merged.length - cap) : merged
}

/** 月K → 年K 重采样（开盘取首月、收盘取末月、高低取极值、量额求和）。 */
export function resampleYearly(monthly: readonly DayBar[]): DayBar[] {
  const out: DayBar[] = []
  let curYear = ''
  let cur: DayBar | null = null
  let prevClose: number | null = null
  for (const b of monthly) {
    const year = b.date.slice(0, 4)
    if (cur === null || year !== curYear) {
      if (cur !== null) out.push(cur)
      cur = { date: b.date, open: b.open, close: b.close, high: b.high, low: b.low, vol: b.vol, pct: null }
      curYear = year
    } else {
      cur.date = b.date
      cur.close = b.close
      cur.high = Math.max(cur.high, b.high)
      cur.low = Math.min(cur.low, b.low)
      cur.vol = (cur.vol ?? 0) + (b.vol ?? 0)
    }
  }
  if (cur !== null) out.push(cur)
  for (const bar of out) {
    const base = prevClose ?? bar.open
    bar.pct = base > 0 ? Math.round(((bar.close - base) / base) * 10000) / 100 : null
    prevClose = bar.close
  }
  return out
}

/** 东财 secid → 腾讯代码（sh/sz/hk/us）；指数/期货等返回 null。 */
function tencentSymbol(secid: string): string | null {
  const dot = secid.indexOf('.')
  if (dot <= 0) return null
  const mkt = secid.slice(0, dot)
  const code = secid.slice(dot + 1)
  if (mkt === '1') return `sh${code}`
  if (mkt === '0') return `sz${code}`
  if (mkt === '116') return `hk${code}`
  if (mkt === '105' || mkt === '106' || mkt === '107') return `us${code.toUpperCase()}`
  return null
}

/**
 * 腾讯历史 K 线兜底源（东财 push2his 限流严重时救命）。
 * 统一走「不复权」，与东财 fqt=0 同口径，避免混源污染本地缓存。
 * 行格式 [date, open, close, high, low, volume]。
 */
async function requestKlineFromTencent(secid: string, klt: number, lmt: number): Promise<DayBar[] | null> {
  const sym = tencentSymbol(secid)
  if (sym === null) return null
  const period = klt === 101 ? 'day' : klt === 102 ? 'week' : 'month'
  const path = `/appstock/app/fqkline/get?param=${sym},${period},,,${Math.min(1000, Math.max(5, lmt))},`
  try {
    const json = (await fetchFromHost('web.ifzq.gtimg.cn', path, 9000)) as {
      data?: Record<string, Record<string, unknown>>
    }
    const node = json?.data?.[sym]
    if (node === undefined) return null
    const rows = (node[period] ?? node[`qfq${period}`]) as unknown
    if (!Array.isArray(rows)) return null
    const bars: DayBar[] = []
    for (const r of rows) {
      if (!Array.isArray(r) || r.length < 5) continue
      const close = num(r[2])
      const open = num(r[1])
      if (close === null || open === null) continue
      bars.push({
        date: String(r[0]),
        open,
        close,
        high: num(r[3]) ?? close,
        low: num(r[4]) ?? close,
        vol: r.length > 5 ? num(r[5]) : null,
        pct: null,
      })
    }
    return bars.length > 0 ? bars : null
  } catch {
    return null
  }
}

/** 单主机取 K 线；空数组视为失败（push2delay/push2 会返回 200 + 空）。优先腾讯。 */
async function requestKlineRaw(secid: string, klt: number, lmt: number): Promise<DayBar[] | null> {
  const fromTencent = await requestKlineFromTencent(secid, klt, lmt)
  if (fromTencent !== null) return fromTencent
  const fields2 = 'f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61'
  const path = `/api/qt/stock/kline/get?secid=${encodeURIComponent(secid)}&klt=${klt}&fqt=0&lmt=${lmt}&end=20500101&fields1=f1,f2,f3&fields2=${fields2}`
  for (let attempt = 0; attempt < 2; attempt += 1) {
    for (const host of HISTORY_HOSTS) {
      try {
        const json = await fetchFromHost(host, path, 9000)
        const data = (bodyOf(json)?.data ?? null) as { klines?: unknown } | null
        const raw = Array.isArray(data?.klines) ? data?.klines ?? [] : []
        const bars: DayBar[] = []
        for (const r of raw) {
          if (typeof r !== 'string') continue
          const p = r.split(',')
          if (p.length < 6) continue
          const close = num(p[2])
          if (close === null) continue
          bars.push({
            date: p[0],
            open: num(p[1]) ?? close,
            close,
            high: num(p[3]) ?? close,
            low: num(p[4]) ?? close,
            vol: num(p[5]),
            pct: num(p[8]),
          })
        }
        if (bars.length > 0) return bars
      } catch {
        /* 换主机 / 重试 */
      }
    }
    if (attempt === 0) await new Promise((r) => setTimeout(r, 500))
  }
  return null
}

/** 取 K 线：命中本地缓存时只增量更新最新几根；上游不可用时回退缓存。 */
export async function fetchKline(
  secid: string,
  klt: 101 | 102 | 103 | 104 = 101,
  lmt = 6,
): Promise<KlineData | null> {
  if (!SECID_RE.test(secid)) return null
  const baseKlt = klt === 104 ? 103 : klt
  const entry = await loadKlineCache(secid, baseKlt)
  const needFull = entry.bars.length === 0
  const key = `kline:${secid}:${baseKlt}:${needFull ? 'full' : 'incr'}`
  const fetched = await ttlCache<DayBar[] | null>(key, needFull ? 3600_000 : 120_000, () =>
    requestKlineRaw(secid, baseKlt, needFull ? KLINE_FULL_LMT[baseKlt] : KLINE_RECENT_LMT[baseKlt]),
  )
  let stale = false
  if (fetched !== null && fetched.length > 0) {
    const before = entry.bars.length
    const beforeLast = entry.bars[entry.bars.length - 1]?.date ?? ''
    entry.bars = mergeBars(entry.bars, fetched, KLINE_CAP[baseKlt])
    entry.updatedAt = Date.now()
    const afterLast = entry.bars[entry.bars.length - 1]?.date ?? ''
    if (before !== entry.bars.length || beforeLast !== afterLast) void saveKlineCache(secid, baseKlt, entry.bars)
  } else if (entry.bars.length === 0) {
    return null
  } else {
    stale = true
  }
  const series = baseKlt === 103 && klt === 104 ? resampleYearly(entry.bars) : entry.bars
  const want = Math.max(1, Math.min(Math.round(lmt) || series.length, series.length))
  return { secid, days: series.slice(series.length - want), stale }
}

// ─────────────────────────────── boards ───────────────────────────────────

export type BoardScope = 'industry' | 'concept' | 'etf'

const BOARD_FS: Record<Exclude<BoardScope, 'etf'>, string> = {
  industry: 'm:90+t:2',
  concept: 'm:90+t:3',
}
const ETF_FS = 'b:MK0021,b:MK0023,b:MK0022'
const BOARD_FIELDS = 'f2,f3,f4,f5,f6,f8,f12,f13,f14,f62,f104,f105,f128,f136'

/** Sector/ETF ranking. sort: pct (default) | money (boards) | amount (ETF). */
export async function fetchBoard(
  scope: BoardScope,
  sort: 'pct' | 'money' | 'amount',
  pn = 1,
  pz = 40,
): Promise<{ total: number; rows: BoardRow[] }> {
  const fs = scope === 'etf' ? ETF_FS : BOARD_FS[scope]
  const fid = sort === 'money' ? 'f62' : sort === 'amount' ? 'f6' : 'f3'
  const po = sort === 'money' || sort === 'amount' ? 1 : 1 // all descending by chosen fid
  const q = `pn=${pn}&pz=${pz}&po=${po}&np=1&fltt=2&invt=2&fid=${fid}&fs=${encodeURIComponent(fs)}&fields=${BOARD_FIELDS}`
  const key = `board:${scope}:${sort}:${pn}:${pz}`
  const json = await ttlCache(key, 30_000, () => fetchAny(QUOTE_HOSTS, `/api/qt/clist/get?${q}`))
  const body = bodyOf(json)
  const rows: BoardRow[] = diffList(json).map((it) => {
    const code = String(it.f12 ?? '')
    const mkt = String(it.f13 ?? '')
    const secid = code !== '' && (mkt === '0' || mkt === '1') ? `${mkt}.${code}` : undefined
    return {
      secid,
      code,
      name: String(it.f14 ?? ''),
      pct: num(it.f3),
      chg: num(it.f4),
      price: num(it.f2),
      up: num(it.f104),
      down: num(it.f105),
      leader: it.f128 === '-' || it.f128 === undefined || it.f128 === null ? null : String(it.f128),
      leaderPct: num(it.f136),
      money: num(it.f62),
      vol: num(it.f5),
      amount: num(it.f6),
    }
  })
  const total = num(body?.data?.total as unknown) ?? rows.length
  return { total, rows }
}

// ─────────────────────── industry board (A股) ─────────────────────────────

/** A-share-only secid filter. */
function aShare(secid: string): boolean {
  const dot = secid.indexOf('.')
  if (dot <= 0) return false
  const mkt = secid.slice(0, dot)
  return mkt === '0' || mkt === '1'
}

const INDUSTRY_NAMES_TTL = 600_000 // EM 侧行业归属极少变动

/** One A股 secid → industry name (single stock/get; f127), 10-min cached. */
async function industryNameOf(secid: string): Promise<string | null> {
  const json = await ttlCache(`industry-name:${secid}`, INDUSTRY_NAMES_TTL, () =>
    fetchAny(QUOTE_HOSTS, `/api/qt/stock/get?secid=${encodeURIComponent(secid)}&fltt=2&invt=2&fields=f57,f58,f127`),
  )
  const data = (bodyOf(json)?.data ?? null) as { f127?: unknown } | null
  const raw = data?.f127
  if (raw === null || raw === undefined || raw === '-' || raw === '') return null
  return String(raw)
}

/** name → 板块当日涨跌幅；分页拉全行业榜（每页 30s 缓存），供批量复用。 */
async function industryBoardPctMap(): Promise<Map<string, number | null>> {
  const map = new Map<string, number | null>()
  let total = Infinity
  for (let pn = 1; pn <= 8 && map.size < total; pn += 1) {
    const board = await fetchBoard('industry', 'pct', pn, 100)
    total = board.total
    for (const r of board.rows) {
      if (!map.has(r.name)) map.set(r.name, r.pct)
    }
  }
  return map
}

/** 小并发池：批量执行（行业名逐代码抓取时用，避免打爆上游）。 */
async function poolRun<T>(items: readonly T[], concurrency: number, worker: (item: T) => Promise<void>): Promise<void> {
  const queue = [...items]
  const runners = Array.from({ length: concurrency }, async () => {
    for (;;) {
      const item = queue.shift()
      if (item === undefined) return
      await worker(item)
    }
  })
  await Promise.all(runners)
}

/** A股 secids → {行业名, 板块今日涨幅}（批量；非 A股与解析失败者缺席）。 */
export async function fetchIndustryOverview(secids: string[]): Promise<Record<string, { name: string; pct: number | null }>> {
  const targets = [...new Set(secids)].filter((s) => SECID_RE.test(s) && aShare(s)).slice(0, 120)
  if (targets.length === 0) return {}
  const names = new Map<string, string>()
  await poolRun(targets, 4, async (secid) => {
    const name = await industryNameOf(secid)
    if (name !== null) names.set(secid, name)
  })
  if (names.size === 0) return {}
  const board = await industryBoardPctMap()
  const out: Record<string, { name: string; pct: number | null }> = {}
  for (const [secid, name] of names) {
    out[secid] = { name, pct: board.get(name) ?? null }
  }
  return out
}

/** 单只 A股 → 行业板块信息（抽屉顶部用），复用上面的缓存与榜单。 */
export async function fetchIndustryOf(secid: string): Promise<{ name: string; pct: number | null } | null> {
  if (!SECID_RE.test(secid) || !aShare(secid)) return null
  const map = await fetchIndustryOverview([secid])
  return map[secid] ?? null
}

// ─────────────────────────────── search ───────────────────────────────────

/**
 * EM suggest search. Eastmoney's `Classify` is NOT stable across markets
 * (沪A/深A="AStock", 科创板="23", 港股="HK", …), so acceptance is decided by
 * the *market number* with only clearly unusable pools excluded:
 *   - 90  板块 composites (not quoteable via /tradewatcher/detail)
 *   - 150 场外基金 OTC funds (no live quote)
 * A-share (0/1), HK (116), US (105–107), global indices (100) and exchange
 * futures/spot (101/103/104/112–125/142…) all pass and quote fine.
 */
const SUGGEST_EXCLUDE_MARKETS = new Set(['90', '150', '151', '152', '80'])

function suggestKind(it: Record<string, unknown>, name: string): string {
  const mkt = String(it.MktNum ?? '')
  const cls = String(it.Classify ?? '')
  const secType = String(it.SecurityTypeName ?? '')
  if (name.includes('ETF')) return 'ETF'
  if (mkt === '116') return '港股'
  if (mkt === '105' || mkt === '106' || mkt === '107') return '美股'
  if (cls === 'UniversalIndex' || cls === 'Index' || mkt === '100') return '指数'
  if (cls === 'Futures') return '期货'
  if (cls === 'Spot') return '现货'
  if (secType.includes('科创') || secType.includes('创业') || cls === 'AStock' || cls === 'Stock') return '股票'
  if (cls === 'Fund' || cls === 'OTCFUND') return '基金'
  return '行情'
}

export async function searchSymbols(query: string): Promise<SuggestItem[]> {
  const q = query.trim()
  if (q === '') return []
  if (q.length > 40) return []
  const key = `suggest:${q}`
  const json = await ttlCache(key, 8000, () =>
    fetchAny(
      [SEARCH_HOST],
      `/api/suggest/get?input=${encodeURIComponent(q)}&type=14&token=${SUGGEST_TOKEN}&count=14`,
    ),
  )
  const body = json as {
    QuotationCodeTable?: { Data?: Array<Record<string, unknown>> }
  }
  const data = body?.QuotationCodeTable?.Data
  if (!Array.isArray(data)) return []
  const out: SuggestItem[] = []
  const seen = new Set<string>()
  for (const it of data) {
    const quoteId = String(it.QuoteID ?? '')
    const code = String(it.Code ?? '')
    const mkt = String(it.MktNum ?? '')
    if (!SECID_RE.test(quoteId)) continue
    if (code === '' || code.includes('_')) continue
    if (!/^\d{1,3}$/.test(mkt) || SUGGEST_EXCLUDE_MARKETS.has(mkt)) continue
    if (seen.has(quoteId)) continue
    const name = String(it.Name ?? '')
    if (name === '') continue
    seen.add(quoteId)
    out.push({
      secid: quoteId,
      code,
      name,
      kind: suggestKind(it, name),
      market: mkt,
    })
    if (out.length >= 10) break
  }
  return out
}

export async function searchBest(query: string): Promise<SuggestItem | null> {
  const hits = await searchSymbols(query)
  if (hits.length === 0) return null
  const bare = query.trim().toUpperCase()
  const exactCode = hits.find((h) => h.code.toUpperCase() === bare || h.name === query.trim())
  return exactCode ?? hits[0]
}

export { cache as _cache }
