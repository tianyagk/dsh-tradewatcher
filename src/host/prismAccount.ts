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

export const PRISM_INITIAL_CAPITAL = 1_500_000
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

/** 三项费用（逐笔；佣金最低 5 元，印花税只在卖出） */
export function feesOf(side: 'buy' | 'sell', price: number, shares: number): FeeBreakdown {
  const amount = price * shares
  const commission = Math.max(COMMISSION_MIN, money(amount * COMMISSION_RATE))
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
      const qty = p.qty + fill.shares
      p.cost = money((p.qty * p.cost + fill.amount + fill.fee) / qty)
      p.qty = qty
    }
  } else {
    const p = positions[idx]
    if (p === undefined) throw new Error('卖出无持仓（内部错误）')
    cash = money(cash + fill.amount - fill.fee)
    realized = money(realized + (fill.price - p.cost) * fill.shares - fill.fee)
    p.qty -= fill.shares
    p.available = Math.max(0, p.available - fill.shares)
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
    positions.push({ secid: r.secid, name: r.name, qty: take, available: take, cost })
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
): PrismEquityPoint {
  const positionsValue = money(account.positions.reduce((a, p) => a + p.qty * (priceOf(p.secid) ?? p.cost), 0))
  const equity = money(account.cash + positionsValue)
  const day = account.day || dayOf(now)
  return {
    day,
    equity,
    cash: account.cash,
    positionsValue,
    realized: account.realized,
    unrealized: money(equity - account.capitalLimit),
    at: now,
  }
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
  if (m === null) return { decision: null, parseError: text.slice(0, 4000) }
  try {
    const raw = JSON.parse(m[1] as string) as Record<string, unknown>
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
    const decision: PrismDecision = {
      limits: {
        singlePct: typeof limitsRaw['singlePct'] === 'number' ? limitsRaw['singlePct'] : null,
        totalPct: typeof limitsRaw['totalPct'] === 'number' ? limitsRaw['totalPct'] : null,
        note: typeof limitsRaw['note'] === 'string' ? limitsRaw['note'] : null,
      },
      orders,
      cancel,
      rejects: [],
      parseError,
    }
    return { decision, parseError: null }
  } catch {
    return { decision: null, parseError: (m[1] as string).slice(0, 4000) }
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
    if (acc !== null && typeof acc === 'object') this.accountValue = normalizeAccount(acc as Record<string, unknown>)
    const ord = await this.readJson('prism-orders.json')
    const ordRoot = ord as { orders?: unknown; fills?: unknown } | null
    this.ordersValue = Array.isArray(ordRoot?.orders) ? (ordRoot?.orders as PrismOrder[]) : []
    this.fillsValue = Array.isArray(ordRoot?.fills) ? (ordRoot?.fills as PrismFill[]) : []
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

  async saveAccount(account: PrismAccount): Promise<void> {
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
    capitalLimit: typeof raw['capitalLimit'] === 'number' ? raw['capitalLimit'] : PRISM_INITIAL_CAPITAL,
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
          return { t, high: Number(r['high']), low: Number(r['low']) }
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
          .map((r) => ({ t: Date.parse(`${String(r[0]).slice(0, 4)}-${String(r[0]).slice(4, 6)}-${String(r[0]).slice(6, 8)}T${String(r[0]).slice(8, 10)}:${String(r[0]).slice(10, 12)}:00+08:00`), high: Number(r[3]), low: Number(r[4]) }))
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
}

const idOf = (order: { secid: string; side: string; price: number; shares: number; decidedAt: number }): string =>
  `o-${order.decidedAt}-${order.secid}-${order.side}-${order.price}-${order.shares}`

/** 按当日决策落挂单：先撤销指定单，再逐笔做静态约束（拒绝也留痕） */
export interface PlaceDecisionResult {
  orders: PrismOrder[]
  rejects: PrismDecision['rejects']
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
    if (orders.some((o) => o.id === order.id)) continue
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
  return { orders: out, rejects }
}

/** 30 秒撮合：跨日挂单失效；1 分钟 high/low 触及按挂单价成交；净值每日一点 */
export async function matchTick(
  store: PrismTradingStore,
  deps: TradingDeps,
): Promise<{ filled: number; rejected: number }> {
  const now = (deps.now ?? Date.now)()
  const day = dayOf(now)
  const account = rollDay(store.account(), day, store.equity().at(-1)?.equity ?? null)
  const orders = store.orders().map((o) => ({ ...o }))
  const fills = store.fills().slice()
  let filled = 0
  let rejected = 0
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
      order.status = 'rejected'
      order.rejectReason = barsResult.reason ?? '撮合数据不可用'
      rejected += 1
      continue
    }
    const hit = matchOrder(order, barsResult.bars)
    if (hit === null) continue
    const blocked = fillRejectReasonOf(account, order, hit.price)
    if (blocked !== null) {
      order.status = 'rejected'
      order.rejectReason = blocked
      rejected += 1
      continue
    }
    const amount = money(hit.price * order.shares)
    const fee = feesOf(order.side, hit.price, order.shares).total
    const fill: PrismFill = {
      orderId: order.id,
      secid: order.secid,
      name: order.name,
      side: order.side,
      price: hit.price,
      shares: order.shares,
      amount,
      fee,
      at: hit.at,
      source: barsResult.source,
    }
    const nextAccount = applyFill(account, order, fill)
    account.cash = nextAccount.cash
    account.realized = nextAccount.realized
    account.positions = nextAccount.positions
    order.status = 'filled'
    order.filledAt = hit.at
    order.fillPrice = hit.price
    order.fee = fee
    order.source = barsResult.source
    fills.push(fill)
    filled += 1
  }
  await store.saveAccount(account)
  await store.saveOrders(orders, fills)
  const quoteMap = await deps.quotes(account.positions.map((p) => p.secid)).catch(() => ({}))
  const point = equityPointOf(account, (secid) => quoteMap[secid]?.price ?? null, now)
  await store.saveEquity(upsertEquity(store.equity(), point))
  return { filled, rejected }
}
