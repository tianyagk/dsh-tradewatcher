/**
 * ATR14（平均真实波幅）——「做T窗口」的间距来源（用户口径：`ATR% = ATR14 ÷ 收盘 × 100`）。
 *
 * 取**日 K**（前复权，14 天窗口）。取不到就如实返回原因，**绝不回落到"默认 2%"**：
 * 那会把一个凭空的波动率画成网格，比不画更糟。
 */
import { fetchKline } from './em.ts'

export interface AtrReading {
  /** ATR14（价格单位） */
  atr: number
  /** 窗口最后一根收盘价（分母） */
  close: number
  /** ATR% = atr / close × 100 */
  pct: number
  /** 实际用了几根真实波幅（= days-1，满窗时 = 14） */
  bars: number
}

/**
 * 从日 K 算 ATR14（Wilder 定义：TR = max(high−low, |high−prevClose|, |low−prevClose|)，
 * ATR = 最近 N 根 TR 的**简单平均**）。
 *
 * 为什么用简单平均而不是 Wilder 平滑：窗口只有 14 根，平滑需要更长历史才有意义；
 * 简单平均在小窗口上更稳、也更容易被断言复算（用户要求公式可核对）。
 */
export function atrFromBars(
  bars: ReadonlyArray<{ high: number; low: number; close: number }>,
  days = 14,
): AtrReading | null {
  const need = Math.max(2, Math.round(days))
  if (bars.length < need + 1) return null
  const win = bars.slice(-(need + 1))
  const trs: number[] = []
  for (let i = 1; i < win.length; i += 1) {
    const cur = win[i]
    const prev = win[i - 1]
    if (cur === undefined || prev === undefined) continue
    const hi = Number(cur.high)
    const lo = Number(cur.low)
    const pc = Number(prev.close)
    if (!Number.isFinite(hi) || !Number.isFinite(lo) || !Number.isFinite(pc)) continue
    if (!(hi > 0) || !(lo > 0) || !(pc > 0) || hi < lo) continue
    trs.push(Math.max(hi - lo, Math.abs(hi - pc), Math.abs(lo - pc)))
  }
  if (trs.length < need) return null
  const last = win[win.length - 1]
  const close = Number(last?.close)
  if (!Number.isFinite(close) || !(close > 0)) return null
  const atr = trs.slice(-need).reduce((a, b) => a + b, 0) / need
  if (!Number.isFinite(atr) || !(atr > 0)) return null
  return { atr, close, pct: (atr / close) * 100, bars: need }
}

export interface AtrResult extends Partial<AtrReading> {
  /** 取不到时的原因（`null` = 拿到了） */
  reason: string | null
}

/**
 * 取某标的的 ATR%（宿主侧）。走既有 `fetchKline`（800 根日线缓存 + 熔断 + 增量），
 * 不新建旁路；只多要 30 根（14 根足够，多要几根抵御停牌/缺根）。
 */
export async function atr14PctOf(secid: string): Promise<AtrResult> {
  let k: Awaited<ReturnType<typeof fetchKline>> = null
  try {
    k = await fetchKline(secid, 101, 30, 1)
  } catch (error) {
    return { reason: `日K 取数失败：${error instanceof Error ? error.message : String(error)}` }
  }
  if (k === null) return { reason: '日K 未取到（上游不可达且本地没有可用缓存）' }
  const bars = (k.days ?? []).map((d) => ({ high: d.high, low: d.low, close: d.close }))
  const reading = atrFromBars(bars, 14)
  if (reading === null) return { reason: `日K 不足 15 根（实际 ${bars.length} 根）⇒ 算不出 ATR14` }
  return { ...reading, reason: null }
}
