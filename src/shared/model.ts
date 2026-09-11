/**
 * Shared data model for dsh-tradewatcher (host + client).
 * Pure types + constants — no runtime dependencies. TS-only constructs are
 * erased (erasable syntax) so host self-tests can run under node type-stripping.
 */

/** Eastmoney secid shape: <market>.<code> (e.g. 1.000001, 114.lhm). */
export const SECID_RE = /^\d{1,3}\.[A-Za-z0-9]+$/

/** TopBar strips: three groups of instruments. */
export const TW_ROWS = [
  {
    key: 'cn',
    label: 'A股指数',
    items: [
      { secid: '1.000001', name: '上证指数' },
      { secid: '0.399001', name: '深证成指' },
      { secid: '0.399006', name: '创业板指' },
      { secid: '1.000688', name: '科创50' },
      { secid: '1.000300', name: '沪深300' },
      { secid: '1.000905', name: '中证500' },
    ],
  },
  {
    key: 'intl',
    label: '国际市场',
    items: [
      { secid: '100.KOSPI200', name: '韩国KOSPI200' },
      { secid: '100.FCHI', name: '法国CAC40' },
      { secid: '100.FTSE', name: '英国富时100' },
      { secid: '100.SX5E', name: '欧洲斯托克50' },
      { secid: '100.SPX', name: '标普500' },
      { secid: '100.NDX', name: '纳斯达克' },
      { secid: '100.GDAXI', name: '德国DAX30' },
      { secid: '100.N225', name: '日经225' },
      { secid: '100.HSI', name: '恒生指数' },
    ],
  },
  {
    key: 'commodity',
    label: '大宗商品',
    items: [
      { secid: '114.lhm', name: '生猪主连' },
      { secid: '114.jmm', name: '焦煤主连' },
      { secid: '114.mm', name: '豆粕主连' },
      { secid: '113.rbm', name: '螺纹钢主连' },
      { secid: '112.B00Y', name: '布伦特原油当月' },
      { secid: '101.HG00Y', name: 'COMEX铜' },
      { secid: '101.SI00Y', name: 'COMEX白银' },
      { secid: '122.XAU', name: '伦敦金现' },
    ],
  },
] as const

/** Flat list used by the client's default quote watcher. */
export const TW_ALL_SECIDS: string[] = TW_ROWS.flatMap((row) =>
  (row.items as ReadonlyArray<{ secid: string }>).map((it) => it.secid),
)

/** A normalized quote item (EM f2… fields, pre-scaled by fltt=2). */
export interface QuoteRow {
  secid: string
  code: string
  name: string
  /** Current price; null when the source returned nothing usable. */
  price: number | null
  /** Day change (price − prevSettlement/prevClose semantics of the feed). */
  chg: number | null
  /** Day change percent (already in % units, e.g. 0.2 = +0.2%). */
  pct: number | null
  /** Previous close / settlement the feed reports. */
  prev: number | null
  open: number | null
  high: number | null
  low: number | null
  /** Volume (shares/lots as reported). */
  vol: number | null
  /** Turnover in CNY (or instrument currency as reported). */
  amount: number | null
  /** Breadth for A-share indices: rising / falling / flat counts. */
  up: number | null
  down: number | null
  even: number | null
  /** Feed update time (ms epoch) when reported. */
  time: number | null
}

/** One intraday point (EM trends2 row). */
export interface TrendPoint {
  /** epoch ms (parsed from "YYYY-MM-DD HH:mm"). */
  t: number
  label: string
  price: number
  avg: number | null
  vol: number | null
}

export interface TrendData {
  secid: string
  /** The feed's own previous-close/settlement baseline. */
  prePrice: number | null
  points: TrendPoint[]
  /** Last point price (== today's current) when available. */
  last: number | null
}

/** One daily bar (kline fallback). */
export interface DayBar {
  date: string
  open: number
  close: number
  high: number
  low: number
  vol: number | null
  pct: number | null
}

export interface KlineData {
  secid: string
  days: DayBar[]
}

/** A search candidate (EM suggest). */
export interface SuggestItem {
  secid: string
  code: string
  name: string
  kind: string
  market: string
}

/** Board row (industry / concept / ETF). */
export interface BoardRow {
  /** Eastmoney secid when the row maps to a quotable instrument (ETFs). */
  secid?: string
  code: string
  name: string
  pct: number | null
  chg: number | null
  price: number | null
  up: number | null
  down: number | null
  leader: string | null
  leaderPct: number | null
  /** Main capital net inflow (CNY) — boards only. */
  money: number | null
  vol: number | null
  amount: number | null
}

/** Stock/ETF detail card data. */
export interface StockDetail {
  secid: string
  code: string
  name: string
  price: number | null
  chg: number | null
  pct: number | null
  open: number | null
  high: number | null
  low: number | null
  prev: number | null
  vol: number | null
  amount: number | null
  turnover: number | null
  volumeRatio: number | null
  pe: number | null
  pb: number | null
  totalMv: number | null
  floatMv: number | null
  up: number | null
  down: number | null
}

/** Watchlist group. */
export interface WatchGroup {
  id: string
  name: string
  order: number
  archived?: boolean
  note?: string
}

export interface WatchItem {
  id: string
  groupId: string
  secid: string
  name: string
  note?: string
  createdAt: number
}

export interface WatchData {
  groups: WatchGroup[]
  items: WatchItem[]
}

/** Portfolio group. */
export interface PortGroup {
  id: string
  name: string
  order: number
  archived?: boolean
  note?: string
}

/** Position descriptor; qty/cost are DERIVED from the trade ledger. */
export interface PortItem {
  id: string
  groupId: string
  secid: string
  name: string
  note?: string
  createdAt: number
}

/** Trade/audit verbs written to the append-only ledger. */
export type LedgerVerb =
  | 'buy'
  | 'sell'
  | 'adjust'
  | 'add'
  | 'remove'
  | 'gcreate'
  | 'grename'
  | 'gdelete'
  | 'grestore'
  | 'gmove'
  | 'pnote'

export interface LedgerEntry {
  id: string
  ts: number
  actor: 'web' | 'tool'
  verb: LedgerVerb
  groupId?: string
  posId?: string
  secid?: string
  name?: string
  /** buy/sell/adjust quantity (signed semantics per verb). */
  qty?: number
  price?: number
  fee?: number
  note?: string
  meta?: Record<string, unknown>
}

export interface PortPrefs {
  theme: 'auto' | 'light' | 'dark'
  refreshSec: number
  redUp: boolean
  /** 成本口径：diluted = 摊薄成本（券商 App 默认）；average = 买入均价 */
  costBasis: 'diluted' | 'average'
}

export const DEFAULT_PREFS: PortPrefs = { theme: 'auto', refreshSec: 10, redUp: true, costBasis: 'diluted' }

/** One derived position row (accounting from ledger + live quote). */
export interface PositionRow {
  posId: string
  groupId: string
  secid: string
  name: string
  note?: string
  qty: number
  /** 买入均价（移动加权，含买入费用；卖出不影响） */
  avgCost: number
  /** 摊薄成本（券商口径）：(累计买入含费 − 累计卖出净额) ÷ 剩余数量 */
  dilutedCost: number | null
  /** Realized P&L since inception (fees included). */
  realized: number
  mv: number
  floatPnl: number
  /** Total (floating) return % — floatPnl / (avgCost × qty). */
  floatPnlPct: number | null
  /** 持仓盈亏（摊薄口径）— (price − dilutedCost) × qty，等于「均价口径浮盈 + 已实现」 */
  dilutedPnl: number | null
  dilutedPnlPct: number | null
  dayPnl: number
  /** Day return % — dayPnl / (overnight qty × prevClose + today's buy costs). */
  dayPnlPct: number | null
  price: number | null
  prev: number | null
  pct: number | null
  chg: number | null
}

/** 所属行业板块快照（个股详情抽屉用；非 A股 返回 null）。 */
export interface IndustryInfo {
  name: string
  pct: number | null
}

export interface GroupView {
  id: string
  name: string
  order: number
  archived?: boolean
  note?: string
  totalMv: number
  floatPnl: number
  /** 摊薄口径的持仓盈亏合计（= floatPnl + realized） */
  dilutedPnl: number
  dayPnl: number
  realized: number
  count: number
}

export interface PortfolioView {
  generatedAt: number
  groups: GroupView[]
  positions: PositionRow[]
  grand: { totalMv: number; floatPnl: number; dilutedPnl: number; dayPnl: number; realized: number }
}

/** One visible history row (verb display + payload). */
export interface LedgerView {
  id: string
  ts: number
  verb: LedgerVerb
  groupName: string | null
  posName: string | null
  qty?: number
  price?: number
  fee?: number
  note?: string
  actor: 'web' | 'tool'
}

/** Route payload envelopes (client -> host). */
export interface MutateWatchBody {
  op:
    | 'addGroup'
    | 'renameGroup'
    | 'noteGroup'
    | 'archiveGroup'
    | 'restoreGroup'
    | 'addItem'
    | 'editItem'
    | 'removeItem'
    | 'moveItem'
  groupId?: string
  itemId?: string
  name?: string
  note?: string
  secid?: string
  symbolName?: string
  order?: number
}

export interface MutatePortBody {
  op:
    | 'addGroup'
    | 'renameGroup'
    | 'noteGroup'
    | 'archiveGroup'
    | 'restoreGroup'
    | 'addPos'
    | 'editPos'
    | 'removePos'
    | 'buy'
    | 'sell'
    | 'adjust'
  groupId?: string
  posId?: string
  name?: string
  note?: string
  secid?: string
  symbolName?: string
  qty?: number
  price?: number
  fee?: number
  ts?: number
}

/** Actor header used by mutations coming from the model tools. */
export const ACTOR_TOOL = 'tool' as const
export const ACTOR_WEB = 'web' as const

/** Reject unreasonable numeric inputs (server-side guard). */
export function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v)
}
