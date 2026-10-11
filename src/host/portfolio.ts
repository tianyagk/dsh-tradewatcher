/**
 * Portfolio view assembly: replay the append-only ledger into per-position
 * accounting, merge live quotes, and produce group/grand summaries.
 * Pure functions — no IO — so they are directly unit-testable.
 */
import type {
  FxCurrency,
  FxMode,
  FxRates,
  GroupView,
  LedgerEntry,
  LedgerView,
  Market,
  PortGroup,
  PortItem,
  PortfolioView,
  PositionRow,
  QuoteRow,
} from '../shared/model.ts'
import { LEDGER_VERB_LABEL, FX_CURRENCY_LABEL, MISSING_TIER_ADVICE, fxCurrencyOf, isFiniteNumber, isT0Secid, marketOf, normalizeFxRate, normalizeFxRates } from '../shared/model.ts'

/** 市场显示名（unpriced 的原因说明用） */
const MARKET_LABEL: Record<Market, string> = {
  cn: 'A股',
  hk: '港股',
  us: '美股',
  intl: '国际',
  futures: '期货/商品',
  unknown: '未知市场',
}
import { replayPosition, replayPositionWithSkips, type TradeState, sortLedger } from './store.ts'
import { shanghaiDayStart as shDayStart } from './time.ts'
import { compositionOf } from './composition.ts'

/**
 * ms epoch of 00:00:00 Asia/Shanghai for the trading day containing `now`.
 * 实现统一在 host/time.ts —— 全插件的时间口径只有这一套（Asia/Shanghai）。
 */
export function shanghaiDayStart(now: number): number {
  return shDayStart(now)
}

const round2 = (n: number): number => Math.round(n * 100) / 100
/** 价格/成本保留 4 位小数（ETF、基金等低价标的 0.948 不能被抹成 0.95） */
const round4 = (n: number): number => Math.round(n * 10000) / 10000

interface DayTrade {
  verb: 'buy' | 'sell'
  qty: number
  price: number
  fee: number
}

interface LedgerSlice {
  entries: LedgerEntry[]
  dayTrades: DayTrade[]
  dayFees: number
  /** Accounting state at day start (pre-day entries only). */
  start: TradeState
}

function slicePosition(entries: readonly LedgerEntry[], posId: string, dayStart: number): LedgerSlice {
  const slice: LedgerSlice = { entries: [], dayTrades: [], dayFees: 0, start: { qty: 0, avgCost: 0, netCost: 0, realized: 0, fees: 0, turnover: 0, realizedUnknownQty: 0 } }
  const pre: LedgerEntry[] = []
  for (const e of entries) {
    if (e.posId !== posId) continue
    if (e.verb !== 'buy' && e.verb !== 'sell' && e.verb !== 'adjust') continue
    slice.entries.push(e)
    if (e.ts < dayStart) {
      pre.push(e)
    } else if (e.verb === 'buy' || e.verb === 'sell') {
      if (typeof e.qty === 'number' && typeof e.price === 'number') {
        slice.dayTrades.push({ verb: e.verb, qty: e.qty, price: e.price, fee: typeof e.fee === 'number' ? e.fee : 0 })
        slice.dayFees += typeof e.fee === 'number' ? e.fee : 0
      }
    }
  }
  slice.start = replayPosition(pre, posId)
  return slice
}

/** Exact per-trade day P&L: (now−prevClose)·startQty + Σ buy (now−price) − fees… */
function dayPnlOf(slice: LedgerSlice, now: number | null, prev: number | null): number | null {
  if (now === null) return null
  let total = 0
  const startQty = slice.start.qty
  if (startQty > 1e-9) {
    if (prev === null) return null
    total += startQty * (now - prev)
  }
  for (const t of slice.dayTrades) {
    if (t.verb === 'buy') total += t.qty * (now - t.price) - t.fee
    else total += t.qty * (t.price - now) - t.fee
  }
  return round2(total)
}

/** One position row with live quote fields merged. */
export function derivePosition(
  entries: readonly LedgerEntry[],
  pos: PortItem,
  quote: QuoteRow | undefined,
  dayStart: number,
): PositionRow {
  const { state: total, skipped } = replayPositionWithSkips(entries, pos.id)
  const slice = slicePosition(entries, pos.id, dayStart)
  const price = quote?.price ?? null
  const prev = quote?.prev ?? null
  const mv = price !== null ? round2(price * total.qty) : total.qty > 0 ? null : 0
  /**
   *   - 不能用 `turnover<=0` 表达"从未真的买卖过"：**卖出同样产生成交额**。
   *   - 也不能只看 `avgCost<=0`：手工改过的流水里可能出现 price=0 的买入。
   */
  const costAmountRecorded = hasPricedCostEntry(entries, pos.id)
  const costUnknown = !costAmountRecorded && total.avgCost <= 0 && (total.qty > 1e-9 || total.realizedUnknownQty > 1e-9)
  const floatPnl = costUnknown || price === null ? (total.qty > 0 ? null : 0) : round2((price - total.avgCost) * total.qty)
  const dayPnl = dayPnlOf(slice, price, prev)
 // 可用数量与费用。A股 T+1：今日买入的部分当日不可卖 → 可用 = 持仓 − 今日买入；
  // ETF/LOF/港股/美股 T+0 → 可用 = 持仓。规则由 isT0Secid() 单点判定。
  const t0 = isT0Secid(pos.secid)
  const todayBuyQty = slice.dayTrades.reduce((a, t) => a + (t.verb === 'buy' ? t.qty : 0), 0)
  const availableQty = t0 ? total.qty : Math.max(0, Math.round((total.qty - todayBuyQty) * 1e4) / 1e4)
  const feeShare = total.turnover > 0 ? round2((total.fees / total.turnover) * 100) : null
  // 总收益率（浮动口径）：浮动盈亏 / 摊薄成本×数量
  const floatPnlPct =
    total.qty > 1e-9 && total.avgCost > 0 && price !== null
      ? round2(((price - total.avgCost) / total.avgCost) * 100)
      : null
  // 当日收益率：当日盈亏 / 期初市值（隔夜 qty×昨收 + 当日买入成本）；无法估值时为 null
  let dayPnlPct: number | null = null
  if (dayPnl !== null) {
    let denom = 0
    let computable = true
    if (slice.start.qty > 1e-9) {
      if (prev !== null) denom += slice.start.qty * prev
      else computable = false // 期初持仓但无昨收 → 无法估值
    }
    if (computable) {
      for (const t of slice.dayTrades) {
        if (t.verb === 'buy') denom += t.qty * t.price
      }
      dayPnlPct = denom > 0 ? round2((dayPnl / denom) * 100) : null
    }
  }
  // 摊薄成本（券商口径）：(累计买入含费 − 累计卖出净额) ÷ 剩余数量
  // 成本未录入时不给数：此时 netCost 被卖出收入冲成负数（D1 场景下是 −12.5），
  // 显示出来会让人以为"成本真是负的"，而真相是"成本不知道"。
  const dilutedCost = costUnknown ? null : total.qty > 1e-9 ? round4(total.netCost / total.qty) : null
  const dilutedPnl = costUnknown
    ? (total.qty > 1e-9 ? null : 0)
    : price !== null && dilutedCost !== null ? round2((price - dilutedCost) * total.qty) : total.qty > 1e-9 ? null : 0
  const dilutedPnlPct =
    !costUnknown && price !== null && dilutedCost !== null && Math.abs(dilutedCost) > 1e-9
      ? round2(((price - dilutedCost) / Math.abs(dilutedCost)) * 100)
      : null
  return {
    posId: pos.id,
    groupId: pos.groupId,
    secid: pos.secid,
    name: pos.name,
    note: pos.note,
    qty: total.qty,
    avgCost: round4(total.avgCost),
    dilutedCost,
    // 「已实现」不可算的两种情形（都返回 null → 界面 —，而不是一个看着正常的数）：
    //   1. 整仓成本未录入（costUnknown）：它是 (卖出价 − 0) × 数量；
    //   2. **历史上**有 N 股在成本未知时卖出（realizedUnknownQty，D1b）：那几笔的已实现
    //      没被累加（见 applyTrade），即使后来补录了成本也不能把它算成一个数
    //      —— 除非补录的成本流水 ts 早于那笔卖出（重放时成本已知，自然算对，counter=0）。
    // 给 null 而不是 0：0 会被读成"确实没有已实现盈亏"，那是另一种错信息。
    realized: costUnknown || total.realizedUnknownQty > 0 ? null : round2(total.realized),
    realizedUnknownQty: total.realizedUnknownQty,
    mv,
    floatPnl,
    floatPnlPct,
    dilutedPnl,
    dilutedPnlPct,
    dayPnl,
    dayPnlPct,
    price,
    prev,
    availableQty,
    t0,
    fees: round2(total.fees),
    turnover: round2(total.turnover),
    feeShare,
    costUnknown,
    skippedLedger: skipped.length,
    skippedNotes: skipped.slice(0, 3).map((x) => `[${x.id}] ${x.reason}`),
    pct: quote?.pct ?? null,
    chg: quote?.chg ?? null,
  }
}

/**
 * 是否存在**产生成本**的流水（D1）：买入，或带 `price > 0` 的调整。
 *
 * 这是"成本是否录入过"的唯一判据来源 —— 卖出会产生 `turnover` 但不产生成本，
 * 用它当"从未买卖过"的替身正是 D1 的成因。
 * 买入要求 `price > 0`（正常写入路径已保证）：手工改过的流水里 price=0 的买入
 * 不该被当成"成本已知"，否则又会退回"浮盈 = 全额市值"。
 */
export function hasPricedCostEntry(entries: readonly LedgerEntry[], posId: string): boolean {
  for (const e of entries) {
    if (e.posId !== posId) continue
    if (e.verb === 'buy' && isFiniteNumber(e.price) && e.price > 0) return true
    if (e.verb === 'adjust' && isFiniteNumber(e.price) && e.price > 0) return true
  }
  return false
}

const add = (a: number, b: number | null | undefined): number => (b === null || b === undefined ? a : a + b)

/**
 * 该标的是否 T+0（当日买入当日可卖）。
 *
 * 判定实现在 `shared/model.ts`（只依赖 `marketOf`，两端与账本校验共用同一处）——
 * 宿主侧卖出校验（store.ts）也要用它，放在 portfolio.ts 会让 store ↔ portfolio 形成循环依赖。
 */

export interface PortfolioAssembly {
  view: PortfolioView
  /** Positions without a usable quote (kept so the UI can still show state). */
  stale: number
}
export interface FxOptions {
  mode: FxMode
  rates: FxRates
}

/**
 * 折算到人民币（P1-11）。返回 `rate: null` 表示**无法折算**（该币种没给汇率），
 * 调用方必须据此把它排除在总额外并如实说明 —— 绝不回退成 1:1。
 */
export function toCny(
  value: number | null,
  secid: string,
  fx: FxOptions,
): { value: number | null; currency: FxCurrency | null; rate: number | null } {
  const currency = fxCurrencyOf(marketOf(secid))
  if (currency === null) return { value: null, currency: null, rate: null }
  if (fx.mode !== 'fixed') return { value: null, currency, rate: null }
  const rate = normalizeFxRate(fx.rates[currency])
  if (rate === undefined) return { value: null, currency, rate: null }
  return { value: value === null ? null : value * rate, currency, rate }
}

export function assemblePortfolio(
  groups: readonly PortGroup[],
  items: readonly PortItem[],
  entries: readonly LedgerEntry[],
  quotes: Readonly<Record<string, QuoteRow>>,
  /** 跨市场折算口径（P1-11）。缺省不折算：总额只含 A股 + 逐项说明 */
  fx: FxOptions = { mode: 'none', rates: {} },
): PortfolioAssembly {
  // Ledger replay must be chronological: sort a copy by (ts, id).
  // 与 store 的校验口径共用同一排序（单一来源），避免"校验用插入序、展示用 ts 序"分叉
  const sorted = sortLedger(entries)
  const dayStart = shanghaiDayStart(Date.now())

  const positions: PositionRow[] = []
  for (const p of items) {
    positions.push(derivePosition(sorted, p, quotes[p.secid], dayStart))
  }

  const groupRows = groups.map((g): GroupView & { group: PortGroup } => {
    const rows = positions.filter((p) => p.groupId === g.id)
    let totalMv = 0
    let floatPnl = 0
    let dilutedPnl = 0
    let dayPnl = 0
    let realized = 0
    let valued = 0
    for (const r of rows) {
      if (r.mv === null && r.qty > 0) continue // no quote yet
      // 总额口径（P0-1/P1-11）：A股直接计；非 A股**只有在能折算时**才计。
      // 按 1:1 加进去会让总额"看起来完整、其实错了"—— 错的口径比缺的口径更危险
      // （用户不会去质疑一个看起来正常的数）。折算不了的一律进 unpriced，
      // 且区分"口径未开"（no-fx）与"开了但没有这个币种的汇率"（no-rate）。
      const cn = marketOf(r.secid) === 'cn'
      if (!cn) {
        const fxMv = toCny(r.mv ?? 0, r.secid, fx)
        if (fxMv.value === null) continue
        totalMv = add(totalMv, fxMv.value)
        floatPnl = add(floatPnl, (toCny(r.floatPnl, r.secid, fx).value ?? 0))
        dilutedPnl = add(dilutedPnl, (toCny(r.dilutedPnl ?? 0, r.secid, fx).value ?? 0))
        if (r.dayPnl !== null) dayPnl = add(dayPnl, (toCny(r.dayPnl, r.secid, fx).value ?? 0))
        realized = add(realized, (toCny(r.realized, r.secid, fx).value ?? 0))
        continue
      }
      totalMv = add(totalMv, r.mv ?? 0)
      floatPnl = add(floatPnl, r.floatPnl)
      dilutedPnl = add(dilutedPnl, r.dilutedPnl ?? 0)
      if (r.dayPnl !== null) dayPnl = add(dayPnl, r.dayPnl)
      realized = add(realized, r.realized)
      valued += 1
    }
    return {
      group: g,
      id: g.id,
      name: g.name,
      order: g.order,
      archived: g.archived,
      note: g.note,
      totalMv: round2(totalMv),
      floatPnl: round2(floatPnl),
      dilutedPnl: round2(dilutedPnl),
      dayPnl: round2(dayPnl),
      realized: round2(realized),
      count: rows.length,
    }
  })
  groupRows.sort((a, b) => a.order - b.order)

  let grandMv = 0
  let grandFloat = 0
  let grandDiluted = 0
  let grandDay = 0
  let grandRealized = 0
  for (const g of groupRows) {
    if (g.archived === true) continue
    grandMv += g.totalMv
    grandFloat += g.floatPnl
    grandDiluted += g.dilutedPnl
    grandDay += g.dayPnl
    grandRealized += g.realized
  }

  const view: PortfolioView = {
    generatedAt: Date.now(),
    groups: groupRows.map(({ group: _g, ...rest }) => rest as GroupView),
    positions,
    grand: {
      totalMv: round2(grandMv),
      floatPnl: round2(grandFloat),
      dilutedPnl: round2(grandDiluted),
      dayPnl: round2(grandDay),
      realized: round2(grandRealized),
    },
    // 组合构成（P0-11）：权重/行业·主题/市场分布/集中度。
    // 行业**只**用本地已有数据（分组名）—— 拿不到就是 null（界面 —），绝不按 secid 猜行业。
    composition: ((): NonNullable<PortfolioView['composition']> => {
      const groupName = new Map(groups.map((g) => [g.id, g.name]))
      const inputs = positions
        .filter((p) => p.qty > 0)
        .map((p) => ({
          id: p.posId,
          name: p.name,
          secid: p.secid,
          market: marketOf(p.secid),
          qty: p.qty,
          price: p.price,
          // 本地标签：分组名（用户自己写的主题/行业）；没有分组就没有行业标签
          groupName: p.groupId === undefined ? null : (groupName.get(p.groupId) ?? null),
        }))
      return compositionOf(inputs)
    })(),
  }
  const stale = positions.filter((p) => p.qty > 0 && p.price === null).length
  // P0-1：总额缺一块必须能点开看到缺的是谁、为什么。
  // 两类原因严格分开：① 拿不到价（行情源问题，重试可能恢复）② 非人民币计价且未折算
  //（口径问题，重试一万次也一样）—— 混成一句"N 只无价"会让 agent 去等一个不会来的数据。
  const unpriced: NonNullable<PortfolioView['unpriced']> = []
  let unpricedMv = 0
  for (const p of positions) {
    if (p.qty <= 0) continue
    if (p.price === null) {
      unpriced.push({
        posId: p.posId, secid: p.secid, name: p.name, qty: p.qty, why: 'no-quote',
        note: `行情源未给出可用价格（东财与备用源均未取到），故不计入总额 —— ${MISSING_TIER_ADVICE.transient}`,
      })
      continue
    }
    const m = marketOf(p.secid)
    if (m !== 'cn') {
      const conv = toCny(p.mv ?? 0, p.secid, fx)
      if (conv.value !== null) continue // 已折算并计入总额，不再列为未计入
      const currency = fxCurrencyOf(m)
      unpriced.push({
        posId: p.posId, secid: p.secid, name: p.name, qty: p.qty, why: 'no-fx',
        note: currency === null
          ? `${MARKET_LABEL[m]}标的没有可折算的币种（指数/期货以点位或合约价计价），故不计入总额`
          : fx.mode === 'fixed'
            ? `已开启固定汇率折算，但没有为${FX_CURRENCY_LABEL[currency]}填写汇率，故仍不计入总额（不是按 1:1 加进去）`
            : `${MARKET_LABEL[m]}标的以${FX_CURRENCY_LABEL[currency]}计价，当前 fxMode=${fx.mode} 不做折算，故不计入总额（不是按 1:1 加进去）`,
      })
      unpricedMv = round2(unpricedMv + (p.mv ?? 0))
    }
  }
  view.fxMode = fx.mode
  view.fxRates = fx.mode === 'fixed' ? normalizeFxRates(fx.rates) : {}
  view.unpriced = unpriced
  view.unpricedMv = round2(unpricedMv)
  return { view, stale }
}
// 动词文案与客户端共用一份（见 shared/model.ts 的 LEDGER_VERB_LABEL）
const VERB_LABEL: Record<LedgerEntry['verb'], string> = LEDGER_VERB_LABEL

export function verbLabel(verb: LedgerEntry['verb']): string {
  return VERB_LABEL[verb] ?? verb
}

/**
 * 过滤后的流水**总数**（`ledgerViews` 会按 limit 截断，这里是"本来有多少条"）。
 *
 * 为什么单列：回包要能说"共 N 条、本次返回 M 条"（其它工具都有 truncated，账本此前没有 ⇒ 静默截断）。
 * 过滤条件必须与 `ledgerViews` **逐字一致**，否则"总数"与"返回数"会互相矛盾。
 */
export function ledgerTotal(
  entries: readonly LedgerEntry[],
  opts: { groupId?: string; posId?: string } = {},
): number {
  return entries.filter((e) => (opts.groupId === undefined || e.groupId === opts.groupId) &&
    (opts.posId === undefined || e.posId === opts.posId)).length
}

/** Human-readable ledger views, newest first. */
export function ledgerViews(
  entries: readonly LedgerEntry[],
  groups: readonly PortGroup[],
  items: readonly PortItem[],
  opts: { limit?: number; groupId?: string; posId?: string } = {},
): LedgerView[] {
  const groupName = new Map(groups.map((g) => [g.id, g.name]))
  const itemName = new Map(items.map((p) => [p.id, p.name]))
  const filtered = entries
    .filter((e) => (opts.groupId === undefined || e.groupId === opts.groupId) &&
      (opts.posId === undefined || e.posId === opts.posId))
    .slice()
    .sort((a, b) => b.ts - a.ts || (a.id < b.id ? 1 : -1))
  const limit = opts.limit === undefined ? 200 : Math.min(Math.max(1, opts.limit), 1000)
  return filtered.slice(0, limit).map((e) => ({
    id: e.id,
    ts: e.ts,
    verb: e.verb,
    actor: e.actor,
    groupName: e.groupId !== undefined ? groupName.get(e.groupId) ?? null : null,
    posName: e.posId !== undefined ? itemName.get(e.posId) ?? e.name ?? null : null,
    qty: e.qty,
    price: e.price,
    fee: e.fee,
    note: e.note,
  }))
}
