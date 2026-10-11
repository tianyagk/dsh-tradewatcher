/**
 * Shared data model for dsh-tradewatcher (host + client).
 * Pure types + constants — no runtime dependencies. TS-only constructs are
 * erased (erasable syntax) so host self-tests can run under node type-stripping.
 */

/** Eastmoney secid shape: <market>.<code> (e.g. 1.000001, 114.lhm). */
export const SECID_RE = /^\d{1,3}\.[A-Za-z0-9]+$/

/** TopBar strips: three groups of instruments. */
/** 卡片类型：`yield`＝收益率（上行＝债券价格下跌），`price`＝价格/指数 */
export type StripItemKind = 'yield' | 'price'

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
    // 国债：中国可用（价格指数）；美/日/德/英是**收益率**（当前上游不可达 ⇒ 如实 — + 原因，绝不用代理）
    key: 'bond',
    label: '国债',
    items: [
      { secid: '1.000012', name: '中国国债', kind: 'price' },
      { secid: '171.US10Y', name: '美国10Y', kind: 'yield' },
      { secid: '171.JP10Y', name: '日本10Y', kind: 'yield' },
      { secid: '171.DE10Y', name: '德国10Y', kind: 'yield' },
      { secid: '171.GB10Y', name: '英国10Y', kind: 'yield' },
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

/**
 * 卡片类型（国债组显式标 `kind`；其余按 secid 习惯判定）。
 * `171.*` 是**收益率**（上行＝债券价格下跌），必须标类型，否则同屏"中国涨、美国跌"无法解释。
 */
/**
 * 单条市值占总市值的**分数**（0.25 = 25%）—— 客户端仓位占比/排序共用这一份。
 *
 * ⚠ 单位是**分数不是百分比**（客户端既有调用与测试都按分数）：
 * 组合构成那边要的是百分比，用 `composition.ts` 的 `weightPctOf`，**别把两处混用**。
 * 缺失或总市值 ≤0 ⇒ `null`（界面 `—`），不用 0 顶替 —— 0 会让"没取到价"与"真的一文不值"看起来一样。
 */
export function weightOf(mv: number | null | undefined, totalMv: number): number | null {
  if (mv === null || mv === undefined || !Number.isFinite(mv) || !(totalMv > 0)) return null
  return mv / totalMv
}

export function stripKindOf(secid: string): StripItemKind {
  for (const row of TW_ROWS) {
    for (const it of row.items) {
      if (it.secid === secid && 'kind' in it) return (it as { kind?: StripItemKind }).kind ?? 'price'
    }
  }
  return secid.startsWith('171.') ? 'yield' : 'price'
}

/**
 * 按**组 key**（不是位置！）取一组预设标的的 secid。
 *
 * ⚠ v0.40.0 插入「国债」组后 `TW_ROWS` 顺序变成 `cn/intl/bond/commodity`，
 * 而工具侧当时是按**位置**取（`TW_ROWS[2]`）⇒ `commodity` 预设静默返回国债指数、`all` 漏掉全部商品
 * （有价、有出处、看着完全正常的**静默错答**）。这里改成按 key 查，找不到就是空数组（不猜）。
 */
export function twGroupSecids(key: string): string[] {
  const row = TW_ROWS.find((r) => r.key === key)
  return row === undefined ? [] : row.items.map((i) => i.secid)
}

/** 全部预设标的（顺序＝ `TW_ROWS` 的组顺序） */
export function twAllSecids(): string[] {
  return TW_ROWS.flatMap((r) => r.items.map((i) => i.secid))
}

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

 // 分时序列的缺失值归一（图表 bug 的根因修复）：**缺失不许编码成 0**。
export function normalizeTrendSeries(points: readonly TrendPoint[]): TrendPoint[] {
  const hasVol = points.some((p) => typeof p.vol === 'number' && p.vol > 0)
  const hasAmount = points.some((p) => typeof p.amount === 'number' && p.amount > 0)
  /**
   * 均价必须落在**当日价格区间内**：VWAP 不可能跑到最低价之下/最高价之上（±2% 容差是因为
   * 采样点未必覆盖真实极值）。判据是**数据自证**，不依赖字段含义 —— 实测 A股指数分时里那个
   * `avg` 字段量纲完全不同（上证指数价格 ~3755–3824 而 avg ~15），放它进纵轴域会把价格线压成平线。
   * **逐点判**：同一条序列里可能一部分点越界、一部分正常（外盘商品就是那样）。
   * ⚠ 客户端另有一份同规则实现（`client/trendView.ts` 的 `plausibleAvgs`）——宿主不能反向依赖客户端，
   * 且跑着的宿主可能是旧构建，所以两边都要有。
   */
  const prices = points.map((p) => p.price).filter((v) => typeof v === 'number' && Number.isFinite(v))
  const avgMin = prices.length > 0 ? Math.min(...prices) * 0.98 : null
  const avgMax = prices.length > 0 ? Math.max(...prices) * 1.02 : null
  return points.map((p) => ({
    ...p,
    avg: typeof p.avg === 'number' && p.avg > 0
      && (avgMin === null || avgMax === null || (p.avg >= avgMin && p.avg <= avgMax))
      ? p.avg
      : null,
    vol: hasVol ? (typeof p.vol === 'number' ? p.vol : null) : null,
    amount: hasAmount ? (typeof p.amount === 'number' ? p.amount : null) : null,
  }))
}

/**
 * 分时点覆盖了几个交易日（按标签前 10 位 `YYYY-MM-DD` 去重）。
 *
 * 用途：`五日` 档靠"多日分钟点"拼图 —— 但很多市场（国际指数/外盘商品/恒生）的分钟源
 * 只有当日，于是五日会静默退化成当日。界面据此**明说**"该市场只有当日分时"。
 */
export function trendDayCount(points: readonly { label: string }[]): number {
  const days = new Set<string>()
  for (const p of points) days.add(p.label.slice(0, 10))
  return days.size
}

/** 多日分时的覆盖报告（本地拼接用）：有哪几天、缺哪几天、请求几天 */
export interface TrendCoverage {
  /** 实际有数据（且够 2 个点）的交易日，升序 */
  have: string[]
  /** 窗口内工作日里没有数据的日子（升序）。没有交易日历 ⇒ 法定假日也会落在这里，如实列出不猜 */
  missing: string[]
  /** 请求的天数（分母）：界面显示"3/5 天" */
  limit: number
}

/** 本次归档的结果（只在真的有"没写成功"时出现在回包里，界面据此说明"本次未归档"） */
export interface TrendArchiveInfo {
  saved: string[]
  skipped: Array<{ day: string; reason: string }>
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
   * 这份序列自己的**交易日**（最后一个点所属的 `YYYY-MM-DD`）。
   *
   * 兜底回 LKG 时必须带上：界面要能写「显示上次成功数据（10-08 15:00）」——
   * 否则用户会以为图上是今天的行情（实测正是这个坑：09:38 还显示 10-08 的整场）。
   */
  sessionDay?: string
  /**
   * `'local-stitch'` = 多日序列是**本地归档拼接**出来的（不是真实多日源），
   * 覆盖情况见 `coverage`；缺省表示来自上游（东财/腾讯/新浪）。
   * 界面对两者必须给出不同说明：拼接是"从本版起累积"，不是"上游给了五日"。
   */
  source?: 'local-stitch'
  /** 拼接的覆盖报告（`source === 'local-stitch'` 时给出） */
  coverage?: TrendCoverage
  /** 本次归档：有 `skipped` 时界面要说明"本次未归档"（体积保护/写失败都算） */
  archive?: TrendArchiveInfo
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

/** ── 年初至今（YTD）────────────────────────────────────────────────────── */

/**
 * YTD 的口径**写死在这里**（界面 tooltip 与 agent 工具都引用同一句，不许各写一套）：
 *
 *   YTD = (现价 − 本年内第一个交易日收盘价) ÷ 该收盘价 × 100%，序列用**前复权**。
 *
 * 为什么必须前复权：除权除息那天不复权序列会跳空下跌，那不是真实收益（分红/送转不是亏钱）。
 * 指数是点位回报、期货是合约价、板块是成分股统计 —— 这些标的没有除权除息概念
 * （`fqSupported=false`），按原始价格计算并在 tooltip 写明「该标的不适用复权，按原始价格」。
 */
export const YTD_CALIBER = 'YTD =（现价 − 本年内第一个交易日收盘价）÷ 该收盘价 × 100%，前复权序列'

/**
 * 基准的性质：
 *   - `year`：本年内第一个交易日（正常情形）；
 *   - `listing`：该标的本年内上市，序列里没有更早的交易日 —— 此时基准是**上市首日**，
 *     不是年初，必须标出来（拿"上市首日至今"当"年初至今"读会高估）。
 */
export type YtdBaseKind = 'year' | 'listing'

export interface YtdRow {
  secid: string
  name: string
  /** 年初至今涨跌幅（%）；不可得时为 null —— **不用 0 顶替**（0 会被读成"没涨没跌"） */
  ytd: number | null
  /** 基准日（YYYY-MM-DD）；不可得为 null */
  baseDate: string | null
  /** 基准收盘价（与 `fq` 同一口径）；不可得为 null */
  baseClose: number | null
  /** 计算用的现价（来自行情） */
  price: number | null
  /** 基准性质；不可得为 null */
  baseKind: YtdBaseKind | null
  /** **实际生效**的复权口径（0=不复权 1=前复权 2=后复权），不是请求值 */
  fq: FqMode
  /** false = 该标的没有除权除息概念（指数/期货/板块），按原始价格计算 */
  fqSupported: boolean
  /** 基准序列被观测/落盘的时刻（epoch ms） */
  asOf: number | null
  /** 本轮没算出 YTD 的原因（人话）；能算出时为 null */
  why: string | null
}

export interface YtdPayload {
  /** 行情（现价）被观测到的时刻；无有效行情时为 null */
  asOf: number | null
  /** 至少一项是兜底值或已过期（沿用行情出处契约的语义） */
  stale: boolean
  source: DataProvenance['source']
  missing: MissingField[]
  rows: YtdRow[]
  /** 请求的标的数（含重复与超限项） */
  requested: number
  /** 是否因超过单次上限被截断（不静默截断） */
  truncated: boolean
  /** 单次上限（界面据此说明"只算了前 N 项"） */
  limit: number
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
 *
 * 键与**列头**一一对应（见 client/sort.ts 的 WATCH_COLUMNS / PORT_COLUMNS）：
 * 有数值来源的列才给键，没有键的列（如「名称」）不参与排序 —— 排错比不排更糟。
 */
export type WatchSortKey = 'default' | 'pct' | 'mv' | 'amount' | 'chg' | 'alpha'
export type PortSortKey = 'default' | 'mv' | 'pnl' | 'dayPnl' | 'weight' | 'price' | 'cost'

export interface SortState<K extends string> {
  key: K
  /** true = 降序（大→小） */
  desc: boolean
}

export const WATCH_SORT_KEYS: readonly WatchSortKey[] = ['default', 'pct', 'mv', 'amount', 'chg', 'alpha']
export const PORT_SORT_KEYS: readonly PortSortKey[] = ['default', 'mv', 'pnl', 'dayPnl', 'weight', 'price', 'cost']

/**
 * 视图密度档位（P0-8，对标"一键摸鱼"）。
 * `full` = 完整（含说明文字与脚注）；`compact` = 去掉说明文字/脚注；
 * `incognito` = 金额模糊（`¥••••`）+ 涨跌色转灰阶。
 * **只影响显示**：取数、告警与 agent 工具返回不受影响。
 */
export type ViewMode = 'full' | 'compact' | 'incognito'

export const VIEW_MODES: readonly ViewMode[] = ['full', 'compact', 'incognito']
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
  /**
   * 行情卡片配置：**存隐藏集合**（`hidden: string[]` = 被隐藏的 secid）。
   *
   * 为什么存隐藏而不是显示：老 profile 没有这个键 ⇒ `hidden=[]` ⇒ 全部可见，
   * 且**将来新增的卡片默认可见**。存"显示集合"会让老 profile 永远看不到后加的国债卡。
   */
  stripCfg?: { hidden: string[] }
  /**
   * 每日分时归档（多日拼接的数据来源，默认开）。
   *
   * 关掉后：不再往 `trends/<secid>/` 写任何文件（已有的不动），五日在没有真实多日源的市场
   * 就只能是当日 —— 界面会如实说明"未归档"，不会假装有历史。
   */
  trendArchive?: boolean
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
  trendArchive: true,
  /** 行情卡片配置：存**隐藏集合**（老 profile 无此键 ⇒ 全可见；将来新增的卡片默认可见） */
  stripCfg: { hidden: [] },
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
  /**
   * 费用影响（P2-6）：`总费用 ÷ 数量`（¥/股）。数量 0 ⇒ `null`（界面 `—`）。
   * 口径：只算**买入侧累计费用**（它已摊进成本）；卖出费用已在 `realized` 里扣过，不重复计。
   */
  feePerShare?: number | null
  /** 费用影响的分母（数量），便于读者复核 */
  feePerShareQty?: number
  /** 买入均价（移动加权，含买入费用；卖出不影响） */
  avgCost: number
  /** 摊薄成本（券商口径）：(累计买入含费 − 累计卖出净额) ÷ 剩余数量 */
  dilutedCost: number | null
  /**
   * 累计已实现盈亏（含费用）。
   *
   * `null` = **算不出来**：成本未录入时它是 (卖出价 − 0) × 数量，正是 D1 那类"凭空盈利"。
   * 界面显示 `—`（不给 0：0 会被读成"确实没有已实现盈亏"），且不计入分组/总览的合计。
   */
  realized: number | null
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
  /**
   * 成本**未录入**（P1-10）：有持仓、买入均价为 0、且从未有过成交额。
   *
   * 典型来源：新建持仓后直接用「调整」录了数量、没填成本 —— 此前会被当成"零成本"，
   * 于是浮动盈亏 = (现价 − 0) × 数量 = 全部市值（凭空多出一整笔盈利）。现在标出来，
   * 盈亏与盈亏率一律显示 `—`，并提示去「调整」补成本；市值照算（它与成本无关）。
   */
  costUnknown?: boolean
  /**
   * 未能应用的流水条数（P1-5）：账本里有这条流水、快照却没把它算进来。
   *
   * 此前这类流水被静默跳过（既不计数据也不报数），用户对不上账时无从下手。
   * 现在逐条记原因：`skippedLedger > 0` 时界面与 `tradewatcher_portfolio` 都会报出来。
   */
  skippedLedger?: number
  /** 未应用流水的原因（最多前 3 条，形如 `[e12] 卖出数量超过持仓（持有 100）`） */
  skippedNotes?: string[]
  /**
   * **成本未知期间卖出的股数**（D1b）：这些股在卖出时 `avgCost` 还是 0（成本未录入），
   * 它们的已实现盈亏算不出来，因此 `realized` 为 `null`。
   *
   * 与 `costUnknown` 是两件事：`costUnknown` 是"整仓现在也没有成本"，
   * 这里是"历史上有 N 股在成本录入之前卖出" —— 用户后来补录了成本，整仓不再缺成本，
   * 但那 N 股的已实现仍旧不可算（除非补录的成本流水 ts 早于那笔卖出，重放就能算对）。
   * 界面与工具据此给出原因（`realizedUnknownNote`），而不是只甩一个 `—`。
   */
  realizedUnknownQty?: number
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
  /**
   * 组合构成（P0-11）：权重 / 行业·主题·市场分布 / 集中度。
   * 权重 = 单条市值 ÷ **可计价**总市值 × 100（缺价的行不进分母，`unpriced` 如实计数）；
   * 行业只来自**本地已有数据**（分组名），拿不到就是 `null`（界面 `—`），不按代码猜。
   */
  composition?: {
    totalMv: number
    unpriced: number
    rows: Array<{ id: string; name: string; secid: string; market: string; mv: number | null; weightPct: number | null; sector: string | null }>
    sectors: Array<{ key: string; weightPct: number; count: number }>
    markets: Array<{ key: string; weightPct: number; count: number }>
    concentration: { top1: number; top3: number; hhi: number; n: number }
  }
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

/**
 * 批量录入的批次标记：`批量录入#` + 1–12 位 base36（客户端写定长 8 位；这里放宽到 1 位，
 * 是为了让“整词相等”这条规则本身可测：`批量录入#1` 只该命中 `#1`，不该命中 `#12` / `#1x`）。
 *
 * 为什么写死格式：反删**不可恢复**，判定必须是"整词精确相等"而不是子串/前缀。
 * 规则：标记**前**必须是串首或空白（所以 `x批量录入#1` 不算），**后**必须不是词字符
 * （所以 `批量录入#1` 不等于 `批量录入#12`，也不等于 `批量录入#1x`）。
 */
export const BULK_BATCH_PREFIX = '批量录入#'
export const BULK_BATCH_RE = /(?:^|\s)批量录入#([0-9a-z]{1,12})(?![0-9a-z])/g

/** 从 note 里取出所有批次标记（整词匹配，见 `BULK_BATCH_RE`） */
export function bulkBatchesOf(note: string | undefined): string[] {
  if (typeof note !== 'string' || note === '') return []
  const out: string[] = []
  BULK_BATCH_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = BULK_BATCH_RE.exec(note)) !== null) out.push(`${BULK_BATCH_PREFIX}${m[1]}`)
  return out
}

/** 这条 note 是否属于**指定批次**（整词相等；`批量录入#1` 不命中 `#12`/`#1x`/`x批量录入#1`） */
export function bulkBatchMatches(note: string | undefined, marker: string): boolean {
  return bulkBatchesOf(note).includes(marker)
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
    // 批量录入的一次撤销：按流水 id 反删（留痕：删掉的原件写进 writeLog，可从那边恢复）
    | 'deleteLedger'
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
  /** `deleteLedger` 用：要反删的流水 id 列表 */
  ids?: string[]
  /** `deleteLedger` 用：按 note 里的**批次标记**反删（整词精确匹配，见 `bulkBatchesOf`） */
  noteMarker?: string
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

/**
 * 该标的是否 T+0（当日买入当日可卖）。**判定只有这一处**，避免界面、账本校验与核算各写一套。
 *
 * 规则：港股/美股/国际/期货商品为 T+0；A股股票 T+1，但**场内基金（ETF/LOF）是 T+0**。
 * 场内基金代码：沪市 `5xxxxx`（50/51/52/56/58 开头），深市 `15xxxx` / `16xxxx` / `18xxxx`。
 * 拿不准的一律按 T+1（保守方向：绝不把"今天买的"说成能卖）。
 *
 * 放在 shared 而不是 host/portfolio.ts：宿主侧的**卖出校验**（store.ts）也要用它，
 * 而 store ↔ portfolio 互相 import 会形成循环依赖。
 */
/**
 * 「已实现不可算」的统一说明（D1b）—— 界面与工具共用同一句，避免两处措辞分叉。
 *
 * 必须点明**原因**而不只是给一个 `—`：`—` 会被读成"数据丢了/还没算"，
 * 而真相是那 N 股在**成本录入之前**卖出，当时成本是未录入的 0，`(卖出价 − 0) × 数量` 不是收益。
 * 用户补录的成本流水时点若早于那笔卖出，重放即可算对（本插件按流水时点重放）。
 */
/**
 * 面板级 / 工具侧「已实现不可算」的**唯一判定**（N1）：只认 `realizedUnknownQty > 0`，
 * 并排除已在「成本未录入」提示里报过的行。
 *
 * 为什么必须共用一份：客户端面板、行内提示、宿主工具都要说"另有 N 只、共 X 股"，
 * 三处各写一套 filter 迟早分叉（分叉出的差额就是"静默缺口"——用户看到合计少了却不知道为什么）。
 * 两个提示合起来**恰好**覆盖所有 `realized === null` 的行：不重复计，也不漏。
 */
/**
 * 「缺失两档」措辞的**唯一出处**（K1：两档必须可区分；S19：同义长句不再一处写一遍）。
 *
 * 每个调用点只补"**具体是谁不可达 / 为什么没有兜底**"那半句，这半句永远来自这里 ——
 * 它决定用户的下一步动作（等 vs 改口径），所以措辞必须稳定且两档可区分。
 */
/**
 * 流水动词的中文名（**宿主与客户端共用这一份**）。
 *
 * 为什么要共享：宿主侧（工具输出）与客户端（流水弹窗）此前各写一份逐字相同的映射 ——
 * 改一处忘另一处，同一笔买卖在两个界面就会叫两个名字。
 */
export const LEDGER_VERB_LABEL = {
  buy: '买入',
  sell: '卖出',
  adjust: '调整',
  add: '新建持仓',
  remove: '移除持仓',
  gcreate: '新建分组',
  grename: '分组改名',
  gdelete: '归档分组',
  grestore: '还原分组',
  gmove: '移动/编辑',
  pnote: '备注',
} as const

/**
 * `number | null | undefined` → 有限数或 `null`（宿主多处数值判定共用这一份）。
 *
 * ⚠ 只处理**数字**：上游把数字当字符串给（东财 `f3: '1.23'`、`'-'` 表示无值）的那几条链路
 * （`em.ts` 的 `num`、`tencent.ts`/`sina.ts` 的 `num`）有自己的字符串解析，**不要合并**：
 * 把 `'1.23'` 判成 `null` 会让行情字段整片变 `—`。
 */
export function numOrNull(v: unknown): number | null {
  if (v === null || v === undefined) return null
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

/**
 * 缺失**四态**（P0-5）：`代码不存在` / `上游无此数据` / `本次失败` / `后台更新中`。
 *
 * 为什么单列：原先只有两态（本次失败 / 上游无此数据），于是"代码写错了"要么被说成"稍后重试"
 * （让用户白等），要么被说成"上游没有"（把上游冤枉了）。**区分不了的不要硬造** ——
 * 只有 `SECID_RE` 校验失败这种**结构性**判据才敢标 `invalid-code`；
 * "查询没返回"既可能是不存在的代码、也可能是上游缺数据，如实留在 `no-source`/`transient` 里。
 */
export type MissingWhy = 'invalid-code' | 'no-source' | 'transient' | 'pending'

/** 四态的短标签（列表/工具输出用；与旧两态标签同处一个词表） */
export const MISSING_STATE_LABEL: Record<MissingWhy, string> = {
  'invalid-code': '代码不存在',
  'no-source': '上游无此数据',
  transient: '本次失败',
  pending: '后台更新中',
}

/** 四态的动作建议（尾句只留动作，别重复"不可达"这类形容词） */
export const MISSING_STATE_ADVICE: Record<MissingWhy, string> = {
  'invalid-code': '核对代码，重试无用',
  'no-source': '重试无用',
  transient: '稍后自动重试',
  pending: '本轮刷新完成后自动出现',
}

export const MISSING_TIER_ADVICE: Record<'transient' | 'no-source', string> = {
  // 只留**动作**：前半句已经写了"不可达/没取到"，尾句再重复同一事实就是啰嗦（R2/R3）
  transient: '稍后自动重试',
  'no-source': '重试无用',
}

/** 两档的**短标签**（列表/工具输出用）——与 `MISSING_TIER_ADVICE` 同一处定义，避免各处三目分叉 */
export const MISSING_TIER_LABEL: Record<'transient' | 'no-source', string> = {
  transient: '本次失败',
  'no-source': '上游无此数据',
}

/** 行内/弹窗用的短句（80 字全文只留面板级一处 —— 避免同一句在每行各写一遍） */
export function realizedUnknownShort(qty: number): string {
  const n = Math.round(qty * 1e4) / 1e4
  return `已实现不可算：${n} 股成本录入前卖出`
}

export function realizedUnknownRows<T extends { realizedUnknownQty?: number; costUnknown?: boolean }>(
  rows: readonly T[],
): T[] {
  return rows.filter((r) => (r.realizedUnknownQty ?? 0) > 0 && r.costUnknown !== true)
}

/** 上述行里"成本录入前卖出"的股数合计（面板级"共 X 股"）—— 与判定同源，调用方不得自己 reduce */
export function realizedUnknownQtyOf(rows: readonly { realizedUnknownQty?: number }[]): number {
  let sum = 0
  for (const r of rows) sum += r.realizedUnknownQty ?? 0
  return Math.round(sum * 1e4) / 1e4
}

export function realizedUnknownNote(qty: number): string {
  const n = Math.round(qty * 1e4) / 1e4
  return `已实现不可算：其中 ${n} 股在「成本录入前卖出」—— 那笔卖出应用时成本还是未录入的 0，` +
    '(卖出价 − 0) × 数量 不是真实收益；补录的成本流水时点若早于这笔卖出，重放即可算对'
}

export function isT0Secid(secid: string): boolean {
  const m = marketOf(secid)
  if (m === 'hk' || m === 'us' || m === 'intl' || m === 'futures') return true
  if (m !== 'cn') return false
  const code = secid.slice(secid.indexOf('.') + 1)
  return /^(5\d{5}|1[5-9]\d{4})$/.test(code)
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
  /**
   * 滞后时长的人话（P0-4）：如「11 天前」「3 分钟前」——比「已降级」有用得多。
   * 只在 `asOf` 存在时给；不编（拿不到时刻就留空）。
   */
  lagHuman?: string
  /**
   * 市场开闭市状态（P0-4）：解释"为什么数字不动"。
   * `open` 交易中；`closed` 休市中（含午休）；`unknown` 判断不了（无时刻/无交易日历）。
   */
  marketState?: 'open' | 'closed' | 'unknown'
  /** 滞后自动告警（P1-9）：超阈值才有一行；不超时**没有这个字段**（不许恒输出） */
  lagAlert?: string
  /**
   * 降级时**现在显示的到底是什么**（P1-10）：如「行情源暂时不可用，当前显示 15:00 快照」。
   * 只有真降级（stale/兜底/本地快照）时才给。
   */
  showing?: string
}

/**
 * 把人话化的滞后时长算出来（P0-4）。纯函数，便于断言。
 *
 * 规则：<90s「刚刚」；<90min「N 分钟前」；<36h「N 小时前」；否则「N 天前」。
 * `asOf === null` ⇒ `null`（**不编**，也不写"刚刚"）。
 */
/**
 * 滞后自动告警（P1-9）：只在**超阈值**时给一行；不超就返回 null（**不许恒输出**）。
 *
 * 阈值按数据频率选：日线/日频数据用 `dailyDays`（默认 3 个自然日，容忍周末），
 * 分钟/实时数据用 `intradayMinutes`（默认 30 分钟）。`asOf` 为 null ⇒ 不给告警（缺时刻是"未知"，
 * 不是"滞后" —— 那种情况由 missing[] 说）。
 */
export function lagAlertOf(
  asOf: number | null,
  now: number,
  opts: { source?: string; dailyDays?: number; intradayMinutes?: number; isDaily?: boolean } = {},
): string | null {
  if (asOf === null || !Number.isFinite(asOf)) return null
  const gapMs = now - asOf
  if (!(gapMs > 0)) return null
  const src = opts.source ?? '数据源'
  if (opts.isDaily === true) {
    const days = Math.floor(gapMs / 86_400_000)
    const limit = opts.dailyDays ?? 3
    if (days < limit) return null
    return `数据更新滞后：${src} 最新 ${new Date(asOf).toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' })}，落后 ${days} 天`
  }
  const min = Math.floor(gapMs / 60_000)
  const limit = opts.intradayMinutes ?? 30
  if (min < limit) return null
  return `数据更新滞后：${src} 最新 ${new Date(asOf).toLocaleTimeString('zh-CN', { hour12: false, timeZone: 'Asia/Shanghai' })}，落后 ${min} 分钟`
}

export function lagHumanOf(asOf: number | null, now: number): string | null {
  if (asOf === null || !Number.isFinite(asOf)) return null
  const ms = now - asOf
  if (!Number.isFinite(ms)) return null
  if (ms < 0) return '刚刚'
  const sec = Math.round(ms / 1000)
  if (sec < 90) return '刚刚'
  const min = Math.round(sec / 60)
  if (min < 90) return `${min} 分钟前`
  const hour = Math.round(min / 60)
  if (hour < 36) return `${hour} 小时前`
  return `${Math.round(hour / 24)} 天前`
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
