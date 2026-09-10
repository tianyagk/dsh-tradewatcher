/**
 * Portfolio view assembly: replay the append-only ledger into per-position
 * accounting, merge live quotes, and produce group/grand summaries.
 * Pure functions — no IO — so they are directly unit-testable.
 */
import type {
  GroupView,
  LedgerEntry,
  LedgerView,
  PortGroup,
  PortItem,
  PortfolioView,
  PositionRow,
  QuoteRow,
} from '../shared/model.ts'
import { replayPosition, type TradeState } from './store.ts'

/** ms epoch of 00:00:00 Asia/Shanghai for the trading day containing `now`. */
export function shanghaiDayStart(now: number): number {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  })
  const [y, m, d] = fmt.format(now).split('-').map(Number)
  // Shanghai is UTC+8 year-round (no DST).
  return Date.UTC(y, m - 1, d) - 8 * 3600_000
}

const round2 = (n: number): number => Math.round(n * 100) / 100

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
  const slice: LedgerSlice = { entries: [], dayTrades: [], dayFees: 0, start: { qty: 0, avgCost: 0, realized: 0, fees: 0 } }
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
  const total = replayPosition(entries, pos.id)
  const slice = slicePosition(entries, pos.id, dayStart)
  const price = quote?.price ?? null
  const prev = quote?.prev ?? null
  const mv = price !== null ? round2(price * total.qty) : total.qty > 0 ? null : 0
  const floatPnl = price !== null ? round2((price - total.avgCost) * total.qty) : total.qty > 0 ? null : 0
  const dayPnl = dayPnlOf(slice, price, prev)
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
  return {
    posId: pos.id,
    groupId: pos.groupId,
    secid: pos.secid,
    name: pos.name,
    note: pos.note,
    qty: total.qty,
    avgCost: round2(total.avgCost),
    realized: round2(total.realized),
    mv,
    floatPnl,
    floatPnlPct,
    dayPnl,
    dayPnlPct,
    price,
    prev,
    pct: quote?.pct ?? null,
    chg: quote?.chg ?? null,
  }
}

const add = (a: number, b: number | null | undefined): number => (b === null || b === undefined ? a : a + b)

export interface PortfolioAssembly {
  view: PortfolioView
  /** Positions without a usable quote (kept so the UI can still show state). */
  stale: number
}

export function assemblePortfolio(
  groups: readonly PortGroup[],
  items: readonly PortItem[],
  entries: readonly LedgerEntry[],
  quotes: Readonly<Record<string, QuoteRow>>,
): PortfolioAssembly {
  // Ledger replay must be chronological: sort a copy by (ts, id).
  const sorted = [...entries].sort((a, b) => (a.ts - b.ts) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  const dayStart = shanghaiDayStart(Date.now())

  const positions: PositionRow[] = []
  for (const p of items) {
    positions.push(derivePosition(sorted, p, quotes[p.secid], dayStart))
  }

  const groupRows = groups.map((g): GroupView & { group: PortGroup } => {
    const rows = positions.filter((p) => p.groupId === g.id)
    let totalMv = 0
    let floatPnl = 0
    let dayPnl = 0
    let realized = 0
    let valued = 0
    for (const r of rows) {
      if (r.mv === null && r.qty > 0) continue // no quote yet
      totalMv = add(totalMv, r.mv ?? 0)
      floatPnl = add(floatPnl, r.floatPnl)
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
      dayPnl: round2(dayPnl),
      realized: round2(realized),
      count: rows.length,
    }
  })
  groupRows.sort((a, b) => a.order - b.order)

  let grandMv = 0
  let grandFloat = 0
  let grandDay = 0
  let grandRealized = 0
  for (const g of groupRows) {
    if (g.archived === true) continue
    grandMv += g.totalMv
    grandFloat += g.floatPnl
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
      dayPnl: round2(grandDay),
      realized: round2(grandRealized),
    },
  }
  const stale = positions.filter((p) => p.qty > 0 && p.price === null).length
  return { view, stale }
}
const VERB_LABEL: Record<LedgerEntry['verb'], string> = {
  buy: '买入',
  sell: '卖出',
  adjust: '调整',
  add: '新建持仓',
  remove: '移除持仓',
  gcreate: '新建分组',
  grename: '分组改名',
  gdelete: '归档分组',
  grestore: '还原分组',
  gmove: '移动/编辑',
  pnote: '备注',
}

export function verbLabel(verb: LedgerEntry['verb']): string {
  return VERB_LABEL[verb] ?? verb
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
