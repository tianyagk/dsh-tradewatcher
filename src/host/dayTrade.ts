/**
 * 做T / 日内往返配对（P1-3）：从流水里配出同日的买↔卖往返（纯函数）。
 *
 * 三条纪律（都来自评测报告的反面教材）：
 *  ① 保留时序方向：先买后卖与先卖后买都算一次往返，方向如实标（报告里 Arkvol 把"先卖后买"渲染成"买入→卖出"）；
 *  ② 按次数统计（不是按天数）：同日两轮 + 次日一轮 = 3 次；
 *  ③ 配不上的部分（只买未卖、数量对不齐）如实列进 `unmatched`，不许硬凑成一次往返。
 *
 * 费用：按配对数量按比例分摊买卖两边的 `fee`，`净盈亏 = 毛盈亏 − 分摊费用`。
 */
import type { LedgerEntry } from '../shared/model.ts'

export interface DayTradeRound {
  day: string
  /**时序方向：`buy-first` 先买后卖（正 T）／`sell-first` 先卖后买（反 T） */
  direction: 'buy-first' | 'sell-first'
  posId: string
  qty: number
  buyPrice: number
  sellPrice: number
  /**毛盈亏（元）＝(卖价 − 买价) × 数量；正为赚 */
  grossPnl: number
  /**分摊到这笔的费用（元） */
  feeShare: number
  /**净盈亏（元）＝毛 − 费用 */
  netPnl: number
  buyId: string
  sellId: string
}

export interface DayTradeUnmatched {
  day: string
  posId: string
  id: string
  verb: string
  qty: number
  price: number | null
  note: string
}

export interface DayTradeResult {
  rounds: DayTradeRound[]
  unmatched: DayTradeUnmatched[]
  summary: {
    /**往返次数（同日两轮计 2） */
    count: number
    /**胜率（净盈亏 > 0 的次数占比，%）；0 次 ⇒ null */
    winRate: number | null
    netPnl: number
    avgNet: number | null
    days: number
  }
  methodology: string
}

const round2 = (n: number): number => Math.round(n * 100) / 100

/**
 * 主入口。`entries` 需要含 `ts/verb/qty/price/fee/posId`；只配对同一持仓、同一天的买入与卖出。
 * 同日多笔按时间顺序 FIFO 配对；一笔被拆成多段时，各段分别计一次往返（这正是"按次数"的含义）。
 */
export function dayTradesOf(entries: readonly LedgerEntry[]): DayTradeResult {
  const isTrade = (e: LedgerEntry): boolean => (e.verb === 'buy' || e.verb === 'sell') && typeof e.qty === 'number' && e.qty > 0
  const trades = entries.filter(isTrade).slice().sort((a, b) => a.ts - b.ts || (a.id < b.id ? -1 : 1))
  const byDay = new Map<string, LedgerEntry[]>()
  for (const e of trades) {
    const day = new Date(e.ts).toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' })
    const key = `${e.posId}|${day}`
    const list = byDay.get(key) ?? []
    list.push(e)
    byDay.set(key, list)
  }
  const rounds: DayTradeRound[] = []
  const unmatched: DayTradeUnmatched[] = []
  for (const [key, list] of [...byDay.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    const [posId, day] = key.split('|')
    type Open = { e: LedgerEntry; left: number; feeLeft: number }
    const buys: Open[] = []
    const sells: Open[] = []
    const pushUnmatched = (e: LedgerEntry, left: number, why: string): void => {
      unmatched.push({ day, posId, id: e.id, verb: e.verb, qty: left, price: e.price ?? null, note: why })
    }
    for (const e of list) {
      let left = e.qty as number
      const feeTotal = typeof e.fee === 'number' ? e.fee : 0
      if (e.verb === 'buy') {
        // 先与已有的卖出配对（先卖后买）
        while (left > 0 && sells.length > 0) {
          const s = sells[0]
          const take = Math.min(left, s.left)
          const buyFee = (feeTotal * take) / (e.qty as number)
          const sellFee = (s.e.fee ?? 0) * (take / (s.e.qty as number))
          rounds.push(mkRound(day, 'sell-first', posId, take, e.price ?? 0, s.e.price ?? 0, e.id, s.e.id, buyFee + sellFee))
          left -= take
          s.left -= take
          s.feeLeft -= sellFee
          if (s.left <= 0) sells.shift()
        }
        if (left > 0) buys.push({ e, left, feeLeft: (feeTotal * left) / (e.qty as number) })
      } else {
        while (left > 0 && buys.length > 0) {
          const b = buys[0]
          const take = Math.min(left, b.left)
          const buyFee = (b.e.fee ?? 0) * (take / (b.e.qty as number))
          const sellFee = (feeTotal * take) / (e.qty as number)
          rounds.push(mkRound(day, 'buy-first', posId, take, b.e.price ?? 0, e.price ?? 0, b.e.id, e.id, buyFee + sellFee))
          left -= take
          b.left -= take
          if (b.left <= 0) buys.shift()
        }
        if (left > 0) sells.push({ e, left, feeLeft: (feeTotal * left) / (e.qty as number) })
      }
    }
    for (const b of buys) pushUnmatched(b.e, b.left, '当日只有买入没有对应卖出（未配对）')
    for (const s of sells) pushUnmatched(s.e, s.left, '当日只有卖出没有对应买入（未配对）')
  }
  const net = rounds.reduce((n, r) => n + r.netPnl, 0)
  const wins = rounds.filter((r) => r.netPnl > 0).length
  const days = new Set(rounds.map((r) => r.day)).size
  return {
    rounds,
    unmatched,
    summary: {
      count: rounds.length,
      winRate: rounds.length === 0 ? null : (wins / rounds.length) * 100,
      netPnl: round2(net),
      avgNet: rounds.length === 0 ? null : round2(net / rounds.length),
      days,
    },
    methodology:
      '同日往返配对：同一持仓、同一交易日的买入与卖出按时间 FIFO 配对，按次数统计（同日两轮计 2 次）；' +
      '方向保留时序（buy-first 先买后卖＝正 T，sell-first 先卖后买＝反 T）；费用按配对数量比例分摊；' +
      '净盈亏 = (卖价 − 买价) × 数量 − 分摊费用；配不上的部分列在 unmatched，不硬凑。',
  }
}

function mkRound(
  day: string, direction: DayTradeRound['direction'], posId: string, qty: number,
  buyPrice: number, sellPrice: number, buyId: string, sellId: string, feeShare: number,
): DayTradeRound {
  const gross = (sellPrice - buyPrice) * qty
  return {
    day,
    direction,
    posId,
    qty,
    buyPrice,
    sellPrice,
    grossPnl: round2(gross),
    feeShare: round2(feeShare),
    netPnl: round2(gross - feeShare),
    buyId,
    sellId,
  }
}
