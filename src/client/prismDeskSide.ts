/**
 * 棱镜 · AGENT DESK（第二批：右栏 + 底部状态条）展示纯函数。
 *
 * 口径（与 `docs/PRISM-DESIGN-DIFF.md` §8–§11 一致，差异写在各函数注释里）：
 * - 今日盈亏 = 总资产 − 账户 `dayStartEquity`（宿主当日开盘净值，唯一事实源）；
 * - 累计 = 总资产 − 资产上限（`capitalLimit`）；两者都不做「编一个基准」的兜底；
 * - 今日已实现 = 今日净值点 `realized` − 上一净值点 `realized`（宿主每日一个净值点，同日覆盖）；
 * - 胜率 / 回撤 / 超额宿主给 `null` ⇒ `—`（样本不足 / 缺基准），**不写 0**；
 * - 行情源 / 温度 / 约束版本宿主无字段 ⇒ `—` + title 原因。
 */
import type { Tone } from './prismDeskMid.ts'
import { shClockText } from './marketTime.ts'
import { PRISM_DEFAULT_INTERVAL_SEC, PRISM_INTERVAL_OPTIONS } from '../shared/prism.ts'

const finite = (v: number | null | undefined): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v : null

const toneOf = (v: number | null): Tone => (v === null || v === 0 ? 'flat' : v > 0 ? 'up' : 'down')

/** 千分位金额（默认 2 位小数）：1582253.68 ⇒ `1,582,253.68`；缺失 ⇒ `—` */
export function moneyOf(v: number | null | undefined, digits = 2): string {
  const n = finite(v)
  if (n === null) return '—'
  const fixed = Math.abs(n).toFixed(digits)
  const dot = fixed.indexOf('.')
  const int = dot < 0 ? fixed : fixed.slice(0, dot)
  const frac = dot < 0 ? '' : fixed.slice(dot)
  const grouped = int.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  const negative = n < 0 && Number(fixed) !== 0
  return `${negative ? '-' : ''}${grouped}${frac}`
}

/** 带符号金额：-11603.82 ⇒ `-11,603.82`；+240 ⇒ `+240.00` */
export function signedMoneyOf(v: number | null | undefined, digits = 2): string {
  const n = finite(v)
  if (n === null) return '—'
  const t = moneyOf(n, digits)
  return n > 0 ? `+${t}` : t
}

/** 带符号百分比（已是百分数）：-0.73 ⇒ `-0.73%` */
export function signedPctOf(v: number | null | undefined, digits = 2): string {
  const n = finite(v)
  if (n === null) return '—'
  return `${n > 0 ? '+' : ''}${n.toFixed(digits)}%`
}

/** 比例 → 百分比（0.7838 ⇒ `78.4%`，一位小数；用于仓位条读数） */
export function ratioPctOf(v: number | null | undefined, digits = 1): string {
  const n = finite(v)
  if (n === null) return '—'
  return `${(n * 100).toFixed(digits)}%`
}

/* ────────────────────────── 账户总览 ────────────────────────── */

export interface SidePositionRow { marketValue?: number | null; pnl?: number | null; kind?: 'cash' }
export interface EquityPointLike { day: string; realized: number; capital?: number | null }

/** 浮盈合计：任一行缺 pnl ⇒ null（不部分求和，与左栏同一口径） */
function sumOf(rows: ReadonlyArray<SidePositionRow>, key: 'marketValue' | 'pnl'): number | null {
  // 现金行（kind:'cash'）不是持仓：计入「持仓市值/浮动盈亏」会把现金重复算一遍（实测多报 34.9%）
  const held = rows.filter((r) => r.kind !== 'cash')
  if (held.length === 0) return null
  let sum = 0
  for (const r of held) {
    const v = finite(r[key])
    if (v === null) return null
    sum += v
  }
  return sum
}

/**
 * 今日已实现 = 今日净值点的 realized − 上一净值点的 realized。
 * 只有「最后一个点就是今天」且至少两个点时才给值；否则 null（不拿累计值冒充当日）。
 */
export function realizedTodayOf(equity: ReadonlyArray<EquityPointLike>, day: string | null | undefined): number | null {
  if (day === null || day === undefined || day === '') return null
  if (equity.length < 2) return null
  const last = equity[equity.length - 1]
  const prev = equity[equity.length - 2]
  if (last === undefined || prev === undefined || last.day !== day) return null
  const a = finite(last.realized)
  const b = finite(prev.realized)
  if (a === null || b === null) return null
  return a - b
}

export interface AccountCell { key: string; label: string; value: string; tone: Tone; title: string }

export interface AccountView {
  totalText: string
  dayPnl: number | null
  dayText: string
  dayPctText: string
  dayTone: Tone
  cumPnl: number | null
  cumText: string
  cumPctText: string
  cumTone: Tone
  cells: AccountCell[]
  /** 仓位比例（0–1）；缺失 ⇒ null（进度条按 0 宽画但读数是 `—`） */
  positionRatio: number | null
  positionText: string
}

export interface AccountInput {
  totalAssets: number | null
  capitalLimit: number | null
  dayStartEquity: number | null
  /** 可用资金 = 现金（desk.overview.cash）；不是「可用额度」available */
  cash: number | null
  positionPct: number | null
  rows: ReadonlyArray<SidePositionRow>
  equity: ReadonlyArray<EquityPointLike>
  day: string | null
}

/** 账户总览：大数 + 今日/累计 + 四格 + 仓位 */
export function accountViewOf(input: AccountInput): AccountView {
  const total = finite(input.totalAssets)
  const start = finite(input.dayStartEquity)
  const limit = finite(input.capitalLimit)
  const dayPnl = total !== null && start !== null && start > 0 ? total - start : null
  const dayPct = dayPnl !== null && start !== null && start > 0 ? (dayPnl / start) * 100 : null
  // 累计基准：优先取 `state.equity` 最后一点的当日资本（与 capitalLimit 同源），缺该点再回退上限
  const equityLast = input.equity.length === 0 ? null : input.equity[input.equity.length - 1]
  const equityCapital = equityLast === null ? null : finite(equityLast.capital)
  const cumBase = equityCapital !== null && equityCapital > 0 ? equityCapital : limit
  const cumPnl = total !== null && cumBase !== null && cumBase > 0 ? total - cumBase : null
  const cumPct = cumPnl !== null && cumBase !== null && cumBase > 0 ? (cumPnl / cumBase) * 100 : null
  const mvSum = sumOf(input.rows, 'marketValue')
  const pnlSum = sumOf(input.rows, 'pnl')
  const realized = realizedTodayOf(input.equity, input.day)
  const ratio = finite(input.positionPct)
  return {
    totalText: moneyOf(total),
    dayPnl,
    dayText: signedMoneyOf(dayPnl),
    dayPctText: signedPctOf(dayPct),
    dayTone: toneOf(dayPnl),
    cumPnl,
    cumText: signedMoneyOf(cumPnl),
    cumPctText: signedPctOf(cumPct),
    cumTone: toneOf(cumPnl),
    cells: [
      { key: 'cash', label: '可用资金', value: moneyOf(input.cash), tone: 'flat', title: input.cash === null ? '宿主未给出现金余额' : '现金（desk.overview.cash）' },
      { key: 'mv', label: '持仓市值', value: moneyOf(mvSum), tone: 'flat', title: 'Σ 持仓市值（desk.positions.rows）' },
      { key: 'float', label: '浮动盈亏', value: signedMoneyOf(pnlSum), tone: toneOf(pnlSum), title: pnlSum === null ? '存在缺现价的持仓，浮盈不可算' : 'Σ 持仓盈亏' },
      { key: 'realized', label: '今日已实现', value: signedMoneyOf(realized), tone: toneOf(realized), title: realized === null ? '缺今日或上一净值点，今日已实现不可算' : '今日净值点 realized − 上一净值点 realized' },
    ],
    positionRatio: ratio,
    positionText: ratioPctOf(ratio),
  }
}

/* ────────────────────────── 持仓 / 挂单 ────────────────────────── */

export interface PanelOrderInput {
  id: string
  name: string
  side: 'buy' | 'sell'
  price: number
  shares: number
  status: string
  filledShares?: number
  decidedAt: number
}

/** 挂单 = 仍在队列里的（pending）；旧订单没有 pending 一律不显示 */
export function pendingOrdersOf(orders: ReadonlyArray<PanelOrderInput>): PanelOrderInput[] {
  return orders.filter((o) => o.status === 'pending')
}

/** 成交进度（0–1）；缺 filledShares ⇒ 0（未成交），股数 ≤0 ⇒ 0 */
export function orderProgressOf(o: Pick<PanelOrderInput, 'shares' | 'filledShares'>): number {
  const total = finite(o.shares)
  const done = finite(o.filledShares) ?? 0
  if (total === null || total <= 0) return 0
  return Math.max(0, Math.min(1, done / total))
}

/* ────────────────────────── Agent 绩效 ────────────────────────── */

export interface PerfCell { key: string; label: string; value: string; title: string }

export interface PerfInput {
  runsCount: number | null
  tradingDays?: number | null
  hitRate: number | null
  maxDrawdown: number | null
  excessPct: number | null
}

/**
 * 四格 `决策 / 胜率 / 回撤 / 超额`。
 * 宿主任一指标为 null ⇒ `—` + title（样本不足 / 缺基准），**不写 0**。
 */
export function perfCellsOf(p: PerfInput): PerfCell[] {
  const tradingDays = finite(p.tradingDays)
  return [
    { key: 'runs', label: '交易日', value: tradingDays === null ? '—' : String(Math.trunc(tradingDays)), title: '从建立模拟盘到当前的交易日数（按交易日历计算）' },
    { key: 'hit', label: '胜率', value: signedPctOrDash(p.hitRate), title: p.hitRate === null ? '宿主样本不足，胜率不可算' : '评估窗口胜率' },
    { key: 'dd', label: '回撤', value: signedPctOrDash(p.maxDrawdown), title: p.maxDrawdown === null ? '宿主未给回撤评估值' : '最大回撤' },
    { key: 'excess', label: '超额', value: signedPctOrDash(p.excessPct), title: p.excessPct === null ? '缺基准收益（净值点无沪深300收盘）' : '相对基准超额' },
  ]
}

/** 绩效百分比：没有小数位修饰，`+1.24%` / `—` */
function signedPctOrDash(v: number | null | undefined): string {
  const n = finite(v)
  return n === null ? '—' : `${n > 0 ? '+' : ''}${n.toFixed(2)}%`
}

export interface SparkView { points: Array<{ t: number; value: number }>; up: boolean; has: boolean }

/** 净值 sparkline：取最近 `n` 个净值点（不足 2 个 ⇒ has=false，界面写 —） */
export function sparkOf(equity: ReadonlyArray<{ equity: number }>, n = 20): SparkView {
  const tail = equity.slice(Math.max(0, equity.length - Math.max(2, n)))
  const points = tail
    .map((p, i) => ({ t: i, value: finite(p.equity) }))
    .filter((p): p is { t: number; value: number } => p.value !== null)
  if (points.length < 2) return { points, up: true, has: false }
  return { points, up: points[points.length - 1].value >= points[0].value, has: true }
}

/* ────────────────────────── 底部状态条 ────────────────────────── */

export interface StatusFact { key: string; label: string; value: string; title: string | null }

export interface StatusInput {
  /** 行情源标识；宿主无字段 ⇒ null */
  feed: string | null
  /** 决策引擎（`state.model.model`） */
  model: string | null
  modelProvider: string | null
  /** 温度；宿主无字段 ⇒ null */
  temperature: number | null
  times: ReadonlyArray<string>
  /**
   * 决策周期（秒）；页面传 `settings.intervalSec ?? 600`。
   * 不传 ⇒ `cycle` 仍按 `times` 时点列表显示（兼容旧调用；`times` 只用于手动重放）。
   */
  intervalSec?: number | null
  /** 约束版本；宿主无字段 ⇒ null */
  constraintVersion: string | null
  /** 今日风控拦截笔数；无法统计 ⇒ null */
  blockedToday: number | null
}

/** `intervalSec` 只认同源档位（300/600/1200/1800/3600）；缺失或非法（含旧档 900）⇒ 600 */
export function intervalSecOf(settings: { intervalSec?: number | null } | null | undefined): number {
  const v = settings?.intervalSec
  return typeof v === 'number' && (PRISM_INTERVAL_OPTIONS as readonly number[]).includes(v) ? v : PRISM_DEFAULT_INTERVAL_SEC
}

/** 底条下拉选项（秒）：300 / 600 / 1200 / 1800 / 3600 */
export const INTERVAL_OPTIONS: ReadonlyArray<number> = PRISM_INTERVAL_OPTIONS

/**
 * 底部状态条六项：`行情源 / 决策引擎 / T / 决策周期 / 约束版本 / 风控`。
 * 无源的项写 `—` 并把原因放 title（不写 `SIM-FEED` 这类演示值）。
 * `intervalSec` 有值 ⇒ 决策周期显示 `600s` 这类周期；否则沿用 `times` 时点列表（旧行为）。
 */
export function statusFactsOf(input: StatusInput): StatusFact[] {
  const times = input.times.filter((t) => typeof t === 'string' && t !== '')
  const t = finite(input.temperature)
  // 只认同源档位；非法回包值按未保存处理（600），不回显 700s 这类假值
  const interval = input.intervalSec === undefined || input.intervalSec === null ? null : intervalSecOf({ intervalSec: input.intervalSec })
  return [
    { key: 'feed', label: '行情源', value: input.feed ?? '—', title: input.feed === null ? '宿主未提供行情源标识' : null },
    { key: 'engine', label: '决策引擎', value: input.model ?? '—', title: input.model === null ? '宿主没有可用默认模型' : (input.modelProvider === null ? null : `provider ${input.modelProvider}`) },
    { key: 'temp', label: 'T', value: t === null ? '—' : t.toFixed(2), title: t === null ? '宿主未提供温度参数' : '模型温度' },
    interval === null
      ? { key: 'cycle', label: '决策周期', value: times.length === 0 ? '—' : times.join(' · '), title: times.length === 0 ? '未配置决策时点' : `每交易日 ${times.length} 个决策时点` }
      : { key: 'cycle', label: '决策周期', value: `${interval}s`, title: '自动决策周期（秒）：仅在 A 股交易时段 09:30–11:30 / 13:00–15:00 内按此周期触发' },
    { key: 'ver', label: '约束版本', value: input.constraintVersion === null ? '—' : input.constraintVersion, title: input.constraintVersion === null ? '宿主未提供约束版本号' : null },
    { key: 'risk', label: '风控', value: input.blockedToday === null ? '—' : input.blockedToday === 0 ? '全部通过' : `拦截 ${input.blockedToday} 笔`, title: input.blockedToday === null ? '缺交易日或委托数据，今日拦截数不可算' : '今日被风控拦截的委托笔数' },
  ]
}

/** 今日风控拦截数 = 今日被拒委托 + 今日各轮决策里被引擎拒绝的笔数；缺 day ⇒ null */
export function blockedTodayOf(
  orders: ReadonlyArray<{ status: string; day?: string }>,
  runs: ReadonlyArray<{ day?: string; decision?: null | { rejects?: ReadonlyArray<unknown> } }>,
  day: string | null,
): number | null {
  if (day === null || day === '') return null
  let n = 0
  for (const o of orders) if (o.day === day && o.status === 'rejected') n += 1
  for (const r of runs) if (r.day === day) n += r.decision?.rejects?.length ?? 0
  return n
}

/* ────────────────────────── 自动做T（弹窗） ────────────────────────── */
/**
 * 数据契约（宿主 GET /tradewatcher/prism 顶层可选字段）：
 * - `positions` = 逐只开关 + 中长期持有标记；
 * - `today` = 今日轮次/收益/计划/成交腿；
 * - `stats` / `perPosition` = 累计统计（胜率 n 是样本数；n=0 ⇒ 胜率不可算）；
 * - `effectiveCost` = 宿主算好的有效成本（客户端只展示，不重算）。
 *
 * 本模块只做**展示格式化与容错**：字段缺失一律 `—` + 原因，不用 0 顶替、不编数。
 */
export type AutoTState = 'running' | 'closed' | 'paused'
export type AutoTPlanStatus = 'planned' | 'waiting' | 'open-filled' | 'done' | 'aborted' | 'unknown'
export type AutoTResultTone = 'ok' | 'blue' | 'off' | 'flat'

export interface AutoTPlan {
  id: string
  secid: string
  name: string
  direction: 'buy-first' | 'sell-first'
  buyPrice: number | null
  sellPrice: number | null
  shares: number | null
  status: AutoTPlanStatus
  observe: string | null
  reasoning: string | null
  conclusion: string | null
}

export interface AutoTTrade {
  id: string
  planId: string
  secid: string
  side: 'buy' | 'sell'
  shares: number | null
  price: number | null
  at: number | null
  leg: 'open' | 'close' | 'unknown'
  forced: boolean
}

export interface AutoTPositionFlag { enabled: boolean; hold: boolean }
export interface AutoTStats { rounds: number | null; profit: number | null; winRate: number | null; n: number | null }
export interface AutoTToday { rounds: number | null; limit: number | null; profit: number | null; plans: AutoTPlan[]; trades: AutoTTrade[] }
export interface PrismAutoT {
  state: AutoTState
  enabled: boolean
  positions: Record<string, AutoTPositionFlag>
  today: AutoTToday
  stats: AutoTStats
  perPosition: Record<string, AutoTStats>
  effectiveCost: Record<string, number | null>
}
export interface AutoTSwitchPatch { positions: Record<string, { enabled: boolean }>; changed: number }
export type AutoTSwitchPatchResult = { ok: true; patch: AutoTSwitchPatch } | { ok: false; error: string }

const recordOf = (v: unknown): Record<string, unknown> | null =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null

const textOf = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v : null)

const intOf = (v: unknown): number | null => {
  const n = finite(v as number)
  return n === null ? null : Math.trunc(n)
}

const planStatusOf = (v: unknown): AutoTPlanStatus =>
  v === 'planned' || v === 'waiting' || v === 'open-filled' || v === 'done' || v === 'aborted' ? v : 'unknown'

function planOf(v: unknown): AutoTPlan | null {
  const o = recordOf(v)
  if (o === null) return null
  const secid = textOf(o.secid)
  if (secid === null) return null
  return {
    id: textOf(o.id) ?? `${secid}-plan`,
    secid,
    name: textOf(o.name) ?? secid,
    direction: o.direction === 'sell-first' ? 'sell-first' : 'buy-first',
    buyPrice: finite(o.buyPrice as number),
    sellPrice: finite(o.sellPrice as number),
    shares: intOf(o.shares),
    status: planStatusOf(o.status),
    observe: textOf(o.observe),
    reasoning: textOf(o.reasoning),
    conclusion: textOf(o.conclusion),
  }
}

function tradeOf(v: unknown): AutoTTrade | null {
  const o = recordOf(v)
  if (o === null) return null
  const id = textOf(o.id)
  const planId = textOf(o.planId)
  const secid = textOf(o.secid)
  if (id === null || planId === null || secid === null) return null
  return {
    id,
    planId,
    secid,
    side: o.side === 'sell' ? 'sell' : 'buy',
    shares: intOf(o.shares),
    price: finite(o.price as number),
    at: finite(o.at as number),
    leg: o.leg === 'open' || o.leg === 'close' ? o.leg : 'unknown',
    forced: o.forced === true,
  }
}

function statsOf(v: unknown): AutoTStats {
  const o = recordOf(v)
  return {
    rounds: o === null ? null : intOf(o.rounds),
    profit: o === null ? null : finite(o.profit as number),
    winRate: o === null ? null : finite(o.winRate as number),
    n: o === null ? null : intOf(o.n),
  }
}

function statsBagOf(v: unknown): Record<string, AutoTStats> {
  const bag = recordOf(v)
  const out: Record<string, AutoTStats> = {}
  if (bag === null) return out
  for (const [secid, raw] of Object.entries(bag)) {
    if (secid.trim() === '') continue
    out[secid] = statsOf(raw)
  }
  return out
}

/**
 * 从 `/tradewatcher/prism` 回包取 `autoT` 并做结构容错。
 * 没有该字段 / 不是对象 ⇒ `null`（界面走「自动做T 未启用」空态，不报错）。
 * 兼容宿主把字段放在顶层或 `state` 内的两种写法。
 */
export function autoTOf(payload: unknown): PrismAutoT | null {
  const bag = recordOf(payload)
  if (bag === null) return null
  const nested = recordOf(bag.state)
  const raw = bag.autoT !== undefined ? bag.autoT : nested?.autoT
  const o = recordOf(raw)
  if (o === null) return null
  const positions: Record<string, AutoTPositionFlag> = {}
  const posBag = recordOf(o.positions)
  if (posBag !== null) {
    for (const [secid, rawFlag] of Object.entries(posBag)) {
      if (secid.trim() === '') continue
      const f = recordOf(rawFlag)
      if (f === null) continue
      positions[secid] = { enabled: f.enabled === true, hold: f.hold === true }
    }
  }
  const todayBag = recordOf(o.today)
  const plansRaw = todayBag?.plans
  const tradesRaw = todayBag?.trades
  const plans = Array.isArray(plansRaw) ? plansRaw.map(planOf).filter((p): p is AutoTPlan => p !== null) : []
  const trades = Array.isArray(tradesRaw) ? tradesRaw.map(tradeOf).filter((t): t is AutoTTrade => t !== null) : []
  const effectiveRaw = recordOf(o.effectiveCost)
  const effectiveCost: Record<string, number | null> = {}
  if (effectiveRaw !== null) {
    for (const [secid, v] of Object.entries(effectiveRaw)) {
      if (secid.trim() === '') continue
      effectiveCost[secid] = finite(v as number)
    }
  }
  return {
    state: o.state === 'running' || o.state === 'paused' ? o.state : 'closed',
    enabled: o.enabled === true,
    positions,
    today: {
      rounds: todayBag === null || todayBag === undefined ? null : intOf(todayBag.rounds),
      limit: todayBag === null || todayBag === undefined ? null : intOf(todayBag.limit),
      profit: todayBag === null || todayBag === undefined ? null : finite(todayBag.profit as number),
      plans,
      trades,
    },
    stats: statsOf(o.stats),
    perPosition: statsBagOf(o.perPosition),
    effectiveCost,
  }
}

/** 有未完成 T 单 = 今日存在未走完（planned / waiting / open-filled）的计划 */
export function autoTHasUnfinishedOf(a: PrismAutoT | null): boolean {
  if (a === null) return false
  return a.today.plans.some((p) => p.status === 'planned' || p.status === 'waiting' || p.status === 'open-filled')
}

/** 入口按钮状态：灰=关闭、绿=运行中、橙=有未完成 T 单（橙优先） */
export function autoTEntryStatusOf(a: PrismAutoT | null): 'closed' | 'running' | 'unfinished' {
  if (a === null || !a.enabled || a.state === 'closed') return 'closed'
  if (autoTHasUnfinishedOf(a)) return 'unfinished'
  return a.state === 'running' ? 'running' : 'closed'
}

/** 入口按钮 / 标题的无障碍说明 */
export function autoTEntryTitleOf(a: PrismAutoT | null): string {
  if (a === null) return '自动做T 未启用（宿主回包没有 autoT 字段）'
  if (!a.enabled) return '自动做T 已关闭'
  if (autoTHasUnfinishedOf(a)) return '自动做T · 有未完成 T 单'
  if (a.state === 'paused') return '自动做T 已暂停'
  if (a.state === 'running') return '自动做T 运行中'
  return '自动做T 已关闭'
}

/** 弹窗头部状态徽标文案 */
export function autoTStateTextOf(a: PrismAutoT | null): string {
  if (a === null || !a.enabled) return '未启用'
  if (a.state === 'paused') return '已暂停'
  if (a.state === 'running') return 'Agent 运行中'
  return '已关闭'
}

export interface AutoTChip { key: string; label: string; value: string; tone: Tone; title: string }

/** 胜率文本：n=0 ⇒ `—（n=0）`；有 n、缺 rate ⇒ `—（n=N）`；都不写 0% */
export function autoTWinRateTextOf(winRate: number | null | undefined, n: number | null | undefined): string {
  const sample = finite(n)
  if (sample === null) return '—'
  const rate = finite(winRate)
  if (sample <= 0 || rate === null) return `—（n=${sample}）`
  const pct = rate.toFixed(1).replace(/\.0$/, '')
  return `${pct}%（n=${sample}）`
}

function winRateTitleOf(winRate: number | null | undefined, n: number | null | undefined): string {
  const sample = finite(n)
  if (sample === null) return '宿主未给出胜率样本数 n'
  if (sample <= 0) return '样本数 n=0，胜率不可算'
  if (finite(winRate) === null) return `宿主未给出胜率（n=${sample}）`
  return `胜率 = 盈利轮次 / 总轮次（n=${sample}）`
}

/** 今日轮次：`1 / 2`；缺一项如实留 `—` */
export function autoTTodayRoundsTextOf(a: PrismAutoT | null): string {
  const rounds = finite(a?.today.rounds)
  const limit = finite(a?.today.limit)
  if (rounds === null && limit === null) return '—'
  if (limit === null) return String(rounds)
  return `${rounds === null ? '—' : String(rounds)} / ${String(limit)}`
}

/** 顶部 5 个统计 chip（唯一汇总口径；表格不再出合计行） */
export function autoTChipsOf(a: PrismAutoT | null): AutoTChip[] {
  const noData = '自动做T 未启用（宿主回包没有 autoT 字段）'
  const todayProfit = a?.today.profit ?? null
  const totalRounds = a?.stats.rounds ?? null
  const totalProfit = a?.stats.profit ?? null
  const winRate = a?.stats.winRate ?? null
  const n = a?.stats.n ?? null
  const rounds = finite(a?.today.rounds)
  const limit = finite(a?.today.limit)
  const roundsTitle = a === null
    ? noData
    : rounds === null
      ? '宿主未给出今日已完成轮次'
      : limit === null
        ? '宿主未给出每日轮次上限'
        : '今日已完成轮次 / 每日上限'
  return [
    { key: 'today-rounds', label: '今日轮次', value: autoTTodayRoundsTextOf(a), tone: 'flat', title: roundsTitle },
    { key: 'today-profit', label: '今日做T收益', value: signedMoneyOf(todayProfit), tone: toneOf(todayProfit), title: a === null ? noData : (todayProfit === null ? '宿主未给出今日做T收益' : '今日做T净收益（宿主结算值）') },
    { key: 'total-rounds', label: '累计做T次数', value: totalRounds === null ? '—' : `${String(totalRounds)} 次`, tone: 'flat', title: a === null ? noData : (totalRounds === null ? '宿主未给出累计做T次数' : '累计完成轮次（两腿都成交且净持仓复原）') },
    { key: 'total-profit', label: '累计做T收益', value: signedMoneyOf(totalProfit), tone: toneOf(totalProfit), title: a === null ? noData : (totalProfit === null ? '宿主未给出累计做T收益' : '累计做T净收益（宿主结算值）') },
    { key: 'win-rate', label: '做T胜率', value: autoTWinRateTextOf(winRate, n), tone: 'flat', title: a === null ? noData : winRateTitleOf(winRate, n) },
  ]
}

/** 单只统计（名称下方一行）：做T N 次 · +X · 胜率 Y%（n=）；整条缺 ⇒ 0 次 · — · —（n=0） */
export function autoTPerPositionTextOf(stat: AutoTStats | null | undefined): string {
  if (stat === null || stat === undefined) return '做T 0 次 · — · 胜率 —（n=0）'
  const rounds = finite(stat.rounds)
  const profit = stat.profit
  const win = autoTWinRateTextOf(stat.winRate, stat.n)
  return `做T ${rounds === null ? '—' : String(rounds)} 次 · ${signedMoneyOf(profit)} · 胜率 ${win}`
}

/** 今日轮次胶囊文案：`自动做T · 1 / 2 轮 · +112.30` */
export function autoTPillTextOf(a: PrismAutoT | null): string {
  const rounds = autoTTodayRoundsTextOf(a)
  const profit = signedMoneyOf(a?.today.profit ?? null)
  return `自动做T · ${rounds === '—' ? '—' : `${rounds} 轮`} · ${profit}`
}

/** 该标的今日计划：优先取未中止的计划，没有则回退最后一条 */
export function autoTPlanOf(a: PrismAutoT | null, secid: string): AutoTPlan | null {
  if (a === null) return null
  const list = a.today.plans.filter((p) => p.secid === secid)
  return list.find((p) => p.status !== 'aborted') ?? list[list.length - 1] ?? null
}

/** 弹窗左下「Agent 判断」面板选中的计划：第一条未中止的计划（没有则第一条） */
export function autoTFocusPlanOf(a: PrismAutoT | null): AutoTPlan | null {
  if (a === null) return null
  return a.today.plans.find((p) => p.status !== 'aborted') ?? a.today.plans[0] ?? null
}

export interface AutoTJudgeView { text: string; muted: boolean; title: string; plan: AutoTPlan | null; direction: string | null }

export function autoTDirectionLabelOf(plan: AutoTPlan): string {
  return plan.direction === 'sell-first' ? '反T' : '正T'
}

function priceTextOf(v: number | null): string {
  return v === null ? '—' : v.toFixed(2)
}

/** 持仓表「Agent 今日判断」：开关/持有标记/计划三层，缺哪层说哪层 */
export function autoTJudgeOf(a: PrismAutoT | null, secid: string): AutoTJudgeView {
  if (a === null) return { text: '—（自动做T 未启用）', muted: true, title: '宿主回包没有 autoT 字段', plan: null, direction: null }
  const flag = a.positions[secid]
  if (flag === undefined || !flag.enabled) return { text: '未开启做T', muted: true, title: '该标的的自动做T 开关当前为关闭', plan: null, direction: null }
  if (!flag.hold) return { text: '非中长期持有', muted: true, title: '该标的未标记为中长期持有，不做T', plan: null, direction: null }
  const plan = autoTPlanOf(a, secid)
  if (plan === null) return { text: '今日无计划', muted: true, title: '今日该标的没有做T计划（价差不足/风控/数据缺失）', plan: null, direction: null }
  const parts = [`${priceTextOf(plan.buyPrice)} ↔ ${priceTextOf(plan.sellPrice)}`, plan.shares === null ? '— 股' : `${moneyOf(plan.shares, 0)} 股`]
  return { text: parts.join(' · '), muted: false, title: `计划 ${plan.id}`, plan, direction: autoTDirectionLabelOf(plan) }
}

export interface AutoTResultView { label: string; tone: AutoTResultTone; title: string }

/** 计划结果徽标（只描述状态；金额在页面按成交腿价差估算并标注未扣费） */
export function autoTPlanResultOf(plan: AutoTPlan | null): AutoTResultView {
  if (plan === null) return { label: '—', tone: 'flat', title: '今日无做T计划' }
  switch (plan.status) {
    case 'planned': return { label: '已计划', tone: 'blue', title: '计划已生成，等待触发' }
    case 'waiting': return { label: '待触发', tone: 'blue', title: '条件单已挂出，等待价格触发' }
    case 'open-filled': return { label: '一腿已成', tone: 'blue', title: '已成交一腿，等待回补腿' }
    case 'done': return { label: '已完成', tone: 'ok', title: '两腿都成交，净持仓复原' }
    case 'aborted': return { label: '已中止', tone: 'off', title: '本轮已中止（未完成，不计入完成次数）' }
    default: return { label: '—', tone: 'flat', title: '宿主未给出可识别的计划状态' }
  }
}

/** 价差（扣费前，%）：(sell / buy − 1) × 100；价格缺失 ⇒ null */
export function autoTSpreadPctOf(plan: AutoTPlan | null): number | null {
  if (plan === null || plan.buyPrice === null || plan.sellPrice === null || plan.buyPrice <= 0) return null
  return (plan.sellPrice / plan.buyPrice - 1) * 100
}

/** 单轮估算净额（按成交腿价差，**未扣费用**）：卖腿金额 − 买腿金额；缺一腿 ⇒ null */
export function autoTPlanNetOf(plan: AutoTPlan | null, trades: ReadonlyArray<AutoTTrade>): number | null {
  if (plan === null) return null
  let buy = 0
  let sell = 0
  let buyShares = 0
  let sellShares = 0
  for (const t of trades) {
    if (t.planId !== plan.id || t.price === null || t.shares === null) continue
    if (t.side === 'buy') { buy += t.price * t.shares; buyShares += t.shares }
    else { sell += t.price * t.shares; sellShares += t.shares }
  }
  if (buyShares <= 0 || sellShares <= 0) return null
  return sell - buy
}

/**
 * 单轮结算金额：回包没有逐轮净额，只有 `today.profit`。
 * 仅当今日只有这一条计划、且该计划已完成时，才把今日收益原样挂到它上面；
 * 多计划无法拆分 ⇒ null（界面写 — 并说明原因，不拿成交腿价差冒充已扣费净额）。
 */
export function autoTPlanSettlementOf(a: PrismAutoT | null, plan: AutoTPlan | null): number | null {
  if (a === null || plan === null || plan.status !== 'done') return null
  if (a.today.plans.length !== 1) return null
  return a.today.profit
}

export interface AutoTFlowEvent {
  id: string
  kind: 'buy' | 'sell' | 'settle' | 'fail'
  label: string
  at: number | null
  timeText: string
  timeTitle: string
  text: string
  amountText: string
  tone: Tone
}

/** 今日流水：T·买入 / T·卖出 / T·结算 / T·失败（按成交时刻升序；结算金额按价差估算并注明未扣费） */
export function autoTFlowOf(a: PrismAutoT | null): AutoTFlowEvent[] {
  if (a === null) return []
  const planById = new Map(a.today.plans.map((p) => [p.id, p]))
  const events: AutoTFlowEvent[] = []
  for (const t of a.today.trades) {
    const plan = planById.get(t.planId) ?? null
    const amount = t.price === null || t.shares === null ? null : (t.side === 'sell' ? 1 : -1) * t.price * t.shares
    const failure = t.forced
    events.push({
      id: `trade-${t.id}`,
      kind: failure ? 'fail' : t.side,
      label: failure ? 'T·失败' : (t.side === 'sell' ? 'T·卖出' : 'T·买入'),
      at: t.at,
      timeText: t.at === null ? '—' : shClockText(t.at).slice(0, 5),
      timeTitle: t.at === null ? '宿主未给出成交时刻' : `成交时刻（北京时间）${shClockText(t.at)}`,
      text: `${plan?.name ?? t.secid} ${t.shares === null ? '—' : moneyOf(t.shares, 0)} 股 @${t.price === null ? '—' : t.price.toFixed(2)}`,
      amountText: signedMoneyOf(amount),
      tone: 'flat',
    })
  }
  for (const plan of a.today.plans) {
    if (plan.status !== 'done') continue
    const settle = autoTPlanSettlementOf(a, plan)
    const legs = a.today.trades.filter((t) => t.planId === plan.id && t.at !== null)
    if (legs.length === 0) continue
    const at = Math.max(...legs.map((t) => t.at as number))
    events.push({
      id: `settle-${plan.id}`,
      kind: 'settle',
      label: 'T·结算',
      at,
      timeText: shClockText(at).slice(0, 5),
      timeTitle: settle === null ? '宿主未给出单轮结算金额（今日收益无法拆分到单轮）' : '今日做T结算（宿主值）',
      text: settle === null ? `结算 · ${plan.name}（单轮金额不可拆）` : `结算 · ${plan.name}`,
      amountText: signedMoneyOf(settle),
      tone: toneOf(settle),
    })
  }
  return events.sort((x, y) => (x.at ?? Number.POSITIVE_INFINITY) - (y.at ?? Number.POSITIVE_INFINITY))
}

/** 持仓开关草稿：以回包 positions 为唯一基线（缺失按 false，开关本身仍可操作） */
export function autoTSwitchDraftOf(a: PrismAutoT | null, secids: ReadonlyArray<string>): Record<string, boolean> {
  const out: Record<string, boolean> = {}
  for (const secid of secids) {
    if (typeof secid !== 'string' || secid.trim() === '') continue
    out[secid] = a?.positions[secid]?.enabled === true
  }
  return out
}

/**
 * 开关 POST payload：只带发生变化的标的；校验键非空、值必须是布尔。
 * 没有变化时 `patch.changed === 0`（页面据此直接关闭，不发空请求）。
 */
export function autoTSwitchPatchOf(draft: unknown, saved: Readonly<Record<string, boolean>>): AutoTSwitchPatchResult {
  const bag = recordOf(draft)
  if (bag === null) return { ok: false, error: '开关状态无效' }
  const positions: Record<string, { enabled: boolean }> = {}
  let changed = 0
  for (const [secid, value] of Object.entries(bag)) {
    if (secid.trim() === '') return { ok: false, error: '标的代码不能为空' }
    if (typeof value !== 'boolean') return { ok: false, error: `${secid} 的开关值必须是布尔值` }
    if (saved[secid] === value) continue
    positions[secid] = { enabled: value }
    changed += 1
  }
  return { ok: true, patch: { positions, changed } }
}

/** 有效成本显示：宿主值原样展示（最多 3 位小数），缺失 ⇒ — */
export function autoTEffectiveCostTextOf(a: PrismAutoT | null, secid: string): string {
  const v = a === null ? null : finite(a.effectiveCost[secid])
  return v === null ? '—' : v.toFixed(3).replace(/\.?0+$/, '')
}

/** 成本价显示（账面成本；宿主值最多 3 位小数） */
export function autoTCostTextOf(v: number | null | undefined): string {
  const n = finite(v)
  return n === null ? '—' : n.toFixed(3).replace(/\.?0+$/, '')
}
