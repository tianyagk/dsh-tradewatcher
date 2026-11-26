/**
 * 错价订正（人工）：把一笔已成交委托的成交价改成真实价，并同步账户现金与持仓成本。
 *
 * 事故形态（2026-11-20）：511130 买入成交价 121.825，而该标的当日区间 110.93–111.50，
 * 价格实际取自另一只 ETF（511090）。此类错误只能用人工订正，不能让引擎自己猜。
 *
 * 口径：
 *   · 只改「已成交」委托；未成交/已撤单不适用；
 *   · 每笔 fill 的 amount 与 fee 按新价重算（佣金万 3 最低 5 + 过户费万 0.1；卖出另有印花税千 1）；
 *   · 现金差额 = Σ(旧 amount + 旧 fee) − Σ(新 amount + 新 fee)（买入多付 ⇒ 退回；卖出少收 ⇒ 补回用负号）；
 *   · 持仓 netCost 同步扣减同一差额，cost = netCost / qty；
 *   · 订正留痕写进 order.corrections 与返回的 note，不静默。
 */
import type { PrismAccount, PrismFill, PrismOrder } from '../shared/prism.ts'

const money = (n: number): number => Math.round(n * 100) / 100
const COMMISSION_RATE = 0.0003
const COMMISSION_MIN = 5
const STAMP_RATE = 0.001
const TRANSFER_RATE = 0.00001

export interface PriceCorrectionInput {
  orderId: string
  newPrice: number
  basis: string
}

export interface PriceCorrectionResult {
  account: PrismAccount
  orders: PrismOrder[]
  fills: PrismFill[]
  oldPrice: number
  newPrice: number
  delta: number
  note: string
}

const feeOf = (amount: number, side: 'buy' | 'sell'): number => {
  const commission = Math.max(COMMISSION_MIN, money(amount * COMMISSION_RATE))
  const stamp = side === 'sell' ? money(amount * STAMP_RATE) : 0
  const transfer = money(amount * TRANSFER_RATE)
  return money(commission + stamp + transfer)
}

export function applyPriceCorrection(
  account: PrismAccount,
  orders: readonly PrismOrder[],
  fills: readonly PrismFill[],
  input: PriceCorrectionInput,
  now = Date.now(),
): PriceCorrectionResult {
  const order = orders.find((o) => o.id === input.orderId)
  if (order === undefined) throw new Error(`没有该委托：${input.orderId}`)
  if (order.status !== 'filled') throw new Error(`只有已成交委托可订正（当前 ${order.status}）`)
  const newPrice = input.newPrice
  if (!Number.isFinite(newPrice) || newPrice <= 0) throw new Error('newPrice 必须是有限正数')
  if (typeof input.basis !== 'string' || input.basis.trim() === '') throw new Error('必须填写订正依据 basis')

  const group = fills.filter((f) => f.orderId === order.id)
  if (group.length === 0) throw new Error('该委托没有成交记录，拒绝订正')
  const oldPrice = group[0]?.price ?? order.fillPrice ?? order.price
  if (Math.abs(oldPrice - newPrice) < 1e-9) throw new Error('新旧价格相同，无需订正')

  // 差额方向必须按买卖分开口径：
  //   买入：delta = 旧(成交额+费用) − 新(成交额+费用)，多付 ⇒ 正数退回
  //   卖出：delta = 新(成交额−费用) − 旧(成交额−费用)，少收 ⇒ 负数（现金减少）
  let delta = 0
  const nextFills: PrismFill[] = fills.map((f) => {
    if (f.orderId !== order.id) return f
    const amount = money(f.shares * newPrice)
    const fee = feeOf(amount, f.side)
    delta += f.side === 'buy' ? (f.amount + f.fee) - (amount + fee) : (amount - fee) - (f.amount - f.fee)
    return { ...f, price: newPrice, amount, fee }
  })
  delta = money(delta)

  // 买入多付 ⇒ delta>0（退回）；卖出少收 ⇒ delta<0（补回）
  const nextOrders: PrismOrder[] = orders.map((o) => (o.id !== order.id ? o : {
    ...o,
    price: newPrice,
    fillPrice: newPrice,
    corrections: [
      ...(o.corrections ?? []),
      { at: now, oldPrice, newPrice, delta, basis: input.basis.trim() },
    ],
  }))

  const isBuy = (group[0]?.side ?? 'buy') === 'buy'
  const positions = isBuy
    ? account.positions.map((p) => {
      if (p.secid !== order.secid) return p
      const netCost = money(p.netCost - delta)
      const cost = p.qty > 0 ? Math.round((netCost / p.qty) * 10_000) / 10_000 : p.cost
      return { ...p, netCost, cost }
    })
    : account.positions

  const nextAccount: PrismAccount = {
    ...account,
    cash: money(account.cash + delta),
    // 卖出订正的差额进已实现盈亏（买入不动 realized）
    realized: isBuy ? account.realized : money(account.realized + delta),
    positions,
  }
  const note = `订正 ${order.name} 成交价 ${oldPrice} → ${newPrice}；现金差额 ${delta >= 0 ? '+' : ''}${delta}`
  return { account: nextAccount, orders: nextOrders, fills: nextFills, oldPrice, newPrice, delta, note }
}
