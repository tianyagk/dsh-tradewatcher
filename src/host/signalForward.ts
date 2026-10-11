/**
 * 信号的前瞻表现（P1-1/P1-2）：过去 N 次信号之后发生了什么（纯函数）。
 *
 * 红线（口径纪律，写在回包与工具描述里，不只是注释）：
 *  ① 必须同时给基准与持有期 —— 报告的反面教材是"有表无基准"：一张只有"至今涨跌幅"的表
 *     回答不了"这段时间大盘也涨了 20%"这件事；
 *  ② 样本 < 10 照旧输出，但显式标注"样本过少，不构成统计结论"（不给显著性、不做外推）；
 *  ③ 不许把它表述成"信号有预测能力" —— 只能说"过去 N 次信号之后发生了什么"；
 *  ④ 基准缺失 ⇒ `—`（`null`），不当 0；信号日就是最新数据日 ⇒ 持有期 0、涨跌幅 `—`。
 */
import type { DailyBarLite } from '../shared/model.ts'

export interface SignalEvent {
  /**信号日 `YYYY-MM-DD` */
  day: string
  /**等级（0–3）与词 */
  level: number
  label: string
  /**触发时的关键指标摘要（如「量能 2.4x · 超大单 +12.3亿」） */
  indicators: string
}

export interface ForwardRow {
  day: string
  level: number
  label: string
  indicators: string
  /**信号日之后到最新数据日的涨跌幅（%）；持有期 0 或数据缺失 ⇒ null */
  retPct: number | null
  /**同期基准涨跌幅（%）；基准缺失 ⇒ null（不是 0） */
  benchPct: number | null
  /**超额 = 标的 − 基准；任一侧缺失 ⇒ null */
  excess: number | null
  /**持有期（自然日） */
  holdDays: number
  /**持有期（交易日 = 区间内新产生的 bar 数） */
  holdTradingDays: number
  /**最新数据日（标的序列的最后一根） */
  lastDay: string | null
  why: string | null
}

export interface ForwardSummary {
  n: number
  /**胜率（超额为正的占比，%）；无可算样本 ⇒ null */
  winRate: number | null
  avgExcess: number | null
  medianExcess: number | null
  /**样本过少等提示；无提示时 null */
  note: string | null
}

export interface ForwardResult {
  rows: ForwardRow[]
  summary: ForwardSummary
  methodology: string
  /**「不能用来干什么」——工具与界面直接引用，不许改写成"预测能力" */
  disclaimer: string
}

/**样本数下限：低于它照旧出数，但必须带"样本过少"标注 */
export const FORWARD_MIN_SAMPLES = 10

const dayMs = 86_400_000
const parseDay = (s: string): number => Date.parse(`${s}T00:00:00+08:00`)

/**该日期（含）之后的第一根 bar —— 信号日可能不是交易日 */
function atOrAfter(bars: readonly DailyBarLite[], day: string): DailyBarLite | null {
  for (const b of bars) if (b.date >= day) return b
  return null
}

const pct = (from: number, to: number): number | null => (from > 0 ? (to / from - 1) * 100 : null)

/**
 * 主入口。`events` 来自护盘历史（当日最大等级 ≥1 的日子），`bars` 是标的日线，`benchBars` 是基准日线。
 * 两者都用收盘价（`DailyBarLite.close`），不引入复权假设（指数/ETF 无复权概念）。
 */
export function forwardOf(
  events: readonly SignalEvent[],
  bars: readonly DailyBarLite[],
  benchBars: readonly DailyBarLite[],
  benchName: string,
): ForwardResult {
  const last = bars[bars.length - 1] ?? null
  const lastDay = last?.date ?? null
  const rows: ForwardRow[] = events.map((ev) => {
    const base = { day: ev.day, level: ev.level, label: ev.label, indicators: ev.indicators, lastDay }
    if (lastDay === null) {
      return { ...base, retPct: null, benchPct: null, excess: null, holdDays: 0, holdTradingDays: 0, why: '标的还没有日线，无法看信号后表现' }
    }
    const start = atOrAfter(bars, ev.day)
    const startBench = atOrAfter(benchBars, ev.day)
    const holdDays = Math.max(0, Math.round((parseDay(lastDay) - parseDay(ev.day)) / dayMs))
    const tradingDays = start === null ? 0 : bars.filter((b) => b.date > start.date && b.date <= lastDay).length
    if (start === null || start.date >= lastDay) {
      return { ...base, retPct: null, benchPct: null, excess: null, holdDays: 0, holdTradingDays: 0, why: '信号日就是最新数据日（持有期 0），涨跌幅 —' }
    }
    const ret = pct(start.close, last.close)
    // 基准用同一段持有期（起点同样取信号日之后的第一根）；取不到基准的终点 ⇒ null（不当 0）
    const benchEnd = atOrAfter(benchBars, lastDay)
    const benchPct = startBench !== null && benchEnd !== null ? pct(startBench.close, benchEnd.close) : null
    const excess = ret !== null && benchPct !== null ? ret - benchPct : null
    return {
      ...base,
      retPct: ret,
      benchPct,
      excess,
      holdDays,
      holdTradingDays: tradingDays,
      why: benchPct === null ? `基准（${benchName}）日线未取到，超额不可算` : null,
    }
  })
  const excesses = rows.map((r) => r.excess).filter((x): x is number => x !== null).sort((a, b) => a - b)
  const n = excesses.length
  const median = n === 0 ? null : n % 2 === 1 ? excesses[(n - 1) / 2] : (excesses[n / 2 - 1] + excesses[n / 2]) / 2
  const summary: ForwardSummary = {
    n,
    winRate: n === 0 ? null : (excesses.filter((x) => x > 0).length / n) * 100,
    avgExcess: n === 0 ? null : excesses.reduce((a, b) => a + b, 0) / n,
    medianExcess: median,
    note: n < FORWARD_MIN_SAMPLES ? `样本过少（${n} < ${FORWARD_MIN_SAMPLES}），不构成统计结论` : null,
  }
  return {
    rows,
    summary,
    methodology:
      `每个事件：从信号日（含当天）到最新数据日的收盘涨跌幅，减同期基准 ${benchName} 的涨跌幅；` +
      `持有期同时给自然日与交易日；样本数 = 可算出超额的次数（基准缺失或持有期为 0 的不计入，但仍在逐行里列出）。`,
    disclaimer:
      '怎么读：这是"过去 N 次信号之后发生了什么"的回顾，不是"信号有预测能力"。' +
      '不能用来干什么：不能当作买卖信号、不能外推将来、不能证明因果（护盘行为本身不披露，识别的是量价模式）；' +
      '样本过少时连描述性结论都不要下。',
  }
}
