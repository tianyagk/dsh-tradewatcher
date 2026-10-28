// 筹码分布：与宿主 `chips.ts` 同形（客户端只消费）
export interface ChipDayDto {
  date: string
  buckets: number[]
  /**
   * ⚠ 本批（AUDIT-IMPL73）起宿主**逐日不再给** `centers`（轴改在顶层 `ChipsPayload.centers` 只给一份，
   * 回包 166 KB → 84 KB）。保留可选字段是为了**老宿主回包**还能渲染：
   * 读取侧统一写 `day.centers ?? payload.centers`（见 `ChipsPanel.tsx`）。
   */
  centers?: number[]
  avgCost: number | null
  support: number | null
  resistance: number | null
  narrow: boolean
  /**
   * 该展示日的**盈亏边界价**（与 `profitRatio` 同源：最新日=现价、历史日=当日收盘价）。
   *
   * ⚠ **可选**：老宿主不带这个字段 ⇒ 客户端按 `chipsDayPriceOf` **如实回退**到顶层 `priceUsed`
   * 并留下原因（不静默）。
   */
  price?: number | null
  profitRatio: number | null
  samples: number
}
export interface ChipsPayload {
  secid: string
  asOf: number | null
  stale: boolean
  source: string
  /** 档中心（轴）——整段序列一份（新宿主恒给；老宿主缺省 ⇒ 退回逐日 `day.centers`） */
  centers?: number[]
  days: ChipDayDto[]
  latest: ChipDayDto | null
  /** 累积窗口（递推用了几根日线） */
  window: number
  /** 展示窗口（滑杆覆盖的天数） */
  displayWindow: number
  bucketCount: number
  /**
   * 实际档宽（元）与目标档宽（元）：档数自适应后**必须**让用户读到"这个分布的价格分辨率是多少"
   * （档数固定时窗口越长档宽越粗：45 天 1.25 元 → 805 天 6.10 元）。
   *
   * ⚠ **可选**（老宿主不带）⇒ 客户端按 `—` 显示，不猜、不写 0。
   */
  bucketWidth?: number | null
  bucketTarget?: number | null
  /** 档数被哪道限制夹住（老宿主 ⇒ 缺省） */
  bucketClamped?: 'min' | 'max' | 'payload' | null
  /** 夹取说明（界面对应位置必须显示它；老宿主 ⇒ 缺省） */
  bucketNote?: string | null
  /**
   * **成交量量纲归一**的如实标注（宿主 v0.101 起；老宿主缺省 = 没动过）。
   *
   * 为什么必须可见：科创板日线在腾讯一侧给的是「股」，插件按「手」算换手率 ⇒ 不归一就会
   * 让 `t` 被放大 100×、天天顶到 cap、筹码退化成"只有两三天"。归一之后数字是对的，
   * 但用户有权知道"这份序列的量纲被改过、只改了 vol"。v0.159.0 起筹码卡不再常驻展示口径注解（用户要求纯删除）——
   * 该字段仍随载荷下发，供接口/agent 核对。
   */
  unitNote?: string | null
  decay: 'turnover' | 'half-life'
  decayReason: string | null
  avgCost: number | null
  support: number | null
  resistance: number | null
  narrow: boolean
  profitRatio: number | null
  samples: number
  methodology: string
  why: string | null
  /** 盈利比例用到的现价（已换算到前复权空间）；null ⇒ 界面显示"未取到" */
  priceUsed: number | null
  priceSource: 'quote' | 'close' | null
  fqt: 1
  priceScale: number
  latestBarDate: string | null
  barAlignsWithDisplay: boolean
  disclaimer: string
  missing: Array<{ what: string; why: string; note: string }>
}

// 做T 视图：与宿主 `dayTrade.ts` 的返回同形（客户端只消费，不重算）
export interface DayTradeView {
  rounds: Array<{
    day: string
    direction: 'buy-first' | 'sell-first'
    qty: number
    buyPrice: number
    sellPrice: number
    grossPnl: number
    feeShare: number
    netPnl: number
  }>
  unmatched: Array<{ day: string; verb: string; qty: number; price: number | null; note: string }>
  summary: { count: number; winRate: number | null; netPnl: number | null; avgNet: number | null; days: number; unpricedCount?: number }
  methodology: string
}

// 全球五市场（工具箱 → 工具①「全球资金流蛋糕模型」）：与宿主 `globalFlow.ts` 同形（客户端只消费，不重算份额）
export interface GlobalFlowMarketDto {
  /** 成分 v2（A股、港股、美国、日本、韩国）—— 顺序即展示顺序 */
  key: 'cn' | 'hk' | 'us' | 'jp' | 'kr'
  name: string
  etf: string
  aumSource: string
  currency: 'USD' | 'CNY' | 'HKD'
  benchmark: string
  benchmarkSource: string
  aumNative: number | null
  aumUsd: number | null
  /** 该市场的**偏好分**（0–1；权重口径：55% 贪婪值 + 30% 5 日动量分位 + 15% 20 日动量分位；null = 样本不足 ⇒ 不进分母） */
  pref?: number | null
  /** 偏好分的口径说明（悬停/口径行用） */
  prefSource?: string
  sharePct: number | null
  delta1Pp: number | null
  delta5Pp: number | null
  momentum: { d20: number | null; d60: number | null; d120: number | null } | null
  rank: number | null
  /** 该行缺什么 + 原因（null = 全齐）；页面必须原样显示，不许用 0 顶替 */
  missing: string | null
}

export interface GlobalFlowPointDto {
  day: string
  origin: 'observed' | 'rebuilt'
  aumUsd: Array<number | null>
  /** 各市场**偏好分**（0–1；蛋糕温度 = 它的均值 × 100，与权重同源） */
  pref?: Array<number | null>
  share: Array<number | null>
  partial: boolean
}

export interface GlobalFlowPayloadDto {
  asOf: number
  day: string
  /** live = 上游现取；snapshot = 本次只读本地快照（零上游请求）；fallback = 上游全失败、退化为最近一次快照 */
  source: 'live' | 'snapshot' | 'fallback'
  fallbackDay: string | null
  fx: { usdCny: number | null; usdHkd: number | null; at: number | null; source: string; note: string | null }
  /**
   * 宏观两档（**24 小时品种**，不套 A 股休市冻结）：美国 10Y 国债收益率 / 广义美元指数。
   * 快照模式（零上游请求）下为 `null` + 说明。
   */
  macro?: {
    us10y: { value: number; at: number | null; history: number[]; samples: number; source: string; crossCheck?: string; historySource?: string } | null
    dxy: { value: number; at: number | null; history: number[]; samples: number; source: string; crossCheck?: string; historySource?: string } | null
    notes: Array<{ what: string; why: string; note: string }>
  }
  markets: GlobalFlowMarketDto[]
  totalUsd: number | null
  totalNote: string | null
  rotation: { kind: 'rotation' | 'flat' | 'unknown'; fromKey: string | null; toKey: string | null; maxAbsPp: number | null; comparable: number; window: number; text: string }
  curve: {
    points: GlobalFlowPointDto[]
    /** 本次实际构建的窗口（= 最大档；客户端从这条曲线切片出各档） */
    window: number
    /** 可选窗口（90 / 180 / 365），分段控件用 */
    windowOptions: number[]
    observedDays: number
    rebuiltDays: number
    note: string
  }
  replay: { days: string[]; max: number; note: string }
  netFlow: { code: string; label: string; days: number; sumCny: number | null; asOf: number | null; series: Array<{ day: string; netCny: number }>; basis: string; miss: string | null }
  snapshot: {
    path: string
    days: number
    bytes: number | null
    firstDay: string | null
    lastDay: string | null
    /** 因口径不一致而作废的旧快照（留痕；成分变更后非空） */
    purged: Array<{ day: string; scope: string | null; reason: string }>
  }
  notes: { kpi: string; curve: string; pie: string; market: string; boundary: string }
  boundary: string[]
  missing: Array<{ what: string; why: 'no-source' | 'transient'; note: string }>
}

// ── 杠杆温度计（工具箱 → 工具②）：与宿主侧**冻结契约**同形（字段名逐字锁定，客户端只消费） ──

/**
 * 窗口三档：`250` = 1 年 / `750` = 3 年 / `all` = 全历史。
 * ⚠ 切档**只换这个查询参数**（同一个接口），不新增别的路由 —— 判据见 `leverageTool.test.ts` ⑥。
 */
export type LeverageRange = '250' | '750' | 'all'

/**
 * 杠杆温度计的载荷。
 *
 * 红线：这里的每个数值都可能是 `null`（上游没给 / 宿主尚未落地这个字段）⇒ 界面一律显示 `—`，
 * **不用 0 顶替**、也不写缺失原因（该工具的页面规格只有一行说明文字：`截至 YYYY-MM-DD`）。
 */
export interface LeveragePayloadDto {
  /** 数据截止日 `YYYY-MM-DD`（两融 T+1 ⇒ 页面写「截至」而不写「今日」） */
  asOf: string
  /** 杠杆温度（0–100） */
  temperature: number | null
  /** 显性融资比例（融资余额 ÷ 流通市值，%） */
  ratioPct: number | null
  /** 杠杆率（含融券口径，%） */
  ratioWithShortPct: number | null
  /** 融资余额（元） */
  marginBalance: number | null
  /** 融券余额（元） */
  shortBalance: number | null
  /** A 股流通市值合计（元） */
  floatMv: number | null
  /** 当日融资净买入（元；正负号有意义） */
  netBuy: number | null
  /** 温度轴上的两条阈值（80 / 95）；上游没给 ⇒ `null` ⇒ 不画那条线（不写 0） */
  thresholds: { p80: number | null; p95: number | null }
  /** 序列日期（旧 → 新） */
  dates: string[]
  /** 温度序列（0–100） */
  temp: Array<number | null>
  /** 显性融资比例序列（%） */
  ratio: Array<number | null>
  /** 当日融资净买入序列（元） */
  net: Array<number | null>
}

import type { ToneRow as ToneRowDto } from './stripTone.ts'
import { parseSelftestBody } from './prismView.ts'
import type { PrismAccount, PrismNewsStatus, PrismOrder, PrismRun, PrismSettings, PrismState, PrismTradingState } from '../shared/prism.ts'
/** Same-origin JSON calls to the /tradewatcher/* host routes. */
import type {
  BoardRow,
  CorporateAction,
  FqMode,
  KlineData,
  MissingField,
  MutatePortBody,
  MutateWatchBody,
  PortPrefs,
  PortfolioView,
  QuoteRow,
  RescueDaySummary,
  RescueIntradayPoint,
  RescueSignalEvent,
  RescueSnapshot,
  QuoteSource,
  StockDetail,
  SuggestItem,
  TrendData,
  WatchData,
  LedgerView,
  TradeMark,
  CalEvent,
  YtdPayload,
  AuctionInfo,
} from '../shared/model.ts'
import { SUGGEST_FULL_COUNT } from '../shared/model.ts'

export class ApiError extends Error {
  status: number
  constructor(message: string, status: number) {
    super(message)
    this.status = status
  }
}

/**
 * 请求超时（毫秒）。**行情轮询的命门**（P2-1）：
 * 旧实现没有超时 —— 一次挂起的 fetch 会让 `inFlight.current` 永远为 true，
 * 之后每一拍 `load()` 都在第一行 return ⇒ **行情轮询彻底停摆**（只能刷新页面）。
 * 所有接口共用这一份上限（行情/详情/搜索都不该无限等）。
 */
export const REQUEST_TIMEOUT_MS = 15_000

export interface RequestSignal {
  signal: AbortSignal
  /** 是否已被取消（超时或外部取消） */
  aborted: () => boolean
  /** 是否是**超时**取消（据此给"请求超时"而不是"网络错误"） */
  timedOut: () => boolean
  /** 必须调用：清掉定时器与外部监听（否则定时器泄漏） */
  clear: () => void
}

/**
 * 超时 + 外部取消合并成一个 `AbortSignal`（纯函数式，便于单测）。
 * `timeoutMs <= 0` 视为"不超时"（仅测试/调试用）。
 */
export function requestSignal(timeoutMs: number = REQUEST_TIMEOUT_MS, outer?: AbortSignal): RequestSignal {
  const ctrl = new AbortController()
  let timedOut = false
  const timer = timeoutMs > 0 ? setTimeout(() => { timedOut = true; ctrl.abort() }, timeoutMs) : null
  const onAbort = (): void => ctrl.abort()
  if (outer !== undefined) {
    if (outer.aborted) ctrl.abort()
    else outer.addEventListener('abort', onAbort)
  }
  return {
    signal: ctrl.signal,
    aborted: () => ctrl.signal.aborted,
    timedOut: () => timedOut,
    clear: () => {
      if (timer !== null) clearTimeout(timer)
      outer?.removeEventListener('abort', onAbort)
    },
  }
}

/** `request` 的超时参数在测试里可缩短（生产路径始终用 `REQUEST_TIMEOUT_MS`） */
export async function requestWithTimeout<T>(path: string, init?: RequestInit, timeoutMs: number = REQUEST_TIMEOUT_MS): Promise<T> {
  const sig = requestSignal(timeoutMs)
  let res: Response
  try {
    res = await fetch(path, {
      ...init,
      headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
      cache: 'no-store',
      signal: sig.signal,
    })
  } catch (error) {
    // 超时与"网络真的断了"是两个原因：前者稍后重试就好，后者要查网络/宿主
    if (sig.timedOut()) throw new ApiError(`请求超时（${Math.max(1, Math.round(timeoutMs / 1000))} 秒未响应）`, 0)
    throw new ApiError(`网络错误: ${error instanceof Error ? error.message : String(error)}`, 0)
  } finally {
    sig.clear()
  }
  let payload: { error?: string } & T
  try {
    payload = (await res.json()) as { error?: string } & T
  } catch {
    throw new ApiError(`响应解析失败 (HTTP ${res.status})`, res.status)
  }
  if (!res.ok || payload.error !== undefined) {
    throw new ApiError(payload.error ?? `HTTP ${res.status}`, res.status)
  }
  return payload
}

/** 生产路径入口：固定超时上限（测试用 `requestWithTimeout` 指定短超时） */
function request<T>(path: string, init?: RequestInit): Promise<T> {
  return requestWithTimeout<T>(path, init)
}

// ── 复盘页（第 7 个页签）的线缆契约：两条 fupan 路由 ─────────────────────────
//
// ⚠ 本文件里任何**在 api 对象之前**的注释都不许出现路由字面量：
// src/rowOwnership.test.ts 按「api 函数体里第一个路由字面量」推归属，而它的函数切分正则
// 会因"空行 + 下一行缩进"把函数起点提前；提前后的函数体里若先出现**另一条**路由字面量，
// 归属就会被算到别处（实测把 globalFlow 的归属算成了别条前缀，直接红）。
//
// 形状由宿主定（`src/host/fupan*.ts`）。**除 `ym`/`asOf` 之外全部可选**：老宿主/回包不完整时
// 界面必须落到「未知 + 原因」，而不是拿默认值（0 / 交易日）顶替 —— 缺失语义的判据在
// `fupanView.ts`，那里是唯一的解释层，页面只渲染。

/** 交易日历的元信息（`covered=false` ⇒ 外部日历未覆盖该月，宿主已回退内置表） */
export interface FupanCalendarInfo {
  covered?: boolean
  source?: string
  warning?: string | null
  months?: string[]
}

/** 月历里的一天（宿主契约：该月**每一天**一条） */
export interface FupanDateDto {
  date: string
  /** 该日**自己写的**笔记条数（缺失 ⇒ 界面写"未知"，不写 0） */
  count?: number
  /** 是否有一条笔记被钉到这一天 */
  hasPinned?: boolean
  /** 是否交易日（缺失 ⇒ `unknown`，**绝不默认 true**） */
  trading?: boolean
  /** `trading === false` 的原因：`周末` / 假日名 / `外部日历（手工维护）` */
  closedReason?: string | null
  /**
   * 该日交易笔数。宿主**当前不带**（复盘月历与交易是两条路由）⇒ 缺省；界面按「按日惰性取数」
   * 走 `GET /tradewatcher/fupan/trades`，只有打开过的日子才知道笔数。
   * 哪天宿主带上了，整月就能直接画 `▲n`（界面不用改）。⚠ 缺失 ⇒ 不画，**不写 0**。
   */
  trades?: number
}

/** 一条复盘笔记（`pinnedTo` = 钉到的日子；`at` = 写入时刻） */
export interface FupanNoteDto {
  id: string
  /** 写在哪一天（YYYY-MM-DD） */
  date: string
  text: string
  pinnedTo?: string | null
  source?: string
  at?: number | null
}

export interface FupanMissing {
  what: string
  why: string
  note?: string
}

/** 超上限后从最旧开始丢的如实回报（界面必须显示，不许当成功无事） */
export interface FupanDropped {
  notes?: unknown[]
  count?: number
  reasons?: string[]
}

export interface FupanMonthPayload {
  ym?: string
  asOf?: number | null
  /** 口径（纯本地文件 + 既有交易日历，零新增上游请求） */
  source?: string
  stale?: boolean
  calendar?: FupanCalendarInfo | null
  /** 非 null = 外部交易日历未覆盖该月（回退内置表）⇒ 界面原样显示这句 */
  calendarWhy?: string | null
  dates?: FupanDateDto[]
  /** 该月**全部**笔记（含被钉到别处的） */
  notes?: FupanNoteDto[]
  totals?: {
    notes?: number
    pinned?: number
    days?: number
    daysWithNotes?: number
    daysWithPinned?: number
    /** 该月交易日数（宿主算出来的；`0` 只可能来自"真的没有交易日"，不能当"不知道"） */
    tradingDays?: number
  }
  missing?: FupanMissing[]
  /** 读失败（权限/磁盘）时宿主给的原因：**不许**当成"没有笔记" */
  notesUnreadable?: { reason?: string } | string | null
  /** 读到了但内容坏 ⇒ 已隔离的原件路径（原字节保留，可人工恢复） */
  notesQuarantined?: string | null
  /** 形状不合法被跳过的条目数（宿主披露，不许静默） */
  invalidEntries?: number
}

export interface FupanNoteResult {
  ok?: boolean
  asOf?: number | null
  source?: string
  /** 实际执行的动作（`upsert` / `delete`） */
  op?: string
  id?: string | null
  /** 删除/更新实际影响的条数（删除时为 1） */
  removed?: number
  /** 本次写入涉及的那一天 */
  date?: string
  ym?: string | null
  /** 该日**自己写的**笔记（写入后的快照；钉到该日的别天笔记不在这里） */
  notes?: FupanNoteDto[]
  dropped?: FupanDropped
  /** 写入后的月历摘要（`dates[]` 用它与界面同步；`null` = 定位不到月份） */
  month?: { ym?: string | null; dates?: FupanDateDto[]; calendar?: FupanCalendarInfo | null; calendarWhy?: string | null } | null
  missing?: FupanMissing[]
  /** 写入后若笔记文件读不到 ⇒ 原因（写成功但读不到，必须说清） */
  notesUnreadable?: string | { reason?: string } | null
  notesQuarantined?: string | null
}

/**
 * 复盘页的一笔交易（宿主从持仓流水里按日筛出；**只读展示**，点一下跳到持仓页的流水并高亮）。
 * 数量/价格/费用可能为 `null`（未填）⇒ 界面写「未取到」，不写 0。
 */
export interface FupanTradeDto {
  /** 台账流水 id（跳转后用它在流水列表里定位并静态高亮那一行） */
  ledgerId?: string
  /** 记账时刻（epoch ms）；`time` 缺省时界面用它在**北京时间**下格式化 */
  ts?: number | null
  /** 宿主给的时刻文本（`09:31` / `HH:mm:ss`） */
  time?: string | null
  name?: string | null
  /** `buy` / `sell` / `adjust`（与台账 verb 同源；其它取值原样显示，不猜） */
  side?: string | null
  /** 中文方向（买/卖/调整）：`side` 缺失时用它 */
  direction?: string | null
  qty?: number | null
  price?: number | null
  fee?: number | null
}

/**
 * `GET /tradewatcher/fupan/trades?day=YYYY-MM-DD` 的回包（客户端只消费，不重算）。
 *
 * ⚠ 两种回包形状都认（本字段清单同时兼容"简报口径 `{buys,sells}`"与宿主最终口径
 * `{buy:{count},sell:{count}}`）：解释层在 `fupanTrades.ts`，那里对缺失项一律给「未取到」。
 */
export interface FupanTradesPayload {
  /** 该日逐笔（宿主上限 500/日；超出部分由 `total` / `truncated` 如实披露） */
  trades?: FupanTradeDto[]
  /** 该日**计入笔数**（不受截断影响）；缺省 ⇒ 用 `trades[]` 长度 */
  total?: number
  /** 当日汇总：只有买卖笔数有用（界面不写净买入/净卖出/净额） */
  summary?: {
    buys?: number
    sells?: number
    buy?: { count?: number }
    sell?: { count?: number }
  } | null
  /** 当日盈亏（与持仓页同源）；`null` / 缺省 ⇒ 界面写「未取到」（**不写 0**） */
  dayPnl?: number | null
  /** 读不到的**旧名**原因（界面不显示：用户口径「当日盈亏不加口径句」） */
  dayPnlWhy?: string | null
  /** 读不到的原因（宿主最终口径；同样不显示） */
  dayPnlReason?: string | null
  truncated?: { shown?: number; total?: number } | null
  /** 台账读取失败（HTTP 仍 200）：界面按「未取到」处理，月历**不画三角** */
  readFailed?: boolean
  readFailedReason?: string | null
  asOf?: number | null
}

/** 自检专用：不经过通用 request（HTTP 200 + 非 JSON 也要给可读原因） */
async function runSelftest(path: string): Promise<{ ok: boolean; error: string | null; model: string | null; elapsedMs: number; text: string | null; chunks: Array<{ type: string; keys: string[] }> }> {
  const sig = requestSignal(30_000)
  try {
    const res = await fetch(path, { method: 'GET', cache: 'no-store', signal: sig.signal })
    const raw = await res.text()
    return parseSelftestBody(res.status, raw)
  } catch (error) {
    const why = sig.timedOut() ? '超时/网络错误（30 秒未响应）' : `超时/网络错误（${error instanceof Error ? error.message : String(error)}）`
    return { ok: false, error: why, model: null, elapsedMs: 0, text: null, chunks: [] }
  } finally {
    sig.clear()
  }
}

export const api = {
  /**
   * 全球五市场（工具箱 → 全球资金流蛋糕模型）。
   * `source='snapshot'` = 只读宿主本地快照（一天一条、保留 90 天），**宿主不会发上游请求**
   * —— 30 日手动回放走这条；默认 `auto` 走宿主的现取模式（三层 TTL + 在飞合并）。
   */
  globalFlow(source: 'auto' | 'snapshot' = 'auto'): Promise<GlobalFlowPayloadDto> {
    return request(`/tradewatcher/tools/global-flow${source === 'snapshot' ? '?source=snapshot' : ''}`)
  },
  /**
   * 杠杆温度计（工具箱 → 工具②）。
   *
   * ⚠ 窗口切换**只换 `range` 这一个查询参数**（`250` = 1 年 / `750` = 3 年 / `all` = 全历史），
   * 宿主对三档都回 200 ⇒ 页面不需要第二条接口、也不需要本地切片。
   */
  leverage(range: LeverageRange = '750'): Promise<LeveragePayloadDto> {
    return request(`/tradewatcher/leverage?range=${range}`)
  },
  /** 棱镜（第 9 行）：首屏状态（设置/骨架/新闻/最近运行/默认模型） */
  prismState(): Promise<{ ok: boolean; asOf: number; state: PrismState; trading: PrismTradingState }> {
    return requestWithTimeout('/tradewatcher/prism', undefined, 20_000)
  },
  /** 棱镜：保存时点（可增删、无上限） */
  prismSetTimes(times: string[]): Promise<{ ok: boolean; settings: PrismSettings }> {
    return requestWithTimeout('/tradewatcher/prism', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'settings', times }),
    }, 20_000)
  },
  /** 棱镜：保存行业上限（P-11） */
  prismSetIndustryLimits(industryLimits: Record<string, number>): Promise<{ ok: boolean; settings: PrismSettings }> {
    return requestWithTimeout('/tradewatcher/prism', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'industryLimits', industryLimits }),
    }, 20_000)
  },
  /** 棱镜：保存骨架 */
  prismSetSkeleton(text: string): Promise<{ ok: boolean; text: string }> {
    return requestWithTimeout('/tradewatcher/prism', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'skeleton', text }),
    }, 20_000)
  },
  /** 棱镜：同步金十新闻（首次回填 24h / 之后增量） */
  prismNews(): Promise<{ ok: boolean; status: PrismNewsStatus }> {
    return requestWithTimeout('/tradewatcher/prism', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'news' }),
    }, 60_000)
  },
  /** 棱镜：手动补跑指定时点（只跑这一轮） */
  /** 棱镜：保存研判/自检模型（未知 provider 由宿主明确报错） */
  prismSetModel(provider: string, model: string): Promise<{ ok: boolean; settings: PrismSettings }> {
    return requestWithTimeout('/tradewatcher/prism', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'model', provider, model }),
    }, 20_000)
  },
  /** 模拟盘：改资金上限（入金） */
  prismCapital(capitalLimit: number): Promise<{ ok: boolean; account: PrismAccount }> {
    return requestWithTimeout('/tradewatcher/prism', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'capital', capitalLimit }),
    }, 20_000)
  },
  /** 模拟盘：按真实成本价重新复制持仓（留痕） */
  prismCopy(): Promise<{ ok: boolean; account: PrismAccount; error?: string }> {
    return requestWithTimeout('/tradewatcher/prism', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'copy' }),
    }, 30_000)
  },
  /** 模拟盘：撤销挂单（留痕） */
  prismCancel(orderId: string): Promise<{ ok: boolean; orders: PrismOrder[] }> {
    return requestWithTimeout('/tradewatcher/prism', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'cancel', orderId }),
    }, 20_000)
  },
  /** 运行时自检：真实调用一次 ctx.llm.stream（永远 200） */
  prismSelftest(): Promise<{ ok: boolean; error: string | null; model: string | null; elapsedMs: number; text: string | null; chunks: Array<{ type: string; keys: string[] }> }> {
    return runSelftest('/tradewatcher/prism/selftest')
  },

  prismRun(slot: string): Promise<{ ok: boolean; run: PrismRun }> {
    return requestWithTimeout('/tradewatcher/prism', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'run', slot }),
    }, 120_000)
  },
  /** 导出备份（P0-9）：GET /tradewatcher/backup */
  exportBackup(): Promise<{ ok: boolean; bundle: unknown; unreadable: string[] }> {
    return request('/tradewatcher/backup')
  },
  /** 导入备份（P0-9）：mode=preview 只校验，apply 才覆盖（覆盖前宿主写 .bak） */
  importBackup(mode: 'preview' | 'apply', bundle: unknown): Promise<{
    ok: boolean
    mode: string
    errors: string[]
    summary: Record<string, unknown>
    conflicts: string[]
    backedUp?: string[]
  }> {
    return request('/tradewatcher/backup', { method: 'POST', body: JSON.stringify({ mode, bundle }) })
  },
  /** 涨跌家数 + 历史分位（P1-8） */
  /**
   * 涨跌家数 + 历史分位（P1-8）。
   *
   * `dist: true` 会额外要一份【涨跌分布】直方图：那要多扫 ~56 页全市场涨跌幅，
   * 所以**默认不要**（其它调用方/工具保持原样、不付这个成本）。
   */
  breadth(opts: { dist?: boolean } = {}): Promise<{
    current: {
      up: number
      down: number
      even: number
      amount: number
      ratio: number | null
      /** 数字时刻：源 A = 行情时刻；自统计 = **统计完成时刻**（语义不同，界面要分别标） */
      asOf: number | null
      /** `em-index` = 上游直接给的；`em-clist` / `page-scan` = 本插件自行统计 */
      source: string
      /** 自统计时给出的统计口径（含哪些板块、平盘怎么界定）；源 A 为 null */
      caliber?: string | null
      /** 自统计的顺序不变量自检结论（排查用） */
      checks?: string[]
    } | null
    percentile: { metric: string; value: number | null; n: number; pct: number | null; sampleSmall: boolean; samples: number[] }
    window: number
    minDays: number
    storedDays: number
    storedThisCall: boolean
    /**
     * 昨日两市成交额（本地 `breadth.json` 的上一交易日快照）。没有那份快照 ⇒ `null`
     * —— 界面按"未取到 + 原因"显示，**不许**用今天的数顶替。
     */
    prevAmount: { day: string; amount: number; final: boolean } | null
    /** 只有 `dist: true` 时才出现；`counts: null` = 没扫全（原因在同项/`missing` 里），不给部分分布 */
    distribution?: {
      labels: string[]
      counts: number[] | null
      blank: number
      scanned: number
      total: number | null
      asOf: number
      reason: string | null
      /** 本轮实际答话的源：`em-clist`（东财分页）| `tencent-agg`（腾讯聚合）| null（都没成） */
      source?: 'em-clist' | 'tencent-agg' | null
      /** 覆盖三数：池内代码 / 有报价 / 停牌（停牌是"有报价"的子集，未计入任何档） */
      coverage?: { codes: number; quoted: number; suspended: number } | null
      /** 覆盖不足（少批/少报价）—— 此时界面写「已扫 k/N 批」，不写「覆盖 N 只」 */
      partial?: boolean
      scannedBatches?: number
      totalBatches?: number
      /** 口径告警（切源、失败批次、停牌数等），界面照原样展示，不吞 */
      warn?: string | null
      /** 同一次扫描里的五个家数（左侧 5 格直接取这五个，缺 ⇒ null 不写 0） */
      up?: number | null
      down?: number | null
      flat?: number | null
      limitUp?: number | null
      limitDown?: number | null
    }
    missing: Array<{ what: string; why: string; note: string }>
  }> {
    return request(opts.dist === true ? '/tradewatcher/breadth?dist=1' : '/tradewatcher/breadth')
  },
  /**
   * 年初至今（YTD）。口径写死在 `shared/model.ts` 的 `YTD_CALIBER`：
   * YTD =（现价 − 本年内第一个交易日收盘价）÷ 该收盘价 × 100%，前复权序列。
   * 缺失项在 `rows[].why` 与 `missing[]` 里都给出原因（不用 0 顶替）。
   */
  /** 五档状态 badge（宿主按日 memo；取不到/样本不足时 rows 里 level=null + why） */
  tones(secids: string[]): Promise<{ asOf: number | null; stale: boolean; source: string; day?: string; rows: ToneRowDto[]; missing: Array<{ what: string; why: string; note: string }>; requested: number; truncated: boolean; limit: number }> {
    const ids = [...new Set(secids)].join(',')
    if (ids === '') {
      return Promise.resolve({ asOf: null, stale: false, source: 'none', rows: [], missing: [], requested: 0, truncated: false, limit: 0 })
    }
    return request(`/tradewatcher/tones?ids=${encodeURIComponent(ids)}`)
  },
  ytd(secids: string[]): Promise<YtdPayload> {
    const ids = [...new Set(secids)].join(',')
    if (ids === '') {
      return Promise.resolve({ asOf: null, stale: false, source: 'none', rows: [], missing: [], requested: 0, truncated: false, limit: 0 })
    }
    return request(`/tradewatcher/ytd?ids=${encodeURIComponent(ids)}`)
  },
  /** 自选异动（P1-4）：放量/异动判定，含"为什么不判定"的原因 */  anomaly(secids: string[]): Promise<{
    rows: Array<{
      secid: string
      name: string
      kind: 'volume' | 'price' | 'both' | null
      mult: number | null
      samples: number
      pct: number | null
      reasons: string[]
      skip: string[]
    }>
    asOf: number
    missing: Array<{ what: string; why: 'no-source' | 'transient'; note: string }>
    source?: string
    stale?: boolean
  }> {
    const ids = [...new Set(secids)].join(',')
    if (ids === '') return Promise.resolve({ rows: [], asOf: Date.now(), missing: [] })
    return request(`/tradewatcher/anomaly?ids=${encodeURIComponent(ids)}`)
  },
  /** 侧栏徽标（P0-3）：与面板顶部同源的汇总数，不触发新采样 */
  badge(): Promise<{
    level: number
    levelLabel: string | null
    dayPnl: number
    dayPnlPct: number | null
    indexPoint: number | null
    indexPct: number | null
    indexName: string | null
    /** 非采样时段且原因是已收盘/周末 → 加后缀「收」 */
    settled: boolean
    asOf: number | null
    source: string
    missingCount: number
  }> {
    return request('/tradewatcher/badge')
  },
  quotes(secids: string[]): Promise<{
    /** 响应生成时刻（用于触发下游刷新），**不是**数据时刻 */
    ts: number
    items: Record<string, QuoteRow>
    /** 最新一次真实观测到行情的时间（epoch ms）；无有效行为 null */
    asOf: number | null
    /** 至少一行是兜底值/已过期（界面必须如实报警，而不是显示"刚刚更新"） */
    stale: boolean
    staleCount: number
    priced: number
    rows: number
    sources: Record<string, number>
    /** 请求了但没有任何源给出价格的标的（原样大小写）→ 界面显示「无行情源」 */
    missing: string[]
    /** 请求的标的数（含重复与超限项） */
    requested: number
    /** 是否因超过 160 项上限被截断 */
    truncated: boolean
    /** 休市定稿（非交易时段 + 无兜底行 + 有价）：卡片显示"定稿复用"灰点，未开盘不得显示绿色 */
    cached: boolean
  }> {
    const ids = [...new Set(secids)].join(',')
    if (ids === '') {
      return Promise.resolve({ ts: Date.now(), items: {}, asOf: null, stale: false, staleCount: 0, priced: 0, rows: 0, sources: {}, missing: [], requested: 0, truncated: false, cached: false })
    }
    return request(`/tradewatcher/quotes?ids=${encodeURIComponent(ids)}`)
  },
  /** `missing` 只在 `trend === null` 时给出：为什么没有（no-source / transient，见共享的 MissingField） */
  trend(secid: string, ndays = 1): Promise<{ trend: TrendData | null; missing?: MissingField[] }> {
    return request(`/tradewatcher/trend?secid=${encodeURIComponent(secid)}&ndays=${ndays}`)
  },
  /**
   * ATR14（「做T窗口」的间距来源）。只在开关打开时调用；`reason` 非空 ⇒ 界面整组不渲染并给原因。
   */
  /** 宿主健康（只读）：熔断状态 `breaker.open` 用于轮询退避（60s 内最多读一次） */
  health(): Promise<{ breaker?: { open?: boolean } }> {
    return request('/tradewatcher/health')
  },
  atr(secid: string): Promise<{ atr: { atr?: number; close?: number; pct?: number; bars?: number; reason: string | null } }> {
    return request(`/tradewatcher/atr?secid=${encodeURIComponent(secid)}`)
  },
  /**
   * 大盘页的**附加行情**（v0.81.2，只读镜像 `/tradewatcher/market-extras`）：
   * 涨停/跌停家数（池接口，含样本）、两融（深交所官方 + 东财**双源交叉**，不一致时两个读数都带）、
   * 全天成交额预测（只在盘中给值；收盘后回落实际值）。
   * ⚠ `amount` 传**页面自己已经显示的那个**当日成交额（宿主不再抓一遍）；缺/非正数 ⇒ 预测部分如实缺失。
   * ⚠ 类型是**线缆契约**（结构对齐宿主 `marketExtras.ts` 的导出）；客户端不 import 宿主模块。
   */
  marketExtras(amount: number | null = null): Promise<MarketExtras> {
    const q = amount === null || !(amount > 0) ? '' : `?amount=${encodeURIComponent(String(Math.round(amount)))}`
    return request(`/tradewatcher/market-extras${q}`)
  },
  /** fqt：0=不复权 1=前复权（默认）2=后复权；实际生效口径见回包 kline.fqt */
  kline(secid: string, klt: 101 | 102 | 103 | 104 = 101, lmt = 120, fqt: FqMode = 1): Promise<{ kline: KlineData | null; missing?: MissingField[] }> {
    return request(`/tradewatcher/kline?secid=${encodeURIComponent(secid)}&klt=${klt}&lmt=${lmt}&fqt=${fqt}`)
  },
  calendar(from: string, to: string, force = false): Promise<{
    events: CalEvent[]
    /** 最近一次**成功**同步时刻；从未成功过为 null（P0-2：失败时刻不改写数据时刻） */
    syncedAt: number | null
    /** 最近一次尝试时刻（不论成败） */
    syncAttemptAt: number | null
    /** 本次是否有源失败（含"从未成功同步"）→ 界面必须如实标注 */
    stale: boolean
    syncSources?: Array<{ key: string; label: string; state: 'ok' | 'failed' | 'skipped'; count: number; error?: string }>
    missing?: Array<{ what: string; why: string; note: string }>
    symbolCount: number
  }> {
    return request(`/tradewatcher/calendar?from=${from}&to=${to}${force ? '&force=1' : ''}`)
  },
  mutateCalendar(body: Record<string, unknown>): Promise<{
    ok: boolean
    events: CalEvent[]
    syncedAt: number | null
    syncAttemptAt: number | null
    stale: boolean
    syncSources?: Array<{ key: string; label: string; state: 'ok' | 'failed' | 'skipped'; count: number; error?: string }>
    missing?: Array<{ what: string; why: string; note: string }>
  }> {
    return request('/tradewatcher/calendar', { method: 'POST', body: JSON.stringify(body) })
  },
  trades(secid: string): Promise<{ trades: TradeMark[] }> {
    return request(`/tradewatcher/trades?secid=${encodeURIComponent(secid)}`)
  },
  /**
   * 复盘页（第 7 个页签）的月历（`ym` 形如 2026-10）。
   *
   * ⚠ 本方法里**只许**这一条路由字面量：行归属是按"api 函数体里第一个路由字面量"推导的
   * （`src/rowOwnership.test.ts`），塞第二条会把归属算错。同理，这两条路由的**唯一**调用方
   * 必须是 `FupanPage.tsx` 可达的模块（页面本体），不许在 `index.tsx`/`TopBar.tsx` 里调用。
   */
  fupanMonth(ym: string): Promise<FupanMonthPayload> {
    return request(`/tradewatcher/fupan/month?ym=${encodeURIComponent(ym)}`)
  },
  /** 复盘页的写入（`{ op:'upsert'|'delete', … }`；请求体由 fupanView.ts 的 `noteBodyOf` 单一构造） */
  fupanNote(body: Record<string, unknown>): Promise<FupanNoteResult> {
    return request('/tradewatcher/fupan/note', { method: 'POST', body: JSON.stringify(body) })
  },
  /**
   * 复盘页的**当日交易**（只读：持仓流水按日筛出 + 当日盈亏）。
   *
   * 归属：只被 `FupanPage.tsx` 消费 ⇒ `ROW_ROUTES.fupan`（行关掉 ⇒ 404，页面按「交易记录未取到」显示）。
   * ⚠ 本方法里**只许**这一条路由字面量（行归属按"函数体里第一个路由字面量"推导，见 `rowOwnership.test.ts`）。
   */
  fupanTrades(day: string): Promise<FupanTradesPayload> {
    return request(`/tradewatcher/fupan/trades?day=${encodeURIComponent(day)}`)
  },
  industry(secid: string): Promise<{ industry: { name: string; pct: number | null } | null }> {
    return request(`/tradewatcher/industry?secid=${encodeURIComponent(secid)}`)
  },
  industries(secids: string[]): Promise<{ map: Record<string, { name: string; pct: number | null }> }> {
    const ids = [...new Set(secids)].join(',')
    if (ids === '') return Promise.resolve({ map: {} })
    return request(`/tradewatcher/industries?secids=${encodeURIComponent(ids)}`)
  },
  detail(secid: string): Promise<{ detail: StockDetail | null; auction?: AuctionInfo; source?: 'eastmoney' | 'tencent' | null; missing?: MissingField[] }> {
    return request(`/tradewatcher/detail?secid=${encodeURIComponent(secid)}`)
  },
  /**
   * 竞价（四项 + 竞价时段采样序列）——**唯一的非东财详情类出口**。
   *
   * 为什么不从 `detail` 里拿：详情只有东财一个上游，东财熔断时 `detail: null`，而竞价的数据
   * 就在本机（`auction/<secid>.json`）+ 腾讯 m1 里。拆出来以后 "东财挂了" 不再连累 "竞价看不到"。
   * 契约：永远 200，`auction` 必有（不可用时 `state:'unavailable'` + 原因）。
   */
  auction(secid: string): Promise<{ auction: AuctionInfo; missing?: MissingField[] }> {
    return request(`/tradewatcher/auction?secid=${encodeURIComponent(secid)}`)
  },
  /**
   * 搜索候选（v0.95.1：**列出全部匹配**）。
   * `count` 是本次向宿主/上游要的条数（默认 50，服务端夹 1..100）。
   * 回包带 `requested`/`truncated`：拿满上限时**无法排除上游还有更多** ⇒ 界面必须如实写"上游本次上限"。
   */
  suggest(q: string, count = SUGGEST_FULL_COUNT): Promise<{ hits: SuggestItem[]; requested?: number; truncated?: boolean; reason?: string }> {
    return request(`/tradewatcher/suggest?q=${encodeURIComponent(q)}&count=${encodeURIComponent(String(count))}`)
  },
  board(scope: 'industry' | 'concept' | 'etf', sort: 'pct' | 'money' | 'amount', pn = 1): Promise<{
    total: number
    rows: BoardRow[]
    /** 上游不可用时回落上次成功结果 */
    stale?: boolean
    asOf?: number
    source?: QuoteSource
  }> {
    return request(`/tradewatcher/board?scope=${scope}&sort=${sort}&pn=${pn}&pz=40`)
  },
  rescue(force = false): Promise<{
    snapshot: RescueSnapshot
    history: RescueDaySummary[]
    calibration?: unknown
    breaker?: {
      open: boolean
      allOpen: boolean
      openHosts: number
      hosts: number
      minutesLeft: number
      allMinutesLeft: number
      lastError: string | null
      detail: Array<{ host: string; open: boolean; minutesLeft: number; trips: number; fails: number; lastError: string | null }>
    }
  }> {
    return request(`/tradewatcher/rescue${force ? '?force=1' : ''}`)
  },
  rescueDay(day: string): Promise<{ snapshot: RescueSnapshot; dayEvents: RescueSignalEvent[]; dayIntraday: RescueIntradayPoint[] }> {
    return request(`/tradewatcher/rescue?day=${encodeURIComponent(day)}`)
  },
  watch(): Promise<{ watch: WatchData }> {
    return request('/tradewatcher/watch')
  },
  mutateWatch(body: MutateWatchBody): Promise<{ watch: WatchData }> {
    return request('/tradewatcher/watch', { method: 'POST', body: JSON.stringify(body) })
  },
  /** 筹码分布（45 日 / 换手率衰减 / P5-P95）。宿主算好，界面只渲染 */
  chips(secid: string, days?: number): Promise<ChipsPayload> {
    const d = days === undefined ? '' : `&days=${Math.round(days)}`
    return request(`/tradewatcher/chips?secid=${encodeURIComponent(secid)}${d}`)
  },
  /** 活跃行清单（core 提供，永远可用）：tab gate 用；不可达时调用方**失败放行** */
  rows(): Promise<{ rows: string[]; asOf: number }> {
    return request('/tradewatcher/rows')
  },
  portfolio(): Promise<{
    view: PortfolioView
    stale: number
    /** 除权除息提示（P2-4），来自已同步的日历事件 */
    corporateActions?: CorporateAction[]
    /** 做T 同日往返配对（P1-3，宿主算好给界面用；与工具同一份实现） */
    dayTrades?: DayTradeView
  }> {
    return request('/tradewatcher/portfolio')
  },
  mutatePortfolio(body: MutatePortBody): Promise<{ view: PortfolioView; stale: number; corporateActions?: CorporateAction[]; dayTrades?: DayTradeView }> {
    return request('/tradewatcher/portfolio', { method: 'POST', body: JSON.stringify(body) })
  },
  ledger(groupId?: string, posId?: string, limit = 300): Promise<{ entries: LedgerView[] }> {
    const p = new URLSearchParams()
    if (groupId !== undefined) p.set('groupId', groupId)
    if (posId !== undefined) p.set('posId', posId)
    p.set('limit', String(limit))
    return request(`/tradewatcher/ledger?${p.toString()}`)
  },
  prefs(): Promise<{ prefs: PortPrefs }> {
    return request('/tradewatcher/prefs')
  },
  setPrefs(patch: Partial<PortPrefs>): Promise<{ prefs: PortPrefs }> {
    return request('/tradewatcher/prefs', { method: 'POST', body: JSON.stringify({ patch }) })
  },
}

// ── `/tradewatcher/market-extras` 的线缆契约（v0.81.2）────────────────────────
export interface LimitCountSideWire {
  count: number | null
  sample: Array<{ code: string; name: string; pct: number | null }>
  source: string
  at: number
}
export interface MarginReadingWire {
  marginBalance: number | null
  marginBuy: number | null
  shortBalance: number | null
  day: string | null
  source: string
}
export interface AmountForecastWire {
  current: number | null
  forecast: number | null
  band: { low: number; high: number } | null
  progress: number | null
  caliber: { curve: string; samples: number; generatedAt: string; note: string }
  actual: number | null
  phase: 'pre' | 'intraday' | 'closed' | 'non-trading'
  missing: MissingField[]
}
export type MarginCrossWire = MarketExtras['margin']
interface MarketExtras {
  limits: { up: LimitCountSideWire; down: LimitCountSideWire; missing: MissingField[]; caliber: string }
  margin: { szse: MarginReadingWire | null; em: MarginReadingWire | null; diffPct: number | null; mismatch: boolean; note: string; missing: MissingField[] }
  forecast: AmountForecastWire
  asOf: number
}
