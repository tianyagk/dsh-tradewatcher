/**
 * 行情卡片五档状态（过冷 / 偏冷 / 适中 / 偏热 / 过热）—— 纯计算，可脱离宿主直接跑。
 *
 * 口径（与 `docs/DESIGN-STRIP-CONFIG.md` §5 + Lead 裁决一致）：
 *   `R30` = 近 30 个交易日涨跌幅；`MOM` = 近 5 日涨跌幅 − 近 20 日涨跌幅；
 *   `score = 0.6·z(R30) + 0.4·z(MOM)`，`z` 用**该标的自身**历史分布标准化（250 根优先，不足降级 120 / 60）；
 *   档位 = `score` 在**该标的自身** score 分布里的分位：`<10%` 过冷 ｜ `10–30%` 偏冷 ｜ `30–70%` 适中 ｜
 *   `70–90%` 偏热 ｜ `>90%` 过热（分位法不假设正态，也不设固定 σ 阈值）。
 *
 * 两条红线：
 *   1. **收益率类先取负**（`−Δyield` = 价格方向），否则"收益率上行"会被读成"债市走强"，与股票卡语义相反；
 *   2. **缺失绝不用「适中」冒充**：样本不足 / 基准不足 / 取不到都返回 `level: null` + 原因。
 */
import type { DayBar } from '../shared/model.ts'

export const TONE_LEVELS = ['过冷', '偏冷', '适中', '偏热', '过热'] as const
export type ToneLevel = (typeof TONE_LEVELS)[number]

/** `R30` 需要 31 根（取 `t−30`）；低于此但 ≥5 根 ⇒ 明确说"样本不足" */
export const TONE_MIN_BARS = 31
/** 分档基准下限：score 样本数不足 30 个不发布档位 */
export const TONE_MIN_SAMPLES = 30
/** 标准化窗口偏好：250 根优先，不足依次降级 */
export const TONE_WINDOWS = [250, 120, 60] as const

export interface ToneComputation {
  level: ToneLevel | null
  /** 分位（0–100，越大越热）；未发布时为 null */
  pct: number | null
  /** 近 30 个交易日涨跌幅（%）；不足时 null */
  r30: number | null
  /** 动量（近 5 日 − 近 20 日，%）；不足时 null */
  momentum: number | null
  /** 参与分档的 score 样本数 */
  samples: number
  /** 用到的收盘序列长度 */
  bars: number
  /** 标准化窗口（实际用到的那一档） */
  window: number
  /** 未发布档位的原因（人话）；已发布时 null */
  why: string | null
  /** 是否属于"样本不足"（区别于"取不到"） */
  insufficient: boolean
}

const EMPTY = (bars: number, why: string, insufficient: boolean): ToneComputation => ({
  level: null, pct: null, r30: null, momentum: null, samples: 0, bars, window: 0, why, insufficient,
})

/** 有效收盘序列（收益率类也是正数：4.23 = 4.23%） */
export function toneCloses(bars: readonly DayBar[]): number[] {
  const out: number[] = []
  for (const b of bars) {
    if (typeof b.close === 'number' && Number.isFinite(b.close) && b.close > 0) out.push(b.close)
  }
  return out
}

/**
 * 收益率类的方向符号：**取负作用在"变化量"上**，不是作用在价格水平上。
 *
 * ⚠ 这里踩过一次：把整条序列取负对收益率是**恒等变换**（`(−b)/(−a) = b/a`），
 * 于是"收益率类先取负"完全没生效、同一段收益率序列的档位与价格型一模一样。
 * 正确做法：`R30`/`MOM` 算出来后乘 `−1` —— 收益率上行 ⇒ 债券价格走弱 ⇒ 落在"冷"侧。
 */
export function toneSign(isYield: boolean): number {
  return isYield ? -1 : 1
}

/**
 * 近 `n` 个交易日涨跌幅（小数，如 0.05 = +5%）；下标不足或基准为 0 ⇒ null。
 *
 * ⚠ 基数用 `!== 0` 而不是 `> 0`：收益率类在内部**已经取负**（`−yield`），分母是负数，
 * 用 `> 0` 会把整条序列判成"不可算"（实测就是这么踩到的）。
 */
export function returnAt(closes: readonly number[], i: number, n: number): number | null {
  const a = closes[i - n]
  const b = closes[i]
  if (a === undefined || b === undefined || !Number.isFinite(a) || a === 0) return null
  return b / a - 1
}

/**
 * 动量 `MOM` = 近 5 日涨跌幅 − 近 20 日涨跌幅（同一序列，按 Lead 裁决的字面定义）
 *
 * 两者都相对 `t−5` / `t−20`，因此需要 30 根历史才能同时取到；不足 ⇒ null（不拿 0 顶替）。
 */
export function momentumAt(closes: readonly number[], i: number): number | null {
  const r5 = returnAt(closes, i, 5)
  const r20 = returnAt(closes, i, 20)
  if (r5 === null || r20 === null) return null
  return r5 - r20
}

/** 样本均值与标准差（总体，n 作分母）；n<2 或 sd=0 ⇒ null（不做标准化，避免除 0 得到假分位） */
export function meanSd(xs: readonly number[]): { mean: number; sd: number } | null {
  if (xs.length < 2) return null
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length
  const varSum = xs.reduce((a, b) => a + (b - mean) ** 2, 0) / xs.length
  const sd = Math.sqrt(varSum)
  return sd > 0 ? { mean, sd } : null
}

/** 标准化到 z；样本不可用（<2 或 sd=0）⇒ null */
export function zOf(x: number, sample: readonly number[]): number | null {
  const ms = meanSd(sample)
  return ms === null ? null : (x - ms.mean) / ms.sd
}

/** 分位（0–100）：`当前值` 在样本里的秩百分位（小于它的比例） */
export function percentileOf(sample: readonly number[], current: number): number | null {
  if (sample.length === 0) return null
  let below = 0
  for (const x of sample) if (x < current) below += 1
  return (below / sample.length) * 100
}

/** 分位 → 档位（与设计文档同一套边界） */
/** 档位对应的**分位区间**（标签型输出必须能给区间边界，P0-9） */
export const TONE_BANDS: Record<ToneLevel, string> = {
  过冷: '分位 <10%',
  偏冷: '分位 10–30%',
  适中: '分位 30–70%',
  偏热: '分位 70–90%',
  过热: '分位 >90%',
}

/** 口径字符串随结果返回（与算法同源：改算法就必须改这里，P0-10） */
export const TONES_METHODOLOGY =
  'score = 0.6·z(近30日涨跌幅) + 0.4·z(近5日涨跌幅 − 近20日涨跌幅)；' +
  'z 用该标的自身历史分布标准化（窗口 250 根日线优先，不足降级 120/60）；' +
  '档位取 score 在该标的自身 score 分布中的分位：<10% 过冷 ｜ 10–30% 偏冷 ｜ 30–70% 适中 ｜ 70–90% 偏热 ｜ >90% 过热；' +
  '收益率类先对变化量取负（上行＝债券价格走弱）。样本：日线 ≥31 根才可算，score 样本 <30 不发布档位；缺失一律 —，不用「适中」冒充。'

export function toneLevelOfPct(pct: number): ToneLevel {
  if (pct < 10) return '过冷'
  if (pct < 30) return '偏冷'
  if (pct <= 70) return '适中'
  if (pct <= 90) return '偏热'
  return '过热'
}

/**
 * 主入口：一段**已收盘**日线 → 五档状态。
 *
 * 样本判定（三条按序）：
 *   - `bars < 5` ⇒ 不发布（原因：日线太少）；
 *   - `5 ≤ bars < 31` ⇒ `insufficient`（"样本不足（现有 N 根，R30 需 ≥31 根）"）；
 *   - score 样本 < 30 ⇒ 不发布（"分档基准不足（m/30 个历史样本）"）。
 */
export function toneOfBars(
  bars: readonly DayBar[],
  opts: { isYield?: boolean; windows?: readonly number[] } = {},
): ToneComputation {
  const closes = toneCloses(bars)
  const sign = toneSign(opts.isYield === true)
  const n = closes.length
  if (n < 5) return EMPTY(n, `日线太少（${n} 根），无法计算`, true)
  if (n < TONE_MIN_BARS) {
    return EMPTY(n, `样本不足（现有 ${n} 根日线，R30 需 ≥${TONE_MIN_BARS} 根）`, true)
  }
  const windows = opts.windows ?? TONE_WINDOWS
  let last: ToneComputation | null = null
  for (const w of windows) {
    const start = Math.max(30, n - w)
    const idx: number[] = []
    for (let i = start; i < n; i += 1) idx.push(i)
    const r30s: number[] = []
    const moms: number[] = []
    for (const i of idx) {
      const r = returnAt(closes, i, 30)
      const m = momentumAt(closes, i)
      if (r !== null) r30s.push(sign * r)
      if (m !== null) moms.push(sign * m)
    }
    if (r30s.length < TONE_MIN_SAMPLES || moms.length < TONE_MIN_SAMPLES) {
      last = { ...EMPTY(n, `分档基准不足（${r30s.length}/${TONE_MIN_SAMPLES} 个历史样本）`, true), window: Math.min(w, n) }
      continue
    }
    const scores: number[] = []
    for (const i of idx) {
      const rr = returnAt(closes, i, 30)
      const mm = momentumAt(closes, i)
      if (rr === null || mm === null) continue
      const zr = zOf(sign * rr, r30s)
      const zm = zOf(sign * mm, moms)
      if (zr === null || zm === null) continue
      scores.push(0.6 * zr + 0.4 * zm)
    }
    const rawR = returnAt(closes, n - 1, 30)
    const rawM = momentumAt(closes, n - 1)
    const curR = rawR === null ? null : sign * rawR
    const curM = rawM === null ? null : sign * rawM
    if (scores.length < TONE_MIN_SAMPLES || curR === null || curM === null) {
      last = { ...EMPTY(n, `分档基准不足（${scores.length}/${TONE_MIN_SAMPLES} 个历史样本）`, true), window: Math.min(w, n) }
      continue
    }
    const zr = zOf(curR, r30s)
    const zm = zOf(curM, moms)
    if (zr === null || zm === null) {
      last = { ...EMPTY(n, '该标的近期波动为 0，标准分不可算', true), window: Math.min(w, n) }
      continue
    }
    const cur = 0.6 * zr + 0.4 * zm
    const pct = percentileOf(scores, cur)
    if (pct === null) {
      last = { ...EMPTY(n, '分档基准不足（0 个历史样本）', true), window: Math.min(w, n) }
      continue
    }
    return {
      level: toneLevelOfPct(pct),
      pct,
      r30: curR * 100,
      momentum: curM * 100,
      samples: scores.length,
      bars: n,
      window: Math.min(w, n),
      why: null,
      insufficient: false,
    }
  }
  return last ?? EMPTY(n, '分档基准不足', true)
}
