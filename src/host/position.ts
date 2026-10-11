/**
 * 位置类指标：52 周区间位置% + 距 52 周高点/低点%（纯函数）。
 *
 * 三条口径（都与 `ytd.ts` 同源，避免"同一个指标两种算法"）：
 *  ① 必须用前复权序列：不复权时除权跳空会被读成"跌了很多"，分位失真（Arkvol 的反面教材：NFLX 未复权）；
 *     指数/期货没有复权概念 ⇒ 按原始价格并在结果里如实标 `fqSupported=false`；
 *  ② 窗口写死成单一常量并随结果返回（`POSITION_WINDOW`）—— 界面/工具都不许自己写"一年"；
 *  ③ 样本不足 ⇒ `posPct: null` + 原因，不用 0 或 50% 冒充。
 */
import type { DayBar, FqMode } from '../shared/model.ts'

/**窗口口径：单一来源（改这里，界面与工具的"52周"跟着变） */
export const POSITION_WINDOW = {
  /**自然日窗口 */
  days: 365,
  label: '52周（最近 365 个自然日）',
  /**需要拉多少根日线（一年约 245 个交易日，留足冗余；窗口内按日期再裁一次） */
  bars: 300,
} as const

export interface PositionMetrics {
  secid: string
  /**现价（调用方给；缺失 ⇒ 全部指标 null） */
  price: number | null
  high: number | null
  low: number | null
  /**区间位置%：0 = 落在窗口最低点，100 = 最高点 */
  posPct: number | null
  /**距窗口高点%（负数表示低于高点） */
  fromHighPct: number | null
  /**距窗口低点%（正数表示高于低点） */
  fromLowPct: number | null
  /**文本标签：极接近低点/接近低点/区间内/接近高点/极接近高点 */
  label: string | null
  /**窗口内的样本数（交易日根数） */
  samples: number
  /**窗口口径（随结果返回，界面不自己写） */
  window: string
  fq: FqMode
  fqSupported: boolean
  /**窗口内第一根的日期（让读者知道样本从哪天开始） */
  from: string | null
  to: string | null
  why: string | null
}

const EMPTY = (secid: string, why: string): PositionMetrics => ({
  secid, price: null, high: null, low: null, posPct: null, fromHighPct: null, fromLowPct: null,
  label: null, samples: 0, window: POSITION_WINDOW.label, fq: 0, fqSupported: false, from: null, to: null, why,
})

/**位置标签（区间边界写死在这里，界面与工具共用） */
export function positionLabel(posPct: number): string {
  if (posPct <= 10) return '极接近低点'
  if (posPct <= 30) return '接近低点'
  if (posPct < 70) return '区间内'
  if (posPct < 90) return '接近高点'
  return '极接近高点'
}

/**窗口内取样：按最后一根的日期回推 `days` 个自然日（不是"最后 N 根"，避免停牌日把窗口拉长） */
export function windowBars(bars: readonly DayBar[], days: number = POSITION_WINDOW.days): DayBar[] {
  const last = bars[bars.length - 1]
  if (last === undefined) return []
  const end = Date.parse(`${last.date}T00:00:00+08:00`)
  if (!Number.isFinite(end)) return [...bars]
  const start = end - days * 86_400_000
  return bars.filter((b) => {
    const t = Date.parse(`${b.date}T00:00:00+08:00`)
    return Number.isFinite(t) && t >= start
  })
}

/**
 * 主入口：一段日线（调用方负责按 `fq` 口径取好）+ 现价 → 位置指标。
 *
 * `price === null` ⇒ 全部 `null` + 原因（现价缺失时算位置没有意义）；窗口内 < 2 根也拒绝（没有区间可言）。
 */
export function positionOfBars(
  secid: string,
  bars: readonly DayBar[],
  price: number | null,
  opts: { fq: FqMode; fqSupported: boolean; days?: number } = { fq: 0, fqSupported: false },
): PositionMetrics {
  if (price === null || !Number.isFinite(price)) return { ...EMPTY(secid, '现价未取到，位置指标不可算'), window: POSITION_WINDOW.label }
  const win = windowBars(bars, opts.days ?? POSITION_WINDOW.days).filter((b) => Number.isFinite(b.high) && Number.isFinite(b.low))
  if (win.length < 2) {
    return {
      ...EMPTY(secid, `窗口内样本不足（${win.length} 根 < 2），无法给区间位置`),
      price, samples: win.length, fq: opts.fq, fqSupported: opts.fqSupported,
    }
  }
  let hi = -Infinity
  let lo = Infinity
  for (const b of win) {
    hi = Math.max(hi, b.high)
    lo = Math.min(lo, b.low)
  }
  if (!(hi > lo)) {
    return { ...EMPTY(secid, '窗口内最高价=最低价，区间位置无意义'), price, samples: win.length, fq: opts.fq, fqSupported: opts.fqSupported }
  }
  // 现价可能超出窗口区间（新高/新低）⇒ 位置夹到 0–100，但距高低点%按实际算（如实）
  const rawPct = ((price - lo) / (hi - lo)) * 100
  const posPct = Math.min(100, Math.max(0, rawPct))
  return {
    secid,
    price,
    high: hi,
    low: lo,
    posPct,
    fromHighPct: hi > 0 ? ((price - hi) / hi) * 100 : null,
    fromLowPct: lo > 0 ? ((price - lo) / lo) * 100 : null,
    label: positionLabel(posPct),
    samples: win.length,
    window: POSITION_WINDOW.label,
    fq: opts.fq,
    fqSupported: opts.fqSupported,
    from: win[0].date,
    to: win[win.length - 1].date,
    why: rawPct > 100 ? '现价高于窗口最高价（区间位置按 100% 记）' : rawPct < 0 ? '现价低于窗口最低价（区间位置按 0% 记）' : null,
  }
}
