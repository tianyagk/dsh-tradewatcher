/**
 * 【棱镜】的三个**输入探针**（宿主侧；只读）：
 *
 *  ① `fetchFiveMinuteBars(secid, datalen)` —— 5 分钟 **OHLC** 线（沪深/港股）。
 *     · 主源：新浪 `quotes.sina.cn` `scale=5`（实测回 `day/open/high/low/close/volume/amount`，
 *       `volume` 是**股**、`day` 是**北京墙上时间**（该根的收盘时刻））；
 *     · 备用：腾讯 `proxy.finance.qq.com` `mkline?param=<code>,m5,,N`（实测行
 *       `[时间, 开, 收, 高, 低, 量(手), {}, 涨跌幅]`）；两侧量纲不同，回包里带 `volUnit` 如实标注。
 *
 *  ①′ **美股**：新浪 `US_MinKService.getMinK`（独立解析，`type=1|5|30`，上游固定回 1023 根 ⇒
 *     本地 `slice(-240)`）。⚠ 这里**不能**复用 `sina.ts` 的 `SinaUsMinBar`：那条链是分时用的，
 *     `d` 已是 ET、字段只留 close/vol；本页要 OHLC + 显式 `usWallToEpoch(d)` 收敛。
 *     符号命名空间也**不能**用 `gb_*` / `us*`（那是别的服务），必须是小写 ticker
 *     （`105/106/107.X → x`，见 `sinaUsTicker`）。
 *
 *  ② `fetchFiveLevelBook(secid)` —— 盘口，分两种**互斥**形态：
 *     · **有量**（沪深/ETF/部分指数标的）：腾讯 `qt.gtimg.cn` 五档（`f[9+2i]/f[10+2i]` 买档、
 *       `f[19+2i]/f[20+2i]` 卖档，量单位**手**），备用新浪 `hq.sinajs.cn` 五档（量单位**股**）
 *       ⇒ `available:true` + `microPrice`（5 档深度加权）+ `levels>0`，此时 `quoteMid` 必须为 **null**；
 *     · **只有价**（港股）：新浪 `rt_hk*` 的 `f[9]`/`f[10]` = 买一/卖一**价**（实测同一秒新鲜度），
 *       量拿不到 ⇒ `available:false` + `microPrice:null` + `levels:0`，但带 `quoteMid` 与自己的
 *       `quoteSource`/`quoteAt`。**不得**把价塞进 `microPrice`（下游分不清"真盘口"与"只有价"）。
 *     · 腾讯港股行情在本机实测：10 个量槽全 0 **且 `f9=f19=现价`**（连两档价都不是真盘口）
 *       ⇒ 腾讯港股盘口**整条弃用**，港股只走新浪价对。
 *
 * 所有请求都过既有的 `withHostBreaker`（按主机熔断记账），与其它宿主取数同款；
 * `fetchText` 可注入（测试用，不联网）。三个探针都**永不抛**：失败变成一句原因。
 */
import {
  PRISM_BARS_MAX,
  PRISM_INPUT_NAME,
  PRISM_MARKET_REASON,
  PRISM_US_FAIL_REASON,
  prismMarketOf,
  type PrismBook,
  type PrismBookLevel,
} from '../shared/prism.ts'
import { withHostBreaker } from './breakerFetch.ts'
import { sinaSymbol } from './sina.ts'
import { tencentCode, tencentQuoteCode } from './tencent.ts'
import { parseMarketStamp, usWallToEpoch } from './time.ts'

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'

/** 一根 5 分钟 OHLC bar（`vol` 的量纲见回包的 `volUnit`；缺失 ⇒ null，**不写 0**） */
export interface PrismBar {
  /** epoch ms（由北京时间/美东时间解析，见 `parseMarketStamp` / `usWallToEpoch`） */
  t: number
  /** `YYYY-MM-DD HH:mm`（该根的**收盘**时刻，与上游一致） */
  label: string
  open: number
  high: number
  low: number
  close: number
  vol: number | null
  /** 这一根是否属于"还没收满"的聚合桶（只有 10/30 分钟聚合会置 true） */
  partial?: boolean
}

export interface PrismFeed {
  bars: PrismBar[]
  /** 实际答话的源（`sina-5min` / `tencent-m5` / `sina-us-min`）；全失败 ⇒ null */
  source: string | null
  /** 量纲（`股` / `手`）——聚合与展示不改量纲，只如实标注 */
  volUnit: string | null
  /** 全失败的原因（一句话；成功时 null） */
  error: string | null
}

/** 美股分钟线的时间粒度（上游 `type`；实测 1/5/30 都能回 1023 根） */
export const PRISM_US_TYPES = [1, 5, 30] as const
export type PrismUsMinType = (typeof PRISM_US_TYPES)[number]
/** 上游固定回 1023 根 ⇒ 本地只留最近 240 根（够六块用，也不把回包撑大） */
export const PRISM_US_KEEP_BARS = 240

/** 注入点（测试用；不联网） */
export type PrismFetchText = (url: string, headers: Record<string, string>) => Promise<string>
export interface PrismFeedDeps {
  fetchText?: PrismFetchText
}

const num = (v: unknown): number | null => {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  if (typeof v !== 'string' || v.trim() === '') return null
  const n = Number(v.trim())
  return Number.isFinite(n) ? n : null
}

/** GBK 解码（腾讯/新浪行情是 GBK；UTF-8 解码会把中文名弄成乱码） */
const decodeText = (buf: ArrayBuffer, gbk: boolean): string => {
  if (!gbk) return new TextDecoder('utf-8').decode(buf)
  try {
    return new TextDecoder('gbk').decode(buf)
  } catch {
    return new TextDecoder('latin1').decode(buf)
  }
}

const GBK_HOSTS = new Set(['qt.gtimg.cn', 'hq.sinajs.cn'])

/** 默认取文本：过既有熔断、单源 6s；GBK 主机按 GBK 解码 */
const defaultFetchText: PrismFetchText = async (url, headers) => {
  const host = new URL(url).hostname
  const res = await withHostBreaker(host, () =>
    fetch(url, { headers: { 'user-agent': UA, ...headers }, signal: AbortSignal.timeout(6000) }),
  )
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${host}`)
  return decodeText(await res.arrayBuffer(), GBK_HOSTS.has(host))
}

/** 简单 TTL 缓存（同一标的在同一拍里被两个块各取一次时不重复打上游） */
function ttl<T>(map: Map<string, { at: number; value: T }>, key: string, ms: number): T | null {
  const hit = map.get(key)
  if (hit === undefined) return null
  if (Date.now() - hit.at > ms) {
    map.delete(key)
    return null
  }
  return hit.value
}
function put<T>(map: Map<string, { at: number; value: T }>, key: string, value: T): T {
  map.set(key, { at: Date.now(), value })
  // 防无界增长：只保留最近 64 个键
  if (map.size > 64) {
    const oldest = [...map.entries()].sort((a, b) => a[1].at - b[1].at)[0]
    if (oldest !== undefined) map.delete(oldest[0])
  }
  return value
}

const BAR_CACHE = new Map<string, { at: number; value: PrismFeed }>()
const BOOK_CACHE = new Map<string, { at: number; value: PrismBook }>()
/** 分钟线缓存 45s（约一拍的粒度；页面按参数重算时不重复回源） */
const BAR_TTL_MS = 45_000
/** 盘口缓存 5s（盘口变化快；页面滑参数时也不重复回源） */
const BOOK_TTL_MS = 5_000

/* ────────────────────────────── 5 分钟 OHLC（沪深/港股） ────────────────────────────── */

/** 新浪 5 分钟线（实测字段：day/open/high/low/close/volume/amount；`volume` = 股） */
async function sinaFiveMinute(sym: string, datalen: number, fetchText: PrismFetchText): Promise<PrismBar[]> {
  const url = `https://quotes.sina.cn/cn/api/json_v2.php/CN_MarketDataService.getKLineData?symbol=${sym}&scale=5&ma=no&datalen=${datalen}`
  const text = await fetchText(url, { referer: 'https://finance.sina.com.cn' })
  const rows = JSON.parse(text) as unknown
  if (!Array.isArray(rows)) return []
  const out: PrismBar[] = []
  for (const r of rows as Array<Record<string, unknown>>) {
    if (typeof r['day'] !== 'string') continue
    const label = (r['day'] as string).slice(0, 16)
    const t = parseMarketStamp(label)
    const open = num(r['open'])
    const high = num(r['high'])
    const low = num(r['low'])
    const close = num(r['close'])
    if (!Number.isFinite(t) || open === null || high === null || low === null || close === null) continue
    out.push({ t, label, open, high, low, close, vol: num(r['volume']) })
  }
  return out
}

/** 腾讯 5 分钟线（实测行：`[YYYYMMDDHHmm, 开, 收, 高, 低, 量(手), {}, 涨跌幅]`） */
async function tencentFiveMinute(code: string, datalen: number, fetchText: PrismFetchText): Promise<PrismBar[]> {
  const path = `/ifzqgtimg/appstock/app/kline/mkline?param=${code},m5,,${datalen}`
  const text = await fetchText(`https://proxy.finance.qq.com${path}`, { referer: 'https://gu.qq.com/' })
  const json = JSON.parse(text) as { data?: Record<string, { m5?: unknown }> }
  const rows = json?.data?.[code]?.m5
  if (!Array.isArray(rows)) return []
  const out: PrismBar[] = []
  for (const r of rows) {
    if (!Array.isArray(r) || r.length < 6) continue
    const raw = String(r[0])
    if (!/^\d{12}$/.test(raw)) continue
    const label = `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)} ${raw.slice(8, 10)}:${raw.slice(10, 12)}`
    const t = parseMarketStamp(label)
    const open = num(r[1])
    const close = num(r[2])
    const high = num(r[3])
    const low = num(r[4])
    if (!Number.isFinite(t) || open === null || close === null || high === null || low === null) continue
    out.push({ t, label, open, high, low, close, vol: num(r[5]) })
  }
  return out
}

/* ────────────────────────────── 美股分钟（独立命名空间 + 独立解析） ────────────────────────────── */

/**
 * 东财 secid → 新浪美股分钟服务的 **ticker（小写）**。
 *
 * ⚠ 命名空间别接错：该服务只认裸 ticker（`aapl`）。`gb_aapl`（新浪行情/日线那条）与
 * `usAAPL`（腾讯行情）**都喂不进** `US_MinKService` —— 拿错前缀时上游回空数组，
 * 看起来像"美股没有分钟源"，其实是符号接错（见 `docs/AUDIT-PRISM.md` §11）。
 */
export function sinaUsTicker(secid: string): string | null {
  const m = /^(105|106|107)\.([A-Za-z][A-Za-z0-9.]{0,11})$/.exec(secid.trim())
  return m === null ? null : (m[2] as string).toLowerCase()
}

/** 美股分钟线的 URL（`type` = 1 / 5 / 30；上游固定回 1023 根） */
export function usMinuteUrl(ticker: string, type: PrismUsMinType): string {
  return `https://stock.finance.sina.com.cn/usstock/api/jsonp_v2.php/x/US_MinKService.getMinK?symbol=${ticker}&type=${type}`
}

/**
 * 解析美股分钟回包：`/*<script>…*\/ x([{d,o,h,l,c,v,a},…])`。
 *
 * `d` 是**美东墙上时间**（该根收盘时刻）⇒ 用 `usWallToEpoch`（`Intl` 反解，含 DST）收敛；
 * 收敛失败 ⇒ 跳过该根（不猜时区、不按 UTC 硬解）。返回**全部**根（截尾由调用方做）。
 */
export function parseUsMinuteText(text: string): PrismBar[] {
  const start = text.indexOf('[')
  const end = text.lastIndexOf(']')
  if (start < 0 || end <= start) return []
  let rows: unknown
  try {
    rows = JSON.parse(text.slice(start, end + 1))
  } catch {
    return []
  }
  if (!Array.isArray(rows)) return []
  const out: PrismBar[] = []
  for (const r of rows as Array<Record<string, unknown>>) {
    if (typeof r['d'] !== 'string') continue
    const label = r['d'].slice(0, 16)
    const t = usWallToEpoch(r['d'])
    if (t === null || !Number.isFinite(t)) continue
    const open = num(r['o'])
    const high = num(r['h'])
    const low = num(r['l'])
    const close = num(r['c'])
    if (open === null || high === null || low === null || close === null) continue
    out.push({ t, label, open, high, low, close, vol: num(r['v']) })
  }
  return out.sort((a, b) => a.t - b.t)
}

/**
 * 取美股分钟线（**单链**：美股没有第二源，失败直接给原因，不假装有兜底）。
 * 上游固定回 1023 根 ⇒ 本地 `slice(-240)`；`type` 支持 1 / 5 / 30。
 */
export async function fetchSinaUsBars(secid: string, type: PrismUsMinType, deps: PrismFeedDeps = {}): Promise<PrismFeed> {
  const ticker = sinaUsTicker(secid)
  if (ticker === null) {
    return { bars: [], source: null, volUnit: null, error: '不是美股 secid（105/106/107.<TICKER>）' }
  }
  const key = `us:${ticker}:${type}`
  const cached = ttl(BAR_CACHE, key, BAR_TTL_MS)
  if (cached !== null) return cached
  try {
    const text = await (deps.fetchText ?? defaultFetchText)(usMinuteUrl(ticker, type), { referer: 'https://finance.sina.com.cn' })
    const all = parseUsMinuteText(text)
    if (all.length === 0) {
      return put(BAR_CACHE, key, { bars: [], source: null, volUnit: null, error: `${PRISM_US_FAIL_REASON}（上游回空，type=${type}）` })
    }
    return put(BAR_CACHE, key, {
      bars: all.slice(-PRISM_US_KEEP_BARS),
      source: 'sina-us-min',
      volUnit: '股',
      error: null,
    })
  } catch (error) {
    return put(BAR_CACHE, key, {
      bars: [],
      source: null,
      volUnit: null,
      error: `${PRISM_US_FAIL_REASON}（${String(error).slice(0, 80)}）`,
    })
  }
}

/**
 * 取 5 分钟 OHLC 线（美股走独立链；沪深走新浪 → 腾讯；都不行 ⇒ 空 + 原因）。
 *
 * **永不抛**：路由的契约是"永远 200"，上游的失败必须变成一句原因。
 */
export async function fetchFiveMinuteBars(secid: string, datalen = PRISM_BARS_MAX, deps: PrismFeedDeps = {}): Promise<PrismFeed> {
  // 按市场分列：无分钟源的市场直接给**各自**的原因（不再笼统说"腾讯回空"）
  const market = prismMarketOf(secid)
  if (market === 'hk' || market === 'index' || market === 'commodity' || market === 'other') {
    return { bars: [], source: null, volUnit: null, error: PRISM_MARKET_REASON[market] }
  }
  // 美股：独立链（分钟粒度固定 5；1/30 由 `fetchSinaUsBars` 直接给断言/诊断用）
  if (market === 'us') return fetchSinaUsBars(secid, 5, deps)
  const n = Math.max(24, Math.min(PRISM_BARS_MAX, Math.round(datalen) || PRISM_BARS_MAX))
  const key = `${secid}:${n}`
  const cached = ttl(BAR_CACHE, key, BAR_TTL_MS)
  if (cached !== null) return cached
  const sina = sinaSymbol(secid)
  const tx = tencentCode(secid)
  if (sina === null && tx === null) {
    return put(BAR_CACHE, key, {
      bars: [],
      source: null,
      volUnit: null,
      error: '该标的没有 5 分钟源（本插件的分钟线只覆盖沪深/美股）',
    })
  }
  const fetchText = deps.fetchText ?? defaultFetchText
  const errors: string[] = []
  if (sina !== null) {
    try {
      const bars = await sinaFiveMinute(sina, n, fetchText)
      if (bars.length > 0) {
        const sorted = bars.sort((a, b) => a.t - b.t)
        return put(BAR_CACHE, key, { bars: sorted, source: 'sina-5min', volUnit: '股', error: null })
      }
      errors.push('新浪 5 分钟回空')
    } catch (error) {
      errors.push(`新浪 5 分钟失败（${String(error).slice(0, 60)}）`)
    }
  }
  if (tx !== null) {
    try {
      const bars = await tencentFiveMinute(tx, n, fetchText)
      if (bars.length > 0) {
        const sorted = bars.sort((a, b) => a.t - b.t)
        return put(BAR_CACHE, key, { bars: sorted, source: 'tencent-m5', volUnit: '手', error: null })
      }
      errors.push('腾讯 5 分钟回空')
    } catch (error) {
      errors.push(`腾讯 5 分钟失败（${String(error).slice(0, 60)}）`)
    }
  }
  return put(BAR_CACHE, key, {
    bars: [],
    source: null,
    volUnit: null,
    error: `沪深分钟线取数失败（${errors.join('；') || '两条 5 分钟源都没有数据'}）`,
  })
}

/* ────────────────────────────── 盘口（两种形态，互斥） ────────────────────────────── */

const emptyBook = (reason: string): PrismBook => ({
  available: false, reason, source: null, levels: 0,
  bids: [], asks: [], microPrice: null,
  quoteMid: null, quoteSource: null, quoteAt: null,
})

/** 只有价、没有量的盘口（港股）：`available:false` + `microPrice:null` + `quoteMid` */
const quoteOnlyBook = (quoteMid: number | null, quoteSource: string | null, quoteAt: number | null, reason: string): PrismBook => ({
  available: false,
  reason,
  source: null,
  levels: 0,
  bids: [],
  asks: [],
  microPrice: null,
  quoteMid,
  quoteSource,
  quoteAt,
})

const lv = (price: number | null, size: number | null): PrismBookLevel => ({ price, size })

/** 有效档：价 > 0 且量 > 0（指数/停牌的盘口是 `0.00 / 0`，那是"没有"，不是"价格为 0"） */
export const validLevel = (l: PrismBookLevel): boolean => l.price !== null && l.size !== null && l.price > 0 && l.size > 0

/** 两侧都有效的档数（页面与微价都只用这个数字） */
export const depthOf = (bids: readonly PrismBookLevel[], asks: readonly PrismBookLevel[]): number =>
  Math.min(bids.filter(validLevel).length, asks.filter(validLevel).length)

/**
 * 深度加权 micro-price：`Σ(买价×卖量) + Σ(卖价×买量)` ÷ `Σ买量+Σ卖量`（只用实际拿到的那几档）。
 *
 * 只用单侧（例如只有买盘）⇒ 退化成最优买卖的算术中值（仅当两侧都有正价）；都没有 ⇒ null
 * （**不拿收盘价、不拿 0 凑**）。
 */
export function microPriceOf(bids: readonly PrismBookLevel[], asks: readonly PrismBookLevel[]): number | null {
  let acc = 0
  let den = 0
  const depth = Math.min(bids.length, asks.length)
  for (let i = 0; i < depth; i += 1) {
    const b = bids[i] as PrismBookLevel
    const a = asks[i] as PrismBookLevel
    if (!validLevel(b) || !validLevel(a)) continue
    acc += (b.price as number) * (a.size as number) + (a.price as number) * (b.size as number)
    den += (b.size as number) + (a.size as number)
  }
  if (den > 0) return acc / den
  const bid1 = bids.find((b) => b.price !== null && b.price > 0)?.price ?? null
  const ask1 = asks.find((a) => a.price !== null && a.price > 0)?.price ?? null
  if (bid1 !== null && ask1 !== null) return (bid1 + ask1) / 2
  return null
}

/** 腾讯 `qt.gtimg.cn` 回包 → 五档（`f[9+2i]` 买价、`f[10+2i]` 买量；`f[19+2i]`/`f[20+2i]` 卖档） */
export function parseTencentDepthBook(text: string): PrismBook {
  const m = /="([\s\S]*?)"/.exec(text)
  if (m === null) return emptyBook('腾讯回包没有行情行（可能是未知代码）')
  const f = (m[1] as string).split('~')
  const bids: PrismBookLevel[] = []
  const asks: PrismBookLevel[] = []
  for (let i = 0; i < 5; i += 1) bids.push(lv(num(f[9 + i * 2]), num(f[10 + i * 2])))
  for (let i = 0; i < 5; i += 1) asks.push(lv(num(f[19 + i * 2]), num(f[20 + i * 2])))
  const levels = depthOf(bids, asks)
  const microPrice = levels > 0 ? microPriceOf(bids, asks) : null
  if (levels === 0 || microPrice === null) {
    return emptyBook('腾讯回包没有买一/卖一数量（指数/停牌/集合竞价可能如此）')
  }
  return {
    available: true,
    reason: null,
    source: `腾讯五档（量单位：手，可用 ${levels} 档）`,
    levels,
    bids,
    asks,
    microPrice,
    quoteMid: null,
    quoteSource: null,
    quoteAt: null,
  }
}

/** 新浪 `hq.sinajs.cn` 深度回包 → 五档（买 i 量/价 `f[10+2i]`/`f[11+2i]`；卖 i `f[20+2i]`/`f[21+2i]`；量单位股） */
export function parseSinaDepthBook(text: string): PrismBook {
  const m = /="([\s\S]*?)"/.exec(text)
  if (m === null) return emptyBook('新浪回包没有行情行')
  const f = (m[1] as string).split(',')
  const bids: PrismBookLevel[] = []
  const asks: PrismBookLevel[] = []
  for (let i = 0; i < 5; i += 1) bids.push(lv(num(f[11 + i * 2]), num(f[10 + i * 2])))
  for (let i = 0; i < 5; i += 1) asks.push(lv(num(f[21 + i * 2]), num(f[20 + i * 2])))
  const levels = depthOf(bids, asks)
  const microPrice = levels > 0 ? microPriceOf(bids, asks) : null
  if (levels === 0 || microPrice === null) return emptyBook('新浪回包没有买一/卖一数量')
  return {
    available: true,
    reason: null,
    source: `新浪五档（量单位：股，可用 ${levels} 档）`,
    levels,
    bids,
    asks,
    microPrice,
    quoteMid: null,
    quoteSource: null,
    quoteAt: null,
  }
}

/** 港股实时行情代码（`116.00700 → rt_hk00700`；其它市场 ⇒ null） */
export function hkQuoteSymbol(secid: string): string | null {
  const m = /^116\.(\d{1,5})$/.exec(secid.trim())
  return m === null ? null : `rt_hk${(m[1] as string).padStart(5, '0')}`
}

/**
 * 新浪港股实时行情 → 只有价的盘口：`f[9]` 买一价、`f[10]` 卖一价、`f[17]+f[18]` 日期+时间。
 * 量拿不到（该回包不给委托量）⇒ 只产出 `quoteMid`，**不产出 microPrice**。
 */
export function parseSinaHkQuote(text: string): { bid: number | null; ask: number | null; at: number | null } {
  const m = /="([\s\S]*?)"/.exec(text)
  if (m === null) return { bid: null, ask: null, at: null }
  const f = (m[1] as string).split(',')
  const bidRaw = num(f[9])
  const askRaw = num(f[10])
  const day = (f[17] ?? '').trim().replace(/\//g, '-')
  const clock = (f[18] ?? '').trim()
  const at = /^\d{4}-\d{2}-\d{2}$/.test(day) && /^\d{2}:\d{2}:\d{2}$/.test(clock) ? parseMarketStamp(`${day} ${clock}`) : null
  return {
    bid: bidRaw !== null && bidRaw > 0 ? bidRaw : null,
    ask: askRaw !== null && askRaw > 0 ? askRaw : null,
    at: Number.isFinite(at) ? at : null,
  }
}

/** 港股：只取新浪价对（腾讯港股盘口整条弃用，理由见文件头） */
async function hkQuoteBook(secid: string, fetchText: PrismFetchText): Promise<PrismBook> {
  const sym = hkQuoteSymbol(secid)
  if (sym === null) return emptyBook('不是港股 secid（116.xxxxx）')
  const text = await fetchText(`https://hq.sinajs.cn/list=${sym}`, { referer: 'https://finance.sina.com.cn' })
  const q = parseSinaHkQuote(text)
  if (q.bid === null || q.ask === null) {
    return quoteOnlyBook(null, null, q.at, '新浪港股回包没有买一/卖一价（停牌或集合竞价可能如此）')
  }
  return quoteOnlyBook(
    (q.bid + q.ask) / 2,
    `${PRISM_INPUT_NAME.quote} · 新浪港股盘口价（量不可用）`,
    q.at,
    '港股只有盘口价、没有可用的委托量 ⇒ 不给 micro-price（不拿 0 量凑）',
  )
}

/**
 * 取盘口。**永不抛**：失败 ⇒ `available:false` + 一句原因。
 *
 * 形态互斥（契约见 `shared/prism.ts` 的 `PrismBook`）：有量 ⇒ `available:true` + `microPrice`；
 * 只有价 ⇒ `available:false` + `quoteMid`（港股）。
 */
export async function fetchFiveLevelBook(secid: string, deps: PrismFeedDeps = {}): Promise<PrismBook> {
  const cached = ttl(BOOK_CACHE, secid, BOOK_TTL_MS)
  if (cached !== null) return cached
  const fetchText = deps.fetchText ?? defaultFetchText
  const errors: string[] = []
  // 港股：只走新浪价对（腾讯港股的量槽全 0 且两档价 == 现价 ⇒ 不可信）
  if (hkQuoteSymbol(secid) !== null) {
    try {
      const book = await hkQuoteBook(secid, fetchText)
      return put(BOOK_CACHE, secid, book)
    } catch (error) {
      return put(BOOK_CACHE, secid, emptyBook(`新浪港股盘口价失败（${String(error).slice(0, 60)}）`))
    }
  }
  // 沪深/美股/指数：腾讯五档 → 新浪五档（有量才 available）
  const txCode = tencentQuoteCode(secid) ?? tencentCode(secid)
  if (txCode !== null) {
    try {
      const text = await fetchText(`https://qt.gtimg.cn/q=${txCode}`, { referer: 'https://gu.qq.com/' })
      const book = parseTencentDepthBook(text)
      if (book.available) return put(BOOK_CACHE, secid, book)
      errors.push(`腾讯：${book.reason ?? '五档不可用'}`)
    } catch (error) {
      errors.push(`腾讯五档失败（${String(error).slice(0, 60)}）`)
    }
  }
  const sym = sinaSymbol(secid)
  if (sym !== null) {
    try {
      const text = await fetchText(`https://hq.sinajs.cn/list=${sym}`, { referer: 'https://finance.sina.com.cn' })
      const book = parseSinaDepthBook(text)
      if (book.available) return put(BOOK_CACHE, secid, book)
      errors.push(`新浪：${book.reason ?? '五档不可用'}`)
    } catch (error) {
      errors.push(`新浪五档失败（${String(error).slice(0, 60)}）`)
    }
  } else if (txCode === null) {
    errors.push('该标的没有盘口源（不是沪深/港股，也不是腾讯可映射的代码）')
  }
  return put(BOOK_CACHE, secid, emptyBook(errors.join('；') || '盘口拿不到'))
}
