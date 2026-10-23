/**
 * P-02 / P-03 / P-20：非重叠评估、超额/回撤/命中率、回撤闸门。
 * 只用已有净值点与 fills；不新增数据源。缺样本/缺基准一律 null + 原因，不写 0。
 */
import type {
  PrismDecision,
  PrismDrawdownGate,
  PrismEquityPoint,
  PrismEvaluation,
  PrismEvalExcess,
} from '../shared/prism.ts'

/** 评估口径的样本下限（独立窗口数） */
export const EVAL_MIN_SAMPLE = 30
/** 评估脚注固定文案（P-02；结果里回传） */
export const EVAL_FOOTNOTE = '非重叠样本 · 不含 embargo 区间'
/** embargo 常量（P-02；先固定，参数化不在本批） */
export const EMBARGO_DAYS = 1

export interface EvalWindow {
  start: number
  end: number
}

/** 起点间隔 ≥ 持有期（非重叠）；不以“事件条数”当样本数。 */
export function nonOverlappingWindowsOf(pointCount: number, holdingDays = 1): EvalWindow[] {
  const hold = Math.max(1, Math.floor(holdingDays))
  const out: EvalWindow[] = []
  for (let start = 0; start + hold < pointCount; start += hold) out.push({ start, end: start + hold })
  return out
}

const avg = (xs: readonly number[]): number | null => xs.length === 0 ? null : xs.reduce((a, b) => a + b, 0) / xs.length
const round = (n: number): number => Math.round(n * 100) / 100

const reasonOf = (n: number, min: number): string | null => n < min ? `样本不足 n=${n} < ${min}` : null

export function evaluationOf(
  points: readonly PrismEquityPoint[],
  feesByDay: Readonly<Record<string, number>> = {},
  holdingDays = 1,
  minSample = EVAL_MIN_SAMPLE,
): PrismEvaluation {
  const valid = points.filter((p) => typeof p.capital === 'number')
  if (valid.length < 2) {
    const reason = '有效资本调整后净值点不足 2 个'
    return {
      excess: { withFee: null, withoutFee: null, reason, n: 0 },
      drawdown: { value: null, reason, n: 0 },
      hitRate: { value: null, reason, n: 0 },
      n: 0, embargoDays: EMBARGO_DAYS, footnote: EVAL_FOOTNOTE, curve: [], reason,
    }
  }
  const windows = nonOverlappingWindowsOf(valid.length, holdingDays)
  const n = windows.length
  const short = reasonOf(n, minSample)
  const withFee: number[] = []
  const withoutFee: number[] = []
  const curve: number[] = []
  let cumulative = 0
  let benchmarkMissing = false
  for (const w of windows) {
    const a = valid[w.start]
    const b = valid[w.end]
    if (a === undefined || b === undefined) continue
    const base = a.equity - (a.capital as number)
    const end = b.equity - (b.capital as number)
    if (!(base > 0)) continue
    const port = (end / base - 1) * 100
    const fee = Object.entries(feesByDay)
      .filter(([day]) => day > a.day && day <= b.day)
      .reduce((sum, [, v]) => sum + v, 0)
    const noFee = port + (fee / base) * 100
    if (typeof a.benchmarkClose !== 'number' || typeof b.benchmarkClose !== 'number' || !(a.benchmarkClose > 0)) {
      benchmarkMissing = true
      continue
    }
    const bench = (b.benchmarkClose / a.benchmarkClose - 1) * 100
    const ex = port - bench
    withFee.push(ex)
    withoutFee.push(noFee - bench)
    cumulative += ex
    curve.push(round(cumulative))
  }
  const nUsed = withFee.length
  const sampleShort = reasonOf(nUsed, minSample) ?? short
  let excess: PrismEvalExcess
  if (benchmarkMissing && nUsed === 0) {
    excess = { withFee: null, withoutFee: null, reason: '基准 1.000300 收盘缺失', n: nUsed }
  } else if (sampleShort !== null) {
    excess = { withFee: null, withoutFee: null, reason: sampleShort, n: nUsed }
  } else {
    excess = { withFee: round(avg(withFee) as number), withoutFee: round(avg(withoutFee) as number), reason: null, n: nUsed }
  }
  const adjusted = valid.map((p) => p.equity - (p.capital as number))
  let peak = adjusted[0] as number
  let dd = 0
  for (const v of adjusted) {
    peak = Math.max(peak, v)
    if (peak > 0) dd = Math.min(dd, (v / peak - 1) * 100)
  }
  const ddReason = sampleShort
  const hitReason = sampleShort ?? (benchmarkMissing ? '基准 1.000300 收盘缺失' : null)
  const hits = withFee.filter((x) => x > 0).length
  return {
    excess,
    drawdown: { value: ddReason === null ? round(dd) : null, reason: ddReason, n: nUsed },
    hitRate: { value: hitReason === null && nUsed > 0 ? round((hits / nUsed) * 100) : null, reason: hitReason, n: nUsed },
    n: nUsed, embargoDays: EMBARGO_DAYS, footnote: EVAL_FOOTNOTE, curve,
    reason: excess.reason,
  }
}

/** P-20：资本调整后序列的自高点回撤/单日跌幅；只决定拒买/提示，不发起卖出 */
export function drawdownGateOf(
  points: readonly PrismEquityPoint[],
  previous?: PrismDrawdownGate | null,
  at = Date.now(),
): PrismDrawdownGate {
  const valid = points.filter((p) => typeof p.capital === 'number')
  if (valid.length < 2) {
    return {
      dailyPct: null, cumulativePct: null, peak: null, triggered: false,
      dailyTriggered: false, cumulativeTriggered: false, targetTotalPct: 100,
      cashMinPct: 0, freezeRound: false, status: '正常', n: valid.length,
      reason: '资本调整后净值点不足 2 个，无法计算回撤', at,
    }
  }
  const values = valid.map((p) => p.equity - (p.capital as number))
  const last = values[values.length - 1] as number
  const prev = values[values.length - 2] as number
  const dailyPct = prev > 0 ? (last / prev - 1) * 100 : null
  const peak = Math.max(...values)
  const cumulativePct = peak > 0 ? (last / peak - 1) * 100 : null
  // 先按展示精度取整再比较阈值，避免 -9.999999999999998 逃过 -10
  const dailyTriggered = dailyPct !== null && round(dailyPct) <= -3
  const cumulativeTriggered = cumulativePct !== null && round(cumulativePct) <= -10
  const triggered = dailyTriggered || cumulativeTriggered
  const freezeRound = triggered && previous?.triggered === true && previous.freezeRound !== true
  return {
    dailyPct: dailyPct === null ? null : round(dailyPct),
    cumulativePct: cumulativePct === null ? null : round(cumulativePct),
    peak: round(peak), triggered, dailyTriggered, cumulativeTriggered,
    targetTotalPct: cumulativeTriggered ? 40 : dailyTriggered ? 60 : 100,
    cashMinPct: cumulativeTriggered ? 25 : 0,
    freezeRound, status: triggered ? '已拒新买单' : '正常',
    n: valid.length, reason: null, at,
  }
}

/** 只过滤买单；卖单原样保留。绝不新建/自动卖出。 */
export function applyDrawdownGate(decision: PrismDecision, gate: PrismDrawdownGate): PrismDecision {
  if (!gate.triggered) return decision
  const buys = decision.orders.filter((o) => o.side === 'buy')
  const orders = decision.orders.filter((o) => o.side === 'sell')
  const rejects = [
    ...decision.rejects,
    ...buys.map((o) => ({ secid: o.secid, side: 'buy' as const, price: o.price, shares: o.shares, reason: `回撤闸门：${gate.freezeRound ? '连续两次触发，冻结新开仓一轮' : '触发，拒新买单'}` })),
  ]
  return { ...decision, orders, rejects }
}
