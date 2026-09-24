/**
 * 【护盘信号】国家队护盘行为的概率性识别。
 *
 * 口径与诚实边界（重要）：
 *  - 汇金/国新/诚通不披露日内成交，本模块识别的是「符合国家队历史行为模式的
 *    宽基 ETF 放量 + 超大单净流入」，输出**概率性信号**，不等于证明买入方身份。
 *  - 超大单为东财按单笔金额的分类口径（非席位数据）；ETF 成交额含做市双边报价与
 *    套利盘，天量 ≠ 净买入，因此始终用「超大单净额」与「量价背离」交叉验证。
 *
 * 阈值来源（全部在 UI 标注，不藏黑箱）：
 *  - F1 量能倍数：历史分位数标定（scripts/calibrate-rescue.mjs，2886 个样本）
 *  - 日内进度曲线：126 个交易日的新浪 5 分钟线标定
 *  - F2 超大单强度：免费源已无日频资金流历史 → 经验锚点，host 采样器自建样本满
 *    20 个交易日后改用自建分位数（thresholdSource = 'self'）
 *
 * 数据文件：<dataHome>/rescue-log.json（60 天滚动）
 * 采样节奏：常态 30s，尾盘（默认 14:30 后）15s，仅交易时段活跃，每次采样 1 个批量请求。
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type {
  RescueConfig, RescueDaySummary, RescueEtfMeta, RescueEtfView, RescueFactor, RescueIntradayPoint,
  RescueLevel, RescueSignalEvent, RescueSnapshot, RescueThresholdSource,
} from '../shared/model.ts'
import { RESCUE_CORE_OUTFLOW_VETO, RESCUE_CORE_INDEXES, RESCUE_PERIPHERAL_FLOW_DISCOUNT, rescueUniverseMeta } from '../shared/model.ts'
import { RESCUE_CALIBRATION } from './rescue-thresholds.ts'
import { dataHome } from './store.ts'

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
const QUOTE_HOSTS = ['push2delay.eastmoney.com', 'push2.eastmoney.com'] as const
const KLINE_HOSTS = ['push2delay.eastmoney.com', 'push2his.eastmoney.com', 'push2.eastmoney.com'] as const

/** 因子权重（合计 1.00） */
export const RESCUE_WEIGHTS = {
  volume: 0.22,
  superflow: 0.26,
  pulse: 0.18,
  persistence: 0.12,
  divergence: 0.14,
  resonance: 0.08,
} as const

/** 兜底脉冲锚点（标定数据缺失时才用；正常走 RESCUE_CALIBRATION.pulseBands） */
export const PULSE_ANCHORS: [number, number, number] = [1.5, 2.5, 4]
/** 尾盘起点（开盘后分钟数）：14:30 */
export const TAIL_FROM_ELAPSED = 180
/** 盘中脉冲的打折系数（真尾盘的大单才更能代表主力意图） */
export const INTRADAY_PULSE_DISCOUNT = 0.6
/** 脉冲「命中」线（分）：对应该时段 P90】 */
export const PULSE_HIT_SCORE = 70
/** 持续性锚点：5 分钟内超大单净增 ÷ 该窗口成交额 → 40/70/100 分 */
export const PERSIST_ANCHORS: [number, number, number] = [0.05, 0.12, 0.25]
/** 核心护盘通道与阈值：定义在 shared，客户端也要用于标注与展示 */
export const CORE_INDEXES = RESCUE_CORE_INDEXES
export const CORE_OUTFLOW_VETO = RESCUE_CORE_OUTFLOW_VETO
export const PERIPHERAL_FLOW_DISCOUNT = RESCUE_PERIPHERAL_FLOW_DISCOUNT

export function isTailElapsed(elapsedMin: number): boolean {
  return elapsedMin >= TAIL_FROM_ELAPSED
}

/** 交易阶段：盘前 / 上午 / 午间 / 午后 / 尾盘 / 已收盘 */
export type RescuePhase = 'pre' | 'am' | 'noon' | 'pm' | 'tail' | 'closed'

export function phaseOf(hhmm: string): RescuePhase {
  if (hhmm < '09:15') return 'pre'
  if (hhmm <= '11:30') return 'am'
  if (hhmm < '13:00') return 'noon'
  if (hhmm < '14:30') return 'pm'
  if (hhmm <= '15:05') return 'tail'
  return 'closed'
}

/** 脉冲因子的名称随阶段变化（盘后不再叫「尾盘突袭」，避免误读为刚发生） */
export function pulseFactorLabel(phase: RescuePhase): string {
  if (phase === 'tail') return '尾盘突袭'
  if (phase === 'closed') return '脉冲（盘后）'
  return '盘中脉冲'
}

/** 取当前时段的脉冲锚点（P75/P90/P95 → 40/70/100） */
export function pulseAnchorsFor(elapsedMin: number): [number, number, number] {
  const bands = RESCUE_CALIBRATION.pulseBands
  if (!Array.isArray(bands) || bands.length === 0) return PULSE_ANCHORS
  const hit = bands.find((b) => elapsedMin >= b.from && elapsedMin <= b.to)
  const b = hit ?? bands[bands.length - 1]
  return [b.p75, b.p90, b.p95]
}

export function pulseBandLabel(elapsedMin: number): string {
  const bands = RESCUE_CALIBRATION.pulseBands
  const hit = Array.isArray(bands) ? bands.find((b) => elapsedMin >= b.from && elapsedMin <= b.to) : undefined
  return hit?.label ?? (isTailElapsed(elapsedMin) ? '尾盘' : '盘中')
}
/** 自建样本满该天数后，F2 改用自建分位数 */
export const SELF_SAMPLE_MIN_DAYS = 20
const KEEP_DAYS = 60
const SAMPLE_RING = 40
/** 写入事件记录的引擎版本（用于在面板上识别旧口径历史事件） */
export const ENGINE_VERSION = '0.13.0'
const INDEX_SECID = '1.000300'
const INDEX_NAME = '沪深300'

interface Sample {
  ts: number
  amount: number
  superNet: number
  mainNet: number
}

interface DayLog {
  events: RescueSignalEvent[]
  intraday: RescueIntradayPoint[]
  samples: number
  gap: boolean
  /** 当日各标的的超大单净额/20日均额 峰值（供 F2 自建分位升级） */
  etfPeak?: Record<string, number>
}

interface LogFile {
  v: number
  days: Record<string, DayLog>
  /** 每只 ETF 的 20 日均成交额基准 */
  baselines: Record<string, { avgAmt20: number; day: string; source: 'em' | 'tencent' | 'calibrated' }>
  /** 自建样本：每只 ETF 每日收盘的超大单净额/20日均额（用于升级 F2 阈值） */
  selfSamples: Record<string, Array<{ day: string; superVsAvg: number }>>
  /** 日内累计成交占比曲线（自建刷新） */
  progressCurve: number[] | null
  progressDays: number
  updatedAt: number
}

/** ── 纯函数（selftest 覆盖）────────────────────────────────────────────── */

/** HH:mm → 开盘后分钟数（0..240，午休折算到 120） */
export function sessionElapsed(hhmm: string): number {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim())
  if (m === null) return -1
  const mins = Number(m[1]) * 60 + Number(m[2])
  if (mins < 570) return 0
  if (mins <= 690) return mins - 570
  if (mins < 780) return 120
  if (mins <= 900) return 120 + (mins - 780)
  return 240
}

/** 日内累计成交占比（曲线索引 i = 开盘后 i*5 分钟），线性插值 */
export function progressAt(curve: readonly number[], elapsedMin: number): number {
  if (curve.length === 0) return elapsedMin >= 240 ? 1 : Math.max(0.02, elapsedMin / 240)
  const e = Math.max(0, Math.min(240, elapsedMin))
  const i = Math.floor(e / 5)
  const j = Math.min(curve.length - 1, i + 1)
  const frac = (e - i * 5) / 5
  const v = curve[i] + (curve[j] - curve[i]) * frac
  return Math.max(0.01, Math.min(1, v))
}

/** 分段线性记分：anchors 依次对应 40 / 70 / 100 分 */
export function interpScore(value: number, anchors: readonly [number, number, number]): number {
  const [a40, a70, a100] = anchors
  if (!Number.isFinite(value) || value <= 0) return 0
  if (value >= a100) return 100
  if (value < a40) return Math.round((40 * value) / a40)
  if (value < a70) return Math.round(40 + (30 * (value - a40)) / (a70 - a40))
  return Math.round(70 + (30 * (value - a70)) / (a100 - a70))
}

/** 量价背离：指数越跌、越符合「恐慌中被托底」的护盘特征 */
export function divergenceScore(indexPct: number | null): number {
  if (indexPct === null || !Number.isFinite(indexPct)) return 50
  if (indexPct <= -1.0) return 100
  if (indexPct <= -0.3) return 80
  if (indexPct < 0) return 60
  if (indexPct <= 0.5) return 35
  return 20
}

/** 全池共振：同时触发的宽基通道数 */
export function resonanceScore(count: number): number {
  if (count >= 3) return 100
  if (count === 2) return 70
  if (count === 1) return 40
  return 0
}

/** 时点系数：午后与尾盘是护盘的典型时点，早盘天量多为情绪 */
export function timeCoefficient(elapsedMin: number): number {
  if (elapsedMin <= 0) return 0.4
  if (elapsedMin < 60) return 0.4
  if (elapsedMin < 120) return 0.7
  if (elapsedMin < 180) return 1.0
  return 1.1
}

export interface RescueFactorInput {
  timeAdjMult: number | null
  /** 核心通道的最大 超大单/20日均额（F2 以核心通道为主） */
  coreSuperVsAvg: number | null
  /** 外围通道的最大 超大单/20日均额（单独净流入时打折） */
  peripheralSuperVsAvg: number | null
  pulseMult: number | null
  /** 持续性：最近窗口内 超大单净增 ÷ 该窗口成交额 */
  persistShare: number | null
  /** 该窗口内单次最大回撤 ÷ 净增（>0.5 说明反复进出，打折） */
  retraceRatio: number | null
  indexPct: number | null
  /** 共振：总只数 / 核心通道命中数 / 外围通道命中数 / 命中通道名 */
  resonance: number
  coreResonance?: number
  peripheralResonance?: number
  resonanceLanes?: string[]
  /** 核心通道中最差的 超大单占比（用于否决） */
  coreWorstShare?: number | null
  /** F2 锚点（可被自建分位数覆盖） */
  f2Anchors: [number, number, number]
  f2Source: RescueThresholdSource
  /** 时点系数；缺省 1（纯函数不读时钟，便于自检） */
  timeCoef?: number
  /** 当前是否为尾盘（14:30 后） */
  isTail?: boolean
  /** 当前时段的脉冲锚点 */
  pulseAnchors?: [number, number, number]
  /** 当前时段标签（早盘/午后/尾盘…） */
  bandLabel?: string
  /** 交易阶段（用于脉冲命名与完整度说明） */
  phase?: RescuePhase
}

/** 因子可用度：数据缺失（如冷启动回填失败）时如实标注，不假装完整 */
export interface RescueCompleteness {
  available: number
  total: number
  missing: string[]
}

export interface RescueScoreResult {
  score: number
  level: RescueLevel
  factors: RescueFactor[]
  summary: string
  completeness: RescueCompleteness
}

const fmt = (v: number | null, unit: string, digits = 2): string => (v === null ? '—' : `${v.toFixed(digits)}${unit}`)
const fmtYi = (v: number | null): string => (v === null ? '—' : `${(v / 1e8).toFixed(2)}亿`)

/**
 * 六因子合成：S = Σ w·f × 时点系数，再施加防误报封顶。
 *
 * P0 修订（针对「早盘噪音被读成护盘」「脉冲过松」「持续性无门槛」）：
 *  - 时点系数**真正接入**（此前 tick 未传，运行时恒为 1 → 早盘满权重）
 *  - F2 以**核心通道**为主：只有外围通道净流入时打折；核心通道大额净流出直接否决
 *  - F3 改名并分档：尾盘（14:30 后）为「尾盘突袭」满分权重，盘中为「盘中脉冲」并打折
 *  - F4 从「连续递增次数」改为**时间 + 幅度**：窗口内净增 ÷ 窗口成交额
 *  - 三级（强护盘）要求核心通道参与共振
 */
export function scoreRescue(input: RescueFactorInput): RescueScoreResult {
  const pulseAnchors = input.pulseAnchors ?? PULSE_ANCHORS
  const isTail = input.isTail ?? false
  const bandLabel = input.bandLabel ?? (isTail ? '尾盘' : '盘中')
  const phase: RescuePhase = input.phase ?? (isTail ? 'tail' : 'pm')

  const f1 = interpScore(input.timeAdjMult ?? 0, [RESCUE_CALIBRATION.f1.mid, RESCUE_CALIBRATION.f1.high, RESCUE_CALIBRATION.f1.extreme])

  // F2：核心通道优先。核心有净流入则以其为准；只有外围在买 → 打折（外围单买不足以证明系统性托底）
  const core = input.coreSuperVsAvg ?? null
  const peri = input.peripheralSuperVsAvg ?? null
  const corePositive = core !== null && core > 0
  const f2Value = corePositive ? (peri !== null ? Math.max(core, peri) : core) : peri !== null ? peri * PERIPHERAL_FLOW_DISCOUNT : 0
  const f2Basis = corePositive ? (peri !== null && peri > core ? '外围主导（已折算）' : '核心通道') : '外围通道（打 0.7 折）'
  const f2 = interpScore(f2Value, input.f2Anchors)

  // F3：脉冲。盘中打折，尾盘满分；命中线为该时段 P90
  const rawPulse = interpScore(input.pulseMult ?? 0, pulseAnchors)
  const f3 = Math.round(rawPulse * (isTail ? 1 : INTRADAY_PULSE_DISCOUNT))

  // F4：持续性 = 窗口内净增 ÷ 窗口成交额（自归一，与采样间隔无关）；反复进出打折
  let f4 = interpScore(input.persistShare ?? 0, PERSIST_ANCHORS)
  const retrace = input.retraceRatio
  if (f4 > 0 && retrace !== null && retrace > 0.5) f4 = Math.round(f4 * 0.6)

  const f5 = divergenceScore(input.indexPct)
  const f6 = resonanceScore(input.resonance)
  const coreRes = input.coreResonance ?? 0
  const periRes = input.peripheralResonance ?? 0

  const factors: RescueFactor[] = [
    {
      id: 'volume', label: '量能放大', score: f1, weight: RESCUE_WEIGHTS.volume,
      actual: fmt(input.timeAdjMult, 'x'),
      threshold: `同时点量能倍数（P75/P90/P95 ${RESCUE_CALIBRATION.f1.mid}/${RESCUE_CALIBRATION.f1.high}/${RESCUE_CALIBRATION.f1.extreme}x 历史标定）`,
      hit: f1 >= 40,
    },
    {
      id: 'superflow', label: '超大单强度', score: f2, weight: RESCUE_WEIGHTS.superflow,
      actual: `${fmt(f2Value, 'x')}（${f2Basis}）`,
      threshold: `核心通道优先：超大单净额/20日均额（${input.f2Anchors[0]}/${input.f2Anchors[1]}/${input.f2Anchors[2]}x，来源 ${input.f2Source === 'self' ? '自建样本分位' : '经验锚点'}）；仅外围净流入打 0.7 折`,
      hit: f2 >= 40,
    },
    {
      id: 'pulse', label: pulseFactorLabel(phase), score: f3, weight: RESCUE_WEIGHTS.pulse,
      actual: `${fmt(input.pulseMult, 'x')}${isTail ? '' : '（打 0.6 折）'}`,
      threshold: `${bandLabel} 时段锚点 ${pulseAnchors[0].toFixed(2)}/${pulseAnchors[1].toFixed(2)}/${pulseAnchors[2].toFixed(2)}x（P75/P90/P95 分档标定）；命中线 ${PULSE_HIT_SCORE} 分`,
      hit: f3 >= PULSE_HIT_SCORE,
    },
    {
      id: 'persistence', label: '持续性', score: f4, weight: RESCUE_WEIGHTS.persistence,
      actual: input.persistShare === null ? '—' : `${(input.persistShare * 100).toFixed(1)}%${retrace !== null && retrace > 0.5 ? `（回撤 ${(retrace * 100).toFixed(0)}% 打折）` : ''}`,
      threshold: `最近 5 分钟超大单净增 ÷ 该窗口成交额（${PERSIST_ANCHORS[0]}/${PERSIST_ANCHORS[1]}/${PERSIST_ANCHORS[2]}），窗口内单次回撤 >50% 净增时打 0.6 折`,
      hit: f4 >= 40,
    },
    {
      id: 'divergence', label: '量价背离', score: f5, weight: RESCUE_WEIGHTS.divergence,
      actual: fmt(input.indexPct, '%'),
      threshold: `${INDEX_NAME} 跌 ≥1.0% 满分；上涨时封顶（追涨天量不是护盘）`,
      hit: f5 >= 60,
    },
    {
      id: 'resonance', label: '全池共振', score: f6, weight: RESCUE_WEIGHTS.resonance,
      actual: `${input.resonance} 只（核心 ${coreRes} / 外围 ${periRes}）${(input.resonanceLanes ?? []).length > 0 ? `：${(input.resonanceLanes ?? []).join('、')}` : ''}`,
      threshold: '同时触发的宽基通道数（按指数去重）；核心通道 = 沪深300/上证50',
      hit: f6 >= 40,
    },
  ]

  const raw = factors.reduce((a, f) => a + f.weight * f.score, 0)
  const coef = input.timeCoef ?? 1
  const score = Math.max(0, Math.min(100, Math.round(raw * coef)))
  const scaled: RescueLevel = score >= 75 ? 3 : score >= 55 ? 2 : score >= 35 ? 1 : 0

  // 防误报约束（每条都写进归因，不做静默降级）
  const caps: string[] = []
  let level = scaled

  // 0) 核心通道否决：沪深300/上证50 出现大额超大单净流出时，不论其它通道如何都不给「疑似护盘」
  const worst = input.coreWorstShare ?? null
  if (worst !== null && worst <= CORE_OUTFLOW_VETO && level > 1) {
    level = 1
    caps.push(`核心通道（${CORE_INDEXES.join('/')}）超大单净流出达成交额的 ${(worst * 100).toFixed(1)}%，与托底特征相反 → 封顶为资金异动`)
  }
  // 1) 护盘的前提是市场承压：指数大涨时的天量更可能是追涨
  const idx = input.indexPct
  if (idx !== null && Number.isFinite(idx)) {
    if (idx > 1.0 && level > 1) {
      level = 1
      caps.push(`指数 +${idx.toFixed(2)}%，放量上涨更可能是追涨而非护盘 → 封顶为资金异动`)
    } else if (idx > 0.3 && level === 3) {
      level = 2
      caps.push(`指数仍上涨 ${idx.toFixed(2)}%，量价背离不成立 → 封顶为疑似护盘`)
    }
  }
  // 2) 强信号必须由核心通道参与
  if (level === 3 && coreRes < 1) {
    level = 2
    caps.push('核心通道（沪深300/上证50）未参与共振 → 降为疑似护盘（外围单买不足以认定系统性护盘）')
  }
  // 3) 强信号必须有真实的超大单净流入
  if (level === 3 && f2 < 70) {
    level = 2
    caps.push('超大单强度未达强信号门槛 → 降为疑似护盘')
  }
  // 4) 疑似信号至少要有量能或资金之一
  if (level === 2 && f2 < 40 && f1 < 70) {
    level = 1
    caps.push('量能与资金流入均未达中档 → 降为资金异动')
  }
  if (f2 < 15 && f4 < 40 && level > 1) {
    level = 1
    caps.push('超大单无有效净流入且持续性不足 → 降为资金异动')
  }

  // 因子可用度：脉冲/持续性在冷启动回填失败时会缺，必须如实标注而不是假装完整
  const availability: Array<[string, boolean]> = [
    ['量能放大', input.timeAdjMult !== null],
    ['超大单强度', core !== null || peri !== null],
    ['脉冲', input.pulseMult !== null],
    ['持续性', input.persistShare !== null],
    ['量价背离', input.indexPct !== null],
    ['全池共振', true],
  ]
  const missing = availability.filter(([, ok]) => !ok).map(([label]) => label)
  const completeness: RescueCompleteness = { available: availability.length - missing.length, total: availability.length, missing }

  const hits = factors.filter((f) => f.hit).map((f) => `${f.label} ${f.actual}`).join(' · ')
  const base = level === 0 || hits === '' ? '宽基 ETF 量能与资金流均在常态区间（无异动）' : hits
  const incomplete = missing.length > 0 ? `；因子 ${completeness.available}/${completeness.total}（缺 ${missing.join('、')}，评分偏保守）` : ''
  const summary = `${base}${caps.length > 0 ? ` —— ${caps.join('；')}` : ''}（评分 ${score}，时点系数 ${coef}${incomplete}）`
  return { score, level, factors, summary, completeness }
}

function hhmmOf(ts: number): string {
  const d = new Date(ts)
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}`
}

function dayOf(ts: number): string {
  const d = new Date(ts)
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** 是否处于采样时段（含开盘前 5 分钟与收盘后 5 分钟收口） */
export function inTradingWindow(ts: number): boolean {
  const d = new Date(ts)
  const dow = d.getDay()
  if (dow === 0 || dow === 6) return false
  const hhmm = hhmmOf(ts)
  return (hhmm >= '09:25' && hhmm <= '11:35') || (hhmm >= '12:55' && hhmm <= '15:05')
}

/** 采样点（窗口资金流统计的输入） */
export interface FlowSample {
  ts: number
  amount: number
  superNet: number
}

export const FLOW_WINDOW_MS = 5 * 60_000

/**
 * 窗口内资金流统计（纯函数，便于自检）。
 *   persistShare = 窗口内超大单净增 ÷ 该窗口成交额（自归一，与采样间隔无关）
 *   retraceRatio = 窗口内单次最大回撤 ÷ 净增（>0.5 说明反复进出）
 * 参考点取「不晚于 now − 窗口长」的最新样本；窗口内样本不足时返回 null。
 */
export function windowFlowStats(
  samples: readonly FlowSample[],
  nowTs: number,
  windowMs = FLOW_WINDOW_MS,
): { persistShare: number | null; retraceRatio: number | null } {
  const target = nowTs - windowMs
  let ref: FlowSample | null = null
  for (const x of samples) {
    if (x.ts <= target + 15_000 && (ref === null || x.ts > ref.ts)) ref = x
  }
  if (ref === null) return { persistShare: null, retraceRatio: null }
  const last = samples[samples.length - 1]
  if (last === undefined) return { persistShare: null, retraceRatio: null }
  const netIncrease = last.superNet - ref.superNet
  const windowAmount = last.amount - ref.amount
  const persistShare = windowAmount > 0 ? netIncrease / windowAmount : null
  let maxDrop = 0
  for (let i = 1; i < samples.length; i++) {
    if (samples[i].ts < ref.ts) continue
    const drop = samples[i - 1].superNet - samples[i].superNet
    if (drop > maxDrop) maxDrop = drop
  }
  const retraceRatio = netIncrease > 0 ? maxDrop / netIncrease : null
  return { persistShare, retraceRatio }
}

/** 自建样本分位数（升序数组的线性插值分位） */
export function quantile(sorted: readonly number[], p: number): number | null {
  if (sorted.length === 0) return null
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.round((p / 100) * (sorted.length - 1))))
  return sorted[idx]
}

/** ── 网络取数 ──────────────────────────────────────────────────────────── */

/** 与 em.fetchAny 同策略：本机到东财的连接会随机被立刻关闭（瞬时失败率可达数十个百分点），
 *  采样器一次丢样本就会形成「缺口」，因此按「轮 × 主机」重试并加抖动退避。 */
const FETCH_ROUNDS = 3
const FETCH_ATTEMPTS_PER_HOST = 2
const FETCH_DEADLINE_MS = 12_000

async function fetchAny(hosts: readonly string[], pathAndQuery: string, timeoutMs = 8000): Promise<Record<string, unknown>> {
  const deadline = Date.now() + FETCH_DEADLINE_MS
  let lastErr: unknown = null
  for (let round = 0; round < FETCH_ROUNDS; round++) {
    for (const host of hosts) {
      for (let attempt = 0; attempt < FETCH_ATTEMPTS_PER_HOST; attempt++) {
        const left = deadline - Date.now()
        if (left <= 250) throw lastErr instanceof Error ? lastErr : new Error('上游请求超时')
        try {
          const res = await fetch(`https://${host}${pathAndQuery}`, {
            headers: { 'user-agent': UA, referer: 'https://quote.eastmoney.com/' },
            signal: AbortSignal.timeout(Math.min(timeoutMs, left)),
          })
          if (!res.ok) throw new Error(`HTTP ${res.status}`)
          const j = (await res.json()) as { data?: unknown }
          if (j?.data === null || j?.data === undefined) throw new Error('data null')
          return j.data as Record<string, unknown>
        } catch (e) {
          lastErr = e
          const message = e instanceof Error ? e.message : String(e)
          if (/HTTP 4\d\d/.test(message)) break
          await new Promise((r) => setTimeout(r, 60 + attempt * 120 + Math.random() * 140))
        }
      }
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error('all hosts failed')
}

export interface RescueQuoteRow {
  secid: string
  price: number | null
  pct: number | null
  amount: number | null
  turnover: number | null
  volRatio: number | null
  mainNet: number | null
  superNet: number | null
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)

/** 批量快照（含 ETF 资金流字段；ETF 的 f62/f66 东财同样提供） */
export async function fetchRescueQuotes(secids: string[]): Promise<Record<string, RescueQuoteRow>> {
  const data = await fetchAny(QUOTE_HOSTS, `/api/qt/ulist.np/get?fltt=2&invt=2&secids=${secids.join(',')}&fields=f12,f13,f14,f2,f3,f6,f8,f10,f62,f66,f184`)
  const diff = Array.isArray(data.diff) ? (data.diff as Array<Record<string, unknown>>) : []
  const out: Record<string, RescueQuoteRow> = {}
  for (const r of diff) {
    const market = num(r.f13)
    const code = String(r.f12 ?? '')
    if (market === null || code === '') continue
    const secid = `${market}.${code}`
    out[secid] = {
      secid,
      price: num(r.f2),
      pct: num(r.f3),
      amount: num(r.f6),
      turnover: num(r.f8),
      volRatio: num(r.f10),
      mainNet: num(r.f62),
      superNet: num(r.f66),
    }
  }
  return out
}

interface DailyBar { date: string; close: number; vol: number; amount: number }

/** 20 日均成交额基准：东财日K（含真实成交额）优先，腾讯日K（vol×100×close 近似）兜底 */
async function fetchAvgAmount20(secid: string): Promise<{ avg: number; source: 'em' | 'tencent' } | null> {
  try {
    const data = await fetchAny(KLINE_HOSTS, `/api/qt/stock/kline/get?secid=${secid}&klt=101&fqt=0&lmt=25&end=20500101&fields1=f1,f2,f3&fields2=f51,f52,f53,f54,f55,f56,f57`, 9000)
    const rows = Array.isArray(data.klines) ? (data.klines as string[]) : []
    const bars: DailyBar[] = []
    for (const line of rows) {
      const c = String(line).split(',')
      if (c.length < 7) continue
      const amount = Number(c[6])
      if (Number.isFinite(amount) && amount > 0) bars.push({ date: c[0], close: Number(c[2]), vol: Number(c[5]), amount })
    }
    const tail = bars.slice(-21, -1)
    if (tail.length >= 15) {
      return { avg: tail.reduce((a, b) => a + b.amount, 0) / tail.length, source: 'em' }
    }
  } catch {
    /* 落到腾讯 */
  }
  try {
    const market = secid.startsWith('1.') ? 'sh' : 'sz'
    const code = secid.split('.')[1]
    const res = await fetch(`https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=${market}${code},day,,,25,qfq`, {
      headers: { 'user-agent': UA }, signal: AbortSignal.timeout(12000),
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const j = (await res.json()) as { data?: Record<string, { qfqday?: string[][]; day?: string[][] }> }
    const d = j?.data?.[`${market}${code}`]
    const arr = d?.qfqday ?? d?.day ?? []
    const bars = arr
      .map((r) => ({ date: String(r[0]), close: Number(r[2]), vol: Number(r[5]) }))
      .filter((b) => Number.isFinite(b.close) && Number.isFinite(b.vol) && b.vol > 0)
      .map((b) => ({ ...b, amount: b.vol * 100 * b.close }))
    const tail = bars.slice(-21, -1)
    if (tail.length >= 15) {
      return { avg: tail.reduce((a, b) => a + b.amount, 0) / tail.length, source: 'tencent' }
    }
  } catch {
    /* ignore */
  }
  return null
}

/** 用新浪 5 分钟线自建当日进度曲线（口径与标定脚本一致，失败则沿用标定值） */
async function fetchProgressCurve(metas: RescueEtfMeta[]): Promise<{ curve: number[]; days: number } | null> {
  const curves: number[][] = []
  for (const meta of metas.slice(0, 6)) {
    try {
      const market = meta.secid.startsWith('1.') ? 'sh' : 'sz'
      const code = meta.secid.split('.')[1]
      const res = await fetch(`https://quotes.sina.cn/cn/api/json_v2.php/CN_MarketDataService.getKLineData?symbol=${market}${code}&scale=5&ma=no&datalen=1023`, {
        headers: { 'user-agent': UA, referer: 'https://finance.sina.com.cn/' }, signal: AbortSignal.timeout(15000),
      })
      if (!res.ok) continue
      const j = (await res.json()) as Array<{ day: string; volume: string }>
      const byDay = new Map<string, Array<{ day: string; volume: string }>>()
      for (const b of Array.isArray(j) ? j : []) {
        const d = String(b.day ?? '').slice(0, 10)
        if (d === '') continue
        const arr = byDay.get(d) ?? []
        arr.push(b)
        byDay.set(d, arr)
      }
      for (const arr of byDay.values()) {
        const slot = new Map<number, number>()
        for (const b of arr) {
          const hm = String(b.day).slice(11, 16)
          const [h, m] = hm.split(':').map(Number)
          if (!Number.isFinite(h) || !Number.isFinite(m)) continue
          const mins = h * 60 + m
          const elapsed = mins <= 690 ? mins - 570 : mins >= 780 ? 120 + (mins - 780) : -1
          if (elapsed <= 0 || elapsed > 240 || elapsed % 5 !== 0) continue
          slot.set(elapsed, (slot.get(elapsed) ?? 0) + Number(b.volume ?? 0))
        }
        const total = [...slot.values()].reduce((a, b) => a + b, 0)
        if (!(total > 0) || slot.size < 40) continue
        const curve = new Array(49).fill(0)
        let run = 0
        for (let i = 1; i <= 48; i++) {
          run += slot.get(i * 5) ?? 0
          curve[i] = run / total
        }
        curves.push(curve)
      }
    } catch {
      /* 单只失败不影响 */
    }
  }
  if (curves.length === 0) return null
  const curve = new Array(49).fill(0).map((_, i) => Number((curves.reduce((a, c) => a + c[i], 0) / curves.length).toFixed(4)))
  return { curve, days: curves.length }
}

/** ── 冷启动回填 ──────────────────────────────────────────────────────────
 * 采样环（内存）在进程启动时是空的，而「脉冲」与「持续性」都需要 ≥5 分钟的历史，
 * 于是**盘中重启**后这两个因子会长时间显示为空 —— 若重启发生在收盘前 5 分钟内，
 * 当天就再也算不出来（实测 9/24 14:44 重启即如此）。
 * 因此首轮采样时用当日分钟数据回填采样环：
 *   - 东财 trends2：每分钟成交额 → 累计成交额
 *   - 东财 fflow klt=1：每分钟累计超大单/主力净额
 * 两者都是当日全量（约 240 点），回填后脉冲/持续性立即可算。
 * ──────────────────────────────────────────────────────────────────────── */

export interface MinuteFlowPoint {
  ts: number
  /** 当日累计成交额 */
  amount: number
  /** 当日累计超大单净额 */
  superNet: number
  /** 当日累计主力净额 */
  mainNet: number
}

/** 解析 "YYYY-MM-DD HH:mm" → epoch ms（本地时区，与趋势接口一致） */
function parseMinuteStamp(text: string): number {
  const t = Date.parse(`${text.slice(0, 10)}T${text.slice(11, 16)}:00`)
  return Number.isFinite(t) ? t : NaN
}

export async function fetchMinuteSeries(secid: string): Promise<MinuteFlowPoint[]> {
  const [trends, flow] = await Promise.all([
    fetchAny(KLINE_HOSTS, `/api/qt/stock/trends2/get?secid=${encodeURIComponent(secid)}&fields1=f1,f2,f3&fields2=f51,f52,f53,f54,f55,f56,f57,f58&ndays=1&iscr=0`).catch(() => null),
    fetchAny(QUOTE_HOSTS, `/api/qt/stock/fflow/kline/get?lmt=0&klt=1&secid=${encodeURIComponent(secid)}&fields1=f1,f2,f3,f7&fields2=f51,f52,f53,f54,f55,f56`).catch(() => null),
  ])
  // 每分钟成交额 → 累计
  const amountByTs = new Map<number, number>()
  const trendRows = (trends as { trends?: unknown } | null)?.trends
  if (Array.isArray(trendRows)) {
    for (const row of trendRows) {
      if (typeof row !== 'string') continue
      const c = row.split(',')
      const ts = parseMinuteStamp(c[0] ?? '')
      const amt = Number(c[6])
      if (!Number.isFinite(ts) || !Number.isFinite(amt)) continue
      amountByTs.set(ts, amt)
    }
  }
  // 每分钟累计超大单/主力
  const flowRows = (flow as { klines?: unknown } | null)?.klines
  const cumFlow = new Map<number, { superNet: number; mainNet: number }>()
  if (Array.isArray(flowRows)) {
    for (const row of flowRows) {
      if (typeof row !== 'string') continue
      const c = row.split(',')
      const ts = parseMinuteStamp(c[0] ?? '')
      const main = Number(c[1])
      const sup = Number(c[5])
      if (!Number.isFinite(ts)) continue
      cumFlow.set(ts, { superNet: Number.isFinite(sup) ? sup : 0, mainNet: Number.isFinite(main) ? main : 0 })
    }
  }
  const stamps = [...amountByTs.keys()].filter((ts) => cumFlow.has(ts)).sort((a, b) => a - b)
  const points: MinuteFlowPoint[] = []
  let cumAmount = 0
  for (const ts of stamps) {
    cumAmount += amountByTs.get(ts) ?? 0
    const f = cumFlow.get(ts)!
    points.push({ ts, amount: cumAmount, superNet: f.superNet, mainNet: f.mainNet })
  }
  return points
}

/** ── 采样器 ────────────────────────────────────────────────────────────── */

export class RescueMonitor {
  private dir: string
  private file: LogFile = { v: 1, days: {}, baselines: {}, selfSamples: {}, progressCurve: null, progressDays: 0, updatedAt: 0 }
  private loaded: Promise<void> | null = null
  private config: RescueConfig
  private ring: Record<string, Sample[]> = {}
  private today: DayLog = { events: [], intraday: [], samples: 0, gap: false }
  private todayKey = ''
  private lastSnapshot: RescueSnapshot | null = null
  private timer: ReturnType<typeof setTimeout> | null = null
  private running = false
  private lastPersist = 0
  private lastLevel: RescueLevel = 0
  private lastIntradayMin = -1
  private calibrating = false
  private calibratedDay = ''
  /** 每个交易日每个标的只回填一次 */
  private bootstrapped = new Set<string>()
  private bootstrappedCount = 0

  constructor(dir: string = dataHome(), config?: RescueConfig) {
    this.dir = dir
    this.config = config ?? { enabled: true, intervalSec: 30, tailIntervalSec: 15, tailFrom: '14:30', universe: [] }
  }

  private path(): string {
    return join(this.dir, 'rescue-log.json')
  }

  async init(): Promise<void> {
    if (this.loaded !== null) return this.loaded
    this.loaded = (async () => {
      await mkdir(this.dir, { recursive: true }).catch(() => undefined)
      try {
        const raw = await readFile(this.path(), 'utf8')
        const parsed = JSON.parse(raw) as Partial<LogFile>
        this.file = {
          v: 1,
          days: parsed.days ?? {},
          baselines: parsed.baselines ?? {},
          selfSamples: parsed.selfSamples ?? {},
          progressCurve: Array.isArray(parsed.progressCurve) && parsed.progressCurve.length === 49 ? parsed.progressCurve : null,
          progressDays: typeof parsed.progressDays === 'number' ? parsed.progressDays : 0,
          updatedAt: typeof parsed.updatedAt === 'number' ? parsed.updatedAt : 0,
        }
      } catch {
        /* 首次：空库 */
      }
      this.rollDay()
      for (const meta of rescueUniverseMeta(this.config.universe)) {
        if (this.file.baselines[meta.secid] === undefined) {
          const cal = RESCUE_CALIBRATION.universe.find((u) => u.secid === meta.secid)
          if (cal !== undefined && cal.avgAmt20 > 0) {
            this.file.baselines[meta.secid] = { avgAmt20: cal.avgAmt20, day: RESCUE_CALIBRATION.generatedAt, source: 'calibrated' }
          }
        }
      }
    })()
    return this.loaded
  }

  private rollDay(): void {
    const key = dayOf(Date.now())
    if (this.todayKey === key) return
    this.bootstrapped.clear()
    this.todayKey = key
    this.today = this.file.days[key] ?? { events: [], intraday: [], samples: 0, gap: false }
    this.file.days[key] = this.today
    this.ring = {}
    this.lastIntradayMin = -1
    this.lastLevel = this.today.events.length > 0 ? this.today.events[this.today.events.length - 1].level : 0
  }

  private async persist(force = false): Promise<void> {
    const now = Date.now()
    if (!force && now - this.lastPersist < 60_000) return
    this.lastPersist = now
    const days = Object.keys(this.file.days).sort()
    while (days.length > KEEP_DAYS) {
      const drop = days.shift()
      if (drop !== undefined) delete this.file.days[drop]
    }
    this.file.updatedAt = now
    const payload = JSON.stringify(this.file)
    try {
      await mkdir(this.dir, { recursive: true }).catch(() => undefined)
      await writeFile(this.path(), payload, 'utf8')
    } catch {
      /* 磁盘失败不影响内存态 */
    }
  }

  getConfig(): RescueConfig {
    return { ...this.config, universe: [...this.config.universe] }
  }

  setConfig(patch: Partial<RescueConfig>): RescueConfig {
    this.config = { ...this.config, ...patch }
    return this.getConfig()
  }

  /** 当前生效采样间隔（尾盘更密） */
  activeIntervalSec(ts = Date.now()): number {
    const hhmm = hhmmOf(ts)
    const tail = this.config.tailFrom !== '' && hhmm >= this.config.tailFrom
    return Math.max(5, tail ? this.config.tailIntervalSec : this.config.intervalSec)
  }

  start(): void {
    if (this.running) return
    this.running = true
    void this.loop()
  }

  stop(): void {
    this.running = false
    if (this.timer !== null) {
      clearTimeout(this.timer)
      this.timer = null
    }
  }

  private async loop(): Promise<void> {
    while (this.running) {
      const ts = Date.now()
      if (this.config.enabled && inTradingWindow(ts)) {
        await this.tick().catch(() => undefined)
      }
      if (!this.running) break
      const waitSec = this.config.enabled && inTradingWindow(Date.now()) ? this.activeIntervalSec() : 30
      await new Promise<void>((resolve) => {
        this.timer = setTimeout(resolve, waitSec * 1000)
      })
      this.timer = null
    }
  }

  /** 立即采样一次（手动刷新/非交易时段复盘） */
  async sampleNow(): Promise<RescueSnapshot> {
    await this.init()
    await this.tick(true)
    return this.snapshot()
  }

  private async tick(force = false): Promise<void> {
    await this.init()
    this.rollDay()
    const metas = rescueUniverseMeta(this.config.universe)
    const secids = [INDEX_SECID, ...metas.map((m) => m.secid)]
    let quotes: Record<string, RescueQuoteRow>
    try {
      quotes = await fetchRescueQuotes(secids)
    } catch {
      this.today.gap = true
      if (this.lastSnapshot !== null) this.lastSnapshot = { ...this.lastSnapshot, gap: true, ts: Date.now() }
      return
    }
    if (this.calibratedDay !== this.todayKey) {
      this.calibratedDay = this.todayKey
      void this.calibrate(metas).catch(() => undefined)
    }
    // 冷启动回填：盘中重启后立刻具备脉冲/持续性所需的历史
    if (inTradingWindow(Date.now())) {
      const short = metas.filter((m) => {
        const ring = this.ring[m.secid] ?? []
        if (ring.length < 2) return true
        const span = ring[ring.length - 1].ts - ring[0].ts
        return span < FLOW_WINDOW_MS - 30_000
      })
      if (short.length > 0 && !short.every((m) => this.bootstrapped.has(`${this.todayKey}|${m.secid}`))) {
        await this.bootstrapRings(short).catch(() => undefined)
      }
    }
    const ts = Date.now()
    const elapsed = sessionElapsed(hhmmOf(ts))
    const curve = this.file.progressCurve ?? RESCUE_CALIBRATION.progressCurve
    const progress = progressAt(curve, elapsed)
    const indexPct = quotes[INDEX_SECID]?.pct ?? null
    const etfs: RescueEtfView[] = []
    const isCoreIndex = (index: string): boolean => CORE_INDEXES.includes(index)
    const pulseAnchors = pulseAnchorsFor(elapsed)
    const phase = phaseOf(hhmmOf(ts))
    // 盘后不再按「尾盘」命名（否则收盘后打开面板会误读为刚发生尾盘突袭）
    const tail = isTailElapsed(elapsed) && inTradingWindow(ts)
    const trading = inTradingWindow(ts)
    // 盘后/非交易时段：不写入新样本，改以「环内最后一个盘中样本」为评估时点，
    // 否则「最近 5 分钟」会错配成「收盘到现在」这一整段空窗
    const ringTail = Math.max(0, ...metas.map((m) => this.ring[m.secid]?.at(-1)?.ts ?? 0))
    const evalTs = trading ? ts : ringTail > ts - 12 * 3600_000 ? ringTail : ts
    const allowPulse = trading || (phase === 'closed' && ringTail > 0)
    let maxMult: number | null = null
    let coreSuperVsAvg: number | null = null
    let peripheralSuperVsAvg: number | null = null
    let maxPulse: number | null = null
    let persistBest: number | null = null
    let retraceWorst: number | null = null
    let coreWorstShare: number | null = null
    const triggeredIndexes = new Set<string>()
    const coreTriggered: string[] = []
    const peripheralTriggered: string[] = []
    for (const meta of metas) {
      const q = quotes[meta.secid]
      const base = this.file.baselines[meta.secid]?.avgAmt20 ?? RESCUE_CALIBRATION.universe.find((u) => u.secid === meta.secid)?.avgAmt20 ?? null
      if (q === undefined) {
        etfs.push({
          secid: meta.secid, name: meta.name, index: meta.index, price: null, pct: null, amount: null, volRatio: null,
          timeAdjMult: null, avgAmt20: base, superNet: null, mainNet: null, superShare: null, superVsAvg: null,
          pulseMult: null, activity: 0, triggered: false, flowDirection: 'unknown',
        })
        continue
      }
      const amount = q.amount
      const superNet = q.superNet
      const timeAdjMult = amount !== null && base !== null && base > 0 ? amount / (base * progress) : null
      const superVsAvg = superNet !== null && base !== null && base > 0 ? superNet / base : null
      const superShare = superNet !== null && amount !== null && amount > 0 ? superNet / amount : null
      // 脉冲：最近 5 分钟成交额 ÷ 同时点基准 5 分钟额
      let pulseMult: number | null = null
      const ring = this.ring[meta.secid] ?? []
      if (allowPulse && amount !== null && base !== null && base > 0 && ring.length > 0) {
        const target = ts - 5 * 60_000
        let ref: Sample | null = null
        for (const s of ring) if (s.ts <= target + 15_000 && (ref === null || s.ts > ref.ts)) ref = s
        if (ref !== null) {
          const actual5 = amount - ref.amount
          const elapsedRef = sessionElapsed(hhmmOf(ref.ts))
          const expected = base * (progress - progressAt(curve, elapsedRef))
          if (expected > 0 && actual5 > 0) pulseMult = actual5 / expected
        }
      }
      const flow = amount !== null && superNet !== null
        ? this.pushSample(meta.secid, trading ? { ts, amount, superNet, mainNet: q.mainNet ?? 0 } : null, evalTs)
        : { persistShare: null, retraceRatio: null }
      if (flow.persistShare !== null && (persistBest === null || flow.persistShare > persistBest)) persistBest = flow.persistShare
      if (flow.retraceRatio !== null && (retraceWorst === null || flow.retraceRatio > retraceWorst)) retraceWorst = flow.retraceRatio
      if (timeAdjMult !== null) maxMult = Math.max(maxMult ?? 0, timeAdjMult)
      if (superVsAvg !== null) {
        if (isCoreIndex(meta.index)) {
          // 核心护盘通道：F2 以它们为主，并记录最差的超大单占比用于否决
          coreSuperVsAvg = Math.max(coreSuperVsAvg ?? -Infinity, superVsAvg)
          if (superShare !== null && (coreWorstShare === null || superShare < coreWorstShare)) coreWorstShare = superShare
        } else {
          peripheralSuperVsAvg = Math.max(peripheralSuperVsAvg ?? -Infinity, superVsAvg)
        }
      }
      if (pulseMult !== null) maxPulse = Math.max(maxPulse ?? 0, pulseMult)
      if (superVsAvg !== null) {
        const peaks = this.today.etfPeak ?? {}
        if (!(meta.secid in peaks) || superVsAvg > peaks[meta.secid]) peaks[meta.secid] = superVsAvg
        this.today.etfPeak = peaks
      }
      // 资金流入是必要条件：只有量能或脉冲、没有净流入，不构成托底证据
      //（9/24 09:48 那次「疑似护盘」正是 F2=0 却因量能+脉冲+持续性凑分所致）
      const flowOk = superVsAvg !== null && superVsAvg >= this.f2Anchors()[0]
      const selfTrigger = flowOk && (
        (timeAdjMult !== null && timeAdjMult >= RESCUE_CALIBRATION.f1.mid) ||
        (pulseMult !== null && pulseMult >= pulseAnchors[1])
      )
      if (selfTrigger) {
        triggeredIndexes.add(meta.index)
        const bucket = isCoreIndex(meta.index) ? coreTriggered : peripheralTriggered
        if (!bucket.includes(meta.index)) bucket.push(meta.index)
      }
      const activity = Math.max(0, Math.min(100, Math.round(
        0.4 * interpScore(timeAdjMult ?? 0, [RESCUE_CALIBRATION.f1.mid, RESCUE_CALIBRATION.f1.high, RESCUE_CALIBRATION.f1.extreme]) +
        0.4 * interpScore(superVsAvg ?? 0, this.f2Anchors()) +
        0.2 * interpScore(pulseMult ?? 0, PULSE_ANCHORS),
      )))
      etfs.push({
        secid: meta.secid, name: meta.name, index: meta.index,
        price: q.price, pct: q.pct, amount, volRatio: q.volRatio, timeAdjMult, avgAmt20: base,
        superNet, mainNet: q.mainNet, superShare, superVsAvg, pulseMult, activity, triggered: selfTrigger,
      })
    }
    const anchors = this.f2Anchors()
    const scored = scoreRescue({
      timeAdjMult: maxMult,
      coreSuperVsAvg, peripheralSuperVsAvg,
      pulseMult: maxPulse,
      persistShare: persistBest, retraceRatio: retraceWorst,
      indexPct, resonance: triggeredIndexes.size,
      coreResonance: coreTriggered.length, peripheralResonance: peripheralTriggered.length,
      resonanceLanes: [...coreTriggered, ...peripheralTriggered],
      coreWorstShare,
      f2Anchors: anchors, f2Source: this.f2Source(),
      // 时点系数此前没有传进来，运行时恒等于 1（早盘噪音最大的时段拿到满权重）
      timeCoef: timeCoefficient(elapsed),
      isTail: tail, pulseAnchors, bandLabel: pulseBandLabel(elapsed), phase,
    })
    etfs.sort((a, b) => b.activity - a.activity)
    // 事件去抖：仅记录等级升级，以及从有信号回落到平静（形成完整时间线）
    if (scored.level > this.lastLevel || (scored.level === 0 && this.lastLevel > 0)) {
      this.today.events.push({
        ts, hhmm: hhmmOf(ts), level: scored.level, score: scored.score,
        engine: ENGINE_VERSION,
        reason: scored.level === 0 ? '信号回落：量能与超大单流入回到常态' : scored.summary,
      })
      if (this.today.events.length > 60) this.today.events.splice(0, this.today.events.length - 60)
      this.lastLevel = scored.level
      await this.persist(true)
    }
    const minuteMark = Math.floor(elapsed / 5) * 5
    if (minuteMark !== this.lastIntradayMin && elapsed > 0) {
      this.lastIntradayMin = minuteMark
      this.today.intraday.push({
        hhmm: hhmmOf(ts), level: scored.level, score: scored.score,
        timeAdjMult: maxMult, superVsAvg: coreSuperVsAvg ?? peripheralSuperVsAvg, persistShare: persistBest,
      })
      if (this.today.intraday.length > 120) this.today.intraday.splice(0, this.today.intraday.length - 120)
    }
    this.today.samples += 1
    this.today.gap = false
    this.lastSnapshot = {
      ts, trading: inTradingWindow(ts), level: scored.level, score: scored.score, summary: scored.summary,
      factors: scored.factors, etfs, indexPct, indexName: INDEX_NAME, timeCoef: timeCoefficient(elapsed),
      resonance: {
        lanes: [...coreTriggered, ...peripheralTriggered],
        core: coreTriggered.length,
        peripheral: peripheralTriggered.length,
        intensity: triggeredIndexes.size === 0 ? 'none' : coreTriggered.length > 0 ? 'systemic' : 'local',
      },
      pulseBand: {
        elapsed, label: phase === 'closed' ? '已收盘' : pulseBandLabel(elapsed), isTail: tail,
        anchors: pulseAnchors, phase,
      },
      completeness: scored.completeness,
      thresholdSource: this.f2Source(), selfSampleDays: this.selfSampleDays(),
      config: this.getConfig(), activeIntervalSec: this.activeIntervalSec(ts),
      today: [...this.today.events].reverse(), intraday: [...this.today.intraday],
      sampleCount: this.today.samples, lastSampleTs: ts, gap: false,
      note: elapsed <= 0 ? '尚未开盘，量能倍数按全天口径显示为 0' : undefined,
    }
    void this.persist()
  }

  /**
   * 用当日分钟数据回填采样环（每个交易日每标的只做一次）。
   * 只补历史、不覆盖已采到的实时样本，因此不会与实时采样冲突。
   */
  private async bootstrapRings(metas: RescueEtfMeta[]): Promise<void> {
    let filled = 0
    for (const meta of metas) {
      const key = `${this.todayKey}|${meta.secid}`
      if (this.bootstrapped.has(key)) continue
      this.bootstrapped.add(key)
      try {
        const points = await fetchMinuteSeries(meta.secid)
        if (points.length < 3) continue
        const ring = this.ring[meta.secid] ?? []
        const newest = ring.length > 0 ? ring[ring.length - 1].ts : 0
        const seeded: Sample[] = points
          .filter((p) => p.ts > newest)
          .slice(-SAMPLE_RING)
          .map((p) => ({ ts: p.ts, amount: p.amount, superNet: p.superNet, mainNet: p.mainNet }))
        if (seeded.length === 0) continue
        this.ring[meta.secid] = [...ring, ...seeded].slice(-SAMPLE_RING)
        filled += 1
      } catch {
        /* 单只失败不影响其它 */
      }
    }
    if (filled > 0) this.bootstrappedCount += filled
  }

  /**
   * 采样环 + 窗口内资金流统计。
   *
   * 旧实现用「超大单净额连续递增的次数」——严格大于就计一次、没有幅度门槛，
   * 而东财超大单以 ~0.01 亿步长抖动，于是几乎必然出现"连续递增"，配合可配置的
   * 采样间隔（30s/60s 语义还不同）会大量误报。改为**时间 + 幅度**口径：
   *   persistShare = 窗口内净增 ÷ 该窗口成交额（自归一，与采样间隔无关）
   *   retraceRatio = 窗口内单次最大回撤 ÷ 净增（揭示反复进出）
   */
  private pushSample(secid: string, s: Sample | null, evalTs: number): { persistShare: number | null; retraceRatio: number | null } {
    const ring = this.ring[secid] ?? []
    if (s !== null) {
      ring.push(s)
      if (ring.length > SAMPLE_RING) ring.splice(0, ring.length - SAMPLE_RING)
      this.ring[secid] = ring
    }
    if (ring.length < 2) return { persistShare: null, retraceRatio: null }
    return windowFlowStats(ring, evalTs)
  }

  private selfSampleDays(): number {
    const all = new Set<string>()
    for (const arr of Object.values(this.file.selfSamples)) for (const s of arr) all.add(s.day)
    return all.size
  }

  /** F2 锚点：自建样本满 20 个交易日后用自建分位数（P75/P90/P95） */
  private f2Anchors(): [number, number, number] {
    const pooled: number[] = []
    for (const arr of Object.values(this.file.selfSamples)) for (const s of arr) pooled.push(s.superVsAvg)
    if (this.selfSampleDays() >= SELF_SAMPLE_MIN_DAYS && pooled.length >= 60) {
      pooled.sort((a, b) => a - b)
      const p75 = quantile(pooled, 75) ?? RESCUE_CALIBRATION.f2.watch
      const p90 = quantile(pooled, 90) ?? RESCUE_CALIBRATION.f2.mid
      const p95 = quantile(pooled, 95) ?? RESCUE_CALIBRATION.f2.strong
      return [Number(p75.toFixed(3)), Number(p90.toFixed(3)), Number(p95.toFixed(3))]
    }
    return [RESCUE_CALIBRATION.f2.watch, RESCUE_CALIBRATION.f2.mid, RESCUE_CALIBRATION.f2.strong]
  }

  private f2Source(): RescueThresholdSource {
    return this.selfSampleDays() >= SELF_SAMPLE_MIN_DAYS ? 'self' : 'empirical'
  }

  /** 每日标定：20 日均额（东财真实成交额优先）+ 自建进度曲线 */
  private async calibrate(metas: RescueEtfMeta[]): Promise<void> {
    if (this.calibrating) return
    this.calibrating = true
    try {
      for (const meta of metas) {
        const got = await fetchAvgAmount20(meta.secid)
        if (got !== null) {
          this.file.baselines[meta.secid] = { avgAmt20: got.avg, day: this.todayKey, source: got.source }
        }
      }
      const prog = await fetchProgressCurve(metas)
      if (prog !== null) {
        this.file.progressCurve = prog.curve
        this.file.progressDays = prog.days
      }
      // 昨日样本入库（供 F2 自建分位升级）
      const prev = Object.keys(this.file.days).sort().filter((d) => d < this.todayKey).pop()
      if (prev !== undefined) {
        const peaks = this.file.days[prev]?.etfPeak ?? {}
        for (const meta of metas) {
          const peak = peaks[meta.secid]
          if (typeof peak !== 'number' || !(peak > 0)) continue
          const arr = this.file.selfSamples[meta.secid] ?? []
          if (!arr.some((x) => x.day === prev)) arr.push({ day: prev, superVsAvg: peak })
          this.file.selfSamples[meta.secid] = arr.slice(-120)
        }
      }
      await this.persist(true)
    } finally {
      this.calibrating = false
    }
  }

  snapshot(): RescueSnapshot {
    if (this.lastSnapshot !== null) {
      return {
        ...this.lastSnapshot,
        trading: inTradingWindow(Date.now()),
        config: this.getConfig(),
        activeIntervalSec: this.activeIntervalSec(),
        thresholdSource: this.f2Source(),
        selfSampleDays: this.selfSampleDays(),
        gap: this.today.gap,
      }
    }
    return {
      ts: Date.now(), trading: inTradingWindow(Date.now()), level: 0, score: 0,
      summary: '尚未采样（打开页面后会自动开始）', factors: [], etfs: [], indexPct: null, indexName: INDEX_NAME,
      timeCoef: timeCoefficient(sessionElapsed(hhmmOf(Date.now()))),
      resonance: { lanes: [], core: 0, peripheral: 0, intensity: 'none' },
      pulseBand: {
        elapsed: sessionElapsed(hhmmOf(Date.now())),
        label: phaseOf(hhmmOf(Date.now())) === 'closed' ? '已收盘' : pulseBandLabel(sessionElapsed(hhmmOf(Date.now()))),
        isTail: isTailElapsed(sessionElapsed(hhmmOf(Date.now()))) && inTradingWindow(Date.now()),
        anchors: pulseAnchorsFor(sessionElapsed(hhmmOf(Date.now()))),
        phase: phaseOf(hhmmOf(Date.now())),
      },
      completeness: { available: 0, total: 6, missing: ['量能放大', '超大单强度', '脉冲', '持续性', '量价背离'] },
      thresholdSource: this.f2Source(),
      selfSampleDays: this.selfSampleDays(), config: this.getConfig(), activeIntervalSec: this.activeIntervalSec(),
      today: [...this.today.events].reverse(), intraday: [...this.today.intraday], sampleCount: this.today.samples,
      lastSampleTs: null, gap: this.today.gap, note: '等待首次采样',
    }
  }

  /** 近 60 天每日摘要（历史回看） */
  history(limit = 30): RescueDaySummary[] {
    const out: RescueDaySummary[] = []
    for (const day of Object.keys(this.file.days).sort().reverse().slice(0, limit)) {
      const d = this.file.days[day]
      const maxScore = d.intraday.reduce((a, p) => Math.max(a, p.score), d.events.reduce((a, e) => Math.max(a, e.score), 0))
      const maxLevel = d.intraday.reduce<RescueLevel>((a, p) => Math.max(a, p.level) as RescueLevel, d.events.reduce<RescueLevel>((a, e) => Math.max(a, e.level) as RescueLevel, 0))
      const peak = d.intraday.find((p) => p.score === maxScore) ?? null
      out.push({ day, maxLevel, maxScore, events: d.events.filter((e) => e.level >= 1).length, peakHhmm: peak?.hhmm ?? null })
    }
    return out
  }

  intradayOf(day: string): RescueIntradayPoint[] {
    return this.file.days[day]?.intraday ?? []
  }

  eventsOf(day: string): RescueSignalEvent[] {
    return this.file.days[day]?.events ?? []
  }

  /** 采样健康度：最近一次采样距今是否超过 2 个间隔 */
  stale(): boolean {
    const last = this.lastSnapshot?.lastSampleTs ?? null
    if (last === null) return false
    return inTradingWindow(Date.now()) && Date.now() - last > this.activeIntervalSec() * 1000 * 2.5
  }

  get calibratedInfo(): { progressDays: number; generatedAt: string } {
    return { progressDays: this.file.progressDays || RESCUE_CALIBRATION.progressDays, generatedAt: RESCUE_CALIBRATION.generatedAt }
  }

  /** 供前端绘制「同时点基准」用：进度曲线 + F1/F2 锚点 */
  get calibrationInfo(): {
    generatedAt: string
    progressCurve: number[]
    progressDays: number
    f1: { mid: number; high: number; extreme: number }
    f2: { watch: number; mid: number; strong: number }
    pooled: { p50: number; p75: number; p90: number; p95: number; p99: number }
    baselines: Record<string, number>
  } {
    const baselines: Record<string, number> = {}
    for (const [k, v] of Object.entries(this.file.baselines)) baselines[k] = v.avgAmt20
    return {
      generatedAt: RESCUE_CALIBRATION.generatedAt,
      progressCurve: this.file.progressCurve ?? RESCUE_CALIBRATION.progressCurve,
      progressDays: this.file.progressDays || RESCUE_CALIBRATION.progressDays,
      f1: RESCUE_CALIBRATION.f1,
      f2: RESCUE_CALIBRATION.f2,
      pooled: RESCUE_CALIBRATION.pooled,
      baselines,
    }
  }
}
