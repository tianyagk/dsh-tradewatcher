/**
 * 自选异动识别（P1-4）。
 *
 * 回答一个问题：**这一条今天"不正常"吗** —— 放量，还是价格异动。
 *
 * 两条判据，全部基于可验证的数据：
 *  1. **量能倍数**：今日成交量 ÷ (20 日均量 × 日内进度)。分母的"日内进度"复用护盘模块
 *     标定的累计成交占比曲线（`progressAt`），因此这是**同时点**口径 —— 早盘 10:00
 *     拿全天均量直接比会得出"每天都缩量"的结论（进度才 40%）。
 *  2. **涨跌幅**：来自行情（不是从 K 线重算），绝对值 ≥ 5% 即价格异动。
 *
 * 单位一致性：量能倍数**只用 K 线序列算**（今日本身在日线里也有一根），不把行情的
 * `vol`（手）与日线的 `vol` 混用 —— 混单位会得出恒为真或恒为假的判定，而且看不出来。
 *
 * 样本不足（< MIN_SAMPLES 个交易日）**不给判定**：5 天以下的均量是噪音，
 * 报出来的"异动"只是新股/次新股的正常波动。
 */
import type { DayBar } from '../shared/model.ts'
import * as em from './em.ts'
import { RESCUE_CALIBRATION } from './rescue-thresholds.ts'
import { progressAt, sessionElapsed } from './rescue.ts'
import { inSession, hhmmOf, dayOf } from './time.ts'

/** 量能倍数阈值（同时点口径）：达到即算放量异动 */
export const VOLUME_MULT_ALERT = 2.5
/** 价格异动阈值（|涨跌幅| %） */
export const PRICE_PCT_ALERT = 5
/** 量价共振：涨跌幅达此值且量能倍数达此值 → 也算异动（单看任一条都还不够） */
export const PRICE_PCT_COMBO = 3
export const VOLUME_MULT_COMBO = 2
/** 均量所需最少交易日数（不足则不给判定） */
export const MIN_SAMPLES = 5
/** 基线窗口（交易日） */
export const BASELINE_DAYS = 20

export type AnomalyKind = 'volume' | 'price' | 'both' | null

export interface AnomalyJudgement {
  kind: AnomalyKind
  /** 同时点量能倍数；不可算时为 null */
  mult: number | null
  /** 基线样本数（参与均量的交易日数） */
  samples: number
  /** 人类可读的成因（每条都能追溯到具体数值） */
  reasons: string[]
  /** 为什么不给判定（样本不足/非交易时段/取不到日前序列）—— 空数组表示"判定过且无异常" */
  skip: string[]
}

export interface AnomalyInput {
  bars: readonly DayBar[]
  /** 当日涨跌幅（%），来自行情 */
  pct: number | null
  /** 北京时间 HH:mm */
  hhmm: string
  /** 当前是否在交易时段 */
  inSessionNow: boolean
  /** 昨日（或最近交易日）的日期，用于识别"最后一根是不是今天" */
  today: string
}

/**
 * 判定一条自选是否异动（纯函数：只依赖入参与标定曲线，可直接断言）。
 *
 * 返回的 `skip` 与 `reasons` 是两件事：
 *   - `skip` 非空 = **本次没有判定**（样本不足/非交易时段），界面不应据此说"无异常"；
 *   - `reasons` 非空 = 判定过且有异常。
 * 此前若把二者合并，样本不足会被显示成"正常"，那是错的信息。
 */
export function judgeAnomaly(input: AnomalyInput): AnomalyJudgement {
  const { bars, pct, hhmm, inSessionNow, today } = input
  // 休市时不产生新异动：收盘后满屏高亮只是噪音（当日结论已定，看也来不及做动作）
  if (!inSessionNow) {
    return { kind: null, mult: null, samples: 0, reasons: [], skip: ['非交易时段（收盘后不再产生新的异动提示）'] }
  }
  const last = bars[bars.length - 1]
  if (last === undefined || last.date !== today) {
    // 日线里还没有今天这根 → 无法算"今日量"，而不是"今天量很小"
    return { kind: null, mult: null, samples: 0, reasons: [], skip: [`日线序列里还没有 ${today} 这一根（上游未更新），无法比较今日量能`] }
  }
  const todayVol = last.vol
  if (todayVol === null || !Number.isFinite(todayVol) || todayVol <= 0) {
    return { kind: null, mult: null, samples: 0, reasons: [], skip: ['今日成交量暂缺（上游未给出）'] }
  }
  const prev = bars.slice(0, bars.length - 1).filter((b) => b.vol !== null && Number.isFinite(b.vol) && (b.vol as number) > 0)
  if (prev.length < MIN_SAMPLES) {
    return {
      kind: null, mult: null, samples: prev.length, reasons: [],
      skip: [`可用均量样本仅 ${prev.length} 个交易日（需 ≥ ${MIN_SAMPLES}）—— 样本不足时不判定，避免把新股/次新股的正常波动报成异动`],
    }
  }
  const window = prev.slice(-BASELINE_DAYS)
  const avg = window.reduce((a, b) => a + (b.vol as number), 0) / window.length
  const elapsed = sessionElapsed(hhmm)
  const expected = avg * progressAt(RESCUE_CALIBRATION.progressCurve, elapsed)
  const mult = expected > 0 ? todayVol / expected : null

  const reasons: string[] = []
  const volumeHit = mult !== null && mult >= VOLUME_MULT_ALERT
  const priceHit = pct !== null && Math.abs(pct) >= PRICE_PCT_ALERT
  const comboHit = mult !== null && pct !== null && Math.abs(pct) >= PRICE_PCT_COMBO && mult >= VOLUME_MULT_COMBO
  if (volumeHit) reasons.push(`放量：同时点量能 ${mult!.toFixed(2)}x（20 日均量 ${fmtVol(avg)}，阈值 ${VOLUME_MULT_ALERT}x）`)
  if (priceHit) reasons.push(`价格异动：当日 ${pct! >= 0 ? '+' : ''}${pct!.toFixed(2)}%（阈值 ±${PRICE_PCT_ALERT}%）`)
  if (comboHit && !volumeHit && !priceHit) reasons.push(`量价共振：${pct! >= 0 ? '+' : ''}${pct!.toFixed(2)}% 且量能 ${mult!.toFixed(2)}x（单条都未越线，但组合已越线）`)
  const kind: AnomalyKind = volumeHit && priceHit ? 'both' : volumeHit ? 'volume' : priceHit ? 'price' : comboHit ? 'both' : null
  return { kind, mult: mult === null ? null : Math.round(mult * 100) / 100, samples: window.length, reasons, skip: [] }
}

const fmtVol = (v: number): string => (v >= 1e8 ? `${(v / 1e8).toFixed(2)}亿股` : v >= 1e4 ? `${(v / 1e4).toFixed(1)}万股` : `${Math.round(v)}股`)

export interface AnomalyRow extends AnomalyJudgement {
  secid: string
  name: string
  pct: number | null
}

export interface AnomalyResult {
  rows: AnomalyRow[]
  asOf: number
  /** 整体不可用的原因（如全部标的的日线都取不到） */
  missing: Array<{ what: string; why: 'no-source' | 'transient'; note: string }>
}

/**
 * 批量判定（K 线走 `fetchKline`，因此复用宿主既有的本地缓存与增量更新，不会额外打上游）。
 * `quotes` 提供涨跌幅 —— 与界面显示的是同一份数据。
 */
export async function detectAnomalies(
  items: ReadonlyArray<{ secid: string; name: string }>,
  quotes: Readonly<Record<string, { pct: number | null }>>,
): Promise<AnomalyResult> {
  const now = Date.now()
  const today = dayOf(now)
  const hhmm = hhmmOf(now)
  const sessionNow = inSession(now)
  const missing: AnomalyResult['missing'] = []
  const rows: AnomalyRow[] = []
  // 并发有界：自选可能几十条，全部并发会打爆上游（复用 K 线缓存，命中时零请求）
  const queue = [...items]
  const workers = Array.from({ length: 4 }, async () => {
    for (;;) {
      const it = queue.shift()
      if (it === undefined) return
      let bars: DayBar[] = []
      try {
        // 不复权（fqt=0）：量能比较不需要复权口径，且不复权序列命中率最高
        const k = await fetchKlineZero(it.secid)
        bars = k ?? []
      } catch {
        missing.push({ what: `${it.name}（${it.secid}）`, why: 'transient', note: '日线本次取不到（上游限流或超时），本轮不给异动判定；稍后随行情轮询自动重试' })
      }
      const judged = judgeAnomaly({ bars, pct: quotes[it.secid]?.pct ?? null, hhmm, inSessionNow: sessionNow, today })
      rows.push({ secid: it.secid, name: it.name, pct: quotes[it.secid]?.pct ?? null, ...judged })
    }
  })
  await Promise.all(workers)
  return { rows, asOf: now, missing }
}

/**
 * 单独的取数入口（便于测试打桩与单点替换）。
 * 复权口径写死**不复权**：量能比较与复权无关，且不复权序列在缓存里命中率最高；
 * 请求 30 根是为了留足 20 日均量 + 今天这一根。
 */
async function fetchKlineZero(secid: string): Promise<DayBar[] | null> {
  const k = await em.fetchKline(secid, 101, BASELINE_DAYS + 6, 0)
  return k === null ? null : k.days
}
