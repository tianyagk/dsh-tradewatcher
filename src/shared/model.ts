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
  /** 数据来源（见 QuoteSource）：em（东财，默认）或备用源 */
  source?: QuoteSource
  /** 该行的成交额是否来自备用源（字段级混源时标注，价格与成交额快照时刻可能不同） */
  amountSource?: QuoteSource
  /**
   * 这一行价格被**实际观测到**的时刻（epoch ms；来自 last-known-good 时是它的原始观测时刻）。
   * 与 `time`（上游自报的行情时间）不同：`at` 描述"我们何时拿到这个数"，
   * 供 `/quotes` 的 `asOf`/`stale` 与界面标注使用。
   */
  at?: number
  /**
   * 总市值（元）。来源覆盖：东财 `f20`（全部标的）、腾讯 `f45`（沪/深/港股）。
   * **新浪备用源不提供市值**（其 `int_/nf_/hf_` 行情里没有该字段），
   * 因此国际指数/商品/期货经新浪兜底时该值为空 —— 按市值排序时它们沉底（见 client/sort.ts）。
   */
  totalMv?: number | null
  /** 流通市值（元）：东财 `f21`、腾讯 `f44`。 */
  floatMv?: number | null
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
  /**
   * true = 直接吃本地缓存、**没有回源**：休市且快照已越过最近一次收盘，
   * 当天的分时/五日序列不会再变（数据是确定的，不是降级）。
   */
  cached?: boolean
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

/**
 * 复权口径（编号与东财 `fqt` 一致）：0=不复权 1=前复权 2=后复权。
 *
 * 只有股票 / ETF / 基金 / 港美股有除权除息，才谈得上复权；指数是点位回报、
 * 期货是合约价格、板块是成分股统计，强行复权等于伪造趋势 —— 这些标的
 * 一律回落 `0` 并把 `fqSupported` 标成 false（见 host/em.ts 的 `fqSupported`）。
 */
export type FqMode = 0 | 1 | 2

export const FQ_LABEL: Record<FqMode, string> = { 0: '不复权', 1: '前复权', 2: '后复权' }

export interface KlineData {
  secid: string
  days: DayBar[]
  /** true = 上游不可用，返回的是本地缓存（数据可能不是最新） */
  stale?: boolean
  /**
   * true = 休市定稿，直接吃本地磁盘缓存、**没有回源**（与 stale 语义不同：
   * 数据是完整的收盘序列，只是不需要再问上游要）。
   */
  cached?: boolean
  /**
   * 本次数据**实际**使用的复权口径（不适用复权时恒为 0，哪怕请求里写了 1）。
   * 界面必须用这个值显示口径，而不是用自己请求的那个值。
   */
  fqt?: FqMode
  /** false = 该标的没有除权除息概念，界面上的复权开关应禁用并说明原因 */
  fqSupported?: boolean
  /**
   * 本地最近一次成功取数（或落盘）的时刻（epoch ms）。口径条显示"数据截至 …"用的就是它
   * —— **不是**最后一根 bar 自己的时间：未收盘的那根 bar 在上游没有收盘时间，
   * 拿"现在"顶替会把"我什么时候拿的"说成"这根什么时候收的"。
   */
  asOf?: number
  /**
   * 最后一根 bar 是否**尚未收盘**（上游仍在更新它）。
   * 该值为 true 时 MA/指标都含这一根，口径条必须写明（否则"MA 是不是含今天"要靠猜）。
   */
  barOpen?: boolean
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

/**
 * 自动事件的一次改期/改名记录（P1-10）。
 *
 * 来源方（东财）会悄悄改期：新股上市日延后、财报预约披露日调整、分红除权日变动。
 * 只显示"最新日期"会让人以为一直是这个日期 —— 于是"我按 10-09 准备的，怎么变成 10-16 了"
 * 无人能回答。因此保留 from→to 的历史，并在事件上标「可能变更」。
 */
export interface CalChange {
  /** 发现时刻（epoch ms） */
  at: number
  field: 'date' | 'endDate' | 'title'
  from: string
  to: string
}

/** 事件与持仓/自选的勾稽关系（P1-10） */
export interface CalLink {
  /** 该标的当前有持仓 */
  held: boolean
  /** 该标的在自选里（未持仓） */
  watched: boolean
}

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
  /** 历次改期/改名（最新在后，最多保留 5 条）；非空即表示"这个日期变过" */
  changes?: CalChange[]
  /** 与持仓/自选的勾稽（由宿主按当前持仓与自选计算，不落盘） */
  link?: CalLink
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
  /**
   * 是否有**备用源**（腾讯/新浪）能取到该标的的行情。
   * false = 只有东财一条链路（如部分商品指数、美股、国际指数的大部分），
   * 东财被限流期间该标的必然空行 —— 界面据此标注"仅东财源"，避免加进自选后以为是 bug。
   */
  hasFallback?: boolean
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
  /** 换手率（%），ETF 排行使用 */
  turnover?: number | null
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

/**
 * 列表排序的**契约**（键名与允许值属于 prefs 的一部分，因此放 shared）：
 * 客户端 UI 文案/比较器在 client/sort.ts，主机侧校验用这里的键表。
 */
export type WatchSortKey = 'default' | 'pct' | 'mv'
export type PortSortKey = 'default' | 'mv' | 'pnl' | 'dayPnl' | 'weight'

export interface SortState<K extends string> {
  key: K
  /** true = 降序（大→小） */
  desc: boolean
}

export const WATCH_SORT_KEYS: readonly WatchSortKey[] = ['default', 'pct', 'mv']
export const PORT_SORT_KEYS: readonly PortSortKey[] = ['default', 'mv', 'pnl', 'dayPnl', 'weight']

/**
 * 视图密度档位（P0-8，对标"一键摸鱼"）。
 * `full` = 完整（含说明文字与脚注）；`compact` = 去掉说明文字/脚注；
 * `incognito` = 金额模糊（`¥••••`）+ 涨跌色转灰阶。
 * **只影响显示**：取数、告警与 agent 工具返回不受影响。
 */
export type ViewMode = 'full' | 'compact' | 'incognito'

export const VIEW_MODES: readonly ViewMode[] = ['full', 'compact', 'incognito']
export const VIEW_MODE_LABEL: Record<ViewMode, string> = { full: '完整', compact: '紧凑', incognito: '隐身' }

/**
 * 面板不透明度的取值范围（P2-2）。下限 0.35 是"还能看出这是块面板"的经验底线：
 * 再低就和桌面混在一起、连区域边界都认不出来，反而不好用。
 */
export const PANEL_OPACITY_MIN = 0.35
export const PANEL_OPACITY_MAX = 1

/**
 * 面板不透明度归一化（纯函数，可单测）。
 * 非法值**回退到 1（完全不透明）**而不是回退到下限：
 * 一个坏偏好不该把面板变得看不清 —— 不可读比不透明更糟。
 */
export function normalizePanelOpacity(v: unknown, fallback = 1): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return fallback
  const clamped = Math.min(PANEL_OPACITY_MAX, Math.max(PANEL_OPACITY_MIN, v))
  return Math.round(clamped * 100) / 100
}

export interface PortPrefs {
  theme: 'auto' | 'light' | 'dark'
  refreshSec: number
  redUp: boolean
  /** 成本口径：diluted = 摊薄成本（券商 App 默认）；average = 买入均价 */
  costBasis: 'diluted' | 'average'
  /** 自选页排序（分组内生效）：默认顺序 / 当日涨跌 / 总市值 */
  watchSort: SortState<WatchSortKey>
  /** 持仓页排序（分组内生效）：默认顺序 / 市值 / 盈亏 / 当日盈亏 / 仓位占比 */
  portSort: SortState<PortSortKey>
  /** 护盘信号监测配置 */
  rescue: RescueConfig
  /** 视图档位（P0-8）：Alt+M 轮换，持久化 */
  viewMode?: ViewMode
  /**
   * 面板不透明度（P2-2）：0.35–1，供截图/录屏时让面板不抢画面。
   * 只作用于**本插件面板**（`.tw-root`），不影响宿主其余界面。
   */
  panelOpacity?: number
  /**
   * 数字模糊（P2-2）：把价格/盈亏/成交额等**数字**糊住（hover 所在行/卡时显形），
   * 用于截图或录屏时不泄露具体数值。只影响显示，取数与工具返回不受影响。
   */
  blurDigits?: boolean
  /**
   * 跨市场折算口径（P1-11）。缺省 `none`（只含 A股 + 逐项说明）；
   * `fixed` 用 `fxRates` 里的用户设定汇率折算；`live` 源未验证，宿主会拒绝并说明。
   */
  fxMode?: FxMode
  /** 固定汇率表（1 外币 = N 人民币），仅 fxMode='fixed' 时生效 */
  fxRates?: FxRates
}

export const DEFAULT_PREFS: PortPrefs = {
  theme: 'auto',
  refreshSec: 10,
  redUp: true,
  costBasis: 'diluted',
  watchSort: { key: 'default', desc: true },
  portSort: { key: 'default', desc: true },
  rescue: { enabled: true, intervalSec: 30, tailIntervalSec: 15, tailFrom: '14:30', universe: [] },
  viewMode: 'full',
  panelOpacity: 1,
  blurDigits: false,
  fxMode: 'none',
  fxRates: {},
}

/**
 * 持仓相关的公司行为提示（P2-4，除权除息日）。
 *
 * 来源是日历里**已同步**的分红除权事件（`autoKey` 前缀 `div:`），因此不新增数据源。
 * 本插件**不自动改账**：送转/派息的实际到账数量与金额以券商为准，自动改会把用户唯一的
 * 交易记录改成一个"看起来对但没人能核对"的状态。
 */
export interface CorporateAction {
  posId: string
  secid: string
  name: string
  /** YYYY-MM-DD */
  date: string
  kind: 'ex' | 'record'
  /** 方案摘要（来自数据源 note） */
  note: string
  /** 距今天数（负=已过） */
  daysUntil: number
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
  /**
   * 可用（可卖）数量（P1-5）。A股 T+1：今日买入的部分当日不可卖；
   * ETF/LOF/港股/美股为 T+0，可用 = 持仓。
   */
  availableQty: number
  /** 该标的是否 T+0（决定 availableQty 的口径，界面据此给出说明） */
  t0: boolean
  /** 累计费用（佣金/手续费，买卖双向，来自流水） */
  fees: number
  /** 累计成交额（|数量×价格| 双向合计） */
  turnover: number
  /** 费用占成交额比例（%）；成交额为 0 时为 null */
  feeShare: number | null
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
  /** 跨市场折算口径（P0-1/P1-11）：none = 总额只含 A股；fixed = 按 fxRates 折算后计入 */
  fxMode?: FxMode
  /** 实际生效的固定汇率表（仅 fxMode='fixed' 时非空）—— 界面与工具据此说明"按什么汇率算的" */
  fxRates?: FxRates
  /** 未计入总额的持仓及原因（P0-1）：总额缺一块必须能点开看到缺的谁 */
  unpriced?: Array<{ posId: string; secid: string; name: string; qty: number; why: 'no-quote' | 'no-fx'; note: string }>
  /** 港美股市值未折算的部分（元，按原币种计价就不存在"折算"这回事，故只在 fxMode=none 时给出） */
  unpricedMv?: number
}

/**
 * 跨市场（港股/美股）市值折算口径。
 * `none` = 不折算：总额**只含 A股**，并在界面与工具里显式标注"不含港股市值"，
 * 绝不按 1:1 悄悄加进去（那会让总额看起来完整、其实是错的数）。
 * `fixed` = 用户设定的固定汇率（离线可用、口径完全透明）；
 * `live` = 实时汇率源 —— **源尚未验证**，宿主拒绝该档并说明原因（不猜符号）。
 */
export type FxMode = 'none' | 'fixed' | 'live'

/** 需要在总额里折算的币种（按 secid 市场号推导；国际指数/期货没有可折算的币种） */
export type FxCurrency = 'HKD' | 'USD'

export const FX_CURRENCIES: readonly FxCurrency[] = ['HKD', 'USD']
export const FX_CURRENCY_LABEL: Record<FxCurrency, string> = { HKD: '港元', USD: '美元' }

/**
 * 固定汇率表：`1 单位外币 = N 人民币`。用户自填，因此口径与出处完全透明
 * —— "这个人民币数字是按什么汇率算的"必须答得上来。
 */
export type FxRates = Partial<Record<FxCurrency, number>>

/** 市场 → 币种（不列出的市场视为"无对应币种"，即无法折算） */
export function fxCurrencyOf(market: ReturnType<typeof marketOf>): FxCurrency | null {
  if (market === 'hk') return 'HKD'
  if (market === 'us') return 'USD'
  return null
}

/** 汇率归一化：只接受合理区间内的正数（0.01–100），超出几乎一定是填错数量级（7.15 写成 715） */
export function normalizeFxRate(v: unknown): number | undefined {
  if (typeof v !== 'number' || !Number.isFinite(v)) return undefined
  if (v < 0.01 || v > 100) return undefined
  return Math.round(v * 1e6) / 1e6
}

export function normalizeFxRates(raw: unknown): FxRates {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const out: FxRates = {}
  for (const c of FX_CURRENCIES) {
    const v = normalizeFxRate((raw as Record<string, unknown>)[c])
    if (v !== undefined) out[c] = v
  }
  return out
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

/**
 * secid 所属市场。东财 secid 的市场号是**前缀**（`1.` 沪 / `0.` 深 / `116.` 港 /
 * `105|106|107.` 美 / `100.` 国际指数 / `101|112|113|114|122.` 期货与商品）。
 * 跨市场折算（P0-1 的 unpriced/fxMode）与"当日涨跌按哪个市场的日历"都依赖它，
 * 因此放在 shared —— 宿主与客户端必须用同一份判定。
 */
export type Market = 'cn' | 'hk' | 'us' | 'intl' | 'futures' | 'unknown'

const MARKET_BY_PREFIX: Record<string, Market> = {
  '1': 'cn',
  '0': 'cn',
  '116': 'hk',
  '105': 'us',
  '106': 'us',
  '107': 'us',
  '100': 'intl',
  '101': 'futures',
  '112': 'futures',
  '113': 'futures',
  '114': 'futures',
  '122': 'futures',
}

export function marketOf(secid: string): Market {
  const dot = secid.indexOf('.')
  if (dot <= 0) return 'unknown'
  return MARKET_BY_PREFIX[secid.slice(0, dot)] ?? 'unknown'
}

/** Reject unreasonable numeric inputs (server-side guard). */
export function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v)
}

/**
 * 行情数据来源的**唯一真源**。此前 api.ts 与 MarketPage.tsx 各自重抄了一份联合类型，
 * 于是"改一边忘另一边"不会变成编译错误（门禁抓不到）——两侧都必须引用本类型。
 */
export type QuoteSource = 'em' | 'tencent' | 'sina' | 'lkg'

/** ── 数据出处契约（P0-1）───────────────────────────────────────────────── */

/**
 * 读工具共用的「数据出处」契约。
 *
 * 每一个被 agent 读到的数都必须能回答：这是几点（`asOf`）、什么源（`source`）、
 * 可不可信（`stale`）、拿不到什么（`missing[]`）。
 *
 * 两个易混字段的口径（必须同时存在，不可互相顶替）：
 *   - `stale`：降级复用 —— 上游这次没给/给了旧值，我们退回 last-known-good；
 *   - `cached`：休市定稿 —— 数据本身是收盘定稿序列，**根本没有回源**（不是降级）。
 */
export interface DataProvenance {
  /** 数据被真实观测到的时刻（epoch ms）；一次都没观测到时是 null（不是"刚刚"） */
  asOf: number | null
  /** 至少一项是兜底值或已过期（与 cached 语义不同，见上） */
  stale: boolean
  /** 不新鲜的项数（0 时 stale 必为 false） */
  staleCount?: number
  /**
   * 本次主要数据来源。`local` = 纯本地文件（watch.json/positions.json/ledger.json，
   * 不经任何上游）；`mixed` = 多源混用（明细见 `sources`）；`none` = 一个源都没给出数据。
   */
  source: QuoteSource | 'local' | 'mixed' | 'none'
  /** 按来源计数，如 { em: 18, tencent: 4 } */
  sources?: Record<string, number>
  /**
   * 拿不到的项及其原因。每条必须能回答"是上游没有这份数据，还是这次暂时失败"——
   * 这两件事对 agent 的下一步动作完全不同（前者改口径，后者等重试）。
   */
  missing: MissingField[]
  /** 休市定稿零回源（与 stale 并存：定稿同时某项可能又是兜底值） */
  cached?: boolean
}

export interface MissingField {
  /** 缺失的对象：标的代码 / 字段名 / 模块名 */
  what: string
  /**
   * 缺失原因。必须是这两类之一，不许含糊：
   *   - `no-source`：上游根本没有这份数据（如新浪源不提供市值、腾讯源不提供分单资金流）；
   *   - `transient`：这次请求失败/超时，稍后重试可能拿到。
   */
  why: 'no-source' | 'transient'
  /** 人类可读的说明（含"多久能补"之类可操作信息） */
  note: string
}

/** 日线（轻量，用于位置/概率计算） */
export interface DailyBarLite {
  date: string
  open: number
  close: number
  high: number
  low: number
  vol: number
}

/** 位置特征 */
export interface BottomPosition {
  drawdown60: number | null
  drawdown250: number | null
  aboveLow60: number | null
  percentile60: number | null
  downStreak: number
  atNewLow60: boolean
}

/** 日内形态特征 */
export interface BottomPattern {
  bouncePct: number | null
  lowerShadow: number | null
  /** 当日最低点出现的时间戳（供界面显示 HH:mm） */
  lowAtTs: number | null
  reclaimedPrevLow: boolean
  newLowReclaimed: boolean
}

/** 底部概率（历史频率口径） */
export interface BottomCalibrationView {
  rule: string
  n: number
  baseN: number
  lanes: number
  /**
   * 多个目标涨幅下的概率与基线（避免只看一个阈值）。
   * v0.25.0（P1-9）补上 Wilson 95% 区间：`20 个样本的 80%` 与 `500 个样本的 80%`
   * 不是一回事，只给点估计会被读成"准确率"。
   */
  targets: Array<{
    targetPct: number
    prob: number | null
    baseRate: number | null
    /** 同类样本的 95% 区间（0–1）；样本为 0 时为 null */
    probLo?: number | null
    probHi?: number | null
    /** 无条件基线的 95% 区间（0–1） */
    baseLo?: number | null
    baseHi?: number | null
  }>
  /** 样本不足（n < 30）：界面必须标「样本少」，此时区间宽到无法支撑结论 */
  sampleSmall?: boolean
  /** 基线样本是否也不足 */
  baseSampleSmall?: boolean
  medianForward: number | null
  medianDrawdown: number | null
  horizon: number
}

/** 单通道底部视图 */
export interface RescueBottomLane {
  secid: string
  name: string
  price: number | null
  position: BottomPosition
  pattern: BottomPattern
  volumeRatio: number | null
  positionScore: number
  patternScore: number
  calibration: BottomCalibrationView
}

export interface RescueBottomView {
  lanes: RescueBottomLane[]
  /** 概率口径说明（含类比规则与样本量） */
  model: string
  asOf: string
  /**
   * 本次展示的是**上一次成功计算的结果**（日线/校准样本暂时拿不到时的保留视图）。
   * 为 true 时界面必须标明"非本次计算"，避免当成实时结论。
   */
  stale?: boolean
  /** 保留视图的原始计算时刻（epoch ms） */
  computedAt?: number
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
  /** 复盘数据（上游不可用时的当日峰值）而非实时快照 */
  provisional?: boolean
  /** 当日开/高/低（底部形态计算与展示用） */
  open?: number | null
  high?: number | null
  low?: number | null
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

/** 自定义监测通道（通常为某板块 ETF）；仅作展示与量能/脉冲观察，不计入护盘评分 */
export interface RescueCustomChannel {
  secid: string
  name: string
  /** 备注/板块名，缺省显示「自定义」 */
  index?: string
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
  /** 用户添加的自定义通道（板块 ETF 等），不计入护盘评分 */
  custom?: RescueCustomChannel[]
}

export interface RescueEtfMeta {
  secid: string
  name: string
  index: string
  core: boolean
  /** core = 沪深300/上证50；peripheral = 其他宽基；custom = 用户添加（不计入评分） */
  group: 'core' | 'peripheral' | 'custom'
}

/** 护盘通道池：核心 6 只默认开启，扩展标的可在面板里勾选 */
export const RESCUE_ETF_CATALOG: RescueEtfMeta[] = [
  { secid: '1.510300', name: '沪深300ETF华泰柏瑞', index: '沪深300', core: true, group: 'core' },
  { secid: '1.510050', name: '上证50ETF华夏', index: '上证50', core: true, group: 'core' },
  { secid: '1.510500', name: '中证500ETF南方', index: '中证500', core: true, group: 'peripheral' },
  { secid: '1.512100', name: '中证1000ETF华夏', index: '中证1000', core: true, group: 'peripheral' },
  { secid: '1.588000', name: '科创50ETF华夏', index: '科创50', core: true, group: 'peripheral' },
  { secid: '0.159915', name: '创业板ETF易方达', index: '创业板指', core: true, group: 'peripheral' },
  { secid: '1.510310', name: '沪深300ETF易方达', index: '沪深300', core: false, group: 'core' },
  { secid: '1.510330', name: '沪深300ETF华夏', index: '沪深300', core: false, group: 'core' },
  { secid: '0.159919', name: '沪深300ETF嘉实', index: '沪深300', core: false, group: 'core' },
  { secid: '1.588080', name: '科创50ETF易方达', index: '科创50', core: false, group: 'peripheral' },
]

/**
 * 监测通道 = 选中的宽基（参与护盘评分） + 用户自定义通道（仅展示，不计入评分）。
 * 自定义通道通常是板块 ETF（半导体、券商、医药…），与「国家队托底」不是一回事，
 * 混进评分会污染共振与量能口径，因此严格隔离。
 */
export function rescueUniverseMeta(universe: string[], custom: RescueCustomChannel[] = []): RescueEtfMeta[] {
  const picked = universe.length === 0
    ? RESCUE_ETF_CATALOG.filter((e) => e.core)
    : RESCUE_ETF_CATALOG.filter((e) => universe.includes(e.secid))
  const broad = picked.length > 0 ? picked : RESCUE_ETF_CATALOG.filter((e) => e.core)
  const extra: RescueEtfMeta[] = custom
    .filter((c) => !broad.some((b) => b.secid === c.secid))
    .map((c) => ({ secid: c.secid, name: c.name, index: c.index ?? '自定义', core: false, group: 'custom' as const }))
  return [...broad, ...extra]
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
  /** 快照数据来源：em = 含分单资金流；tencent = 仅量能与价格（备用源） */
  flowSource?: 'em' | 'tencent'
  /** 底部位置 / 形态 / 概率（核心通道 + 最强通道） */
  bottom?: RescueBottomView
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
  /**
   * 最近一次**采样失败**的时刻（epoch ms）。
   * 与 `ts`/`lastSampleTs` 严格分开：失败不得改写"数据时刻"，否则界面会把
   * 「刚刚试图采样但失败了」显示成「刚刚拿到了数据」。
   */
  lastFailTs?: number | null
  /** 是否出现采样缺口（上游失败） */
  gap: boolean
  /** 本快照是否来自 last-known-good（上游暂不可用时的旧数据） */
  stale?: boolean
  /** 上游不可用时的当日复盘兜底数据 */
  fallback?: {
    day: string
    peaks: Array<{ secid: string; name: string; index: string; peakSuperVsAvg: number | null }>
    note?: string
  }
  /** 无实时数据时的说明 */
  note?: string
  /**
   * 采样窗口（P0-1/P0-4）。非采样时段分数位显示 `—` 并旁注「采样暂停 · 下次 …」，
   * 而不是让人以为"坏了"；`sampling` 为 false 时 `gap` 只反映当日真实失败。
   */
  activeWindow?: RescueActiveWindow
  /** 阈值标定日期（P0-1）：YYYY-MM-DD，供阈值漂移回溯（分差从哪天开始偏） */
  calibratedAt?: string
  /** 因子对总分的贡献度（P0-7）：权 × 因子分，求和应等于 总分 ÷ 时点系数 */
  factorContrib?: Array<{ id: RescueFactor['id']; label: string; weight: number; score: number; contribution: number }>
}

/** 护盘采样窗口状态（非活跃时段必须显式说明"暂停"而不是沉默） */
export interface RescueActiveWindow {
  /** 当前是否在采样时段内 */
  sampling: boolean
  /** 不在采样时段时的原因 */
  reason?: 'closed' | 'weekend' | 'noon-break' | 'disabled'
  /** 下次采样时刻（epoch ms）；已收盘时为下一交易日开盘，disabled 时为 null */
  nextAt: number | null
  /** 下次采样时刻的人类可读说明，如「10-09 09:25」 */
  nextLabel: string | null
  /** 当前生效采样间隔（秒） */
  intervalSec: number
  /** 当日已采样次数 */
  samples: number
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
