/**
 * 【棱镜】批次 1+2 的共享契约：调度设置 / 骨架 / 金十新闻 / 研判运行。
 * 页面与路由共用同一份字段名（错一个就会被断言抓住）。
 */

export interface PrismSettings {
  /**
   * `HH:MM`（Asia/Shanghai）**手动补跑 / 重放**用的时点，默认 09:35 / 11:20 / 13:10 / 14:40。
   *
   * ⚠ 自动决策已改由 `intervalSec` 周期驱动（见 `PrismScheduler`）：本字段**不再自动触发**，
   * 只在手动「重放今日」/ `{action:'run', slot}` 时使用。保留字段是为了不破坏旧文件与手动路径。
   */
  times: string[]
  /**
   * 自动决策周期（秒）：300 / 600 / 1200 / 1800 / 3600，缺省 600。
   *
   * 只在 A 股交易时段（09:30–11:30 / 13:00–15:00）内按此周期触发：落在时段内且
   * `now − lastAutoAt ≥ 周期` ⇒ 触发；每个时段开盘后的第一次立即触发。
   */
  intervalSec?: number
  /**
   * 上次**自动**决策的触发时刻（epoch ms）：跑完写盘，进程重启不丢（重启后不立刻重复触发）。
   * 手动补跑不写本字段（手动不占用自动节奏）；旧文件缺字段 ⇒ 视为从未自动跑过。
   */
  lastAutoAt?: number
  /** 模拟盘资金上限（持久化；入金 = 上限与现金同步 +delta） */
  capital?: number
  /** 成交参与率上限（默认 0.10；成交股数 ≤ volume × 该值） */
  participationRate?: number
  /** 行业展示上限（百分比；缺失 ⇒ 表格上限 `—`，不猜） */
  industryLimits?: Record<string, number>
  /** 研判/自检使用的模型；缺省用 agentDefaultModel.currentSelection() */
  model?: { provider: string; model: string } | null
  /** 每个交易日已触发的时点（`YYYY-MM-DD` → `HH:MM[]`），进程重启不丢 */
  lastFired: Record<string, string[]>
  /** v0.203.0 约束六字段（B5）：单票上限% / 止损% / 单笔金额元 / 总仓上限% / 日回撤熔断% / 现金下限% */
  perStockPct?: number | null
  stopLossPct?: number | null
  perOrderYuan?: number | null
  maxPosPct?: number | null
  maxDDPct?: number | null
  minCashPct?: number | null
  /** 累计回撤熔断%（v0.222.0；缺省 10，0 = 关闭该维度） */
  maxCumDDPct?: number | null
  /** 自动做T：总开关与逐只开关（其余参数由 Agent/引擎决定，不落用户配置） */
  autoT?: { enabled: boolean; positions: Record<string, { enabled: boolean }> }
  /** 累计决策轮次（历史总数；runs 只保留最近 20 条） */
  runsTotal?: number
  /** 回撤闸门基线时刻（v0.222.0）：账本校平后只统计此刻之后的净值点，累计回撤从 0 重新起算 */
  gateBaseAt?: number
}

export interface PrismNewsItem {
  id: string
  /** `YYYY-MM-DD HH:mm:ss`（金十原始，东八区） */
  time: string
  text: string
  important: boolean
}

export type PrismNewsState = 'idle' | 'backfilling' | 'ready' | 'error'

export interface PrismNewsStatus {
  state: PrismNewsState
  /** 本次回填已完成页数 */
  pages: number
  lastSeenId: string | null
  fetchedAt: number | null
  reason: string | null
  items: number
}

export interface PrismAnalysis {
  key: 'a-macro' | 'overseas' | 'commodity' | 'info'
  label: string
  text: string | null
  error: string | null
}

export interface PrismReport {
  /** 分报告角色（技术面/外盘/大宗/信息面） */
  role: string
  text: string | null
  error: string | null
}

export interface PrismPlacement {
  /** 本轮新进入 pending 的挂单数 */
  placed: number
  /** 去重/无法处理而跳过的笔数 */
  skipped: number
  /** 被引擎拒绝的委托（含原因；不是静默） */
  rejects: Array<{ secid: string; reason: string }>
  /** 跳过原因（skipped>0 时必填） */
  skippedReasons?: Array<{ secid: string; reason: string }>
}

export interface PrismRun {
  /** 触发时点（手动补跑也写时点；`manual` 用于非时点补跑） */
  slot: string
  /** 北京日期 `YYYY-MM-DD` */
  day: string
  /** 北京时刻 ISO（含 +08:00） */
  at: string
  /** 四份分报告（逐份落盘 + 回包） */
  reports: PrismReport[]
  /** 本轮 agent 给出的仓位上限/挂单/撤单（解析失败 ⇒ null） */
  decision?: PrismDecision | null
  /** 本轮落库结果（自动时点与手动补跑都必须有） */
  placement?: PrismPlacement
  /** 构建注入的代码版本（禁止手写） */
  codeVersion?: string
  /** 骨架 + settings 参数（剔除运行时水位 lastFired / lastAutoAt）的全 sha256 */
  mandateHash?: string
  /** P-20 回撤闸门（本轮计算 + 上一轮触发状态用于连续两次冻结） */
  drawdown?: PrismDrawdownGate
  startedAt: number
  finishedAt: number | null
  analyses: PrismAnalysis[]
  summary: string | null
  error: string | null
}

export interface PrismModelInfo {
  provider: string | null
  model: string | null
  error: string | null
}

export interface PrismState {
  settings: PrismSettings
  skeleton: string
  news: PrismNewsStatus
  runs: PrismRun[]
  model: PrismModelInfo
  /** 模拟盘状态（GET `/tradewatcher/prism` 顶层同时返回 `trading`） */
  account?: PrismAccount
  orders?: PrismOrder[]
  fills?: PrismFill[]
  equity?: PrismEquityPoint[]
  decision?: PrismDecision | null
  prices?: Record<string, number | null>
  exposure?: PrismExposure | null
  evaluation?: PrismEvaluation | null
  /** 宿主可用模型（provider → model ids）；取不到则为空并给原因 */
  modelCatalog?: { providers: Array<{ id: string; name: string }>; models: Record<string, string[]>; error: string | null }
}

export const PRISM_DEFAULT_CAPITAL = 1_500_000
export const PRISM_DEFAULT_TIMES = ['09:35', '11:20', '13:10', '14:40'] as const
/** 决策周期可选值（秒）；与 `PrismSettings.intervalSec` 同一口径（v0.209.0 起改为 5 档） */
export const PRISM_INTERVAL_OPTIONS = [300, 600, 1200, 1800, 3600] as const
/** 决策周期默认值（秒）：未保存过 ⇒ 600s */
export const PRISM_DEFAULT_INTERVAL_SEC = 600
export const PRISM_MAX_TIMES = 50
export const PRISM_SKELETON_MAX = 20_000
export const PRISM_NEWS_KEEP_MS = 24 * 3_600_000
export const PRISM_NEWS_PAGE_MAX = 10
export const PRISM_NEWS_GAP_MS = 3_000
export const PRISM_RUNS_KEEP = 20

export const PRISM_ANALYSIS_META: ReadonlyArray<{ key: PrismAnalysis['key']; label: string; prompt: string }> = [
  {
    key: 'a-macro',
    label: '技术面',
    prompt: '聚焦 A股技术面：只解读【指数技术面】里的指标与量能动量（中证1000/中证2000/沪深300/科创50/科创半导体ETF），'
      + '逐只说清趋势（均线排列）、动能（MACD/RSI）、量能（量比）与区间位置，给出对风格（小微盘/蓝筹/科技）的含义。'
      + '不要解读新闻与政策（新闻统一由信息面分析）。只给判断与依据，不写免责声明。',
  },
  { key: 'overseas', label: '外盘', prompt: '聚焦外盘：美股、美债、汇率与主要指数。只给判断与依据，不写免责声明。' },
  { key: 'commodity', label: '大宗', prompt: '聚焦大宗商品：原油、贵金属、有色与黑色。只给判断与依据，不写免责声明。' },
  {
    key: 'info',
    label: '信息面',
    prompt: '聚焦信息面：统一解读近 24h 金十快讯（宏观/政策/行业/公司）对 A股与现存持仓的影响，'
      + '给出事件→受影响标的→方向与力度。新闻解读只在本段出现，其他段不得重复转述新闻。只给判断与依据，不写免责声明。',
  },
]

export const PRISM_DEFAULT_SKELETON = `# 棱镜研判骨架（可编辑）

- 视角：以持仓为中心，先风险后机会。
- 顺序：技术面 → 外盘 → 大宗 → 信息面 → 汇总。
- 输出：每段给「判断 / 依据 / 需要盯的变量」，不写免责声明。
- 缺失数据写 — 并给一句原因。`


/* ────────────────────────── 批次 3：模拟盘 ────────────────────────── */

export interface PrismPosition {
  secid: string
  name: string
  qty: number
  /** T+1：今日可卖（当日买入不加进来） */
  available: number
  /** 摊薄成本价：(累计买入含费 − 累计卖出净额) ÷ 剩余数量 */
  cost: number
  /** 摊薄净成本（口径唯一事实源；旧账本无此字段时按 qty×cost 回退） */
  netCost?: number
  /**
   * 买入均价（**卖出不变**；v0.222.2）。用于止损判定：
   * 摊薄成本会因亏损卖出而抬高 ⇒ 越卖越"亏"，触发止损再卖，形成卖出循环。
   */
  avgCost?: number
}

export interface PrismFill {
  orderId: string
  secid: string
  name: string
  side: 'buy' | 'sell'
  price: number
  shares: number
  amount: number
  fee: number
  /** 本笔佣金（累计口径；同一委托最低佣金只收一次） */
  commission?: number
  at: number
  source: '1min' | 'trend'
}

export interface PrismOrder {
  id: string
  secid: string
  name: string
  side: 'buy' | 'sell'
  price: number
  shares: number
  reason: string
  decidedAt: number
  /** 挂单所属交易日（`YYYY-MM-DD`）；跨日自动失效 */
  day: string
  status: 'pending' | 'filled' | 'cancelled' | 'rejected'
  /** 最近处理的 bar 时间；同一 bar 不重复下单，下一根 bar 才推进 */
  lastBarTime?: number
  /** v0.241.0：自动做T 委托（并入主挂单管线） */
  channel?: 'autoT'
  tPlanId?: string
  pairId?: string
  leg?: 'open' | 'close'
  /** 自动做T 截止时刻（epoch ms）：到点撤单 */
  expireAt?: number
  /** 已成交股数（部分成交时 < shares；status 仍 pending，余量排队） */
  filledShares?: number
  /** 本轮不成交的稳定原因码（vol-missing / vol-zero / trend-no-1min / transient-source） */
  skipCode?: string
  /** 本轮不成交原因（UI「原因」列；不写 = rejected） */
  skipReason?: string
  fillPrice?: number
  filledAt?: number
  fee?: number
  source?: '1min' | 'trend'
  rejectReason?: string
  /** v0.202.0：委托来源；旧订单无此字段 ⇒ 读取方按 'unknown' 处理（不回填猜测） */
  origin?: 'auto' | 'manual'
  cancelledAt?: number
  cancelReason?: string
  /** 撤单原因码：manual / model-cancel / replaced / gate-triggered / expired / switch-off / copy-reset */
  cancelCode?: string
  /** 人工错价订正留痕：每次订正一条，不覆盖历史 */
  corrections?: Array<{ at: number; oldPrice: number; newPrice: number; delta: number; basis: string }>
}

export interface PrismEquityPoint {
  day: string
  equity: number
  /** 当日资金上限（用于资本调整后收益；旧点缺省 ⇒ 调整后收益不可算） */
  capital?: number
  /** 沪深300收盘（1.000300）；未取到 ⇒ null / 缺省 */
  benchmarkClose?: number | null
  cash: number
  positionsValue: number
  realized: number
  unrealized: number
  at: number
  /** 读取/口径告警（如 dayStartEquity 与前一收盘差 >1；不改变数值） */
  warnings?: string[]
}

export interface PrismCopyLog {
  at: number
  before: string[]
  after: string[]
  /** 复制说明（部分复制/超限原因） */
  note?: string
  /** 未能覆盖的行（逐条原因） */
  skipped?: string[]
}

export interface PrismFeeCorrection {
  at: number
  secid: string
  orderIds: string[]
  orderKey: string
  beforeFee: number
  afterFee: number
  credit: number
  reason: '拆单重复收取最低佣金'
}

export interface PrismAccount {
  /** 当前账本所属交易日（T+1/挂单当日有效的基准） */
  day: string
  /** 与 settings.capital 同值的对外别名（capitalLimit 为历史字段） */
  capital?: number
  capitalLimit: number
  cash: number
  realized: number
  dayStartEquity: number | null
  /** 当日开盘持仓快照（收盘对账用；缺失 = 老账本未记录） */
  dayOpenQty?: Record<string, number>
  positions: PrismPosition[]
  copiedAt: number | null
  copyLogs: PrismCopyLog[]
  /** 历史费用订正（幂等；原始 fills 不动） */
  feeCorrections?: PrismFeeCorrection[]
}

export type PrismIndustryLimits = Record<string, number> | Array<{ name: string; limitPct: number }>

export interface PrismClampEvent {
  at: number
  secid: string
  dimension: 'single' | 'industry' | 'total' | 'cash' | 'perStock' | 'perOrder' | 'maxPos' | 'minCash' | 'maxDD' | 'stopLoss' | 'available'
  before: number
  after: number
  basis: string
}

/** 缺数据而**未做**的校验（不是失败，也不许把「没查」说成「查过没问题」）：只留痕，不拦单 */
export interface PrismClampSkip {
  secid: string
  /** product = 同产品重复闸；deviation = 委托价偏离闸；stopLoss = 缺买入均价未判止损 */
  gate: 'product' | 'deviation' | 'stopLoss'
  /** 为什么没查（缺现价 / 缺名称），不得编数 */
  reason: string
}

export interface PrismDecision {
  limits: { singlePct: number | null; totalPct: number | null; note: string | null; byIndustry?: PrismIndustryLimits }
  /** 本轮决策理由（一句话；orders 为空也必须给） */
  note?: string | null
  orders: Array<{ secid: string; side: 'buy' | 'sell'; price: number; shares: number; reason: string }>
  cancel: string[]
  /** v0.241.0：自动做T 计划（不占 orders；由引擎转成配对挂单） */
  tPlans?: Array<{
    secid: string; direction: 'buy-first' | 'sell-first'
    buyPrice: number; sellPrice: number; shares: number
    /** P1-3：回显已有计划的 pairId ⇒ 引擎保留该腿（条件不变不要逐轮重挂） */
    pairId?: string
    observe?: string | null; reasoning?: string | null; conclusion?: string | null
  }>
  /** 引擎拒绝的委托（盘后/资金/约束），带原因；不是「模型没动作」 */
  rejects: Array<{ secid: string; side: 'buy' | 'sell'; price: number; shares: number; reason: string }>
  /** 汇总 JSON 解析失败时的原文（不得静默成 0 笔） */
  parseError: string | null
  /** 确定性裁剪留痕（只裁模型已给的单，不新建） */
  clampEvents?: PrismClampEvent[]
  /** v0.214.0：缺数据未做的校验（不拦；落 run 以便事后核对「闸到底跑没跑」） */
  clampSkipped?: PrismClampSkip[]
}

export interface PrismExposureRow {
  name: string
  value: number
  weight: number
  kind: 'industry' | 'wide' | 'unpenetrated' | 'cash'
  /** 宽基族级（大盘/中小盘/成长；同族多 ETF 合并后仍标；无则 null） */
  family?: '大盘' | '中小盘' | '成长' | '混合' | null
  limitPct: number | null
  status: '超限' | '正常' | '待穿透' | '可用'
}

export interface PrismExposure {
  /** ok = 可展示；unavailable = 缺行业归属，表体必须显示 — + reason */
  state: 'ok' | 'unavailable'
  reason?: string
  rows: PrismExposureRow[]
  classifiedPct: number
  unclassifiedPct: number
  unpenetratedPct: number
  cashPct: number
  total: number
}

export interface PrismEvalMetric {
  value: number | null
  reason: string | null
  n: number
}

export interface PrismEvalExcess {
  withFee: number | null
  withoutFee: number | null
  reason: string | null
  n: number
}

export interface PrismEvaluation {
  excess: PrismEvalExcess
  drawdown: PrismEvalMetric
  hitRate: PrismEvalMetric
  /** 独立窗口数（不是事件数） */
  n: number
  embargoDays: number
  footnote: string
  /** 累计超额曲线（每个独立窗口一个点，%） */
  curve: number[]
  reason: string | null
}

export interface PrismDrawdownGate {
  dailyPct: number | null
  cumulativePct: number | null
  peak: number | null
  triggered: boolean
  dailyTriggered: boolean
  cumulativeTriggered: boolean
  targetTotalPct: number
  cashMinPct: number
  /** 连续两次触发后的单轮冻结 */
  freezeRound: boolean
  status: '正常' | '已拒新买单' | '未启用（样本不足）'
  n: number
  reason: string | null
  at: number
}

export interface PrismTradingState {
  account: PrismAccount
  orders: PrismOrder[]
  fills: PrismFill[]
  equity: PrismEquityPoint[]
  decision: PrismDecision | null
  /** 现价（按 secid；取不到 ⇒ null，界面 `—` + 原因） */
  prices?: Record<string, number | null>
  /** 行业暴露（宿主按既有 f127 聚合；缺数据保留未穿透） */
  exposure?: PrismExposure | null
  /** P-03/P-02 评估（始终给出对象；样本不足用 —+原因） */
  evaluation?: PrismEvaluation | null
}
