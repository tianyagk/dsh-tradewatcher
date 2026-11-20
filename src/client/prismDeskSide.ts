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

export interface SidePositionRow { marketValue?: number | null; pnl?: number | null }
export interface EquityPointLike { day: string; realized: number; capital?: number | null }

/** 浮盈合计：任一行缺 pnl ⇒ null（不部分求和，与左栏同一口径） */
function sumOf(rows: ReadonlyArray<SidePositionRow>, key: 'marketValue' | 'pnl'): number | null {
  if (rows.length === 0) return null
  let sum = 0
  for (const r of rows) {
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
  hitRate: number | null
  maxDrawdown: number | null
  excessPct: number | null
}

/**
 * 四格 `决策 / 胜率 / 回撤 / 超额`。
 * 宿主任一指标为 null ⇒ `—` + title（样本不足 / 缺基准），**不写 0**。
 */
export function perfCellsOf(p: PerfInput): PerfCell[] {
  const runs = finite(p.runsCount)
  return [
    { key: 'runs', label: '决策', value: runs === null ? '—' : String(Math.trunc(runs)), title: '累计决策轮次（desk.performance.runsCount）' },
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
