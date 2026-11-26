/**
 * 自动做T 的确定性门槛（单一事实源）。
 *
 * 设计原则：
 * - 只做「可执行性」判断，不做方向/选股判断；
 * - 每个拒绝只有一个原因码 + 可读明细，UI 直接展示；
 * - 门槛常量只在这里定义，提示词/测试/回测共用。
 */
import type { FactorMetrics } from './prismFactors.ts'

export const AUTO_T_RULES = {
  /** 版本号：改任何常量必须递增 */
  version: 't-gate-v2',
  /** 价差下限（%） */
  minSpreadPct: 1.2,
  /** ATR 绝对下限（%） */
  minAtrPct: 1.0,
  /** ATR 自身 120 日分位下限（0–100） */
  minAtrRank: 40,
  /** 日均振幅下限（%） */
  minAmpPct: 1.2,
  /** 一跳占比上限（%）：超过说明价差会被 tick 吃掉 */
  maxTickPct: 0.5,
  /** 扣费后净额下限（元） */
  minNetYuan: 20,
  /** 扣费后净额下限（占买入额 %） */
  minNetPct: 0.3,
  /** 单只做T 股数上限（底仓 %） */
  maxPositionPct: 20,
  /** 整手 */
  lot: 100,
  /** 最后开仓时间（HH:MM） */
  lastOpen: '14:30',
  /** 全部平腿截止 */
  deadline: '14:50',
} as const

export type AutoTGateCode =
  | 'data-missing'
  | 'bar-stale'
  | 'quote-stale'
  | 'lkg-quote'
  | 'atr-low'
  | 'atr-rank-low'
  | 'amp-low'
  | 'tick-high'
  | 'spread-low'
  | 'net-low'
  | 'cash-low'
  | 'available-low'
  | 'pending-conflict'
  | 'position-cap'
  | 'time-window'
  | 'limit-locked'

export interface AutoTGateInput {
  metrics: FactorMetrics | null
  /** 买价/卖价（正T 先买，反T 先卖；两腿都传） */
  buyPrice: number
  sellPrice: number
  shares: number
  direction: 'buy-first' | 'sell-first'
  /** 账户侧 */
  cash: number
  available: number
  positionQty: number
  /** 已有未成交 T 腿（同标的） */
  pendingShares?: number
  /** 报价状态 */
  quoteStale?: boolean
  quoteFromLkg?: boolean
  /** 14:30 之后不再开新仓（HHMM 数字，如 1431） */
  nowHHMM?: number
  /** 涨跌停锁死（买不进/卖不出） */
  limitLocked?: boolean
}

export interface AutoTGateResult {
  ok: boolean
  code: AutoTGateCode | null
  detail: string
  /** 扣费后净额（元），用于展示 */
  netYuan: number | null
  /** 价差（%） */
  spreadPct: number | null
}

const hhmm = (s: string): number => Number(s.replace(':', ''))

/** 估算双边费用：佣金万3最低5 + 卖出印花千1（ETF 免）+ 过户万0.1 */
export function feeRoundTripOf(buyPrice: number, sellPrice: number, shares: number, isEtf: boolean): number {
  const commission = (amount: number): number => Math.max(5, amount * 0.0003)
  const buyAmount = buyPrice * shares
  const sellAmount = sellPrice * shares
  const stamp = isEtf ? 0 : sellAmount * 0.001
  const transfer = (buyAmount + sellAmount) * 0.00001
  return Math.round((commission(buyAmount) + commission(sellAmount) + stamp + transfer) * 100) / 100
}

export function evaluateAutoT(input: AutoTGateInput): AutoTGateResult {
  const { metrics } = input
  const fail = (code: AutoTGateCode, detail: string, extra: Partial<AutoTGateResult> = {}): AutoTGateResult => ({ ok: false, code, detail, netYuan: null, spreadPct: null, ...extra })

  if (metrics === null || metrics.bars < 21) return fail('data-missing', `日K 不足 21 根（实际 ${metrics?.bars ?? 0} 根）`)
  if (input.quoteFromLkg === true) return fail('lkg-quote', '报价来自 last-known-good，不能用于下单')
  if (input.quoteStale === true) return fail('quote-stale', '报价超龄')
  if (input.limitLocked === true) return fail('limit-locked', '涨跌停锁死，T 腿无法成交')

  const spreadPct = input.buyPrice > 0 ? (input.sellPrice / input.buyPrice - 1) * 100 : null
  const gross = (input.sellPrice - input.buyPrice) * input.shares
  const isEtf = false
  const fees = feeRoundTripOf(input.buyPrice, input.sellPrice, input.shares, isEtf)
  const netYuan = Math.round((gross - fees) * 100) / 100
  const extra = { netYuan, spreadPct }

  if (metrics.atrPct === null) return fail('data-missing', 'ATR14 不可算（日K不足15根）', extra)
  if (metrics.atrPct < AUTO_T_RULES.minAtrPct) return fail('atr-low', `ATR14 ${metrics.atrPct.toFixed(2)}% < ${AUTO_T_RULES.minAtrPct}%`, extra)
  if (metrics.atrRank120 === null) return fail('data-missing', 'ATR 分位不可算（历史不足）', extra)
  if (metrics.atrRank120 < AUTO_T_RULES.minAtrRank) return fail('atr-rank-low', `ATR分位 ${metrics.atrRank120} < ${AUTO_T_RULES.minAtrRank}`, extra)
  if (metrics.amp20Pct === null) return fail('data-missing', '日均振幅不可算（日K不足21根）', extra)
  if (metrics.amp20Pct < AUTO_T_RULES.minAmpPct) return fail('amp-low', `日均振幅 ${metrics.amp20Pct.toFixed(2)}% < ${AUTO_T_RULES.minAmpPct}%`, extra)
  if (metrics.tickPct !== null && metrics.tickPct > AUTO_T_RULES.maxTickPct) return fail('tick-high', `一跳 ${metrics.tickPct.toFixed(2)}% > ${AUTO_T_RULES.maxTickPct}%`, extra)
  const lot = AUTO_T_RULES.lot
  if (input.shares % lot !== 0 || input.shares <= 0) return fail('position-cap', `股数 ${input.shares} 不是 ${lot} 的整数倍`, extra)
  const cap = Math.floor((input.positionQty * AUTO_T_RULES.maxPositionPct) / 100 / lot) * lot
  if (input.shares > cap) return fail('position-cap', `股数 ${input.shares} > 底仓 ${AUTO_T_RULES.maxPositionPct}%（${cap} 股）`, extra)
  if (spreadPct === null || spreadPct < AUTO_T_RULES.minSpreadPct) return fail('spread-low', `价差 ${spreadPct?.toFixed(2) ?? '—'}% < ${AUTO_T_RULES.minSpreadPct}%`, extra)
  if (netYuan < AUTO_T_RULES.minNetYuan) return fail('net-low', `扣费后净额 ${netYuan.toFixed(2)} 元 < ${AUTO_T_RULES.minNetYuan} 元`, extra)
  if (netYuan < input.buyPrice * input.shares * (AUTO_T_RULES.minNetPct / 100)) return fail('net-low', `扣费后净额 ${netYuan.toFixed(2)} 元 < 买入额 ${AUTO_T_RULES.minNetPct}%`, extra)

  if (input.available < input.shares) return fail('available-low', `可卖 ${input.available} < ${input.shares} 股`, extra)
  if (input.direction === 'buy-first' && input.cash < input.buyPrice * input.shares + fees) return fail('cash-low', `现金 ${input.cash.toFixed(2)} 不足买入 ${(input.buyPrice * input.shares).toFixed(2)} + 费用`, extra)
  if ((input.pendingShares ?? 0) > 0) return fail('pending-conflict', `同标的已有未成交 T 腿 ${input.pendingShares} 股`, extra)
  if (input.nowHHMM !== undefined && input.nowHHMM > hhmm(AUTO_T_RULES.lastOpen)) return fail('time-window', `已过 ${AUTO_T_RULES.lastOpen}，不再开新 T`, extra)

  return { ok: true, code: null, detail: '条件满足', ...extra }
}
