/**
 * 复盘行（第 8 行 `fupan`）的「持仓交易记录」：某一天的逐笔 + 汇总 + 当日盈亏（只读）。
 *
 * 非显然的几条（各配反例注入，见 `fupanTrades.test.ts`）：
 *   · 归属日 = `ts` 的**北京日**（`dayOf`；用宿主 TZ 会在 UTC 主机上串日）；
 *   · 当日盈亏**取持仓核算**（`grand.dayPnl`），逐笔重算会漏掉隔夜持仓那部分；且只对"今天"成立；
 *   · 结果是**本地读**（`em.peekQuotes`），零上游请求 ⇒ 缺价就 null + 原因，不回源凑数；
 *   · 读取失败按用户口径回"0 笔"，但 `readFailed` 仍如实留在回包里（数据层不撒谎）。
 */
import type { LedgerEntry, MissingField, PortfolioView } from '../shared/model.ts'
import * as em from './em.ts'
import { HttpError } from './http.ts'
import { assemblePortfolio } from './portfolio.ts'
import { unreadableMissing } from './readGuard.ts'
import type { DataStore } from './store.ts'
import { dayOf, hhmmOf } from './time.ts'

/** 单日返回上限（超出给 `truncated`；客户端显示「另有 N 笔未显示」） */
export const FUPAN_TRADES_MAX = 500
/** 同日结果缓存 TTL；流水落盘会立刻清掉（见 `attachFupanTradesCache`） */
export const FUPAN_TRADES_TTL_MS = 60_000
/** 缓存条数上限（随"翻过的日子"增长，必须有界） */
const FUPAN_TRADES_CACHE_MAX = 64
/** 计入交易记录的方向 */
export const FUPAN_TRADE_VERBS = ['buy', 'sell', 'adjust'] as const
export type FupanTradeVerb = (typeof FUPAN_TRADE_VERBS)[number]

/** 方向的中文字（回包同时给 `side` 与 `direction`，界面不必再维护一份映射） */
export const FUPAN_TRADE_LABEL: Record<FupanTradeVerb, string> = { buy: '买', sell: '卖', adjust: '调整' }

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

export interface FupanTradeRow {
  /** 流水 id（客户端据此跳转高亮到流水弹窗里的那一条） */
  ledgerId: string
  ts: number
  /** HH:mm（北京） */
  time: string
  name: string
  side: FupanTradeVerb
  direction: string
  qty: number | null
  price: number | null
  fee: number | null
}

export interface FupanTradeTotals {
  count: number
  buy: { count: number; qty: number }
  sell: { count: number; qty: number }
  adjust: { count: number; qty: number }
  /** 成交额（买卖两侧）；有缺价流水时为 null —— 拿"已计价那部分"当总额就是编数 */
  amount: number | null
  /** 费用合计（元）：未填按 0 计（与持仓核算同口径） */
  fees: number
  /** 缺成交价的条数（>0 ⇒ `amount` 为 null） */
  unpriced: number
}

export interface FupanTradesPayload {
  day: string
  asOf: number
  source: string
  stale: boolean
  trades: FupanTradeRow[]
  /** 该日**计入**的笔数（不受截断影响） */
  total: number
  truncated: { shown: number; total: number }
  summary: FupanTradeTotals
  /** 当日盈亏（元；直接取持仓核算值）。算不出/不是今天 ⇒ null */
  dayPnl: number | null
  dayPnlReason: string | null
  /** 流水是否本次读不到（**恒给**；为 true 时上面全是空/0 —— 界面按用户豁免不显示提示） */
  readFailed: boolean
  readFailedReason: string | null
  missing: MissingField[]
}

export const FUPAN_TRADES_SOURCE = 'local:ledger.json+portfolio'

/** 校验 `day` 查询参数（返回规范化值；不合法抛 400 —— 这是调用方的错，不是"没有交易"） */
export function parseFupanDay(raw: unknown): string {
  const day = typeof raw === 'string' ? raw.trim() : ''
  if (!DATE_RE.test(day) || Number.isNaN(Date.parse(`${day}T12:00:00+08:00`))) {
    throw new HttpError('day 应为 YYYY-MM-DD（例如 2026-10-20）', 400)
  }
  return day
}

const round2 = (n: number): number => Math.round(n * 100) / 100

/** 一条流水 → 交易记录行（缺的数量/价格/费用如实为 null，不补 0） */
function toRow(e: LedgerEntry): FupanTradeRow {
  const side = e.verb as FupanTradeVerb
  return {
    ledgerId: e.id,
    ts: e.ts,
    time: hhmmOf(e.ts),
    name: e.name ?? e.secid ?? '（未命名）',
    side,
    direction: FUPAN_TRADE_LABEL[side] ?? String(e.verb),
    qty: typeof e.qty === 'number' && Number.isFinite(e.qty) ? e.qty : null,
    price: typeof e.price === 'number' && Number.isFinite(e.price) ? e.price : null,
    fee: typeof e.fee === 'number' && Number.isFinite(e.fee) ? e.fee : null,
  }
}

const isCounted = (e: LedgerEntry): boolean => (FUPAN_TRADE_VERBS as readonly string[]).includes(e.verb)

/**
 * 某月按**北京日**分组的计入逐笔（一次遍历）。
 *
 * 这是"哪些流水算交易、算在哪一天"的**唯一**实现：逐日明细（`tradesOfDay`）与月历笔数
 * （`tradeCountsOfMonth`）都从这里取 ⇒ 两条路由不可能各算一套。
 */
function tradesByDayOfMonth(entries: readonly LedgerEntry[], ym: string): Map<string, LedgerEntry[]> {
  const out = new Map<string, LedgerEntry[]>()
  for (const e of entries) {
    if (!isCounted(e)) continue
    const day = dayOf(e.ts)
    if (!day.startsWith(`${ym}-`)) continue
    const list = out.get(day)
    if (list === undefined) out.set(day, [e])
    else list.push(e)
  }
  return out
}

/** 某月每天的交易笔数（`0`/缺键 = 那天真的没有；与"未取到"由调用方用 `null` 区分） */
export function tradeCountsOfMonth(entries: readonly LedgerEntry[], ym: string): Record<string, number> {
  const out: Record<string, number> = {}
  for (const [day, list] of tradesByDayOfMonth(entries, ym)) out[day] = list.length
  return out
}

/**
 * 该日的逐笔 + 汇总（纯函数）。汇总按**全日**统计：600 笔的日子若按 500 笔算合计，
 * 两个数字各自都"对"、合起来是错的。
 */
export function tradesOfDay(
  entries: readonly LedgerEntry[],
  day: string,
): { trades: FupanTradeRow[]; total: number; summary: FupanTradeTotals } {
  const dayEntries = (tradesByDayOfMonth(entries, day.slice(0, 7)).get(day) ?? [])
    .sort((a, b) => a.ts - b.ts || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  const summary: FupanTradeTotals = {
    count: dayEntries.length,
    buy: { count: 0, qty: 0 },
    sell: { count: 0, qty: 0 },
    adjust: { count: 0, qty: 0 },
    amount: 0,
    fees: 0,
    unpriced: 0,
  }
  let amount = 0
  let priced = 0
  for (const e of dayEntries) {
    const qty = typeof e.qty === 'number' && Number.isFinite(e.qty) ? e.qty : 0
    const verb = e.verb as FupanTradeVerb
    summary[verb].count += 1
    summary[verb].qty += qty
    if (typeof e.fee === 'number' && Number.isFinite(e.fee)) summary.fees += e.fee
    if (verb === 'adjust') continue
    if (typeof e.price === 'number' && Number.isFinite(e.price)) {
      amount += Math.abs(qty) * e.price
      priced += 1
    }
  }
  const traded = summary.buy.count + summary.sell.count
  summary.unpriced = traded - priced
  summary.fees = round2(summary.fees)
  summary.amount = summary.unpriced > 0 ? null : round2(amount)
  summary.buy.qty = round2(summary.buy.qty)
  summary.sell.qty = round2(summary.sell.qty)
  summary.adjust.qty = round2(summary.adjust.qty)
  return { trades: dayEntries.slice(0, FUPAN_TRADES_MAX).map(toRow), total: dayEntries.length, summary }
}

export interface AccountingDayPnl {
  dayPnl: number | null
  reason: string | null
}

/**
 * 当日盈亏：只读持仓核算的结果（`grand.dayPnl`）。
 *
 * 不按逐笔重算：那会漏掉隔夜持仓的 `(现价 − 昨收) × 期初数量`，与持仓页对不上。
 * 只要有一只持仓算不出（缺现价/昨收），合计就给 null —— 拿部分行相加是错的数。
 */
export function accountingDayPnl(view: Pick<PortfolioView, 'positions' | 'grand'>): AccountingDayPnl {
  // qty 为 0 但当日有成交（清仓/日内往返）的行同样参与持仓页合计 ⇒ 也要检查
  const rows = view.positions.filter((p) => p.qty > 1e-9 || p.dayPnl !== null)
  const missing = rows.filter((p) => p.dayPnl === null)
  if (missing.length > 0) {
    const names = missing.slice(0, 5).map((p) => p.name)
    const tail = missing.length > names.length ? ` 等 ${missing.length} 只` : ''
    return {
      dayPnl: null,
      reason: `${names.join('、')}${tail}的当日盈亏算不出来（缺现价或昨收）⇒ 合计不给数（不写 0）`,
    }
  }
  return { dayPnl: view.grand.dayPnl, reason: null }
}

/** 缓存与"确实构建过几次"的计数（测试用它证明缓存真的在挡重复读取） */
export const __fupanTradesStats = { builds: 0 }
/** 每个 store 一份缓存（同一个进程里可能有多个 store 实例：临时目录/测试/多 profile） */
interface CacheSlot {
  exp: number
  value: unknown
}
const caches = new WeakMap<DataStore, Map<string, CacheSlot>>()
const attached = new WeakSet<DataStore>()

function cacheOf(store: DataStore): Map<string, CacheSlot> {
  let map = caches.get(store)
  if (map === undefined) {
    map = new Map()
    caches.set(store, map)
  }
  return map
}

/** 同一个 60 秒缓存 + 同一条写路径失效（日明细与月历笔数共用；键加前缀区分） */
function cached<T>(store: DataStore, key: string, now: number, build: () => T): T {
  attachFupanTradesCache(store)
  const cache = cacheOf(store)
  const hit = cache.get(key)
  if (hit !== undefined && now < hit.exp) return hit.value as T
  const value = build()
  cache.set(key, { exp: now + FUPAN_TRADES_TTL_MS, value })
  while (cache.size > FUPAN_TRADES_CACHE_MAX) {
    const oldest = cache.keys().next()
    if (oldest.done === true) break
    cache.delete(oldest.value)
  }
  return value
}

/** 流水读不到的原因（`null` = 读到了或本来就没有）；两条口径共用同一个判据 */
function ledgerReadFailure(store: DataStore): string | null {
  return store.readFailures().find((f) => f.file === 'ledger.json')?.reason ?? null
}

/** 挂到该 store 的流水写路径上（幂等：同一个 store 只订阅一次） */
export function attachFupanTradesCache(store: DataStore): void {
  if (attached.has(store)) return
  attached.add(store)
  const map = cacheOf(store)
  store.onLedgerWrite(() => map.clear())
}

/** 测试钩子：丢掉该 store 的缓存并清零构建计数 */
export function __resetFupanTradesCache(store: DataStore): void {
  caches.get(store)?.clear()
  __fupanTradesStats.builds = 0
}

function emptyPayload(day: string, now: number): FupanTradesPayload {
  return {
    day,
    asOf: now,
    source: FUPAN_TRADES_SOURCE,
    stale: false,
    trades: [],
    total: 0,
    truncated: { shown: 0, total: 0 },
    summary: {
      count: 0,
      buy: { count: 0, qty: 0 },
      sell: { count: 0, qty: 0 },
      adjust: { count: 0, qty: 0 },
      amount: 0,
      fees: 0,
      unpriced: 0,
    },
    dayPnl: null,
    dayPnlReason: null,
    readFailed: false,
    readFailedReason: null,
    missing: [],
  }
}

/**
 * 组装一份（唯一读数据的地方；缓存未命中才走到这里）。
 * 行情只读本地槽（`em.peekQuotes`）：取不到价就让持仓核算给 null + 原因，不回源凑数。
 */
export function buildFupanTrades(store: DataStore, day: string, now = Date.now()): FupanTradesPayload {
  __fupanTradesStats.builds += 1
  const payload = emptyPayload(day, now)
  const unreadable = ledgerReadFailure(store)
  if (unreadable !== null) {
    return {
      ...payload,
      dayPnlReason: `交易流水文件读不到（${unreadable}）⇒ 逐笔与当日盈亏都不显示`,
      readFailed: true,
      readFailedReason: unreadable,
      missing: unreadableMissing([{ file: 'ledger.json', reason: unreadable }], '交易流水文件'),
    }
  }
  const entries = store.ledgerEntries()
  const { trades, total, summary } = tradesOfDay(entries, day)
  const today = dayOf(now)
  if (day !== today) {
    // 持仓核算的"当日盈亏"永远是**今天**那一天；拿它冒充历史某天就是编数
    return {
      ...payload,
      trades,
      total,
      truncated: { shown: trades.length, total },
      summary,
      dayPnlReason: `${day} 不是今天（${today}）：当日盈亏源自持仓核算，只对"今天"成立 ⇒ 该日期不给这个数（不是 0）`,
    }
  }
  const port = store.portData()
  const quotes = em.peekQuotes([...new Set(port.items.map((p) => p.secid))])
  const prefs = store.getPrefs()
  const { view } = assemblePortfolio(port.groups, port.items, entries, quotes, {
    mode: prefs.fxMode ?? 'none',
    rates: prefs.fxRates ?? {},
  })
  const pnl = accountingDayPnl(view)
  return {
    ...payload,
    trades,
    total,
    truncated: { shown: trades.length, total },
    summary,
    dayPnl: pnl.dayPnl,
    dayPnlReason: pnl.reason,
  }
}

/** 读某一天（60 秒缓存；流水落盘后由订阅清空缓存 ⇒ 立刻反映新流水） */
export function readFupanTrades(store: DataStore, day: string, now = Date.now()): FupanTradesPayload {
  return cached(store, day, now, () => buildFupanTrades(store, day, now))
}

/**
 * 某月每天的交易笔数（月历用）：一次遍历，与逐日明细**同一份**过滤/归属。
 *
 * `counts === null` = 流水读不到（**不是**"那天没有交易"）：界面据此不画 `▲n`，
 * 而不是把整月画成 0 笔。
 */
export interface FupanMonthTrades {
  counts: Record<string, number> | null
  readFailed: boolean
  readFailedReason: string | null
  missing: MissingField[]
}

export function buildFupanMonthTrades(store: DataStore, ym: string): FupanMonthTrades {
  __fupanTradesStats.builds += 1
  const unreadable = ledgerReadFailure(store)
  if (unreadable !== null) {
    return {
      counts: null,
      readFailed: true,
      readFailedReason: unreadable,
      missing: unreadableMissing([{ file: 'ledger.json', reason: unreadable }], '交易流水文件'),
    }
  }
  return { counts: tradeCountsOfMonth(store.ledgerEntries(), ym), readFailed: false, readFailedReason: null, missing: [] }
}

/** 读某月的笔数（与 `readFupanTrades` 同一个 60 秒缓存 + 同一条写路径失效） */
export function readFupanMonthTrades(store: DataStore, ym: string, now = Date.now()): FupanMonthTrades {
  return cached(store, `month:${ym}`, now, () => buildFupanMonthTrades(store, ym))
}

/** 供断言：这一天/这个月的读结果是否还在缓存里（写入后必须立刻变 false） */
export function fupanTradesCached(store: DataStore, key: string): boolean {
  return caches.get(store)?.has(key) === true
}
