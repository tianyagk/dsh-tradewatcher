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
  /** 每分钟成交额（东财 trends2 提供；其它源可能缺省） */
  amount?: number | null
}

export interface TrendData {
  secid: string
  /** The feed's own previous-close/settlement baseline. */
  prePrice: number | null
  points: TrendPoint[]
  /** Last point price (== today's current) when available. */
  last: number | null
  /** 该序列来自 last-known-good 时，记录快照时间（上游瞬时失败兜底） */
  staleAt?: number
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
  /** true = 上游不可用，返回的是本地缓存（数据可能不是最新） */
  stale?: boolean
}

/** ── 财经日历 ─────────────────────────────────────────────────────────── */

export type CalCategory = 'macro-intl' | 'macro-cn' | 'ipo' | 'earnings' | 'dividend' | 'other'

export const CAL_CATEGORY_LABEL: Record<CalCategory, string> = {
  'macro-intl': '国际宏观',
  'macro-cn': '国内宏观',
  ipo: 'IPO/新股',
  earnings: '财报',
  dividend: '分红',
  other: '其他',
}

/** 重要性：3=高（红）2=中（橙）1=低（灰蓝） */
export type CalImportance = 1 | 2 | 3

export interface CalEvent {
  id: string
  /** YYYY-MM-DD */
  date: string
  endDate?: string
  /** HH:mm（北京时间；宏观数据公布时刻，未知则缺省） */
  time?: string
  title: string
  category: CalCategory
  importance: CalImportance
  note?: string
  /** 关联标的（secid 或代码），可选 */
  symbol?: string
  source: 'auto' | 'manual'
  /** 自动事件的稳定去重键 */
  autoKey?: string
}

export interface CalPayload {
  events: CalEvent[]
  syncedAt: number
  /** 自动同步覆盖的标的代码（来自自选+持仓） */
  symbolCount: number
}

/** 一笔买卖（图上的 B/S 标记，来自持仓流水）。 */
export interface TradeMark {
  id: string
  ts: number
  verb: 'buy' | 'sell'
  qty: number
  price: number
  posName: string | null
  groupName: string | null
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
  /** 护盘信号监测配置 */
  rescue: RescueConfig
}

export const DEFAULT_PREFS: PortPrefs = {
  theme: 'auto',
  refreshSec: 10,
  redUp: true,
  costBasis: 'diluted',
  rescue: { enabled: true, intervalSec: 30, tailIntervalSec: 15, tailFrom: '14:30', universe: [] },
}

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

/** ── 护盘信号 ─────────────────────────────────────────────────────────────
 * 识别「符合国家队历史行为模式」的宽基 ETF 放量 + 超大单净流入。
 * 注意：汇金/国新/诚通不披露日内成交，本模块输出的是**概率性信号**，
 * 不等于证明买入方身份。所有阈值来源都在 UI 上标注（标定 / 自建样本 / 经验）。
 */

/** 核心护盘通道（按指数）：系统性护盘必须由它们体现，F2 以核心通道为主 */
export const RESCUE_CORE_INDEXES = ['沪深300', '上证50']
/** 外围通道单独净流入时的强度折扣 */
export const RESCUE_PERIPHERAL_FLOW_DISCOUNT = 0.7
/** 核心通道大额净流出阈值（超大单净额 ÷ 成交额）→ 封顶为「资金异动」 */
export const RESCUE_CORE_OUTFLOW_VETO = -0.15

/** 0 平静 · 1 资金异动 · 2 疑似护盘 · 3 强护盘信号 */
export type RescueLevel = 0 | 1 | 2 | 3

export const RESCUE_LEVEL_LABEL: Record<RescueLevel, string> = {
  0: '平静',
  1: '资金异动',
  2: '疑似护盘',
  3: '强护盘信号',
}

export const RESCUE_LEVEL_DESC: Record<RescueLevel, string> = {
  0: '宽基 ETF 量能与资金流均在常态区间',
  1: '出现放量或超大单流入，但尚不构成护盘特征',
  2: '量能放大 + 超大单净流入 + 指数承压，具备护盘特征',
  3: '多通道共振的天量买入，符合历史上国家队护盘的行为模式',
}

/** 阈值来源：calibrated = 历史分位数标定；self = 自建样本分位；empirical = 经验值 */
export type RescueThresholdSource = 'calibrated' | 'self' | 'empirical'

/** 全池共振分层：核心通道（沪深300/上证50）是否参与，决定是否算「系统性护盘」 */
export interface RescueResonance {
  /** 命中通道的指数名 */
  lanes: string[]
  core: number
  peripheral: number
  intensity: 'systemic' | 'local' | 'none'
}

/** 当前脉冲时段（锚点按时段分档） */
export interface RescuePulseBand {
  elapsed: number
  label: string
  isTail: boolean
  anchors: [number, number, number]
  /** 交易阶段：pre/am/noon/pm/tail/closed */
  phase?: 'pre' | 'am' | 'noon' | 'pm' | 'tail' | 'closed'
}

export interface RescueFactor {
  id: 'volume' | 'superflow' | 'pulse' | 'persistence' | 'divergence' | 'resonance'
  label: string
  /** 0–100 */
  score: number
  weight: number
  /** 实测值（人类可读） */
  actual: string
  /** 阈值口径说明 */
  threshold: string
  hit: boolean
}

export interface RescueEtfView {
  secid: string
  name: string
  /** 对应宽基指数（共振按指数去重） */
  index: string
  price: number | null
  pct: number | null
  /** 当日累计成交额（元） */
  amount: number | null
  /** 东财量比 */
  volRatio: number | null
  /** 同时点量能倍数 = 当日累计额 ÷ (20日均额 × 日内进度) */
  timeAdjMult: number | null
  /** 20 日均成交额（元） */
  avgAmt20: number | null
  /** 超大单净额 */
  superNet: number | null
  /** 主力净额 */
  mainNet: number | null
  /** 超大单净额 ÷ 当日成交额 */
  superShare: number | null
  /** 超大单净额 ÷ 20日均成交额 */
  superVsAvg: number | null
  /** 最近 5 分钟成交额 ÷ 同时点基准 5 分钟额 */
  pulseMult: number | null
  /** 综合活跃度 0–100（仅用于排序/着色） */
  activity: number
  /** 该通道是否自身触发 */
  triggered: boolean
  /** 资金方向：超大单占比 ≥+15% 为吸纳，≤−15% 为撤离（避免把「大额净流出」误读成哑火） */
  flowDirection?: 'in' | 'out' | 'flat' | 'unknown'
}

export interface RescueSignalEvent {
  ts: number
  /** HH:mm */
  hhmm: string
  level: RescueLevel
  score: number
  reason: string
  /** 记录该事件的引擎版本；缺失表示旧口径（评分逻辑与当前不同） */
  engine?: string
}

/** 因子可用度：数据缺失时如实标注 */
export interface RescueCompleteness {
  available: number
  total: number
  missing: string[]
}

/** 当日每 5 分钟抽样点（用于当日信号曲线回放） */
export interface RescueIntradayPoint {
  hhmm: string
  level: RescueLevel
  score: number
  timeAdjMult: number | null
  superVsAvg: number | null
  /** 窗口内超大单净增 ÷ 该窗口成交额 */
  persistShare?: number | null
}

export interface RescueConfig {
  enabled: boolean
  /** 常态采样间隔（秒） */
  intervalSec: number
  /** 尾盘采样间隔（秒） */
  tailIntervalSec: number
  /** 尾盘起始时刻 HH:mm，之后切到 tailIntervalSec */
  tailFrom: string
  /** 自定义标的池（空 = 默认核心 6 只） */
  universe: string[]
}

export interface RescueEtfMeta {
  secid: string
  name: string
  index: string
  core: boolean
}

/** 护盘通道池：核心 6 只默认开启，扩展标的可在面板里勾选 */
export const RESCUE_ETF_CATALOG: RescueEtfMeta[] = [
  { secid: '1.510300', name: '沪深300ETF华泰柏瑞', index: '沪深300', core: true },
  { secid: '1.510050', name: '上证50ETF华夏', index: '上证50', core: true },
  { secid: '1.510500', name: '中证500ETF南方', index: '中证500', core: true },
  { secid: '1.512100', name: '中证1000ETF华夏', index: '中证1000', core: true },
  { secid: '1.588000', name: '科创50ETF华夏', index: '科创50', core: true },
  { secid: '0.159915', name: '创业板ETF易方达', index: '创业板指', core: true },
  { secid: '1.510310', name: '沪深300ETF易方达', index: '沪深300', core: false },
  { secid: '1.510330', name: '沪深300ETF华夏', index: '沪深300', core: false },
  { secid: '0.159919', name: '沪深300ETF嘉实', index: '沪深300', core: false },
  { secid: '1.588080', name: '科创50ETF易方达', index: '科创50', core: false },
]

export function rescueUniverseMeta(universe: string[]): RescueEtfMeta[] {
  if (universe.length === 0) return RESCUE_ETF_CATALOG.filter((e) => e.core)
  const want = new Set(universe)
  const picked = RESCUE_ETF_CATALOG.filter((e) => want.has(e.secid))
  return picked.length > 0 ? picked : RESCUE_ETF_CATALOG.filter((e) => e.core)
}

export interface RescueSnapshot {
  ts: number
  /** 是否处于采样时段 */
  trading: boolean
  level: RescueLevel
  score: number
  /** 一句话归因 */
  summary: string
  factors: RescueFactor[]
  etfs: RescueEtfView[]
  /** 基准指数（沪深300）当日涨跌幅 */
  indexPct: number | null
  indexName: string
  /** 时点系数（0.4 早盘 ~ 1.1 尾盘，已接入评分） */
  timeCoef: number
  /** 全池共振分层 */
  resonance: RescueResonance
  /** 当前脉冲时段与锚点 */
  pulseBand: RescuePulseBand
  /** 本次快照的因子可用度 */
  completeness?: RescueCompleteness
  thresholdSource: RescueThresholdSource
  /** 自建样本天数（<20 时使用经验锚点） */
  selfSampleDays: number
  config: RescueConfig
  /** 当前生效的采样间隔（秒） */
  activeIntervalSec: number
  /** 今日信号时间线 */
  today: RescueSignalEvent[]
  /** 今日 5 分钟抽样曲线 */
  intraday: RescueIntradayPoint[]
  sampleCount: number
  lastSampleTs: number | null
  /** 是否出现采样缺口（上游失败） */
  gap: boolean
  /** 无实时数据时的说明 */
  note?: string
}

export interface RescueDaySummary {
  day: string
  maxLevel: RescueLevel
  maxScore: number
  events: number
  peakHhmm: string | null
}

export interface RescuePayload {
  snapshot: RescueSnapshot
  history: RescueDaySummary[]
}
