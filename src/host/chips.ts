/**
 * 筹码分布（纯函数，不 import react）。
 *
 * 口径由 Lead 拍定 + `docs/DESIGN-CHIPS.md` 的实测支撑：
 *  ① **衰减主口径 = 换手率**：`t_i = min(vol_i×100×close_i ÷ floatMv_now, cap=0.25)`。
 *     为什么不是"成交量 ÷ 流通股本"：**流通股本拿不到，但流通市值拿得到**，而
 *     `成交额 ÷ 流通市值` 与 `成交量 ÷ 流通股本` 等价 ⇒ 不需要股数。逐日历史流通市值我们没有，
 *     所以用**当前** `floatMv` 近似（口径字符串里写明）。
 *  ② **回落口径 = 固定半衰期** `w = 0.5^(k/H)`，`H = 10` 交易日。**港股必须走这一档**：
 *     实测港股 `vol/amount` 的缩放与 A股不同（`amount ÷ (vol×price) ≈ 9926`，单位未标定）
 *     ⇒ 用换手率口径前必须先标定，本轮**不标定、直接回落**。
 *  ③ 窗口 45 根（`fqt=1` 前复权）；不足按实际根数并写 `近 N 日`；`N < 10` ⇒ 样本不足，不给结论。
 *  ④ 指数/期货/板块（`fqSupported=false`）**不提供**该模块（比"按原始价格"更诚实）。
 *  ⑤ 桶数 32，收盘价落边界时**按位置线性分摊到相邻两桶**（守恒：分摊前后总权重相等）。
 *  ⑥ 支撑/压力 = 筹码累积分布的 **P5 / P95** 价位；过窄（`P95−P5 < 区间 3%`）⇒ 只给一句"区间过窄"。
 *  ⑦ 平均成本 = Σ(桶价×权重)/Σ权重；**盈利比例** = Σ(桶价 **<** 现价 的权重)/Σ权重。
 */
export const CHIPS_BUCKETS = 32
export const CHIPS_WINDOW = 45
/** 换手率口径的封顶（单日最多换掉 25% 筹码，避免极端值把权重打满） */
export const CHIPS_CAP = 0.25
/** 固定半衰期（交易日）：港股与缺 floatMv 时使用 */
export const CHIPS_HALF_LIFE = 10
/** 衰减系数 k（用户口径）：`chips_t = chips_{t-1} × max(0, 1 − t_t×k) + new_t`，默认 1.5、范围 [0.5, 3.0] */
export const CHIPS_DECAY_DEFAULT = 1.5
export const CHIPS_DECAY_MIN = 0.5
export const CHIPS_DECAY_MAX = 3
/** 新增筹码的分配形状：三角形（默认，峰在当日均价）／均匀 */
export type ChipSpread = 'triangle' | 'uniform'
export const CHIPS_SPREAD_DEFAULT: ChipSpread = 'triangle'

/** 口径归一：非法值（负数/超范围/未知形状）⇒ 回落默认，并如实回报（不静默） */
export function normalizeChipPrefs(raw: { decay?: unknown; spread?: unknown }): { decay: number; spread: ChipSpread; notes: string[] } {
  const notes: string[] = []
  const d = typeof raw.decay === 'number' && Number.isFinite(raw.decay) ? raw.decay : Number.NaN
  let decay = CHIPS_DECAY_DEFAULT
  if (Number.isFinite(d)) {
    if (d < CHIPS_DECAY_MIN || d > CHIPS_DECAY_MAX) notes.push(`衰减系数 k=${d} 超出 [${CHIPS_DECAY_MIN}, ${CHIPS_DECAY_MAX}] ⇒ 回落 ${CHIPS_DECAY_DEFAULT}`)
    else decay = d
  } else if (raw.decay !== undefined) {
    notes.push(`衰减系数 k 不是数字（${String(raw.decay)}）⇒ 回落 ${CHIPS_DECAY_DEFAULT}`)
  }
  let spread: ChipSpread = CHIPS_SPREAD_DEFAULT
  if (raw.spread !== undefined) {
    if (raw.spread === 'triangle' || raw.spread === 'uniform') spread = raw.spread
    else notes.push(`筹码形状「${String(raw.spread)}」认不出（只支持 triangle/uniform）⇒ 回落 ${CHIPS_SPREAD_DEFAULT}`)
  }
  return { decay, spread, notes }
}
export const CHIPS_MIN_SAMPLES = 10
/** "区间过窄"阈值：P95−P5 占价格区间的比例 */
export const CHIPS_NARROW_RATIO = 0.03

export interface ChipBar {
  date: string
  close: number
  /** 成交量（手/股按上游原样；换手率口径下与 close 一起构成成交额） */
  vol: number | null
}

export type ChipDecay = 'turnover' | 'half-life'

export interface ChipDay {
  date: string
  /** 32 桶权重（和为 1；全 0 时代表没有可用样本） */
  buckets: number[]
  /** 桶中心价位（与 buckets 等长） */
  centers: number[]
  avgCost: number | null
  support: number | null
  resistance: number | null
  narrow: boolean
  profitRatio: number | null
  samples: number
}

export interface ChipSeries {
  days: ChipDay[]
  /** 最后一天（界面默认显示这一天） */
  latest: ChipDay | null
  window: number
  bucketCount: number
  decay: ChipDecay
  /** 回落原因（主口径可用时为 null；**必须如实写清**，界面直接显示） */
  decayReason: string | null
  avgCost: number | null
  support: number | null
  resistance: number | null
  narrow: boolean
  profitRatio: number | null
  samples: number
  /** 口径字符串（与算法同源，随结果返回） */
  methodology: string
  /** 不提供该模块时的一句话原因（指数/期货/样本不足），否则 null */
  why: string | null
  disclaimer: string
}

const round = (n: number, d = 4): number => Math.round(n * 10 ** d) / 10 ** d

/** 桶中心：把 [low, high] 等分成 n 桶，中心取每桶中点（与参考实现"价格刻度"同性质） */
export function bucketCenters(low: number, high: number, n: number): number[] {
  const width = (high - low) / n
  return Array.from({ length: n }, (_, i) => low + width * (i + 0.5))
}

/**
 * 把一份权重按价格**线性分摊**到相邻两桶（守恒）。
 * 价格正好落在桶中心 ⇒ 全给该桶；落在两中心之间 ⇒ 按距离反比拆分。
 */
export function allocate(weights: number[], centers: number[], price: number, w: number): void {
  const n = centers.length
  if (n === 0 || !(w > 0)) return
  if (price <= centers[0]) {
    weights[0] += w
    return
  }
  if (price >= centers[n - 1]) {
    weights[n - 1] += w
    return
  }
  for (let i = 0; i < n - 1; i += 1) {
    const a = centers[i]
    const b = centers[i + 1]
    if (price >= a && price <= b) {
      const t = (price - a) / (b - a)
      weights[i] += w * (1 - t)
      weights[i + 1] += w * t
      return
    }
  }
}

/**
 * 当日新增筹码的分配（守恒）：`new_t` 按形状铺到当日价格区间。
 *  - 三角形（默认）：以**当日均价** `(high+low+close)/3` 为峰，向 high/low 线性递减；
 *  - 均匀：区间内平均分配。
 * 两种形状的总权重都等于 `w`（断言守恒）。
 */
export function allocateSpread(
  weights: number[],
  centers: number[],
  low: number,
  high: number,
  w: number,
  shape: ChipSpread,
  peak: number,
): void {
  const n = centers.length
  if (n === 0 || !(w > 0)) return
  const span = high - low
  // 三角形未归一化的密度：峰处 1，端点 0；退化（span=0）⇒ 单点
  const density = (p: number): number => {
    if (!(span > 0)) return p === peak ? 1 : 0
    return p <= peak ? Math.max(0, (p - low) / Math.max(1e-12, peak - low)) : Math.max(0, (high - p) / Math.max(1e-12, high - peak))
  }
  // 先用密度函数算每个桶的权重（用桶中心的密度 × 桶宽近似，再归一化保证总量守恒）
  const raw = centers.map((c) => (shape === 'uniform' ? 1 : density(c)))
  const total = raw.reduce((s2, x) => s2 + x, 0)
  if (total <= 0) {
    // 密度全 0（形状退化）⇒ 退化成"全给最接近峰值的桶"，仍守恒
    let best = 0
    for (let i = 1; i < n; i += 1) if (Math.abs(centers[i] - peak) < Math.abs(centers[best] - peak)) best = i
    weights[best] += w
    return
  }
  for (let i = 0; i < n; i += 1) weights[i] += (raw[i] / total) * w
}

/** 分位价位（在桶中心上线性插值，稳定可复算） */
export function percentilePrice(buckets: readonly number[], centers: readonly number[], q: number): number | null {
  const total = buckets.reduce((s, x) => s + x, 0)
  if (!(total > 0)) return null
  const target = total * q
  let acc = 0
  for (let i = 0; i < buckets.length; i += 1) {
    const next = acc + buckets[i]
    if (next >= target) {
      if (buckets[i] === 0) return centers[i]
      // 在该桶的价格区间内线性插值：桶 i 的区间 = [上一个中心, 本中心]
      const lo = i === 0 ? centers[i] : centers[i - 1]
      const hi = centers[i]
      const frac = (target - acc) / buckets[i]
      return lo + (hi - lo) * frac
    }
    acc = next
  }
  return centers[centers.length - 1] ?? null
}

/** 当日均价（用户口径）：(high + low + close) / 3 —— 三角形分布的峰 */
export function peakAfter(low: number, high: number, close: number): number {
  return (high + low + close) / 3
}

export interface ChipOptions {
  /** 当日流通市值（元）。拿不到 ⇒ 回落半衰期 */
  floatMv?: number | null
  /** 港股（`116.*`）：vol/amount 单位未标定 ⇒ **必须**回落半衰期 */
  isHk?: boolean
  /** 现价（盈利比例用；缺失 ⇒ 盈利比例 —，平均成本仍给） */
  price?: number | null
  /** 该标的是否支持前复权（指数/期货/板块 ⇒ false，直接不提供模块） */
  fqSupported?: boolean
  buckets?: number
  window?: number
  halfLife?: number
  cap?: number
  /** 样本数下限（默认 `CHIPS_MIN_SAMPLES`；断言/离线分析可放宽） */
  minSamples?: number
  /** 衰减系数 k（默认 1.5，范围 [0.5, 3.0]） */
  decay?: number
  /** 新增筹码分配形状（默认 triangle） */
  spread?: ChipSpread
}

/** 逐日筹码分布（含每日的 avgCost / P5 / P95 / 盈利比例） */
export function chipSeriesOf(bars: readonly ChipBar[], opts: ChipOptions = {}): ChipSeries {
  const buckets = opts.buckets ?? CHIPS_BUCKETS
  const window = opts.window ?? CHIPS_WINDOW
  const halfLife = opts.halfLife ?? CHIPS_HALF_LIFE
  const cap = opts.cap ?? CHIPS_CAP
  const norm = normalizeChipPrefs({ decay: opts.decay, spread: opts.spread })
  const kFactor = norm.decay
  const shape = norm.spread
  const win = bars.filter((b) => Number.isFinite(b.close) && b.close > 0).slice(-window)
  const samples = win.length
  const base: Omit<ChipSeries, 'days' | 'latest'> = {
    window,
    bucketCount: buckets,
    decay: 'half-life',
    decayReason: null,
    avgCost: null,
    support: null,
    resistance: null,
    narrow: false,
    profitRatio: null,
    samples,
    methodology: '',
    why: null,
    disclaimer: '这是筹码分布统计量（成交量的历史累积），不是支撑/压力的预测，也不是买卖建议。',
  }
  // ⑤ 不提供的三种情形：不支持前复权（指数/期货/板块）、样本不足、没有可用 bar
  if (opts.fqSupported === false) {
    return { ...base, days: [], latest: null, why: '指数/期货/板块没有复权口径（前复权序列不可得）⇒ 本模块不提供筹码分布' }
  }
  if (samples < (opts.minSamples ?? CHIPS_MIN_SAMPLES)) {
    return { ...base, days: [], latest: null, why: `样本不足（近 ${samples} 个交易日 < ${CHIPS_MIN_SAMPLES}）⇒ 不给结论` }
  }
  const lows = win.map((b) => b.close)
  const low = Math.min(...lows)
  const high = Math.max(...lows)
  if (!(high > low)) {
    return { ...base, days: [], latest: null, why: '窗口内价格没有变化（高=低）⇒ 分布无意义' }
  }
  const centers = bucketCenters(low, high, buckets)
  // 衰减口径：港股或缺 floatMv ⇒ 半衰期（并如实写原因）
  const useTurnover = opts.isHk !== true && typeof opts.floatMv === 'number' && opts.floatMv > 0
  const decay: ChipDecay = useTurnover ? 'turnover' : 'half-life'
  const decayReason = useTurnover
    ? null
    : opts.isHk === true
      ? '港股 vol/amount 的缩放与 A股不同（实测比值≈9926，单位未标定）⇒ 未标定前不能按换手率口径算，回落固定半衰期 10 日'
      : '缺当日流通市值（floatMv，新浪备用源不提供）⇒ 回落固定半衰期 10 日'
  // 逐日递推：先算每天新增权重贡献，再按"旧筹码被换掉"的比例衰减历史
  const days: ChipDay[] = []
  let hist = new Array<number>(buckets).fill(0)
  /** 实际生效的衰减因子（取整段里最小的那个）——用来在口径里如实写"夹到 0"这件事 */
  let minFactor = Number.POSITIVE_INFINITY
  let clamped = false
  let peakSum = 0
  for (let i = 0; i < win.length; i += 1) {
    const b = win[i]
    let w: number
    if (useTurnover) {
      // t_i = 成交额 ÷ 流通市值（= 换手率）；vol 是"手" ⇒ ×100 得股数（上游 A股口径）
      const amount = b.vol === null ? null : b.vol * 100 * b.close
      const raw = amount === null ? null : amount / (opts.floatMv as number)
      const t = raw === null ? null : Math.min(cap, Math.max(0, raw))
      // 新增筹码权重 = 当日换手率（夹到 cap）；下面递推里乘的换手率因子也用同一个 t
      w = t === null ? 0 : t
    } else {
      // 半衰期：越近的 bar 权重越大（k=0 是最近）
      const k = win.length - 1 - i
      w = 0.5 ** (k / halfLife)
    }
    // 递推式（用户口径）：chips_t = chips_{t-1} × max(0, 1 − t_t×k) + new_t
    //  `t_t` = 当日换手率 = 成交额 ÷ 流通市值（等价于 成交量 ÷ 流通股本）；`k` = 衰减系数（默认 1.5）
    //  `1 − t_t×k` 可能为负 ⇒ **必须**夹到 0（旧筹码全清），并把**实际生效的因子**写进口径字符串
    const rawFactor = useTurnover ? 1 - w * kFactor : 0.5 ** (1 / halfLife)
    const decayFactor = Math.max(0, rawFactor)
    if (decayFactor < minFactor) minFactor = decayFactor
    if (rawFactor < 0) clamped = true
    const lowBar = (b as { low?: number }).low ?? b.close
    const highBar = (b as { high?: number }).high ?? b.close
    peakSum += (highBar + lowBar + b.close) / 3
    for (let x = 0; x < buckets; x += 1) hist[x] *= decayFactor
    // 新增筹码按形状铺到当日价格区间（三角形峰在当日均价）
    allocateSpread(hist, centers, lowBar, highBar, w, shape, peakAfter(lowBar, highBar, b.close))
    const total = hist.reduce((s, x) => s + x, 0)
    const norm = total > 0 ? hist.map((x) => x / total) : hist
    const avg = total > 0 ? centers.reduce((s, c, x) => s + c * norm[x], 0) : null
    const support = percentilePrice(norm, centers, 0.05)
    const resistance = percentilePrice(norm, centers, 0.95)
    const narrow = support !== null && resistance !== null && (resistance - support) / (high - low) < CHIPS_NARROW_RATIO
    const price = opts.price === undefined ? null : opts.price
    const profitRatio = price === null || total <= 0
      ? null
      : norm.reduce((s, x, idx) => (centers[idx] < price ? s + x : s), 0)
    days.push({
      date: b.date,
      buckets: norm.map((x) => round(x, 6)),
      centers: centers.map((c) => round(c, 4)),
      avgCost: avg === null ? null : round(avg, 4),
      support: support === null ? null : round(support, 4),
      resistance: resistance === null ? null : round(resistance, 4),
      narrow,
      profitRatio: profitRatio === null ? null : round(profitRatio * 100, 2),
      samples: i + 1,
    })
  }
  const latest = days[days.length - 1] ?? null
  return {
    ...base,
    days,
    latest,
    decay,
    decayReason,
    avgCost: latest?.avgCost ?? null,
    support: latest?.support ?? null,
    resistance: latest?.resistance ?? null,
    narrow: latest?.narrow ?? false,
    profitRatio: latest?.profitRatio ?? null,
    methodology:
      (useTurnover
        ? `递推式：chips_t = chips_{t-1} × max(0, 1 − t_t×k) + new_t；` +
          `t_t = 当日换手率 = 成交额 ÷ 流通市值（等价于 成交量 ÷ 流通股本；cap=${cap}）` +
          `，逐日历史流通市值不可得 ⇒ 用当前 floatMv 近似（东财/腾讯市值字段）。`
        : `递推式：chips_t = chips_{t-1} × 0.5^(1/${halfLife}) + new_t（固定半衰期 ${halfLife} 日）—— ${decayReason ?? ''}`) +
      `衰减系数 k=${kFactor}（越大越强调近期筹码；>1 时旧筹码衰减更快）` +
      (clamped ? `；本段出现过 1−t×k < 0 的极端换手，因子已夹到 0（旧筹码全清），实际最小生效因子 ${minFactor.toFixed(4)}` : `；实际最小生效因子 ${Number.isFinite(minFactor) ? minFactor.toFixed(4) : '—'}`) +
      `。新增筹码按${shape === 'triangle' ? '三角形分布（峰在当日均价 (high+low+close)/3）' : '均匀分布'}铺到当日 [low, high]` +
      `（均价均值 ${(peakSum / Math.max(1, win.length)).toFixed(4)}）；` +
      `窗口${samples === window ? `${window} 根` : `近 ${samples} 根（实际不足 ${window} 根）`}日线（fqt=1 前复权）；` +
      `桶数 ${buckets}；支撑/压力 = 筹码累积分布的 P5/P95 价位；平均成本 = Σ(桶价×权重)/Σ权重；盈利比例 = Σ(桶价 < 现价 的权重)/Σ权重。`,
  }
}
