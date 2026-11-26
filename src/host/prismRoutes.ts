/**
 * 棱镜（第 9 行）的路由：**只有一条** `/tradewatcher/prism`。
 *
 * GET  → 首屏状态（设置/骨架/新闻/最近运行/默认模型）
 * POST → `{action}`：
 *   · `settings` `{times?, intervalSec?}` 保存手动重放时点（≤50）与自动决策周期（秒）
 *   · `skeleton` `{text}`  保存骨架（≤20 000 字）
 *   · `news`               立即同步金十（首次回填 24h / 之后增量）
 *   · `run` `{slot}`        手动补跑指定时点（只跑这一轮）
 *
 * 五类操作复用同一条路径 ⇒ 路由账只 +1（用户裁决：30 → 31）。
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { PluginWebRoute } from './context.ts'
import type { AutoTFile, AutoTPlanRec, AutoTResultRec, PrismStore } from './prismStore.ts'
import { LedgerUnreadableError, PrismTradingStore, applyFeeCorrection, avgCostFromHistory, clampDecision, copyAtCost, dayStartMismatchOf, equityPointOf, isEtfName, matchTick, placeDecision, productKeyOf, realizedFromIdentity, rebuildFromOrders, upsertEquity, type QuoteLite } from './prismAccount.ts'
import { dataHome, type DataStore } from './store.ts'
import type { PrismAccount, PrismFill, PrismOrder, PrismRun, PrismSettings, PrismState } from '../shared/prism.ts'
import { PRISM_INTERVAL_OPTIONS, PRISM_MAX_TIMES, PRISM_SKELETON_MAX } from '../shared/prism.ts'
import { applyPriceCorrection } from './prismCorrection.ts'
import { indexTechTextOf } from './indexTech.ts'
import { candidatesTextOf, type CandidateInput } from './candidateStats.ts'
import { isValidSecid, readPrismLedger } from './prismDeskWrite.ts'
import { backfillNews, incrementalNews } from './prismNews.ts'
import { runPrismAnalysis, type PrismInputs } from './prismPipeline.ts'
import { fetchIndustryOverview, fetchKline, fetchQuotes, fetchValuationBatch } from './em.ts'
import { assemblePortfolio } from './portfolio.ts'
import { industryExposureOf, needsIndustryOf, unavailableExposure } from './prismExposure.ts'
import { applyDrawdownGate, drawdownGateOf, evaluationOf, EVAL_MIN_SAMPLE } from './prismEval.ts'
import { prismDeskOf } from './prismData.ts'
import { appendPrismLedger, applyPositionOp, validateConstraints } from './prismDeskWrite.ts'
import { dayOf, hhmmOf } from './time.ts'

export interface PrismRouteDeps {
  store: PrismStore
  trading: PrismTradingStore
  data: DataStore
  get: (name: string) => unknown
  /** 测试注入；缺省走既有 `fetchQuotes`（不新增源） */
  quotes?: typeof fetchQuotes
  /** 测试注入时钟（run 触发/下单边界用） */
  now?: () => number
  /** 测试注入行业归属取数；缺省走既有 `fetchIndustryOverview`（不新增源） */
  industry?: typeof fetchIndustryOverview
  /** 测试注入基准 K 线（净值点的 benchmarkClose）；缺省走既有 `fetchKline`（不新增源） */
  kline?: typeof fetchKline
}

const send = (res: ServerResponse, status: number, body: unknown): void => {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(JSON.stringify(body))
}

const readBody = async (req: IncomingMessage): Promise<unknown> => {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string)
    size += buf.length
    if (size > 1_000_000) throw new Error('body too large')
    chunks.push(buf)
  }
  const text = Buffer.concat(chunks).toString('utf8').trim()
  if (text === '') return null
  return JSON.parse(text) as unknown
}

/** 账户快照：七项数字/单位必须同时出现（提示词用，缺项写 — 与原因） */
export function accountSnapshotOf(
  account: PrismAccount,
  prices: Readonly<Record<string, number | null>>,
  fills: readonly PrismFill[],
  pendingCount: number,
  now: number = Date.now(),
): string {
  const value = account.positions.reduce((sum, p) => sum + p.qty * (prices[p.secid] ?? p.cost), 0)
  const total = account.cash + value
  const weight = total > 0 ? (value / total) * 100 : null
  const today = dayOf(now)
  const filledToday = fills.filter((f) => dayOf(f.at) === today).length
  return [
    `总资产：${total.toFixed(2)} 元`,
    `现金：${account.cash.toFixed(2)} 元`,
    `持仓市值：${value.toFixed(2)} 元`,
    `当前仓位占比：${weight === null ? '—（总资产为 0）' : `${weight.toFixed(2)}%`}`,
    `可买额度：${account.cash.toFixed(2)} 元`,
    `当日已成交笔数：${filledToday} 笔`,
    `未成交挂单：${pendingCount} 笔`,
    '棱镜持仓明细（模拟盘，权重 = 市值 ÷ 总资产）：',
    ...(account.positions.length === 0
      ? ['—（空仓）']
      : account.positions.map((p) => {
        const mv = p.qty * (prices[p.secid] ?? p.cost)
        const w = total > 0 ? (mv / total) * 100 : null
        const px = prices[p.secid]
        const avg = typeof (p as { avgCost?: number }).avgCost === 'number' ? (p as { avgCost?: number }).avgCost as number : null
        const costText = avg === null
          ? `摊薄成本 ${p.cost.toFixed(3)}（无买入均价，止损暂按此值）`
          : `成本（止损口径=买入均价） ${avg.toFixed(3)}；摊薄成本 ${p.cost.toFixed(3)}（仅展示，不用于止损）`
        return `- ${p.name}（${p.secid}）：${p.qty} 股（可卖 ${p.available} 股），${costText}，现价 ${px === null || px === undefined ? '—（未取到）' : px.toFixed(3)}，市值 ${mv.toFixed(2)}，权重 ${w === null ? '—' : `${w.toFixed(2)}%`}`
      })),
  ].join('\n')
}

export interface IndustryData {
  map: Record<string, { name: string; pct: number | null }>
  reason?: string
}

/** 行业归属缓存 TTL：10 分钟（与上游 `industry-name` 的 600 s 同名口径） */
const INDUSTRY_TTL_MS = 10 * 60_000
/**
 * 取失败（`reason` 非空）只缓存 60 s：上游恢复后能尽快自愈，又不会因为每 30 s 一次 GET
 * 把 N+1 行业请求打成"持续连发"。
 */
const INDUSTRY_FAIL_TTL_MS = 60_000

/**
 * 按「持仓 secid 集合」缓存行业归属（P2-7）：同一集合在 TTL 内直接用上次结果。
 *
 * 用 `WeakMap` 挂在 `deps` 上（每个路由实例一份）—— 不放模块级：那样测试与
 * 多个插件实例会互相污染。集合变了（加/减仓）⇒ 键变了 ⇒ 必重新取。
 */
const industryCacheOf = new WeakMap<PrismRouteDeps, { key: string; exp: number; value: IndustryData }>()

const industryKeyOf = (secids: readonly string[]): string => [...new Set(secids)].sort().join(',')

const fetchIndustryData = async (deps: PrismRouteDeps, secids: string[]): Promise<IndustryData> => {
  try {
    const map = await (deps.industry ?? fetchIndustryOverview)(secids)
    if (needsIndustryOf(secids.map((secid) => ({ secid }))) && Object.keys(map).length === 0) {
      return { map, reason: '行业归属接口未返回 f127（东财可能限流/熔断；本次记未穿透）' }
    }
    return { map }
  } catch (error) {
    return { map: {}, reason: `行业归属 f127 取数失败（东财限流/熔断或网络不可达）：${String(error).slice(0, 80)}` }
  }
}

const industryDataOf = async (deps: PrismRouteDeps, secids: string[]): Promise<IndustryData> => {
  const key = industryKeyOf(secids)
  const hit = industryCacheOf.get(deps)
  const now = Date.now()
  if (hit !== undefined && hit.key === key && now < hit.exp) return hit.value
  const value = await fetchIndustryData(deps, secids)
  const ttl = value.reason === undefined ? INDUSTRY_TTL_MS : INDUSTRY_FAIL_TTL_MS
  industryCacheOf.set(deps, { key, exp: now + ttl, value })
  return value
}

/** 一条「今日已被风控拒绝」的委托（提示词与去重闸共用） */
export interface RejectedTodayOrder {
  id: string
  secid: string
  name: string
  side: 'buy' | 'sell'
  price: number
  shares: number
  decidedAt: number
  reason: string
}

/**
 * 被拒原因：`skipReason` → `rejectReason` → 当日各轮 `decision.rejects` 对应条目的 `reason` → `—`。
 * 不猜：三级都缺就写 `—`（提示词里不得编原因）。
 */
export function rejectedReasonOf(order: PrismOrder, runs: readonly PrismRun[] = []): string {
  const skip = order.skipReason?.trim() ?? ''
  if (skip !== '') return skip
  const direct = order.rejectReason?.trim() ?? ''
  if (direct !== '') return direct
  for (const run of runs) {
    if (run.day !== order.day) continue
    const hit = run.decision?.rejects.find((r) => r.secid === order.secid && r.side === order.side && r.shares === order.shares && r.price === order.price)
    if (hit !== undefined && hit.reason.trim() !== '') return hit.reason
  }
  return '—'
}

/** 今日（`day` = 北京自然日）被风控拒绝的委托：按 `decidedAt` 倒序，最多 `limit` 条（默认 10） */
export function rejectedTodayOf(
  orders: readonly PrismOrder[],
  day: string,
  runs: readonly PrismRun[] = [],
  limit = 10,
): RejectedTodayOrder[] {
  return orders
    .filter((o) => o.status === 'rejected' && o.day === day)
    .sort((a, b) => b.decidedAt - a.decidedAt)
    .slice(0, limit)
    .map((o) => ({
      id: o.id,
      secid: o.secid,
      name: o.name,
      side: o.side,
      price: o.price,
      shares: o.shares,
      decidedAt: o.decidedAt,
      reason: rejectedReasonOf(o, runs),
    }))
}

/** 提示词里的「今日已被风控拒绝的委托」段落正文；无 ⇒ `—（今日无被拒委托）` */
export function rejectedTodayTextOf(items: readonly RejectedTodayOrder[]): string {
  if (items.length === 0) return '—（今日无被拒委托）'
  return items
    .map((o) => `${hhmmOf(o.decidedAt)} ${o.side === 'buy' ? '买入' : '卖出'} ${o.name} ${o.shares.toLocaleString('en-US')} 股 @${o.price} — 原因：${o.reason}`)
    .join('\n')
}

/**
 * 【ETF 按产品合并】段落（v0.214.0，C 层）。
 *
 * 同一跟踪标的、不同基金公司的 ETF（如 `511130 博时` / `511090 鹏扬` 都是 30 年国债 ETF）
 * 对组合而言是**同一条腿**；分成两行会让模型以为「还没配这条腿」而重复建仓。
 * 只列同键 ≥2 只的组；权重 = 合计市值 ÷ 可计价总市值（与组合总览同一分母）。
 * 缺价 ⇒ `—` + 原因，不拿 0 或成本冒充。
 */
export function etfProductsTextOf(
  positions: ReadonlyArray<{ secid: string; name: string; qty: number; mv: number | null }>,
  totalMv: number,
): string {
  const groups = new Map<string, Array<{ secid: string; name: string; qty: number; mv: number | null }>>()
  for (const p of positions) {
    if (!(p.qty > 0) || !isEtfName(p.name)) continue
    const key = productKeyOf(p.name)
    const list = groups.get(key)
    if (list === undefined) groups.set(key, [p])
    else list.push(p)
  }
  const rows: string[] = []
  for (const [key, members] of groups) {
    if (members.length < 2) continue
    const missing = members.filter((m) => typeof m.mv !== 'number')
    const sumMv = members.reduce((sum, m) => sum + (typeof m.mv === 'number' ? m.mv : 0), 0)
    const mvText = missing.length > 0 ? `—（缺价：${missing.map((m) => m.name).join('、')}）` : `${sumMv.toFixed(2)} 元`
    const weightText = missing.length > 0
      ? '—（合计市值不可算）'
      : !(totalMv > 0) ? '—（可计价总市值 0）' : `${((sumMv / totalMv) * 100).toFixed(2)}%`
    rows.push(`${key}：${members.map((m) => `${m.name}（${m.secid}）${m.qty} 股`).join(' + ')} — 合计权重 ${weightText}，合计市值 ${mvText}`)
  }
  return ['【ETF 按产品合并】', '（同键 = 同一跟踪标的、不同基金公司，属同一条腿；加仓请直接加已持有的那只）', ...(rows.length === 0 ? ['—（无同产品多标的持仓）'] : rows)].join('\n')
}

/** 指数技术面缓存：5 分钟（一轮研判 10 分钟一次，避免每轮 5 条日线全量回源） */
let techCache: { at: number; text: string } | null = null
async function indexTechCachedOf(): Promise<string> {
  if (techCache !== null && Date.now() - techCache.at < 5 * 60_000) return techCache.text
  const text = await indexTechTextOf({
    loadBars: async (secid) => (await fetchKline(secid, 101, 120, 0))?.days ?? null,
  })
  techCache = { at: Date.now(), text }
  return text
}

/** 自动做T 回包：计划/成交/结算 → 界面结构（缺数据一律 null，不编 0） */
export function autoTPayloadOf(
  store: { autoT: () => AutoTFile; settings: () => PrismSettings },
  account: PrismAccount,
  today: string,
  degraded = false,
): Record<string, unknown> {
  const file = store.autoT()
  const cfg = store.settings().autoT
  // 没有总开关：只要任意一只持仓开启做T，整体即视为运行（v2 设计：人类只开关仓位）
  const enabled = Object.values(cfg?.positions ?? {}).some((v) => v?.enabled === true)
  const positions: Record<string, { enabled: boolean; hold: boolean }> = {}
  for (const p of account.positions) {
    if (p.qty <= 0) continue
    positions[p.secid] = { enabled: cfg?.positions?.[p.secid]?.enabled === true, hold: true }
  }
  const plans = file.plans.filter((p) => p.day === today)
  const planIds = new Set(plans.map((p) => p.id))
  const trades = file.trades.filter((t) => planIds.has(t.planId))
  const results = file.results.filter((r) => r.day === today)
  const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)
  const sum = (list: Array<{ net?: number | null }>): number | null => {
    if (list.length === 0) return null
    const vals = list.map((x) => num(x.net))
    return vals.every((v): v is number => v !== null) ? vals.reduce((a, b) => a + b, 0) : null
  }
  const statsOf = (list: AutoTResultRec[]): { rounds: number; profit: number | null; winRate: number | null; n: number } => {
    const rounds = list.length
    const profit = sum(list)
    if (rounds === 0) return { rounds: 0, profit: null, winRate: null, n: 0 }
    const wins = list.filter((r) => (num(r.net) ?? 0) > 0).length
    return { rounds, profit, winRate: Math.round((wins / rounds) * 10000) / 100, n: rounds }
  }
  const perPosition: Record<string, ReturnType<typeof statsOf>> = {}
  for (const p of account.positions) {
    perPosition[p.secid] = statsOf(file.results.filter((r) => r.secid === p.secid))
  }
  const effectiveCost: Record<string, number | null> = {}
  for (const p of account.positions) {
    const profit = statsOf(file.results.filter((r) => r.secid === p.secid)).profit
    effectiveCost[p.secid] = p.qty > 0 && profit !== null ? Math.round((p.cost - profit / p.qty) * 1000) / 1000 : p.cost
  }
  return {
    state: degraded ? 'paused' : enabled ? 'running' : 'closed',
    enabled,
    positions,
    today: { rounds: results.length, limit: 2, profit: sum(results), plans, trades },
    stats: statsOf(file.results),
    perPosition,
    effectiveCost,
  }
}

/** 用户配置的硬边界（与骨架冲突时以这里为准；模型必须按这些值填 limits） */
export function limitsTextOf(settings: {
  perStockPct?: number | null; stopLossPct?: number | null; perOrderYuan?: number | null
  maxPosPct?: number | null; maxDDPct?: number | null; minCashPct?: number | null
  industryLimits?: Record<string, number>
}): string {
  const pct = (v: number | null | undefined): string => (typeof v === 'number' ? `${v}%` : '未设置')
  const yuan = (v: number | null | undefined): string => (typeof v === 'number' ? `${v} 元` : '未设置')
  const ind = settings.industryLimits === undefined || Object.keys(settings.industryLimits).length === 0
    ? '未设置'
    : Object.entries(settings.industryLimits).map(([k, v]) => `${k} ${v}%`).join('，')
  return [
    '【约束（用户配置，硬边界）】',
    `单票上限：${pct(settings.perStockPct)}（limits.singlePct 必须填这个值）`,
    `单票止损线：${pct(settings.stopLossPct)}`,
    `单笔金额上限：${yuan(settings.perOrderYuan)}`,
    `最大总仓位：${pct(settings.maxPosPct)}`,
    `日回撤熔断：${pct(settings.maxDDPct)}`,
    `最低现金留存：${pct(settings.minCashPct)}`,
    `单板块上限：${ind}`,
    '（与研判骨架里的旧数值冲突时，一律以本段配置为准）',
  ].join('\n')
}

/** 候选池缓存：10 分钟（持仓+自选 50+ 只日线，逐轮全量回源会拖慢研判） */
let candidatesCache: { key: string; at: number; text: string } | null = null
async function candidatesCachedOf(deps: PrismRouteDeps, watch: ReadonlyArray<{ secid: string; name: string }>): Promise<string> {
  const account = deps.trading.account()
  const prices: Record<string, number | null> = {}
  for (const p of account.positions) prices[p.secid] = null
  const held = account.positions
    .map((p) => ({ secid: p.secid, name: p.name, held: true as const }))
    .sort((a, b) => b.secid.localeCompare(a.secid))
  const heldSet = new Set(held.map((h) => h.secid))
  const rest = watch.filter((w) => !heldSet.has(w.secid)).map((w) => ({ secid: w.secid, name: w.name, held: false as const }))
  // 只保留可交易的沪深 A 股 / ETF（港股/美股/期货在引擎里本来就下不了单，列出来只占上下文）
  const list: CandidateInput[] = [...held, ...rest].filter((c) => isValidSecid(c.secid))
  const key = list.map((c) => c.secid).join(',')
  if (candidatesCache !== null && candidatesCache.key === key && Date.now() - candidatesCache.at < 10 * 60_000) return candidatesCache.text
  const text = await candidatesTextOf(list, {
    loadBars: async (secid) => (await fetchKline(secid, 101, 120, 0))?.days ?? null,
    loadValuation: (secids) => fetchValuationBatch(secids),
  })
  candidatesCache = { key, at: Date.now(), text }
  return text
}

export const prismInputsOf = async (deps: PrismRouteDeps): Promise<PrismInputs> => {
  const watch = deps.data.watchData().items
  const port = deps.data.portData()
  const secids = [...new Set([...watch.map((w) => w.secid), ...port.items.map((p) => p.secid)])]
  const quotes = await loadQuotes(deps, secids).catch(() => ({}))
  const assembly = assemblePortfolio(port.groups, port.items, deps.data.ledgerEntries(), quotes)
  const positions = assembly.view.positions
    .filter((p) => p.qty > 0)
    .map((p) => `${p.name}（${p.secid}）：${p.qty} 股，成本 ${p.avgCost.toFixed(3)}`)
    .join('\n')
  const products = etfProductsTextOf(
    assembly.view.positions.map((p) => ({ secid: p.secid, name: p.name, qty: p.qty, mv: typeof p.mv === 'number' ? p.mv : null })),
    assembly.view.grand.totalMv,
  )
  const quoteText = secids
    .map((secid) => {
      const q = quotes[secid]
      if (q === undefined || q.price === null) return `${secid}：—（未取到行情）`
      return `${q.name ?? secid}：${q.price}（${q.pct === null ? '—' : `${q.pct.toFixed(2)}%`}）`
    })
    .join('\n')
  const allOrders = deps.trading.orders()
  const pending = allOrders.filter((o) => o.status === 'pending')
  const account = deps.trading.account()
  const accountPrices: Record<string, number | null> = {}
  for (const p of account.positions) accountPrices[p.secid] = quotes[p.secid]?.price ?? null
  const accountSnapshot = accountSnapshotOf(account, accountPrices, deps.trading.fills(), pending.length)
  const pendingText = pending.length === 0
    ? '—'
    : pending.map((o) => `${o.id} ${o.side === 'buy' ? '买' : '卖'} ${o.name} ${o.shares}@${o.price}`).join('\n')
  const news = deps.store.news().items.slice().sort((a, b) => (a.time < b.time ? 1 : -1))
  const industryData = await industryDataOf(deps, account.positions.map((p) => p.secid))
  const exposure = industryExposureOf(account, accountPrices, industryData.map, deps.store.settings().industryLimits ?? {}, industryData.reason)
  const exposureText = exposure.state === 'unavailable'
    ? `—（${exposure.reason ?? '行业归属不可用'}）`
    : exposure.rows.length === 0
      ? '—（无持仓与现金）'
      : exposure.rows.map((r) => `${r.name}：${r.weight.toFixed(2)}%（市值 ${r.value.toFixed(2)}${r.limitPct === null ? '' : `，上限 ${r.limitPct}%`}）`).join('\n') +
        `\n已归类 ${exposure.classifiedPct.toFixed(2)}% + 未归类 ${exposure.unclassifiedPct.toFixed(2)}% = 100.00%`
  // 今日（北京时间）已被风控拒绝的委托：模型必须看见上一轮为何被拒，避免按周期重复提交
  const rejectedText = rejectedTodayTextOf(rejectedTodayOf(allOrders, dayOf((deps.now ?? Date.now)()), deps.store.runs()))
  return {
    positions,
    products,
    account: accountSnapshot,
    quotes: `${quoteText}\n【待成交挂单】\n${pendingText}\n【今日已被风控拒绝的委托】\n${rejectedText}`,
    news,
    skeleton: deps.store.skeleton(),
    exposure: exposureText,
    tech: await indexTechCachedOf().catch(() => '【指数技术面（由本地日线计算；缺数据写 —）】\n—（本轮取数失败）'),
    candidates: await candidatesCachedOf(deps, watch).catch(() => '【候选池（持仓 + 自选）】\n—（本轮取数失败）'),
    limits: limitsTextOf(deps.store.settings()),
    autoT: (() => {
      const cfg = deps.store.settings().autoT
      const anyOn = Object.values(cfg?.positions ?? {}).some((v) => v?.enabled === true)
      if (!anyOn) return '【自动做T·可计划标的】未开启（不要输出 tPlans，给空数组）'
      const rows = account.positions.filter((p) => cfg.positions?.[p.secid]?.enabled === true && p.qty > 0)
      if (rows.length === 0) return '【自动做T·可计划标的】无（没有开启做T的持仓；tPlans 给空数组）'
      return ['【自动做T·可计划标的】（只对这些持仓给 tPlans）', ...rows.map((p) => `- ${p.name}（${p.secid}）：持仓 ${p.qty}，可卖 ${p.available}，买入均价 ${p.avgCost ?? p.cost}`)].join('\n')
    })(),
    drawdown: (() => {
      const st = deps.store.settings()
      const g = drawdownGateOf(deps.trading.equity(), deps.store.runs().at(-1)?.drawdown ?? null, Date.now(), {
        dailyLimitPct: typeof st.maxDDPct === 'number' ? st.maxDDPct : 3,
        cumulativeLimitPct: typeof st.maxCumDDPct === 'number' ? st.maxCumDDPct : 10,
        baseAt: st.gateBaseAt,
      })
      const pct = (v: number | null): string => (v === null ? '—（样本不足）' : `${v.toFixed(2)}%`)
      return `【回撤闸门（引擎判定，先于你的决策）】\n日跌幅 ${pct(g.dailyPct)}；累计回撤 ${pct(g.cumulativePct)}；状态：${g.status}${g.triggered ? `（本轮新买单会被直接拒绝；目标总仓 ${g.targetTotalPct}%、现金下限 ${g.cashMinPct}%）` : ''}`
    })(),
  }
}

const kickNews = (store: PrismStore): void => {
  if (process.env.NODE_TEST_CONTEXT !== undefined) return
  const status = store.news().status
  const task = status.state === 'ready' ? incrementalNews(store) : backfillNews(store)
  void task.catch(() => undefined)
}

const loadQuotes = (deps: PrismRouteDeps, secids: string[]): Promise<Record<string, import('../shared/model.ts').QuoteRow>> =>
  (deps.quotes ?? fetchQuotes)(secids)

const quoteLiteOf = async (deps: PrismRouteDeps, secids: string[]): Promise<Record<string, QuoteLite>> => {
  const rows = await loadQuotes(deps, secids).catch(() => ({}))
  const out: Record<string, QuoteLite> = {}
  for (const secid of secids) {
    const q = rows[secid]
    if (q !== undefined) out[secid] = { name: q.name, price: q.price, prev: q.prev }
  }
  return out
}

const copyRowsOf = async (deps: PrismRouteDeps): Promise<Array<{ secid: string; name: string; qty: number; cost: number }>> => {
  const port = deps.data.portData()
  const secids = port.items.map((p) => p.secid)
  const quotes = await loadQuotes(deps, secids).catch(() => ({}))
  const view = assemblePortfolio(port.groups, port.items, deps.data.ledgerEntries(), quotes).view
  // 用户口径：复制主插件**摊薄成本**（不是移动加权 avgCost）
  return view.positions.filter((p) => p.qty > 0).map((p) => ({ secid: p.secid, name: p.name, qty: p.qty, cost: p.dilutedCost ?? p.avgCost }))
}

/**
 * 每天一个净值点（缺价按成本）；同日覆盖。
 *
 * P2-7：**只有净值点真的变了才写盘** —— 同日最新点的 `cash`/`equity` 与本次相同就跳过
 * （页面每 30 s 一次 GET，旧实现每次都是一次 2.8 KB 原子写 + 一次基准 K 线取数）。
 * 跨日（或还没有任何点）必写。返回 `true` = 真的落盘。
 *
 * `quotes` 可由调用方传入（GET 本来就要取同一份行情，别取两次）；缺省自己取。
 */
/** 净值点只在开盘后记录：盘前 GET 会把「今日盘前价」写到上一交易日名下（审计 B1） */
export function equityRecordAllowed(hhmm: string): boolean {
  return hhmm >= '09:30'
}

const recordEquity = async (deps: PrismRouteDeps, now = Date.now(), quotesGiven?: Record<string, QuoteLite>): Promise<boolean> => {
  const preOpen = !equityRecordAllowed(hhmmOf(now))
  const account = deps.trading.account()
  const before = deps.trading.equity()
  const last = before.at(-1) ?? null
  const quotes = quotesGiven ?? (await quoteLiteOf(deps, account.positions.map((p) => p.secid)).catch(() => ({})))
  const priceOf = (secid: string): number | null => quotes[secid]?.price ?? null
  // 先用**不含基准**的净值判断要不要写：跳过时连基准 K 线都不用取
  const probe = equityPointOf(account, priceOf, now, null)
  // 盘前只拦「会覆盖上一交易日收盘」的写入；当天还没有点（新账本）时允许建首个点
  if (preOpen && probe.day !== dayOf(now)) return false
  if (last !== null && last.day === probe.day && last.cash === probe.cash && last.equity === probe.equity) return false
  let benchmarkClose: number | null = null
  try {
    const k = await (deps.kline ?? fetchKline)('1.000300', 101, 1)
    const close = k?.days.at(-1)?.close
    benchmarkClose = typeof close === 'number' && Number.isFinite(close) ? close : null
  } catch { benchmarkClose = null }
  const point = equityPointOf(account, priceOf, now, benchmarkClose)
  const warning = dayStartMismatchOf(account, before)
  if (warning !== null) console.warn(`[tradewatcher] 棱镜净值口径告警：${warning}`)
  if (warning !== null) point.warnings = [warning]
  await deps.trading.saveEquity(upsertEquity(before, point))
  return true
}

interface ModelCatalog {
  providers: Array<{ id: string; name: string }>
  models: Record<string, string[]>
  error: string | null
}

let catalogCache: { at: number; value: ModelCatalog } | null = null

/** 宿主可用模型（60s 缓存）；拿不到 ⇒ providers 空 + error（页面退化为自由输入） */
const modelCatalogOf = async (get: (n: string) => unknown): Promise<ModelCatalog> => {
  if (catalogCache !== null && Date.now() - catalogCache.at < 60_000) return catalogCache.value
  try {
    const llm = get('llm') as {
      listProviders?: () => Array<{ id?: unknown; name?: unknown }>
      listModels?: (provider: string) => Promise<Array<{ id?: unknown }>>
    } | undefined
    const providers = (llm?.listProviders?.() ?? [])
      .filter((p): p is { id: string; name?: unknown } => typeof p.id === 'string')
      .map((p) => ({ id: p.id, name: typeof p.name === 'string' ? p.name : p.id }))
    const models: Record<string, string[]> = {}
    if (typeof llm?.listModels === 'function') {
      for (const p of providers) {
        try {
          models[p.id] = (await llm.listModels(p.id)).map((m) => m.id).filter((id): id is string => typeof id === 'string')
        } catch {
          models[p.id] = []
        }
      }
    }
    const value: ModelCatalog = { providers, models, error: providers.length === 0 ? '宿主没有可用 provider 列表（可自由输入）' : null }
    catalogCache = { at: Date.now(), value }
    return value
  } catch (error) {
    const value: ModelCatalog = { providers: [], models: {}, error: `模型列表不可读（${String(error).slice(0, 80)}）` }
    catalogCache = { at: Date.now(), value }
    return value
  }
}

const stateOf = (store: PrismStore, get: (n: string) => unknown): PrismState => {
  let provider: string | null = null
  let model: string | null = null
  let error: string | null = null
  try {
    const sel = get('agentDefaultModel') as { currentSelection?: () => { provider?: unknown; model?: unknown } } | undefined
    const picked = sel?.currentSelection?.()
    if (typeof picked?.provider === 'string' && typeof picked?.model === 'string') {
      provider = picked.provider
      model = picked.model
    } else {
      error = '没有默认模型（agentDefaultModel.currentSelection 为空）'
    }
  } catch (e) {
    error = `默认模型不可读（${String(e).slice(0, 80)}）`
  }
  const news = store.news()
  return {
    settings: store.settings(),
    skeleton: store.skeleton(),
    news: news.status,
    runs: store.runs(),
    model: { provider, model, error },
  }
}

/**
 * HTTP 回包瘦身（审计 UI P1）：`runs[].reports[].text` 与 `desk.decisionFlow` 客户端零引用，
 * 单次回包合计约 557KB（33.5%）。只影响回包，落盘结构不变。
 */
export function slimPrismPayload<T extends Record<string, unknown>>(payload: T): T {
  const state = payload['state'] as { runs?: Array<Record<string, unknown>> } | undefined
  if (state !== undefined && Array.isArray(state.runs)) {
    state.runs = state.runs.map((r) => {
      const { reports: _reports, ...rest } = r
      return rest
    })
  }
  const desk = payload['desk'] as { decisionFlow?: unknown } | undefined
  if (desk !== undefined && 'decisionFlow' in desk) delete desk.decisionFlow
  return payload
}

const tradingOf = (trading: PrismTradingStore, prices: Record<string, number | null> = {}): {
  account: ReturnType<PrismTradingStore['account']>
  orders: ReturnType<PrismTradingStore['orders']>
  fills: ReturnType<PrismTradingStore['fills']>
  equity: ReturnType<PrismTradingStore['equity']>
  decision: ReturnType<PrismStore['runs']>[number]['decision'] | null
  prices: Record<string, number | null>
  exposure: ReturnType<typeof unavailableExposure>
} => ({
  account: trading.account(),
  orders: trading.orders(),
  fills: trading.fills(),
  equity: trading.equity(),
  decision: trading === undefined ? null : null,
  prices,
  // 非 GET 操作不重算行业；仍返回非 null 的 unavailable，前端永远有卡可渲染
  exposure: unavailableExposure('本次操作未重算行业暴露（GET 时计算）'),
})

/** 把 tPlans 转成配对挂单（channel:'autoT'），与主委托同管线 */
async function placeAutoTPairs(deps: PrismRouteDeps, run: PrismRun): Promise<void> {
  const cfg = deps.store.settings().autoT
  const plans = run.decision.tPlans ?? []
  if (cfg?.enabled !== true || plans.length === 0) return
  const day = dayOf(Date.now())
  const deadline = Date.parse(`${day}T14:50:00+08:00`)
  if (!(Date.now() < deadline)) return
  const records: AutoTPlanRec[] = []
  await deps.trading.runExclusive(async () => {
    await deps.trading.reloadForWrite()
    const account = deps.trading.account()
    const orders = deps.trading.orders().slice()
    const fills = deps.trading.fills()
    for (const plan of plans) {
      if (cfg.positions?.[plan.secid]?.enabled !== true) continue
      const pos = account.positions.find((p) => p.secid === plan.secid)
      if (pos === undefined) continue
      const cap = Math.min(pos.available, Math.floor((pos.qty * 0.2) / 100) * 100, plan.shares)
      if (cap < 100) continue
      if ((plan.sellPrice / plan.buyPrice - 1) * 100 < 0.8) continue
      const pairId = `T-${day.replace(/-/g, '')}-${plan.secid}-${Date.now().toString(36)}`
      const at = Date.now()
      orders.push(
        { id: `${pairId}-buy`, secid: plan.secid, name: pos.name, side: 'buy', price: plan.buyPrice, shares: cap, reason: '自动做T·买入腿', decidedAt: at, day, status: 'pending', channel: 'autoT', tPlanId: pairId, pairId, leg: 'open', expireAt: deadline },
        { id: `${pairId}-sell`, secid: plan.secid, name: pos.name, side: 'sell', price: plan.sellPrice, shares: cap, reason: '自动做T·卖出腿', decidedAt: at, day, status: 'pending', channel: 'autoT', tPlanId: pairId, pairId, leg: 'close', expireAt: deadline },
      )
      records.push({ id: pairId, secid: plan.secid, name: pos.name, day, direction: plan.direction, buyPrice: plan.buyPrice, sellPrice: plan.sellPrice, shares: cap, status: 'waiting', observe: plan.observe ?? null, reasoning: plan.reasoning ?? null, conclusion: plan.conclusion ?? null, pairId, at })
    }
    await deps.trading.saveAll({ account, orders, fills })
    if (records.length > 0) {
      const file = deps.store.autoT()
      await deps.store.saveAutoT({ ...file, plans: [...file.plans, ...records] })
    }
  })
}

export async function runPrismForSlot(deps: PrismRouteDeps, slot: string): Promise<Awaited<ReturnType<typeof runPrismAnalysis>>> {
  // P0-2：账本读不到时，连研判落单都不许开始（先给明确的 400，而不是跑完 LLM 再报错）
  deps.trading.assertWritable('棱镜研判落单')
  const inputs = await prismInputsOf(deps)
  const now = deps.now ?? Date.now
  const run = await runPrismAnalysis(deps.store, slot, inputs, { get: deps.get, model: deps.store.settings().model ?? null, now })
  if (run.decision === null) {
    run.placement = { placed: 0, skipped: 0, rejects: [] }
    await deps.store.replaceRun(run)
    return run
  }
  const account = deps.trading.account()
  const quotes = run.decision.orders.length > 0 ? await quoteLiteOf(deps, run.decision.orders.map((o) => o.secid)) : {}
  // 行业归属要覆盖「本轮新开仓」的标的：只查已持仓会让新开仓的行业上限永远不生效（审计 F3）
  const industrySecids = [...new Set([...account.positions.map((p) => p.secid), ...run.decision.orders.map((o) => o.secid)])]
  const industries = await fetchIndustryOverview(industrySecids).catch(() => ({}))
  const settings = deps.store.settings()
  const decisionIndustry = Array.isArray(run.decision.limits.byIndustry) ? Object.fromEntries(run.decision.limits.byIndustry.map((x) => [x.name, x.limitPct])) : (run.decision.limits.byIndustry ?? {})
  // 行业上限：**用户配置优先**，模型自报只补未配置的行业（否则模型可自证放宽上限）
  const limits = { ...run.decision.limits, byIndustry: { ...decisionIndustry, ...(settings.industryLimits ?? {}) } }
  const eq = deps.trading.equity()
  const lastEq = eq.at(-1)
  const dayDrawdownPct = lastEq !== undefined && lastEq.equity > 0 && account.dayStartEquity !== null
    ? ((lastEq.equity - account.dayStartEquity) / account.dayStartEquity) * 100
    : null
  // 服务端去重闸（最后防线）：今日已因同一原因被拒、且标的/方向/股数/价格几乎相同的单
  // 不再进入撮合、不写 pending；上下文（A 层）是第一道，这里防模型无视上下文。
  const rejectedToday = rejectedTodayOf(deps.trading.orders(), dayOf(run.startedAt), deps.store.runs(), Number.POSITIVE_INFINITY)
  // v0.214.0：同产品闸要名称、偏离闸要现价——两者都只认本轮 `quotes`（同一次取数，不新开源）；
  // 取不到就记 skipped，绝不拿成本或 0 冒充现价。
  const pendingBuys = deps.trading.orders()
    .filter((o) => o.status === 'pending' && o.side === 'buy')
    .map((o) => ({ secid: o.secid, name: o.name }))
  const clamped = clampDecision(run.decision, {
    cash: account.cash,
    // 缺价 ⇒ 传 null（不要拿成本冒充现价）：clamp 会按 missingPrice 跳过并留痕，避免「按成本算权重」与提示词不一致
    positions: account.positions.map((p) => ({ secid: p.secid, qty: p.qty, available: p.available, price: quotes[p.secid]?.price ?? null, name: p.name })),
    limits,
    constraints: {
      perStockPct: settings.perStockPct ?? null,
      stopLossPct: settings.stopLossPct ?? null,
      perOrderYuan: settings.perOrderYuan ?? null,
      maxPosPct: settings.maxPosPct ?? null,
      maxDDPct: settings.maxDDPct ?? null,
      minCashPct: settings.minCashPct ?? null,
    },
    // 止损判定要比的是**每股成本**：netCost 是总成本（几千几万），拿它和现价比会算出 −99.9%，
    // 把所有「加仓已持有标的」的买单全部误判成触及止损（实测 2026-11-24 工商银行/长债ETF）。
    // 只给「有买入均价」的持仓；缺的留给 clamp 记 skipped（不拿摊薄成本兜底）
    costs: Object.fromEntries(account.positions.filter((p) => p.qty > 0 && typeof p.avgCost === 'number').map((p) => [p.secid, p.avgCost as number])),
    dayDrawdownPct,
    industries: Object.fromEntries(Object.entries(industries).map(([k, v]) => [k, v?.name ?? null])),
    at: run.startedAt,
    rejectedToday,
    quotes,
    pendingBuys,
  })
  const previous = deps.store.runs().filter((r) => r.startedAt < run.startedAt).at(-1)?.drawdown ?? null
  const settingsNow = deps.store.settings()
  const drawdown = drawdownGateOf(deps.trading.equity(), previous, run.startedAt, {
    dailyLimitPct: typeof settingsNow.maxDDPct === 'number' ? settingsNow.maxDDPct : 3,
    cumulativeLimitPct: typeof settingsNow.maxCumDDPct === 'number' ? settingsNow.maxCumDDPct : 10,
    baseAt: settingsNow.gateBaseAt,
  })
  run.decision = applyDrawdownGate(clamped.decision, drawdown)
  run.drawdown = drawdown
  // 边界口径：用 run 触发时刻（startedAt），不是分析结束后的墙钟；14:59:09 ⇒ 14:59 可下单
  const result = await placeDecision(deps.trading, run.decision, run.startedAt, quotes)
  // 保留裁剪/去重阶段的 rejects（此前被 placeDecision 的 rejects 覆盖 ⇒ 去重闸留痕会消失）
  run.decision = { ...run.decision, rejects: [...run.decision.rejects, ...result.rejects] }
  await placeAutoTPairs(deps, run).catch((error) => { run.error = `自动做T下单失败：${String((error as Error)?.message ?? error)}` })
  // 单票上限以配置为准：模型自报值可能照抄骨架里的旧数字，落盘前统一成配置值（否则界面显示 20%、实际按 30% 裁）
  if (typeof settingsNow.perStockPct === 'number') {
    run.decision = { ...run.decision, limits: { ...run.decision.limits, singlePct: settingsNow.perStockPct } }
  }
  run.placement = result.placement
  await deps.store.replaceRun(run)
  return run
}

export function makePrismRoutes(deps: PrismRouteDeps): PluginWebRoute[] {
  const { store } = deps
  return [
    {
      kind: 'exact',
      path: '/tradewatcher/prism',
      handler: async (req, res) => {
        if (req.method === 'GET') {
          // P0-2：账本读不到 ⇒ 不读"内存空库"、不写 equity，直接把降级状态告诉界面
          if (deps.trading.degraded) {
            send(res, 503, {
              ok: false,
              degraded: true,
              error: deps.trading.ledgerError() ?? '账本不可读，已停止写入',
              ledger: deps.trading.degradedInfo(),
            })
            return
          }
          await deps.trading.reloadOrders()
          if (deps.trading.degraded) {
            send(res, 503, {
              ok: false,
              degraded: true,
              error: deps.trading.ledgerError() ?? '账本不可读，已停止写入',
              ledger: deps.trading.degradedInfo(),
            })
            return
          }
          kickNews(store)
          const account = deps.trading.account()
          const settings = store.settings()
          const accountView = { ...account, capital: settings.capital ?? account.capital ?? account.capitalLimit }
          const quotes = await quoteLiteOf(deps, accountView.positions.map((p) => p.secid)).catch(() => ({}))
          // P2-7：复用同一份行情判断净值点是否变化 —— 没变就 0 次写盘、0 次基准 K 线取数
          await recordEquity(deps, Date.now(), quotes)
          const prices: Record<string, number | null> = {}
          for (const p of accountView.positions) prices[p.secid] = quotes[p.secid]?.price ?? null
          const industryData = await industryDataOf(deps, accountView.positions.map((p) => p.secid))
          let exposure
          try {
            const latestIndustry = store.runs().at(-1)?.decision?.limits.byIndustry
            const latestIndustryMap = Array.isArray(latestIndustry) ? Object.fromEntries(latestIndustry.map((x) => [x.name, x.limitPct])) : (latestIndustry ?? {})
            exposure = industryExposureOf(accountView, prices, industryData.map, { ...(settings.industryLimits ?? {}), ...latestIndustryMap }, industryData.reason)
          } catch (error) {
            exposure = unavailableExposure(`行业暴露计算失败：${String(error).slice(0, 80)}`)
          }
          const feesByDay: Record<string, number> = {}
          for (const f of deps.trading.fills()) feesByDay[dayOf(f.at)] = (feesByDay[dayOf(f.at)] ?? 0) + f.fee
          const evaluation = evaluationOf(deps.trading.equity(), feesByDay, 1, EVAL_MIN_SAMPLE)
          const trading = { ...tradingOf(deps.trading, prices), account: accountView, exposure, evaluation }
          const latestDecision = store.runs().at(-1)?.decision ?? null
          const tradingWithDecision = { ...trading, decision: latestDecision }
          const modelCatalog = await modelCatalogOf(deps.get)
          const autoT = autoTPayloadOf(store, account, dayOf(Date.now()))
          // v0.202.0：AGENT DESK 六区块新增字段（只读追加，旧字段一个不删）
          const desk = prismDeskOf({
            account: accountView,
            prices,
            quotes: Object.fromEntries(Object.entries(quotes).map(([k, v]) => [k, { price: v.price ?? null, prev: (v as { prev?: number | null }).prev ?? null }])),
            orders: deps.trading.orders(),
            fills: deps.trading.fills(),
            runs: store.runs(),
            equity: deps.trading.equity(),
            evaluation,
            // 已保存约束（只读）：持仓分析的「超单票上限 / 触及止损线」只认它，缺 ⇒ null（不套默认 15/8）
            constraints: { perStockPct: settings.perStockPct ?? null, stopLossPct: settings.stopLossPct ?? null },
          })
          // 顶层 `state` 也带模拟盘字段（旧消费者读 state.account；页面读 trading）
          send(res, 200, slimPrismPayload({
            ok: true,
            asOf: Date.now(),
            state: { ...stateOf(store, deps.get), ...tradingWithDecision, modelCatalog, autoT },
            // 顶层 trading 与 state 是同一对象（重复序列化 260KB，审计 UI）：客户端只读 state
            modelCatalog,
            desk,
            autoT,
          }))
          return
        }
        if (req.method !== 'POST') {
          send(res, 405, { ok: false, error: 'method not allowed' })
          return
        }
        try {
          const body = (await readBody(req)) as { op?: unknown; shares?: unknown; cost?: unknown; confirm?: unknown; action?: unknown; times?: unknown; intervalSec?: unknown; text?: unknown; slot?: unknown; capitalLimit?: unknown; orderId?: unknown; provider?: unknown; model?: unknown; industryLimits?: unknown; secid?: unknown; at?: unknown; price?: unknown; newPrice?: unknown; basis?: unknown; backupOf?: unknown; cash?: unknown } | null
          const action = body !== null && typeof body.action === 'string' ? body.action : ''
          if (action === 'ledgerRepair') {
            // P0-2 首次修复：从 *.bak / .corrupt-* 恢复；成功后才解除 degraded
            const backupOf = typeof body?.backupOf === 'string' && body.backupOf.trim() !== '' ? body.backupOf.trim() : undefined
            try {
              const repaired = await deps.trading.repairLedger(backupOf === undefined ? {} : { backupOf })
              send(res, repaired.ok ? 200 : 400, { ok: repaired.ok, action: 'ledgerRepair', ...repaired, ledger: deps.trading.degradedInfo() })
            } catch (error) {
              send(res, 400, { ok: false, action: 'ledgerRepair', error: String((error as Error).message ?? error).slice(0, 160), ledger: deps.trading.degradedInfo() })
            }
            return
          }
          if (action === 'position') {
            const op = typeof body?.op === 'string' ? body.op : ''
            const input = { op, secid: body?.secid, shares: body?.shares, cost: body?.cost, confirm: body?.confirm }
            const result = await deps.trading.runExclusive(async () => {
              deps.trading.assertWritable('持仓调整')
              await deps.trading.reloadForWrite()
              deps.trading.assertWritable('持仓调整')
              const r = applyPositionOp(deps.trading.account(), input, Date.now())
              if (!r.ok) return r
              // 持仓调整也必须与 orders/equity 一起走"三账本一次写"，不能只改 account
              await deps.trading.saveAll({ account: r.account!, orders: deps.trading.orders(), fills: deps.trading.fills() })
              return r
            })
            if (!result.ok) { send(res, 400, { ok: false, error: result.error }); return }
            if (result.entry !== undefined) appendPrismLedger(deps.trading.dirOf(), result.entry)
            send(res, 200, { ok: true, positions: result.account!.positions, note: result.note })
            return
          }
          if (action === 'constraints') {
            const checked = validateConstraints(body as Record<string, unknown>)
            if (checked.ok === false) { send(res, 400, { ok: false, error: checked.error }); return }
            await store.saveConstraints(checked.value)
            send(res, 200, { ok: true, constraints: checked.value })
            return
          }
          if (action === 'settings') {
            // `times` 与 `intervalSec` 各自可选、可同时传；两者都不传 ⇒ 400（避免空写）
            const hasTimes = body !== null && body.times !== undefined
            const hasInterval = body !== null && body.intervalSec !== undefined
            if (!hasTimes && !hasInterval) {
              send(res, 400, { ok: false, error: `settings 需要 times（HH:MM 数组，手动重放用）和/或 intervalSec（${PRISM_INTERVAL_OPTIONS.join(' / ')} 秒）` })
              return
            }
            let times: string[] | undefined
            if (hasTimes) {
              const raw = Array.isArray(body.times) ? body.times : null
              if (raw === null) {
                send(res, 400, { ok: false, error: 'times 必须是 HH:MM 数组' })
                return
              }
              if (raw.length > PRISM_MAX_TIMES) {
                send(res, 400, { ok: false, error: `时点最多 ${PRISM_MAX_TIMES} 个` })
                return
              }
              const clean = raw.filter((t): t is string => typeof t === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(t))
              if (clean.length !== raw.length) {
                send(res, 400, { ok: false, error: '存在非法时点（HH:MM）' })
                return
              }
              times = clean
            }
            let intervalSec: number | undefined
            if (hasInterval) {
              const v = body.intervalSec
              if (typeof v !== 'number' || !(PRISM_INTERVAL_OPTIONS as readonly number[]).includes(v)) {
                send(res, 400, { ok: false, error: `intervalSec 只允许 ${PRISM_INTERVAL_OPTIONS.join(' / ')} 秒` })
                return
              }
              intervalSec = v
            }
            // intervalSec 是**自动决策周期**：`PrismScheduler.intervalDue` 在交易时段内按它触发；
            // times 只留给手动重放（两者不再同时跑两套自动触发）
            const settings: PrismSettings = await store.saveSchedule({ ...(times === undefined ? {} : { times }), ...(intervalSec === undefined ? {} : { intervalSec }) })
            send(res, 200, { ok: true, settings })
            return
          }
          if (action === 'industryLimits') {
            const raw = body !== null && body.industryLimits !== null && typeof body.industryLimits === 'object' && !Array.isArray(body.industryLimits)
              ? body.industryLimits as Record<string, unknown>
              : null
            if (raw === null) { send(res, 400, { ok: false, error: 'industryLimits 必须是对象' }); return }
            const clean: Record<string, number> = {}
            for (const [name, v] of Object.entries(raw)) {
              if (name.trim() === '' || name.length > 80 || typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 100) {
                send(res, 400, { ok: false, error: `行业上限非法：${name}` }); return
              }
              clean[name.trim()] = Math.round(v * 100) / 100
            }
            const settings = await store.saveIndustryLimits(clean)
            send(res, 200, { ok: true, settings })
            return
          }
          if (action === 'feeCorrection') {
            const orderId = typeof body?.orderId === 'string' ? body.orderId : ''
            const secid = typeof body?.secid === 'string' ? body.secid : ''
            const at = typeof body?.at === 'number' ? body.at : NaN
            const price = typeof body?.price === 'number' ? body.price : NaN
            if (orderId === '' || secid === '' || !Number.isFinite(at) || !Number.isFinite(price)) {
              send(res, 400, { ok: false, error: 'feeCorrection 缺 orderId/secid/at/price' }); return
            }
            const result = await deps.trading.runExclusive(async () => {
              deps.trading.assertWritable('费用订正')
              await deps.trading.reloadForWrite()
              deps.trading.assertWritable('费用订正')
              const r = applyFeeCorrection(deps.trading.account(), deps.trading.fills(), { orderId, secid, at, price })
              await deps.trading.saveAll({ account: r.account, orders: deps.trading.orders(), fills: deps.trading.fills() })
              return r
            })
            send(res, 200, { ok: true, ...result, account: result.account })
            return
          }
          if (action === 'priceCorrection') {
            const orderId = typeof body?.orderId === 'string' ? body.orderId : ''
            const newPrice = typeof body?.newPrice === 'number' ? body.newPrice : NaN
            const basis = typeof body?.basis === 'string' ? body.basis : ''
            if (orderId === '' || !Number.isFinite(newPrice) || basis.trim() === '') {
              send(res, 400, { ok: false, error: 'priceCorrection 缺 orderId/newPrice/basis' }); return
            }
            try {
              const result = await deps.trading.runExclusive(async () => {
                deps.trading.assertWritable('错价订正')
                await deps.trading.reloadForWrite()
                deps.trading.assertWritable('错价订正')
                const r = applyPriceCorrection(deps.trading.account(), deps.trading.orders(), deps.trading.fills(), { orderId, newPrice, basis })
                // 订正同时改账户现金与成交价：必须三账本一次写，不能先 account 后 orders
                await deps.trading.saveAll({ account: r.account, orders: r.orders, fills: r.fills })
                return r
              })
              send(res, 200, { ok: true, note: result.note, delta: result.delta, oldPrice: result.oldPrice, newPrice: result.newPrice, account: result.account })
            } catch (error) {
              send(res, 400, { ok: false, error: String((error as Error).message ?? error) })
            }
            return
          }
          if (action === 'model') {
            const provider = typeof body?.provider === 'string' ? body.provider.trim() : ''
            const model = typeof body?.model === 'string' ? body.model.trim() : ''
            if (provider === '' || model === '') {
              send(res, 400, { ok: false, error: 'provider 和 model 都必须填写' })
              return
            }
            const catalog = await modelCatalogOf(deps.get)
            if (catalog.providers.length > 0 && !catalog.providers.some((p) => p.id === provider)) {
              send(res, 400, { ok: false, error: `未知 provider「${provider}」（可用：${catalog.providers.map((p) => p.id).join(' / ')}）` })
              return
            }
            const settings = await store.saveModel(provider, model)
            send(res, 200, { ok: true, settings })
            return
          }
          if (action === 'skeleton') {
            const text = body !== null && typeof body.text === 'string' ? body.text : null
            if (text === null) {
              send(res, 400, { ok: false, error: 'text 必须是字符串' })
              return
            }
            if (text.length > PRISM_SKELETON_MAX) {
              send(res, 400, { ok: false, error: `骨架最多 ${PRISM_SKELETON_MAX} 字` })
              return
            }
            await store.saveSkeleton(text)
            send(res, 200, { ok: true, text })
            return
          }
          if (action === 'news') {
            const status = store.news().status.state === 'ready'
              ? await incrementalNews(store).catch(() => store.news().status)
              : await backfillNews(store).catch(() => store.news().status)
            send(res, 200, { ok: true, asOf: Date.now(), status })
            return
          }
          if (action === 'run') {
            // 手动补跑 / 重放今日：只写 `lastFired`（当天已补的时点），**不写** `lastAutoAt`
            // —— 手动不占用自动节奏；自动触发只走 `PrismScheduler`（intervalSec 周期）。
            const slot = typeof body?.slot === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(body.slot) ? body.slot : 'manual'
            const run = await runPrismForSlot(deps, slot)
            await recordEquity(deps)
            if (slot !== 'manual') await store.markFired(dayOf(Date.now()), slot)
            send(res, 200, { ok: true, asOf: Date.now(), run, orders: deps.trading.orders() })
            return
          }
          if (action === 'autoT') {
            const bodyObj = (body ?? {}) as { enabled?: unknown; positions?: unknown }
            const current = deps.store.settings().autoT ?? { enabled: false, positions: {} }
            const nextPositions: Record<string, { enabled: boolean }> = { ...current.positions }
            if (bodyObj.positions !== null && typeof bodyObj.positions === 'object' && !Array.isArray(bodyObj.positions)) {
              for (const [secid, raw] of Object.entries(bodyObj.positions as Record<string, unknown>)) {
                if (!isValidSecid(secid)) continue
                const flag = raw !== null && typeof raw === 'object' ? (raw as { enabled?: unknown }).enabled : undefined
                if (typeof flag === 'boolean') nextPositions[secid] = { enabled: flag }
              }
            }
            // 总状态由逐只开关派生（不单独暴露总开关）
            const enabled = Object.values(nextPositions).some((v) => v.enabled === true)
            await deps.store.patchSettings({ autoT: { enabled, positions: nextPositions } })
            const accountNow = deps.trading.account()
            send(res, 200, { ok: true, autoT: autoTPayloadOf(deps.store, accountNow, dayOf(Date.now())) })
            return
          }
          if (action === 'cash') {
            // 「现金持仓可编辑」：用户直接设当前现金余额（不动 realized，不补记成交）
            const cash = Number(body?.cash)
            if (!Number.isFinite(cash) || cash < 0) { send(res, 400, { ok: false, error: '现金必须是非负数' }); return }
            const next = await deps.trading.runExclusive(async () => {
              deps.trading.assertWritable('调整现金')
              await deps.trading.reloadForWrite()
              deps.trading.assertWritable('调整现金')
              const account = deps.trading.account()
              const before = account.cash
              const value = { ...account, cash: Math.round(cash * 100) / 100 }
              await deps.trading.saveAll({ account: value, orders: deps.trading.orders(), fills: deps.trading.fills() })
              // 现金是账外注资/提取：必须留痕（审计 A5），否则净值凭空变化且无记录
              appendPrismLedger(deps.trading.dirOf(), {
                id: `C${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
                ts: Date.now(), kind: 'manual-adjust', op: 'update', secid: 'CASH',
                before: { qty: before, cost: 1 }, after: { qty: value.cash, cost: 1 },
                note: `现金 ${before} → ${value.cash}（差额 ${Math.round((value.cash - before) * 100) / 100}，账外资金变动）`,
              })
              return value
            })
            send(res, 200, { ok: true, account: next })
            return
          }
          if (action === 'backfillBenchmark') {
            // 回填历史净值点的基准收盘价（1.000300 日线）：缺失会让「超额/命中率」永远是 —。
            const k = await (deps.kline ?? fetchKline)('1.000300', 101, 250).catch(() => null)
            const closes = new Map<string, number>()
            for (const d of k?.days ?? []) if (typeof d.close === 'number' && d.close > 0) closes.set(d.date, d.close)
            if (closes.size === 0) { send(res, 400, { ok: false, error: '基准日线取数失败，未做任何修改' }); return }
            const out = await deps.trading.runExclusive(async () => {
              deps.trading.assertWritable('回填基准收盘')
              await deps.trading.reloadForWrite()
              deps.trading.assertWritable('回填基准收盘')
              const before = deps.trading.equity()
              let filled = 0
              const pointsFixed = before.map((p) => {
                if (typeof p.benchmarkClose === 'number' && p.benchmarkClose > 0) return p
                const c = closes.get(p.day)
                if (c === undefined) return p
                filled += 1
                return { ...p, benchmarkClose: c }
              })
              await deps.trading.saveEquity(pointsFixed)
              return { filled, total: before.length, missing: pointsFixed.filter((p) => typeof p.benchmarkClose !== 'number').map((p) => p.day) }
            })
            send(res, 200, { ok: true, ...out })
            return
          }
          if (action === 'normalizeCostBasis') {
            // 把历史「摊薄成本」归一为买入均价：v0.226.0 起卖出不再改变每股成本，
            // 但旧账本里的 cost 仍是摊薄口径（招商轮船 39.64 vs 均价 18.21）⇒ 一次性对齐。
            const out = await deps.trading.runExclusive(async () => {
              deps.trading.assertWritable('成本口径归一')
              await deps.trading.reloadForWrite()
              deps.trading.assertWritable('成本口径归一')
              const account = deps.trading.account()
              const positions = account.positions.map((p) => {
                const avg = typeof p.avgCost === 'number' && p.avgCost > 0 ? p.avgCost : null
                if (avg === null) return p
                return { ...p, cost: avg, netCost: Math.round(avg * p.qty * 100) / 100 }
              })
              // 换成本口径会改变未实现盈亏 ⇒ 已实现必须按恒等式同步，否则 equity ≠ capital+realized+unrealized
              const quotesNow = await quoteLiteOf(deps, positions.map((p) => p.secid)).catch(() => ({}))
              const mv = positions.reduce((a, p) => a + p.qty * (quotesNow[p.secid]?.price ?? p.cost), 0)
              const unrealizedNow = positions.reduce((a, p) => a + (p.qty * (quotesNow[p.secid]?.price ?? p.cost) - (p.netCost ?? p.qty * p.cost)), 0)
              const realizedNow = realizedFromIdentity(account.cash + mv, account.capital, unrealizedNow)
              const value = { ...account, positions, ...(realizedNow === null ? {} : { realized: realizedNow }) }
              await deps.trading.saveAll({ account: value, orders: deps.trading.orders(), fills: deps.trading.fills() })
              return positions.map((p) => ({ secid: p.secid, name: p.name, qty: p.qty, cost: p.cost, netCost: p.netCost }))
            })
            send(res, 200, { ok: true, positions: out })
            return
          }
          if (action === 'backfillAvgCost') {
            const out = await deps.trading.runExclusive(async () => {
              deps.trading.assertWritable('回填买入均价')
              await deps.trading.reloadForWrite()
              deps.trading.assertWritable('回填买入均价')
              const account = deps.trading.account()
              const logs = account.copyLogs as ReadonlyArray<{ at: number; after?: string[] }>
              const positions = account.positions.map((p) => ({
                ...p,
                avgCost: avgCostFromHistory(p.secid, logs, deps.trading.fills(), readPrismLedger(dataHome()) as never, p.cost),
              }))
              const value = { ...account, positions }
              await deps.trading.saveAll({ account: value, orders: deps.trading.orders(), fills: deps.trading.fills() })
              return positions.map((p) => ({ secid: p.secid, name: p.name, cost: p.cost, avgCost: p.avgCost }))
            })
            send(res, 200, { ok: true, positions: out })
            return
          }
          if (action === 'rebase') {
            // 账本校平：realized := equity − capital − 未实现盈亏；并把回撤闸门基线挪到当前净值点。
            // 目的：历史 bug 造成的 realized/净值序列失真不再让「累计 −17%」永久冻结新买单。
            const quotes = await quoteLiteOf(deps, deps.trading.account().positions.map((p) => p.secid)).catch(() => ({}))
            const out = await deps.trading.runExclusive(async () => {
              deps.trading.assertWritable('校平账本')
              await deps.trading.reloadForWrite()
              deps.trading.assertWritable('校平账本')
              const account = deps.trading.account()
              const rows = account.positions.map((p) => {
                const px = quotes[p.secid]?.price ?? null
                const mv = px === null ? p.qty * p.cost : p.qty * px
                const net = p.netCost ?? p.qty * p.cost
                return { mv, net }
              })
              const equity = rows.reduce((a, r) => a + r.mv, 0) + account.cash
              const unrealized = rows.reduce((a, r) => a + (r.mv - r.net), 0)
              const realized = realizedFromIdentity(equity, account.capital, unrealized)
              if (realized === null) throw new Error('账本数据不完整（净值/本金/未实现盈亏含非法值），已拒绝校平')
              const before = account.realized
              // 不再把 available 全部解锁（审计 C1：当日买入会被校平绕过 T+1）；手工调整已在 update 时解锁
              const value = { ...account, realized }
              await deps.trading.saveAll({ account: value, orders: deps.trading.orders(), fills: deps.trading.fills() })
              await deps.store.patchSettings({ gateBaseAt: Date.now() })
              return { before, after: realized, equity, unrealized, cash: account.cash }
            })
            send(res, 200, { ok: true, ...out })
            return
          }
          if (action === 'capital') {
            const limit = Number(body?.capitalLimit)
            if (!Number.isFinite(limit) || limit <= 0) {
              send(res, 400, { ok: false, error: '资金上限必须是正数' })
              return
            }
            const next = await deps.trading.runExclusive(async () => {
              deps.trading.assertWritable('调整资金上限')
              await deps.trading.reloadForWrite()
              deps.trading.assertWritable('调整资金上限')
              const account = deps.trading.account()
              const cash = Math.round((account.cash + (limit - account.capitalLimit)) * 100) / 100
              if (cash < 0) return { error: '资金上限低于当前持仓成本 + 已用现金，不能把现金改为负数' as const }
              const value = { ...account, capital: limit, capitalLimit: limit, cash }
              await deps.trading.saveAll({ account: value, orders: deps.trading.orders(), fills: deps.trading.fills() })
              return { account: value }
            })
            if ('error' in next) { send(res, 400, { ok: false, error: next.error }); return }
            const settings = await store.saveCapital(limit)
            send(res, 200, { ok: true, account: next.account, settings })
            return
          }
          if (action === 'copy') {
            const rows = await copyRowsOf(deps)
            // 真实持仓为空时按成本复制会把模拟盘清空并重置现金（审计 A2）⇒ 直接拒绝
            if (rows.length === 0) {
              send(res, 400, { ok: false, error: '真实持仓为空：按成本复制会清空模拟盘并重置现金，已拒绝。请先用有持仓的账户，或显式清仓。' })
              return
            }
            const required = Math.round(rows.reduce((sum, r) => sum + Math.round(Math.max(0, r.cost) * 100) / 100 * Math.max(0, r.qty), 0) * 100) / 100
            const copied = await deps.trading.runExclusive(async () => {
              deps.trading.assertWritable('按成本复制持仓')
              await deps.trading.reloadForWrite()
              deps.trading.assertWritable('按成本复制持仓')
              const account = deps.trading.account()
              const capitalBefore = account.capitalLimit
              const capitalAfter = Math.max(capitalBefore, required)
              const raised = capitalAfter > capitalBefore
              const result = copyAtCost(rows, { ...account, capitalLimit: capitalAfter, capital: capitalAfter }, Date.now())
              result.account.capital = capitalAfter
              // 复制 = 新账本：旧挂单全部作废（否则旧买单用新现金成交、旧卖单卖掉新持仓）
              for (const o of deps.trading.orders()) {
                if (o.status === 'pending') { o.status = 'cancelled'; o.cancelledAt = Date.now(); o.cancelReason = '复制重置' }
              }
              await deps.trading.saveAll({ account: result.account, orders: deps.trading.orders(), fills: deps.trading.fills() })
              return { result, capitalBefore, capitalAfter, raised }
            })
            const settings = await store.saveCapital(copied.capitalAfter)
            await recordEquity(deps)
            send(res, 200, {
              ok: true,
              account: { ...copied.result.account, capital: copied.capitalAfter },
              settings,
              copy: {
                requestedPositions: rows.length,
                copiedPositions: copied.result.account.positions.length,
                required,
                capitalBefore: copied.capitalBefore,
                capitalAfter: copied.capitalAfter,
                raised: copied.raised,
              },
              log: copied.result.log,
              skipped: copied.result.skipped,
            })
            return
          }
          if (action === 'recover') {
            const account = deps.trading.account()
            const rebuilt = rebuildFromOrders(account, deps.trading.orders())
            send(res, 200, { ok: true, fills: rebuilt.fills, cash: rebuilt.cash, note: rebuilt.note })
            return
          }
          if (action === 'cancel') {
            const orderId = typeof body?.orderId === 'string' ? body.orderId : ''
            const result = await deps.trading.runExclusive(async () => {
              deps.trading.assertWritable('撤单')
              await deps.trading.reloadForWrite()
              deps.trading.assertWritable('撤单')
              const orders = deps.trading.orders()
              const order = orders.find((o) => o.id === orderId && o.status === 'pending')
              if (order === undefined) return { ok: false as const, error: '没有可撤销的挂单' }
              order.status = 'cancelled'
              order.cancelledAt = Date.now()
              order.cancelReason = '手动撤销'
              await deps.trading.saveAll({ account: deps.trading.account(), orders, fills: deps.trading.fills() })
              return { ok: true as const, orders }
            })
            send(res, 200, result)
            return
          }
          if (action === 'match') {
            const result = await matchTick(deps.trading, {
              quotes: (secids) => quoteLiteOf(deps, secids),
              bars: (secid, day) => import('./prismAccount.ts').then((m) => m.fetchOneMinuteBars(secid, day)),
              participationRate: store.settings().participationRate ?? 0.1,
            })
            send(res, 200, { ok: true, ...result, trading: tradingOf(deps.trading) })
            return
          }
          send(res, 400, { ok: false, error: '未知 action' })
        } catch (error) {
          // P0-2：账本不可读是**客户端可纠正**的状态（去修复），不是 500
          const status = error instanceof LedgerUnreadableError ? 400 : 500
          send(res, status, { ok: false, error: String((error as Error).message ?? error).slice(0, 160) })
        }
      },
    },
    {
      kind: 'exact',
      path: '/tradewatcher/prism/selftest',
      handler: async (_req, res) => {
        const started = Date.now()
        let ok = false
        let error: string | null = null
        let model: string | null = null
        let text: string | null = null
        let chunks: Array<{ type: string; keys: string[] }> = []
        try {
          const resolved = await import('./prismLlm.ts').then((m) => m.resolvePrismModel(deps.get, deps.store.settings().model ?? null))
          if (resolved.llm === null || resolved.info.provider === null || resolved.info.model === null) {
            error = resolved.info.error ?? '模型不可用'
          } else {
            model = `${resolved.info.provider} / ${resolved.info.model}`
            const r = await import('./prismLlm.ts').then((m) =>
              m.streamText(resolved.llm as never, { provider: resolved.info.provider as string, model: resolved.info.model as string },
                [{ role: 'user', content: '只回复 OK' }], undefined, AbortSignal.timeout(20_000)),
            )
            ok = r.text !== null && r.error === null
            text = r.text
            chunks = r.chunks
            error = r.error
          }
        } catch (e) {
          error = String(e).slice(0, 200)
        }
        send(res, 200, { ok, error, model, elapsedMs: Date.now() - started, text, chunks })
      },
    },
  ]
}
