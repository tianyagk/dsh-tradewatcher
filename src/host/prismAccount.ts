/**
 * 棱镜模拟盘引擎（批次 3）：账户 / 挂单 / 撮合 / 费用 / A股约束。
 *
 * 口径（用户裁决，不改）：
 *   · 初始 150 万；`capitalLimit` 可改（入金，现金同步增减）；
 *   · 起点持仓**按真实成本价复制**（只读 `assemblePortfolio`），可随时重copy（留痕：时间 + 前后差异）；
 *   · 挂单当日有效；后续研判可撤销（留痕）；跨日自动失效；
 *   · 撮合：1 分钟 `high/low` 触及即按**挂单价**成交；缺 1 分钟退回分时并标注来源；
 *   · 费用：佣金万 2.5（最低 5 元）+ 卖出印花税千 1 + 过户费万 0.1；不计滑点；
 *   · A股：T+1、涨跌停不可成交、停牌不可成交、100 股整手；违反 → `rejected` + 原因（不静默丢）。
 *
 * 三个账本文件都走 `updateJsonLocked` + `ReadGuard`；坏文件先 `quarantineFile` 隔离。
 */
import { mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type {
  PrismAccount,
  PrismClampEvent,
  PrismIndustryLimits,
  PrismCopyLog,
  PrismDecision,
  PrismEquityPoint,
  PrismFill,
  PrismOrder,
  PrismPosition,
} from '../shared/prism.ts'
import { dataHome } from './store.ts'
import { readJsonForUpdate, updateJsonLocked } from './lock.ts'
import { ReadGuard, quarantineFile } from './readGuard.ts'
import { dayOf, hhmmOf } from './time.ts'
import { withHostBreaker } from './breakerFetch.ts'

import { PRISM_DEFAULT_CAPITAL } from '../shared/prism.ts'
export const PRISM_INITIAL_CAPITAL = PRISM_DEFAULT_CAPITAL
export const COMMISSION_RATE = 0.00025
export const COMMISSION_MIN = 5
export const STAMP_RATE = 0.001
export const TRANSFER_RATE = 0.00001

const money = (n: number): number => Math.round(n * 100) / 100

export interface FeeBreakdown {
  commission: number
  stamp: number
  transfer: number
  total: number
}

/**
 * 三项费用。`priorAmount/priorCommission` 用于同一委托的累计佣金：
 * 只在本笔补足「累计应收佣金 − 已收佣金」，最低 5 元不会每笔重复收。
 */
export function feesOf(
  side: 'buy' | 'sell',
  price: number,
  shares: number,
  priorAmount = 0,
  priorCommission = 0,
): FeeBreakdown {
  const amount = price * shares
  const totalAmount = priorAmount + amount
  const dueCommission = Math.max(COMMISSION_MIN, money(totalAmount * COMMISSION_RATE))
  const commission = money(Math.max(0, dueCommission - priorCommission))
  const stamp = side === 'sell' ? money(amount * STAMP_RATE) : 0
  const transfer = money(amount * TRANSFER_RATE)
  return { commission, stamp, transfer, total: money(commission + stamp + transfer) }
}

export interface OrderLimits {
  prevClose: number | null
  upper: number | null
  lower: number | null
}

/** A股涨跌停（10%/20%/5% ST）：主板 10%，创业板/科创板 20%，ST 5% */
export function limitsOf(secid: string, name: string, prevClose: number | null): OrderLimits {
  if (prevClose === null || !(prevClose > 0)) return { prevClose: null, upper: null, lower: null }
  const code = secid.split('.')[1] ?? ''
  const pct = /^ST/i.test(name) ? 0.05 : /^(300|301|688|689)/.test(code) ? 0.2 : 0.1
  return { prevClose, upper: money(prevClose * (1 + pct)), lower: money(prevClose * (1 - pct)) }
}

export interface OrderCheckContext {
  limits: OrderLimits
  suspended: boolean
  positionQty: number
  availableQty: number
}

/** 挂单的静态约束（T+1/涨跌停/停牌/整手）；返回拒绝原因或 null */
export function rejectReasonOf(order: PrismOrder, ctx: OrderCheckContext): string | null {
  if (!(order.price > 0) || !Number.isFinite(order.price)) return '价格无效'
  if (!(order.shares > 0) || order.shares % 100 !== 0) return '非100股整手'
  if (ctx.suspended) return '停牌不可成交'
  const { upper, lower } = ctx.limits
  if (upper !== null && lower !== null) {
    if (order.side === 'buy' && order.price >= upper) return `涨停不可成交（涨停价 ${upper.toFixed(2)}）`
    if (order.side === 'sell' && order.price <= lower) return `跌停不可成交（跌停价 ${lower.toFixed(2)}）`
    if (order.price > upper || order.price < lower) return `价格超出涨跌停（${lower.toFixed(2)}–${upper.toFixed(2)}）`
  }
  if (order.side === 'sell') {
    if (ctx.positionQty <= 0) return '无持仓不可卖'
    if (ctx.availableQty < order.shares) return `T+1 不可卖（今日可卖 ${ctx.availableQty} 股）`
  }
  return null
}

/**
 * 成交前的资金/可卖校验（与撮合同一条路径）：
 *   · 买入：成交金额 + 费用 ≤ 可用现金，否则 `现金不足（需 X，可用 Y）`；
 *   · 卖出：可卖数量（已扣当日买入）≥ 委托数量，否则 T+1 原因。
 * 返回 null = 可成交；否则为拒绝原因（订单落 `rejected`，现金/持仓不变）。
 */
export function fillRejectReasonOf(
  account: PrismAccount,
  order: PrismOrder,
  price: number,
): string | null {
  if (order.side === 'buy') {
    const amount = money(price * order.shares)
    const fee = feesOf('buy', price, order.shares).total
    const need = money(amount + fee)
    if (need > money(account.cash)) {
      return `现金不足（需 ${need.toFixed(2)}，可用 ${money(account.cash).toFixed(2)}）`
    }
    return null
  }
  const position = account.positions.find((p) => p.secid === order.secid)
  const available = position?.available ?? 0
  if (available < order.shares) {
    return `T+1 不可卖（今日可卖 ${available} 股，需要 ${order.shares} 股）`
  }
  return null
}

export interface MinuteBar {
  t: number
  high: number
  low: number
  /** 成交量（股；与 em.ts 新浪/腾讯分钟口径一致）；null/undefined = 上游未给，不是 0 */
  volume?: number | null
}

/** 撮合：买看 low ≤ 挂单价，卖看 high ≥ 挂单价；按**挂单价**成交（不用收盘价） */
export function matchOrder(
  order: PrismOrder,
  bars: readonly MinuteBar[],
): { price: number; at: number } | null {
  for (const bar of bars) {
    if (bar.t < order.decidedAt) continue
    if (order.side === 'buy' && bar.low <= order.price) return { price: order.price, at: bar.t }
    if (order.side === 'sell' && bar.high >= order.price) return { price: order.price, at: bar.t }
  }
  return null
}

/** 买入/卖出后的账户（费用计入；成本按移动加权摊薄） */
export function applyFill(account: PrismAccount, order: PrismOrder, fill: PrismFill): PrismAccount {
  const positions = account.positions.map((p) => ({ ...p }))
  const idx = positions.findIndex((p) => p.secid === order.secid)
  let cash = account.cash
  let realized = account.realized
  if (order.side === 'buy') {
    if (money(fill.amount + fill.fee) > money(cash)) throw new Error('现金不足（内部错误：成交前未校验）')
    cash = money(cash - fill.amount - fill.fee)
    if (idx < 0) {
      positions.push({ secid: order.secid, name: order.name, qty: fill.shares, available: 0, cost: money((fill.amount + fill.fee) / fill.shares) })
    } else {
      const p = positions[idx] as PrismPosition
      const net = p.netCost ?? p.qty * p.cost
      p.netCost = money(net + fill.amount + fill.fee)
      p.qty += fill.shares
      p.cost = money(p.netCost / p.qty)
    }
  } else {
    const p = positions[idx]
    if (p === undefined) throw new Error('卖出无持仓（内部错误）')
    cash = money(cash + fill.amount - fill.fee)
    realized = money(realized + (fill.price - p.cost) * fill.shares - fill.fee)
    const net = p.netCost ?? p.qty * p.cost
    p.netCost = money(net - (fill.amount - fill.fee))
    p.qty -= fill.shares
    p.available = Math.max(0, p.available - fill.shares)
    if (p.qty > 0) p.cost = money((p.netCost as number) / p.qty)
    if (p.qty === 0) positions.splice(idx, 1)
  }
  return { ...account, cash, realized, positions }
}

/**
 * 复制真实持仓（按成本价；资金上限不足时**只复制能覆盖的部分**并留痕）。
 * 复制的现金口径：`cash = capitalLimit − Σ(实际复制 qty × cost)`。
 */
export function copyAtCost(
  rows: ReadonlyArray<{ secid: string; name: string; qty: number; cost: number }>,
  account: PrismAccount,
  now: number,
): { ok: true; account: PrismAccount; log: PrismCopyLog; skipped: string[] } {
  const before = account.positions.map((p) => `${p.secid}×${p.qty}@${p.cost.toFixed(2)}`)
  let remaining = money(account.capitalLimit)
  const positions: PrismPosition[] = []
  const skipped: string[] = []
  for (const r of rows) {
    const cost = money(r.cost)
    if (!(cost > 0) || !(r.qty > 0)) {
      skipped.push(`${r.secid}×${r.qty}@${r.cost}（数量或成本无效）`)
      continue
    }
    const take = Math.max(0, Math.min(r.qty, Math.floor(remaining / cost)))
    if (take <= 0) {
      skipped.push(`${r.secid}×${r.qty}@${cost.toFixed(2)}（剩余现金 ${remaining.toFixed(2)} 不足）`)
      continue
    }
    positions.push({ secid: r.secid, name: r.name, qty: take, available: take, cost, netCost: money(take * cost) })
    remaining = money(remaining - take * cost)
    if (take < r.qty) skipped.push(`${r.secid} 仅复制 ${take}/${r.qty} 股（剩余现金不足）`)
  }
  const note = skipped.length === 0 ? undefined : `部分复制：${skipped.join('；')}`
  const log: PrismCopyLog = {
    at: now,
    before,
    after: positions.map((p) => `${p.secid}×${p.qty}@${p.cost.toFixed(2)}`),
    ...(note === undefined ? {} : { note }),
    ...(skipped.length === 0 ? {} : { skipped }),
  }
  const next: PrismAccount = {
    ...account,
    cash: remaining,
    positions,
    copiedAt: now,
    copyLogs: [...account.copyLogs, log].slice(-20),
  }
  return { ok: true, account: next, log, skipped }
}

/** 新交易日：T+1 解锁（available = qty）；dayStartEquity 用上一日收盘净值 */
export function rollDay(account: PrismAccount, day: string, previousEquity: number | null): PrismAccount {
  if (account.day === day) return account
  const positions = account.positions.map((p) => ({ ...p, available: p.qty }))
  return { ...account, day, positions, dayStartEquity: previousEquity ?? account.dayStartEquity }
}

/** 当日净值（一个交易日一个点；同一天再算就覆盖） */
export function equityPointOf(
  account: PrismAccount,
  priceOf: (secid: string) => number | null,
  now: number,
  benchmarkClose: number | null = null,
): PrismEquityPoint {
  const positionsValue = money(account.positions.reduce((a, p) => a + p.qty * (priceOf(p.secid) ?? p.cost), 0))
  const equity = money(account.cash + positionsValue)
  const day = account.day || dayOf(now)
  return {
    day,
    equity,
    capital: account.capital ?? account.capitalLimit,
    benchmarkClose,
    cash: account.cash,
    positionsValue,
    realized: account.realized,
    unrealized: money(equity - account.capitalLimit),
    at: now,
  }
}

/** dayStartEquity 与前一交易日收盘净值差 >1 元 ⇒ 告警（不改口径来源） */
export function dayStartMismatchOf(account: PrismAccount, points: readonly PrismEquityPoint[]): string | null {
  if (account.dayStartEquity === null) return null
  const prev = [...points].filter((p) => p.day < account.day).sort((a, b) => (a.day < b.day ? 1 : -1))[0]
  if (prev === undefined) return null
  const diff = Math.abs(account.dayStartEquity - prev.equity)
  return diff > 1 ? `当日基准净值 ${account.dayStartEquity.toFixed(2)} 与前一收盘净值 ${prev.equity.toFixed(2)} 差 ${diff.toFixed(2)} 元` : null
}

export function upsertEquity(list: readonly PrismEquityPoint[], point: PrismEquityPoint): PrismEquityPoint[] {
  const out = list.filter((p) => p.day !== point.day)
  out.push(point)
  return out.sort((a, b) => (a.day < b.day ? -1 : 1)).slice(-365)
}

/**
 * 解析汇总里的严格 JSON 决策块（```json … ```）。
 * 失败 ⇒ `decision=null` + `parseError` 带**原文**（不得静默成 0 笔）。
 */
export function parseDecisionDetailed(text: string | null): { decision: PrismDecision | null; parseError: string | null } {
  if (text === null) return { decision: null, parseError: null }
  const m = /```json\s*([\s\S]*?)```/.exec(text)
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  const source = m !== null ? (m[1] as string) : start >= 0 && end > start ? text.slice(start, end + 1) : null
  if (source === null) return { decision: null, parseError: text.slice(0, 4000) }
  try {
    const raw = JSON.parse(source) as Record<string, unknown>
    const limitsRaw = (raw['limits'] ?? {}) as Record<string, unknown>
    const ordersRaw = Array.isArray(raw['orders']) ? raw['orders'] : []
    const orders = ordersRaw
      .filter((o): o is Record<string, unknown> => o !== null && typeof o === 'object')
      .map((o) => ({
        secid: typeof o['secid'] === 'string' ? o['secid'] : '',
        side: o['side'] === 'sell' ? ('sell' as const) : ('buy' as const),
        price: Number(o['price']),
        shares: Math.round(Number(o['shares'])),
        reason: typeof o['reason'] === 'string' ? o['reason'] : '',
      }))
      .filter((o) => /^[0-9]{1,3}\.[A-Za-z0-9]+$/.test(o.secid) && o.price > 0 && o.shares > 0)
    const cancel = Array.isArray(raw['cancel']) ? raw['cancel'].filter((x): x is string => typeof x === 'string') : []
    const dropped = ordersRaw.length - orders.length
    const parseError = dropped > 0 ? `orders 中有 ${dropped} 笔字段非法被丢弃（原始 ${ordersRaw.length} 笔）` : null
    const byIndustryRaw = limitsRaw['byIndustry']
    const byIndustry: Record<string, number> = {}
    if (byIndustryRaw !== null && typeof byIndustryRaw === 'object' && !Array.isArray(byIndustryRaw)) {
      for (const [name, v] of Object.entries(byIndustryRaw as Record<string, unknown>)) {
        if (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 100) byIndustry[name] = v
      }
    }
    const decision: PrismDecision = {
      limits: {
        singlePct: typeof limitsRaw['singlePct'] === 'number' ? limitsRaw['singlePct'] : null,
        totalPct: typeof limitsRaw['totalPct'] === 'number' ? limitsRaw['totalPct'] : null,
        note: typeof limitsRaw['note'] === 'string' ? limitsRaw['note'] : null,
        ...(Object.keys(byIndustry).length === 0 ? {} : { byIndustry }),
      },
      note: typeof raw['note'] === 'string' && raw['note'].trim() !== ''
        ? raw['note'].trim()
        : typeof limitsRaw['note'] === 'string' && limitsRaw['note'].trim() !== ''
          ? limitsRaw['note'].trim()
          : null,
      orders,
      cancel,
      rejects: [],
      parseError,
    }
    return { decision, parseError: null }
  } catch {
    return { decision: null, parseError: source.slice(0, 4000) }
  }
}

/** 兼容旧调用：只取决策（失败 ⇒ null；需要原文用 `parseDecisionDetailed`） */
export function parseDecision(text: string | null): PrismDecision | null {
  return parseDecisionDetailed(text).decision
}

/* ────────────────────────── 账本存储 ────────────────────────── */

export class PrismTradingStore {
  private readonly dir: string
  private readonly guard = new ReadGuard()
  private accountValue: PrismAccount = {
    day: '',
    capital: PRISM_INITIAL_CAPITAL,
    capitalLimit: PRISM_INITIAL_CAPITAL,
    cash: PRISM_INITIAL_CAPITAL,
    realized: 0,
    dayStartEquity: null,
    positions: [],
    copiedAt: null,
    copyLogs: [],
  }
  private ordersValue: PrismOrder[] = []
  private fillsValue: PrismFill[] = []
  private equityValue: PrismEquityPoint[] = []

  constructor(dir = dataHome()) {
    this.dir = dir
  }

  private pathOf(name: string): string {
    return join(this.dir, name)
  }

  async init(): Promise<void> {
    await mkdir(this.dir, { recursive: true })
    const acc = await this.readJson('prism-account.json')
    if (acc !== null && typeof acc === 'object') {
      // 三种历史格式都兼容：裸 account / { v, account } / { v, account, fills } 或 { v, ...account, fills }
      const root = acc as { account?: unknown }
      const saved = root.account !== null && typeof root.account === 'object' ? root.account : acc
      this.accountValue = normalizeAccount(saved as Record<string, unknown>)
    }
    await this.reloadOrders(acc)
    const eq = await this.readJson('prism-equity.json')
    const eqRoot = eq as { points?: unknown } | null
    this.equityValue = Array.isArray(eqRoot?.points) ? (eqRoot?.points as PrismEquityPoint[]) : []
  }

  private async readJson(name: string): Promise<unknown> {
    const file = this.pathOf(name)
    try {
      const disk = await readJsonForUpdate(file, 'null')
      this.guard.clear(file)
      return disk
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.guard.markUnreadable(file, error)
        console.warn(`[tradewatcher] 棱镜账本读不到（${file}）：${String(error).slice(0, 80)}`)
      }
      return null
    }
  }

  async quarantine(): Promise<void> {
    for (const name of ['prism-account.json', 'prism-orders.json', 'prism-equity.json']) {
      const file = this.pathOf(name)
      try {
        JSON.parse(await readFile(file, 'utf8'))
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
        if (error instanceof SyntaxError) await quarantineFile(file)
      }
    }
  }

  account(): PrismAccount { return JSON.parse(JSON.stringify(this.accountValue)) as PrismAccount }
  orders(): PrismOrder[] { return this.ordersValue.slice() }
  fills(): PrismFill[] { return this.fillsValue.slice() }
  equity(): PrismEquityPoint[] { return this.equityValue.slice() }

  /**
   * 订单/成交流水的唯一读取源是 `prism-orders.json`；账户内嵌 orders/fills 只作兼容兜底。
   * GET 会重新调用：外部/上一进程写入的订单不需要重启才能看见。
   */
  async reloadOrders(accountRoot: unknown = null): Promise<void> {
    const ord = await this.readJson('prism-orders.json')
    const ordRoot = ord as { orders?: unknown; fills?: unknown } | null
    const accRoot = accountRoot as { fills?: unknown; orders?: unknown; account?: { fills?: unknown; orders?: unknown } } | null
    const fileOrders = Array.isArray(ordRoot?.orders) ? (ordRoot?.orders as PrismOrder[]) : []
    const fileFills = Array.isArray(ordRoot?.fills) ? (ordRoot?.fills as PrismFill[]) : []
    const embeddedOrders = Array.isArray(accRoot?.orders)
      ? (accRoot?.orders as PrismOrder[])
      : Array.isArray(accRoot?.account?.orders) ? (accRoot.account.orders as PrismOrder[]) : []
    const embeddedFills = Array.isArray(accRoot?.fills)
      ? (accRoot?.fills as PrismFill[])
      : Array.isArray(accRoot?.account?.fills) ? (accRoot.account.fills as PrismFill[]) : []
    this.ordersValue = fileOrders.length > 0 ? fileOrders : embeddedOrders
    this.fillsValue = fileFills.length > 0 ? fileFills : embeddedFills
  }

  async saveAccount(account: PrismAccount, opts: { explicitReset?: boolean } = {}): Promise<void> {
    const oldHasData = this.accountValue.positions.length > 0 || this.fillsValue.length > 0
    if (opts.explicitReset !== true && oldHasData && account.positions.length === 0 && this.fillsValue.length === 0) {
      console.warn('[tradewatcher] accountWriteGuard：拒绝把已有持仓/成交流水的账户写成空账户（如确需重置请显式 reset）')
      throw new Error('accountWriteGuard：拒绝把已有数据的账户写成空账户')
    }
    this.accountValue = account
    await updateJsonLocked(this.pathOf('prism-account.json'), () => ({ v: 1, account })).catch(() => undefined)
  }

  async saveOrders(orders: PrismOrder[], fills: PrismFill[]): Promise<void> {
    this.ordersValue = orders
    this.fillsValue = fills
    await updateJsonLocked(this.pathOf('prism-orders.json'), () => ({ v: 1, orders, fills })).catch(() => undefined)
  }

  async saveEquity(points: PrismEquityPoint[]): Promise<void> {
    this.equityValue = points
    await updateJsonLocked(this.pathOf('prism-equity.json'), () => ({ v: 1, points })).catch(() => undefined)
  }
}

function normalizeAccount(raw: Record<string, unknown>): PrismAccount {
  const positions = Array.isArray(raw['positions']) ? raw['positions'] : []
  return {
    day: typeof raw['day'] === 'string' ? raw['day'] : '',
    capital: typeof raw['capital'] === 'number' ? raw['capital'] : typeof raw['capitalLimit'] === 'number' ? raw['capitalLimit'] : PRISM_INITIAL_CAPITAL,
    capitalLimit: typeof raw['capitalLimit'] === 'number' ? raw['capitalLimit'] : typeof raw['capital'] === 'number' ? raw['capital'] : PRISM_INITIAL_CAPITAL,
    cash: typeof raw['cash'] === 'number' ? raw['cash'] : PRISM_INITIAL_CAPITAL,
    realized: typeof raw['realized'] === 'number' ? raw['realized'] : 0,
    dayStartEquity: typeof raw['dayStartEquity'] === 'number' ? raw['dayStartEquity'] : null,
    positions: positions.filter((p): p is PrismPosition => p !== null && typeof p === 'object' && typeof (p as PrismPosition).secid === 'string'),
    copiedAt: typeof raw['copiedAt'] === 'number' ? raw['copiedAt'] : null,
    copyLogs: Array.isArray(raw['copyLogs']) ? (raw['copyLogs'] as PrismCopyLog[]) : [],
  }
}

/* ────────────────────────── 1 分钟撮合数据 ────────────────────────── */

export interface BarsResult {
  bars: MinuteBar[]
  source: '1min' | 'trend' | null
  reason: string | null
}

const BARS_TTL_MS = 30_000
const barsCache = new Map<string, { at: number; value: BarsResult }>()

/** 1 分钟 OHLC（新浪 scale=1 → 腾讯 m1）；都失败退回既有分时（标注来源） */
export async function fetchOneMinuteBars(
  secid: string,
  day: string,
  deps: { fetchJson?: (url: string) => Promise<unknown>; fetchTrend?: (secid: string) => Promise<Array<{ t: number; price: number }>> } = {},
): Promise<BarsResult> {
  const hit = barsCache.get(secid)
  if (deps.fetchJson === undefined && hit !== undefined && Date.now() - hit.at < BARS_TTL_MS) return hit.value
  const fetchJson = deps.fetchJson ?? (async (url: string) => {
    const res = await withHostBreaker(new URL(url).host, () =>
      fetch(url, { headers: { 'user-agent': 'Mozilla/5.0', referer: 'https://finance.sina.com.cn' }, signal: AbortSignal.timeout(8000) }),
    )
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return res.json()
  })
  const { sinaSymbol } = await import('./sina.ts')
  const { tencentCode } = await import('./tencent.ts')
  const sym = sinaSymbol(secid)
  if (sym !== null) {
    try {
      const json = (await fetchJson(`https://quotes.sina.cn/cn/api/json_v2.php/CN_MarketDataService.getKLineData?symbol=${sym}&scale=1&ma=no&datalen=240`)) as Array<Record<string, unknown>>
      const bars = (Array.isArray(json) ? json : [])
        .filter((r) => typeof r['day'] === 'string' && (r['day'] as string).startsWith(day))
        .map((r) => {
          const t = Date.parse(`${(r['day'] as string).replace(' ', 'T')}+08:00`)
          // 新浪 minute volume 单位为「股」（与 em.ts:1685 的真机标定一致）；缺失必须是 null，不是 0
          const volume = Number(r['volume'])
          return { t, high: Number(r['high']), low: Number(r['low']), volume: Number.isFinite(volume) ? volume : null }
        })
        .filter((b) => Number.isFinite(b.t) && Number.isFinite(b.high) && Number.isFinite(b.low))
      if (bars.length > 0) {
        const value: BarsResult = { bars, source: '1min', reason: null }
        if (deps.fetchJson === undefined) barsCache.set(secid, { at: Date.now(), value })
        return value
      }
    } catch { /* 落腾讯 */ }
  }
  const code = tencentCode(secid)
  if (code !== null) {
    try {
      const json = (await fetchJson(`https://proxy.finance.qq.com/ifzqgtimg/appstock/app/kline/mkline?param=${code},m1,,240`)) as { data?: Record<string, { m1?: unknown }> }
      const rows = json?.data?.[code]?.m1
      if (Array.isArray(rows)) {
        const bars = rows
          .filter((r): r is unknown[] => Array.isArray(r) && r.length >= 5 && String(r[0]).startsWith(day.replace(/-/g, '')))
          .map((r) => {
            // 腾讯 m1 第 5 列 volume 单位「股」；缺失必须是 null，不是 0
            const volume = Number(r[5])
            return { t: Date.parse(`${String(r[0]).slice(0, 4)}-${String(r[0]).slice(4, 6)}-${String(r[0]).slice(6, 8)}T${String(r[0]).slice(8, 10)}:${String(r[0]).slice(10, 12)}:00+08:00`), high: Number(r[3]), low: Number(r[4]), volume: Number.isFinite(volume) ? volume : null }
          })
          .filter((b) => Number.isFinite(b.t) && Number.isFinite(b.high) && Number.isFinite(b.low))
        if (bars.length > 0) {
          const value: BarsResult = { bars, source: '1min', reason: null }
          if (deps.fetchJson === undefined) barsCache.set(secid, { at: Date.now(), value })
          return value
        }
      }
    } catch { /* 落分时 */ }
  }
  try {
    const points = await (deps.fetchTrend ?? defaultTrend)(secid)
    const bars = points.filter((p) => dayOf(p.t) === day && p.price > 0).map((p) => ({ t: p.t, high: p.price, low: p.price }))
    const value: BarsResult = { bars, source: bars.length > 0 ? 'trend' : null, reason: bars.length > 0 ? null : '1 分钟与分时都没有数据' }
    if (deps.fetchJson === undefined) barsCache.set(secid, { at: Date.now(), value })
    return value
  } catch (error) {
    return { bars: [], source: null, reason: `1 分钟/分时取数失败（${String(error).slice(0, 60)}）` }
  }
}

async function defaultTrend(secid: string): Promise<Array<{ t: number; price: number }>> {
  const { fetchTrend } = await import('./em.ts')
  const data = await fetchTrend(secid, 1)
  return (data?.points ?? []).map((p) => ({ t: p.t, price: p.price }))
}

/* ────────────────────────── 引擎编排 ────────────────────────── */

export interface QuoteLite {
  name: string
  price: number | null
  prev: number | null
}

export interface TradingDeps {
  now?: () => number
  quotes: (secids: string[]) => Promise<Record<string, QuoteLite>>
  bars: (secid: string, day: string) => Promise<BarsResult>
  /** 参与率上限（默认 10%）；成交股数 ≤ volume × participationRate */
  participationRate?: number
}

const idOf = (order: { secid: string; side: string; price: number; shares: number; decidedAt: number }): string =>
  `o-${order.decidedAt}-${order.secid}-${order.side}-${order.price}-${order.shares}`

export interface ClampContext {
  cash: number
  positions: ReadonlyArray<{ secid: string; qty: number; price: number | null; industry?: string | null }>
  limits: { singlePct?: number | null; totalPct?: number | null; byIndustry?: PrismIndustryLimits }
  industries?: Record<string, string | null>
  at: number
}

export interface ClampResult {
  decision: PrismDecision
  events: PrismClampEvent[]
  rejected: PrismDecision['rejects']
}

const lot = (shares: number): number => Math.max(0, Math.floor(shares / 100) * 100)

/** 确定性裁剪链：单票 → 行业 → 总仓 → 现金；只裁模型已给的买单，不新建、不重分配；卖出不动。 */
export function clampDecision(decision: PrismDecision, ctx: ClampContext): ClampResult {
  const positions = ctx.positions.map((p) => ({ ...p, value: p.qty * (p.price ?? 0) }))
  const missingPrice = positions.some((p) => p.price === null)
  const totalAssets = ctx.cash + positions.reduce((sum, p) => sum + p.value, 0)
  const industryValue = (name: string): number => positions.filter((p) => (p.industry ?? ctx.industries?.[p.secid] ?? null) === name).reduce((sum, p) => sum + p.value, 0)
  const industryLimitOf = (name: string): number | undefined => Array.isArray(ctx.limits.byIndustry)
    ? ctx.limits.byIndustry.find((x) => x.name === name)?.limitPct
    : ctx.limits.byIndustry?.[name]
  const events: PrismClampEvent[] = []
  const rejected: PrismDecision['rejects'] = []
  let cashLeft = ctx.cash
  const accepted: Array<{ secid: string; industry: string | null; value: number }> = []
  const buyValue = (secid: string): number => positions.filter((p) => p.secid === secid).reduce((sum, p) => sum + p.value, 0) + accepted.filter((x) => x.secid === secid).reduce((sum, x) => sum + x.value, 0)
  const orders: PrismDecision['orders'] = []
  for (const order of decision.orders) {
    if (order.side === 'sell') { orders.push(order); continue }
    const before = order.shares
    let shares = lot(order.shares)
    const px = order.price
    const existing = buyValue(order.secid)
    const dims: Array<{ dimension: PrismClampEvent['dimension']; max: number | null; current: number; basis: string }> = []
    if (!missingPrice && typeof ctx.limits.singlePct === 'number' && totalAssets > 0) {
      dims.push({ dimension: 'single', max: totalAssets * ctx.limits.singlePct / 100, current: existing, basis: `单票 ${ctx.limits.singlePct}% × 总资产 ${totalAssets.toFixed(2)}` })
    }
    const industry = ctx.industries?.[order.secid] ?? positions.find((p) => p.secid === order.secid)?.industry ?? null
    const indLimit = industry === null ? undefined : industryLimitOf(industry)
    if (!missingPrice && industry !== null && typeof indLimit === 'number' && totalAssets > 0) {
      const currentIndustry = industryValue(industry) + accepted.filter((x) => x.industry === industry).reduce((sum, x) => sum + x.value, 0)
      dims.push({ dimension: 'industry', max: totalAssets * indLimit / 100, current: currentIndustry, basis: `行业 ${industry} ${indLimit}% × 总资产` })
    }
    if (!missingPrice && typeof ctx.limits.totalPct === 'number' && totalAssets > 0) {
      const currentTotal = positions.reduce((sum, p) => sum + p.value, 0) + accepted.reduce((sum, x) => sum + x.value, 0)
      dims.push({ dimension: 'total', max: totalAssets * ctx.limits.totalPct / 100, current: currentTotal, basis: `总仓 ${ctx.limits.totalPct}% × 总资产` })
    }
    for (const d of dims) {
      if (d.max === null) continue
      const room = Math.max(0, d.max - d.current)
      const maxShares = lot(Math.floor(room / px))
      if (shares > maxShares) {
        const after = maxShares
        events.push({ at: ctx.at, secid: order.secid, dimension: d.dimension, before: shares, after, basis: d.basis })
        shares = after
      }
    }
    const cashMax = lot(Math.floor(cashLeft / px))
    if (shares > cashMax) {
      const after = cashMax
      events.push({ at: ctx.at, secid: order.secid, dimension: 'cash', before: shares, after, basis: `现金 ${cashLeft.toFixed(2)}` })
      shares = after
    }
    if (shares < 100) {
      rejected.push({ secid: order.secid, side: 'buy', price: order.price, shares: before, reason: '裁剪后不足一手（<100 股）' })
      continue
    }
    orders.push({ ...order, shares })
    accepted.push({ secid: order.secid, industry, value: shares * px })
    cashLeft = Math.max(0, cashLeft - shares * px)
  }
  return { decision: { ...decision, orders, rejects: [...decision.rejects, ...rejected], clampEvents: events }, events, rejected }
}

/** 按当日决策落挂单：先撤销指定单，再逐笔做静态约束（拒绝也留痕） */
export interface PlaceDecisionResult {
  orders: PrismOrder[]
  rejects: PrismDecision['rejects']
  placement: {
    placed: number
    skipped: number
    rejects: Array<{ secid: string; reason: string }>
    skippedReasons: Array<{ secid: string; reason: string }>
  }
}

export async function placeDecision(
  store: PrismTradingStore,
  decision: PrismDecision,
  now: number,
  quotes: Record<string, QuoteLite>,
): Promise<PlaceDecisionResult> {
  const day = dayOf(now)
  const account = rollDay(store.account(), day, store.equity().at(-1)?.equity ?? null)
  const orders = store.orders().map((o) => ({ ...o }))
  for (const id of decision.cancel) {
    const o = orders.find((x) => x.id === id && x.status === 'pending')
    if (o !== undefined) {
      o.status = 'cancelled'
      o.cancelledAt = now
      o.cancelReason = '后续研判撤销'
    }
  }
  const out: PrismOrder[] = []
  const rejects: PrismDecision['rejects'] = []
  const skippedReasons: Array<{ secid: string; reason: string }> = []
  const hhmm = hhmmOf(now)
  const afterHours = hhmm >= '15:00' || hhmm < '09:30'
  for (const d of decision.orders) {
    const q = quotes[d.secid]
    const position = account.positions.find((p) => p.secid === d.secid)
    const limits = limitsOf(d.secid, q?.name ?? d.secid, q?.prev ?? null)
    const order: PrismOrder = {
      id: idOf({ ...d, decidedAt: now }),
      secid: d.secid,
      name: q?.name ?? d.secid,
      side: d.side,
      price: d.price,
      shares: d.shares,
      reason: d.reason,
      decidedAt: now,
      day,
      status: 'pending',
    }
    if (orders.some((o) => o.id === order.id)) {
      skippedReasons.push({ secid: d.secid, reason: '重复决策（同一秒/同一委托已存在）' })
      continue
    }
    if (afterHours) {
      const reason = `盘后不下单（${hhmm}，A股 15:00 收盘）`
      order.status = 'rejected'
      order.rejectReason = reason
      orders.push(order)
      out.push(order)
      rejects.push({ secid: d.secid, side: d.side, price: d.price, shares: d.shares, reason })
      continue
    }
    const reason = q === undefined
      ? '未取到行情（停牌/代码无效）'
      : rejectReasonOf(order, {
          limits,
          suspended: q.price === null,
          positionQty: position?.qty ?? 0,
          availableQty: position?.available ?? 0,
        })
    if (reason !== null) {
      order.status = 'rejected'
      order.rejectReason = reason
    }
    orders.push(order)
    out.push(order)
  }
  await store.saveAccount(account)
  await store.saveOrders(orders, store.fills())
  return {
    orders: out,
    rejects,
    placement: {
      placed: out.filter((o) => o.status === 'pending').length,
      skipped: skippedReasons.length,
      rejects: rejects.map((r) => ({ secid: r.secid, reason: r.reason })),
      skippedReasons,
    },
  }
}

/** 从 orders.json 的已成交单重建 fills 与现金（只读推断；不写盘，标注「重建」） */
export interface RebuiltLedger {
  fills: PrismFill[]
  /** 以当前 capitalLimit 为起点的推算现金（未含历史入金/未知成交） */
  cash: number
  note: string
}

export function rebuildFromOrders(account: PrismAccount, orders: readonly PrismOrder[]): RebuiltLedger {
  let cash = account.capitalLimit
  const fills: PrismFill[] = []
  for (const o of orders) {
    if (o.status !== 'filled') continue
    const price = o.fillPrice ?? o.price
    const amount = money(price * o.shares)
    const fee = o.fee ?? 0
    cash = money(cash + (o.side === 'sell' ? amount - fee : -amount - fee))
    fills.push({
      orderId: o.id,
      secid: o.secid,
      name: o.name,
      side: o.side,
      price,
      shares: o.shares,
      amount,
      fee,
      at: o.filledAt ?? o.decidedAt,
      source: o.source ?? 'trend',
    })
  }
  return { fills, cash, note: `据 orders.json 的 ${fills.length} 笔已成交单推断；未包含历史入金/未知成交，cash 仅作参考` }
}

/** 30 秒撮合：跨日挂单失效；1 分钟 high/low 触及按挂单价成交；净值每日一点 */
export async function matchTick(
  store: PrismTradingStore,
  deps: TradingDeps,
): Promise<{ filled: number; rejected: number; skipped: Array<{ id: string; code: string; reason: string }>; rejects: Array<{ id: string; code: string; reason: string }> }> {
  const now = (deps.now ?? Date.now)()
  const day = dayOf(now)
  const rate = deps.participationRate ?? 0.1
  const account = rollDay(store.account(), day, store.equity().at(-1)?.equity ?? null)
  const orders = store.orders().map((o) => ({ ...o }))
  const fills = store.fills().slice()
  let filled = 0
  let rejected = 0
  const skipped: Array<{ id: string; code: string; reason: string }> = []
  for (const order of orders) {
    if (order.status !== 'pending') continue
    if (order.day !== day) {
      order.status = 'cancelled'
      order.cancelledAt = now
      order.cancelReason = '当日未成交，次日失效'
      continue
    }
    const quoteMap = await deps.quotes([order.secid])
    const q = quoteMap[order.secid]
    const position = account.positions.find((p) => p.secid === order.secid)
    const limits = limitsOf(order.secid, order.name, q?.prev ?? null)
    const reason = q === undefined
      ? '未取到行情（停牌/代码无效）'
      : rejectReasonOf(order, {
          limits,
          suspended: q.price === null,
          positionQty: position?.qty ?? 0,
          availableQty: position?.available ?? 0,
        })
    if (reason !== null) {
      order.status = 'rejected'
      order.rejectReason = reason
      rejected += 1
      continue
    }
    const barsResult = await deps.bars(order.secid, day)
    if (barsResult.source === null) {
      // 瞬时失败不是终态：保留 pending，下一 tick 重试
      order.skipCode = 'transient-source'
      order.skipReason = barsResult.reason ?? '撮合数据暂不可用（下一 tick 重试）'
      skipped.push({ id: order.id, code: order.skipCode, reason: order.skipReason })
      continue
    }
    if (barsResult.source === 'trend') {
      order.skipCode = 'trend-no-1min'
      order.skipReason = '仅分时源（无 1 分钟成交量），本轮不成交并保持 pending'
      skipped.push({ id: order.id, code: order.skipCode, reason: order.skipReason })
      continue
    }
    // 同一 bar 只处理一次；下一根 bar 才推进（避免同一分钟 volume 被每个 tick 重复使用）
    const bars = order.lastBarTime === undefined
      ? barsResult.bars
      : barsResult.bars.filter((b) => b.t > (order.lastBarTime as number))
    const hit = matchOrder(order, bars)
    if (hit === null) continue
    const bar = barsResult.bars.find((b) => b.t === hit.at)
    order.lastBarTime = hit.at
    const volume = bar?.volume
    if (volume === null || volume === undefined) {
      order.skipCode = 'vol-missing'
      order.skipReason = '上游未给成交量（volume=null），本轮不成交并保持 pending'
      skipped.push({ id: order.id, code: order.skipCode, reason: order.skipReason })
      continue
    }
    if (!(volume > 0)) {
      order.skipCode = 'vol-zero'
      order.skipReason = '该分钟成交量为 0，本轮不成交并保持 pending'
      skipped.push({ id: order.id, code: order.skipCode, reason: order.skipReason })
      continue
    }
    const remaining = order.shares - (order.filledShares ?? 0)
    const barFilled = fills.filter((f) => f.secid === order.secid && f.at === hit.at).reduce((sum, f) => sum + f.shares, 0)
    const barCap = Math.max(0, Math.floor(volume * rate) - barFilled)
    const take = Math.min(remaining, barCap)
    if (take <= 0) {
      order.skipCode = 'bar-volume-used'
      order.skipReason = `该 bar 量能上限已用完（${barFilled}/${Math.floor(volume * rate)} 股），下一根 bar 再处理`
      skipped.push({ id: order.id, code: order.skipCode, reason: order.skipReason })
      continue
    }
    const checkOrder = { ...order, shares: take }
    const blocked = fillRejectReasonOf(account, checkOrder, hit.price)
    if (blocked !== null) {
      order.status = 'rejected'
      order.rejectReason = blocked
      rejected += 1
      continue
    }
    const amount = money(hit.price * take)
    const prior = fills.filter((f) => f.orderId === order.id)
    const priorAmount = prior.reduce((sum, f) => sum + f.amount, 0)
    const priorCommission = prior.reduce((sum, f) => sum + (typeof f.commission === 'number' ? f.commission : 0), 0)
    const feeParts = feesOf(order.side, hit.price, take, priorAmount, priorCommission)
    const fee = feeParts.total
    const fill: PrismFill = {
      orderId: order.id,
      secid: order.secid,
      name: order.name,
      side: order.side,
      price: hit.price,
      shares: take,
      amount,
      fee,
      commission: feeParts.commission,
      at: hit.at,
      source: '1min',
    }
    const nextAccount = applyFill(account, order, fill)
    account.cash = nextAccount.cash
    account.realized = nextAccount.realized
    account.positions = nextAccount.positions
    order.filledShares = (order.filledShares ?? 0) + take
    if (order.filledShares >= order.shares) {
      order.status = 'filled'
      order.filledAt = hit.at
      order.fillPrice = hit.price
      order.fee = (order.fee ?? 0) + fee
      order.source = '1min'
      order.skipCode = undefined
      order.skipReason = undefined
    } else {
      order.status = 'pending'
      order.skipCode = 'partial'
      order.skipReason = `部分成交 ${order.filledShares}/${order.shares}，余量排队`
    }
    fills.push(fill)
    filled += 1
  }
  await store.saveAccount(account)
  await store.saveOrders(orders, fills)
  const quoteMap = await deps.quotes(account.positions.map((p) => p.secid)).catch(() => ({}))
  const point = equityPointOf(account, (secid) => quoteMap[secid]?.price ?? null, now)
  await store.saveEquity(upsertEquity(store.equity(), point))
  return { filled, rejected, skipped, rejects: skipped }
}
