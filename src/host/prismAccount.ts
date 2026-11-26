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
 * 三个账本文件（account / orders / equity）走 `updateJsonLocked` + `ReadGuard`。
 *
 * 两条红线（v0.215.0，AUDIT-HOST-PERF P0-1/P0-2）：
 *   ① **单飞 + 一次写**：`runExclusive` 串行化 matchTick / 落单 / 订正 / 持仓调整；
 *      `saveAll` 在同一组文件锁内把三份账本一次提交（先写唯一临时文件，再 rename；
 *      提交失败按写前字节回滚）。
 *   ② **读不到 ≠ 空库**：parse 错误 / EACCES / 非预期结构 ⇒ `degraded`（fail-closed），
 *      禁止任何写入，`account()` 返回 null 语义；只有 `repairLedger` 从 `*.bak` /
 *      `.corrupt-*` 恢复成功才解除。
 */
import { AsyncLocalStorage } from 'node:async_hooks'
import { mkdir, readFile, readdir, stat } from 'node:fs/promises'
import { basename, isAbsolute, join } from 'node:path'
import type {
  PrismAccount,
  PrismClampEvent,
  PrismClampSkip,
  PrismFeeCorrection,
  PrismIndustryLimits,
  PrismCopyLog,
  PrismDecision,
  PrismEquityPoint,
  PrismFill,
  PrismOrder,
  PrismPosition,
} from '../shared/prism.ts'
import { dataHome } from './store.ts'
import { LockTimeoutError, readJsonForUpdate, updateJsonLocked, withFileLocks } from './lock.ts'
import { ReadGuard, isFirstBoot, quarantineFile } from './readGuard.ts'
import { dayOf, hhmmOf } from './time.ts'
import type { AutoTFile, AutoTResultRec } from './prismStore.ts'
import { withHostBreaker } from './breakerFetch.ts'
import { writeFileAtomic, writeFileSetAtomic, type AtomicFileSetEntry } from './atomic.ts'

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
  /** ETF 免印花税（A 股规则）；普通股票 false */
  stampExempt = false,
): FeeBreakdown {
  const amount = price * shares
  const totalAmount = priorAmount + amount
  const dueCommission = Math.max(COMMISSION_MIN, money(totalAmount * COMMISSION_RATE))
  const commission = money(Math.max(0, dueCommission - priorCommission))
  const stamp = side === 'sell' && !stampExempt ? money(amount * STAMP_RATE) : 0
  const transfer = money(amount * TRANSFER_RATE)
  return { commission, stamp, transfer, total: money(commission + stamp + transfer) }
}

export interface FeeCorrectionInput {
  orderId: string
  secid: string
  at: number
  price: number
}

export interface FeeCorrectionResult {
  account: PrismAccount
  correction: PrismFeeCorrection
  credit: number
  duplicate: boolean
}

/** 对同一委托/bar/价的拆单重算整单费用；只改 cash/realized + 一条留痕，不改 fills */
export function applyFeeCorrection(
  account: PrismAccount,
  fills: readonly PrismFill[],
  input: FeeCorrectionInput,
  now = Date.now(),
): FeeCorrectionResult {
  const group = fills.filter((f) => f.orderId === input.orderId && f.secid === input.secid && f.at === input.at && f.price === input.price)
  if (group.length === 0) throw new Error('没有匹配的 fills，拒绝订正')
  const orderKey = `${input.orderId}|${input.secid}|${input.at}|${input.price}`
  const beforeFee = money(group.reduce((sum, f) => sum + f.fee, 0))
  const amount = money(group.reduce((sum, f) => sum + f.amount, 0))
  const side = group[0]?.side ?? 'buy'
  const commission = Math.max(COMMISSION_MIN, money(amount * COMMISSION_RATE))
  const stamp = side === 'sell' ? money(amount * STAMP_RATE) : 0
  const transfer = money(amount * 0.00001)
  const afterFee = money(commission + stamp + transfer)
  const credit = money(Math.max(0, beforeFee - afterFee))
  const correction: PrismFeeCorrection = {
    at: now, secid: input.secid, orderIds: [...new Set(group.map((f) => f.orderId))],
    orderKey, beforeFee, afterFee, credit, reason: '拆单重复收取最低佣金',
  }
  const duplicate = (account.feeCorrections ?? []).some((c) => c.orderKey === orderKey)
  if (duplicate) return { account, correction: { ...correction, credit: 0 }, credit: 0, duplicate: true }
  return {
    account: {
      ...account,
      cash: money(account.cash + credit),
      realized: money(account.realized + credit),
      feeCorrections: [...(account.feeCorrections ?? []), correction],
    },
    correction, credit, duplicate: false,
  }
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
    // 必须比「**剩余未成交**股数」：用原始 shares 比较时，部分成交后（如 1000 股成交 789、剩 211）
    // 会把剩余 211 误判成 T+1 不可卖——而它正是今天可卖的那 211 股（实测 2026-11-24 儒意电影）。
    const remaining = Math.max(0, order.shares - (order.filledShares ?? 0))
    if (ctx.availableQty < remaining) return `T+1 不可卖（今日可卖 ${ctx.availableQty} 股，剩余 ${remaining} 股）`
  }
  return null
}

/** 已拒绝委托的最小形状（去重闸只认这五项 + 原因） */
export interface RejectedOrderLike {
  secid: string
  side: 'buy' | 'sell'
  price: number
  shares: number
  reason: string
}

/**
 * 纯函数：是否与「今日已拒绝」的委托重复。
 *
 * 判据（用户裁决）：同 `secid`、同 `side`、`|shares 差| ≤ 100`、`|price 差| / price ≤ 0.5%`。
 * 价格分母取**前次被拒委托**的价格；前次价格非正 ⇒ 无法比较，按不重复处理。
 * 返回命中的前次委托（供 reject 文案取原因），未命中返回 null。
 */
export function isDuplicateRejected(
  order: { secid: string; side: 'buy' | 'sell'; price: number; shares: number },
  rejectedToday: readonly RejectedOrderLike[],
): RejectedOrderLike | null {
  for (const prior of rejectedToday) {
    if (prior.secid !== order.secid || prior.side !== order.side) continue
    if (Math.abs(prior.shares - order.shares) > 100) continue
    if (!(prior.price > 0) || !Number.isFinite(order.price)) continue
    // 0.5% 是闭区间；加 1e-9 只吸收浮点误差，不放宽口径
    if (Math.abs(prior.price - order.price) > prior.price * 0.005 + 1e-9) continue
    return prior
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
  // 老账本没有 available ⇒ 按 qty 处理（与 clamp 的回落一致，否则合法卖单会被判 T+1 0 股）
  const available = position?.available ?? position?.qty ?? 0
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
      positions.push({ secid: order.secid, name: order.name, qty: fill.shares, available: 0, cost: money((fill.amount + fill.fee) / fill.shares), avgCost: money((fill.amount + fill.fee) / fill.shares) })
    } else {
      const p = positions[idx] as PrismPosition
      const net = p.netCost ?? p.qty * p.cost
      const avg0 = p.avgCost ?? p.cost
      p.netCost = money(net + fill.amount + fill.fee)
      // 买入均价：只有买入会改变它（卖出不动），作为止损判定的成本口径
      p.avgCost = money((avg0 * p.qty + fill.amount + fill.fee) / (p.qty + fill.shares))
      p.qty += fill.shares
      p.cost = money(p.netCost / p.qty)
    }
  } else {
    const p = positions[idx]
    if (p === undefined) throw new Error('卖出无持仓（内部错误）')
    if (fill.shares > p.qty) throw new Error(`卖出超过持仓（内部错误：${fill.shares} > ${p.qty}）`)
    cash = money(cash + fill.amount - fill.fee)
    // v0.226.0：卖出只冲减**账面成本**（每股成本 × 股数），不再用卖出所得冲减。
    // 旧写法在盈利卖出时会把 netCost 冲成负数 ⇒ cost 为负 ⇒ 浮盈被放大一倍（审计 A1）；
    // 亏损卖出也不再抬高成本（用户反馈的"越卖越亏"）。卖出盈亏全部体现在 realized。
    const net = p.netCost ?? p.qty * p.cost
    const book = money(p.cost * fill.shares)
    realized = money(realized + (fill.amount - fill.fee) - book)
    p.netCost = money(net - book)
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
    positions.push({ secid: r.secid, name: r.name, qty: take, available: take, cost, netCost: money(take * cost), avgCost: cost })
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
    // 复制 = 新账本：已实现盈亏归零（旧实现沿用上一本账，导致 equity−capital 与 realized 永久不自洽）
    realized: 0,
    positions,
    copiedAt: now,
    copyLogs: [...account.copyLogs, log].slice(-20),
  }
  return { ok: true, account: next, log, skipped }
}

/**
 * 常规恒等式反解已实现盈亏：`equity = capital + realized + unrealized`
 * ⇒ `realized = equity − capital − unrealized`。
 *
 * 只用于「校平账本」：历史 bug 让 realized 字段与现金/持仓对不上（实测差 846 280 元），
 * 这条式子用当前可观测的 equity / 未实现盈亏把它重新对齐（不编造成交）。
 */
export function realizedFromIdentity(equity: number, capital: number, unrealized: number): number | null {
  // 数据不完整 ⇒ null（调用方必须拒绝写入），不要返回 0 把已实现盈亏洗成 0（审计 A7）
  if (![equity, capital, unrealized].every((v) => Number.isFinite(v))) return null
  return Math.round((equity - capital - unrealized) * 100) / 100
}

/**
 * 回填「买入均价 avgCost」：从**最近一次复制基准**出发，只叠加其后的买入成交（卖出不影响）。
 *
 * 用途：老持仓没有 avgCost，止损只能回落用摊薄成本 —— 而摊薄成本会被亏损卖出越推越高
 * （实测招商轮船 cost 30.71 vs 真实买入均价约 18.2，浮亏显示 −49%，把止损循环又带起来）。
 */
export function avgCostFromHistory(
  secid: string,
  copyLogs: ReadonlyArray<{ at: number; after?: string[] }> | undefined,
  fills: ReadonlyArray<{ secid: string; side: 'buy' | 'sell'; at: number; shares: number; amount: number; fee: number }>,
  adjustments: ReadonlyArray<{ at: number; secid: string; before?: { qty: number; cost: number } | null; after?: { qty: number; cost: number } | null }> | undefined,
  fallback: number,
): number {
  let baseQty = 0
  let baseCost = fallback
  let baseAt = 0
  for (const log of copyLogs ?? []) {
    const hit = (log.after ?? []).find((s) => s.startsWith(`${secid}×`))
    if (hit === undefined) continue
    const m = /^[^×]+×(\d+)@([\d.]+)$/.exec(hit)
    if (m === null) continue
    baseQty = Number(m[1]); baseCost = Number(m[2]); baseAt = log.at
  }
  // 单条事件流：复制基准 → 成交 → 手工调整（手工调整按 after 重置 qty/均价）
  const events: Array<{ at: number; kind: 'buy' | 'sell' | 'adjust'; shares?: number; amount?: number; fee?: number; qty?: number; cost?: number }> = []
  for (const f of fills) if (f.secid === secid && f.at > baseAt) events.push({ at: f.at, kind: f.side, shares: f.shares, amount: f.amount, fee: f.fee })
  for (const a of adjustments ?? []) {
    if (a.secid !== secid || a.at <= baseAt) continue
    if (a.after === null || a.after === undefined) events.push({ at: a.at, kind: 'adjust', qty: 0, cost: 0 })
    else events.push({ at: a.at, kind: 'adjust', qty: a.after.qty, cost: a.after.cost })
  }
  events.sort((x, y) => x.at - y.at)
  let qty = baseQty
  let avg = baseCost
  for (const e of events) {
    if (e.kind === 'adjust') {
      qty = e.qty ?? 0
      // 手工调整给的是摊薄成本；作为新的起始均价（用户明确设定的口径）
      avg = qty > 0 ? (e.cost ?? avg) : 0
      continue
    }
    if (e.kind === 'buy') {
      const total = avg * qty + (e.amount ?? 0) + (e.fee ?? 0)
      qty += e.shares ?? 0
      avg = qty > 0 ? total / qty : avg
      continue
    }
    // sell：数量减少，均价不变；卖空到 0 后重置（之后再有买入会重新建立均价）
    qty -= e.shares ?? 0
    if (qty <= 0) { qty = 0; avg = 0 }
  }
  // 低价 ETF（<10 元）保留 3 位小数，否则 0.6952 会被抹成 0.70
  if (qty > 0 && avg > 0) return avg < 10 ? Math.round(avg * 1000) / 1000 : Math.round(avg * 100) / 100
  // 账本自相矛盾（手工调整前的历史与当前不符）：退化为「基准后买入加权」，仍没有就回落
  const buys = (fills as ReadonlyArray<{ secid: string; side: string; at: number; shares: number; amount: number; fee: number }>)
    .filter((f) => f.secid === secid && f.side === 'buy' && f.at > baseAt).sort((a, b) => a.at - b.at)
  if (buys.length === 0) return Math.round(fallback * 100) / 100
  let q = 0; let a = 0
  for (const b of buys) { const t = a * q + b.amount + b.fee; q += b.shares; a = q > 0 ? t / q : a }
  return a < 10 ? Math.round(a * 1000) / 1000 : Math.round(a * 100) / 100
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
  const markOf = (secid: string, cost: number): number => {
    const px = priceOf(secid)
    // 0/NaN/负价一律视为缺价（否则市值会被打成 0 或 NaN，直接触发假熔断）
    return typeof px === 'number' && Number.isFinite(px) && px > 0 ? px : cost
  }
  const positionsValue = money(account.positions.reduce((a, p) => a + p.qty * markOf(p.secid, p.cost), 0))
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
    // 未实现盈亏 = Σ(市值 − 账面成本)，与 rebase 的恒等式同口径；
    // 旧实现写的是 `equity − capitalLimit`（其实是总盈亏），导致 equity ≠ capital + realized + unrealized。
    unrealized: money(account.positions.reduce((a, p) => a + (p.qty * markOf(p.secid, p.cost) - (p.netCost ?? p.qty * p.cost)), 0)),
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
  // 同日只保留**更晚**的点：GET 与撮合并发时，晚到的旧快照不得覆盖新点（审计 D2）
  const same = list.find((p) => p.day === point.day)
  if (same !== undefined && typeof same.at === 'number' && typeof point.at === 'number' && point.at < same.at) {
    return [...list]
  }
  const out = list.filter((p) => p.day !== point.day)
  out.push(point)
  return out.sort((a, b) => (a.day < b.day ? -1 : 1)).slice(-365)
}

/** 合并两组净值点：同一天取 `at` 更大的那条（保存时防丢点） */
export function mergeEquityLists(a: readonly PrismEquityPoint[], b: readonly PrismEquityPoint[]): PrismEquityPoint[] {
  const byDay = new Map<string, PrismEquityPoint>()
  for (const p of [...a, ...b]) {
    const prev = byDay.get(p.day)
    if (prev === undefined || (typeof p.at === 'number' && typeof prev.at === 'number' && p.at >= prev.at)) byDay.set(p.day, p)
  }
  return [...byDay.values()].sort((x, y) => (x.day < y.day ? -1 : 1)).slice(-365)
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
        // 方向缺省/拼错 ⇒ 丢弃（旧实现默认按 buy，可能把"卖"当"买"下出去）
        side: (o['side'] === 'sell' ? 'sell' : o['side'] === 'buy' ? 'buy' : '') as 'buy' | 'sell' | '',
        price: Number(o['price']),
        shares: Math.round(Number(o['shares'])),
        reason: typeof o['reason'] === 'string' ? o['reason'] : '',
      }))
      .filter((o) => (o.side === 'buy' || o.side === 'sell') && /^[0-9]{1,3}\.[A-Za-z0-9]+$/.test(o.secid) && o.price > 0 && o.shares > 0)
      .map((o) => ({ ...o, side: o.side as 'buy' | 'sell' }))
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
    const tPlansRaw = Array.isArray(raw['tPlans']) ? raw['tPlans'] : []
    const tPlans = tPlansRaw
      .filter((p): p is Record<string, unknown> => p !== null && typeof p === 'object')
      .map((p) => ({
        secid: typeof p['secid'] === 'string' ? p['secid'] : '',
        direction: p['direction'] === 'sell-first' ? ('sell-first' as const) : ('buy-first' as const),
        buyPrice: Number(p['buyPrice']), sellPrice: Number(p['sellPrice']), shares: Math.round(Number(p['shares'])),
        observe: typeof p['observe'] === 'string' ? p['observe'] : null,
        reasoning: typeof p['reasoning'] === 'string' ? p['reasoning'] : null,
        conclusion: typeof p['conclusion'] === 'string' ? p['conclusion'] : null,
      }))
      .filter((p) => /^[0-9]{1,3}\.[A-Za-z0-9]+$/.test(p.secid) && p.buyPrice > 0 && p.sellPrice > p.buyPrice && p.shares >= 100 && p.shares % 100 === 0)
    const decision: PrismDecision = {
      limits: {
        singlePct: typeof limitsRaw['singlePct'] === 'number' && limitsRaw['singlePct'] >= 0 && limitsRaw['singlePct'] <= 100 ? limitsRaw['singlePct'] : null,
        totalPct: typeof limitsRaw['totalPct'] === 'number' && limitsRaw['totalPct'] >= 0 && limitsRaw['totalPct'] <= 100 ? limitsRaw['totalPct'] : null,
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
      ...(tPlans.length === 0 ? {} : { tPlans }),
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

/** 三份账本（物理文件）；`saveAll` 在同一组文件锁内一次提交这三份。 */
export const PRISM_LEDGER_FILES = ['prism-account.json', 'prism-orders.json', 'prism-equity.json'] as const
export type PrismLedgerFile = (typeof PRISM_LEDGER_FILES)[number]

/** 账本读不到 ⇒ 写入被拒（fail-closed）。消息前缀是契约：界面/接口都按「账本不可读」识别。 */
export class LedgerUnreadableError extends Error {
  readonly reason: string
  readonly action: string
  constructor(reason: string, action = '写回棱镜账本') {
    super(`账本不可读，已停止写入（${reason}）；拒绝${action}`)
    this.name = 'LedgerUnreadableError'
    this.reason = reason
    this.action = action
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

const ACCOUNT_KEYS = ['capital', 'capitalLimit', 'cash', 'realized', 'positions'] as const

/** 账户根结构校验：返回 null = 可接受；字符串 = 非预期结构的原因 */
function validateAccountRoot(root: unknown): string | null {
  if (!isRecord(root)) return root === null ? '内容为 null' : `顶层不是对象（${Array.isArray(root) ? '数组' : typeof root}）`
  if (root['account'] !== undefined) {
    return isRecord(root['account']) ? null : 'account 字段不是对象'
  }
  if (!ACCOUNT_KEYS.some((k) => root[k] !== undefined)) return '没有任何账户字段（不是棱镜账户）'
  if (root['positions'] !== undefined && !Array.isArray(root['positions'])) return 'positions 不是数组'
  if (root['cash'] !== undefined && typeof root['cash'] !== 'number') return 'cash 不是数字'
  return null
}

function validateOrdersRoot(root: unknown): string | null {
  if (!isRecord(root)) return root === null ? '内容为 null' : `顶层不是对象（${Array.isArray(root) ? '数组' : typeof root}）`
  if (root['orders'] !== undefined && !Array.isArray(root['orders'])) return 'orders 不是数组'
  if (root['fills'] !== undefined && !Array.isArray(root['fills'])) return 'fills 不是数组'
  return null
}

function validateEquityRoot(root: unknown): string | null {
  if (!isRecord(root)) return root === null ? '内容为 null' : `顶层不是对象（${Array.isArray(root) ? '数组' : typeof root}）`
  if (!Array.isArray(root['points'])) return '缺少 points 数组'
  return null
}

function validatorOf(file: string): (root: unknown) => string | null {
  if (file === 'prism-account.json') return validateAccountRoot
  if (file === 'prism-orders.json') return validateOrdersRoot
  return validateEquityRoot
}

/** 降级时 `account()` 的返回值：数值一律 null（不是 0、更不是初始 150 万），并带 degraded/ledgerError */
function degradedAccount(reason: string): PrismAccount {
  const nullNumber = null as unknown as number
  return {
    day: '',
    capital: nullNumber,
    capitalLimit: nullNumber,
    cash: nullNumber,
    realized: nullNumber,
    dayStartEquity: null,
    positions: [],
    copiedAt: null,
    copyLogs: [],
    degraded: true,
    ledgerError: reason,
  } as unknown as PrismAccount
}

/** 合并委托：以 id 为键；`next` 覆盖同 id 的磁盘旧值，磁盘独有的保留（不丢别的进程刚写的单） */
function mergeOrders(disk: readonly PrismOrder[], next: readonly PrismOrder[]): PrismOrder[] {
  const byId = new Map<string, PrismOrder>()
  for (const o of disk) if (o !== null && typeof o === 'object' && typeof o.id === 'string') byId.set(o.id, o)
  for (const o of next) byId.set(o.id, o)
  return [...byId.values()]
}

/** 合并成交：同委托/标的/bar/价/方向/股数视为同一笔（重复写入幂等） */
function mergeFills(disk: readonly PrismFill[], next: readonly PrismFill[]): PrismFill[] {
  const keyOf = (f: PrismFill): string => `${f.orderId}|${f.secid}|${f.at}|${f.price}|${f.side}|${f.shares}`
  const byKey = new Map<string, PrismFill>()
  for (const f of disk) if (f !== null && typeof f === 'object') byKey.set(keyOf(f), f)
  for (const f of next) byKey.set(keyOf(f), f)
  return [...byKey.values()].sort((a, b) => a.at - b.at)
}

/** 合并净值点：同一天 `next` 覆盖磁盘旧值 */
function mergeEquity(disk: readonly PrismEquityPoint[], next: readonly PrismEquityPoint[]): PrismEquityPoint[] {
  const byDay = new Map<string, PrismEquityPoint>()
  for (const p of disk) if (p !== null && typeof p === 'object' && typeof p.day === 'string') byDay.set(p.day, p)
  for (const p of next) byDay.set(p.day, p)
  return [...byDay.values()].sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0))
}

export interface PrismLedgerSnapshot {
  account: PrismAccount
  orders: PrismOrder[]
  fills: PrismFill[]
  /** 缺省 ⇒ 沿用内存里的净值点（仍会随三账本一起落盘） */
  equity?: PrismEquityPoint[]
}

export interface SaveAllOptions {
  /** 测试注入：第 N 个文件（1-based）提交前失败；生产不传 */
  failCommitAt?: number
}

export interface LedgerRepairResult {
  ok: boolean
  repaired: Array<{ file: string; source: string }>
  degraded: boolean
  reason: string | null
  notes: string[]
}

export class PrismTradingStore {
  private readonly dir: string
  private readonly guard = new ReadGuard()
  /** file(绝对路径) → 读失败原因；非空 ⇒ degraded（fail-closed） */
  private readonly degradedReasons = new Map<string, string>()
  /** `runExclusive` 的 Promise 链尾（同进程互斥；失败不阻塞后继） */
  private exclusiveTail: Promise<unknown> = Promise.resolve()
  /** 只用于识别「同一异步上下文内的重入」，不能用一个全局布尔（并发请求会互相放行） */
  private readonly exclusiveCtx = new AsyncLocalStorage<true>()
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
  /**
   * `prism-orders.json` 的 **mtime + size** 快照（P2-7）：文件没变就不重读。
   * 页面开着时每 30 s 一次 GET，旧实现每次都读 195 KB；现在只有真的变了才读。
   * `null` = 缓存不可用（写入后主动失效 / 上次读失败 ⇒ 下一次必读）。
   */
  private ordersStamp: { present: boolean; mtimeMs: number; size: number } | null = null
  private ordersCache: { orders: PrismOrder[]; fills: PrismFill[] } | null = null
  /** `reloadOrders` 的读盘/命中计数（只增；运维与测试可观测，不参与业务判断） */
  readonly ordersIo = { read: 0, cached: 0 }

  constructor(dir = dataHome()) {
    this.dir = dir
  }

  private pathOf(name: string): string {
    return join(this.dir, name)
  }

  /** 是否因账本读不到而停写（P0-2）。 */
  get degraded(): boolean {
    return this.degradedReasons.size > 0
  }

  /** 全部读失败原因（文件 + errno/parse 说明）；null = 健康 */
  ledgerError(): string | null {
    if (this.degradedReasons.size === 0) return null
    return [...this.degradedReasons.entries()]
      .map(([file, reason]) => `${basename(file)}: ${reason}`)
      .join('；')
  }

  degradedInfo(): { active: boolean; reason: string | null; files: Array<{ file: string; reason: string }> } {
    return {
      active: this.degraded,
      reason: this.ledgerError(),
      files: [...this.degradedReasons.entries()].map(([file, reason]) => ({ file: basename(file), reason })),
    }
  }

  /** 写前守卫：degraded 或任一账本被 ReadGuard 标记 ⇒ 抛 `LedgerUnreadableError`。 */
  assertWritable(action = '写回棱镜账本'): void {
    const reason = this.ledgerError()
    if (reason !== null) throw new LedgerUnreadableError(reason, action)
    for (const name of PRISM_LEDGER_FILES) {
      this.guard.assertWritable(this.pathOf(name), action)
    }
  }

  /**
   * 单飞：把 `fn` 排在 Promise 链尾，前一个结束（成功或失败）才轮到下一个。
   * matchTick / placeDecision / priceCorrection / position 等"读内存 → 改 → 写盘"必须整体进来。
   */
  async runExclusive<T>(fn: () => Promise<T> | T): Promise<T> {
    // 重入：已在临界区内 ⇒ 直接执行（同一持锁者），否则会排在链尾等待自己、永久挂住（审计 D4）
    if (this.exclusiveCtx.getStore() === true) return fn()
    const run = this.exclusiveTail.then(() => this.exclusiveCtx.run(true, fn))
    this.exclusiveTail = run.then(() => undefined, () => undefined)
    return run
  }

  async init(): Promise<void> {
    await mkdir(this.dir, { recursive: true })
    await this.reloadForWrite()
  }

  /** 从磁盘重新装载三账本；读失败只标记 degraded（不抛、不写）。 */
  async reloadForWrite(): Promise<void> {
    const acc = await this.readLedger('prism-account.json')
    if (acc !== null) {
      // 三种历史格式都兼容：裸 account / { v, account } / { v, account, fills } 或 { v, ...account, fills }
      const root = acc as { account?: unknown }
      const saved = isRecord(root.account) ? root.account : acc
      this.accountValue = normalizeAccount(saved as Record<string, unknown>)
    }
    await this.reloadOrders(acc)
    const eq = await this.readLedger('prism-equity.json')
    if (eq !== null) {
      this.equityValue = (eq as { points: PrismEquityPoint[] }).points
    }
  }

  private markDegraded(file: string, error: unknown): string {
    const reason = this.guard.markUnreadable(file, error)
    this.degradedReasons.set(file, reason)
    console.warn(`[tradewatcher] 棱镜账本不可读（${file}）：${reason.slice(0, 120)} —— 已停止写入`)
    return reason
  }

  /** 锁外只读装载：parse 错误 / EACCES / 非预期结构都算"读不到"，绝不返回空库。 */
  private async readLedger(name: PrismLedgerFile): Promise<unknown> {
    const file = this.pathOf(name)
    try {
      const disk = await readJsonForUpdate(file, 'throw')
      if (disk === null) {
        // 只有 ENOENT（首次启动）才是真的没有
        this.guard.clear(file)
        return null
      }
      const problem = validatorOf(name)(disk)
      if (problem !== null) throw new Error(`非预期结构：${problem}`)
      this.guard.clear(file)
      return disk
    } catch (error) {
      if (isFirstBoot(error)) {
        this.guard.clear(file)
        return null
      }
      this.markDegraded(file, error)
      return null
    }
  }

  /**
   * 启动时的隔离检查。**读不到/坏掉的账本不隔离**：改名会让下一次启动把它当"首次启动"，
   * 30 秒后又被空库覆盖。坏文件留在原地，`degraded` 才能跨重启继续挡住写入；
   * 恢复走 `repairLedger`（从 `.bak` / `.corrupt-*` 复制，原坏文件在修复时才隔离）。
   */
  async quarantine(): Promise<void> {
    for (const name of PRISM_LEDGER_FILES) {
      const file = this.pathOf(name)
      if (this.guard.isBlocked(file)) continue
      try {
        JSON.parse(await readFile(file, 'utf8'))
      } catch (error) {
        if (isFirstBoot(error)) continue
        if (error instanceof SyntaxError) this.markDegraded(file, error)
      }
    }
  }

  /** v0.203.0：数据目录（手工调整的 ledger 与账户同目录） */
  dirOf(): string { return this.dir }

  /** 读账户。degraded ⇒ 数值全 null（不是 0、不是初始 150 万）+ degraded/ledgerError。 */
  account(): PrismAccount {
    const reason = this.ledgerError()
    if (reason !== null) return degradedAccount(reason)
    return JSON.parse(JSON.stringify(this.accountValue)) as PrismAccount
  }

  orders(): PrismOrder[] { return this.ordersValue.slice() }
  fills(): PrismFill[] { return this.fillsValue.slice() }
  equity(): PrismEquityPoint[] { return this.equityValue.slice() }

  private async fileStampOf(file: string): Promise<{ present: boolean; mtimeMs: number; size: number }> {
    try {
      const st = await stat(file)
      return { present: true, mtimeMs: st.mtimeMs, size: st.size }
    } catch {
      return { present: false, mtimeMs: 0, size: 0 }
    }
  }

  /**
   * 订单/成交流水的唯一读取源是 `prism-orders.json`；账户内嵌 orders/fills 只作兼容兜底。
   * GET 会重新调用：外部/上一进程写入的订单不需要重启才能看见。
   *
   * P2-7：GET 路径（`accountRoot === null`）先比 **mtime + size**，文件没变就直接用内存值，
   * 不读盘。写路径（`reloadForWrite` 传 accountRoot）必须重读 —— 内嵌兜底依赖账户内容。
   * 读失败（degraded）时不写缓存：修好之后必须重新读，绝不能用"坏文件那次读到的空值"。
   */
  async reloadOrders(accountRoot: unknown = null): Promise<void> {
    const file = this.pathOf('prism-orders.json')
    const cacheable = accountRoot === null
    if (cacheable && this.ordersCache !== null && this.ordersStamp !== null) {
      const now = await this.fileStampOf(file)
      if (now.present === this.ordersStamp.present && now.mtimeMs === this.ordersStamp.mtimeMs && now.size === this.ordersStamp.size) {
        this.ordersIo.cached += 1
        return
      }
    }
    const stamp = await this.fileStampOf(file)
    this.ordersIo.read += 1
    const ord = await this.readLedger('prism-orders.json')
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
    if (cacheable && !this.guard.isBlocked(file)) {
      this.ordersStamp = stamp
      this.ordersCache = { orders: this.ordersValue, fills: this.fillsValue }
    } else {
      this.ordersStamp = null
      this.ordersCache = null
    }
  }

  /** 本进程刚写过 orders ⇒ mtime 缓存失效（下一次 GET 必读一次，之后继续命中） */
  private invalidateOrdersCache(): void {
    this.ordersStamp = null
    this.ordersCache = null
  }

  /** 写失败若是"读不到/坏文件"（不是锁超时），标记 degraded，避免下一次拿空库覆盖。 */
  private noteWriteFailure(file: string, error: unknown): void {
    if (error instanceof LockTimeoutError) return
    const code = (error as NodeJS.ErrnoException | null)?.code
    const text = String(error)
    if (
      code === 'EACCES' || code === 'EPERM' || code === 'EIO' || code === 'ENOSPC' || code === 'EROFS' ||
      /内容无法解析|非预期结构|Unexpected|JSON/.test(text)
    ) {
      this.markDegraded(file, error)
    }
  }

  /**
   * 写失败若是"读不到/坏文件"（不是锁超时），升级为 degraded 并抛 `LedgerUnreadableError`：
   * 对外统一是「账本不可读，已停止写入（原因）」，而不是一句底层 parse 错误。
   */
  private rethrowWriteFailure(file: string, error: unknown, action: string): never {
    this.noteWriteFailure(file, error)
    if (!(error instanceof LockTimeoutError) && this.degraded) {
      throw new LedgerUnreadableError(this.ledgerError() ?? String(error), action)
    }
    throw error
  }

  async saveAccount(account: PrismAccount, opts: { explicitReset?: boolean } = {}): Promise<void> {
    const file = this.pathOf('prism-account.json')
    this.assertWritable('写回棱镜账户')
    const oldHasData = this.accountValue.positions.length > 0 || this.fillsValue.length > 0
    if (opts.explicitReset !== true && oldHasData && account.positions.length === 0 && this.fillsValue.length === 0) {
      console.warn('[tradewatcher] accountWriteGuard：拒绝把已有持仓/成交流水的账户写成空账户（如确需重置请显式 reset）')
      throw new Error('accountWriteGuard：拒绝把已有数据的账户写成空账户')
    }
    try {
      await updateJsonLocked(file, (disk) => {
        this.assertWritable('写回棱镜账户')
        if (disk !== null && !isRecord(disk)) throw new Error(`prism-account.json 非预期结构：顶层不是对象`)
        return { v: 1, account }
      })
    } catch (error) {
      this.rethrowWriteFailure(file, error, '写回棱镜账户')
    }
    this.accountValue = account
  }

  /**
   * 写委托/成交。`update` 回调必须用**磁盘最新值**合并（审计 P0-1）：
   * 别的进程刚写的委托/成交不能被本进程的内存快照整份覆盖。
   */
  async saveOrders(orders: PrismOrder[], fills: PrismFill[]): Promise<void> {
    const file = this.pathOf('prism-orders.json')
    this.assertWritable('写回棱镜委托')
    let mergedOrders: PrismOrder[] = orders
    let mergedFills: PrismFill[] = fills
    try {
      await updateJsonLocked(file, (disk) => {
        this.assertWritable('写回棱镜委托')
        if (disk !== null && !isRecord(disk)) throw new Error('prism-orders.json 非预期结构：顶层不是对象')
        const root = isRecord(disk) ? disk : null
        const diskOrders = Array.isArray(root?.['orders']) ? (root?.['orders'] as PrismOrder[]) : []
        const diskFills = Array.isArray(root?.['fills']) ? (root?.['fills'] as PrismFill[]) : []
        mergedOrders = mergeOrders(diskOrders, orders)
        mergedFills = mergeFills(diskFills, fills)
        return { v: 1, orders: mergedOrders, fills: mergedFills }
      })
    } catch (error) {
      this.rethrowWriteFailure(file, error, '写回棱镜委托')
    }
    this.ordersValue = mergedOrders
    this.fillsValue = mergedFills
    this.invalidateOrdersCache()
  }

  /** 自动做T 账本（与主三账本同目录，成交仍以 fills 为准） */
  async autoT(): Promise<AutoTFile> {
    try {
      const disk = await readJsonForUpdate(this.pathOf('prism-autot.json'), 'throw') as { plans?: unknown; trades?: unknown; results?: unknown } | null
      if (disk === null) return { plans: [], trades: [], results: [] }
      return {
        plans: (Array.isArray(disk.plans) ? disk.plans : []) as AutoTFile['plans'],
        trades: (Array.isArray(disk.trades) ? disk.trades : []) as AutoTFile['trades'],
        results: (Array.isArray(disk.results) ? disk.results : []) as AutoTFile['results'],
      }
    } catch { return { plans: [], trades: [], results: [] } }
  }

  async saveAutoT(next: AutoTFile): Promise<void> {
    await updateJsonLocked(this.pathOf('prism-autot.json'), () => ({ v: 1, ...next })).catch(() => undefined)
  }

  async saveEquity(points: PrismEquityPoint[]): Promise<void> {
    const file = this.pathOf('prism-equity.json')
    this.assertWritable('写回棱镜净值')
    let merged: PrismEquityPoint[] = points
    try {
      await updateJsonLocked(file, (disk) => {
        this.assertWritable('写回棱镜净值')
        if (disk !== null && !isRecord(disk)) throw new Error('prism-equity.json 非预期结构：顶层不是对象')
        const root = isRecord(disk) ? disk : null
        const diskPoints = Array.isArray(root?.['points']) ? (root?.['points'] as PrismEquityPoint[]) : []
        merged = mergeEquity(diskPoints, points)
        return { v: 1, points: merged }
      })
    } catch (error) {
      this.rethrowWriteFailure(file, error, '写回棱镜净值')
    }
    this.equityValue = merged
  }

  /**
   * **三账本一次写**（P0-1 核心）：同一组文件锁内写 account / orders(含 fills) / equity。
   * 先全部写唯一临时文件，再逐个 rename；提交中途失败按写前字节回滚。
   * 内存只在三份都落盘成功后才更新（失败 ⇒ 内存/磁盘都不前进）。
   */
  async saveAll(next: PrismLedgerSnapshot, opts: SaveAllOptions = {}): Promise<void> {
    this.assertWritable('一次写回棱镜三账本')
    const equity = next.equity ?? this.equityValue
    const entries: AtomicFileSetEntry[] = [
      { target: this.pathOf('prism-account.json'), text: JSON.stringify({ v: 1, account: next.account }, null, 1) },
      { target: this.pathOf('prism-orders.json'), text: JSON.stringify({ v: 1, orders: next.orders, fills: next.fills }, null, 1) },
      { target: this.pathOf('prism-equity.json'), text: JSON.stringify({ v: 1, points: equity }, null, 1) },
    ]
    await withFileLocks(
      entries.map((e) => e.target),
      async () => {
        this.assertWritable('一次写回棱镜三账本')
        // 锁内再确认磁盘现状：坏文件/非预期结构 ⇒ 拒绝覆盖（读不到 ≠ 空库）
        for (const name of PRISM_LEDGER_FILES) {
          const file = this.pathOf(name)
          try {
            const disk = await readJsonForUpdate(file, 'throw')
            if (disk === null) continue
            const problem = validatorOf(name)(disk)
            if (problem !== null) throw new Error(`${name} 非预期结构：${problem}`)
          } catch (error) {
            this.markDegraded(file, error)
            throw new LedgerUnreadableError(this.ledgerError() ?? String(error), '一次写回棱镜三账本')
          }
        }
        // v0.226.0：跨进程保护（审计 D1）——本进程写回前，磁盘上的 orders/fills 不得比内存里多。
        // 少一条就说明另有写入者（另一个 dsh-web 实例、手工脚本），整份覆盖会静默丢成交 ⇒ 拒绝并让人重试。
        try {
          const diskOrders = await readJsonForUpdate(this.pathOf('prism-orders.json'), 'throw') as
            { orders?: Array<{ id?: unknown }>; fills?: Array<{ orderId?: unknown; at?: unknown; shares?: unknown }> } | null
          if (diskOrders !== null) {
            const key = (f: { orderId?: unknown; at?: unknown; shares?: unknown }): string => `${String(f.orderId)}|${String(f.at)}|${String(f.shares)}`
            const mine = new Set(next.fills.map(key))
            const lostFills = (diskOrders.fills ?? []).filter((f) => !mine.has(key(f)))
            const mineOrders = new Set(next.orders.map((o) => o.id))
            const lostOrders = (diskOrders.orders ?? []).filter((o) => !mineOrders.has(String(o.id)))
            if (lostFills.length > 0 || lostOrders.length > 0) {
              throw new Error(`账本已被其他进程写入（成交 ${lostFills.length} 笔 / 委托 ${lostOrders.length} 笔），拒绝覆盖`)
            }
          }
        } catch (error) {
          if (error instanceof LedgerUnreadableError) throw error
          this.markDegraded(this.pathOf('prism-orders.json'), error)
          throw new LedgerUnreadableError(String((error as Error)?.message ?? error), '一次写回棱镜三账本')
        }
        // 净值文件可能被 recordEquity 的 saveEquity 单独写过：锁内合并，不能拿内存旧列表覆盖（审计 D3）
        try {
          const diskEq = await readJsonForUpdate(this.pathOf('prism-equity.json'), 'throw') as { points?: PrismEquityPoint[] } | null
          if (diskEq !== null && Array.isArray(diskEq.points)) {
            const merged = mergeEquityLists(next.equity ?? this.equityValue, diskEq.points)
            const entry = entries.find((e) => e.target === this.pathOf('prism-equity.json'))
            if (entry !== undefined) entry.text = JSON.stringify({ v: 1, points: merged }, null, 1)
          }
        } catch (error) {
          this.markDegraded(this.pathOf('prism-equity.json'), error)
          throw new LedgerUnreadableError(String((error as Error)?.message ?? error), '一次写回棱镜三账本')
        }
        // 内容没变就不写：交易时段 matchTick 每 30s 调一次 saveAll，即使零变化也会重写三份账本
        // （实测 ≈112MB/日 无谓写 + 每次 mtime 变化会让读缓存失效）。逐文件比对**我们自己的序列化文本**：
        // 磁盘文件都是本函数写的（同样 indent=1），文本级比较即可；任何差异都照常整组提交。
        const unchanged = new Set<string>()
        for (const entry of entries) {
          try {
            const raw = await readFile(entry.target, 'utf8')
            if (raw === entry.text) unchanged.add(entry.target)
          } catch { /* 读不到 ⇒ 视为需要写 */ }
        }
        const toWrite = entries.filter((e) => !unchanged.has(e.target))
        if (toWrite.length > 0) {
          await writeFileSetAtomic(toWrite, opts.failCommitAt === undefined ? {} : { failCommitAt: opts.failCommitAt })
        }
      },
      { note: 'prism-ledger-saveAll' },
    )
    this.accountValue = next.account
    this.ordersValue = next.orders
    this.fillsValue = next.fills
    this.equityValue = equity
    this.invalidateOrdersCache()
  }

  private async exists(path: string): Promise<boolean> {
    try {
      await stat(path)
      return true
    } catch {
      return false
    }
  }

  private backupPathOf(backupOf: string): string {
    return isAbsolute(backupOf) || backupOf.includes('/') || backupOf.includes('\\') ? backupOf : join(this.dir, backupOf)
  }

  /** `backupOf`（文件名或路径）对应的账本目标；不是棱镜账本 ⇒ null */
  private targetForBackupName(name: string): string | null {
    const base = basename(name)
    for (const file of PRISM_LEDGER_FILES) {
      if (base === file || base.startsWith(`${file}.bak`) || base.startsWith(`${file}.corrupt-`) || base.startsWith(`${file}.quarantine-`)) {
        return this.pathOf(file)
      }
    }
    return null
  }

  /** 最新备份：`<file>.bak` / `<file>.bak-*` / `<file>.corrupt-*` / `<file>.quarantine-*`，按 mtime 倒序 */
  private async newestBackupOf(target: string): Promise<string | null> {
    const base = basename(target)
    let names: string[]
    try {
      names = await readdir(this.dir)
    } catch {
      return null
    }
    const candidates = names.filter(
      (n) => n === `${base}.bak` || n.startsWith(`${base}.bak-`) || n.startsWith(`${base}.corrupt-`) || n.startsWith(`${base}.quarantine-`),
    )
    const rows = await Promise.all(candidates.map(async (n) => {
      const p = join(this.dir, n)
      try {
        return { p, n, mtime: (await stat(p)).mtimeMs }
      } catch {
        return null
      }
    }))
    const valid = rows.filter((r): r is { p: string; n: string; mtime: number } => r !== null)
    valid.sort((a, b) => b.mtime - a.mtime || (a.n < b.n ? 1 : a.n > b.n ? -1 : 0))
    return valid[0]?.p ?? null
  }

  private async ledgerFileValid(target: string): Promise<boolean> {
    const name = basename(target)
    if (!(PRISM_LEDGER_FILES as readonly string[]).includes(name)) return false
    try {
      const disk = await readJsonForUpdate(target, 'throw')
      return disk !== null && validatorOf(name)(disk) === null
    } catch {
      return false
    }
  }

  private clearDegraded(target: string): void {
    this.degradedReasons.delete(target)
    this.guard.clear(target)
  }

  /**
   * 首次修复路径（P0-2）：从 `*.bak` / `.corrupt-*` 恢复。
   * `backupOf` 可给备份文件名/路径（如 `prism-account.json.bak`），也可给账本名表示"用该账本最新备份"。
   * 只有恢复并重新装载成功后 `degraded` 才解除；没有可用备份 ⇒ 保持 degraded 并如实返回原因。
   */
  async repairLedger(opts: { backupOf?: string } = {}): Promise<LedgerRepairResult> {
    return this.runExclusive(async () => {
      const notes: string[] = []
      const repaired: Array<{ file: string; source: string }> = []
      const jobs: Array<{ target: string; source: string | null }> = []
      if (opts.backupOf !== undefined && opts.backupOf.trim() !== '') {
        const target = this.targetForBackupName(opts.backupOf)
        if (target === null) throw new Error(`backupOf 不是棱镜账本备份：${opts.backupOf}`)
        const explicitSource = basename(opts.backupOf) === basename(target) ? null : this.backupPathOf(opts.backupOf)
        jobs.push({ target, source: explicitSource ?? (await this.newestBackupOf(target)) })
      } else {
        for (const target of this.degradedReasons.keys()) jobs.push({ target, source: await this.newestBackupOf(target) })
      }
      if (jobs.length === 0) {
        notes.push('没有处于 degraded 的账本，无需修复')
      }
      for (const job of jobs) {
        const file = basename(job.target)
        // 显式给了 backupOf ⇒ 强制从该备份恢复（即使当前文件"看起来可读"）；
        // 未指定时先看当前文件是否已经恢复可读，避免无谓覆盖。
        if (opts.backupOf === undefined && await this.ledgerFileValid(job.target)) {
          this.clearDegraded(job.target)
          repaired.push({ file, source: '当前文件（已可读）' })
          notes.push(`${file} 当前文件已可读，无需从备份恢复`)
          continue
        }
        if (job.source === null) {
          notes.push(`${file} 没有可用备份（*.bak / .corrupt-*）`)
          continue
        }
        const text = await readFile(job.source, 'utf8')
        let parsed: unknown
        try {
          parsed = JSON.parse(text) as unknown
        } catch (error) {
          throw new Error(`备份 ${basename(job.source)} 不是合法 JSON：${String(error).slice(0, 120)}`)
        }
        const problem = validatorOf(file)(parsed)
        if (problem !== null) throw new Error(`备份 ${basename(job.source)} 不是有效棱镜账本：${problem}`)
        // 原坏文件改名留存（不覆盖证据）；再原子恢复
        if (await this.exists(job.target)) {
          const parked = await quarantineFile(job.target)
          if (parked !== null) notes.push(`${file} 原文件已隔离为 ${basename(parked)}`)
        }
        await writeFileAtomic(job.target, text)
        this.clearDegraded(job.target)
        repaired.push({ file, source: basename(job.source) })
        notes.push(`${file} 已从 ${basename(job.source)} 恢复`)
      }
      await this.reloadForWrite()
      return {
        ok: this.degradedReasons.size === 0,
        repaired,
        degraded: this.degraded,
        reason: this.ledgerError(),
        notes,
      }
    })
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
    ...(Array.isArray(raw['feeCorrections']) ? { feeCorrections: raw['feeCorrections'] as PrismFeeCorrection[] } : {}),
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

/**
 * 纯函数：**同产品键**（v0.214.0）。取名称中 `ETF` 及之前的部分——
 * `30年国债ETF博时` / `30年国债ETF鹏扬` ⇒ 都是 `30年国债ETF`：同一跟踪标的，
 * 只是不同基金公司发的壳，对组合而言是**同一条腿**。
 *
 * 名称里没有 `ETF` ⇒ 原样返回（不知道就不猜；调用方据此判定「不是 ETF，不适用」）。
 */
export function productKeyOf(name: string): string {
  const text = (name ?? '').trim()
  const at = text.toUpperCase().indexOf('ETF')
  // 大写化只为键比较稳定（大小写不同不该拆成两条腿）；中文不受影响
  return (at < 0 ? text : text.slice(0, at + 3)).toUpperCase()
}

/** 名称是否是 ETF（同产品判据只对 ETF 生效；LOF/普通股不按产品合并） */
export const isEtfName = (name: string): boolean => /ETF/i.test(name ?? '')

export interface ClampContext {
  cash: number
  /** `name` 用于同产品闸（缺 ⇒ 该持仓不参与判据，并记 skipped） */
  positions: ReadonlyArray<{ secid: string; qty: number; price: number | null; name?: string | null; industry?: string | null; available?: number }>
  limits: { singlePct?: number | null; totalPct?: number | null; byIndustry?: PrismIndustryLimits }
  industries?: Record<string, string | null>
  at: number
  /** v0.203.0：settings 六约束（B5）；缺项 ⇒ 不夹紧（R1） */
  constraints?: {
    perStockPct?: number | null
    stopLossPct?: number | null
    perOrderYuan?: number | null
    maxPosPct?: number | null
    maxDDPct?: number | null
    minCashPct?: number | null
  }
  /** 持仓成本（止损判定用） */
  costs?: Record<string, number>
  /** 当日回撤（%，负数）；null/缺省 ⇒ 不判熔断 */
  dayDrawdownPct?: number | null
  /**
   * 今日（北京时间自然日）已被风控拒绝的委托：命中重复判据的单直接进 rejects，
   * 不进入后续裁剪/撮合/挂单。缺省 ⇒ 不去重（旧调用方行为不变）。
   */
  rejectedToday?: readonly RejectedOrderLike[]
  /**
   * v0.214.0：本轮行情（按 secid）——同产品闸取名称、偏离闸取现价。
   * 缺项一律按「缺数据」处理（记 `skipped`），不拿持仓成本或 0 冒充现价。
   */
  quotes?: Record<string, { name?: string | null; price?: number | null } | undefined>
  /** v0.214.0：今日已挂的买单（同键已有挂单 ⇒ 不重复建仓；加仓同一只不在此列） */
  pendingBuys?: ReadonlyArray<{ secid: string; name: string }>
}

export interface ClampResult {
  decision: PrismDecision
  events: PrismClampEvent[]
  rejected: PrismDecision['rejects']
  /** 因缺数据**未做**的校验（不拦单，但必须能被看见） */
  skipped: PrismClampSkip[]
}

const lot = (shares: number): number => Math.max(0, Math.floor(shares / 100) * 100)

/** 确定性裁剪链：单票 → 行业 → 总仓 → 现金；只裁模型已给的买单，不新建、不重分配；卖出不动（重复被拒的除外）。 */
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
  const skipped: PrismClampSkip[] = []
  let cashLeft = ctx.cash
  const accepted: Array<{ secid: string; name: string | null; industry: string | null; value: number }> = []
  const buyValue = (secid: string): number => positions.filter((p) => p.secid === secid).reduce((sum, p) => sum + p.value, 0) + accepted.filter((x) => x.secid === secid).reduce((sum, x) => sum + x.value, 0)
  const orders: PrismDecision['orders'] = []
  // 同一轮内多个重复只留一条 reject（按「标的+方向+前次原因」归并，避免刷屏）
  const duplicateKeys = new Set<string>()
  /** 标的名（行情优先；其次持仓；再次今日挂单）；三级都缺 ⇒ null（缺数据，不猜） */
  const nameOf = (secid: string): string | null => {
    const q = ctx.quotes?.[secid]?.name
    if (typeof q === 'string' && q.trim() !== '') return q
    const held = positions.find((p) => p.secid === secid)?.name
    if (typeof held === 'string' && held.trim() !== '') return held
    const pending = ctx.pendingBuys?.find((p) => p.secid === secid)?.name
    return typeof pending === 'string' && pending.trim() !== '' ? pending : null
  }
  /** 同产品已持有/已挂单的那只（不含本次委托标的自身：对已持有那只继续加仓不拦） */
  const productLegOf = (secid: string, key: string): { secid: string; name: string } | null => {
    for (const p of positions) {
      if (p.secid === secid || !(p.qty > 0)) continue
      const name = nameOf(p.secid)
      if (name !== null && isEtfName(name) && productKeyOf(name) === key) return { secid: p.secid, name }
    }
    for (const p of ctx.pendingBuys ?? []) {
      if (p.secid === secid) continue
      if (isEtfName(p.name) && productKeyOf(p.name) === key) return { secid: p.secid, name: p.name }
    }
    for (const a of accepted) {
      if (a.secid === secid || a.name === null) continue
      if (isEtfName(a.name) && productKeyOf(a.name) === key) return { secid: a.secid, name: a.name }
    }
    return null
  }
  const productRejectKeys = new Set<string>()
  for (const order of decision.orders) {
    const prior = isDuplicateRejected(order, ctx.rejectedToday ?? [])
    if (prior !== null) {
      const key = `${order.secid}|${order.side}|${prior.reason}`
      if (!duplicateKeys.has(key)) {
        duplicateKeys.add(key)
        rejected.push({
          secid: order.secid,
          side: order.side,
          price: order.price,
          shares: order.shares,
          reason: `重复委托（前次拒绝：${prior.reason}）`,
        })
      }
      continue
    }
    // ── B. 委托价偏离闸（v0.214.0）：错价引用 = 直接按错价成交（买卖两侧都会亏），
    //    因此买卖同口径；无现价 ⇒ 不拦（不拿成本/0 顶现价），但记 skipped。
    const marketRaw = ctx.quotes?.[order.secid]?.price
    const market = typeof marketRaw === 'number' && Number.isFinite(marketRaw) && marketRaw > 0 ? marketRaw : null
    if (market === null) {
      skipped.push({ secid: order.secid, gate: 'deviation', reason: '缺现价，未做偏离校验' })
    } else {
      const deviationPct = Math.abs(order.price / market - 1) * 100
      // 3% 是开区间；加 1e-9 只吸收浮点误差（111.2×1.03 会算成 3.0000000000000018），不放宽口径
      if (Number.isFinite(deviationPct) && deviationPct > 3 + 1e-9) {
        rejected.push({
          secid: order.secid,
          side: order.side,
          price: order.price,
          shares: order.shares,
          reason: `委托价偏离现价 ${deviationPct.toFixed(1)}%，疑似引用错标的，需按现价重报`,
        })
        continue
      }
    }
    if (order.side === 'sell') {
      // 卖出先按 T+1 可用数量裁剪：不裁的话每轮都会提交超额卖单 → 被拒 → 下轮再提交（实测 11-24 连续 4400/6000/10900 被拒）
      const pos = positions.find((p) => p.secid === order.secid)
      // 持仓不存在 ⇒ 不在这里裁（交给下单时的「无持仓不可卖」拒绝，保持旧行为）
      if (pos === undefined) { orders.push(order); continue }
      // 旧夹具/旧账本没有 available 字段 ⇒ 视为全部可卖（不改变历史行为）
      const avail = Math.max(0, Math.floor((pos.available ?? pos.qty) / 100) * 100)
      const wanted = lot(order.shares)
      if (avail <= 0) {
        rejected.push({ secid: order.secid, side: 'sell', price: order.price, shares: order.shares, reason: '今日可卖 0 股（T+1），本轮不下单' })
        continue
      }
      if (wanted > avail) {
        events.push({ at: ctx.at, secid: order.secid, dimension: 'available', before: wanted, after: avail, basis: `T+1 可卖 ${avail} 股` })
        orders.push({ ...order, shares: avail })
        continue
      }
      orders.push(order)
      continue
    }
    // ── A. 同产品重复闸（v0.214.0）：只拦买单；已持有「另一只」同键 ETF、
    //    或今日已有同键挂单 ⇒ 拒绝（对已持有的那只继续加仓不拦）。
    const targetName = nameOf(order.secid)
    if (targetName === null) {
      skipped.push({ secid: order.secid, gate: 'product', reason: '缺名称，未做同产品校验' })
    } else if (isEtfName(targetName)) {
      const other = productLegOf(order.secid, productKeyOf(targetName))
      if (other !== null) {
        const key = `${order.secid}|${other.secid}`
        if (!productRejectKeys.has(key)) {
          productRejectKeys.add(key)
          rejected.push({
            secid: order.secid,
            side: 'buy',
            price: order.price,
            shares: order.shares,
            reason: `同产品已持有 ${other.name}（${other.secid}），不重复建仓；如需加仓请直接加该标的`,
          })
        }
        continue
      }
    }
    const before = order.shares
    let shares = lot(order.shares)
    const px = order.price
    const existing = buyValue(order.secid)
    const dims: Array<{ dimension: PrismClampEvent['dimension']; max: number | null; current: number; basis: string }> = []
    // 单票上限：**用户配置优先**。模型自报的 limits.singlePct 只作兜底——
    // 否则「设置里 30%、骨架里 20%、模型照抄骨架」会让配置形同虚设（实测：配置 30，决策仍按 20 减仓）。
    const configuredSingle = typeof ctx.constraints?.perStockPct === 'number' ? ctx.constraints.perStockPct : null
    const singleLimitPct = configuredSingle ?? (typeof ctx.limits.singlePct === 'number' ? ctx.limits.singlePct : null)
    if (!missingPrice && singleLimitPct !== null && totalAssets > 0) {
      dims.push({
        dimension: 'single',
        max: totalAssets * singleLimitPct / 100,
        current: existing,
        basis: configuredSingle !== null
          ? `单票上限 ${singleLimitPct}%（用户配置）× 总资产 ${totalAssets.toFixed(2)}`
          : `单票 ${singleLimitPct}% × 总资产 ${totalAssets.toFixed(2)}`,
      })
    }
    const industry = ctx.industries?.[order.secid] ?? positions.find((p) => p.secid === order.secid)?.industry ?? null
    const indLimit = industry === null ? undefined : industryLimitOf(industry)
    if (!missingPrice && industry !== null && typeof indLimit === 'number' && totalAssets > 0) {
      const currentIndustry = industryValue(industry) + accepted.filter((x) => x.industry === industry).reduce((sum, x) => sum + x.value, 0)
      dims.push({ dimension: 'industry', max: totalAssets * indLimit / 100, current: currentIndustry, basis: `行业 ${industry} ${indLimit}% × 总资产` })
    }
    // 总仓上限：配置优先（maxPosPct），模型自报 totalPct 只在未配置时兜底
    const totalPct = typeof ctx.constraints?.maxPosPct === 'number' ? ctx.constraints.maxPosPct : ctx.limits.totalPct
    if (!missingPrice && typeof totalPct === 'number' && totalAssets > 0) {
      const currentTotal = positions.reduce((sum, p) => sum + p.value, 0) + accepted.reduce((sum, x) => sum + x.value, 0)
      dims.push({ dimension: 'total', max: totalAssets * totalPct / 100, current: currentTotal, basis: `总仓 ${totalPct}% × 总资产${typeof ctx.constraints?.maxPosPct === 'number' ? '（用户配置）' : ''}` })
    }
    const c = ctx.constraints ?? {}
    // 配置了 perStockPct 时，上面 single 维度已经用它 ⇒ 不再重复加一条同义的 perStock 维度
    if (configuredSingle === null && !missingPrice && typeof c.perStockPct === 'number' && totalAssets > 0) {
      dims.push({ dimension: 'perStock', max: totalAssets * c.perStockPct / 100, current: existing, basis: `单票上限 ${c.perStockPct}% × 总资产` })
    }
    if (typeof c.perOrderYuan === 'number' && c.perOrderYuan >= 0) {
      const maxSharesByOrder = lot(Math.floor(c.perOrderYuan / px))
      if (shares > maxSharesByOrder) {
        events.push({ at: ctx.at, secid: order.secid, dimension: 'perOrder', before: shares, after: maxSharesByOrder, basis: `单笔金额上限 ${c.perOrderYuan} 元` })
        shares = maxSharesByOrder
      }
    }
    // 配置了 maxPosPct 时上面的 total 维度已用它 ⇒ 不再重复一条同义维度
    const dd = ctx.dayDrawdownPct
    if (typeof c.maxDDPct === 'number' && typeof dd === 'number' && -dd >= c.maxDDPct) {
      events.push({ at: ctx.at, secid: order.secid, dimension: 'maxDD', before: shares, after: 0, basis: `日回撤 ${dd.toFixed(2)}% 触发熔断 ${c.maxDDPct}%` })
      rejected.push({ secid: order.secid, side: 'buy', price: order.price, shares: before, reason: `日回撤 ${dd.toFixed(2)}% 触发熔断（${c.maxDDPct}%）` })
      continue
    }
    const cost = ctx.costs?.[order.secid]
    // 缺买入均价 ⇒ 不做止损判定并留痕（不要拿摊薄成本兜底：会被亏损卖出越推越高，形成卖出循环）
    if (typeof c.stopLossPct === 'number' && (typeof cost !== 'number' || !(cost > 0))) {
      skipped.push({ secid: order.secid, gate: 'stopLoss', reason: '缺买入均价，未做止损判定（先执行 backfillAvgCost）' })
    }
    if (typeof c.stopLossPct === 'number' && typeof cost === 'number' && cost > 0) {
      const lossPct = (px / cost - 1) * 100
      if (lossPct <= -c.stopLossPct) {
        events.push({ at: ctx.at, secid: order.secid, dimension: 'stopLoss', before: shares, after: 0, basis: `现价较成本 ${lossPct.toFixed(2)}% ≤ 止损线 −${c.stopLossPct}%` })
        rejected.push({ secid: order.secid, side: 'buy', price: order.price, shares: before, reason: `已触及止损线 −${c.stopLossPct}%（当前 ${lossPct.toFixed(2)}%）` })
        continue
      }
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
    if (typeof c.minCashPct === 'number' && totalAssets > 0) {
      const floor = totalAssets * c.minCashPct / 100
      const roomCash = Math.max(0, cashLeft - floor)
      const maxSharesByCashFloor = lot(Math.floor(roomCash / px))
      if (shares > maxSharesByCashFloor) {
        events.push({ at: ctx.at, secid: order.secid, dimension: 'minCash', before: shares, after: maxSharesByCashFloor, basis: `现金下限 ${c.minCashPct}%（≥ ${floor.toFixed(0)} 元）` })
        shares = maxSharesByCashFloor
      }
    }
    if (shares < 100) {
      rejected.push({ secid: order.secid, side: 'buy', price: order.price, shares: before, reason: '裁剪后不足一手（<100 股）' })
      continue
    }
    orders.push({ ...order, shares })
    accepted.push({ secid: order.secid, name: targetName, industry, value: shares * px })
    cashLeft = Math.max(0, cashLeft - shares * px)
  }
  return { decision: { ...decision, orders, rejects: [...decision.rejects, ...rejected], clampEvents: events, clampSkipped: skipped }, events, rejected, skipped }
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
  // 单飞 + fail-closed：读盘最新 → 改内存 → 一次写三账本；degraded 时在第一次 assert 就拒绝。
  return store.runExclusive(async () => {
    store.assertWritable('落单')
    await store.reloadForWrite()
    store.assertWritable('落单')
    return placeDecisionLocked(store, decision, now, quotes)
  })
}

async function placeDecisionLocked(
  store: PrismTradingStore,
  decision: PrismDecision,
  now: number,
  quotes: Record<string, QuoteLite>,
): Promise<PlaceDecisionResult> {
  const day = dayOf(now)
  let account = rollDay(store.account(), day, store.equity().at(-1)?.equity ?? null)
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
      // v0.202.0：引擎落库的委托一律记为自动；人工单不会走这条路径
      origin: 'auto',
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
  await store.saveAll({ account, orders, fills: store.fills(), equity: store.equity() })
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
  // 单飞 + fail-closed：10 个并发 matchTick 也只能一个接一个从磁盘重新装载后撮合。
  return store.runExclusive(async () => {
    store.assertWritable('自动撮合')
    await store.reloadForWrite()
    store.assertWritable('自动撮合')
    return matchTickLocked(store, deps)
  })
}

async function matchTickLocked(
  store: PrismTradingStore,
  deps: TradingDeps,
): Promise<{ filled: number; rejected: number; skipped: Array<{ id: string; code: string; reason: string }>; rejects: Array<{ id: string; code: string; reason: string }> }> {
  const now = (deps.now ?? Date.now)()
  const day = dayOf(now)
  const rate = deps.participationRate ?? 0.1
  let account = rollDay(store.account(), day, store.equity().at(-1)?.equity ?? null)
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
    // 部分成交按量能上限原样成交（ETF 允许非整手撮合，仓里已有 5062 份的既有口径与测试；审计 C2 暂不采纳）
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
    const feeParts = feesOf(order.side, hit.price, take, priorAmount, priorCommission, /ETF/i.test(order.name))
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
    // 每笔成交都累计手续费（旧实现只在完全成交时加，部分成交被拒后 order.fee 缺失，审计 C3）
    order.fee = (order.fee ?? 0) + fee
    if (order.filledShares >= order.shares) {
      order.status = 'filled'
      order.filledAt = hit.at
      order.fillPrice = hit.price
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
  // 三账本一次写：账户（钱）、委托/成交（流水）、净值点必须在同一把文件锁内提交
  // 取价失败 ⇒ 不写净值点（否则整仓按成本计，会打出假的日跌幅/假熔断）
  // 自动做T：两腿都成交 ⇒ 结算；到截止时间未完成 ⇒ 撤单并标记 aborted
  try {
    const file = await store.autoT()
    let changed = false
    for (const plan of file.plans) {
      if (plan.status === 'done' || plan.status === 'aborted') continue
      const pair = orders.filter((o) => o.pairId === plan.pairId)
      if (pair.length < 2) continue
      const buy = pair.find((o) => o.side === 'buy')
      const sell = pair.find((o) => o.side === 'sell')
      if (buy === undefined || sell === undefined) continue
      if (buy.status === 'filled' && sell.status === 'filled') {
        const sumOf = (id: string, key: 'amount' | 'fee'): number => fills.filter((f) => f.orderId === id).reduce((a, f) => a + f[key], 0)
        const net = Math.round((sumOf(sell.id, 'amount') - sumOf(buy.id, 'amount') - sumOf(buy.id, 'fee') - sumOf(sell.id, 'fee')) * 100) / 100
        const rec: AutoTResultRec = {
          id: `${plan.id}-r`, planId: plan.id, secid: plan.secid, day,
          buyPrice: buy.fillPrice ?? plan.buyPrice ?? 0, sellPrice: sell.fillPrice ?? plan.sellPrice ?? 0,
          shares: plan.shares, fees: Math.round((sumOf(buy.id, 'fee') + sumOf(sell.id, 'fee')) * 100) / 100, net, at: now,
        }
        file.results.push(rec)
        plan.status = 'done'
        changed = true
        continue
      }
      const deadline = Math.max(...pair.map((o) => o.expireAt ?? 0))
      if (deadline > 0 && now >= deadline) {
        const filledLeg = pair.find((o) => o.status === 'filled' || (o.filledShares ?? 0) > 0)
        for (const o of pair) if (o.status === 'pending') { o.status = 'cancelled'; o.cancelledAt = now; o.cancelReason = '自动做T截止' }
        if (filledLeg !== undefined) {
          // 已成交一腿：按现价强制平掉，保证收盘净持仓不变（失败也会体现在净收益里）
          const q = await deps.quotes([plan.secid]).catch(() => ({}))
          const px = q[plan.secid]?.price
          if (typeof px === 'number' && Number.isFinite(px) && px > 0) {
            const side: 'buy' | 'sell' = filledLeg.side === 'buy' ? 'sell' : 'buy'
            const fee = feesOf(side, px, plan.shares, 0, 0, /ETF/i.test(plan.name)).total
            const fill = { orderId: `${plan.id}-forced`, secid: plan.secid, name: plan.name, side, price: px, shares: plan.shares, amount: Math.round(px * plan.shares * 100) / 100, fee, at: now, source: '1min' as const }
            account = applyFill(account, { ...filledLeg, id: `${plan.id}-forced`, side, price: px, shares: plan.shares, status: 'pending', day }, fill)
            fills.push(fill)
          }
        }
        plan.status = 'aborted'
        changed = true
      }
    }
    if (changed) await store.saveAutoT(file)
  } catch { /* 自动做T 账本异常不影响主账 */ }

  let quoteMap: Record<string, { price?: number | null }> | null = null
  try { quoteMap = await deps.quotes(account.positions.map((p) => p.secid)) } catch { quoteMap = null }
  const equity = quoteMap === null
    ? store.equity()
    : upsertEquity(store.equity(), equityPointOf(account, (secid) => quoteMap![secid]?.price ?? null, now))
  await store.saveAll({ account, orders, fills, equity })
  return { filled, rejected, skipped, rejects: skipped }
}
