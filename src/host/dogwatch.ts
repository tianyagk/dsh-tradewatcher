/**
 * 汪汪队跟踪：沪市 14 只宽基 ETF 的**日频份额**（上交所规模日报）+ 当日行情（腾讯）。
 *
 * 口径（与设计稿一致）：
 *   每日份额变化 = 份额_t − 份额_{t−1}（万份 → 亿份）
 *   加仓指数     = 100 × 总份额_t ÷ 总份额_首日（首日恒 100）
 *   放大倍数     = 合计成交额 ÷ 最近 20 个交易日合计均额
 *   主动净买入   = Σ[(外盘 − 内盘) ÷ (外盘 + 内盘) × 成交额]
 *   池内加权涨跌 = Σ(涨跌 × 规模) ÷ Σ规模
 *
 * 两个保护：折算检测（份额跳 >20% 且价格无 >5% 跳空 ⇒ 该日顺延并记账）、未日更自检（≥70% 同值 ⇒ stale）。
 */
import { mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { dataHome } from './store.ts'
import { fetchTextHost } from './hostFetch.ts'
import { dayOf } from './time.ts'
import { tradingDayState } from './rescue.ts'

export interface DogwatchPoolItem { code: string; name: string; indexName: string }

/** 固定池：沪市 14 只（深市代码出现 ⇒ 排除并写 missing） */
export const DOGWATCH_POOL: readonly DogwatchPoolItem[] = [
  { code: '510300', name: '沪深300ETF华泰柏瑞', indexName: '沪深300' },
  { code: '510310', name: '沪深300ETF易方达', indexName: '沪深300' },
  { code: '510330', name: '沪深300ETF华夏', indexName: '沪深300' },
  { code: '510350', name: '沪深300ETF工银', indexName: '沪深300' },
  { code: '510050', name: '上证50ETF华夏', indexName: '上证50' },
  { code: '510500', name: '中证500ETF南方', indexName: '中证500' },
  { code: '512500', name: '中证500ETF华夏', indexName: '中证500' },
  { code: '512100', name: '中证1000ETF南方', indexName: '中证1000' },
  { code: '588000', name: '科创50ETF华夏', indexName: '科创50' },
  { code: '588080', name: '科创50ETF易方达', indexName: '科创50' },
  { code: '510180', name: '上证180ETF华安', indexName: '上证180' },
  { code: '510230', name: '金融ETF国泰', indexName: '上证金融' },
  { code: '515800', name: '中证800ETF汇添富', indexName: '中证800' },
  { code: '512050', name: '中证A500ETF华夏', indexName: '中证A500' },
]

/** 窗口 → 交易日数（2y ≈ 488 个交易日 + 20 日均额的前置） */
export const DOGWATCH_WINDOWS: Record<string, number> = { '3m': 63, '6m': 126, '1y': 250, '2y': 500 }

/** 深市/非沪市代码：池里出现就排除并记 missing */
export function isShenzhenCode(code: string): boolean {
  return /^(15|16|18)\d{4}$/.test(code) || /^sz/i.test(code)
}

/** 解析上交所规模日报：一次返回全部沪市 ETF（TOT_VOL 单位 = 万份） */
export function parseSseShares(text: string): Map<string, { name: string; volWan: number }> {
  const out = new Map<string, { name: string; volWan: number }>()
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch {
    return out
  }
  const rows = ((json as { result?: unknown[] })?.result ?? []) as Array<Record<string, unknown>>
  for (const r of rows) {
    const code = String(r.SEC_CODE ?? '').trim()
    const vol = Number(r.TOT_VOL)
    if (!/^\d{6}$/.test(code) || !Number.isFinite(vol) || vol <= 0) continue
    out.set(code, { name: String(r.SEC_NAME ?? ''), volWan: vol })
  }
  return out
}

/** 万份 → 亿份 */
export const wanToYi = (wan: number): number => wan / 1e4

export interface SharePoint { day: string; volWan: number }
export interface CorporateAction { day: string; code: string; prevWan: number; nowWan: number; ratio: number; priceGapPct: number | null }

/**
 * 折算检测（纯函数）：相邻两日 |份额比 − 1| > 20% 且当日价格无 >5% 跳空 ⇒ 判为折算。
 * 命中 ⇒ 该日**不进入**份额变化与加仓指数（用前值顺延），并返回记账条目。
 */
export function detectCorporateActions(
  series: Array<{ day: string; totalWan: number; priceGapPct: number | null }>,
  opts: { threshold?: number; priceGapMax?: number } = {},
): CorporateAction[] {
  const threshold = opts.threshold ?? 0.2
  const priceGapMax = opts.priceGapMax ?? 5
  const out: CorporateAction[] = []
  for (let i = 1; i < series.length; i += 1) {
    const prev = series[i - 1]
    const now = series[i]
    if (!(prev.totalWan > 0) || !(now.totalWan > 0)) continue
    const ratio = now.totalWan / prev.totalWan
    const gap = now.priceGapPct
    // 价格有 >5% 跳空 ⇒ 更像真实申购赎回/市场暴跌，不判折算
    if (Math.abs(ratio - 1) > threshold && (gap === null || Math.abs(gap) <= priceGapMax)) {
      out.push({ day: now.day, code: 'POOL', prevWan: prev.totalWan, nowWan: now.totalWan, ratio, priceGapPct: gap })
    }
  }
  return out
}

/** 未日更自检：同一市场当日 ≥70% 标的份额与上一日完全相同 ⇒ stale */
export function sharesStaleOf(today: Record<string, number>, prev: Record<string, number>, threshold = 0.7): boolean {
  const codes = Object.keys(today).filter((c) => prev[c] !== undefined)
  if (codes.length === 0) return false
  const same = codes.filter((c) => today[c] === prev[c]).length
  return same / codes.length >= threshold
}

/** 加仓指数序列：首日 = 100；折算日顺延（用前值，不把折算读成减仓） */
export function indexSeriesOf(series: SharePoint[], actions: readonly CorporateAction[]): Array<{ day: string; change: number; index: number }> {
  if (series.length === 0) return []
  const actionDays = new Set(actions.map((a) => a.day))
  const base = series[0].volWan
  let prev = series[0].volWan
  const out: Array<{ day: string; change: number; index: number }> = []
  for (let i = 0; i < series.length; i += 1) {
    const raw = series[i].volWan
    const vol = i > 0 && actionDays.has(series[i].day) ? prev : raw
    out.push({ day: series[i].day, change: i === 0 ? 0 : wanToYi(vol - prev), index: base > 0 ? (100 * vol) / base : 100 })
    prev = vol
  }
  return out
}

/** 放大倍数 = 合计成交额 ÷ 最近 20 个交易日合计均额（不含当日） */
export function ratioOf(totalAmount: number | null, prev20: readonly number[]): number | null {
  if (totalAmount === null || prev20.length === 0) return null
  const avg = prev20.reduce((a, b) => a + b, 0) / prev20.length
  return avg > 0 ? totalAmount / avg : null
}

/** 主动净买入（元）：Σ[(外盘−内盘)/(外盘+内盘) × 成交额] */
export function netBuyOf(rows: ReadonlyArray<{ outer: number | null; inner: number | null; amount: number | null }>): number | null {
  let sum = 0
  let any = false
  for (const r of rows) {
    if (r.outer === null || r.inner === null || r.amount === null) continue
    const total = r.outer + r.inner
    if (!(total > 0)) continue
    sum += ((r.outer - r.inner) / total) * r.amount
    any = true
  }
  return any ? sum : null
}

/** 池内加权涨跌：Σ(涨跌 × 规模) ÷ Σ规模 */
export function weightedPctOf(rows: ReadonlyArray<{ pct: number | null; scale: number | null }>): number | null {
  let num = 0
  let den = 0
  for (const r of rows) {
    if (r.pct === null || r.scale === null || !(r.scale > 0)) continue
    num += r.pct * r.scale
    den += r.scale
  }
  return den > 0 ? num / den : null
}

// ── 取数与缓存 ────────────────────────────────────────────────────────────

const SSE_HOST = 'query.sse.com.cn'
const memToday = new Map<string, { at: number; rows: Map<string, { name: string; volWan: number }> }>()
const TODAY_TTL_MS = 5 * 60_000

export function sharesCachePath(day: string): string {
  return join(dataHome(), 'dogwatch', `shares-${day}.json`)
}

/** 读磁盘缓存（历史永久）；没有 ⇒ null */
/**
 * 池覆盖率（纯函数）：缓存里命中的池内代码 / 池大小。
 * v0.188.0：早期缓存只存了一页（≈10 行）⇒ 池内只剩 1 只，界面总份额退化成单只。
 */
export function poolCoverageOf(rows: Map<string, { name: string; volWan: number }> | null): { hit: number; total: number; ratio: number } {
  const total = DOGWATCH_POOL.length
  if (rows === null) return { hit: 0, total, ratio: 0 }
  const hit = DOGWATCH_POOL.filter((p) => rows.has(p.code)).length
  return { hit, total, ratio: hit / total }
}

/** 缓存是否可用：覆盖率 ≥ 90%（<13/14 ⇒ 判残缺，必须重拉） */
export function cacheUsableOf(rows: Map<string, { name: string; volWan: number }> | null): boolean {
  return poolCoverageOf(rows).ratio >= 0.9
}

function readDiskShares(day: string): Map<string, { name: string; volWan: number }> | null {
  try {
    const raw = JSON.parse(readFileSync(sharesCachePath(day), 'utf8')) as { day?: string; rows?: Record<string, { name: string; volWan: number }> }
    if (raw.day !== day || raw.rows === undefined) return null
    const rows = new Map(Object.entries(raw.rows))
    // 残缺缓存（池覆盖 <90%）⇒ 视为未命中，调用方会重拉并覆盖
    return cacheUsableOf(rows) ? rows : null
  } catch {
    // 损坏文件：删掉该日，下一次请求只补这一天（不影响其它日）
    try { unlinkSync(sharesCachePath(day)) } catch { /* ignore */ }
    return null
  }
}

function writeDiskShares(day: string, rows: Map<string, { name: string; volWan: number }>): void {
  try {
    mkdirSync(dirname(sharesCachePath(day)), { recursive: true })
    writeFileSync(sharesCachePath(day), JSON.stringify({ day, rows: Object.fromEntries(rows) }))
  } catch {
    /* 缓存写失败不影响回包 */
  }
}

/** 取某日份额：磁盘永久缓存 → 当日 5 分钟内存 → 上游（0.72s） */
export async function loadSharesOf(day: string, now: number = Date.now()): Promise<Map<string, { name: string; volWan: number }>> {
  const disk = readDiskShares(day)
  if (disk !== null) return disk
  const isToday = day === dayOf(now)
  if (isToday) {
    const hit = memToday.get(day)
    if (hit !== undefined && now - hit.at < TODAY_TTL_MS) return hit.rows
  }
  const url = `https://${SSE_HOST}/commonQuery.do?sqlId=COMMON_SSE_ZQPZ_ETFZL_XXPL_ETFGM_SEARCH_L&type=inParams&STAT_DATE=${day}&pageHelp.pageSize=2000&pageHelp.pageNo=1`
  const text = await fetchTextHost(SSE_HOST, url, { referer: 'http://www.sse.com.cn/' })
  const rows = parseSseShares(text)
  if (rows.size > 0) {
    writeDiskShares(day, rows)
    if (isToday) memToday.set(day, { at: now, rows })
  }
  return rows
}

/** 回测窗口的交易日列表（含今天；跳过周末与法定假日） */
export function tradingDaysBack(count: number, now: number = Date.now()): string[] {
  const out: string[] = []
  let ts = now
  let guard = 0
  while (out.length < count && guard < count * 3) {
    guard += 1
    const day = dayOf(ts)
    if (tradingDayState(ts).trading) out.unshift(day)
    ts -= 86_400_000
  }
  return out
}

/** 4 并发 + 120ms 批间等待 */
export async function mapWithConcurrency<T, R>(items: readonly T[], limit: number, gapMs: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length)
  let i = 0
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (i < items.length) {
      const idx = i
      i += 1
      out[idx] = await fn(items[idx] as T)
      if (gapMs > 0 && i < items.length) await new Promise((r) => setTimeout(r, gapMs))
    }
  })
  await Promise.all(workers)
  return out
}

// ── 组装回包 ──────────────────────────────────────────────────────────────

export interface DogwatchRow {
  secid: string; name: string; indexName: string
  /** 规模（亿份）—— 与 `sharesYi` 同值，供加权与表格共用；**已是亿份，客户端不得再换算** */
  scale: number | null; amount: number | null; ratio20: number | null
  netBuy: number | null; pct: number | null
  /** 份额（**亿份**）：`TOT_VOL(万份) / 1e4`，全链路只此一次换算 */
  sharesYi: number | null
  /** 份额变化（亿份）；缺上一交易日 ⇒ null */
  sharesDelta: number | null
}

export interface DogwatchPayload {
  window: string
  summary: { totalAmount: number | null; ratio: number | null; netBuy: number | null; weightedPct: number | null; baseDate: string | null; /** 总份额（亿份，Σ14） */ totalSharesYi: number | null }
  series: Array<{ day: string; change: number; index: number }>
  rows: DogwatchRow[]
  missing: Array<{ what: string; why: 'no-source' | 'transient'; note: string }>
  corporateActions: CorporateAction[]
  sharesStale: boolean
  asOf: number
  /** 缓存排障：磁盘命中日数 / 网络拉取日数 / 耗时 / 是否命中汇总缓存 */
  stats: { fromDisk: number; fetched: number; elapsedMs: number; cached?: boolean }
}

/** 20 日均额档案（每日落盘，供次日算放大倍数；历史不变 ⇒ 永久缓存） */
function amountArchivePath(day: string): string { return join(dataHome(), 'dogwatch', `amount-${day}.json`) }
function readAmountArchive(): Map<string, number> {
  const out = new Map<string, number>()
  try {
    const dir = join(dataHome(), 'dogwatch')
    for (const f of readdirSync(dir)) {
      const m = /^amount-(\d{4}-\d{2}-\d{2})\.json$/.exec(f)
      if (m === null) continue
      const v = JSON.parse(readFileSync(join(dir, f), 'utf8')) as { total?: number }
      if (typeof v.total === 'number') out.set(m[1] as string, v.total)
    }
  } catch { /* 无档案 */ }
  return out
}
function writeAmountArchive(day: string, total: number): void {
  try { mkdirSync(dirname(amountArchivePath(day)), { recursive: true }); writeFileSync(amountArchivePath(day), JSON.stringify({ day, total })) } catch { /* ignore */ }
}

/** 拉一次完整回包（依赖注入便于断言：quotes / shares 可替身） */
/** 汇总结果 5 分钟缓存：键 = `window|asOfDay`（命中即零请求、零重算） */
const summaryCache = new Map<string, { at: number; payload: DogwatchPayload }>()
const SUMMARY_TTL_MS = 5 * 60_000

export async function fetchDogwatch(
  window: string,
  deps: {
    now?: number
    loadShares?: (day: string) => Promise<Map<string, { name: string; volWan: number }>>
    quotes?: (codes: string[]) => Promise<Record<string, { amount: number | null; pct: number | null; outer: number | null; inner: number | null }>>
  } = {},
): Promise<DogwatchPayload> {
  const now = deps.now ?? Date.now()
  const t0 = Date.now()
  const cacheKey = `${window}|${dayOf(now)}`
  const hit = summaryCache.get(cacheKey)
  if (hit !== undefined && now - hit.at < SUMMARY_TTL_MS) {
    return { ...hit.payload, stats: { fromDisk: hit.payload.stats.fromDisk, fetched: 0, elapsedMs: Date.now() - t0, cached: true } }
  }
  const days = Math.max(21, DOGWATCH_WINDOWS[window] ?? DOGWATCH_WINDOWS['1y'] as number) + 21
  const tradingDays = tradingDaysBack(days, now)
  const loadShares = deps.loadShares ?? ((d: string) => loadSharesOf(d, now))
  const missing: DogwatchPayload['missing'] = []
  // 池：只保留沪市；深市代码出现 ⇒ 排除并记账
  const pool = DOGWATCH_POOL.filter((p) => {
    if (isShenzhenCode(p.code)) { missing.push({ what: p.code, why: 'no-source', note: '深市无日频份额' }); return false }
    return true
  })
  let fromDisk = 0
  let fetched = 0
  const perDay = await mapWithConcurrency(tradingDays, 4, 120, async (day) => {
    // 读盘优先：磁盘已有 ⇒ 零网络；缺失/损坏 ⇒ 只补这一天
    const disk = readDiskShares(day)
    if (disk !== null) { fromDisk += 1; return { day, rows: disk } }
    const rows = await loadShares(day)
    if (rows.size > 0) fetched += 1
    return { day, rows }
  })
  const totalSeries = perDay.map(({ day, rows }) => {
    let sum = 0
    for (const p of pool) sum += rows.get(p.code)?.volWan ?? 0
    return { day, totalWan: sum, rows }
  }).filter((p) => p.totalWan > 0)
  if (totalSeries.length === 0) missing.push({ what: '份额', why: 'no-source', note: '上交所规模日报未取到任何池内标的' })
  // 价格跳空：用当日池内加权涨跌近似（无历史价 ⇒ 折算检测按"无跳空"处理，保守判折算）
  const actions = detectCorporateActions(totalSeries.map((p) => ({ day: p.day, totalWan: p.totalWan, priceGapPct: null })))
  const series = indexSeriesOf(totalSeries.map((p) => ({ day: p.day, volWan: p.totalWan })), actions)
  const last = totalSeries[totalSeries.length - 1]
  const prev = totalSeries[totalSeries.length - 2]
  const quotes = deps.quotes !== undefined
    ? await deps.quotes(pool.map((p) => `1.${p.code}`))
    : await (async () => {
        /**
         * 当日行情：腾讯批量一次拿全（成交额 f37 万元、涨跌 f32、外盘 f7、内盘 f8）。
         * 之前走 `fetchQuotesDetailed(emFields)` 在休市时段拿到的是空壳（amount/pct 为 undefined）。
         */
        const codes = pool.map((p) => `sh${p.code}`).join(',')
        const out: Record<string, { amount: number | null; pct: number | null; outer: number | null; inner: number | null }> = {}
        try {
          const text = await fetchTextHost('qt.gtimg.cn', `https://qt.gtimg.cn/q=${codes}`, { referer: 'https://gu.qq.com/', charset: 'gbk' })
          for (const line of text.split('\n')) {
            const m = /v_(sh\d{6})="([^"]*)"/.exec(line)
            if (m === null) continue
            const f = (m[2] as string).split('~')
            const num = (v: string | undefined): number | null => (v === undefined || v.trim() === '' ? null : (Number.isFinite(Number(v)) ? Number(v) : null))
            const amountWan = num(f[37])
            out[`1.${(m[1] as string).slice(2)}`] = {
              amount: amountWan === null ? null : amountWan * 1e4,
              pct: num(f[32]),
              outer: num(f[7]),
              inner: num(f[8]),
            }
          }
        } catch { /* 行情拿不到 ⇒ 相应字段 null + missing */ }
        return out
      })()
  const rows: DogwatchRow[] = pool.map((p) => {
    const q = quotes[`1.${p.code}`]
    const sharesWan = last?.rows.get(p.code)?.volWan ?? null
    const prevWan = prev?.rows.get(p.code)?.volWan ?? null
    return {
      secid: `1.${p.code}`, name: p.name, indexName: p.indexName,
      scale: sharesWan === null ? null : wanToYi(sharesWan),
      amount: q?.amount ?? null, ratio20: null, netBuy: null,
      pct: q?.pct ?? null,
      sharesYi: sharesWan === null ? null : wanToYi(sharesWan),
      sharesDelta: sharesWan !== null && prevWan !== null ? wanToYi(sharesWan - prevWan) : null,
    }
  })
  /**
   * 零值保护（v0.189.0）：单位只换算一次；若某行 `sharesYi` 恰好为 0（换算两次的典型症状），
   * 必须把它连同**原始 TOT_VOL** 一起报出来，而不是静默显示 0.0。
   */
  const zeroRows = rows.filter((r) => r.sharesYi === 0)
  for (const r of zeroRows) {
    const raw = last?.rows.get(r.secid.split('.')[1] ?? '')?.volWan
    missing.push({ what: r.secid, why: 'no-source', note: `份额换算后为 0（原始 TOT_VOL=${raw ?? '?'} 万份）——量纲可能被二次换算` })
  }
  // 折算日：单只标的的份额变化同样顺延（避免折算日的巨量"减仓"）
  const actionDays = new Set(actions.map((a) => a.day))
  if (last !== undefined && actionDays.has(last.day)) {
    for (const r of rows) r.sharesDelta = null
  }
  const totalAmount = rows.some((r) => r.amount !== null) ? rows.reduce((a, r) => a + (r.amount ?? 0), 0) : null
  const archive = readAmountArchive()
  const prev20 = [...archive.entries()].filter(([d]) => d < (last?.day ?? '')).sort((a, b) => (a[0] < b[0] ? -1 : 1)).slice(-20).map(([, v]) => v)
  if (last !== undefined && totalAmount !== null) writeAmountArchive(last.day, totalAmount)
  const ratio = ratioOf(totalAmount, prev20)
  if (ratio === null && totalAmount !== null) missing.push({ what: '放大倍数', why: 'no-source', note: `20 日合计均额样本不足（当前 ${prev20.length} 天），逐日累积后可用` })
  const netBuy = netBuyOf(rows.map((r) => ({ outer: quotes[`${r.secid}`]?.outer ?? null, inner: quotes[`${r.secid}`]?.inner ?? null, amount: r.amount })))
  const weightedPct = weightedPctOf(rows)
  // 未日更自检：当日 vs 上一日，≥70% 同值 ⇒ stale
  const todayMap: Record<string, number> = {}
  const prevMap: Record<string, number> = {}
  if (last !== undefined && prev !== undefined) for (const p of pool) {
    const t = last.rows.get(p.code)?.volWan
    const y = prev.rows.get(p.code)?.volWan
    if (t !== undefined) todayMap[p.code] = t
    if (y !== undefined) prevMap[p.code] = y
  }
  const sharesStale = sharesStaleOf(todayMap, prevMap)
  const payload: DogwatchPayload = {
    window,
    summary: {
      totalAmount, ratio, netBuy, weightedPct, baseDate: totalSeries[0]?.day ?? null,
      totalSharesYi: rows.some((r) => r.sharesYi !== null) ? rows.reduce((a, r) => a + (r.sharesYi ?? 0), 0) : null,
    },
    series, rows, missing, corporateActions: actions, sharesStale, asOf: now,
    stats: { fromDisk, fetched, elapsedMs: Date.now() - t0 },
  }
  summaryCache.set(cacheKey, { at: now, payload })
  return payload
}
