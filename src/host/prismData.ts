/**
 * 棱镜 AGENT DESK 数据契约（v0.202.0）：给 `/tradewatcher/prism` 回包**追加**的只读视图字段。
 *
 * 设计约束（见 `docs/SPEC-PRISM-DATA.md`）：
 * - 只做加法：不删不改任何旧字段；
 * - 缺数据 ⇒ `null` + `missing[]` 原因，**不得 0 顶替**（R1）；
 * - 纯只读：本模块不产生任何委托/下单路径（R12）。
 */
import type { PrismAccount, PrismDecision, PrismEquityPoint, PrismEvaluation, PrismFill, PrismOrder, PrismRun } from '../shared/prism.ts'

export interface PrismMissing { what: string; why: 'no-source' | 'transient'; note: string }

const num = (v: number | null | undefined): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)

/** 1) 资产上限：上限值 / 已用（持仓市值） / 可用 / 超限状态 */
export function prismLimitUsageOf(
  account: Pick<PrismAccount, 'capital' | 'capitalLimit' | 'positions'>,
  prices: Record<string, number | null>,
): { limit: number | null; used: number | null; available: number | null; limitState: 'exceeded' | 'ok' | null; missing: PrismMissing[] } {
  const missing: PrismMissing[] = []
  const limit = num(account.capital) ?? num(account.capitalLimit)
  if (limit === null) missing.push({ what: '资产上限', why: 'no-source', note: '账户未记录资金上限' })
  let used = 0
  let priced = 0
  for (const p of account.positions) {
    const price = num(prices[p.secid])
    if (price === null) continue
    used += p.qty * price
    priced += 1
  }
  if (account.positions.length > 0 && priced === 0) {
    missing.push({ what: '已用资金', why: 'no-source', note: '全部持仓缺现价，无法计算市值' })
  }
  const usedValue = account.positions.length === 0 ? 0 : priced > 0 ? used : null
  const available = limit === null || usedValue === null ? null : limit - usedValue
  return {
    limit, used: usedValue, available,
    limitState: limit === null || usedValue === null ? null : usedValue > limit ? 'exceeded' : 'ok',
    missing,
  }
}

export interface PrismPositionView {
  secid: string; name: string; qty: number; available: number; cost: number
  price: number | null; marketValue: number | null; pnl: number | null; weight: number | null
}

/** 2) 持仓明细：marketValue / pnl / weight（分母 = 总资产） */
export function prismPositionViewOf(
  account: Pick<PrismAccount, 'positions' | 'cash'>,
  prices: Record<string, number | null>,
): { rows: PrismPositionView[]; totalAssets: number | null; missing: PrismMissing[] } {
  const missing: PrismMissing[] = []
  const rows: PrismPositionView[] = account.positions.map((p) => {
    const price = num(prices[p.secid])
    const marketValue = price === null ? null : p.qty * price
    const cost = num(p.netCost) ?? num(p.cost) ?? 0
    const pnl = price === null ? null : (price - cost) * p.qty
    return { secid: p.secid, name: p.name, qty: p.qty, available: p.available, cost, price, marketValue, pnl, weight: null }
  })
  const cash = num(account.cash)
  const mvSum = rows.some((r) => r.marketValue !== null) ? rows.reduce((a, r) => a + (r.marketValue ?? 0), 0) : null
  const totalAssets = cash === null || mvSum === null ? null : cash + mvSum
  for (const r of rows) r.weight = totalAssets === null || totalAssets <= 0 || r.marketValue === null ? null : r.marketValue / totalAssets
  if (rows.some((r) => r.marketValue === null)) missing.push({ what: '持仓市值', why: 'no-source', note: '部分持仓缺现价，市值/占比按 null 处理' })
  return { rows, totalAssets, missing }
}

/** 3) 个股详情：prevClose（腾讯 f[4]）/ dayPnl */
export function prismHoldingDetailOf(
  position: { secid: string; qty: number },
  quote: { price: number | null; prev: number | null } | null,
): { prevClose: number | null; dayPnl: number | null; missing: PrismMissing[] } {
  const missing: PrismMissing[] = []
  const prevClose = num(quote?.prev)
  const price = num(quote?.price)
  if (prevClose === null) missing.push({ what: '昨收', why: 'no-source', note: '腾讯快照未取到昨收（f[4] 缺失或行情失败）' })
  if (price === null) missing.push({ what: '现价', why: 'no-source', note: '行情未取到' })
  return { prevClose, dayPnl: price === null || prevClose === null ? null : position.qty * (price - prevClose), missing }
}

/** 4) 决策流：把 orders / fills / rejects / runs 归一成一条时间轴（只读） */
export type PrismFlowAction = 'buy' | 'sell' | 'hold' | 'reject' | 'cancel'
export interface PrismFlowItem {
  at: number; action: PrismFlowAction; reason: string | null
  targetPrice: number | null; status: string; origin: 'auto' | 'manual' | 'unknown'
  secid?: string; name?: string; qty?: number | null
}

export function prismDecisionFlowOf(
  state: { runs?: readonly PrismRun[] },
  orders: readonly PrismOrder[],
  fills: readonly PrismFill[],
  runs?: readonly PrismRun[],
): PrismFlowItem[] {
  const list: PrismFlowItem[] = []
  const runList = runs ?? state.runs ?? []
  const fillByOrder = new Map<string, PrismFill[]>()
  for (const f of fills) {
    const arr = fillByOrder.get(f.orderId) ?? []
    arr.push(f)
    fillByOrder.set(f.orderId, arr)
  }
  for (const o of orders) {
    const filled = fillByOrder.get(o.id) ?? []
    const lastFill = filled.at(-1)
    const origin = o.origin === 'auto' || o.origin === 'manual' ? o.origin : 'unknown'
    list.push({
      at: lastFill?.at ?? o.filledAt ?? o.decidedAt,
      action: o.side,
      reason: o.reason || o.skipReason || o.rejectReason || null,
      targetPrice: num(lastFill?.price) ?? num(o.fillPrice) ?? num(o.price),
      status: o.status,
      origin, secid: o.secid, name: o.name, qty: o.shares ?? null,
    })
    if (o.status === 'cancelled') {
      list.push({ at: o.cancelledAt ?? o.decidedAt, action: 'cancel', reason: o.cancelReason ?? null, targetPrice: null, status: 'cancelled', origin, secid: o.secid, name: o.name })
    }
    if (o.status === 'rejected') {
      list.push({ at: o.decidedAt, action: 'reject', reason: o.rejectReason ?? null, targetPrice: num(o.price), status: 'rejected', origin, secid: o.secid, name: o.name })
    }
  }
  for (const r of runList) {
    const d: PrismDecision | null | undefined = r.decision
    for (const rej of d?.rejects ?? []) {
      list.push({ at: r.startedAt, action: 'reject', reason: rej.reason ?? null, targetPrice: num(rej.price), status: 'rejected', origin: 'auto', secid: rej.secid, qty: rej.shares ?? null })
    }
    if ((d?.orders?.length ?? 0) === 0 && (d?.rejects?.length ?? 0) === 0 && d !== null && d !== undefined) {
      list.push({ at: r.startedAt, action: 'hold', reason: d.note ?? null, targetPrice: null, status: 'hold', origin: 'auto' })
    }
  }
  return list.sort((a, b) => a.at - b.at)
}

/** 5) 账户总览：总资产 / 现金 / 仓位占比 / 可用资金 */
export function prismAccountOverviewOf(
  account: Pick<PrismAccount, 'cash' | 'positions' | 'capital' | 'capitalLimit'>,
  prices: Record<string, number | null>,
): { totalAssets: number | null; cash: number | null; positionPct: number | null; available: number | null; missing: PrismMissing[] } {
  const missing: PrismMissing[] = []
  const view = prismPositionViewOf(account, prices)
  missing.push(...view.missing)
  const limit = prismLimitUsageOf(account, prices)
  missing.push(...limit.missing)
  const cash = num(account.cash)
  const totalAssets = view.totalAssets
  const positionPct = totalAssets === null || totalAssets <= 0 ? null : (totalAssets - (cash ?? 0)) / totalAssets
  return { totalAssets, cash, positionPct, available: limit.available, missing }
}

/** 6) Agent 绩效：超额收益（对基准）/ 最大回撤；token 用量无源 ⇒ 恒 null */
export function prismPerformanceOf(
  equity: readonly PrismEquityPoint[],
  evaluation: PrismEvaluation | null,
  runs: readonly PrismRun[],
): { returnPct: number | null; benchmarkPct: number | null; excessPct: number | null; maxDrawdown: number | null; hitRate: number | null; runsCount: number; latencyMs: number | null; tokenUsage: null; missing: PrismMissing[] } {
  const missing: PrismMissing[] = []
  const first = equity[0]
  const last = equity.at(-1)
  const returnPct = first !== undefined && last !== undefined && first.equity > 0 ? (last.equity / first.equity - 1) * 100 : null
  const b0 = num(first?.benchmarkClose)
  const b1 = num(last?.benchmarkClose)
  const benchmarkPct = b0 === null || b1 === null || b0 <= 0 ? null : (b1 / b0 - 1) * 100
  if (benchmarkPct === null) missing.push({ what: '基准收益', why: 'no-source', note: '净值点缺沪深300收盘（benchmarkClose）' })
  const excessPct = returnPct === null || benchmarkPct === null ? null : returnPct - benchmarkPct
  const maxDrawdown = num(evaluation?.drawdown?.value)
  const hitRate = num(evaluation?.hitRate?.value)
  const withEnd = runs.filter((r) => typeof r.finishedAt === 'number')
  const latencyMs = withEnd.length === 0 ? null : withEnd.reduce((a, r) => a + ((r.finishedAt as number) - r.startedAt), 0) / withEnd.length
  missing.push({ what: 'token 用量', why: 'no-source', note: 'token 用量无源' })
  return { returnPct, benchmarkPct, excessPct, maxDrawdown, hitRate, runsCount: runs.length, latencyMs, tokenUsage: null, missing }
}

/** 汇总：一次算出六区块的新增字段（`missing` 去重后返回） */
export function prismDeskOf(input: {
  account: PrismAccount
  prices: Record<string, number | null>
  quotes: Record<string, { price: number | null; prev: number | null }>
  orders: readonly PrismOrder[]
  fills: readonly PrismFill[]
  runs: readonly PrismRun[]
  equity: readonly PrismEquityPoint[]
  evaluation: PrismEvaluation | null
}): {
  limits: ReturnType<typeof prismLimitUsageOf>
  positions: ReturnType<typeof prismPositionViewOf>
  holdings: Array<{ secid: string } & ReturnType<typeof prismHoldingDetailOf>>
  decisionFlow: PrismFlowItem[]
  overview: ReturnType<typeof prismAccountOverviewOf>
  performance: ReturnType<typeof prismPerformanceOf>
  missing: PrismMissing[]
} {
  const limits = prismLimitUsageOf(input.account, input.prices)
  const positions = prismPositionViewOf(input.account, input.prices)
  const holdings = input.account.positions.map((p) => ({ secid: p.secid, ...prismHoldingDetailOf(p, input.quotes[p.secid] ?? null) }))
  const overview = prismAccountOverviewOf(input.account, input.prices)
  const performance = prismPerformanceOf(input.equity, input.evaluation, input.runs)
  const seen = new Set<string>()
  const missing: PrismMissing[] = []
  for (const m of [...limits.missing, ...positions.missing, ...holdings.flatMap((h) => h.missing), ...overview.missing, ...performance.missing]) {
    const key = `${m.what}|${m.note}`
    if (seen.has(key)) continue
    seen.add(key)
    missing.push(m)
  }
  return { limits, positions, holdings, decisionFlow: prismDecisionFlowOf({ runs: input.runs }, input.orders, input.fills, input.runs), overview, performance, missing }
}
