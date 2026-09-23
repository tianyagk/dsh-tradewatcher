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
import { rescueUniverseMeta } from '../shared/model.ts'
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

/** 尾盘脉冲锚点（同时点口径，已用标定曲线消除集合竞价的自然放大） */
export const PULSE_ANCHORS: [number, number, number] = [1.5, 2.5, 4]
/** 自建样本满该天数后，F2 改用自建分位数 */
export const SELF_SAMPLE_MIN_DAYS = 20
const KEEP_DAYS = 60
const SAMPLE_RING = 40
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

/** 持续性：超大单净额连续递增的采样次数（30s 一档） */
export function persistenceScore(streak: number): number {
  if (streak >= 4) return 100
  if (streak >= 3) return 80
  if (streak >= 2) return 60
  if (streak >= 1) return 30
  return 0
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
  superVsAvg: number | null
  pulseMult: number | null
  streak: number
  indexPct: number | null
  resonance: number
  /** F2 锚点（可被自建分位数覆盖） */
  f2Anchors: [number, number, number]
  f2Source: RescueThresholdSource
  /** 时点系数；缺省 1（纯函数不读时钟，便于自检） */
  timeCoef?: number
}

export interface RescueScoreResult {
  score: number
  level: RescueLevel
  factors: RescueFactor[]
  summary: string
}

const fmt = (v: number | null, unit: string, digits = 2): string => (v === null ? '—' : `${v.toFixed(digits)}${unit}`)
const fmtYi = (v: number | null): string => (v === null ? '—' : `${(v / 1e8).toFixed(2)}亿`)

/** 六因子合成：S = Σ w·f × 时点系数；并施加「强信号须有真实超大单」的防误报约束 */
export function scoreRescue(input: RescueFactorInput): RescueScoreResult {
  const f1 = interpScore(input.timeAdjMult ?? 0, [RESCUE_CALIBRATION.f1.mid, RESCUE_CALIBRATION.f1.high, RESCUE_CALIBRATION.f1.extreme])
  const f2 = interpScore(input.superVsAvg ?? 0, input.f2Anchors)
  const f3 = interpScore(input.pulseMult ?? 0, PULSE_ANCHORS)
  const f4 = persistenceScore(input.streak)
  const f5 = divergenceScore(input.indexPct)
  const f6 = resonanceScore(input.resonance)
  const factors: RescueFactor[] = [
    {
      id: 'volume', label: '量能放大', score: f1, weight: RESCUE_WEIGHTS.volume,
      actual: fmt(input.timeAdjMult, 'x'), threshold: `同时点量能倍数（P75/P90/P95 ${RESCUE_CALIBRATION.f1.mid}/${RESCUE_CALIBRATION.f1.high}/${RESCUE_CALIBRATION.f1.extreme}x 历史标定）`,
      hit: f1 >= 40,
    },
    {
      id: 'superflow', label: '超大单强度', score: f2, weight: RESCUE_WEIGHTS.superflow,
      actual: fmt(input.superVsAvg, 'x'), threshold: `超大单净额/20日均额（${input.f2Anchors[0]}/${input.f2Anchors[1]}/${input.f2Anchors[2]}x，来源 ${input.f2Source === 'self' ? '自建样本分位' : '经验锚点'}）`,
      hit: f2 >= 40,
    },
    {
      id: 'pulse', label: '尾盘脉冲', score: f3, weight: RESCUE_WEIGHTS.pulse,
      actual: fmt(input.pulseMult, 'x'), threshold: `最近5分钟成交额/同时点基准（${PULSE_ANCHORS[0]}/${PULSE_ANCHORS[1]}/${PULSE_ANCHORS[2]}x）`,
      hit: f3 >= 40,
    },
    {
      id: 'persistence', label: '持续性', score: f4, weight: RESCUE_WEIGHTS.persistence,
      actual: `${input.streak} 次`, threshold: '超大单净额连续递增的采样次数（≥2 起算）',
      hit: f4 >= 40,
    },
    {
      id: 'divergence', label: '量价背离', score: f5, weight: RESCUE_WEIGHTS.divergence,
      actual: fmt(input.indexPct, '%'), threshold: `${INDEX_NAME} 跌 ≥1.0% 满分；上涨时权重打折（追涨天量不是护盘）`,
      hit: f5 >= 60,
    },
    {
      id: 'resonance', label: '全池共振', score: f6, weight: RESCUE_WEIGHTS.resonance,
      actual: `${input.resonance} 只`, threshold: '同时触发的宽基通道数（按指数去重）',
      hit: f6 >= 40,
    },
  ]
  const raw = factors.reduce((a, f) => a + f.weight * f.score, 0)
  const coef = input.timeCoef ?? 1
  const score = Math.max(0, Math.min(100, Math.round(raw * coef)))
  const scaled: RescueLevel = score >= 75 ? 3 : score >= 55 ? 2 : score >= 35 ? 1 : 0
  // 防误报约束（每条都会写进归因，不做静默降级）：
  //  1) 护盘的前提是市场承压 —— 指数明显上涨时的天量更可能是追涨，指数大涨直接封顶
  //  2) 强信号必须有真实的超大单净流入
  //  3) 既没有资金流入也没有脉冲时，最多算「异动」
  const caps: string[] = []
  let level = scaled
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
  if (level === 3 && f2 < 70) {
    level = 2
    caps.push('超大单强度未达强信号门槛 → 降为疑似护盘')
  }
  if (level === 2 && f2 < 40 && f1 < 70) {
    level = 1
    caps.push('量能与资金流入均未达中档 → 降为资金异动')
  }
  if (f2 < 15 && f3 < 40 && level > 1) {
    level = 1
    caps.push('无有效超大单净流入且无脉冲 → 降为资金异动')
  }
  const hits = factors.filter((f) => f.hit).map((f) => `${f.label} ${f.actual}`).join(' · ')
  const base = level === 0 ? '宽基 ETF 量能与资金流均在常态区间（无异动）' : `${hits}`
  const summary = `${base}${caps.length > 0 ? ` —— ${caps.join('；')}` : ''}（评分 ${score}，时点系数 ${coef}）`
  return { score, level, factors, summary }
}

export function hhmmOf(ts: number): string {
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
    const ts = Date.now()
    const elapsed = sessionElapsed(hhmmOf(ts))
    const curve = this.file.progressCurve ?? RESCUE_CALIBRATION.progressCurve
    const progress = progressAt(curve, elapsed)
    const indexPct = quotes[INDEX_SECID]?.pct ?? null
    const etfs: RescueEtfView[] = []
    let maxMult: number | null = null
    let maxSuperVsAvg: number | null = null
    let maxPulse: number | null = null
    let maxAmount = 0
    const triggeredIndexes = new Set<string>()
    let streakBest = 0
    for (const meta of metas) {
      const q = quotes[meta.secid]
      const base = this.file.baselines[meta.secid]?.avgAmt20 ?? RESCUE_CALIBRATION.universe.find((u) => u.secid === meta.secid)?.avgAmt20 ?? null
      if (q === undefined) {
        etfs.push({
          secid: meta.secid, name: meta.name, index: meta.index, price: null, pct: null, amount: null, volRatio: null,
          timeAdjMult: null, avgAmt20: base, superNet: null, mainNet: null, superShare: null, superVsAvg: null,
          pulseMult: null, activity: 0, triggered: false,
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
      if (inTradingWindow(ts) && amount !== null && base !== null && base > 0 && ring.length > 0) {
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
      const streak = amount !== null && superNet !== null ? this.pushSample(meta.secid, { ts, amount, superNet, mainNet: q.mainNet ?? 0 }) : 0
      streakBest = Math.max(streakBest, streak)
      if (timeAdjMult !== null) maxMult = Math.max(maxMult ?? 0, timeAdjMult)
      if (superVsAvg !== null) maxSuperVsAvg = Math.max(maxSuperVsAvg ?? -Infinity, superVsAvg)
      if (pulseMult !== null) maxPulse = Math.max(maxPulse ?? 0, pulseMult)
      if (amount !== null) maxAmount = Math.max(maxAmount, amount)
      if (superVsAvg !== null) {
        const peaks = this.today.etfPeak ?? {}
        if (!(meta.secid in peaks) || superVsAvg > peaks[meta.secid]) peaks[meta.secid] = superVsAvg
        this.today.etfPeak = peaks
      }
      const selfTrigger = (timeAdjMult !== null && timeAdjMult >= RESCUE_CALIBRATION.f1.mid && superVsAvg !== null && superVsAvg >= this.f2Anchors()[0]) ||
        (pulseMult !== null && pulseMult >= PULSE_ANCHORS[1])
      if (selfTrigger) triggeredIndexes.add(meta.index)
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
      timeAdjMult: maxMult, superVsAvg: maxSuperVsAvg, pulseMult: maxPulse, streak: streakBest,
      indexPct, resonance: triggeredIndexes.size, f2Anchors: anchors, f2Source: this.f2Source(),
    })
    etfs.sort((a, b) => b.activity - a.activity)
    // 事件去抖：仅记录等级升级，以及从有信号回落到平静（形成完整时间线）
    if (scored.level > this.lastLevel || (scored.level === 0 && this.lastLevel > 0)) {
      this.today.events.push({
        ts, hhmm: hhmmOf(ts), level: scored.level, score: scored.score,
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
        timeAdjMult: maxMult, superVsAvg: maxSuperVsAvg,
      })
      if (this.today.intraday.length > 120) this.today.intraday.splice(0, this.today.intraday.length - 120)
    }
    this.today.samples += 1
    this.today.gap = false
    this.lastSnapshot = {
      ts, trading: inTradingWindow(ts), level: scored.level, score: scored.score, summary: scored.summary,
      factors: scored.factors, etfs, indexPct, indexName: INDEX_NAME, timeCoef: timeCoefficient(elapsed),
      thresholdSource: this.f2Source(), selfSampleDays: this.selfSampleDays(),
      config: this.getConfig(), activeIntervalSec: this.activeIntervalSec(ts),
      today: [...this.today.events].reverse(), intraday: [...this.today.intraday],
      sampleCount: this.today.samples, lastSampleTs: ts, gap: false,
      note: elapsed <= 0 ? '尚未开盘，量能倍数按全天口径显示为 0' : undefined,
    }
    void this.persist()
  }

  /** 采样环 + 超大单净额连续递增次数 */
  private pushSample(secid: string, s: Sample): number {
    const ring = this.ring[secid] ?? []
    const last = ring.length > 0 ? ring[ring.length - 1] : null
    const rising = last !== null && s.superNet > last.superNet
    ring.push(s)
    if (ring.length > SAMPLE_RING) ring.splice(0, ring.length - SAMPLE_RING)
    this.ring[secid] = ring
    if (!rising) return 0
    let streak = 1
    for (let i = ring.length - 1; i > 0; i--) {
      if (ring[i].superNet > ring[i - 1].superNet) streak += 1
      else break
    }
    return Math.min(8, streak)
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
      timeCoef: timeCoefficient(sessionElapsed(hhmmOf(Date.now()))), thresholdSource: this.f2Source(),
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
