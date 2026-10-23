/**
 * 【棱镜】批次 1+2 的共享契约：调度设置 / 骨架 / 金十新闻 / 研判运行。
 * 页面与路由共用同一份字段名（错一个就会被断言抓住）。
 */

export interface PrismSettings {
  /** `HH:MM`（Asia/Shanghai），默认 09:35 / 11:20 / 13:10 / 14:40；可增删、无上限 */
  times: string[]
  /** 研判/自检使用的模型；缺省用 agentDefaultModel.currentSelection() */
  model?: { provider: string; model: string } | null
  /** 每个交易日已触发的时点（`YYYY-MM-DD` → `HH:MM[]`），进程重启不丢 */
  lastFired: Record<string, string[]>
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
  /** 分报告角色（A股宏观/外盘/大宗/信息面） */
  role: string
  text: string | null
  error: string | null
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
  /** 宿主可用模型（provider → model ids）；取不到则为空并给原因 */
  modelCatalog?: { providers: Array<{ id: string; name: string }>; models: Record<string, string[]>; error: string | null }
}

export const PRISM_DEFAULT_TIMES = ['09:35', '11:20', '13:10', '14:40'] as const
export const PRISM_MAX_TIMES = 50
export const PRISM_SKELETON_MAX = 20_000
export const PRISM_NEWS_KEEP_MS = 24 * 3_600_000
export const PRISM_NEWS_PAGE_MAX = 10
export const PRISM_NEWS_GAP_MS = 3_000
export const PRISM_RUNS_KEEP = 20

export const PRISM_ANALYSIS_META: ReadonlyArray<{ key: PrismAnalysis['key']; label: string; prompt: string }> = [
  { key: 'a-macro', label: 'A股宏观', prompt: '聚焦 A股宏观：政策、流动性、指数与风格。只给判断与依据，不写免责声明。' },
  { key: 'overseas', label: '外盘', prompt: '聚焦外盘：美股、美债、汇率与主要指数。只给判断与依据，不写免责声明。' },
  { key: 'commodity', label: '大宗', prompt: '聚焦大宗商品：原油、贵金属、有色与黑色。只给判断与依据，不写免责声明。' },
  { key: 'info', label: '信息面', prompt: '聚焦信息面：金十快讯里对 A股有影响的事件与主题。只给判断与依据，不写免责声明。' },
]

export const PRISM_DEFAULT_SKELETON = `# 棱镜研判骨架（可编辑）

- 视角：以持仓为中心，先风险后机会。
- 顺序：A股宏观 → 外盘 → 大宗 → 信息面 → 汇总。
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
  fillPrice?: number
  filledAt?: number
  fee?: number
  source?: '1min' | 'trend'
  rejectReason?: string
  cancelledAt?: number
  cancelReason?: string
}

export interface PrismEquityPoint {
  day: string
  equity: number
  cash: number
  positionsValue: number
  realized: number
  unrealized: number
  at: number
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

export interface PrismAccount {
  /** 当前账本所属交易日（T+1/挂单当日有效的基准） */
  day: string
  capitalLimit: number
  cash: number
  realized: number
  dayStartEquity: number | null
  positions: PrismPosition[]
  copiedAt: number | null
  copyLogs: PrismCopyLog[]
}

export interface PrismDecision {
  limits: { singlePct: number | null; totalPct: number | null; note: string | null }
  /** 本轮决策理由（一句话；orders 为空也必须给） */
  note?: string | null
  orders: Array<{ secid: string; side: 'buy' | 'sell'; price: number; shares: number; reason: string }>
  cancel: string[]
  /** 引擎拒绝的委托（盘后/资金/约束），带原因；不是「模型没动作」 */
  rejects: Array<{ secid: string; side: 'buy' | 'sell'; price: number; shares: number; reason: string }>
  /** 汇总 JSON 解析失败时的原文（不得静默成 0 笔） */
  parseError: string | null
}

export interface PrismTradingState {
  account: PrismAccount
  orders: PrismOrder[]
  fills: PrismFill[]
  equity: PrismEquityPoint[]
  decision: PrismDecision | null
  /** 现价（按 secid；取不到 ⇒ null，界面 `—` + 原因） */
  prices?: Record<string, number | null>
}
