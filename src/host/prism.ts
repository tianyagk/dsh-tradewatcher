/**
 * 【棱镜】只读推演的**宿主侧实现**（六块 + 参数解析 + 聚合 + 路由回包）。
 *
 * 三条不可越的线（断言见 `src/host/prism.test.ts`）：
 *  ① **永远 200**：`prismResponse()` 从不抛；缺数据一律 `null` + `reason`（**不写 0**）。
 *  ② **只读推演**：不写任何文件、不下单、不连券商；所有数字都由既有 5 分钟线与五档盘口现算。
 *  ③ **不编数**：输入不可得 ⇒ 该块 `available:false` + 一句原因；`available:true` ⇒ `samples > 0`。
 *
 * ## 六块的口径（都在这里写死，页面只显示值与规则名）
 *  1. **Bayes 认知**：`p = sigmoid(logit(prior) + 0.35·量能z + 0.45·(2·位置−1) + 0.5·连续性)`。
 *     三个特征都是**粗粒度 bar 特征**（量能 z / 滚动高低位置 / 近 3 根涨跌连续性）；
 *     这是**简化模型**（固定权重、无拟合），页面顶部必须写明（`PRISM_MODEL`）。
 *  2. **Edge 优势**：`EV = p·平均盈利 − (1−p)·平均亏损 − 成本`，单位 bps（万分之一）。
 *     成本 = 手续费 + 滑点 + **延迟惩罚**（`σ_bar × √(延迟 ÷ 一根的毫秒)`：把延迟折算成
 *     一个"量级"上的漂移，不是报价）。平均盈利/亏损来自**同周期历史 bar 实测**（只计同日相邻）。
 *     三态结论：EV ≤ 阈值 ⇒ `不下结论`；否则 p ≥ 0.5 ⇒ `看多`，else `看空`。
 *  3. **Spread 价差**：只支持两标的配对，`S = ln(A/B)`，`z = (S−μ)/σ`（μ/σ 用**不含当根**的
 *     前 zN 根）；只给 z、mid 与是否越阈 —— **不给挂单价 δ**（本插件没有可定价差的挂单数据）。
 *  4. **Stoikov 保留价**：`r = s − q·γ·σ²·(T−t)`（模拟量：q 是"模拟库存"，σ² 来自 bar 收益）。
 *     **T−t 保护**：`T−t < 0.5 根`、或 `|r−s| > 20%·s`、或输入非有限 ⇒ 夹回 `s` 并标 `protected`。
 *  5. **Kelly 仓位**：`f* = (b·p − (1−p))/b`，`b = 平均盈利/平均亏损`，再乘分数系数。
 *     页面标题与数值固定带「模拟」（防误读为实盘仓位 —— 属口径，不是注解）。
 *  6. **Monte Carlo 风控**：≥1 万次、固定种子（可复现）。四条假设**全部上屏**：
 *     成交率、滑点、延迟、p 误差。输出 MDD 的 P50/P95、破产概率（资金 ≤ 起点 50%）、
 *     中位资金曲线（每步取全样本中位）。
 *
 * ## 频率与降频
 * 10/30 分钟**由 5 分钟聚合**（`aggregateBars`，按交易时段锚定：上午 09:30–11:30、下午 13:00–15:00，
 * 每 6 根 5 分钟 = 1 根 30 分钟）。输入不足时按「先降频（5 → 10 → 30）」逐档重试，
 * 足迹记进回包的 `downgrade`（页面如实显示）。⚠ 单测与实盘都证明：**降频不增加样本数**
 * （同一段 5 分钟线聚合后根数只会更少），所以它只在"某些频率的聚合桶能凑够最小样本"时有用；
 * 真凑不够时回包照样是 `—` + 三档尝试的全量原因（不认输，但也不编）。
 */
import {
  PRISM_BARS_MAX,
  PRISM_BLOCK_KEYS,
  PRISM_DEFAULT_PARAMS,
  PRISM_FREQS,
  PRISM_MIN_SAMPLES,
  type PrismAssumption,
  type PrismBayesBlock,
  type PrismBlocks,
  type PrismBook,
  type PrismEdgeBlock,
  type PrismFreq,
  type PrismKellyBlock,
  type PrismMcBlock,
  type PrismParams,
  type PrismPayload,
  type PrismSpreadBlock,
  type PrismStance,
  type PrismStoikovBlock,
  type PrismTarget,
} from '../shared/prism.ts'
import { log } from './context.ts'
import { fetchFiveLevelBook, fetchFiveMinuteBars, type PrismBar, type PrismFeed } from './prismFeed.ts'

/* ────────────────────────────── 常量（写死一处，避免页面/测试各抄一份） ────────────────────────────── */

/** 量能 z / 价格位置用的滚动窗口（根） */
export const PRISM_ROLL = 20
/** Bayes 的固定权重（简化模型的一部分；页面只写"固定权重"，不展开公式） */
export const PRISM_WEIGHTS = { volZ: 0.35, pos: 0.45, streak: 0.5 } as const
/** p 的显示夹取（避免 0/1 这种"确定"的口气） */
export const PRISM_P_CLAMP = [0.02, 0.98] as const
/** 历史平均盈利/亏损至少各要几根（不足 ⇒ 该块不可算） */
export const PRISM_MIN_WIN = 5
export const PRISM_MIN_LOSS = 5
/** ATR 窗口（根） */
export const PRISM_ATR_N = 14
/** Stoikov 的保护阈值：T−t < 0.5 根 ⇒ 夹回 s；偏离 > 20% ⇒ 夹到 ±20% */
export const PRISM_PROTECT_TT = 0.5
export const PRISM_PROTECT_DRIFT = 0.2
/** MC 的交易笔数（固定；次数是参数） */
export const PRISM_MC_TRADES = 240
/** MC 的固定种子（同一组参数必得同一结果 ⇒ 可复现、可断言） */
export const PRISM_MC_SEED = 20261021
/** MC 的破产口径：资金 ≤ 起点 50% */
export const PRISM_MC_RUIN = 0.5
/** MC 次数下限（需求：≥1 万次）与上限（防一次请求跑太久） */
export const PRISM_MC_MIN_RUNS = 10_000
export const PRISM_MC_MAX_RUNS = 50_000
/** 目标价规则 id ↔ 规则名（页面必须显示规则名；不许只给裸数字） */
export const PRISM_TARGET_RULES = { atrK: 'ATR×k', histP95: '历史 P95' } as const

/* ────────────────────────────── 参数解析（永不抛） ────────────────────────────── */

const numOr = (raw: string | null, fallback: number, lo: number, hi: number): number => {
  const n = raw === null || raw.trim() === '' ? Number.NaN : Number(raw)
  if (!Number.isFinite(n)) return fallback
  return Math.min(hi, Math.max(lo, n))
}

const freqOf = (raw: string | null): PrismFreq => {
  const n = Number(raw)
  return (PRISM_FREQS as readonly number[]).includes(n) ? (n as PrismFreq) : PRISM_DEFAULT_PARAMS.freq
}

/** 解析 query（缺省/非法一律回落默认值；**不 400** —— 这些是推演参数，不是用户输入错误） */
export function parsePrismQuery(query: URLSearchParams): PrismParams {
  const pairB = (query.get('pairB') ?? '').trim()
  return {
    freq: freqOf(query.get('freq')),
    pairA: (query.get('pairA') ?? '').trim(),
    pairB: pairB === '' ? null : pairB,
    zN: Math.round(numOr(query.get('zN'), PRISM_DEFAULT_PARAMS.zN, 10, 240)),
    prior: numOr(query.get('prior'), PRISM_DEFAULT_PARAMS.prior, 0.2, 0.8),
    feeBps: numOr(query.get('feeBps'), PRISM_DEFAULT_PARAMS.feeBps, 0, 100),
    slipBps: numOr(query.get('slipBps'), PRISM_DEFAULT_PARAMS.slipBps, 0, 100),
    latencyMs: Math.round(numOr(query.get('latencyMs'), PRISM_DEFAULT_PARAMS.latencyMs, 0, 10_000)),
    evMinBps: numOr(query.get('evMinBps'), PRISM_DEFAULT_PARAMS.evMinBps, -100, 200),
    zTh: numOr(query.get('zTh'), PRISM_DEFAULT_PARAMS.zTh, 1, 5),
    gamma: numOr(query.get('gamma'), PRISM_DEFAULT_PARAMS.gamma, 0, 1),
    q: Math.round(numOr(query.get('q'), PRISM_DEFAULT_PARAMS.q, -1000, 1000)),
    ttBars: numOr(query.get('ttBars'), PRISM_DEFAULT_PARAMS.ttBars, 0, 240),
    kellyFrac: numOr(query.get('kellyFrac'), PRISM_DEFAULT_PARAMS.kellyFrac, 0.05, 1),
    tgtK: numOr(query.get('tgtK'), PRISM_DEFAULT_PARAMS.tgtK, 0.5, 5),
    mcRuns: Math.round(numOr(query.get('mcRuns'), PRISM_DEFAULT_PARAMS.mcRuns, PRISM_MC_MIN_RUNS, PRISM_MC_MAX_RUNS)),
    mcFill: numOr(query.get('mcFill'), PRISM_DEFAULT_PARAMS.mcFill, 0.1, 1),
    mcPErr: numOr(query.get('mcPErr'), PRISM_DEFAULT_PARAMS.mcPErr, 0, 0.3),
  }
}

/* ────────────────────────────── 聚合（10/30 分钟） ────────────────────────────── */

const MIN_OF_DAY = (hhmm: string): number | null => {
  const h = Number(hhmm.slice(0, 2))
  const m = Number(hhmm.slice(3, 5))
  if (!Number.isFinite(h) || !Number.isFinite(m)) return null
  return h * 60 + m
}

/**
 * 一根 5 分钟 bar 所属的**时段桶**（按交易时段锚定，午餐休市不合并）。
 *
 * bar 的 label 是**收盘时刻**（上游口径：09:35..11:30、13:05..15:00），所以用 `收盘 − 5 分钟`
 * 作为该根的**起点**再分桶：09:35/09:40/…/10:00 这 6 根起于 09:30–09:55 ⇒ 全部落在 30 分钟的第 0 桶。
 * 这正是断言「6 根 5 分钟 ⇒ 1 根 30 分钟」的口径；写错首/末（例如用收盘时刻分桶）会让 10:00 掉进第 1 桶。
 */
export function prismBucketOf(bar: PrismBar, freq: PrismFreq): string | null {
  if (freq === 5) return null
  const hhmm = bar.label.slice(11)
  const end = MIN_OF_DAY(hhmm)
  if (end === null) return null
  const start = end - 5
  const morning = 9 * 60 + 30
  const morningEnd = 11 * 60 + 30
  const afternoon = 13 * 60
  const afternoonEnd = 15 * 60
  let offset: number | null = null
  if (start >= morning && start < morningEnd) offset = start - morning
  else if (start >= afternoon && start < afternoonEnd) offset = morningEnd - morning + (start - afternoon)
  if (offset === null) return null
  return String(Math.floor(offset / freq))
}

/**
 * 把 5 分钟线聚合成 `freq` 分钟（5 ⇒ 原样返回）。OHLC 口径：开=首根开、收=末根收、高=max、低=min；
 * **量**：任一分量缺失 ⇒ `null`（不拿已知部分冒充整根）；`partial` = 该桶根数不足 `freq/5`（当根未收满）。
 */
export function aggregateBars(bars: readonly PrismBar[], freq: PrismFreq): PrismBar[] {
  const sorted = [...bars].sort((a, b) => a.t - b.t)
  if (freq === 5) return sorted
  const groups: PrismBar[][] = []
  const index = new Map<string, number>()
  for (const bar of sorted) {
    const day = bar.label.slice(0, 10)
    const bucket = prismBucketOf(bar, freq)
    // 落在时段之外的 bar（上游偶尔给 09:30 那种）单独成组，避免把不同时段硬并进一个桶
    const key = bucket === null ? `${day}#x${groups.length}` : `${day}#${bucket}`
    const at = index.get(key)
    if (at === undefined) {
      index.set(key, groups.length)
      groups.push([bar])
    } else {
      ;(groups[at] as PrismBar[]).push(bar)
    }
  }
  const expect = freq / 5
  return groups.map((group) => {
    const first = group[0] as PrismBar
    const last = group[group.length - 1] as PrismBar
    let high = first.high
    let low = first.low
    let vol: number | null = 0
    for (const b of group) {
      if (b.high > high) high = b.high
      if (b.low < low) low = b.low
      if (b.vol === null) vol = null
      else if (vol !== null) vol += b.vol
    }
    return { t: last.t, label: last.label, open: first.open, high, low, close: last.close, vol, partial: group.length < expect }
  })
}

/** 频率口径一句话（页面常驻显示；降频时把原因带上） */
export function freqNoteOf(freq: PrismFreq, downgraded: boolean): string {
  if (freq === 5) return '5 分钟（原始档）'
  const n = freq / 5
  return `${freq} 分钟（5 分钟聚合 ${n} 根${downgraded ? '；已降频' : ''}）`
}

/* ────────────────────────────── 统计小工具 ────────────────────────────── */

const mean = (xs: readonly number[]): number | null => (xs.length === 0 ? null : xs.reduce((a, b) => a + b, 0) / xs.length)

const sd = (xs: readonly number[]): number | null => {
  if (xs.length < 2) return null
  const m = mean(xs)
  if (m === null) return null
  const v = xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1)
  return v > 0 ? Math.sqrt(v) : 0
}

const quantile = (xs: readonly number[], q: number): number | null => {
  if (xs.length === 0) return null
  const s = [...xs].sort((a, b) => a - b)
  const pos = (s.length - 1) * q
  const lo = Math.floor(pos)
  const hi = Math.ceil(pos)
  const a = s[lo] as number
  const b = s[hi] as number
  return a + (b - a) * (pos - lo)
}

const sigmoid = (x: number): number => 1 / (1 + Math.exp(-x))
const logit = (p: number): number => Math.log(p / (1 - p))
const clamp = (x: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, x))

/** 同日相邻两根的收益（bps）；最后一根若是未收满的聚合桶 ⇒ 不参与（它的收盘还会变） */
export function barReturnsBps(bars: readonly PrismBar[]): number[] {
  const out: number[] = []
  for (let i = 1; i < bars.length; i += 1) {
    const prev = bars[i - 1] as PrismBar
    const cur = bars[i] as PrismBar
    if (prev.label.slice(0, 10) !== cur.label.slice(0, 10)) continue // 隔夜跳空不是这根 bar 的走势
    if (cur.partial === true) continue
    if (!(prev.close > 0) || !(cur.close > 0)) continue
    out.push((cur.close / prev.close - 1) * 10_000)
  }
  return out
}

/** 每根 bar 的价格方差 σ²（价格单位²）—— Stoikov 用；收益不足 5 根 ⇒ null */
export function sigmaSqOf(bars: readonly PrismBar[], s: number): number | null {
  const rets = barReturnsBps(bars)
  if (rets.length < 5) return null
  const rel = sd(rets.map((bps) => bps / 10_000))
  if (rel === null) return null
  return (rel * s) ** 2
}

/**
 * 延迟惩罚（bps）：`σ_bar(bps) × √(延迟ms ÷ 一根的毫秒)`。
 *
 * 口径：把延迟折算成"这段时间里价格漂移的量级"（平方根缩放），**不是报价、不是滑点**；
 * 参数可见、公式名在页面标签上（`延迟惩罚`），页面不展开推导。
 */
export function latencyPenaltyBps(sigmaBarBps: number | null, latencyMs: number, freq: PrismFreq): number | null {
  if (sigmaBarBps === null || !Number.isFinite(sigmaBarBps)) return null
  if (latencyMs <= 0) return 0
  return sigmaBarBps * Math.sqrt(latencyMs / (freq * 60_000))
}

/* ────────────────────────────── 六块 ────────────────────────────── */

interface Features {
  volZ: number | null
  pos: number | null
  streak: number | null
  why: string | null
}

/** 最后一根的三个粗粒度特征（缺任一 ⇒ `why` 给原因，整块不可算） */
export function featuresAt(bars: readonly PrismBar[], i = bars.length - 1): Features {
  const cur = bars[i]
  if (cur === undefined) return { volZ: null, pos: null, streak: null, why: '没有可用的 bar' }
  const from = Math.max(0, i - PRISM_ROLL + 1)
  const win = bars.slice(from, i + 1)
  // 量能 z：窗口内成交量（含当根）
  let volZ: number | null = null
  let why: string | null = null
  if (cur.vol === null) {
    why = '当根成交量缺失（上游没给量）⇒ 量能 z 不可算'
  } else if (win.some((b) => b.vol === null)) {
    why = '窗口内有 bar 缺成交量 ⇒ 量能 z 不可算'
  } else {
    const vols = win.map((b) => b.vol as number)
    const m = mean(vols)
    const s = sd(vols)
    if (m === null || s === null) why = '量能样本不足 ⇒ 量能 z 不可算'
    else if (s === 0) why = '窗口内成交量没有波动（σ=0）⇒ 量能 z 不可算'
    else volZ = ((cur.vol as number) - m) / s
  }
  // 价格位置：滚动高低区间内的相对位置（0=区间低点，1=区间高点）
  let pos: number | null = null
  const hi = Math.max(...win.map((b) => b.high))
  const lo = Math.min(...win.map((b) => b.low))
  if (!(hi > lo)) {
    if (why === null) why = '窗口内最高=最低（无波动）⇒ 价格位置不可算'
  } else pos = clamp((cur.close - lo) / (hi - lo), 0, 1)
  // 连续性：近 3 根同日相邻涨跌之和 / 3；没有同日相邻 ⇒ 记 0（不编方向）
  const day = cur.label.slice(0, 10)
  let sum = 0
  let pairs = 0
  for (let k = i; k > 0 && pairs < 3; k -= 1) {
    const a = bars[k - 1] as PrismBar
    const b = bars[k] as PrismBar
    if (a.label.slice(0, 10) !== day || b.label.slice(0, 10) !== day) break
    sum += Math.sign(b.close - a.close)
    pairs += 1
  }
  const streak = pairs === 0 ? 0 : sum / pairs
  return { volZ, pos, streak, why }
}

/** 单根的（简化模型）上涨概率 */
export function pAt(bars: readonly PrismBar[], i: number, prior: number): number | null {
  const f = featuresAt(bars, i)
  if (f.volZ === null || f.pos === null) return null
  const z = logit(prior) + PRISM_WEIGHTS.volZ * f.volZ + PRISM_WEIGHTS.pos * (2 * f.pos - 1) + PRISM_WEIGHTS.streak * (f.streak ?? 0)
  return clamp(sigmoid(z), PRISM_P_CLAMP[0], PRISM_P_CLAMP[1])
}

export function bayesBlock(bars: readonly PrismBar[], params: PrismParams): PrismBayesBlock {
  const f = featuresAt(bars)
  if (bars.length <= PRISM_ROLL) {
    return {
      available: false,
      reason: `样本不足：只有 ${bars.length} 根，量能 z / 位置窗口需要 ≥ ${PRISM_ROLL + 1} 根`,
      samples: bars.length,
      prior: params.prior,
      p: null,
      series: [],
      features: { volZ: null, pos: null, streak: null },
    }
  }
  if (f.volZ === null || f.pos === null) {
    return {
      available: false,
      reason: f.why ?? '量能 z 或价格位置不可算',
      samples: bars.length,
      prior: params.prior,
      p: null,
      series: [],
      features: { volZ: f.volZ, pos: f.pos, streak: f.streak },
    }
  }
  const p = pAt(bars, bars.length - 1, params.prior)
  if (p === null) {
    return {
      available: false,
      reason: '量能 z 或价格位置不可算',
      samples: bars.length,
      prior: params.prior,
      p: null,
      series: [],
      features: f,
    }
  }
  const series: number[] = []
  for (let i = PRISM_ROLL; i < bars.length; i += 1) {
    const v = pAt(bars, i, params.prior)
    if (v !== null) series.push(v)
  }
  return {
    available: true,
    reason: null,
    samples: bars.length,
    prior: params.prior,
    p,
    series: series.slice(-120),
    features: { volZ: f.volZ, pos: f.pos, streak: f.streak },
  }
}

interface EdgeStats {
  wins: number[]
  losses: number[]
  sigma: number | null
  returns: number
}

export function edgeStatsOf(bars: readonly PrismBar[]): EdgeStats {
  const rets = barReturnsBps(bars)
  const wins = rets.filter((r) => r > 0)
  const losses = rets.filter((r) => r < 0).map((r) => Math.abs(r))
  return { wins, losses, sigma: sd(rets), returns: rets.length }
}

/** ATR（真实波幅均值，窗口 `PRISM_ATR_N`）；同日首根用 high−low（没有前收） */
export function atrOf(bars: readonly PrismBar[]): number | null {
  const usable = bars.filter((b) => b.partial !== true)
  if (usable.length < 2) return null
  const from = Math.max(1, usable.length - PRISM_ATR_N)
  const trs: number[] = []
  for (let i = from; i < usable.length; i += 1) {
    const cur = usable[i] as PrismBar
    const prev = usable[i - 1] as PrismBar
    const prevClose = prev.label.slice(0, 10) === cur.label.slice(0, 10) ? prev.close : null
    trs.push(
      prevClose === null
        ? cur.high - cur.low
        : Math.max(cur.high - cur.low, Math.abs(cur.high - prevClose), Math.abs(cur.low - prevClose)),
    )
  }
  if (trs.length === 0) return null
  return mean(trs)
}

/**
 * 三态结论 + 目标价。
 *
 * 目标价**必须由可复算规则给出**（规则名 + 全部输入都进回包）：`ATR×k` 与 `历史 P95（|bar 收益|）`。
 * `stance === 不下结论` ⇒ 不给目标价（数组为空）——不硬给方向。
 */
export function edgeBlock(bars: readonly PrismBar[], p: number | null, params: PrismParams): PrismEdgeBlock {
  const st = edgeStatsOf(bars)
  const base = {
    available: false,
    reason: null as string | null,
    samples: st.returns,
    p,
    avgWinBps: null as number | null,
    avgLossBps: null as number | null,
    feeBps: params.feeBps,
    slipBps: params.slipBps,
    latencyPenaltyBps: null as number | null,
    costBps: null as number | null,
    evBps: null as number | null,
    thresholdBps: params.evMinBps,
    stance: '不下结论' as PrismStance,
    stanceWhy: '',
    targets: [] as PrismTarget[],
  }
  if (p === null) {
    return { ...base, reason: 'p 不可算（Bayes 块没有输入）⇒ EV 不可算', stanceWhy: 'p 不可算，不下结论' }
  }
  if (st.wins.length < PRISM_MIN_WIN || st.losses.length < PRISM_MIN_LOSS) {
    return {
      ...base,
      reason: `历史样本不足：上涨 ${st.wins.length} 根 / 下跌 ${st.losses.length} 根（各需 ≥ ${PRISM_MIN_WIN}/${PRISM_MIN_LOSS}）`,
      stanceWhy: '平均盈利/亏损不可算，不下结论',
    }
  }
  const avgWinBps = mean(st.wins) as number
  const avgLossBps = mean(st.losses) as number
  const penalty = latencyPenaltyBps(st.sigma, params.latencyMs, params.freq)
  if (penalty === null) {
    return { ...base, avgWinBps, avgLossBps, reason: '收益波动 σ 不可算（样本不足）⇒ 延迟惩罚不可算', stanceWhy: '成本不可算，不下结论' }
  }
  const costBps = params.feeBps + params.slipBps + penalty
  const evBps = p * avgWinBps - (1 - p) * avgLossBps - costBps
  const stance: PrismStance = evBps > params.evMinBps ? (p >= 0.5 ? '看多' : '看空') : '不下结论'
  const stanceWhy = evBps > params.evMinBps
    ? `EV ${evBps.toFixed(2)}bps > 阈值 ${params.evMinBps}bps，p ${p.toFixed(3)} ${p >= 0.5 ? '≥' : '<'} 0.5`
    : `EV ${evBps.toFixed(2)}bps ≤ 阈值 ${params.evMinBps}bps ⇒ 不下结论`
  const targets: PrismTarget[] = []
  if (stance !== '不下结论') {
    const dir = stance === '看多' ? 1 : -1
    const usable = bars.filter((b) => b.partial !== true)
    const last = usable[usable.length - 1]
    const close = last?.close ?? null
    const atr = atrOf(bars)
    targets.push({
      rule: 'atr-k',
      ruleLabel: PRISM_TARGET_RULES.atrK.replace('k', String(params.tgtK)),
      value: close !== null && atr !== null ? close + dir * params.tgtK * atr : null,
      reason: close === null || atr === null ? '最新收盘或 ATR 不可算（可用 bar 不足）' : null,
      inputs: { close, atr, k: params.tgtK, dir },
    })
    // 用**|bar 收益| 的 95 分位**（= 上涨样本 ∪ 下跌样本的绝对值）：
    // 同一个规则对看多/看空都成立（看多用它当上行空间、看空当下行空间），不会出现
    // "看空却拿上涨分布定价"这种不对称口径。
    const p95 = quantile([...st.wins, ...st.losses], 0.95)
    targets.push({
      rule: 'hist-p95',
      ruleLabel: PRISM_TARGET_RULES.histP95,
      value: close !== null && p95 !== null ? close * (1 + (dir * p95) / 10_000) : null,
      reason: close === null || p95 === null ? '最新收盘或历史 P95 不可算（样本不足）' : null,
      inputs: { close, p95Bps: p95, dir },
    })
  }
  return {
    available: true,
    reason: null,
    samples: st.returns,
    p,
    avgWinBps,
    avgLossBps,
    feeBps: params.feeBps,
    slipBps: params.slipBps,
    latencyPenaltyBps: penalty,
    costBps,
    evBps,
    thresholdBps: params.evMinBps,
    stance,
    stanceWhy,
    targets,
  }
}

/** 对齐两根 5 分钟线（同 label；只保留两侧都有、且非未收满的根） */
export function alignBars(a: readonly PrismBar[], b: readonly PrismBar[]): Array<{ a: PrismBar; b: PrismBar }> {
  const index = new Map<string, PrismBar>()
  for (const bar of b) if (bar.partial !== true) index.set(bar.label, bar)
  const out: Array<{ a: PrismBar; b: PrismBar }> = []
  for (const bar of a) {
    if (bar.partial === true) continue
    const mate = index.get(bar.label)
    if (mate !== undefined) out.push({ a: bar, b: mate })
  }
  return out
}

export function spreadBlock(
  barsA: readonly PrismBar[],
  barsB: readonly PrismBar[] | null,
  params: PrismParams,
  bookA: PrismBook,
  bookB: PrismBook | null,
): PrismSpreadBlock {
  const pairB = params.pairB
  const base: PrismSpreadBlock = {
    available: false,
    reason: null,
    samples: 0,
    pairB,
    n: params.zN,
    z: null,
    mu: null,
    sigma: null,
    threshold: params.zTh,
    beyond: null,
    mid: null,
    midSource: '—',
    book: bookA,
  }
  if (pairB === null || barsB === null) {
    return { ...base, reason: '未选择配对标的（pairB 为空）⇒ 价差不可算' }
  }
  const aligned = alignBars(barsA, barsB)
  if (aligned.length < params.zN + 1) {
    return { ...base, samples: aligned.length, reason: `对齐后只有 ${aligned.length} 根（zN=${params.zN} 需要 ≥ ${params.zN + 1} 根）` }
  }
  const series = aligned.map(({ a, b }) => Math.log(a.close / b.close))
  const window = series.slice(-(params.zN + 1))
  const baseline = window.slice(0, -1)
  const current = window[window.length - 1] as number
  const mu = mean(baseline)
  const sigma = sd(baseline)
  if (mu === null || sigma === null || sigma === 0) {
    return { ...base, samples: aligned.length, mu, sigma, reason: '价差 σ=0（窗口内无波动）⇒ z 不可算' }
  }
  const z = (current - mu) / sigma
  const lastA = aligned[aligned.length - 1]?.a as PrismBar
  const lastB = aligned[aligned.length - 1]?.b as PrismBar
  const microA = bookA.microPrice
  const microB = bookB?.microPrice ?? null
  const useBook = microA !== null && microB !== null && microA > 0 && microB > 0
  const mid = useBook ? Math.log((microA as number) / (microB as number)) : Math.log(lastA.close / lastB.close)
  const beyond = z > params.zTh ? 'upper' : z < -params.zTh ? 'lower' : null
  return {
    available: true,
    reason: null,
    samples: aligned.length,
    pairB,
    n: params.zN,
    z,
    mu,
    sigma,
    threshold: params.zTh,
    beyond,
    mid,
    midSource: useBook ? `micro-price（五档，A ${bookA.levels} 档 / B ${bookB?.levels ?? 0} 档）` : '最新收盘（无五档）',
    book: bookA,
  }
}

/**
 * Stoikov 保留价（模拟）：`r = s − q·γ·σ²·(T−t)`。
 *
 * **保护**（断言 ⑧）：`T−t < 0.5 根` ⇒ 夹回 `s`；`|r−s| > 20%·s` ⇒ 夹到 ±20%；
 * 输入非有限 ⇒ 夹回 `s`。三种情况都置 `protected:true` 并给一句原因（页面必须显示）。
 */
export function stoikovBlock(bars: readonly PrismBar[], params: PrismParams, s: number | null, sSource: string): PrismStoikovBlock {
  const base: PrismStoikovBlock = {
    available: false,
    reason: null,
    samples: barReturnsBps(bars).length,
    s,
    sSource,
    gamma: params.gamma,
    sigmaSq: null,
    q: params.q,
    ttBars: params.ttBars,
    reserve: null,
    protected: false,
    protectReason: null,
  }
  if (s === null || !(s > 0)) return { ...base, reason: '中间价 s 不可得（收盘价与五档都没有）' }
  const sigmaSq = sigmaSqOf(bars, s)
  if (sigmaSq === null) return { ...base, reason: 'σ² 不可算（同周期收益不足 5 根）' }
  const raw = s - params.q * params.gamma * sigmaSq * params.ttBars
  if (params.ttBars < PRISM_PROTECT_TT) {
    return { ...base, available: true, sigmaSq, reserve: s, protected: true, protectReason: `T−t ${params.ttBars} 根 < ${PRISM_PROTECT_TT} 根 ⇒ 保留价夹回 s（保护已生效）` }
  }
  if (!Number.isFinite(raw)) {
    return { ...base, available: true, sigmaSq, reserve: s, protected: true, protectReason: 'r 非有限值 ⇒ 夹回 s（保护已生效）' }
  }
  const drift = Math.abs(raw - s)
  if (drift > s * PRISM_PROTECT_DRIFT) {
    const capped = s + Math.sign(raw - s) * s * PRISM_PROTECT_DRIFT
    return {
      ...base,
      available: true,
      sigmaSq,
      reserve: capped,
      protected: true,
      protectReason: `|r−s| > ${PRISM_PROTECT_DRIFT * 100}%·s ⇒ 夹到 ±${PRISM_PROTECT_DRIFT * 100}%（保护已生效）`,
    }
  }
  return { ...base, available: true, sigmaSq, reserve: raw, protected: false, protectReason: null }
}

/** Kelly（模拟）：`f* = (b·p − (1−p)) / b`；f* ≤ 0 ⇒ 0（不押）。`samples` 传 Edge 的收益样本数。 */
export function kellyBlock(
  p: number | null,
  avgWinBps: number | null,
  avgLossBps: number | null,
  params: PrismParams,
  samples = 1,
): PrismKellyBlock {
  const base: PrismKellyBlock = {
    available: false,
    reason: null,
    samples,
    p,
    b: null,
    fStar: null,
    fScaled: null,
    frac: params.kellyFrac,
  }
  if (p === null) return { ...base, reason: 'p 不可算（Bayes 块没有输入）' }
  if (avgWinBps === null || avgLossBps === null || !(avgLossBps > 0)) {
    return { ...base, samples: 0, reason: '平均盈利/亏损不可算（历史样本不足）⇒ 赔率 b 不可得' }
  }
  const b = avgWinBps / avgLossBps
  const fStar = (b * p - (1 - p)) / b
  const fScaled = clamp(fStar, 0, 1) * params.kellyFrac
  return { available: true, reason: null, samples, p, b, fStar, fScaled, frac: params.kellyFrac }
}

/* ────────────────────────────── Monte Carlo ────────────────────────────── */

/** mulberry32（确定性 PRNG；同一 seed 同一条路径） */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * Monte Carlo 风控（模拟）：`runs × trades` 条路径，逐笔按 p±误差 抽输赢、按成交率抽是否成交，
 * 扣成本（手续费 + 滑点 + 延迟惩罚），资金复利累积，记录最大回撤与"资金 ≤ 起点 50%"的破产事件。
 *
 * 四条假设**全部**进 `assumptions`（页面逐条上屏）：成交率、滑点、延迟（→惩罚 bps）、p 误差。
 */
export function assumptionsOf(params: PrismParams, penaltyBps: number | null): PrismAssumption[] {
  return [
    { key: 'fill', label: '成交率', value: params.mcFill, unit: '', source: '页面参数' },
    { key: 'slip', label: '滑点', value: params.slipBps, unit: 'bps', source: '页面参数' },
    {
      key: 'latency',
      label: '延迟',
      value: params.latencyMs,
      unit: 'ms',
      source: penaltyBps === null ? '页面参数（延迟惩罚暂不可算）' : `页面参数（折算 ${penaltyBps.toFixed(2)}bps）`,
    },
    { key: 'pErr', label: 'p 误差', value: params.mcPErr, unit: '±', source: '页面参数' },
  ]
}

export function mcBlock(
  p: number | null,
  avgWinBps: number | null,
  avgLossBps: number | null,
  params: PrismParams,
  penaltyBps: number | null,
): PrismMcBlock {
  const runs = Math.round(clamp(params.mcRuns, PRISM_MC_MIN_RUNS, PRISM_MC_MAX_RUNS))
  const assumptions = assumptionsOf(params, penaltyBps)
  const base: PrismMcBlock = {
    available: false,
    reason: null,
    samples: 0,
    runs,
    trades: PRISM_MC_TRADES,
    assumptions,
    mddP50: null,
    mddP95: null,
    ruinProb: null,
    equity: [],
  }
  if (p === null) return { ...base, reason: 'p 不可算（Bayes 块没有输入）' }
  if (avgWinBps === null || avgLossBps === null) return { ...base, reason: '平均盈利/亏损不可算（历史样本不足）' }
  if (penaltyBps === null) return { ...base, reason: '延迟惩罚不可算（收益 σ 不可得）' }
  const cost = params.feeBps + params.slipBps + penaltyBps
  const rnd = mulberry32(PRISM_MC_SEED)
  const gauss = (): number => {
    // Box-Muller（避免 0 对数的极小概率）
    const u = Math.max(1e-12, rnd())
    const v = rnd()
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v)
  }
  const checkpoints = 24
  const grid: number[][] = Array.from({ length: checkpoints }, () => [])
  const mdds: number[] = []
  let ruin = 0
  for (let r = 0; r < runs; r += 1) {
    let eq = 1
    let peak = 1
    let mdd = 0
    let dead = false
    for (let t = 1; t <= PRISM_MC_TRADES; t += 1) {
      const filled = rnd() < params.mcFill
      if (filled) {
        const pRun = clamp(p + gauss() * params.mcPErr, 0.01, 0.99)
        const win = rnd() < pRun
        const gross = win ? avgWinBps : -avgLossBps
        eq *= 1 + (gross - cost) / 10_000
        if (eq > peak) peak = eq
        const dd = peak > 0 ? (peak - eq) / peak : 0
        if (dd > mdd) mdd = dd
        if (eq <= PRISM_MC_RUIN) {
          dead = true
          break
        }
      }
      if (t % (PRISM_MC_TRADES / checkpoints) === 0) {
        const idx = t / (PRISM_MC_TRADES / checkpoints) - 1
        ;(grid[idx] as number[]).push(eq)
      }
    }
    mdds.push(mdd)
    if (dead || eq <= PRISM_MC_RUIN) ruin += 1
  }
  const equity = grid.map((col) => quantile(col, 0.5) ?? 1)
  return {
    available: true,
    reason: null,
    samples: runs,
    runs,
    trades: PRISM_MC_TRADES,
    assumptions,
    mddP50: (quantile(mdds, 0.5) ?? 0) * 100,
    mddP95: (quantile(mdds, 0.95) ?? 0) * 100,
    ruinProb: ruin / runs,
    equity,
  }
}

/* ────────────────────────────── 组装 ────────────────────────────── */

/** 不可算块的公共字段（`available:false` + 一句原因；`samples` 记实际参与计算的样本数） */
const unavailable = (reason: string, samples = 0): { available: false; reason: string; samples: number } => ({ available: false, reason, samples })

/** 六个块全部置"不可算"（回包永远形状完整；不写 0） */
export function emptyBlocks(reason: string, params: PrismParams = PRISM_DEFAULT_PARAMS): PrismBlocks {
  return {
    bayes: { ...unavailable(reason), prior: PRISM_DEFAULT_PARAMS.prior, p: null, series: [], features: { volZ: null, pos: null, streak: null } },
    edge: {
      ...unavailable(reason),
      p: null, avgWinBps: null, avgLossBps: null, feeBps: 0, slipBps: 0, latencyPenaltyBps: null,
      costBps: null, evBps: null, thresholdBps: 0, stance: '不下结论', stanceWhy: reason, targets: [],
    },
    spread: {
      ...unavailable(reason),
      pairB: null, n: 0, z: null, mu: null, sigma: null, threshold: 2, beyond: null, mid: null,
      midSource: '—',
      book: { available: false, reason, source: null, levels: 0, bids: [], asks: [], microPrice: null },
    },
    stoikov: { ...unavailable(reason), s: null, sSource: '—', gamma: 0, sigmaSq: null, q: 0, ttBars: 0, reserve: null, protected: false, protectReason: null },
    kelly: { ...unavailable(reason), p: null, b: null, fStar: null, fScaled: null, frac: 0 },
    mc: {
      ...unavailable(reason), runs: 0, trades: 0,
      // 假设来自**页面参数**（即便整块不可算，四条假设也必须上屏 —— 断言 ⑨）
      assumptions: assumptionsOf(params, null),
      mddP50: null, mddP95: null, ruinProb: null, equity: [],
    },
  }
}

/** 形状完整、全部 `null` + 同一个原因的空回包（路由的兜底；**永远 200**） */
export function emptyPrismPayload(
  params: PrismParams,
  reason: string,
  asOf = Date.now(),
  universe: Array<{ secid: string; name: string }> = [],
): PrismPayload {
  const blocks = emptyBlocks(reason, params)
  return {
    asOf,
    freq: params.freq,
    freqNote: freqNoteOf(params.freq, false),
    downgrade: null,
    params,
    symbols: { a: params.pairA, b: params.pairB },
    universe,
    bars: { n: 0, from: null, to: null, lastPartial: false, source: null, reason },
    blocks,
    missing: PRISM_BLOCK_KEYS.map((key) => `${key}：${reason}`),
  }
}

/** 一根 bar 是否"未收满"（只有聚合档会置 partial） */
const lastPartialOf = (bars: readonly PrismBar[]): boolean => bars[bars.length - 1]?.partial === true

export interface PrismInput {
  params: PrismParams
  feedA: PrismFeed
  feedB: PrismFeed | null
  bookA: PrismBook
  bookB: PrismBook | null
  asOf?: number
  /** 自选清单（只用于页面选标的；不参与任何计算） */
  universe?: Array<{ secid: string; name: string }>
}

/**
 * 组装回包（纯函数：输入全是已经取到的数据；测试直接喂假数据）。
 *
 * 频率解析：从请求的频率开始，按 5 → 10 → 30 逐档重试，取第一档样本够的；
 * 足迹进 `downgrade`。全部不够 ⇒ 用请求档的（可能为空的）聚合结果，块一律给原因。
 */
export function buildPrismPayload(input: PrismInput): PrismPayload {
  const { params } = input
  const asOf = input.asOf ?? Date.now()
  const bars5 = input.feedA.bars
  const order = PRISM_FREQS.filter((f) => f >= params.freq)
  const attempts: Array<{ freq: PrismFreq; samples: number; usable: boolean }> = []
  let freq = params.freq
  let bars: PrismBar[] = []
  for (const f of order) {
    const agg = aggregateBars(bars5, f)
    const usable = agg.length >= PRISM_MIN_SAMPLES
    attempts.push({ freq: f, samples: agg.length, usable })
    if (usable) {
      freq = f
      bars = agg
      break
    }
  }
  if (bars.length === 0) {
    freq = params.freq
    bars = aggregateBars(bars5, freq)
  }
  const downgraded = freq !== params.freq
  const downgrade = attempts.length > 1 || attempts.some((a) => !a.usable)
    ? {
        requested: params.freq,
        attempts,
        reason: input.feedA.error !== null
          ? input.feedA.error
          : downgraded
            ? `请求 ${params.freq} 分钟样本不足（${attempts.map((a) => `${a.freq}分 ${a.samples} 根`).join(' / ')}），已降频到 ${freq} 分钟`
            : null,
      }
    : null
  const patch: PrismParams = { ...params, freq }
  const usableBars = bars.length >= PRISM_MIN_SAMPLES
  const feedReason = input.feedA.error
  const barReason = feedReason !== null
    ? feedReason
    : usableBars
      ? null
      : `5 分钟线只有 ${bars5.length} 根（${freq} 分钟聚合后 ${bars.length} 根），不足最低样本 ${PRISM_MIN_SAMPLES} 根`

  const bayes = barReason === null ? bayesBlock(bars, patch) : unavailableBayes(barReason)
  const edge = barReason === null ? edgeBlock(bars, bayes.p, patch) : unavailableEdge(barReason, params)
  const bookA = input.bookA
  const s = bookA.microPrice ?? bars.filter((b) => b.partial !== true).at(-1)?.close ?? null
  const sSource = bookA.microPrice !== null ? `micro-price（${bookA.levels} 档）` : '最新收盘（无五档）'
  const stoikov = barReason === null ? stoikovBlock(bars, patch, s, sSource) : unavailableStoikov(barReason, patch)
  const kelly = barReason === null ? kellyBlock(bayes.p, edge.avgWinBps, edge.avgLossBps, patch, edge.samples) : unavailableKelly(barReason, patch)
  const spread = spreadBlock(bars, input.feedB?.bars ?? null, patch, bookA, input.bookB ?? null)
  const mc = barReason === null
    ? mcBlock(bayes.p, edge.avgWinBps, edge.avgLossBps, patch, edge.latencyPenaltyBps)
    : unavailableMc(barReason, patch)
  const blocks: PrismBlocks = { bayes, edge, spread, stoikov, kelly, mc }
  const missing: string[] = []
  for (const key of PRISM_BLOCK_KEYS) {
    const b = blocks[key]
    if (!b.available && b.reason !== null) missing.push(`${key}：${b.reason}`)
  }
  return {
    asOf,
    freq,
    freqNote: freqNoteOf(freq, downgraded),
    downgrade,
    params: patch,
    symbols: { a: params.pairA, b: params.pairB },
    universe: input.universe ?? [],
    bars: {
      n: bars.length,
      from: bars[0]?.label ?? null,
      to: bars[bars.length - 1]?.label ?? null,
      lastPartial: lastPartialOf(bars),
      source: input.feedA.source,
      reason: barReason,
    },
    blocks,
    missing,
  }
}

/* 六个块的"不可算"构造器（集中一处，防止某处忘写 reason） */
function unavailableBayes(reason: string): PrismBayesBlock {
  return { ...unavailable(reason), prior: PRISM_DEFAULT_PARAMS.prior, p: null, series: [], features: { volZ: null, pos: null, streak: null } }
}
function unavailableEdge(reason: string, params: PrismParams): PrismEdgeBlock {
  return {
    ...unavailable(reason), p: null, avgWinBps: null, avgLossBps: null, feeBps: params.feeBps, slipBps: params.slipBps,
    latencyPenaltyBps: null, costBps: null, evBps: null, thresholdBps: params.evMinBps, stance: '不下结论',
    stanceWhy: reason, targets: [],
  }
}
function unavailableStoikov(reason: string, params: PrismParams): PrismStoikovBlock {
  return {
    ...unavailable(reason), s: null, sSource: '—', gamma: params.gamma, sigmaSq: null, q: params.q, ttBars: params.ttBars,
    reserve: null, protected: false, protectReason: null,
  }
}
function unavailableKelly(reason: string, params: PrismParams): PrismKellyBlock {
  return { ...unavailable(reason), p: null, b: null, fStar: null, fScaled: null, frac: params.kellyFrac }
}
function unavailableMc(reason: string, params: PrismParams): PrismMcBlock {
  return {
    ...unavailable(reason), runs: Math.round(params.mcRuns), trades: PRISM_MC_TRADES,
    assumptions: assumptionsOf(params, null),
    mddP50: null, mddP95: null, ruinProb: null, equity: [],
  }
}

/* ────────────────────────────── 回包（永不抛） ────────────────────────────── */

export interface PrismDeps {
  loadBars: (secid: string, datalen: number) => Promise<PrismFeed>
  loadBook: (secid: string) => Promise<PrismBook>
  now: () => number
}

const DEFAULT_DEPS: PrismDeps = { loadBars: fetchFiveMinuteBars, loadBook: fetchFiveLevelBook, now: () => Date.now() }

const safeFeed = async (deps: PrismDeps, secid: string): Promise<PrismFeed> => {
  try {
    return await deps.loadBars(secid, PRISM_BARS_MAX)
  } catch (error) {
    return { bars: [], source: null, volUnit: null, error: `5 分钟线取数异常（${String(error).slice(0, 80)}）` }
  }
}

const safeBook = async (deps: PrismDeps, secid: string): Promise<PrismBook> => {
  try {
    return await deps.loadBook(secid)
  } catch (error) {
    return { available: false, reason: `五档取数异常（${String(error).slice(0, 80)}）`, source: null, levels: 0, bids: [], asks: [], microPrice: null }
  }
}

/**
 * 路由的回包函数：**永远 200**，任何异常都变成形状完整的空回包。
 *
 * 契约（断言 ⑩）：`status` 恒 200；`body.blocks` 恒有六个键；缺数据一律 `null` + `reason`。
 * 唯一非 200 的来源是既有围栏（`needGate`，全站鉴权行为）—— 不在这条函数里。
 */
export async function prismResponse(
  rawQuery: string,
  deps: Partial<PrismDeps> = {},
  universe: Array<{ secid: string; name: string }> = [],
): Promise<{ status: 200; body: PrismPayload }> {
  const d: PrismDeps = { ...DEFAULT_DEPS, ...deps }
  const params = parsePrismQuery(new URLSearchParams(rawQuery))
  try {
    if (params.pairA === '') {
      return { status: 200, body: emptyPrismPayload(params, '未指定标的（pairA 为空）⇒ 六块都不可算', d.now(), universe) }
    }
    const [feedA, feedB, bookA, bookB] = await Promise.all([
      safeFeed(d, params.pairA),
      params.pairB === null ? Promise.resolve(null) : safeFeed(d, params.pairB),
      safeBook(d, params.pairA),
      params.pairB === null ? Promise.resolve(null) : safeBook(d, params.pairB),
    ])
    return {
      status: 200,
      body: buildPrismPayload({ params, feedA, feedB, bookA, bookB, asOf: d.now(), universe }),
    }
  } catch (error) {
    log(`prism response fallback: ${error instanceof Error ? error.message : String(error)}`)
    return { status: 200, body: emptyPrismPayload(params, `回包组装异常（${String(error).slice(0, 80)}）`, d.now(), universe) }
  }
}
