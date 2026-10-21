/**
 * 【棱镜】的两个**输入探针**（宿主侧；只读）：
 *
 *  ① `fetchFiveMinuteBars(secid, datalen)` —— 5 分钟 **OHLC** 线。
 *     · 主源：新浪 `quotes.sina.cn` `scale=5`（实测回 `day/open/high/low/close/volume/amount`，
 *       `volume` 是**股**、`day` 是**北京墙上时间**（该根的收盘时刻））；
 *     · 备用：腾讯 `proxy.finance.qq.com` `mkline?param=<code>,m5,,N`（实测行
 *       `[时间, 开, 收, 高, 低, 量(手), {}, 涨跌幅]`）；两侧量纲不同，回包里带 `volUnit` 如实标注。
 *
 *     ⚠ 为什么不复用 `em.ts` 的 `fetchSinaMinuteBars`：那条链是**分时**用的，解析时只保留
 *     `close/vol`（`TrendPoint` 的字段），OHLC 在解析处就被丢掉了；而本页的聚合、ATR、目标价
 *     都需要 OHLC。这里**复用同一上游、同一套时间解析**（`parseMarketStamp`，避免 TZ 漂移），
 *     没有接入任何新的数据源（AUDIT-PRISM §2 有实测记录）。
 *
 *  ② `fetchFiveLevelBook(secid)` —— **五档价量**（买一/卖一**数量**是 micro-price 的必要输入）。
 *     · 主源：腾讯 `qt.gtimg.cn/q=`（GBK，`~` 分隔）：`f[3]` 现价、`f[9+2i]/f[10+2i]` = 买 i 价/量、
 *       `f[19+2i]/f[20+2i]` = 卖 i 价/量（i=0..4，量单位**手**；实测锚点见 `docs/AUDIT-PRISM.md`）；
 *     · 备用：新浪 `hq.sinajs.cn/list=`（需要 `referer`；`f[6]/f[7]` 买一/卖一价，`f[10+2i]/f[11+2i]`
 *       = 买 i 量/价，`f[20+2i]/f[21+2i]` = 卖 i 量/价，量单位**股**）。
 *     · 两源都拿不到（非沪深/港股、指数、或上游故障）⇒ `available:false` + 原因（不编数）。
 *
 * 所有请求都过既有的 `withHostBreaker`（按主机熔断记账），与其它宿主取数同款。
 */
import { PRISM_BARS_MAX, type PrismBook, type PrismBookLevel } from '../shared/prism.ts'
import { withHostBreaker } from './breakerFetch.ts'
import { sinaSymbol } from './sina.ts'
import { tencentCode, tencentQuoteCode } from './tencent.ts'
import { parseMarketStamp } from './time.ts'

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'

/** 一根 5 分钟 OHLC bar（`vol` 的量纲见回包的 `volUnit`；缺失 ⇒ null，**不写 0**） */
export interface PrismBar {
  /** epoch ms（由北京墙上时间解析，见 `parseMarketStamp`） */
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
  /** 实际答话的源（`sina-5min` / `tencent-m5`）；全失败 ⇒ null */
  source: string | null
  /** 量纲（`股` / `手`）——聚合与展示不改量纲，只如实标注 */
  volUnit: string | null
  /** 全失败的原因（一句话；成功时 null） */
  error: string | null
}

const num = (v: unknown): number | null => {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  if (typeof v !== 'string' || v.trim() === '') return null
  const n = Number(v.trim())
  return Number.isFinite(n) ? n : null
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
/** 5 分钟线缓存 45s（约一拍的粒度；页面按参数重算时不重复回源） */
const BAR_TTL_MS = 45_000
/** 盘口缓存 5s（五档变化快；页面滑参数时也不重复回源） */
const BOOK_TTL_MS = 5_000

/* ────────────────────────────── 5 分钟 OHLC ────────────────────────────── */

/** 新浪 5 分钟线（实测字段：day/open/high/low/close/volume/amount；`volume` = 股） */
async function sinaFiveMinute(sym: string, datalen: number): Promise<PrismBar[]> {
  const url = `https://quotes.sina.cn/cn/api/json_v2.php/CN_MarketDataService.getKLineData?symbol=${sym}&scale=5&ma=no&datalen=${datalen}`
  const res = await withHostBreaker('quotes.sina.cn', () =>
    fetch(url, {
      headers: { 'user-agent': UA, referer: 'https://finance.sina.com.cn' },
      // 单源 6s：两条链串行 ⇒ 最坏 12s，留在客户端 15s 请求上限之内（否则整页报"请求超时"）
      signal: AbortSignal.timeout(6000),
    }),
  )
  if (!res.ok) throw new Error(`HTTP ${res.status} from sina`)
  const rows = (await res.json()) as Array<Record<string, unknown>>
  if (!Array.isArray(rows)) return []
  const out: PrismBar[] = []
  for (const r of rows) {
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
async function tencentFiveMinute(code: string, datalen: number): Promise<PrismBar[]> {
  const path = `/ifzqgtimg/appstock/app/kline/mkline?param=${code},m5,,${datalen}`
  const res = await withHostBreaker('proxy.finance.qq.com', () =>
    fetch(`https://proxy.finance.qq.com${path}`, {
      headers: { 'user-agent': UA, referer: 'https://gu.qq.com/' },
      signal: AbortSignal.timeout(6000),
    }),
  )
  if (!res.ok) throw new Error(`HTTP ${res.status} from tencent`)
  const json = (await res.json()) as { data?: Record<string, { m5?: unknown }> }
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

/**
 * 取 5 分钟 OHLC 线（新浪 → 腾讯；两条都不行 ⇒ 空 + 原因）。
 *
 * **永不抛**：路由的契约是"永远 200"，上游的失败必须变成一句原因。
 */
export async function fetchFiveMinuteBars(secid: string, datalen = PRISM_BARS_MAX): Promise<PrismFeed> {
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
      error: '该标的没有 5 分钟源（本插件的分钟线只覆盖沪深/港股）',
    })
  }
  const errors: string[] = []
  if (sina !== null) {
    try {
      const bars = await sinaFiveMinute(sina, n)
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
      const bars = await tencentFiveMinute(tx, n)
      if (bars.length > 0) {
        const sorted = bars.sort((a, b) => a.t - b.t)
        return put(BAR_CACHE, key, { bars: sorted, source: 'tencent-m5', volUnit: '手', error: null })
      }
      errors.push('腾讯 5 分钟回空')
    } catch (error) {
      errors.push(`腾讯 5 分钟失败（${String(error).slice(0, 60)}）`)
    }
  }
  return put(BAR_CACHE, key, { bars: [], source: null, volUnit: null, error: errors.join('；') || '两条 5 分钟源都没有数据' })
}

/* ────────────────────────────── 五档盘口 ────────────────────────────── */

const emptyBook = (reason: string): PrismBook => ({
  available: false, reason, source: null, levels: 0,
  bids: [], asks: [], microPrice: null,
})

const lv = (price: number | null, size: number | null): PrismBookLevel => ({ price, size })

/**
 * 深度加权 micro-price：`Σ(买价×卖量) + Σ(卖价×买量)` ÷ `Σ买量+Σ卖量`（只用实际拿到的档数）。
 *
 * 只用单侧（例如只有买盘）⇒ 退化成该侧最优价；两侧都没有 ⇒ null（**不拿收盘价凑**）。
 */
/** 有效档：价 > 0 且量 > 0（指数/停牌的盘口是 `0.00 / 0`，那是"没有"，不是"价格为 0"） */
export const validLevel = (l: PrismBookLevel): boolean => l.price !== null && l.size !== null && l.price > 0 && l.size > 0

/** 两侧都有效的档数（页面与微价都只用这个数字） */
export const depthOf = (bids: readonly PrismBookLevel[], asks: readonly PrismBookLevel[]): number =>
  Math.min(bids.filter(validLevel).length, asks.filter(validLevel).length)

export function microPriceOf(bids: readonly PrismBookLevel[], asks: readonly PrismBookLevel[]): number | null {
  // 逐档配对：`Σ(买价×卖量 + 卖价×买量) / Σ(买量+卖量)`；只用两侧都有效的那几档
  let num = 0
  let den = 0
  const depth = Math.min(bids.length, asks.length)
  for (let i = 0; i < depth; i += 1) {
    const b = bids[i] as PrismBookLevel
    const a = asks[i] as PrismBookLevel
    if (!validLevel(b) || !validLevel(a)) continue
    num += (b.price as number) * (a.size as number) + (a.price as number) * (b.size as number)
    den += (b.size as number) + (a.size as number)
  }
  if (den > 0) return num / den
  // 一点深度都没有 ⇒ 只有"两侧都有正价"才退回算术中值；否则 null（不拿 0 或收盘价凑）
  const bid1 = bids.find((b) => b.price !== null && b.price > 0)?.price ?? null
  const ask1 = asks.find((a) => a.price !== null && a.price > 0)?.price ?? null
  if (bid1 !== null && ask1 !== null) return (bid1 + ask1) / 2
  return null
}

/** 腾讯 `qt.gtimg.cn`：五档（`f[9+2i]` 买价、`f[10+2i]` 买量；`f[19+2i]`/`f[20+2i]` 卖档） */
async function tencentBook(secid: string): Promise<PrismBook> {
  const code = tencentQuoteCode(secid) ?? tencentCode(secid)
  if (code === null) return emptyBook('该标的没有五档源（腾讯只覆盖沪深/港股/美股/少数指数）')
  const res = await withHostBreaker('qt.gtimg.cn', () =>
    fetch(`https://qt.gtimg.cn/q=${code}`, {
      headers: { 'user-agent': UA, referer: 'https://gu.qq.com/' },
      signal: AbortSignal.timeout(5000),
    }),
  )
  if (!res.ok) throw new Error(`HTTP ${res.status} from qt.gtimg.cn`)
  const buf = await res.arrayBuffer()
  const text = (() => {
    try {
      return new TextDecoder('gbk').decode(buf)
    } catch {
      return new TextDecoder('latin1').decode(buf)
    }
  })()
  const m = /="([\s\S]*?)"/.exec(text)
  if (m === null) return emptyBook('腾讯回包没有行情行（可能是未知代码）')
  const f = (m[1] as string).split('~')
  const bids: PrismBookLevel[] = []
  const asks: PrismBookLevel[] = []
  for (let i = 0; i < 5; i += 1) bids.push(lv(num(f[9 + i * 2]), num(f[10 + i * 2])))
  for (let i = 0; i < 5; i += 1) asks.push(lv(num(f[19 + i * 2]), num(f[20 + i * 2])))
  const levels = depthOf(bids, asks)
  if (levels === 0) return emptyBook('腾讯回包没有买一/卖一数量（指数/停牌/集合竞价可能如此）')
  return {
    available: true,
    reason: null,
    source: `腾讯五档（量单位：手，可用 ${levels} 档）`,
    levels,
    bids,
    asks,
    microPrice: microPriceOf(bids, asks),
  }
}

/** 新浪 `hq.sinajs.cn`：五档（买 i 量/价在 `f[10+2i]`/`f[11+2i]`；卖 i 在 `f[20+2i]`/`f[21+2i]`；量单位股） */
async function sinaBook(secid: string): Promise<PrismBook> {
  const sym = sinaSymbol(secid)
  if (sym === null) return emptyBook('该标的没有新浪五档源（新浪只覆盖沪深）')
  const res = await withHostBreaker('hq.sinajs.cn', () =>
    fetch(`https://hq.sinajs.cn/list=${sym}`, {
      headers: { 'user-agent': UA, referer: 'https://finance.sina.com.cn' },
      signal: AbortSignal.timeout(5000),
    }),
  )
  if (!res.ok) throw new Error(`HTTP ${res.status} from hq.sinajs.cn`)
  const buf = await res.arrayBuffer()
  const text = (() => {
    try {
      return new TextDecoder('gbk').decode(buf)
    } catch {
      return new TextDecoder('latin1').decode(buf)
    }
  })()
  const m = /="([\s\S]*?)"/.exec(text)
  if (m === null) return emptyBook('新浪回包没有行情行')
  const f = (m[1] as string).split(',')
  const bids: PrismBookLevel[] = []
  const asks: PrismBookLevel[] = []
  for (let i = 0; i < 5; i += 1) bids.push(lv(num(f[11 + i * 2]), num(f[10 + i * 2])))
  for (let i = 0; i < 5; i += 1) asks.push(lv(num(f[21 + i * 2]), num(f[20 + i * 2])))
  const levels = depthOf(bids, asks)
  if (levels === 0) return emptyBook('新浪回包没有买一/卖一数量')
  return {
    available: true,
    reason: null,
    source: `新浪五档（量单位：股，可用 ${levels} 档）`,
    levels,
    bids,
    asks,
    microPrice: microPriceOf(bids, asks),
  }
}

/**
 * 取五档盘口（腾讯 → 新浪）。**永不抛**：两条都失败 ⇒ `available:false` + 一句原因。
 *
 * 这条是「输入不可得时先探索」的兑现：Spread 的 mid 与 Stoikov 的 s 都优先用 micro-price，
 * 拿不到才退回最新收盘价，并在回包的 `midSource`/`sSource` 里如实写明用的是哪一个。
 */
export async function fetchFiveLevelBook(secid: string): Promise<PrismBook> {
  const cached = ttl(BOOK_CACHE, secid, BOOK_TTL_MS)
  if (cached !== null) return cached
  const errors: string[] = []
  try {
    const book = await tencentBook(secid)
    if (book.available) return put(BOOK_CACHE, secid, book)
    errors.push(book.reason ?? '腾讯五档不可用')
  } catch (error) {
    errors.push(`腾讯五档失败（${String(error).slice(0, 60)}）`)
  }
  try {
    const book = await sinaBook(secid)
    if (book.available) return put(BOOK_CACHE, secid, book)
    errors.push(book.reason ?? '新浪五档不可用')
  } catch (error) {
    errors.push(`新浪五档失败（${String(error).slice(0, 60)}）`)
  }
  return put(BOOK_CACHE, secid, emptyBook(errors.join('；') || '五档拿不到'))
}
