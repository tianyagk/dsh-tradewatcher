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

/**
 * 个股研判（v0.211.0）：`holdings[].thesis`。
 *
 * 口径（唯一事实源，不做语义推断）：
 * - `order`：该 secid **最新一笔委托**的 `reason`（`decidedAt` 倒序）；
 * - `run-note`：最新一轮 `runs[].decision.note` **明确提到该股**（名称或 6 位代码）时的**首句**；
 * - 都没有 ⇒ `null`。**不得**拿别的股票的理由、也不得拿宏观研报原文顶替。
 *
 * `at` 是 epoch ms：`orders[].decidedAt` 原样；`run.at` 是 ISO 字符串 ⇒ 解析后给出
 * （解析不了回退 `startedAt`，再不行 ⇒ null）。
 */
export interface PrismThesis {
  /** 研判原文（不截断；UI 的 title 用它显示全文） */
  text: string
  /** 研判时刻（epoch ms）；无源 ⇒ null */
  at: number | null
  /** 来源：委托理由 / 本轮组合研判；无源 ⇒ null */
  kind: 'order' | 'run-note' | null
}

/** 从东方财富 secid（`1.601398`）取 6 位代码；取不到 ⇒ ''（港股 5 位等不硬凑） */
function codeOfSecid(secid: string): string {
  return /(?:^|\.)(\d{6})$/.exec(secid)?.[1] ?? ''
}

/** 同一只标的：secid 完全相同，或 6 位代码相同（兼容 `601398` 与 `1.601398` 两种写法） */
function sameStock(a: string, b: string): boolean {
  if (a === b) return true
  const ca = codeOfSecid(a)
  const cb = codeOfSecid(b)
  return ca !== '' && ca === cb
}

/** note 是否明确提到该股：名称子串，或 6 位代码（前后不能紧邻数字，避免命中金额） */
function mentionsStock(note: string, name: string, secid: string): boolean {
  const n = name.trim()
  if (n !== '' && note.includes(n)) return true
  const code = codeOfSecid(secid)
  if (code === '') return false
  return new RegExp(`(^|\\D)${code}(?!\\d)`).test(note)
}

/** 首句：第一条非空行里，到第一个 `。！？!?` 为止（含标点）；没有标点 ⇒ 整行 */
function firstSentenceOfNote(text: string): string {
  const line = text.split(/\r?\n/).map((s) => s.trim()).find((s) => s !== '') ?? text.trim()
  return (line.match(/^[^。！？!?]*[。！？!?]/)?.[0] ?? line).trim()
}

/** run 时刻：`at`（ISO，含 +08:00）优先；解析失败 ⇒ `startedAt`；都没有 ⇒ null */
function runTimeOf(run: PrismRun): number | null {
  const raw = (run as unknown as { at?: unknown }).at
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw
  if (typeof raw === 'string' && raw !== '') {
    const parsed = Date.parse(raw)
    if (Number.isFinite(parsed)) return parsed
  }
  return num(run.startedAt)
}

/** 该股最新一笔委托理由（跳过 reason 为空的笔；没有 ⇒ null） */
function latestOrderThesisOf(secid: string, orders: readonly PrismOrder[]): { text: string; at: number | null } | null {
  const own = orders
    .map((o, i) => ({ o, i, at: num(o.decidedAt), reason: typeof o.reason === 'string' ? o.reason.trim() : '' }))
    .filter((x) => sameStock(x.o.secid, secid) && x.reason !== '')
  if (own.length === 0) return null
  own.sort((a, b) => (b.at ?? Number.NEGATIVE_INFINITY) - (a.at ?? Number.NEGATIVE_INFINITY) || b.i - a.i)
  const best = own[0]!
  return { text: best.reason, at: best.at }
}

/** 最新一轮**提到该股**的组合研判首句（run 时间倒序；都没有 ⇒ null） */
function latestRunNoteThesisOf(name: string, secid: string, runs: readonly PrismRun[]): { text: string; at: number | null } | null {
  const list = runs
    .map((r, i) => ({ r, i, at: runTimeOf(r) }))
    .sort((a, b) => (b.at ?? Number.NEGATIVE_INFINITY) - (a.at ?? Number.NEGATIVE_INFINITY) || b.i - a.i)
  for (const { r, at } of list) {
    const note = typeof r.decision?.note === 'string' ? r.decision.note.trim() : ''
    if (note === '' || !mentionsStock(note, name, secid)) continue
    return { text: firstSentenceOfNote(note), at }
  }
  return null
}

/**
 * 个股研判：最新委托理由 > 最新一条提到该股的组合研判首句 > null。
 * 反例约束：别的股票的 reason 不会出现在结果里（按 secid 过滤），宏观研报也不参与（只读 decision.note）。
 */
export function thesisOf(
  secid: string,
  name: string,
  orders: readonly PrismOrder[],
  runs: readonly PrismRun[],
): PrismThesis | null {
  const order = latestOrderThesisOf(secid, orders)
  if (order !== null) return { text: order.text, at: order.at, kind: 'order' }
  const note = latestRunNoteThesisOf(name, secid, runs)
  if (note !== null) return { text: note.text, at: note.at, kind: 'run-note' }
  return null
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
    // 成本口径：p.cost 是每股摊薄成本；p.netCost 是总成本（历史字段）。两者不可混用——
    // 之前优先取 netCost 当"每股成本"，导致 pnl 被放大 qty 倍（实测 -4.7 亿）。这里统一取每股成本。
    const netCost = num(p.netCost)
    const perShare = num(p.cost) ?? (netCost !== null && p.qty > 0 ? netCost / p.qty : null)
    const cost = perShare ?? 0
    const pnl = price === null || perShare === null ? null : (price - perShare) * p.qty
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

/* ────────────────────────── 持仓分析（v0.212.0） ────────────────────────── */

/** 该股无研判：与客户端 `THESIS_NONE` 同一句话（宿主给结论，页面不再二次判空） */
export const HOLD_THESIS_NONE = '—（该股暂无研判）'
/** 约束未保存：**不得**用设计稿默认值（15 / 8）顶替 */
export const HOLD_CONSTRAINT_NONE = '—（约束未设置，无法判定）'

/**
 * 一条「持仓分析」（HOLD）：每个持仓标的各一条，进决策流的 `持仓` 视图。
 *
 * 口径（全部由回包现算，不编造判断）：
 * - 观察：`权重 x.x%（单票上限 y%）` / `浮盈 ±x.xx%` / `当日 ±x.xx%`（有 `prevClose` 才算）/
 *   `持仓市值 xx.x万`；缺哪项 ⇒ `—` + 括号原因（不写 0）；
 * - 推理：只与**已保存约束**比较（权重 > `perStockPct` ⇒ 超单票上限；浮亏 ≤ −`stopLossPct` ⇒ 触及止损线；
 *   否则未触及上限/止损线）；约束未保存 ⇒ `—（约束未设置，无法判定）`；
 * - 结论：只认该股 `thesis.text`；没有 ⇒ `—（该股暂无研判）`；
 * - 时刻：`thesis.at` 优先，否则最近一轮 run 的 `at`；都没有 ⇒ `null`（界面 `—`）。
 *
 * 纯只读：不产生委托、不写 `runs`、不参与手动「重放今日」。
 */
export interface PrismHoldingAnalysis {
  secid: string
  name: string
  /** 分析时刻（epoch ms）；无源 ⇒ null */
  at: number | null
  /** 观察（事实，可逐项复算） */
  observation: string
  /** 推理（规则判定 + 依据） */
  reasoning: string
  /** 结论（该股研判原文，或 `—（该股暂无研判）`） */
  conclusion: string
  /** 观察四项原始数值（缺失 ⇒ null，不写 0） */
  weight: number | null
  perStockPct: number | null
  pnlPct: number | null
  dayPct: number | null
  marketValue: number | null
  /** 推理判定结果：超上限 / 触及止损 / 未触及 / 约束未设置 / 数据不足 ⇒ null */
  verdict: 'over' | 'stop' | 'ok' | 'no-constraint' | null
  /** 结论是否来自真实研判（false ⇒ `HOLD_THESIS_NONE`） */
  hasThesis: boolean
}

/** 带符号百分比：+0.81% / -1.20%；小于半个末位 ⇒ 0.00%（不输出 `-0.00%`） */
function signedPctOf(v: number | null, digits: number): string | null {
  if (v === null) return null
  const eps = 0.5 * Math.pow(10, -digits)
  const n = Math.abs(v) < eps ? 0 : v
  return `${n > 0 ? '+' : ''}${n.toFixed(digits)}%`
}

/** 持仓分析：每个持仓一条（顺序同 `account.positions`） */
export function holdingAnalysesOf(
  account: Pick<PrismAccount, 'positions'>,
  prices: Record<string, number | null>,
  overview: { totalAssets: number | null },
  constraints: { perStockPct?: number | null; stopLossPct?: number | null } | null | undefined,
  holdings: ReadonlyArray<{ secid: string; prevClose?: number | null; thesis?: PrismThesis | null }>,
  runs: readonly PrismRun[] = [],
): PrismHoldingAnalysis[] {
  const perStockPct = num(constraints?.perStockPct)
  const stopLossPct = num(constraints?.stopLossPct)
  const totalAssets = num(overview.totalAssets)
  // 兜底时刻：最近一轮 run 的 at（解析不了 ⇒ startedAt；全都没有 ⇒ null）
  let latestRunAt: number | null = null
  for (const r of runs) {
    const at = runTimeOf(r)
    if (at !== null && (latestRunAt === null || at > latestRunAt)) latestRunAt = at
  }
  const prevOf = (secid: string): number | null => {
    for (const h of holdings) if (sameStock(h.secid, secid)) return num(h.prevClose)
    return null
  }
  const thesisOfSecid = (secid: string): PrismThesis | null => {
    for (const h of holdings) if (sameStock(h.secid, secid)) return h.thesis ?? null
    return null
  }
  return account.positions.map((p) => {
    const price = num(prices[p.secid])
    const marketValue = price === null ? null : p.qty * price
    const weight = marketValue === null || totalAssets === null || totalAssets <= 0 ? null : marketValue / totalAssets
    const perShare = num(p.cost) ?? (num(p.netCost) !== null && p.qty > 0 ? (num(p.netCost) as number) / p.qty : null)
    const pnlPct = price === null || perShare === null || perShare <= 0 ? null : (price / perShare - 1) * 100
    const prevClose = prevOf(p.secid)
    const dayPct = price === null || prevClose === null || prevClose <= 0 ? null : (price / prevClose - 1) * 100
    const weightPct = weight === null ? null : weight * 100

    const limitText = perStockPct === null ? '—' : `${perStockPct}%`
    const observation = [
      weightPct === null ? '权重 —（缺总资产或现价）' : `权重 ${weightPct.toFixed(1)}%（单票上限 ${limitText}）`,
      pnlPct === null ? '浮盈 —（缺成本价或现价）' : `浮盈 ${signedPctOf(pnlPct, 2)}`,
      dayPct === null ? '当日 —（缺昨收）' : `当日 ${signedPctOf(dayPct, 2)}`,
      marketValue === null ? '持仓市值 —（缺现价）' : `持仓市值 ${(marketValue / 1e4).toFixed(1)}万`,
    ].join(' · ')

    const over = weightPct !== null && perStockPct !== null && weightPct > perStockPct + 1e-9
    const stop = pnlPct !== null && stopLossPct !== null && pnlPct <= -stopLossPct + 1e-9
    let reasoning: string
    let verdict: PrismHoldingAnalysis['verdict']
    if (perStockPct === null || stopLossPct === null) {
      reasoning = HOLD_CONSTRAINT_NONE
      verdict = 'no-constraint'
    } else if (over) {
      reasoning = `超单票上限（权重 ${(weightPct as number).toFixed(1)}% > 单票上限 ${perStockPct}%）`
      verdict = 'over'
    } else if (stop) {
      reasoning = `触及止损线（浮亏 ${signedPctOf(pnlPct, 2)} ≤ −${stopLossPct}%）`
      verdict = 'stop'
    } else if (weightPct === null && pnlPct === null) {
      reasoning = '—（缺权重与浮盈，无法判定）'
      verdict = null
    } else if (weightPct === null) {
      reasoning = `未触及止损线（浮亏 ${signedPctOf(pnlPct, 2)} > −${stopLossPct}%）；权重缺失，单票上限不可判定`
      verdict = 'ok'
    } else if (pnlPct === null) {
      reasoning = `未触及单票上限（权重 ${weightPct.toFixed(1)}% ≤ ${perStockPct}%）；浮盈缺失，止损线不可判定`
      verdict = 'ok'
    } else {
      reasoning = `未触及上限/止损线（权重 ${weightPct.toFixed(1)}% ≤ ${perStockPct}%，浮亏 ${signedPctOf(pnlPct, 2)} > −${stopLossPct}%）`
      verdict = 'ok'
    }

    const thesis = thesisOfSecid(p.secid)
    const text = typeof thesis?.text === 'string' ? thesis.text.trim() : ''
    return {
      secid: p.secid,
      name: p.name,
      at: num(thesis?.at) ?? latestRunAt,
      observation,
      reasoning,
      conclusion: text === '' ? HOLD_THESIS_NONE : text,
      weight,
      perStockPct,
      pnlPct,
      dayPct,
      marketValue,
      verdict,
      hasThesis: text !== '',
    }
  })
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
  /** 已保存约束（只读；缺字段 ⇒ null，绝不用设计稿默认值） */
  constraints?: { perStockPct?: number | null; stopLossPct?: number | null } | null
}): {
  limits: ReturnType<typeof prismLimitUsageOf>
  positions: ReturnType<typeof prismPositionViewOf>
  holdings: Array<{ secid: string; thesis: PrismThesis | null } & ReturnType<typeof prismHoldingDetailOf>>
  /** v0.212.0：每个持仓一条 HOLD（只读派生，不写 runs） */
  holdingAnalyses: PrismHoldingAnalysis[]
  decisionFlow: PrismFlowItem[]
  overview: ReturnType<typeof prismAccountOverviewOf>
  performance: ReturnType<typeof prismPerformanceOf>
  missing: PrismMissing[]
} {
  const limits = prismLimitUsageOf(input.account, input.prices)
  const positions = prismPositionViewOf(input.account, input.prices)
  const holdings = input.account.positions.map((p) => ({
    secid: p.secid,
    ...prismHoldingDetailOf(p, input.quotes[p.secid] ?? null),
    thesis: thesisOf(p.secid, p.name, input.orders, input.runs),
  }))
  const overview = prismAccountOverviewOf(input.account, input.prices)
  const holdingAnalyses = holdingAnalysesOf(input.account, input.prices, overview, input.constraints ?? null, holdings, input.runs)
  const performance = prismPerformanceOf(input.equity, input.evaluation, input.runs)
  const seen = new Set<string>()
  const missing: PrismMissing[] = []
  for (const m of [...limits.missing, ...positions.missing, ...holdings.flatMap((h) => h.missing), ...overview.missing, ...performance.missing]) {
    const key = `${m.what}|${m.note}`
    if (seen.has(key)) continue
    seen.add(key)
    missing.push(m)
  }
  return { limits, positions, holdings, holdingAnalyses, decisionFlow: prismDecisionFlowOf({ runs: input.runs }, input.orders, input.fills, input.runs), overview, performance, missing }
}
