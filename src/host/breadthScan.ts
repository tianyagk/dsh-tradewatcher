import { dayOf } from './time.ts'

/**
 * 腾讯聚合涨跌分布（按 `docs/PROBE-BREADTH-SOURCES.md` 结论：无鉴权、≤600/批、4 并发 0.9s）。
 *
 * 本模块只做**可测的纯逻辑**：11 档分桶（含停牌单列）、分批、退避、断点续扫、代码表缓存判据。
 * 网络与 GBK 解码由调用方注入（`fetchBatch` / `fetchTable`），便于断言与替换。
 */
export const BATCH_SIZE = 600
export const BATCH_GAP_MS = 120
export const MAX_CONCURRENCY = 4

export interface QuoteRow { pct: number | null; suspended?: boolean }

/**
 * 11 档分桶：正 5 档 + 平 + 负 5 档（边界**左闭右开**：`[10,+∞)` 进「>10」，`(-∞,-10]` 进「≤-10」）
 *
 * v0.183.0 修：`+10.00%` 此前落到「7~10」（`pct > 10` 是开区间）—— 与负侧 `-10.00 ⇒ ≤-10` 不对称。
 */
export function bucketIndexOf(pct: number): number {
  if (pct >= 10) return 0
  if (pct >= 7) return 1
  if (pct >= 5) return 2
  if (pct >= 3) return 3
  if (pct > 0) return 4
  if (pct === 0) return 5
  if (pct >= -3) return 6
  if (pct >= -5) return 7
  if (pct >= -7) return 8
  if (pct > -10) return 9
  return 10
}

export interface Aggregate {
  buckets: number[]
  up: number
  down: number
  flat: number
  limitUp: number
  limitDown: number
  suspended: number
  total: number
}

/**
 * 聚合：**停牌单列**（不计平盘、不冒充 0）；涨跌停由调用方按涨跌停价判好后放进 `limitUp/limitDown` 计数。
 * 返回的 `total = 各档合计 + 停牌`（差一只就说明有行没归位）。
 */
export function aggregateOf(rows: readonly QuoteRow[], extra: { limitUp?: number; limitDown?: number } = {}): Aggregate {
  const buckets = Array.from({ length: 11 }, () => 0)
  let up = 0, down = 0, flat = 0, suspended = 0
  for (const r of rows) {
    if (r.suspended === true) { suspended += 1; continue }
    const p = r.pct
    if (typeof p !== 'number' || !Number.isFinite(p)) continue
    buckets[bucketIndexOf(p)]! += 1
    if (p > 0) up += 1
    else if (p < 0) down += 1
    else flat += 1
  }
  const total = buckets.reduce((a, b) => a + b, 0) + suspended
  return { buckets, up, down, flat, limitUp: extra.limitUp ?? 0, limitDown: extra.limitDown ?? 0, suspended, total }
}

/**
 * 分批（每批 ≤600）。
 *
 * v0.183.0 修：`size = 0` 时 `i += 0` **死循环**（把整个进程挂死）。入口先归一成整数并校验：
 * 非有限数或 <1 ⇒ 抛 `RangeError('batch size must be >= 1')`；空 `codes` 直接 `[]`（不进循环）。
 */
export function batchesOf(codes: readonly string[], size: number): string[][] {
  // 空池先返回（不进循环，也不因 size 报错）—— 这样"空数据 + 默认参数缺失"不会把无害调用变成异常
  if (codes.length === 0) return []
  // 参数**必填**：显式传 `undefined` 也走同一分支 ⇒ `Math.floor(undefined)=NaN` ⇒ RangeError（不静默用默认值）
  const n = Math.floor(size)
  if (!Number.isFinite(n) || n < 1) throw new RangeError('batch size must be >= 1')
  const out: string[][] = []
  for (let i = 0; i < codes.length; i += n) out.push(codes.slice(i, i + n))
  return out
}

export interface ScanState { poolVersion: string; done: number[]; failedBatches: number[] }

/**
 * 分批扫描（**4 并发 + 120ms 批间延迟 + 指数退避 1/2/4s 且降并发到 1**）。
 * 单批失败不废整轮：记 `failedBatches`，其余批照常返回（断点续扫靠 `done`）。
 */
export async function scanBatches<T extends QuoteRow>(args: {
  batches: readonly string[][]
  fetchBatch: (codes: readonly string[], batch: number) => Promise<T[]>
  sleep: (ms: number) => Promise<void>
  state?: ScanState
  concurrency?: number
  gapMs?: number
  retryDelays?: readonly number[]
}): Promise<{ rows: T[]; state: ScanState; failedBatches: number[] }> {
  const gap = Math.max(BATCH_GAP_MS, args.gapMs ?? BATCH_GAP_MS)
  const conc = Math.min(MAX_CONCURRENCY, Math.max(1, args.concurrency ?? MAX_CONCURRENCY))
  const delays = args.retryDelays ?? [1000, 2000, 4000]
  const done = new Set(args.state?.done ?? [])
  const failed: number[] = [...(args.state?.failedBatches ?? [])]
  const rows: T[] = []
  let idx = 0
  let liveConc = conc
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = idx++
      const batch = args.batches[i]
      if (batch === undefined) return
      if (done.has(i)) continue
      let ok: T[] | null = null
      for (let attempt = 0; attempt <= delays.length; attempt += 1) {
        try { ok = await args.fetchBatch(batch, i); break } catch {
          const wait = delays[attempt]
          if (wait !== undefined) { await args.sleep(wait); liveConc = 1 }
        }
      }
      if (ok === null) { if (!failed.includes(i)) failed.push(i) } else { done.add(i); rows.push(...ok) }
      await args.sleep(gap)
    }
  }
  await Promise.all(Array.from({ length: liveConc }, () => worker()))
  return { rows, state: { poolVersion: args.state?.poolVersion ?? '', done: [...done].sort((a, b) => a - b), failedBatches: failed.sort((a, b) => a - b) }, failedBatches: failed.sort((a, b) => a - b) }
}

/* ────────────────────── 新浪代码表（沪深A股，不含北交所） ────────────────────── */

/** 代码表主机（新浪财经行情服务） */
export const SINA_CODE_HOST = 'vip.stock.finance.sina.com.cn'
/** 单页上限（实测 `num=500` 被压回 100） */
export const CODE_PAGE_SIZE = 100
/** 页数上限（沪深A股实测 56 页；留 4 页余量，超了就是上游变了） */
export const CODE_PAGES_MAX = 60
/** 页间隔（实测 200ms 连跑 56 页零失败） */
export const CODE_PAGE_GAP_MS = 200

/** 代码表页 URL（`node=hs_a` 已含北交所 ⇒ 解析时按前缀过滤掉 bj） */
export function sinaCodePageUrl(page: number, pageSize = CODE_PAGE_SIZE): string {
  return `https://${SINA_CODE_HOST}/quotes_service/api/json_v2.php/Market_Center.getHQNodeData?page=${page}&num=${pageSize}&node=hs_a&sort=symbol&asc=1`
}

/**
 * 解析代码表一页：只留 `sh`/`sz` 六位代码（**北交所 `bj*` 一律剔除** —— 本项目的
 * 涨跌分布口径是"沪深A股，不含北交所"，界面标「北交所 未接入」）。
 * 非 JSON / 空页 ⇒ 返回空数组（调用方据此停止翻页）。
 */
export function parseSinaCodePage(text: string): { codes: string[]; rows: number } {
  let rows: unknown
  try {
    rows = JSON.parse(text)
  } catch {
    return { codes: [], rows: 0 }
  }
  if (!Array.isArray(rows)) return { codes: [], rows: 0 }
  const out: string[] = []
  for (const raw of rows) {
    const sym = String((raw as { symbol?: unknown } | null)?.symbol ?? '').trim().toLowerCase()
    if (/^(sh|sz)\d{6}$/.test(sym)) out.push(sym)
  }
  return { codes: out, rows: rows.length }
}


/** 拉全量代码表（翻页到空页或上限；页间 `CODE_PAGE_GAP_MS`） */
export async function fetchSinaCodePool(
  fetchText: (host: string, url: string, opts?: { referer?: string }) => Promise<string>,
  sleep: (ms: number) => Promise<void>,
  maxPages = CODE_PAGES_MAX,
): Promise<string[]> {
  const seen = new Set<string>()
  for (let page = 1; page <= maxPages; page += 1) {
    const text = await fetchText(SINA_CODE_HOST, sinaCodePageUrl(page), { referer: 'https://finance.sina.com.cn' })
    const pageOf = parseSinaCodePage(text)
    if (pageOf.rows === 0) break
    for (const c of pageOf.codes) seen.add(c)
    await sleep(CODE_PAGE_GAP_MS)
  }
  return [...seen]
}

/* ────────────────────── 腾讯批量报价 ────────────────────── */

/** 批量报价主机 */
export const QT_HOST = 'qt.gtimg.cn'
/** 单批上限（实测 700 起 TCP 断连；600 安全） */
export const QT_BATCH = BATCH_SIZE

/** 一批报价的 URL（600 只 ≈ 5.4KB，远低于断连阈值） */
export function qtBatchUrl(codes: readonly string[]): string {
  return `https://${QT_HOST}/q=${codes.join(',')}`
}

export interface TencentQuote {
  /** `sh600000` / `sz000001` */
  code: string
  price: number | null
  prev: number | null
  /** 成交量（手）—— 停牌判定要用它 */
  vol: number | null
  /** f[32] 涨跌幅（%） */
  pct: number | null
  /** f[47] 涨停价 */
  upLimit: number | null
  /** f[48] 跌停价 */
  downLimit: number | null
}

const numOf = (v: string | undefined): number | null => {
  if (v === undefined) return null
  const s = v.trim()
  if (s === '') return null
  const n = Number(s)
  return Number.isFinite(n) ? n : null
}

/**
 * 解析 `qt.gtimg.cn` 文本（GBK 已由调用方按 ASCII 安全方式解出；数值字段逐字节不变）。
 *
 * 行格式：`v_sh600000="1~浦发银行~600000~9.62~9.53~...";`
 * 实测下标（0 起）：f3 现价、f4 昨收、f6 成交量(手)、f32 涨跌幅、f47 涨停价、f48 跌停价。
 */
export function parseTencentQuoteText(text: string): TencentQuote[] {
  const out: TencentQuote[] = []
  const re = /v_((?:sh|sz)\d{6})="([^"]*)"/g
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    const code = m[1] as string
    const f = (m[2] as string).split('~')
    out.push({
      code,
      price: numOf(f[3]),
      prev: numOf(f[4]),
      vol: numOf(f[6]),
      pct: numOf(f[32]),
      upLimit: numOf(f[47]),
      downLimit: numOf(f[48]),
    })
  }
  return out
}

/* ────────────────────── 11 桶 → 现有 9 档 ────────────────────── */

/**
 * 腾讯/自算用 **11 桶**（>10 / 7~10 / 5~7 / 3~5 / 0~3 / 平盘 / -3~0 / -5~-3 / -7~-5 / -10~-7 / <-10）。
 * 现有界面是 **9 档**（`DIST_LABELS`，本轮不改）：把两个**开口的边界档**并进去——
 *   `≥7%` = (>10) + (7~10)；`≤-7%` = (-7~-10) + (<-10)。
 * 其余 7 桶一一对应。11 档界面是另一张单，这里只做映射、不动档名。
 */
export const NINE_FROM_ELEVEN: readonly (readonly number[])[] = [
  [0, 1], // ≥7%
  [2], // 5~7%
  [3], // 3~5%
  [4], // 0~3%
  [5], // 平盘
  [6], // -3~0%
  [7], // -5~-3%
  [8], // -7~-5%
  [9, 10], // ≤-7%
] as const

/** 11 桶计数 → 9 档计数（合并边界两档；长度不符 ⇒ 抛错，不静默补 0） */
export function nineBucketsOf(buckets11: readonly number[]): number[] {
  if (buckets11.length !== 11) throw new Error(`11 桶计数长度应为 11，实际 ${buckets11.length}`)
  return NINE_FROM_ELEVEN.map((idx) => idx.reduce((sum, i) => sum + (buckets11[i] ?? 0), 0))
}

/* ────────────────────── 聚合（纯函数部分） ────────────────────── */

export interface BreadthAggregate {
  /** 9 档计数 */
  counts: number[]
  /** 11 桶计数（留档/自检用） */
  buckets11: number[]
  up: number
  down: number
  flat: number
  limitUp: number
  limitDown: number
  suspended: number
  /** 池内代码数 */
  codes: number
  /** 回包里出现的报价行数（停牌也有行）；停牌是它的子集 */
  quoted: number
  /** 停牌（有行但无量且平盘，或价/昨收缺失） */
  suspendedCount: number
}

const isSuspendedQuote = (q: TencentQuote): boolean => {
  const price = q.price
  const prev = q.prev
  if (price === null || prev === null || !(price > 0) || !(prev > 0)) return true
  // 收盘后仍无量且平盘 ⇒ 停牌（开盘后的真实平盘有成交量）
  return q.pct === 0 && (q.vol ?? 0) === 0
}

/** 报价行 → 11 桶 + 涨跌平 + 涨跌停 + 停牌（`quoted` 由调用方给池大小） */
export function aggregateQuotes(quotes: readonly TencentQuote[], codes: number): BreadthAggregate {
  const rows: QuoteRow[] = []
  let quoted = 0
  let suspended = 0
  let limitUp = 0
  let limitDown = 0
  for (const q of quotes) {
    // `quoted` = **回包里真的出现这一行**（停牌也有行）；停牌是它的子集，两者相差 = 参与分档的只数
    quoted += 1
    if (isSuspendedQuote(q)) {
      rows.push({ pct: null, suspended: true })
      suspended += 1
      continue
    }
    const pct = q.pct
    if (pct === null || !Number.isFinite(pct)) {
      rows.push({ pct: null, suspended: true })
      suspended += 1
      continue
    }
    if (q.upLimit !== null && q.upLimit > 0 && q.price !== null && q.price >= q.upLimit - 1e-6) limitUp += 1
    if (q.downLimit !== null && q.downLimit > 0 && q.price !== null && q.price <= q.downLimit + 1e-6) limitDown += 1
    rows.push({ pct })
  }
  const agg = aggregateOf(rows, { limitUp, limitDown })
  return {
    counts: nineBucketsOf(agg.buckets),
    buckets11: agg.buckets,
    up: agg.up,
    down: agg.down,
    flat: agg.flat,
    limitUp,
    limitDown,
    suspended,
    codes,
    quoted,
    suspendedCount: suspended,
  }
}

/* ────────────────────── 编排（网络；fetchText 注入） ────────────────────── */

/**
 * 代码池当日缓存：56 页只翻一次（实测 56 页 ≈ 12–20 s，而分布快照 60 s 一刷新 —— 不缓存等于每分打 56 页）。
 * 键 = `dayOf(now)`（R5-⑤：日期只走 `dayOf`，不许自己拿时间戳加 8 小时）。
 * 新股/退市会让池子漂移，所以缓存**只在同一天**内有效，跨日必然重翻。
 */
let codePoolCache: { day: string; codes: string[] } | null = null

/** 仅供测试：清空代码池缓存 */
export function __resetCodePoolCache(): void {
  codePoolCache = null
}

export interface TencentAggregateResult extends BreadthAggregate {
  scannedBatches: number
  totalBatches: number
  failedBatches: number[]
  warn: string | null
  asOf: number
}

export interface TencentAggregateDeps {
  fetchText: (host: string, url: string, opts?: { referer?: string }) => Promise<string>
  sleep: (ms: number) => Promise<void>
  now?: number
  /** 注入代码池（测试用；缺省翻新浪代码表） */
  pool?: readonly string[]
  /** 注入单批解析（测试用；缺省打腾讯并按 600 一批） */
  fetchBatch?: (codes: readonly string[], batch: number) => Promise<TencentQuote[]>
}

/** 腾讯聚合主流程：代码池 → 600/批 4 并发 120ms → 11 桶 → 9 档 */
export async function tencentBreadthAggregate(deps: TencentAggregateDeps): Promise<TencentAggregateResult> {
  const now = deps.now ?? Date.now()
  const day = dayOf(now)
  let pool: readonly string[]
  if (deps.pool !== undefined) {
    pool = deps.pool
  } else if (codePoolCache !== null && codePoolCache.day === day) {
    pool = codePoolCache.codes
  } else {
    const fetched = await fetchSinaCodePool(deps.fetchText, deps.sleep)
    codePoolCache = { day, codes: fetched }
    pool = fetched
  }
  if (pool.length === 0) throw new Error('代码表为空（新浪翻页未取到任何沪深代码）')
  const batches = batchesOf(pool, QT_BATCH)
  const fetchBatch = deps.fetchBatch ?? (async (codes: readonly string[]) => parseTencentQuoteText(await deps.fetchText(QT_HOST, qtBatchUrl(codes))))
  const scan = await scanBatches({ batches, fetchBatch: (codes, i) => fetchBatch(codes, i), sleep: deps.sleep })
  const agg = aggregateQuotes(scan.rows, pool.length)
  const warnParts: string[] = []
  if (scan.failedBatches.length > 0) warnParts.push(`${scan.failedBatches.length} 批失败（缺 ${scan.failedBatches.length * QT_BATCH} 只上限）`)
  if (agg.suspended > 0) warnParts.push(`${agg.suspended} 只停牌未计入各档`)
  if (agg.quoted === 0) throw new Error('腾讯报价一条都没解析出来（回包格式变了？）')
  return {
    ...agg,
    scannedBatches: batches.length - scan.failedBatches.length,
    totalBatches: batches.length,
    failedBatches: scan.failedBatches,
    warn: warnParts.length > 0 ? warnParts.join('；') : null,
    asOf: now,
  }
}
