/**
 * 【棱镜】只读推演页的**共享契约**（宿主 `/tradewatcher/prism` 的回包形状 + 页面常量）。
 *
 * 两条硬口径（断言钉住，见 `src/client/prismView.test.ts` / `src/host/prism.test.ts`）：
 *  ① 结论只有三态：`看多 / 看空 / 不下结论`（`PrismStance`）；Edge 不达标必须走 `不下结论`。
 *  ② 注解类文案**一律不上屏**（用户裁决）：页面/本契约/解释层都不留这类文案；
 *     数据事实（缺数据的原因、目标价规则名、`模拟` 口径）照常保留。
 *
 * 「不可算就给原因」：每个块都带 `available` / `reason` / `samples`；
 * `available === false` ⇒ `reason` 必须是一句人话；`available === true` ⇒ `samples > 0`
 * （防"用 0 冒充算出来的数"，断言见 `prismPayloadProblems`）。
 *
 * 目标价必须**由可复算规则给出**：`PrismTarget` 带 `rule`（规则 id）与 `ruleLabel`（规则名，
 * 例如 `ATR×k`、`历史 P95`）+ `inputs`（规则的全部输入），页面不许只显示一个裸数字。
 */

/** 可选频率（分钟）。5 分钟是原始档；10/30 由 5 分钟聚合（聚合函数见 `src/host/prism.ts`）。 */
export const PRISM_FREQS = [5, 10, 30] as const
export type PrismFreq = (typeof PRISM_FREQS)[number]

/** 每个频率至少要有多少根 bar 才算"输入可得"（5 分钟 × 24 = 2 小时） */
export const PRISM_MIN_SAMPLES = 24
/** 一次最多取多少根 5 分钟 bar（新浪 scale=5 实测上限 1023；留余量） */
export const PRISM_BARS_MAX = 720

/** 页面顶部唯一一行模型口径（推演页允许；不进任何块的常驻区） */
export const PRISM_MODEL = '简化模型：固定权重的对数几率更新；不是预测模型'

/** 三态结论（Edge 不达标 ⇒ 不下结论，不许硬给方向） */
export const PRISM_STANCES = ['看多', '看空', '不下结论'] as const
export type PrismStance = (typeof PRISM_STANCES)[number]

/** 页面参数（宿主按同一份名字解析 query；页面用它构造 query ⇒ 切频率只改 `freq`） */
export interface PrismParams {
  freq: PrismFreq
  pairA: string
  /** 配对标的（空 ⇒ Spread 块不可算，给原因） */
  pairB: string | null
  /** 价差 z 的窗口 N */
  zN: number
  /** 先验上涨概率（0.2–0.8；页面两个预设：震荡 0.5 / 趋势 0.55） */
  prior: number
  /** 手续费（bps，按一次进出合计） */
  feeBps: number
  /** 滑点（bps） */
  slipBps: number
  /** 延迟（ms）→ 按 σ 尺度折算成惩罚 bps（见 host 的 `latencyPenaltyBps`） */
  latencyMs: number
  /** Edge 阈值（bps）：EV 必须 > 它才给方向 */
  evMinBps: number
  /** 价差阈值 |z|（2 / 3） */
  zTh: number
  /** Stoikov 风险厌恶 γ */
  gamma: number
  /** 模拟库存 q（份；纯模拟量，不是持仓） */
  q: number
  /** Stoikov 的 T−t：窗口剩余（根） */
  ttBars: number
  /** Kelly 分数系数（1/4、1/2、1） */
  kellyFrac: number
  /** 目标价规则 ATR×k 的 k */
  tgtK: number
  /** Monte Carlo 次数（≥10000） */
  mcRuns: number
  /** MC 假设：成交率 */
  mcFill: number
  /** MC 假设：p 误差（±） */
  mcPErr: number
}

/** 块状态（每个块都有） */
export interface PrismBlockBase {
  /** 输入是否可得（false ⇒ 只显示 `—` + `reason`） */
  available: boolean
  /** 不可算的原因（一句话）；available 时通常 null */
  reason: string | null
  /** 参与计算的样本数；available 时必须 > 0 */
  samples: number
}

/** 目标价（必须带规则名 + 全部输入；value=null 时给 reason） */
export interface PrismTarget {
  /** 规则 id：`atr-k` / `hist-p95` */
  rule: string
  /** 规则名（页面必须显示）：`ATR×k` / `历史 P95` */
  ruleLabel: string
  value: number | null
  reason: string | null
  /** 规则的全部输入 ⇒ 用页面参数 + 历史数据可复算 */
  inputs: Record<string, number | null>
}

export interface PrismBayesBlock extends PrismBlockBase {
  prior: number
  /** 下一根上涨的（简化模型）概率 */
  p: number | null
  /** p 的历史序列（同口径逐根更新，最多 120 点，绘图用） */
  series: number[]
  /** 三个粗粒度特征（最后一根） */
  features: { volZ: number | null; pos: number | null; streak: number | null }
}

export interface PrismEdgeBlock extends PrismBlockBase {
  p: number | null
  avgWinBps: number | null
  avgLossBps: number | null
  feeBps: number
  slipBps: number
  latencyPenaltyBps: number | null
  costBps: number | null
  evBps: number | null
  thresholdBps: number
  /** 三态结论（EV ≤ 阈值 ⇒ `不下结论`） */
  stance: PrismStance
  /** stance 的判据一句话（如 "EV 12.3bps > 阈值 0bps 且 p≥0.5"） */
  stanceWhy: string
  /** 目标价：仅当 stance ≠ 不下结论 时非空；每个都带规则名与输入 */
  targets: PrismTarget[]
}

export interface PrismBookLevel {
  price: number | null
  size: number | null
}

/** 五档盘口（腾讯 `qt.gtimg.cn` / 新浪 `hq.sinajs.cn` 都能给；拿不到 ⇒ available=false + 原因） */
export interface PrismBook {
  available: boolean
  reason: string | null
  source: string | null
  /** 实际可用的档数（1..5） */
  levels: number
  bids: PrismBookLevel[]
  asks: PrismBookLevel[]
  /** 深度加权 micro-price（用 `levels` 档的价×量） */
  microPrice: number | null
}

export interface PrismSpreadBlock extends PrismBlockBase {
  /** 配对标的（pairB 为空时 available=false） */
  pairB: string | null
  n: number
  z: number | null
  mu: number | null
  sigma: number | null
  threshold: number
  /** 越阈方向（null = 未越阈） */
  beyond: 'upper' | 'lower' | null
  /** 价差的最新值 S = ln(A/B)（本插件无买一/卖一"中间价"时的口径见 midSource） */
  mid: number | null
  midSource: string
  /** A 的盘口（五档是否可得；Spread 的 mid 与 Stoikov 的 s 都用它） */
  book: PrismBook
}

export interface PrismStoikovBlock extends PrismBlockBase {
  /** 当前中间价 s（有盘口用 micro-price，否则用最新收盘） */
  s: number | null
  sSource: string
  gamma: number
  /** 每根 bar 的价格方差 σ²（价格单位²） */
  sigmaSq: number | null
  q: number
  ttBars: number
  /** 模拟保留价 r */
  reserve: number | null
  /** T−t→0（或偏离过大）时的保护是否生效 */
  protected: boolean
  protectReason: string | null
}

export interface PrismKellyBlock extends PrismBlockBase {
  p: number | null
  /** 赔率 b = 平均盈利 / 平均亏损 */
  b: number | null
  /** f* = (b·p − (1−p)) / b */
  fStar: number | null
  /** 分数系数缩放后的模拟仓位 */
  fScaled: number | null
  frac: number
}

export interface PrismAssumption {
  key: string
  label: string
  value: number
  unit: string
  /** 值从哪来（页面参数 / 由成本项推导）—— 假设必须全部上屏 */
  source: string
}

export interface PrismMcBlock extends PrismBlockBase {
  runs: number
  trades: number
  assumptions: PrismAssumption[]
  /** 最大回撤分位（%）：P50 / P95 */
  mddP50: number | null
  mddP95: number | null
  /** 破产概率（资金 ≤ 起点 50% 的路径占比） */
  ruinProb: number | null
  /** 中位路径（每步取全样本中位；归一化到起点 1） */
  equity: number[]
}

export interface PrismBlocks {
  bayes: PrismBayesBlock
  edge: PrismEdgeBlock
  spread: PrismSpreadBlock
  stoikov: PrismStoikovBlock
  kelly: PrismKellyBlock
  mc: PrismMcBlock
}

export type PrismBlockKey = keyof PrismBlocks
/** 六个块的固定顺序（断言：块集合恰好是这六个） */
export const PRISM_BLOCK_KEYS: readonly PrismBlockKey[] = ['bayes', 'edge', 'spread', 'stoikov', 'kelly', 'mc']

/** 回包（永远 200；缺数据一律 null + 原因） */
export interface PrismPayload {
  asOf: number
  /** 实际生效的频率（可能因降频而 ≠ 请求值） */
  freq: PrismFreq
  /** 频率口径一句话（如 "30 分钟（5 分钟聚合 6 根）"） */
  freqNote: string
  /** 降频足迹（未降频 ⇒ null） */
  downgrade: { requested: PrismFreq; attempts: Array<{ freq: PrismFreq; samples: number; usable: boolean }>; reason: string | null } | null
  /** 回显全部生效参数（页面据此渲染常驻参数行） */
  params: PrismParams
  symbols: { a: string; b: string | null }
  /** 自选清单（页面用来选配对；空 = 自选为空/读不到 —— 页面仍允许手输代码） */
  universe: Array<{ secid: string; name: string }>
  bars: { n: number; from: string | null; to: string | null; lastPartial: boolean; source: string | null; reason: string | null }
  blocks: PrismBlocks
  /** 不可算项的汇总（一句话一条），供顶部/日志用 */
  missing: string[]
}

/** 默认参数（页面与宿主共用一份，避免两边默认值漂移） */
export const PRISM_DEFAULT_PARAMS: PrismParams = {
  freq: 5,
  pairA: '',
  pairB: null,
  zN: 60,
  prior: 0.5,
  feeBps: 2,
  slipBps: 3,
  latencyMs: 300,
  evMinBps: 0,
  zTh: 2,
  gamma: 0.1,
  q: 0,
  ttBars: 6,
  kellyFrac: 0.5,
  tgtK: 2,
  mcRuns: 10000,
  mcFill: 0.75,
  mcPErr: 0.05,
}
