/**
 */
import { mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type {
  DailyBarLite, RescueActiveWindow, RescueBottomLane, RescueConfig, RescueDaySummary, RescueEtfMeta, RescueEtfView,
  RescueBreadthMoment, RescueCardSeries, RescueFactor, RescueIntradayChannel, RescueIntradayPoint, RescueLevel,
  RescueSignalEvent, RescueSnapshot, RescueThresholdSource,
} from '../shared/model.ts'
import { RESCUE_CORE_OUTFLOW_VETO, RESCUE_CORE_INDEXES, RESCUE_PERIPHERAL_FLOW_DISCOUNT, rescueUniverseMeta } from '../shared/model.ts'
import { RESCUE_CALIBRATION } from './rescue-thresholds.ts'
import { hostsAllowed } from './breaker.ts'
import { QUOTE_HOSTS as EM_QUOTE_HOSTS, HISTORY_HOSTS as EM_HISTORY_HOSTS, fetchAny as fetchAnyJson, loadQuoteRowsShared } from './em.ts'
import { fetchTencentDaily, fetchTencentMinutes } from './tencent.ts'
import { dayOf as shDayOf, hhmmOf as shHhmmOf, parseMarketStamp, weekdayOf as shWeekdayOf } from './time.ts'
import { externalCalendarStatus, externalClosureOf, loadTradingCalendar, monthCoveredByFile, type TradingCalendarStatus } from './tradingCalendar.ts'
import { buildBottomLane, calibrateAcross } from './bottom.ts'
import { SingleFlight } from './singleflight.ts'
import { dataHome } from './store.ts'
import { mergeByKey, updateJsonLocked } from './lock.ts'
import { withHostBreaker } from './breakerFetch.ts'

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
// 主机组与取数实现都从 em.ts 复用（单一所有者）：本地再写一份只会让两边的退避与熔断语义漂移
const QUOTE_HOSTS = EM_QUOTE_HOSTS
const KLINE_HOSTS = EM_HISTORY_HOSTS

/**因子权重（合计 1.00） */
/**
 * 因子权重（**合计必须恰好 = 1**，有断言守着）。
 *
 * v0.80.0 变更：删除「全池共振」因子 —— 实测 302/302 个历史样本的因子分恒为 0
 * （`rescue-log.json` 的 `scoreLog`），即它从未对任何一次评分产生过贡献；
 * 剩下五项按各 /0.92 重新归一（0.239+0.283+0.196+0.130+0.152 = 1.000）。
 * 「共振」本身没被删：它仍是**展示用**的通道命中信息（`snapshot.resonance`），只是不再进评分。
 */
export const RESCUE_WEIGHTS = {
  volume: 0.239,
  pulse: 0.196,
  persistence: 0.13,
  divergence: 0.152,
} as const

/**
 * 权重合计 —— **刻意不归一**（`AUDIT-IMPL54` 批 A′+B）。
 *
 * F2「超大单强度」已被剔除（宽基 ETF 的分单数据太稀疏：305 个历史样本里该因子分的 p90 = 1、
 * max = 15，原始输入 p90 = 0.01×20 日均额 ⇒ 它几乎恒为 0，只占权重不参与判断）。
 * 剔除后**保留其余四项的原始权重**，因此合计 = **0.717**（不是 1.000）。
 *
 * 为什么不归一：归一（或等价地"把等级线也乘 0.717"）会把剩余四项的贡献放大 1/0.717 ≈ 1.40 倍
 * ⇒ 实测回放里 8 天有 5 天等级 +1、凭空多出 3 个「强护盘」（`AUDIT-IMPL54` §批 A′+B 回放给出同一结论）。
 * 判定变量是**绝对 raw**（Σ w·f），等级线保持历史值 35/55/75 —— 因为 F2 历史上几乎恒为 0，
 * `raw_new ≈ raw_old`，于是判据**逐样本不变**（差异只剩 F2 偶尔贡献的 0–4 分，方向只可能"更保守"）。
 */
export const RESCUE_WEIGHT_SUM = Number(Object.values(RESCUE_WEIGHTS).reduce((a, b) => a + b, 0).toFixed(3))

/**
 * **声明给用户的等级集**（唯一来源）：0 平静 / 1 资金异动 / 2 疑似护盘。
 *
 * ⚠ **3（强护盘）已从等级集删除**（v0.15.0，Lead 决策）：
 *   · 剔除 F2 后四项权重上限 = `0.717 × 100 = 71.7`，而历史 L3 线是 **75** ⇒ 它**数学上不可达**；
 *   · 效度复核（`docs/DESIGN-RESCUE-VALIDITY.md`）判定它**无可证明的区分度**（23 天日志 0 次触发）；
 *   · 靠"把线降下来"迁就它等于人为降低门槛（伪信号），所以选择**删等级**、把粒度交给连续评分。
 *   · 结构性断言：`RESCUE_LEVEL_BASE` 的每个线都必须 ≤ 可达上限（见 `rescueWeights.test.ts` ③）。
 */
export const RESCUE_LEVELS: readonly RescueLevel[] = [0, 1, 2]

/**兜底脉冲锚点（标定数据缺失时才用；正常走 RESCUE_CALIBRATION.pulseBands） */
export const PULSE_ANCHORS: [number, number, number] = [1.5, 2.5, 4]
/**尾盘起点（开盘后分钟数）：14:30 */
export const TAIL_FROM_ELAPSED = 180
/**盘中脉冲的打折系数（真尾盘的大单才更能代表主力意图） */
export const INTRADAY_PULSE_DISCOUNT = 0.6
/**脉冲「命中」线（分）：对应该时段 P90】 */
export const PULSE_HIT_SCORE = 70
/**持续性锚点：5 分钟内超大单净增 ÷ 该窗口成交额 → 40/70/100 分 */
export const PERSIST_ANCHORS: [number, number, number] = [0.05, 0.12, 0.25]
/**核心护盘通道与阈值：定义在 shared，客户端也要用于标注与展示 */
export const CORE_INDEXES = RESCUE_CORE_INDEXES
export const CORE_OUTFLOW_VETO = RESCUE_CORE_OUTFLOW_VETO
export const PERIPHERAL_FLOW_DISCOUNT = RESCUE_PERIPHERAL_FLOW_DISCOUNT

export function isTailElapsed(elapsedMin: number): boolean {
  return elapsedMin >= TAIL_FROM_ELAPSED
}

/**交易阶段：盘前 / 上午 / 午间 / 午后 / 尾盘 / 已收盘 */
export type RescuePhase = 'pre' | 'am' | 'noon' | 'pm' | 'tail' | 'closed'

export function phaseOf(hhmm: string): RescuePhase {
  if (hhmm < '09:15') return 'pre'
  if (hhmm <= '11:30') return 'am'
  if (hhmm < '13:00') return 'noon'
  if (hhmm < '14:30') return 'pm'
  if (hhmm <= '15:05') return 'tail'
  return 'closed'
}

/**脉冲因子的名称随阶段变化（盘后不再叫「尾盘突袭」，避免误读为刚发生） */
export function pulseFactorLabel(phase: RescuePhase): string {
  if (phase === 'tail') return '尾盘突袭'
  if (phase === 'closed') return '脉冲（盘后）'
  return '盘中脉冲'
}

/**取当前时段的脉冲锚点（P75/P90/P95 → 40/70/100） */
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
/**自建样本满该天数后，F2 改用自建分位数 */
export const SELF_SAMPLE_MIN_DAYS = 20
const KEEP_DAYS = 60
const SAMPLE_RING = 40
/**写入事件记录的引擎版本（用于在面板上识别旧口径历史事件） */
/**
 * 评分引擎版本。**口径一改就必须升**（出分日志按它区分"当时用的是哪套权重与等级线"）。
 * v0.14.0：剔除 F2「超大单强度」+ 四项权重不归一（0.717）+ 等级线曾按权重合计缩放（**已废弃**）+ 交易时段闸门
 * v0.15.0：**等级集降为两级**（平静 / 资金异动 / 疑似护盘，线固定 35/55，**不缩放**）+ 连续评分/分位承载粒度
 * v0.16.0：**连续评分与它的跨日分位进快照契约**（`continuous`/`continuousPercentile`/`continuousPercentileN`/`continuousPercentileWhy`）
 *   —— 此前分位只在宿主算、没进契约，界面拿不到（契约缺口）；v0.15.0 的旧快照没有这三个字段 ⇒
 *   界面按"缺字段"处理：显示原因文案而不是凭空算一个（旧条目仍能说明当时用的是哪套权重与线）
 * ⇒ 旧条目按版本解读：0.13.0 = 五项权重 + 线 35/55/75 + 收盘后也出等级；0.14.0 = 剔 F2 但线 ×0.717（曾把等级整体上移 1 档）。
 */
export const ENGINE_VERSION = '0.16.0'
const INDEX_SECID = '1.000300'
const INDEX_NAME = '沪深300'

interface Sample {
  ts: number
  amount: number
  superNet: number
  mainNet: number
}

/**落盘的快照（去掉当日时间线/抽样这些已经在 days 里的重复内容） */
interface PersistedSnapshot {
  ts: number
  level: RescueLevel
  score: number
  summary: string
  factors: RescueFactor[]
  etfs: RescueEtfView[]
  indexPct: number | null
  indexName: string
  timeCoef: number
  /** 连续评分与它的跨日分位（v0.16.0 起进契约；持久化也保留 ⇒ 重启后界面照样能显示） */
  continuous?: RescueSnapshot['continuous']
  continuousPercentile?: RescueSnapshot['continuousPercentile']
  continuousPercentileN?: RescueSnapshot['continuousPercentileN']
  continuousPercentileWhy?: RescueSnapshot['continuousPercentileWhy']
  /** 六卡分钟序列（当日；已按点数/字节上限裁剪 ⇒ 文件有界） */
  etfSeries?: RescueSnapshot['etfSeries']
  resonance: RescueSnapshot['resonance']
  pulseBand: RescueSnapshot['pulseBand']
  completeness: RescueSnapshot['completeness']
  thresholdSource: RescueThresholdSource
  selfSampleDays: number
  config: RescueConfig
  activeIntervalSec: number
  /**数据来源（em/tencent）：收盘后重启时面板要能说明为什么缺分单资金流因子 */
  flowSource?: RescueSnapshot['flowSource']
  /**最近一次采样失败时刻（与 ts 严格分开） */
  lastFailTs?: RescueSnapshot['lastFailTs']
}

/**导出供自检：确认落盘时保留了"数据来源"与"失败时刻"这类诚实性字段 */
export function stripSnapshot(s: RescueSnapshot): PersistedSnapshot {
  // flowSource / lastFailTs 也要落盘：收盘后重启时面板才能说明"这份数据来自备用源
  // （所以缺分单资金流因子）"与"最近一次采样失败于何时"，而不是只剩一个时间戳
  const { ts, level, score, summary, factors, etfs, indexPct, indexName, timeCoef, continuous, continuousPercentile, continuousPercentileN, continuousPercentileWhy, etfSeries, resonance, pulseBand, completeness, thresholdSource, selfSampleDays, config, activeIntervalSec, flowSource, lastFailTs } = s
  return { ts, level, score, summary, factors, etfs, indexPct, indexName, timeCoef, continuous, continuousPercentile, continuousPercentileN, continuousPercentileWhy, etfSeries, resonance, pulseBand, completeness, thresholdSource, selfSampleDays, config, activeIntervalSec, flowSource, lastFailTs }
}

/**
 * 锁内合并（rescue-log 专用）：把"磁盘上那份"与"本进程这份"并成一份。
 * 每条规则都对应一种会丢的数据；改动前先看 docs/AUDIT-IMPL42.md §5.1。
 */
function mergeRescueLog(disk: unknown, mem: LogFile, base: Map<string, number>): LogFile {
  const onDisk = (disk !== null && typeof disk === 'object' ? disk : {}) as Partial<LogFile>
  const days: Record<string, DayLog> = { ...(onDisk.days ?? {}) }
  for (const [day, baseSamples] of base) {
    const mine = mem.days[day]
    if (mine === undefined) continue
    const theirs = days[day]
    // ① 计数：磁盘现值 + 我自上次成功写盘以来的拍数 ⇒ 两个进程各 +1 都留下
    const delta = Math.max(0, mine.samples - baseSamples)
    // ② 当日峰值不能被另一次较小的观测抹小
    const peak: Record<string, number> = { ...(theirs?.etfPeak ?? {}) }
    for (const [secid, v] of Object.entries(mine.etfPeak ?? {})) {
      const prev = peak[secid]
      if (typeof prev !== 'number' || v > prev) peak[secid] = v
    }
    const scoreLog = theirs?.scoreLog === undefined && mine.scoreLog === undefined
      ? undefined
      : mergeByKey(theirs?.scoreLog ?? [], mine.scoreLog ?? [], (s) => s.ts)
    days[day] = {
      ...theirs,                                     // 别的进程写进同一日的其它字段先留着
      ...mine,                                       // 本进程的视图（gap / etfLast / …）
      samples: (typeof theirs?.samples === 'number' ? theirs.samples : 0) + delta,
      events: mergeByKey(theirs?.events ?? [], mine.events ?? [], (e) => e.ts),
      intraday: mergeByKey(theirs?.intraday ?? [], mine.intraday ?? [], (p) => p.hhmm).slice(-120),
      etfPeak: peak,
      etfLast: { ...(theirs?.etfLast ?? {}), ...(mine.etfLast ?? {}) },
      ...(scoreLog === undefined ? {} : { scoreLog }),
    }
  }
  // ③ 裁剪放在**合并结果**上：只裁内存那份的话，被裁掉的旧日期会从磁盘"复活"
  const keys = Object.keys(days).sort()
  while (keys.length > KEEP_DAYS) {
    const drop = keys.shift()
    if (drop !== undefined) delete days[drop]
  }
  // ④ 本进程没动过的日（base 里没有的 key）一律用磁盘那份 —— 别的进程写的整天记录不许被我覆盖
  const selfSamples: LogFile['selfSamples'] = { ...(onDisk.selfSamples ?? {}) }
  for (const [secid, list] of Object.entries(mem.selfSamples ?? {})) {
    selfSamples[secid] = mergeByKey(selfSamples[secid] ?? [], list, (s) => s.day)
  }
  const pickSnapshot = (a?: PersistedSnapshot | null, b?: PersistedSnapshot | null): PersistedSnapshot | null => {
    if (a === undefined || a === null) return b ?? null
    if (b === undefined || b === null) return a
    return b.ts > a.ts ? b : a
  }
  return {
    v: mem.v,
    days,
    lastSnapshot: pickSnapshot(onDisk.lastSnapshot, mem.lastSnapshot),
    baselines: { ...(onDisk.baselines ?? {}), ...mem.baselines },
    selfSamples,
    progressCurve: mem.progressCurve ?? onDisk.progressCurve ?? null,
    progressSd: mem.progressSd ?? onDisk.progressSd ?? null,
    progressDays: Math.max(mem.progressDays ?? 0, onDisk.progressDays ?? 0),
    updatedAt: mem.updatedAt,
  }
}

/**一条出分日志（P0-7）：把各因子的原始值 + 当次生效阈值一起落盘，供阈值漂移回溯 */
interface ScoreLogEntry {
  ts: number
  hhmm: string
  score: number
  /**未乘时点系数的原始分；非交易时段 ⇒ null */
  rawScore: number | null
  /** 本次生效的等级线（= 基准线 {35,55} ÷ 时点系数；供界面/报告显示"为什么是这个等级"） */
  levelLines?: { t1: number; t2: number }
  timeCoef: number | null
  /** 连续评分（0–100 = raw ÷ 权重合计 × 100）；非交易时段 ⇒ null */
  continuous?: number | null
  /** 是否交易时段（false ⇒ 该样本不出等级、不计入当日最高等级） */
  inSession?: boolean
  /**评分引擎版本：口径改动后旧条目仍能说明"当时用的是哪套权重" */
  engine: string
  factors: Array<{ id: string; score: number; weight: number; actual: string; threshold: string; hit: boolean }>
}

interface DayLog {
  events: RescueSignalEvent[]
  intraday: RescueIntradayPoint[]
  samples: number
  gap: boolean
  /**
   * 出分日志（P0-7）。粒度=5 分钟刻度 + 等级变化时，而不是每 15/30 秒一条：
   * 后者在 60 天滚动窗口下会产生数万条记录（日志变成负担），而阈值漂移的回溯
   * 分辨率本来就不需要秒级 —— 分差不会在 5 分钟内漂。
   */
  scoreLog?: ScoreLogEntry[]
  /**当日各标的的超大单净额/20日均额 峰值（供 F2 自建分位升级） */
  etfPeak?: Record<string, number>
  /**当日各通道最后一次成功采样的完整视图（上游中断时用于复盘展示） */
  etfLast?: Record<string, RescueEtfView>
}

interface LogFile {
  v: number
  days: Record<string, DayLog>
  /**最后一次成功采样的快照（轻量版）：采样失败时作为 last-known-good 兜底 */
  lastSnapshot?: PersistedSnapshot | null
  /**每只 ETF 的 20 日均成交额基准 */
  baselines: Record<string, { avgAmt20: number; day: string; source: 'em' | 'tencent' | 'calibrated' }>
  /**自建样本：每只 ETF 每日收盘的超大单净额/20日均额（用于升级 F2 阈值） */
  selfSamples: Record<string, Array<{ day: string; superVsAvg: number }>>
  /**日内累计成交占比曲线（自建刷新） */
  progressCurve: number[] | null
  /** 同刻度基线：逐 slot 的 σ（长度固定 49 ⇒ 有界；与 curve 同一天更新一次） */
  progressSd?: number[] | null
  progressDays: number
  updatedAt: number
}

/**── 纯函数（selftest 覆盖）────────────────────────────────────────────── */

/** 每卡分钟序列的点数上限（A 股一整日 = 240 分钟 + 边界 ⇒ 242） */
export const RESCUE_CARD_MAX_POINTS = 242
/** 六卡分钟序列整块的序列化字节上限（超出从最旧的一端丢；当日不会无限长） */
export const RESCUE_CARD_SERIES_MAX_BYTES = 128 * 1024
/** 每卡序列的口径（进契约，界面原样展示；两套源都是"每分钟成交额"，腾讯链是累计差分推导值） */
export const RESCUE_CARD_SERIES_CALIBER = '每分钟成交额（元）·当日；腾讯分钟链的逐分钟值由累计额差分推导（amountDerived）'

/**
 * 六卡序列的**上限裁剪**（纯函数，可测）：① 每卡点数 ≤ maxPoints（保留最新）；
 * ② 整块序列化体积 ≤ maxBytes（超了就从最旧的分钟丢，六卡**同步**丢，保证各卡长度一致）。
 */
export function trimCardSeries(
  cards: readonly RescueCardSeries[],
  opts: { maxPoints?: number; maxBytes?: number } = {},
): { cards: RescueCardSeries[]; droppedPoints: number; bytes: number } {
  const maxPoints = opts.maxPoints ?? RESCUE_CARD_MAX_POINTS
  const maxBytes = opts.maxBytes ?? RESCUE_CARD_SERIES_MAX_BYTES
  let out = cards.map((c) => (c.points.length > maxPoints ? { ...c, points: c.points.slice(c.points.length - maxPoints) } : c))
  let dropped = cards.reduce((a, c) => a + Math.max(0, c.points.length - maxPoints), 0)
  let bytes = JSON.stringify(out).length
  while (bytes > maxBytes && (out[0]?.points.length ?? 0) > 1) {
    const cut = Math.max(1, Math.floor((out[0]?.points.length ?? 1) / 8))
    out = out.map((c) => ({ ...c, points: c.points.slice(Math.min(cut, Math.max(0, c.points.length - 1))) }))
    dropped += cut
    bytes = JSON.stringify(out).length
  }
  return { cards: out, droppedPoints: dropped, bytes }
}

/**
 * 由**已有**的分钟采样造六卡序列（纯函数；调用方传进来的 `minutes` 就是采样器那份缓存 ⇒ 不发请求）。
 * 没有序列的卡 ⇒ `points: []` + `why` 原因（**不许**补 0 冒充完整序列）。
 */
export function cardSeriesOf(
  metas: ReadonlyArray<{ secid: string; name: string }>,
  minutes: Readonly<Record<string, ReadonlyArray<{ label?: string; hhmm?: string; amount?: number | null; price?: number | null }>>>,
): RescueCardSeries[] {
  return metas.map((m) => {
    const pts = minutes[m.secid] ?? []
    if (pts.length === 0) {
      return { secid: m.secid, name: m.name, caliber: RESCUE_CARD_SERIES_CALIBER, points: [], why: '本次会话还没有拿到该标的的分钟序列（上游未返回或还没到 60 秒刷新时刻）⇒ 空数组，不补 0' }
    }
    return {
      secid: m.secid,
      name: m.name,
      caliber: RESCUE_CARD_SERIES_CALIBER,
      points: pts.map((p) => ({
        hhmm: String(p.hhmm ?? p.label ?? '').slice(-5),
        amount: typeof p.amount === 'number' && Number.isFinite(p.amount) ? p.amount : null,
        price: typeof p.price === 'number' && Number.isFinite(p.price) ? p.price : null,
      })),
      why: null,
    }
  })
}

/** 分时点保留上限（条） */
export const RESCUE_INTRADAY_MAX = 120
/** 分时点序列化体积上限（字节）——六通道字段进来之后必须有上界，否则当日文件会无节制变大 */
export const RESCUE_INTRADAY_MAX_BYTES = 192 * 1024
/**
 * 按**字节**裁剪当日分时点（纯函数，可测）：从最旧的一端丢，直到序列化体积落到上限内。
 * 条数上限（`RESCUE_INTRADAY_MAX`）另外由写入侧保证；两者都要有（条数少了但字段多了照样会胖）。
 */
export function trimIntradayBySize<T>(points: readonly T[], maxBytes = RESCUE_INTRADAY_MAX_BYTES): { points: T[]; dropped: number; bytes: number } {
  let out = [...points]
  let bytes = JSON.stringify(out).length
  let dropped = 0
  while (bytes > maxBytes && out.length > 1) {
    // 先丢最旧的 1/8（比逐条丢快，又不会一次砍太多）
    const cut = Math.max(1, Math.floor(out.length / 8))
    out = out.slice(cut)
    dropped += cut
    bytes = JSON.stringify(out).length
  }
  return { points: out, dropped, bytes }
}

/**HH:mm → 开盘后分钟数（0..240，午休折算到 120） */
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

/**日内累计成交占比（曲线索引 i = 开盘后 i*5 分钟），线性插值 */
export function progressAt(curve: readonly number[], elapsedMin: number): number {
  if (curve.length === 0) return elapsedMin >= 240 ? 1 : Math.max(0.02, elapsedMin / 240)
  const e = Math.max(0, Math.min(240, elapsedMin))
  const i = Math.floor(e / 5)
  const j = Math.min(curve.length - 1, i + 1)
  const frac = (e - i * 5) / 5
  const v = curve[i] + (curve[j] - curve[i]) * frac
  return Math.max(0.01, Math.min(1, v))
}

/**
 * 触发瞬间的**家数快照**解析（v0.18.0，纯函数 —— 只有缓存/本拍数据，**任何情况下都不取数**）。
 *
 * 优先级：① 本拍行情批量里的指数家数（`f104/f105/f106`，零成本、时刻最准）
 *         ② `/breadth` 最近一次成功结果（`BREADTH_MOMENT_TTL_MS` 内有效）
 *         ③ 两者都没有 ⇒ `{ moment: null, why: '…' }`（**不写 0**：0 会被读成"全市场无涨跌"）
 */
export const BREADTH_MOMENT_TTL_MS = 120_000
export function resolveBreadthMoment(args: {
  /** 本拍行情里的指数行（家数字段可能缺失；缺失 = null） */
  quote?: { up: number | null; down: number | null; even: number | null; amount: number | null; at: number } | null
  /** `/breadth` 最近一次成功结果（内存里记录的，不是新请求） */
  cached?: { up: number; down: number; even: number; amount: number | null; asOf: number; source: string } | null
  now: number
  ttlMs?: number
}): { moment: RescueBreadthMoment | null; why: string | null; source: 'tick-quote' | 'breadth-cache' | null } {
  const q = args.quote ?? null
  if (q !== null && typeof q.up === 'number' && typeof q.down === 'number' && typeof q.even === 'number') {
    return {
      moment: { up: q.up, down: q.down, even: q.even, amount: q.amount ?? null, asOf: q.at, source: '本拍行情（指数 f104/f105/f106）' },
      why: null, source: 'tick-quote',
    }
  }
  const c = args.cached ?? null
  const ttl = args.ttlMs ?? BREADTH_MOMENT_TTL_MS
  if (c !== null && args.now - c.asOf <= ttl) {
    return { moment: { up: c.up, down: c.down, even: c.even, amount: c.amount ?? null, asOf: c.asOf, source: c.source }, why: null, source: 'breadth-cache' }
  }
  return {
    moment: null,
    why: c === null
      ? '本拍行情没有指数家数字段，且 /breadth 还没有成功过一次（不为此单独发请求；等下一次 /breadth 或下一拍行情）'
      : `/breadth 的家数读数已过期（${Math.round((args.now - c.asOf) / 1000)}s > ${Math.round(ttl / 1000)}s）⇒ 不拿旧数冒充"触发瞬间"（不为此单独发请求）`,
    source: null,
  }
}

/**
 * **同刻度（同 5 分钟 slot）标准分** `z = (今天累计占比 − 同 slot 历史均值) / 同 slot 历史标准差`。
 *
 * 为什么需要它（用户口径 v0.17.0）：早盘量能天然偏小，旧的 `timeCoefficient(0.4)` 是这件事的**粗糙替代品** ——
 * 它把等级线整体抬高（35/0.4 = 87.5 > 四项上限 71.7）⇒ 早盘**数学上不可达**，真信号一起被压掉。
 * 有同刻度基线后，早盘按"同一时刻的历史分布"判高低 ⇒ 不需要动系数、也不需要动等级线。
 *
 * 返回 `null`（**不写 0**）当：样本不足（`n < SAME_SLOT_MIN_DAYS`）、σ 不可用（过小/非有限）、
 * 或当前进度本身取不到 —— 这三种情况一律**回落**到现有时点系数，并在悬停写明"基线不足，本次用时点系数替代"。
 */
export const SAME_SLOT_MIN_DAYS = 20
export function sameSlotZ(progressNow: number | null, mu: number | null, sd: number | null, days: number): number | null {
  if (progressNow === null || mu === null || sd === null) return null
  if (!Number.isFinite(progressNow) || !Number.isFinite(mu) || !Number.isFinite(sd)) return null
  if (days < SAME_SLOT_MIN_DAYS) return null
  // σ 过小（例如样本里各天几乎一样）⇒ 分不出高低，如实回落而不是给一个巨大的 z
  if (sd < Math.max(1e-4, mu * 0.05)) return null
  return Math.max(-5, Math.min(5, (progressNow - mu) / sd))
}

/**
 * z → 0–100 分的锚点（依次 40 / 70 / 100 分）：`0.75σ / 1.5σ / 2.5σ`。
 *
 * 依据是**标准分的分位含义**（不是"把门槛调低"）：标准正态下 0.75σ ≈ 高于约 23% 的时点、
 * 1.5σ ≈ 高于约 7%、2.5σ ≈ 高于约 0.6% —— 也就是说"要拿满分，得是历史上同刻极少见的放量"。
 * 与旧的 x 倍数锚点（`RESCUE_CALIBRATION.f1`）**不是一个刻度**，所以两者的数值不可直接比较。
 */
export const SAME_SLOT_Z_ANCHORS = [0.75, 1.5, 2.5] as const

/**分段线性记分：anchors 依次对应 40 / 70 / 100 分 */
export function interpScore(value: number, anchors: readonly [number, number, number]): number {
  const [a40, a70, a100] = anchors
  if (!Number.isFinite(value) || value <= 0) return 0
  if (value >= a100) return 100
  if (value < a40) return Math.round((40 * value) / a40)
  if (value < a70) return Math.round(40 + (30 * (value - a40)) / (a70 - a40))
  return Math.round(70 + (30 * (value - a70)) / (a100 - a70))
}

/**量价背离：指数越跌、越符合「恐慌中被托底」的护盘特征 */
export function divergenceScore(indexPct: number | null): number {
  if (indexPct === null || !Number.isFinite(indexPct)) return 50
  if (indexPct <= -1.0) return 100
  if (indexPct <= -0.3) return 80
  if (indexPct < 0) return 60
  if (indexPct <= 0.5) return 35
  return 20
}

/**全池共振：同时触发的宽基通道数 */
export function resonanceScore(count: number): number {
  if (count >= 3) return 100
  if (count === 2) return 70
  if (count === 1) return 40
  return 0
}

/**等级线基准（平静 < t1 ≤ 资金异动 < t2 ≤ 疑似护盘）；**按时点系数缩放后**使用；强护盘已删除（两级） */
/**
 * 等级线基准（**历史值，不随权重合计缩放**）：`raw >= 35` ⇒ 资金异动，`raw >= 55` ⇒ 疑似护盘。
 *
 * 为什么不缩放（Lead 决策 ②）：剔除 F2 只影响 0.283 的权重，而 F2 历史 p90 = 1 分 ⇒ 等效门槛本来就没变；
 * 把线乘 0.717 等于把剩下四项放大 1.40× ⇒ 回放实测 8 天有 5 天等级 +1（伪信号）。
 * 与历史逐日一致（305 样本仅 1 个样本因 F2 偶发 0–4 分不同，见报告）。
 */
export const RESCUE_LEVEL_BASE = [35, 55] as const

/**
 * 等级线（按时点系数缩放）。系数越大（越靠近尾盘）线越低 ⇒ 越容易出等级；
 * 系数越小（早盘）线越高 ⇒ 越保守（早盘成交量天然少，不设更严的线会被误读成"有资金托底"）。
 */
export function levelLines(coef: number): { t1: number; t2: number } {
  const c = Number.isFinite(coef) && coef > 0 ? coef : 1
  return { t1: RESCUE_LEVEL_BASE[0] / c, t2: RESCUE_LEVEL_BASE[1] / c }
}

/**
 * **规则等级**（唯一入口，尚未施加防误报 caps）：`raw` 与缩放后的等级线比较。
 *
 * 抽成纯函数的理由：①断言与历史口径可以直接对拍（`rescueWeights.test.ts` 的等效性用例）；
 * ②回放/注入只需要这一个判据，不会出现"两处各写一遍比较逻辑"。
 */
export function ruleLevel(raw: number, coef: number): RescueLevel {
  const l = levelLines(coef)
  return raw >= l.t2 ? 2 : raw >= l.t1 ? 1 : 0
}

/** 交易时段（09:30–11:30、13:00–15:00）：**采样闸门**的唯一判据（与 `sessionElapsed` 同源口径） */
export function inTradingSession(hhmm: string): boolean {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim())
  if (m === null) return false
  const mins = Number(m[1]) * 60 + Number(m[2])
  return (mins >= 570 && mins <= 690) || (mins >= 780 && mins <= 900)
}

/**
 * 连续评分（0–100，可跨样本比较）：`raw ÷ 权重合计 × 100`。
 *
 * 为什么需要它：权重合计不再是 1.000 ⇒ `raw` 的绝对值不可跨口径比较，而"当前偏强还是偏弱"
 * 需要一个稳定刻度。同时给「近 N 个样本的分位」——样本不足（< 5）时**如实返回 null**，不编。
 */
export function scorePercentile(value: number, history: readonly number[], minSamples = 5): { pct: number; n: number } | null {
  const xs = history.filter((x) => Number.isFinite(x))
  if (xs.length < minSamples) return null
  return { pct: (xs.filter((x) => x <= value).length / xs.length) * 100, n: xs.length }
}

/**时点系数：午后与尾盘是护盘的典型时点，早盘天量多为情绪 */
export function timeCoefficient(elapsedMin: number): number {
  if (elapsedMin <= 0) return 0.4
  if (elapsedMin < 60) return 0.4
  if (elapsedMin < 120) return 0.7
  if (elapsedMin < 180) return 1.0
  return 1.1
}

export interface RescueFactorInput {
  timeAdjMult: number | null
  /**
   * **同刻度 z**（同一 5 分钟 slot 的历史分布标准分；取六通道里最强的那个）。
   * `null` ⇒ 基线不足/σ 不可用 ⇒ **回落**到时点系数，并在归因里写明（不静默）。
   */
  volumeZ?: number | null
  /** 同刻度基线的样本天数（用于归因与"是否够 20 日"的判据） */
  volumeZDays?: number
  /**核心通道的最大 超大单/20日均额（F2 以核心通道为主） */
  coreSuperVsAvg: number | null
  /**外围通道的最大 超大单/20日均额（单独净流入时打折） */
  peripheralSuperVsAvg: number | null
  pulseMult: number | null
  /**持续性：最近窗口内 超大单净增 ÷ 该窗口成交额 */
  persistShare: number | null
  /**该窗口内单次最大回撤 ÷ 净增（>0.5 说明反复进出，打折） */
  retraceRatio: number | null
  indexPct: number | null
  /**共振：总只数 / 核心通道命中数 / 外围通道命中数 / 命中通道名 */
  resonance: number
  coreResonance?: number
  peripheralResonance?: number
  resonanceLanes?: string[]
  /**核心通道中最差的 超大单占比（用于否决） */
  coreWorstShare?: number | null
  /**分单资金流是否可得（腾讯备用源下为 false） */
  flowAvailable?: boolean
  /**
   * 是否在**交易时段**内（09:30–11:30 / 13:00–15:00）。
   *
   * `false` ⇒ 本次**不出等级**（`level` 恒 0、`timeCoef`/`rawScore`/`continuous`/`percentile` 全为 null，
   * 归因写明「非交易时段」），调用方也不得把它写进事件与 5 分钟抽样、不得计入当日最高等级。
   * 缺省 `true`：纯函数调用方（测试/回放）不受影响。
   */
  inSession?: boolean
  /**近 N 个样本的连续评分（用于分位；样本 < 5 ⇒ 分位为 null）。由调用方从出分日志取 */
  recentContinuous?: readonly number[]
  /**F2 锚点（可被自建分位数覆盖） */
  f2Anchors: [number, number, number]
  f2Source: RescueThresholdSource
  /**时点系数；缺省 1（纯函数不读时钟，便于自检） */
  timeCoef?: number
  /**当前是否为尾盘（14:30 后） */
  isTail?: boolean
  /**当前时段的脉冲锚点 */
  pulseAnchors?: [number, number, number]
  /**当前时段标签（早盘/午后/尾盘…） */
  bandLabel?: string
  /**交易阶段（用于脉冲命名与完整度说明） */
  phase?: RescuePhase
}

/**因子可用度：数据缺失（如冷启动回填失败）时如实标注，不假装完整 */
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
  /**
   * 时点系数（P0-7）。总分 = round(Σ 贡献度 × timeCoef)，
   * 界面必须能据此复算：只给总分不给系数时，"这一分是谁加的"永远答不上来。
   */
  timeCoef: number
  /**Σ 贡献度（= 未乘时点系数的原始分）。与 score 的差全部来自 timeCoef 与四舍五入；非交易时段 ⇒ null */
  rawScore: number | null
  /**
   * 本次生效的**等级线**（= 基准线 {35,55,75} ÷ timeCoef）。
   *
   * 等级判据只认它（`raw ≥ line`），`score` 仅用于展示 —— 这样"时点调整"只有一处，
   * 不会出现"分数乘一次系数、阈值再乘一次"的双重计算。
   */
  levelLines: { t1: number; t2: number }
  /** 本次是否在交易时段内（false ⇒ 上面那些数字全为 null，且不出等级） */
  inSession: boolean
  /** 连续评分（0–100）：`raw ÷ 权重合计 × 100`；非交易时段 ⇒ null */
  continuous: number | null
  /** 连续评分在近 N 个样本里的分位（0–100）；样本不足 ⇒ null（不编） */
  percentile: number | null
  /** 分位的样本数（0 = 还没有跨日样本；与 `percentile` 同时给出，供界面写 N=…） */
  percentileN: number
  /** 分位算不出来的原因（样本不足/无历史）；算得出来时为 null */
  percentileWhy: string | null
  /**
   * 内部矛盾标记（P6）：**只做展示与归因，不改分数、不改等级**（红线：不得用这类代理指标升级信号）。
   *
   * 用途：对"按单笔成交金额分档"这一资金流口径的已知缺陷给出**可检测代理** ——
   * 量能显著放大却看不到超大单净流入，可能是拆单/算法单（TWAP/VWAP）或纯被动成交，
   * 不能读作"有资金在托底"。
   */
  contradiction: string | null
}

const fmt = (v: number | null, unit: string, digits = 2): string => (v === null ? '—' : `${v.toFixed(digits)}${unit}`)

/**
 * 六因子合成：S = Σ w·f × 时点系数，再施加防误报封顶。
 *
 * P0 修订（针对「早盘噪音被读成护盘」「脉冲过松」「持续性无门槛」）：
 *  - 时点系数真正接入（此前 tick 未传，运行时恒为 1 → 早盘满权重）
 *  - F2 以核心通道为主：只有外围通道净流入时打折；核心通道大额净流出直接否决
 *  - F3 改名并分档：尾盘（14:30 后）为「尾盘突袭」满分权重，盘中为「盘中脉冲」并打折
 *  - F4 从「连续递增次数」改为时间 + 幅度：窗口内净增 ÷ 窗口成交额
 *  - 三级（强护盘）要求核心通道参与共振
 */
export function scoreRescue(input: RescueFactorInput): RescueScoreResult {
  const pulseAnchors = input.pulseAnchors ?? PULSE_ANCHORS
  const isTail = input.isTail ?? false
  const bandLabel = input.bandLabel ?? (isTail ? '尾盘' : '盘中')
  const phase: RescuePhase = input.phase ?? (isTail ? 'tail' : 'pm')

  /**
   * 量能因子（v0.17.0）：**有同刻度基线就按 z 归一**（同一时刻的历史分布），
   * 没有才回落到旧的"同时点倍数 × 时点系数"那套，并在归因里写明"基线不足，本次用时点系数替代"。
   */
  const volumeZ = input.volumeZ ?? null
  const volumeZDays = input.volumeZDays ?? 0
  const sameSlot = volumeZ !== null
  const f1 = sameSlot
    ? interpScore(volumeZ, SAME_SLOT_Z_ANCHORS)
    : interpScore(input.timeAdjMult ?? 0, [RESCUE_CALIBRATION.f1.mid, RESCUE_CALIBRATION.f1.high, RESCUE_CALIBRATION.f1.extreme])

  // F2「超大单强度」**已剔除**（AUDIT-IMPL54 批 A′+B）：宽基 ETF 的分单数据太稀疏 ——
  // 305 个历史样本里该因子分 p90 = 1 / max = 15，原始输入 p90 = 0.01×20 日均额 ⇒ 恒 0，只占权重。
  // 剔除后**保留原权重不归一**（合计 0.717），等级线保持历史值 35/55/75 ⇒ 判据逐样本等效。
  // 这里只保留"符号事实"读数（核心优先、否则外围）：它仍被 L3 前置与内部矛盾标记使用，
  // 但**不再参与打分**（也不做 0.7 折算 —— 那是 F2 的算法，已随因子一起删除）。
  const core = input.coreSuperVsAvg ?? null
  const peri = input.peripheralSuperVsAvg ?? null
  /** 超大单读数（核心优先、否则外围）：> 0 表示"看得到净流入" */
  const flowSign = core !== null ? core : peri

  // F3：脉冲。盘中打折，尾盘满分；命中线为该时段 P90
  const rawPulse = interpScore(input.pulseMult ?? 0, pulseAnchors)
  const f3 = Math.round(rawPulse * (isTail ? 1 : INTRADAY_PULSE_DISCOUNT))

  // F4：持续性 = 窗口内净增 ÷ 窗口成交额（自归一，与采样间隔无关）；反复进出打折
  let f4 = interpScore(input.persistShare ?? 0, PERSIST_ANCHORS)
  const retrace = input.retraceRatio
  if (f4 > 0 && retrace !== null && retrace > 0.5) f4 = Math.round(f4 * 0.6)

  const f5 = divergenceScore(input.indexPct)

  const factors: RescueFactor[] = [
    {
      id: 'volume', label: '量能放大', score: f1, weight: RESCUE_WEIGHTS.volume,
      // 口径随"用哪套"而变：有同刻度基线 ⇒ 显示 z；否则显示旧的倍数（两套刻度不可直接比，所以标注也分开）
      actual: sameSlot ? `z=${volumeZ.toFixed(2)}` : fmt(input.timeAdjMult, 'x'),
      threshold: sameSlot
        ? `同刻度 z（近 ${volumeZDays} 个交易日、同一 5 分钟 slot 的历史分布；锚点 ${SAME_SLOT_Z_ANCHORS.join('/')}σ ⇒ 40/70/100 分）`
        : `同时点量能倍数（P75/P90/P95 ${RESCUE_CALIBRATION.f1.mid}/${RESCUE_CALIBRATION.f1.high}/${RESCUE_CALIBRATION.f1.extreme}x 历史标定）；⚠ 同刻度基线不足（${volumeZDays}/${SAME_SLOT_MIN_DAYS} 日）⇒ 本次用时点系数替代`,
      hit: f1 >= 40,
    },
    {
      id: 'pulse', label: pulseFactorLabel(phase), score: f3, weight: RESCUE_WEIGHTS.pulse,
      actual: `${fmt(input.pulseMult, 'x')}${input.pulseMult !== null && !isTail ? '（打 0.6 折）' : ''}`,
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
  ]

  const raw = factors.reduce((a, f) => a + f.weight * f.score, 0)
  /**
   * **时点系数降级为兜底**（用户口径 v0.17.0）：基线可用时它**不参与**（系数按 1 算 ⇒ 等级线就是 35/55，
   * 早盘不再被抬到 87.5/137.5 那种不可达的位置）；只有基线不足时（冷启动/σ 不可用）才照旧参与。
   */
  const coefInput = input.timeCoef ?? 1
  const coef = sameSlot ? 1 : coefInput
  const score = Math.max(0, Math.min(100, Math.round(raw * coef)))
  /**
   * 连续评分（0–100）：`raw ÷ 权重合计 × 100`。
   * 权重合计已不是 1.000（剔 F2 且不归一）⇒ 用比值把"当前偏强/偏弱"拉回稳定刻度，
   * 并据此算近 N 个样本的分位（样本 < 5 ⇒ null，不编）。
   */
  // raw 的单位是"分×权重"（上限 = 权重合计 × 100 = 71.7）⇒ 除以权重合计即回到 0–100 的稳定刻度
  const continuous = Math.max(0, Math.min(100, raw / RESCUE_WEIGHT_SUM))
  /** 跨日样本（宿主从出分日志取，最近 ≤20 条；客户端**不**参与计算） */
  const pctHistory = (input.recentContinuous ?? []).filter((x) => Number.isFinite(x))
  const pct = scorePercentile(continuous, pctHistory)
  /**
   * 等级线**按时点系数缩放**（唯一一处时点调整；`score` 只用于展示）。
   *
   * 为什么把调整做在**线**上而不是分数上（用户给的二选一里的推荐项）：
   *   - 旧实现是 `score = raw × coef` 再与固定线 `{35,55,75}` 比较 —— 判据里同时躺着"系数"
   *     与"线"两套机制，任何一处单独调整都会变成双重计算；
   *   - 现在等级只由 `raw` 与**缩放后的线**比较得出，缩放方向即"越早越保守"：
   *     早盘 0.4 ⇒ 线升到 87.5/137.5/187.5（>100 的线意味着早盘不可能上「疑似/强」），
   *     尾盘 1.1 ⇒ 线降到 31.8/50/68.2。
   * 与旧实现的差异只在取整边界（±1 分），方向唯一：早盘只会更保守、不会更激进。
   */
  const lines = levelLines(coef)
  const scaled: RescueLevel = ruleLevel(raw, coef)

  /**
   * **交易时段闸门**（AUDIT-IMPL54 批 A-1）：非交易时段（收盘后、午休、开盘前）**不出等级**。
   *
   * 为什么：时点系数假设"越晚越接近尾盘"（≥180min ⇒ 1.1，线最低），但收盘后这个假设失效 ——
   * 实测日志里有 16:49 / 21:56 / 22:26 / 22:30 的采样点，它们会拿到**最宽松的线**去判等级。
   * 现在：非交易时段 ⇒ `coef/raw/continuous/percentile` 全为 null、`level = 0`、归因写明原因；
   * 调用方（采样子系统）不把它写进事件与 5 分钟抽样，也不计入当日最高等级。
   */
  const inSession = input.inSession !== false
  if (!inSession) {
    // 因子可用度照常如实统计（读数确实存在，只是这次不用它判等级）——不要写成"全缺"
    const av: Array<[string, boolean]> = [
      ['量能放大', input.timeAdjMult !== null],
      ['脉冲', input.pulseMult !== null],
      ['持续性', input.persistShare !== null],
      ['量价背离', input.indexPct !== null],
    ]
    const miss = av.filter(([, ok]) => !ok).map(([label]) => label)
    return {
      score: 0,
      level: 0,
      factors,
      summary: `非交易时段（${fmt(input.indexPct, '%')} 为当时指数读数）：本次不出等级、不计入当日最高等级；量能与资金读数仅供参考（样本保留为留痕）`,
      completeness: { available: av.length - miss.length, total: av.length, missing: miss },
      timeCoef: null,
      rawScore: null,
      levelLines: lines,
      inSession: false,
      continuous: null,
      percentile: null,
      percentileN: 0,
      percentileWhy: '非交易时段：这次不出等级、也不算连续评分与分位',
      contradiction: null,
    }
  }

  // 防误报约束（每条都写进归因，不做静默降级）
  const caps: string[] = []
  let level = scaled

  // 0) 资金流数据缺失（备用源只有量能与价格）：无法证明"有资金在托底"，封顶为资金异动
  if (input.flowAvailable === false && level > 1) {
    level = 1
    caps.push('分单资金流数据不可用（备用源仅提供量能与价格）→ 无法确认托底资金，封顶为资金异动')
  }
  // 0b) 核心通道否决：沪深300/上证50 出现大额超大单净流出时，不论其它通道如何都不给「疑似护盘」
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
  // 3)（原「强护盘」前置已删除：L3 不在等级集里）
  /** 超大单符号是否为正（**说明项**：用于连续评分/分位与防误报降级，不再是等级前置） */
  const flowPositive = flowSign !== null && flowSign > 0
  // 4) 疑似信号至少要有量能或"看得见的净流入"之一
  if (level === 2 && !flowPositive && f1 < 70) {
    level = 1
    caps.push('量能未达中档且超大单读数为负/未取到 → 降为资金异动')
  }
  if (!flowPositive && f4 < 40 && level > 1) {
    level = 1
    caps.push('超大单无有效净流入且持续性不足 → 降为资金异动')
  }

  // 因子可用度：脉冲/持续性在冷启动回填失败时会缺，必须如实标注而不是假装完整
  // 因子可用度：只统计**仍在评分里**的四个因子（F2 与"全池共振"已剔除，不再计入 total）
  const availability: Array<[string, boolean]> = [
    ['量能放大', input.timeAdjMult !== null],
    ['脉冲', input.pulseMult !== null],
    ['持续性', input.persistShare !== null],
    ['量价背离', input.indexPct !== null],
  ]
  const missing = availability.filter(([, ok]) => !ok).map(([label]) => label)
  const completeness: RescueCompleteness = { available: availability.length - missing.length, total: availability.length, missing }

  const hits = factors.filter((f) => f.hit).map((f) => `${f.label} ${f.actual}`).join(' · ')
  const base = level === 0 || hits === '' ? '宽基 ETF 量能与资金流均在常态区间（无异动）' : hits
  const incomplete = missing.length > 0 ? `；因子 ${completeness.available}/${completeness.total}（缺 ${missing.join('、')}，评分偏保守）` : ''
  /**
   * F2 剔除的**如实标注**（红线：缺数据说缺数据，不许用常数顶替）。
   * 提示词里带上样本量与分位，读者能自己判断"剔除"是否合理。
   */
  const removedNote = '；已剔除「超大单强度」因子：宽基 ETF 分单数据稀疏（305 样本 p90 = 0.01×20 日均额），该因子不可用'
  /**
   * 量能口径一句话（进归因、也进悬停）：**有同刻度基线就用它，没有就如实说"用时点系数替代"**。
   * 这条不只是解释，也是"不得静默"的落点：面板/工具输出里能直接读到本次到底用了哪套。
   */
  const volumeNote = sameSlot
    ? `量能口径：同刻度 z=${volumeZ.toFixed(2)}（近 ${volumeZDays} 日同 slot 分布）⇒ 时点系数不参与`
    : `量能口径：同刻度基线不足（${volumeZDays}/${SAME_SLOT_MIN_DAYS} 日）⇒ 本次用时点系数 ${coefInput} 替代（不是静默：这一句就是替代声明）`
  const contNote = `连续评分 ${continuous.toFixed(1)}/100（${pct === null ? '近 20 日分位 —（样本不足 5）' : `近 20 日分位 ${pct.pct.toFixed(0)}%，N=${pct.n}`}；生效时点系数 ${coef}；${volumeNote}）`
  /**
   * 两个**说明项**（Lead 决策：不再作为等级前置，只解释连续评分/分位）：
   *   · 核心通道共振只数；· 超大单读数符号。等级只由 `raw` 与两条线（35/55）决定。
   */
  const advisory = `；说明项（不参与等级判定）：核心共振 ${input.coreResonance ?? 0} 只、超大单读数 ${flowSign === null ? '未取到' : `${flowSign.toFixed(3)}x（符号${flowSign > 0 ? '为正' : flowSign < 0 ? '为负' : '为零'}）`}`
  /**
   * P6 内部矛盾：量增（同时点量能倍数 ≥ 标定 P90）**但**超大单读数 ≤ 0。
   *
   * ⚠ 这条**不改分数、不改等级**（只进归因与展示）。阈值取标定值 `f1.high`（= P90 = 1.57x），
   * 不用手调数字；超大单读数取"核心优先、否则外围"的口径（与 F2 同源，但不折外围的 0.7 折 ——
   * 这里只判"有没有净流入"这一符号事实）。
   */
  const contradiction = input.timeAdjMult !== null && flowSign !== null && input.timeAdjMult >= RESCUE_CALIBRATION.f1.high && flowSign <= 0
    ? `量能放大（同时点倍数 ${input.timeAdjMult.toFixed(2)}x ≥ P90 ${RESCUE_CALIBRATION.f1.high}x）但超大单读数 ≤ 0（${flowSign.toFixed(3)}x）⇒ 可能是拆单/算法单或纯被动成交，不能读作"有资金托底"`
    : null
  const contraNote = contradiction === null ? '' : `；⚠ 内部矛盾：${contradiction}`
  const summary = `${base}${caps.length > 0 ? ` —— ${caps.join('；')}` : ''}（评分 ${score}，${contNote}${incomplete}${advisory}${removedNote}）${contraNote}`
  return {
    score, level, factors, summary, completeness,
    timeCoef: coef, rawScore: raw, levelLines: lines,
    inSession: true, continuous, percentile: pct === null ? null : pct.pct,
    percentileN: pctHistory.length,
    percentileWhy: pct === null
      ? (pctHistory.length === 0
        ? '还没有跨日样本（连续评分需要历史样本；冷启动当天为 0 条）'
        : `跨日样本不足（${pctHistory.length} < 5）—— 不编分位，也不用 0 顶替`)
      : null,
    contradiction,
  }
}

/**
 * 快照契约里与"连续评分 + 跨日分位"有关的那组字段（**唯一映射实现**，可单测）。
 *
 * 为什么单独抽出来：这段映射只有在"真的采到一次样"时才会跑到（而多数用例是离线/休市路径），
 * 抽成纯函数后，"分位与宿主算法一致 / 样本不足给 null + 原因"这两条判据才**可能被守住**。
 */
export function snapshotContractFields(scored: RescueScoreResult): Pick<RescueSnapshot, 'continuous' | 'continuousPercentile' | 'continuousPercentileN' | 'continuousPercentileWhy'> {
  return {
    continuous: scored.continuous === null ? null : Math.round(scored.continuous * 10) / 10,
    continuousPercentile: scored.percentile === null ? null : Math.round(scored.percentile * 10) / 10,
    continuousPercentileN: scored.percentileN,
    continuousPercentileWhy: scored.percentileWhy,
  }
}

/**
 * 因子贡献度（P0-7）：权 × 因子分。
 *
 * 存在的理由：此前只给总分与六因子，用户看到 `评分 68` 与 `量能 ×2.1`、`超大单 ×0.3`
 * 无法判断"这一分到底是谁加的"——是量能撑起来的，还是背离（跌出来的）撑起来的，
 * 两者的操作含义完全相反。贡献度列把总分拆开，且求和可复算（见 selftest）。
 */
export function factorContributions(
  factors: readonly RescueFactor[],
  timeCoef: number,
): Array<{ id: RescueFactor['id']; label: string; weight: number; score: number; contribution: number }> {
  return factors.map((f) => ({
    id: f.id,
    label: f.label,
    weight: f.weight,
    score: f.score,
    contribution: f.weight * f.score * timeCoef,
  }))
}

/**
 * HH:mm（北京时间）—— 护盘的采样时段、阶段语义、时点系数全部基于它。
 * 必须钉死 Asia/Shanghai：宿主为 UTC（Docker/云主机/CI 默认）时，
 * 用本地时间会把真实盘中判成"盘前"→ 采样一次都不触发（见 host/time.ts）。
 */
const hhmmOf = (ts: number): string => shHhmmOf(ts)

/**YYYY-MM-DD（北京时间自然日）：驱动 todayKey / rollDay / 60 日归档 */
const dayOf = (ts: number): string => shDayOf(ts)

/**
 * A股**法定休市日**（整日休市；周末不在此列 —— 由 `shWeekdayOf` 判定）。
 *
 * 来源：上海证券交易所《关于上海证券交易所2026年部分节假日休市安排的通知》
 * （上证公告〔2025〕45号，2025-12-22）：元旦 1/1–1/3、春节 2/15–2/23、清明 4/4–4/6、
 * 劳动节 5/1–5/5、端午 6/19–6/21、中秋 9/25–9/27、国庆 10/1–10/7（**10/8 起照常开市**）。
 * 区间里落在周末的日子不用单列（星期判定已经会拦掉）。
 *
 * ⚠ 这是**年限快照**：表过期后 `holidayOf` 不再命中 ⇒ 退化为「周末 + 未命中即按交易日」，
 * 即失败方向是**多采一天**而不是把真交易日误判成休市（后者会漏掉真实信号）。新公告发布后更新本表。
 */
export const A_SHARE_HOLIDAYS: readonly { from: string; to: string; name: string }[] = [
  { from: '2026-01-01', to: '2026-01-03', name: '元旦' },
  { from: '2026-02-15', to: '2026-02-23', name: '春节' },
  { from: '2026-04-04', to: '2026-04-06', name: '清明节' },
  { from: '2026-05-01', to: '2026-05-05', name: '劳动节' },
  { from: '2026-06-19', to: '2026-06-21', name: '端午节' },
  { from: '2026-09-25', to: '2026-09-27', name: '中秋节' },
  { from: '2026-10-01', to: '2026-10-07', name: '国庆节' },
]

/** 命中法定休市日则给出假期名（按 `YYYY-MM-DD` 字符串比较，无时区参与） */
export function holidayOf(day: string): { name: string } | null {
  for (const h of A_SHARE_HOLIDAYS) if (day >= h.from && day <= h.to) return { name: h.name }
  return null
}

interface TradingDayState {
  trading: boolean
  /** 非交易日的原因：周末 / 法定假日 */
  reason: 'weekend' | 'holiday' | null
  /** 人类可读的假期名（周末为 null） */
  label: string | null
}

/**
 * 交易日判定（纯函数）：周末 + 法定假日。
 *
 * 为什么不用「指数当日有没有成交」当主判据：那是**延时行情**，节假日它会回上一交易日的收盘值
 * （`amount` 也还是上一日的），只能靠时间戳分辨 —— 时间戳在跨零点/半日市/上游陈旧时会给出
 * 假的「今天有成交」。因此主判据用**离线可判定的日历**（周末 + 上交所公告表）：确定性、零请求、
 * 不依赖上游；失败方向是「表过期 ⇒ 多采一天」，不会把交易日误判成休市。
 */
export function tradingDayState(ts: number): TradingDayState {
  const dow = shWeekdayOf(ts)
  if (dow === 0 || dow === 6) return { trading: false, reason: 'weekend', label: null }
  const day = dayOf(ts)
  /**
   * 优先级：**外部覆盖文件 > 内置假日表 > 周末规则**（见 `tradingCalendar.ts` 文件头）。
   *
   * 外部文件是用户每月手工维护的（交易所公告抄一次），内置表是**退路**：文件缺失/损坏/未覆盖
   * 当月时退回内置表；内置表也没命中 ⇒ 按交易日处理（失败方向 = 多采一天，不会漏采）。
   * 退回这件事**必须可见** —— 状态由 `snapshot().calendarStatus` 与 agent 工具输出携带。
   */
  if (monthCoveredByFile(day.slice(0, 7))) {
    // 覆盖当月 ⇒ **以文件为准**：文件说是休市就是休市；文件没写的就是交易日（内置表不参与）
    return externalClosureOf(day)
      ? { trading: false, reason: 'holiday', label: '外部日历（手工维护）' }
      : { trading: true, reason: null, label: null }
  }
  const hol = holidayOf(day)
  if (hol !== null) return { trading: false, reason: 'holiday', label: hol.name }
  return { trading: true, reason: null, label: null }
}

/**是否处于采样时段（含开盘前 5 分钟与收盘后 5 分钟收口）；**非交易日一律 false** */
export function inTradingWindow(ts: number): boolean {
  // 是否交易日**只由 `tradingDayState` 判定**（周末 → 外部文件 → 内置表，一处实现）：
  // 这里再写一遍星期/假日判断会让"外部文件覆盖当月"在这条快速路径上失效（实测：文件把 10-09
  // 标成休市，但采样窗口仍把它当交易日 ⇒ 定时器照采）
  if (tradingDayState(ts).trading !== true) return false
  const hhmm = hhmmOf(ts)
  return (hhmm >= '09:25' && hhmm <= '11:35') || (hhmm >= '12:55' && hhmm <= '15:05')
}

/**采样时段分段（与 inTradingWindow 必须同源：窗口边界只有这一份） */
const SAMPLE_WINDOWS: ReadonlyArray<{ from: string; to: string }> = [
  { from: '09:25', to: '11:35' },
  { from: '12:55', to: '15:05' },
]

/**
 * 采样窗口状态（P0-4）。分数位在非采样时段是空的，必须能说清"暂停采样"而不是"坏了"，
 * 因此这里给出原因与下次采样时刻，供界面显示 `采样暂停 · 下次 10-09 09:25`。
 *
 * 纯函数（只依赖 `ts` 与配置），因此可以直接断言跨周末/跨午休的边界。
 */
export function samplingWindow(
  ts: number,
  opts: { enabled: boolean; intervalSec: number; samples: number },
): RescueActiveWindow {
  const intervalSec = opts.intervalSec
  if (!opts.enabled) {
    return { sampling: false, reason: 'disabled', nextAt: null, nextLabel: null, intervalSec, samples: opts.samples }
  }
  const hhmm = hhmmOf(ts)
  const sampling = inTradingWindow(ts)
  if (sampling) {
    return { sampling: true, nextAt: null, nextLabel: null, intervalSec, samples: opts.samples }
  }
  const dayState = tradingDayState(ts)
  const reason: RescueActiveWindow['reason'] = !dayState.trading
    ? (dayState.reason === 'holiday' ? 'holiday' : 'weekend')
    : hhmm > '11:35' && hhmm < '12:55' ? 'noon-break' : 'closed'
  // 下一个窗口起点：今天剩下的窗口 → 否则回溯到下一个交易日 09:25（周末与法定假日逐日跳过）
  let nextAt: number | null = null
  for (let i = 0; i < 15 && nextAt === null; i += 1) {
    const day = shDayOf(ts + i * 86_400_000)
    if (tradingDayState(Date.parse(`${day}T09:25:00+08:00`)).trading !== true) continue
    for (const w of SAMPLE_WINDOWS) {
      const at = Date.parse(`${day}T${w.from}:00+08:00`)
      if (at > ts) {
        nextAt = at
        break
      }
    }
  }
  const nextLabel = nextAt === null ? null : dayOf(nextAt).slice(5) + ' ' + hhmmOf(nextAt)
  return { sampling: false, reason, nextAt, nextLabel, intervalSec, samples: opts.samples }
}

/**采样点（窗口资金流统计的输入） */
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

 // 才能当作"5 分钟前"的参考；且序列末端必须贴近 evalAt（`evalTs - last <= maxLagMs`）。
 // 为什么必须卡这两个边界（v0.21.0 修的 bug）：分钟序列此前每天只在冷启动回填写一次，
export function pickPulseRef(
  series: readonly { ts: number; amount: number }[],
  evalTs: number,
  evalAt: number,
  windowMs = FLOW_WINDOW_MS,
  opts: { maxLagMs?: number; toleranceMs?: number } = {},
): { ref: { ts: number; amount: number }; evalAt: number } | null {
  if (series.length === 0) return null
  const maxLag = opts.maxLagMs ?? 60_000
  const tol = opts.toleranceMs ?? 30_000
  const last = series[series.length - 1]
  // 序列末端离评估时点太远（过期）→ 不用序列口径
  if (last.ts < evalTs - maxLag) return null
  const at = Math.min(evalAt, last.ts)
  const low = at - windowMs - tol
  const high = at - windowMs + tol
  let ref: { ts: number; amount: number } | null = null
  for (const p of series) {
    if (p.ts < low || p.ts > high) continue
    if (ref === null || p.ts > ref.ts) ref = p
  }
  return ref === null ? null : { ref, evalAt: at }
}

/**自建样本分位数（升序数组的线性插值分位） */
export function quantile(sorted: readonly number[], p: number): number | null {
  if (sorted.length === 0) return null
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.round((p / 100) * (sorted.length - 1))))
  return sorted[idx]
}

/**── 网络取数 ──────────────────────────────────────────────────────────── */

/**
 * 采样器取数：复用行情中继的同一套骨架（2 轮 × 每主机 2 次 + 抖动退避 + 9 秒总截止
 * + 按主机熔断与半开探针，见 em.fetchAny）。
 *
 * 此前这里自己实现了一套，且用单台 push2delay 的熔断器当整组闸门：
 *   - push2delay 冷却时，健康的 push2 被一起挡掉 → 采样器与日线一并停摆；
 *   - 反过来 push2his 熔断时闸门毫无反应，采样器仍然每 15s 打一遍不可达主机。
 * 重复实现带来的第二个后果是两条链路的退避节奏不同（抖动间隔、截止时间各写一份）。
 */
async function fetchData(hosts: readonly string[], pathAndQuery: string, timeoutMs = 8000): Promise<Record<string, unknown>> {
  const json = (await fetchAnyJson(hosts, pathAndQuery, timeoutMs)) as { data?: unknown }
  if (json?.data === null || json?.data === undefined) throw new Error('data null')
  return json.data as Record<string, unknown>
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
  /**当日开盘/最高/最低（形态计算用） */
  open: number | null
  high: number | null
  low: number | null
  /**
   * 全市场涨/跌/平家数（指数行才有；同批行情的 `f104/f105/f106`）——
   * 护盘事件要"触发瞬间的家数"，用它即可**零新增请求**（见 `resolveBreadthMoment`）。
   */
  up: number | null
  down: number | null
  even: number | null
}

// 注：曾经这里有一个 `fetchRescueQuotes`（采样器自己打一条带 f62/f66/f184 的 ulist URL）。
// 它与顶部行情条的逐标的槽**互不命中**，实测同刻两条链路各打一遍上游（AUDIT-CACHE-2 §3.10）。
// 现在采样器统一走 `fetchQuoteSource → em.loadQuoteRowsShared`（同一条槽 + 在飞合并），
// 该函数随之删除 —— 留着只会让"两条链路各取各的"再长回来。

interface DailyBar { date: string; close: number; vol: number; amount: number }

/**20 日均成交额基准：东财日K（含真实成交额）优先，腾讯日K（vol×100×close 近似）兜底 */
async function fetchAvgAmount20(secid: string): Promise<{ avg: number; source: 'em' | 'tencent' } | null> {
  try {
    const data = await fetchData(KLINE_HOSTS, `/api/qt/stock/kline/get?secid=${secid}&klt=101&fqt=0&lmt=25&end=20500101&fields1=f1,f2,f3&fields2=f51,f52,f53,f54,f55,f56,f57`, 9000)
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
    const res = await withHostBreaker('web.ifzq.gtimg.cn', () =>
      fetch(`https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=${market}${code},day,,,25,qfq`, {
        headers: { 'user-agent': UA }, signal: AbortSignal.timeout(12000),
      }),
    )
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

/**用新浪 5 分钟线自建当日进度曲线（口径与标定脚本一致，失败则沿用标定值） */
async function fetchProgressCurve(metas: RescueEtfMeta[]): Promise<{ curve: number[]; sd: number[]; days: number } | null> {
  const curves: number[][] = []
  for (const meta of metas.slice(0, 6)) {
    try {
      const market = meta.secid.startsWith('1.') ? 'sh' : 'sz'
      const code = meta.secid.split('.')[1]
      const res = await withHostBreaker('quotes.sina.cn', () =>
        fetch(`https://quotes.sina.cn/cn/api/json_v2.php/CN_MarketDataService.getKLineData?symbol=${market}${code}&scale=5&ma=no&datalen=1023`, {
          headers: { 'user-agent': UA, referer: 'https://finance.sina.com.cn/' }, signal: AbortSignal.timeout(15000),
        }),
      )
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
  /**
   * **同刻度基线的离散度**（用户口径 v0.17.0）：逐 slot 的标准差。
   * 只有均值时，"今天这个时刻的累计占比是不是异常"只能跟一个数比（无判别力）；
   * 有了 σ 才能给出 `z = (今天 − μ) / σ` —— 这正是"同一时刻的历史分布"该干的事。
   */
  const sd = new Array(49).fill(0).map((_, i) => {
    if (curves.length < 2) return 0
    const mu = curve[i] as number
    const varSum = curves.reduce((a, c) => a + ((c[i] as number) - mu) ** 2, 0) / (curves.length - 1)
    return Number(Math.sqrt(varSum).toFixed(4))
  })
  return { curve, sd, days: curves.length }
}

/**── 冷启动回填 ──────────────────────────────────────────────────────────
 * 采样环（内存）在进程启动时是空的，而「脉冲」与「持续性」都需要 ≥5 分钟的历史，
 * 于是盘中重启后这两个因子会长时间显示为空 —— 若重启发生在收盘前 5 分钟内，
 * 当天就再也算不出来（实测 9/24 14:44 重启即如此）。
 * 因此首轮采样时用当日分钟数据回填采样环：
 *   - 东财 trends2：每分钟成交额 → 累计成交额
 *   - 东财 fflow klt=1：每分钟累计超大单/主力净额
 * 两者都是当日全量（约 240 点），回填后脉冲/持续性立即可算。
 * ──────────────────────────────────────────────────────────────────────── */

export interface MinuteFlowPoint {
  ts: number
  /**当日累计成交额 */
  amount: number
  /**当日累计超大单净额（腾讯备用源无此数据 → null） */
  superNet: number | null
  /**当日累计主力净额（腾讯备用源无此数据 → null） */
  mainNet: number | null
}

/**
 * 解析 "YYYY-MM-DD HH:mm" → epoch ms。
 *
 * ⚠ 上游给的是**北京墙上时间**，必须显式 `+08:00`（走 `host/time.ts` 的 `parseMarketStamp`）：
 * 旧实现是无偏移的 `Date.parse`，在 `TZ=UTC` 宿主下整批时间戳偏 8 小时 ⇒
 * `bootstrapOne` 的 `p.ts > newest` 回填判定把北京盘中所有点当"未来"，
 * `hhmmOf/sessionElapsed/inTradingWindow` 全部失准（复核实测 0/330 命中）。
 */
function parseMinuteStamp(text: string): number {
  return parseMarketStamp(text)
}

export async function fetchMinuteSeries(secid: string): Promise<MinuteFlowPoint[]> {
  const [trends, flow] = await Promise.all([
    fetchData(KLINE_HOSTS, `/api/qt/stock/trends2/get?secid=${encodeURIComponent(secid)}&fields1=f1,f2,f3&fields2=f51,f52,f53,f54,f55,f56,f57,f58&ndays=1&iscr=0`).catch(() => null),
    fetchData(QUOTE_HOSTS, `/api/qt/stock/fflow/kline/get?lmt=0&klt=1&secid=${encodeURIComponent(secid)}&fields1=f1,f2,f3,f7&fields2=f51,f52,f53,f54,f55,f56`).catch(() => null),
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

/**分钟序列（含成交额与分单资金流）：东财优先，失败回落腾讯（后者只有成交额） */
export async function fetchMinuteSeriesAny(secid: string): Promise<MinuteFlowPoint[]> {
  try {
    const em = await fetchMinuteSeries(secid)
    if (em.length >= 3) return em
  } catch {
    /* 回落腾讯 */
  }
  const tx = await fetchTencentMinutes(secid)
  return tx.map((p) => ({ ts: p.ts, amount: p.amount, superNet: null, mainNet: null }))
}

/**快照数据来源：em = 含分单资金流；tencent = 只有量能与价格（含新浪兜底与旧值） */
export type QuoteSource = 'em' | 'tencent'

/**
 * 采样器快照：**与顶部行情条共用同一份逐标的行情槽**（P0 —— 采样器此前绕过行情缓存）。
 *
 * 此前这里自己直调 `fetchAny`，URL 的字段表（`…,f62,f66,f184`）与行情引擎的 `QUOTE_FIELDS` 不同 ⇒
 * 两条链路各打一遍上游、互不命中：实测"完全没人看"的 53 秒窗口里本插件共 6 条请求，其中 4 条是这种重复
 * （AUDIT-CACHE-2 §3.10）。现在改走 `em.loadQuoteRowsShared`（= `/quotes` 的同一条槽 + 在飞合并）：
 *   - 行情条刚取过数 ⇒ 采样器**0 请求**（实测：一屏 45s 内采样器 3 → 0 条）；
 *   - 行情条没开 / 槽已过期 ⇒ 采样器自己取一次（与从前一样，不依赖 UI 在不在）。
 * 字段表已把 `f62/f66`（主力/超大单净额）与 `f8/f10`（换手/量比）并进同一份 `QUOTE_FIELDS`，
 * 所以共用一条 URL 不丢列（多带两列不增加请求数）。
 *
 * 分单资金流只有东财给：`source !== 'em'` 的行**按 null 处理** —— 与"备用源没有分单资金流"的既有口径一致
 * （此前腾讯兜底时这些因子同样直接不可用），不许把来自备用源/旧值的数字当东财资金流用。
 */
export async function fetchQuoteSource(
  secids: string[],
  opts: { minReuseMs?: number } = {},
): Promise<{ rows: Record<string, RescueQuoteRow>; source: QuoteSource }> {
  // M5：采样器按**自己的 tick**复用槽（否则 30s/15s 的间隔每次都刚好撞上 12s 的槽 TTL ⇒ 命中率 0%）
  // emFields：护盘评分要 `superNet/mainNet`，这两个字段**只有东财给** ⇒ 这条链路允许东财先行
  // （AUDIT-IMPL70 P1：行情链已把东财降为兜底，不显式声明就会让超大单因子在东财健康时也变全 null）
  const shared = await loadQuoteRowsShared(secids, { minReuseMs: opts.minReuseMs ?? 0, emFields: true })
  const rows: Record<string, RescueQuoteRow> = {}
  let sawEm = false
  let live = 0
  for (const [secid, row] of shared) {
    const fromEm = (row.source ?? 'em') === 'em'
    if (fromEm) sawEm = true
    if ((row.source ?? 'em') !== 'lkg') live += 1
    rows[secid] = {
      secid,
      price: row.price,
      pct: row.pct,
      amount: row.amount,
      turnover: row.turnover ?? null,
      volRatio: row.volRatio ?? null,
      mainNet: fromEm ? row.mainNet ?? null : null,
      superNet: fromEm ? row.superNet ?? null : null,
      open: row.open,
      high: row.high,
      low: row.low,
      up: row.up ?? null,
      down: row.down ?? null,
      even: row.even ?? null,
    }
  }
  // 只剩 last-known-good（东财/腾讯/新浪都没有回包）⇒ **不**当成一次成功采样：
  // 与从前"两个源都失败就抛错"的语义一致（`tickOnce` 会记一次采样缺口，面板保留上次快照）
  if (live === 0) throw new Error('本次没有拿到任何可用行情（东财/腾讯/新浪都没有回包）')
  return { rows, source: sawEm ? 'em' : 'tencent' }
}

/**── 采样器 ────────────────────────────────────────────────────────────── */

export class RescueMonitor {
  private dir: string
  private file: LogFile = { v: 1, days: {}, lastSnapshot: null, baselines: {}, selfSamples: {}, progressCurve: null, progressSd: null, progressDays: 0, updatedAt: 0 }
  private loaded: Promise<void> | null = null
  private config: RescueConfig
  private ring: Record<string, Sample[]> = {}
  private today: DayLog = { events: [], intraday: [], samples: 0, gap: false }
  /**
   * 本进程"上次成功写盘时"各日的 samples（重基准点）。
   * `today.samples += 1` 只加在**本进程内存**里；写盘时必须变成"磁盘现值 + 我的增量"，
   * 否则两个进程各 +1 会互相吞掉（谁后写谁赢）。见 docs/AUDIT-IMPL42.md §5.1。
   */
  private samplesBase = new Map<string, number>()
  private todayKey = ''
  private lastSnapshot: RescueSnapshot | null = null
  /**
   * `/breadth` 最近一次**成功**结果（由路由在响应时顺手记一份，纯内存）——
   * 护盘事件要"触发瞬间的家数"，但**不许为此发请求**，所以只能搭车拿已有读数。
   */
  private lastBreadth: { up: number; down: number; even: number; amount: number | null; asOf: number; source: string } | null = null

  /** 路由侧调用：把刚生成的 /breadth 家数记进内存（无 IO、无请求） */
  noteBreadthMoment(m: { up: number; down: number; even: number; amount: number | null; asOf: number; source: string }): void {
    this.lastBreadth = m
  }
  private timer: ReturnType<typeof setTimeout> | null = null
  private running = false
  private lastPersist = 0
  /**落盘串行化（tmp+rename 之外的并发保护） */
  private writeChain: Promise<void> = Promise.resolve()
  private lastLevel: RescueLevel = 0
  private lastIntradayMin = -1
  private calibrating = false
  private calibratedDay = ''
  /**每个交易日每个标的只回填一次 */
  private bootstrapped = new Set<string>()
  private bootstrappedCount = 0
  /**当日每个通道的回填尝试次数（失败上限 3 次，避免网络抖动导致整日缺因子或重试风暴） */
  private bootstrapAttempts = new Map<string, number>()
  /**本轮并发回填成功计数（bootstrapRings 结束时并入 bootstrappedCount） */
  private bootstrapFilled = 0
  /**回填并发度 */
  private static readonly BOOTSTRAP_CONCURRENCY = 3
  /**回填时间预算：超过就先出快照（剩余通道后台补齐） */
  private static readonly BOOTSTRAP_BUDGET_MS = 3_000
  /**正在后台补算基准的通道（避免重复请求） */
  private baselinePending = new Set<string>()
  /**日线缓存（位置/底部概率用，按日刷新） */
  private dailyBars: Record<string, DailyBarLite[]> = {}
  private dailyDay = ''
  /**底部概率校准结果（跨通道合并，按日缓存） */
  private bottomCal: ReturnType<typeof calibrateAcross> | null = null
  private bottomComputing = false
  /**校准失败后的冷却时间戳：避免日线拉取失败时每个 tick 重跑全量回测 */
  private bottomCalRetryAfter = 0
  /**底部视图缓存（按节流刷新，避免每 tick 重算位置/形态） */
  private bottomCache: { at: number; key: string; view: RescueSnapshot['bottom'] } | null = null
  /**
   * 上一次成功算出的底部视图。日线拉取失败或校准样本归零时保留它（标 stale），
   * 而不是让整块面板消失 —— 位置/形态/概率都是慢变量，几十分钟前的结论仍可参考，
   * 但必须标明"非本次计算"。
   */
  private bottomLast: { at: number; view: NonNullable<RescueSnapshot['bottom']> } | null = null
  /**tick 合并（定时循环 / 手动刷新 / 自动补采三条路径共用一份工作） */
  private tickFlight = new SingleFlight()
  /**当日分钟序列缓存（脉冲计算用；东财或腾讯） */
  private minutes: Record<string, MinuteFlowPoint[]> = {}
  /**最近一次分钟序列刷新时刻（节流用；此前只写不读 → 序列每天只冷启动写一次） */
  private lastMinuteRefresh = 0
  private minuteRefreshing = false
  /**分钟序列刷新间隔：与采样间隔无关，60 秒足够让脉冲参考点落在窗口内 */
  private static readonly MINUTE_REFRESH_MS = 60_000
  /**最近一次成功采样的数据来源（未采过样时为 null，避免把"还没采"说成"来自东财"） */
  private quoteSource: QuoteSource | null = null

  constructor(dir: string = dataHome(), config?: RescueConfig) {
    this.dir = dir
    this.config = config ?? { enabled: true, intervalSec: 30, tailIntervalSec: 15, tailFrom: '14:30', universe: [] }
  }

  private path(): string {
    return join(this.dir, 'rescue-log.json')
  }

  async init(): Promise<void> {
    // 预热外部交易日历（用户改完文件按 mtime 失效；坏文件在这里隔离留痕）
    await loadTradingCalendar({ quarantineBroken: true }).catch(() => undefined)
    if (this.loaded !== null) return this.loaded
    this.loaded = (async () => {
      await mkdir(this.dir, { recursive: true }).catch(() => undefined)
      try {
        const raw = await readFile(this.path(), 'utf8')
        const parsed = JSON.parse(raw) as Partial<LogFile>
        this.file = {
          v: 1,
          days: parsed.days ?? {},
          lastSnapshot: parsed.lastSnapshot ?? null,
          baselines: parsed.baselines ?? {},
          selfSamples: parsed.selfSamples ?? {},
          progressCurve: Array.isArray(parsed.progressCurve) && parsed.progressCurve.length === 49 ? parsed.progressCurve : null,
          // 长度必须正好 49 且全为有限非负数（否则当作没有 ⇒ 回落时点系数，不静默用一个坏基线）
          progressSd: Array.isArray(parsed.progressSd) && parsed.progressSd.length === 49 && parsed.progressSd.every((x: unknown) => typeof x === 'number' && Number.isFinite(x) && x >= 0) ? parsed.progressSd : null,
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
    this.bootstrapAttempts.clear()
    this.bootstrapFilled = 0
    this.todayKey = key
    this.today = this.file.days[key] ?? { events: [], intraday: [], samples: 0, gap: false }
    this.file.days[key] = this.today
    // 首次见到该日时记下基准（之后每次**成功写盘**后再重基准，见 persist）
    if (!this.samplesBase.has(key)) this.samplesBase.set(key, this.today.samples)
    this.ring = {}
    this.lastIntradayMin = -1
    this.lastLevel = this.today.events.length > 0 ? this.today.events[this.today.events.length - 1].level : 0
  }

  /**
   * 落盘：tmp + rename 原子替换，并用 writeChain 串行化。
   *
   * 此前是裸 writeFile，且本文件已有 4 处 persist 调用点（基准补算 / tick / 周期 / calibrate），
   * 并发写同一文件一旦交错或被中断，init() 解析失败即静默空库，随后一次 persist 覆盖
   * → 60 天历史 + 自建样本 + 进度曲线 + 基准全部永久丢失。
   */
  private persist(force = false): Promise<void> {
    const run = this.writeChain.then(async () => {
      const now = Date.now()
      if (!force && now - this.lastPersist < 60_000) return
      this.lastPersist = now
      this.file.updatedAt = now
      try {
        // 跨进程：整份覆写 → **锁内「读磁盘最新 → 合并 → 写回」**（KEEP_DAYS 裁剪在合并函数里做）
        await updateJsonLocked(this.path(), (disk) => mergeRescueLog(disk, this.file, this.samplesBase), {
          note: 'rescue-log',
        })
        // **成功之后**才重基准：失败就不动基准，这次的增量下次继续算（不会丢）
        for (const day of this.samplesBase.keys()) {
          const cur = this.file.days[day]?.samples
          if (typeof cur === 'number') this.samplesBase.set(day, cur)
        }
      } catch (error) {
        console.warn('[tradewatcher] rescue persist failed:', String(error))
      }
    })
    this.writeChain = run.catch(() => undefined)
    return run
  }

  getConfig(): RescueConfig {
    return { ...this.config, universe: [...this.config.universe] }
  }

  setConfig(patch: Partial<RescueConfig>): RescueConfig {
    this.config = { ...this.config, ...patch }
    return this.getConfig()
  }

  /**当前生效采样间隔（尾盘更密） */
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
    // 延迟补算也要取消：否则卸载后还会再跑一拍（与"stop 之后又 start"的竞态同源）
    if (this.deferredTimer !== null) {
      clearTimeout(this.deferredTimer)
      this.deferredTimer = null
    }
    this.deferredReTick = false
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

  /**
   * 采样失败的统一记账。
   *
   * 不得改写 `ts`：`ts`/`lastSampleTs` 是"这份数据是几点拿到的"，失败只是"我们
   * 在几点试过并且没成功"。此前这里写 `ts: Date.now()` —— 收盘后手动点一次「立即采样」
   * 而上游不可用时，界面顶部的「已收盘 · 21:34:43」会变成失败时刻，看起来像刚采到数据。
   * 失败的时刻另存 `lastFailTs`，与数据时刻在界面上分开表述。
   */
  private noteSampleFailure(at = Date.now()): void {
    this.today.gap = true
    this.lastFailTs = at
    if (this.lastSnapshot !== null) this.lastSnapshot = { ...this.lastSnapshot, gap: true, lastFailTs: at }
  }

  /**最近一次采样失败时刻（成功采样会清空它） */
  private lastFailTs: number | null = null

  /**立即采样一次（手动刷新/非交易时段复盘）；与在飞的定时采样合并 */
  async sampleNow(): Promise<RescueSnapshot> {
    await this.init()
    // 非交易日：**不采样**（假日里"量能平稳"会被算成一份平静的当日分 —— 那正是假信号）。
    // 也不发上游请求：按日历就能判定，问上游只是浪费。
    if (!tradingDayState(Date.now()).trading) return this.snapshot()
    await this.tick()
    return this.snapshot()
  }

  /**
   * 采样一次。重入守卫：三条触发路径（定时循环 `loop`、前端手动 `sampleNow`、
   * 路由自动补采 `ensureFresh`）会撞在一起 —— 此前各跑一份，导致上游请求翻倍、
   * `today.samples` 重复计数、两份快照互相覆盖（样本数可能"回退"）。现统一合并：
   * 已有采样在飞时，新调用等待同一份结果，不再叠加第二次全量采样。
   */
  private async tick(): Promise<void> {
    return this.tickFlight.run(() => this.tickOnce())
  }

  /**是否正在采样（自检/UI 观察用） */
  get sampling(): boolean {
    return this.tickFlight.busy
  }

  private async tickOnce(): Promise<void> {
    await this.init()
    this.rollDay()
    const metas = rescueUniverseMeta(this.config.universe, this.config.custom ?? [])
    const secids = [INDEX_SECID, ...metas.map((m) => m.secid)]
    // 冷启动回填与行情取数并发（此前是串行：先等行情失败 3.4s，再等回填 3s = 6.4s 首屏）
    const shortRings = phaseOf(hhmmOf(Date.now())) === 'pre'
      ? []
      : metas.filter((m) => {
          const ring = this.ring[m.secid] ?? []
          if (ring.length < 2) return true
          return ring[ring.length - 1].ts - ring[0].ts < FLOW_WINDOW_MS - 30_000
        })
    const needsBootstrap = shortRings.length > 0 && !shortRings.every((m) => this.bootstrapped.has(`${this.todayKey}|${m.secid}`))
    const bootstrapWork = needsBootstrap
      ? this.withBudget(this.bootstrapRings(shortRings), RescueMonitor.BOOTSTRAP_BUDGET_MS, '冷启动回填').then((timedOut) => {
          // 超预算 = 这份快照的脉冲/持续性可能要缺，后台补齐后自动补算一次
          if (timedOut) this.scheduleDeferredReTick()
        })
      : Promise.resolve()
    let quotes: Record<string, RescueQuoteRow>
    let source: QuoteSource = 'em'
    try {
      const [got] = await Promise.all([
        // 复用窗口 = 本拍间隔 − 余量（尾盘 15s ⇒ 11s；盘中 30s ⇒ 22s）：
        // 宁可偶尔多打一次上游，也不让采样读到过旧的值
        fetchQuoteSource(secids, { minReuseMs: Math.max(5_000, Math.round(this.activeIntervalSec() * 0.75 * 1000)) }),
        bootstrapWork,
      ])
      quotes = got.rows
      source = got.source
    } catch {
      this.noteSampleFailure()
      return
    }
    this.quoteSource = source
    if (this.calibratedDay !== this.todayKey) {
      this.calibratedDay = this.todayKey
      void this.calibrate(metas).catch(() => undefined)
    }
    // 缺少 20 日均额基准的通道（例如刚加入的自定义通道）立即后台补算，
    // 否则它们的量能倍数/脉冲会一直显示为空
    const missingBase = metas.filter((m) => this.file.baselines[m.secid]?.avgAmt20 === undefined && !this.baselinePending.has(m.secid))
    // 整组闸门（而不是单台）：只要还有一台可用就继续补算
    if (missingBase.length > 0 && hostsAllowed(QUOTE_HOSTS).length > 0) {
      for (const m of missingBase) this.baselinePending.add(m.secid)
      void (async () => {
        for (const m of missingBase) {
          try {
            const got = await fetchAvgAmount20(m.secid)
            if (got !== null) this.file.baselines[m.secid] = { avgAmt20: got.avg, day: this.todayKey, source: got.source }
          } catch {
            /* 稍后再试 */
          } finally {
            this.baselinePending.delete(m.secid)
          }
        }
        await this.persist(true)
      })().catch(() => undefined)
    }
    // 日线（位置 / 底部概率）：每个交易日拉一次，后台进行
    if (this.dailyDay !== this.todayKey && !this.bottomComputing) {
      this.dailyDay = this.todayKey
      this.bottomComputing = true
      void (async () => {
        const bars: Record<string, DailyBarLite[]> = {}
        for (const m of metas) {
          try {
            const got = await fetchTencentDaily(m.secid, 320)
            if (got.length > 80) bars[m.secid] = got
          } catch {
            /* 单只失败不影响 */
          }
        }
        this.dailyBars = bars
        if (Object.keys(bars).length > 0) {
          this.bottomCal = calibrateAcross(Object.values(bars).map((b) => b as DailyBarLite[]))
          this.bottomCache = null
        } else {
          // 日线全失败：进入冷却，30 分钟内不再重试（否则上游抖动会把 O(通道×日线) 计算拉到每 tick）
          this.bottomCalRetryAfter = Date.now() + 30 * 60_000
        }
      })().finally(() => {
        this.bottomComputing = false
      })
    }
    const ts = Date.now()
    const tradingNow = inTradingWindow(ts)
    // 分钟序列刷新（后台执行，不阻塞本拍；面板用的是本拍已有序列 + pickPulseRef 的守卫）
    if (tradingNow && ts - this.lastMinuteRefresh >= RescueMonitor.MINUTE_REFRESH_MS) {
      void this.refreshMinutes(metas).catch(() => undefined)
    }
    const elapsed = sessionElapsed(hhmmOf(ts))
    const curve = this.file.progressCurve ?? RESCUE_CALIBRATION.progressCurve
    const progress = progressAt(curve, elapsed)
    const indexPct = quotes[INDEX_SECID]?.pct ?? null
    const etfs: RescueEtfView[] = []
    // 自定义通道（板块 ETF）只作展示与量能/脉冲观察，不进入护盘评分池：
    // 它们与「国家队托底」不是一回事，混入会污染共振与量能口径
    const scoring = new Set(metas.filter((m) => m.group !== 'custom').map((m) => m.secid))
    const isCoreIndex = (index: string): boolean => CORE_INDEXES.includes(index)
    const pulseAnchors = pulseAnchorsFor(elapsed)
    const phase = phaseOf(hhmmOf(ts))
    // 盘后不再按「尾盘」命名（否则收盘后打开面板会误读为刚发生尾盘突袭）
    const tail = isTailElapsed(elapsed) && inTradingWindow(ts)
    const trading = inTradingWindow(ts)
    // 盘后/非交易时段：不写入新样本，改以「环内最后一个盘中样本」为评估时点，
    // 否则「最近 5 分钟」会错配成「收盘到现在」这一整段空窗
    // 评估基准取「采样环」与「分钟序列」中较新的一个：
    // 腾讯备用源下采样环为空（无分单资金流），但分钟序列仍有累计成交额
    const ringTail = Math.max(0, ...metas.map((m) => this.ring[m.secid]?.at(-1)?.ts ?? 0))
    const minuteTail = Math.max(0, ...metas.map((m) => this.minutes[m.secid]?.at(-1)?.ts ?? 0))
    const tailRef = Math.max(ringTail, minuteTail)
    const evalTs = trading ? ts : tailRef > ts - 12 * 3600_000 ? tailRef : ts
    const allowPulse = trading || phase === 'closed'
    let maxMult: number | null = null
    /** 同刻度 z 的最大值（六条评分通道里最强的那个）；基线不足/σ 不可用 ⇒ 一直是 null ⇒ 走兜底 */
    let maxVolumeZ: number | null = null
    /** 同刻度基线可用的通道数（归因里说明"几个通道用上了基线"） */
    let volumeZChannels = 0
    const slotIdx = Math.max(1, Math.min(48, Math.round(elapsed / 5)))
    const sameSlotMu = (this.file.progressCurve ?? RESCUE_CALIBRATION.progressCurve)[slotIdx] ?? null
    const sameSlotSd = (this.file.progressSd ?? null)?.[slotIdx] ?? null
    const sameSlotDays = this.file.progressSd === null || this.file.progressSd === undefined ? 0 : this.file.progressDays
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
          pulseMult: null, activity: 0, triggered: false, flowDirection: 'unknown', volumeZ: null,
          open: null, high: null, low: null,
        })
        continue
      }
      const amount = q.amount
      const superNet = q.superNet
      const timeAdjMult = amount !== null && base !== null && base > 0 ? amount / (base * progress) : null
      /**
       * 同刻度 z（v0.17.0）：`(今日累计额 ÷ 20 日均额 − 同 slot 历史均值) ÷ 同 slot 历史 σ`。
       * 与 `timeAdjMult` 的分母不同（后者用"日内进度"这种粗略替代），所以两套刻度**不可直接比**：
       * 有 z 就用 z，没有就回落，并在因子行/归因里标清楚用的哪套。
       */
      const progressNow = amount !== null && base !== null && base > 0 ? amount / base : null
      const volumeZ = sameSlotZ(progressNow, sameSlotMu, sameSlotSd, sameSlotDays)
      const superVsAvg = superNet !== null && base !== null && base > 0 ? superNet / base : null
      const superShare = superNet !== null && amount !== null && amount > 0 ? superNet / amount : null
      // 脉冲：最近 5 分钟成交额 ÷ 同时点基准 5 分钟额
      let pulseMult: number | null = null
      if (allowPulse && base !== null && base > 0) {
        // 优先用当日分钟序列（东财 trends2 或腾讯分钟线都能提供累计成交额）；
        // 序列过期时 pickPulseRef 返回 null，自动退回采样环口径（见该函数的说明）
        const windowMs = FLOW_WINDOW_MS
        const picked = pickPulseRef(this.minutes[meta.secid] ?? [], evalTs, evalTs, windowMs)
        if (picked !== null) {
          const actual5 = (amount ?? 0) - picked.ref.amount
          const elapsedRef = sessionElapsed(hhmmOf(picked.ref.ts))
          const expected = base * (progressAt(curve, sessionElapsed(hhmmOf(picked.evalAt))) - progressAt(curve, elapsedRef))
          if (expected > 0 && actual5 > 0) pulseMult = actual5 / expected
        }
        // 无分钟序列时退回采样环口径
        if (pulseMult === null) {
          const ring = this.ring[meta.secid] ?? []
          const target = evalTs - windowMs
          let ref: Sample | null = null
          for (const x of ring) if (x.ts <= target + 15_000 && (ref === null || x.ts > ref.ts)) ref = x
          if (ref !== null && amount !== null) {
            const actual5 = amount - ref.amount
            const elapsedRef = sessionElapsed(hhmmOf(ref.ts))
            const expected = base * (progress - progressAt(curve, elapsedRef))
            if (expected > 0 && actual5 > 0) pulseMult = actual5 / expected
          }
        }
      }
      const flow = amount !== null && superNet !== null
        ? this.pushSample(meta.secid, trading ? { ts, amount, superNet, mainNet: q.mainNet ?? 0 } : null, evalTs)
        : { persistShare: null, retraceRatio: null }
      const inPool = scoring.has(meta.secid)
      if (inPool) {
        if (flow.persistShare !== null && (persistBest === null || flow.persistShare > persistBest)) persistBest = flow.persistShare
        if (flow.retraceRatio !== null && (retraceWorst === null || flow.retraceRatio > retraceWorst)) retraceWorst = flow.retraceRatio
        if (timeAdjMult !== null) maxMult = Math.max(maxMult ?? 0, timeAdjMult)
        if (volumeZ !== null && scoring.has(meta.secid)) {
          maxVolumeZ = Math.max(maxVolumeZ ?? -Infinity, volumeZ)
          volumeZChannels += 1
        }
      }
      if (superVsAvg !== null && inPool) {
        if (isCoreIndex(meta.index)) {
          // 核心护盘通道：F2 以它们为主，并记录最差的超大单占比用于否决
          coreSuperVsAvg = Math.max(coreSuperVsAvg ?? -Infinity, superVsAvg)
          if (superShare !== null && (coreWorstShare === null || superShare < coreWorstShare)) coreWorstShare = superShare
        } else {
          peripheralSuperVsAvg = Math.max(peripheralSuperVsAvg ?? -Infinity, superVsAvg)
        }
      }
      if (inPool && pulseMult !== null) maxPulse = Math.max(maxPulse ?? 0, pulseMult)
      if (inPool && superVsAvg !== null) {
        const peaks = this.today.etfPeak ?? {}
        if (!(meta.secid in peaks) || superVsAvg > peaks[meta.secid]) peaks[meta.secid] = superVsAvg
        this.today.etfPeak = peaks
      }
      // 资金流入是必要条件：只有量能或脉冲、没有净流入，不构成托底证据
      //（9/24 09:48 那次「疑似护盘」正是 F2=0 却因量能+脉冲+持续性凑分所致）
      const flowOk = superVsAvg !== null && superVsAvg >= this.f2Anchors()[0]
      const selfTrigger = inPool && flowOk && (
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
        // 当日开/高/低：底部形态（日内回升、下影线、收回前低）计算所需
        open: q.open, high: q.high, low: q.low,
        flowDirection: superShare === null ? 'unknown' : superShare >= 0.15 ? 'in' : superShare <= -0.15 ? 'out' : 'flat',
        volumeZ,
      })
    }
    const anchors = this.f2Anchors()
    const scored = scoreRescue({
      timeAdjMult: maxMult,
      volumeZ: maxVolumeZ,
      volumeZDays: sameSlotDays,
      coreSuperVsAvg, peripheralSuperVsAvg,
      pulseMult: maxPulse,
      persistShare: persistBest, retraceRatio: retraceWorst,
      indexPct, resonance: triggeredIndexes.size,
      coreResonance: coreTriggered.length, peripheralResonance: peripheralTriggered.length,
      resonanceLanes: [...coreTriggered, ...peripheralTriggered],
      coreWorstShare,
      flowAvailable: source === 'em',
      f2Anchors: anchors, f2Source: this.f2Source(),
      // 时点系数此前没有传进来，运行时恒等于 1（早盘噪音最大的时段拿到满权重）
      timeCoef: timeCoefficient(elapsed),
      isTail: tail, pulseAnchors, bandLabel: pulseBandLabel(elapsed), phase,
      // A-1 交易时段闸门：非交易时段不出等级（收盘后/午休/盘前），也不计入当日最高等级
      inSession: inTradingSession(hhmmOf(ts)),
      recentContinuous: this.recentContinuous(),
    })
    etfs.sort((a, b) => b.activity - a.activity)
    /**
     * A-1 交易时段闸门（写入侧）：**非交易时段不进事件、不进 5 分钟抽样** ——
     * 否则夜里/午休的样本会污染当日最高等级（`history()` 的 `maxLevel`）与时间线。
     * 那次采样仍然留痕：`scoreLog` 里 rawScore/timeCoef 为 `null`（不是 0），一眼能看出"没有判据"。
     */
    if (scored.inSession) {
      // 事件去抖：仅记录等级升级，以及从有信号回落到平静（形成完整时间线）
      if (scored.level > this.lastLevel || (scored.level === 0 && this.lastLevel > 0)) {
        /**
         * 触发瞬间的家数（v0.18.0）：**搭车**，绝不为此发请求 ——
         * ① 本拍行情批量里就有指数家数；② 否则用 `/breadth` 最近一次成功结果（≤120s）；③ 都没有 ⇒ null + 原因。
         */
        const indexRow = quotes[INDEX_SECID]
        const breadth = resolveBreadthMoment({
          quote: indexRow === undefined
            ? null
            : { up: indexRow.up ?? null, down: indexRow.down ?? null, even: indexRow.even ?? null, amount: indexRow.amount ?? null, at: ts },
          cached: this.lastBreadth,
          now: ts,
        })
        this.today.events.push({
          ts, hhmm: hhmmOf(ts), level: scored.level, score: scored.score,
          engine: ENGINE_VERSION,
          reason: scored.level === 0 ? '信号回落：量能与超大单流入回到常态' : scored.summary,
          breadth: breadth.moment,
          breadthWhy: breadth.why,
          breadthSource: breadth.source,
        })
        if (this.today.events.length > 60) this.today.events.splice(0, this.today.events.length - 60)
        this.lastLevel = scored.level
        this.pushScoreLog(ts, scored)
        await this.persist(true)
      }
      const minuteMark = Math.floor(elapsed / 5) * 5
      if (minuteMark !== this.lastIntradayMin && elapsed > 0) {
        this.lastIntradayMin = minuteMark
        /**
         * 分时点带上**六通道各自的读数**（v0.18.0）：数据就是本拍 `etfs`（同一批行情），**不新增请求**。
         * 只有评分通道（宽基六条）进这里；自定义通道不进（避免把板块 ETF 混进护盘口径）。
         */
        const channels: RescueIntradayChannel[] = etfs
          .filter((e) => scoring.has(e.secid))
          .map((e) => ({ secid: e.secid, name: e.name, price: e.price, pct: e.pct, amount: e.amount, timeAdjMult: e.timeAdjMult, volumeZ: e.volumeZ ?? null, superNet: e.superNet }))
        this.today.intraday.push({
          hhmm: hhmmOf(ts), level: scored.level, score: scored.score,
          timeAdjMult: maxMult, superVsAvg: coreSuperVsAvg ?? peripheralSuperVsAvg, persistShare: persistBest,
          channels,
        })
        // 条数上限（旧有）+ **体积上限**（六通道字段进来后必须有）：从最旧的一端丢
        if (this.today.intraday.length > RESCUE_INTRADAY_MAX) this.today.intraday.splice(0, this.today.intraday.length - RESCUE_INTRADAY_MAX)
        const trimmed = trimIntradayBySize(this.today.intraday)
        if (trimmed.dropped > 0) {
          console.warn(`[tradewatcher] 分时点体积超上限（>${Math.round(RESCUE_INTRADAY_MAX_BYTES / 1024)}KB）：丢掉最旧 ${trimmed.dropped} 条`)
          this.today.intraday = trimmed.points
        }
        this.pushScoreLog(ts, scored)
      }
    } else {
      this.pushScoreLog(ts, scored)
    }
    // 记住每通道最后一次成功值：上游中断/收盘后重启时，面板可据此复盘而不是空白
    {
      const last = this.today.etfLast ?? {}
      for (const e of etfs) last[e.secid] = e
      this.today.etfLast = last
    }
    this.today.samples += 1
    this.today.gap = false
    this.lastFailTs = null
    this.lastSnapshot = {
      ts, trading: inTradingWindow(ts),
      // 非交易时段：level 置空（契约允许 null，与"休市日不出等级"同一语义）、score/timeCoef 走 0 + 归因说明
      level: scored.inSession ? scored.level : null,
      score: scored.inSession ? scored.score : 0,
      summary: scored.summary,
      factors: scored.factors, etfs, indexPct, indexName: INDEX_NAME,
      timeCoef: scored.inSession ? timeCoefficient(elapsed) : 0,
      // 连续评分与它的跨日分位（客户端只显示，不自己算）——映射只有 `snapshotContractFields` 一处
      ...snapshotContractFields(scored),
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
      flowSource: source,
      bottom: this.buildBottom(etfs),
      thresholdSource: this.f2Source(), selfSampleDays: this.selfSampleDays(),
      calibratedAt: RESCUE_CALIBRATION.generatedAt,
      activeWindow: samplingWindow(ts, { enabled: this.config.enabled, intervalSec: this.activeIntervalSec(ts), samples: this.today.samples }),
      factorContrib: factorContributions(scored.factors, timeCoefficient(elapsed)),
      config: this.getConfig(), activeIntervalSec: this.activeIntervalSec(ts),
      today: [...this.today.events].reverse(), intraday: [...this.today.intraday],
      /**
       * 六卡分钟序列（v0.18.0）：数据就是 `this.minutes`（采样器**已经**在取的那份，60 秒刷新一次）
       * ⇒ 为了让客户端画卡内迷你折线而**不新增任何上游请求**；上限（点数/字节）在这里裁。
       */
      etfSeries: ((): RescueCardSeries[] => {
        const built = cardSeriesOf(etfs.filter((e) => scoring.has(e.secid)).map((e) => ({ secid: e.secid, name: e.name })), this.minutes)
        const trimmed = trimCardSeries(built)
        if (trimmed.droppedPoints > 0) {
          console.warn(`[tradewatcher] 六卡分钟序列超上限：丢掉最旧 ${trimmed.droppedPoints} 个点（${Math.round(trimmed.bytes / 1024)}KB）`)
        }
        return trimmed.cards
      })(),
      sampleCount: this.today.samples, lastSampleTs: ts, gap: false, lastFailTs: null,
      note: elapsed <= 0 ? '尚未开盘，量能倍数按全天口径显示为 0' : undefined,
    }
    this.file.lastSnapshot = stripSnapshot(this.lastSnapshot)
    void this.persist()
  }

  /**
   * 用当日分钟数据回填采样环（每个交易日每标的只做一次）。
   * 只补历史、不覆盖已采到的实时样本，因此不会与实时采样冲突。
   */
  /**
   * 冷启动回填：把当日分钟序列灌进采样环（脉冲与持续性都需要 ≥5 分钟历史）。
   *
   * 两处修正（此前实测首屏 7.8s）：
   *  1. 并发：原来 for-await 串行拉每个通道（7 次网络往返叠加），现按 3 路并发，
   *     正常上游下从数秒降到几百毫秒；
   *  2. 时间预算：调用方用 `withBudget` 等最多 3s，超时就先出快照（缺口如实标注），
   *     剩余通道的请求继续在后台跑完并在后续 tick 生效 —— 面板不再为回填干等。
   */
  private async bootstrapRings(metas: RescueEtfMeta[]): Promise<void> {
    const queue = [...metas]
    const workers = Array.from(
      { length: Math.max(1, Math.min(RescueMonitor.BOOTSTRAP_CONCURRENCY, queue.length)) },
      async () => {
        for (;;) {
          const meta = queue.shift()
          if (meta === undefined) return
          await this.bootstrapOne(meta)
        }
      },
    )
    await Promise.all(workers)
    if (this.bootstrapFilled > 0) {
      this.bootstrappedCount += this.bootstrapFilled
      this.bootstrapFilled = 0
    }
  }

  /**
   * 分钟序列的节流刷新（交易时段内每 60 秒一次）。
   *
   * 此前 `this.minutes` 只在冷启动回填时写一次：进程盘中启动后序列就冻结在那一刻，
   * 而脉冲要用"5 分钟前"的参考点 —— 序列过期就会拿几十分钟的成交额去比 5 分钟预期
   * （实测放大 4.5 倍，见 pickPulseRef 的说明）。刷新失败时保留旧序列，
   * 由 pickPulseRef 的陈旧守卫保证"宁可退回采样环，也不算错"。
   */
  private async refreshMinutes(metas: RescueEtfMeta[]): Promise<void> {
    if (this.minuteRefreshing) return
    this.minuteRefreshing = true
    try {
      const queue = [...metas]
      const workers = Array.from(
        { length: Math.max(1, Math.min(RescueMonitor.BOOTSTRAP_CONCURRENCY, queue.length)) },
        async () => {
          for (;;) {
            const meta = queue.shift()
            if (meta === undefined) return
            try {
              const points = await fetchMinuteSeriesAny(meta.secid)
              if (points.length >= 3) this.minutes[meta.secid] = points
            } catch {
              /* 单通道失败保留旧序列（陈旧守卫会兜住） */
            }
          }
        },
      )
      await Promise.all(workers)
      this.lastMinuteRefresh = Date.now()
    } finally {
      this.minuteRefreshing = false
    }
  }

  /**单个通道的回填；失败放回待办（上限 3 次/日），避免一次网络抖动让该通道整日缺因子 */
  private async bootstrapOne(meta: RescueEtfMeta): Promise<void> {
    const key = `${this.todayKey}|${meta.secid}`
    if (this.bootstrapped.has(key)) return
    const attempts = (this.bootstrapAttempts.get(key) ?? 0) + 1
    this.bootstrapAttempts.set(key, attempts)
    this.bootstrapped.add(key) // 先占位：同一 tick 内的并发不重复拉同一通道
    try {
      const points = await fetchMinuteSeriesAny(meta.secid)
      if (points.length < 3) return // 上游明确没有分钟数据：今天不再试
      this.minutes[meta.secid] = points
      const ring = this.ring[meta.secid] ?? []
      const newest = ring.length > 0 ? ring[ring.length - 1].ts : 0
      this.lastMinuteRefresh = Date.now()
      // 腾讯备用源没有分单资金流：此时不写入采样环（持续性须真实资金数据支撑）
      const seeded: Sample[] = points
        .filter((p) => p.ts > newest && p.superNet !== null)
        .slice(-SAMPLE_RING)
        .map((p) => ({ ts: p.ts, amount: p.amount, superNet: p.superNet as number, mainNet: p.mainNet ?? 0 }))
      if (seeded.length === 0) return
      this.ring[meta.secid] = [...ring, ...seeded].slice(-SAMPLE_RING)
      this.bootstrapFilled += 1
    } catch {
      if (attempts < 3) this.bootstrapped.delete(key)
    }
  }

  /**
   * 给一段后台工作设时间预算：到点即返回（工作继续在后台跑），
   * 用于"宁可先出带缺口的快照，也不让面板干等"。
   */
  private async withBudget(work: Promise<void>, budgetMs: number, label: string): Promise<boolean> {
    let timedOut = false
    const timer = new Promise<void>((resolve) => {
      setTimeout(() => {
        timedOut = true
        resolve()
      }, budgetMs).unref?.()
    })
    await Promise.race([work.catch(() => undefined), timer])
    if (timedOut) {
      console.warn(`[tradewatcher] ${label} 超过 ${budgetMs}ms 预算：先出快照（因子可能暂时缺失），后台继续补齐`)
    }
    return timedOut
  }

  /**
   * 回填被预算"抛弃"后，它仍会在后台跑完 —— 但收盘后没有定时 tick，
   * 面板就会一直停在缺因子的那份快照上。这里在回填完成后安排一次补算：
   * 先等当前 tick 结束（不能在这里 await 自己那一份，会自锁），再重新采样一次。
   */
  private scheduleDeferredReTick(attempt = 0): void {
    if (this.deferredReTick) return
    this.deferredReTick = true
    const step = (n: number): void => {
      const handle = setTimeout(() => {
        this.deferredTimer = null
        if (this.tickFlight.busy) {
          if (n < 6) { step(n + 1); return }
          this.deferredReTick = false
          return
        }
        this.deferredReTick = false
        void this.tick().catch(() => undefined)
      }, 250)
      handle.unref?.()
      this.deferredTimer = handle
    }
    step(attempt)
  }

  /**是否有待执行的补算（自检用） */
  private deferredReTick = false
  /**延迟补算的定时器句柄（stop 时要清掉） */
  private deferredTimer: ReturnType<typeof setTimeout> | null = null

  /**
   * 采样环 + 窗口内资金流统计。
   *
   * 旧实现用「超大单净额连续递增的次数」——严格大于就计一次、没有幅度门槛，
   * 而东财超大单以 ~0.01 亿步长抖动，于是几乎必然出现"连续递增"，配合可配置的
   * 采样间隔（30s/60s 语义还不同）会大量误报。改为时间 + 幅度口径：
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

  /**F2 锚点：自建样本满 20 个交易日后用自建分位数（P75/P90/P95） */
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

  /**每日标定：20 日均额（东财真实成交额优先）+ 自建进度曲线 */
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
        this.file.progressSd = prog.sd
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

  /**
   * 写一条出分日志（P0-7）。与 `events`/`intraday` 同一份 DayLog，因此跟着 60 天
   * 滚动归档一起老化，不需要第二套清理逻辑。
   */
  private pushScoreLog(ts: number, scored: RescueScoreResult): void {
    const log = (this.today.scoreLog ??= [])
    const entry: ScoreLogEntry = {
      ts,
      hhmm: hhmmOf(ts),
      score: scored.score,
      // ⚠ 非交易时段 rawScore/timeCoef 是 null：**不许**用 0 顶替（0 会被读成"评分 0 = 平静"）
      rawScore: scored.rawScore === null ? null : Math.round(scored.rawScore * 100) / 100,
      timeCoef: scored.timeCoef,
      continuous: scored.continuous === null ? null : Math.round(scored.continuous * 10) / 10,
      inSession: scored.inSession,
      engine: ENGINE_VERSION,
      factors: scored.factors.map((f) => ({
        id: f.id, score: f.score, weight: f.weight, actual: f.actual, threshold: f.threshold, hit: f.hit,
      })),
    }
    // 同一 5 分钟刻度内只保留最后一条（tick 与事件两条路径可能在同一刻度各写一次）
    const mark = entry.hhmm.slice(0, 15)
    if (log.length > 0 && log[log.length - 1].hhmm.slice(0, 15) === mark) log[log.length - 1] = entry
    else log.push(entry)
    if (log.length > 240) log.splice(0, log.length - 240)
  }

  /**
   * 快照（对外入口）。**非交易日门禁在这里**：休市日不出等级、不显示当日分，理由如实。
   *
   * 为什么放在最外层：读取方不止定时采样器（路由、面板手动刷新、agent 工具都走 `snapshot()`），
   * 只在采样器里拦会让"周末打开面板"照样看到一个等级（实测：本地日志里 10-10 周六 21:44、
   * 10-11 周日 12:10 各写出过一条 27~30 分的"平静"记录）。
   */
  snapshot(): RescueSnapshot {
    const inner = this.snapshotInner()
    const day = tradingDayState(Date.now())
    void inner
    // 交易日历状态随快照走：`warning` 必须能被面板/工具看见（不许静默退回内置规则）
    const cal: TradingCalendarStatus | null = externalCalendarStatus()
    const calWarn = cal?.warning ?? null
    const withCal = (base: RescueSnapshot): RescueSnapshot =>
      cal === null ? base : { ...base, calendarStatus: cal, summary: calWarn === null ? base.summary : `${base.summary}｜⚠ ${calWarn}` }
    // 不再写 `levelLines`：等级只剩两级（35/55），"为什么是这个等级"由 summary 里的连续评分 + 线说明承担
    if (day.trading) return withCal({ ...inner, nonTrading: null })
    const what = day.reason === 'weekend' ? '周末休市' : `法定假日休市（${day.label ?? '节假日'}）`
    return withCal({
      ...inner,
      trading: false,
      level: null,
      score: 0,
      nonTrading: { reason: day.reason === 'holiday' ? 'holiday' : 'weekend', label: day.label },
      summary: `休市（非交易日）：${what} —— 今天不是交易日，不采样、不出等级、不写当日分`,
    })
  }

  private snapshotInner(): RescueSnapshot {
    if (this.lastSnapshot === null && this.file.lastSnapshot != null) {
      // 兜底：本次会话还没采到数据（例如收盘后重启），用上次成功快照，注明为旧数据
      const p = this.file.lastSnapshot
      return {
        // 注意 gap 取当日真实缺口标记，而不是无条件 true：
        // "本会话还没采过样"与"采样失败"是两件事，用同一个标记会让面板误报"采样缺口"。
        ...p, trading: inTradingWindow(Date.now()), stale: true, lastSampleTs: p.ts, lastFailTs: this.lastFailTs, gap: this.today.gap,
        // 老快照（v0.15.0 之前）没有这三个字段 ⇒ 显式补 null + 原因，别让界面拿到 undefined
        continuous: p.continuous ?? null,
        continuousPercentile: p.continuousPercentile ?? null,
        continuousPercentileN: p.continuousPercentileN ?? 0,
        continuousPercentileWhy: p.continuousPercentileWhy ?? '上次快照（旧版本）里没有跨日分位字段 ⇒ 本次显示原因而不是现算',
        today: [...this.today.events].reverse(), intraday: [...this.today.intraday],
        sampleCount: this.today.samples,
        note: `本会话尚未采样（如收盘后重启），显示上次成功采样（${hhmmOf(p.ts)}）的数据`,
        calibratedAt: RESCUE_CALIBRATION.generatedAt,
        activeWindow: samplingWindow(Date.now(), { enabled: this.config.enabled, intervalSec: this.activeIntervalSec(), samples: this.today.samples }),
        factorContrib: factorContributions(p.factors, p.timeCoef ?? 1),
        config: this.getConfig(), activeIntervalSec: this.activeIntervalSec(), selfSampleDays: this.selfSampleDays(),
      }
    }
    if (this.lastSnapshot !== null) {
      return {
        ...this.lastSnapshot,
        trading: inTradingWindow(Date.now()),
        config: this.getConfig(),
        activeIntervalSec: this.activeIntervalSec(),
        thresholdSource: this.f2Source(),
        selfSampleDays: this.selfSampleDays(),
        gap: this.today.gap,
        calibratedAt: RESCUE_CALIBRATION.generatedAt,
        activeWindow: samplingWindow(Date.now(), { enabled: this.config.enabled, intervalSec: this.activeIntervalSec(), samples: this.today.samples }),
        factorContrib: factorContributions(this.lastSnapshot.factors, this.lastSnapshot.timeCoef ?? 1),
      }
    }
    const fb = this.fallbackFromDayLog()
    if (fb !== null) {
      return {
        ts: Date.now(), trading: inTradingWindow(Date.now()), level: 0, score: 0,
        summary: fb.note, factors: [], etfs: fb.etfs,
        indexPct: null, indexName: INDEX_NAME,
        timeCoef: timeCoefficient(sessionElapsed(hhmmOf(Date.now()))),
        resonance: { lanes: [], core: 0, peripheral: 0, intensity: 'none' },
        pulseBand: {
          elapsed: sessionElapsed(hhmmOf(Date.now())),
          label: phaseOf(hhmmOf(Date.now())) === 'closed' ? '已收盘' : pulseBandLabel(sessionElapsed(hhmmOf(Date.now()))),
          isTail: false, anchors: pulseAnchorsFor(sessionElapsed(hhmmOf(Date.now()))), phase: phaseOf(hhmmOf(Date.now())),
        },
        completeness: { available: 0, total: 6, missing: ['量能放大', '超大单强度', '脉冲', '持续性', '量价背离'] },
        thresholdSource: this.f2Source(), selfSampleDays: this.selfSampleDays(),
        calibratedAt: RESCUE_CALIBRATION.generatedAt,
        activeWindow: samplingWindow(Date.now(), { enabled: this.config.enabled, intervalSec: this.activeIntervalSec(), samples: this.today.samples }),
        config: this.getConfig(), activeIntervalSec: this.activeIntervalSec(),
        today: [...this.today.events].reverse(), intraday: [...this.today.intraday],
        sampleCount: this.today.samples, lastSampleTs: null, gap: true, stale: true,
        // 契约字段：本次没有采样 ⇒ 连续评分与分位都是 null + 原因（**不许**在界面侧现算或顶 0）
        continuous: null, continuousPercentile: null, continuousPercentileN: 0,
        continuousPercentileWhy: '本次会话还没有采样（复盘兜底数据）⇒ 连续评分与跨日分位都无从谈起',
        // 复盘兜底也要如实标注"最近一次成功采样取自哪个源"（未采过样则不给结论）
        flowSource: this.quoteSource ?? undefined,
        note: fb.note, fallback: fb.meta,
      }
    }
    return {
      ts: Date.now(), trading: inTradingWindow(Date.now()), level: 0, score: 0,
      summary: '尚未采样（打开页面后会自动开始）', factors: [], etfs: [], indexPct: null, indexName: INDEX_NAME,
      continuous: null, continuousPercentile: null, continuousPercentileN: 0,
      continuousPercentileWhy: '本次会话还没有采样 ⇒ 连续评分与跨日分位都还没有（打开页面后会自动开始采样）',
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
      calibratedAt: RESCUE_CALIBRATION.generatedAt,
      activeWindow: samplingWindow(Date.now(), { enabled: this.config.enabled, intervalSec: this.activeIntervalSec(), samples: this.today.samples }),
      factorContrib: [],
      today: [...this.today.events].reverse(), intraday: [...this.today.intraday], sampleCount: this.today.samples,
      lastSampleTs: null, gap: this.today.gap, note: '等待首次采样',
    }
  }

  /**
   * 上游不可用时的当日复盘兜底：
   *   - 优先用当日各通道「最后一次成功采样」的完整视图（可渲染卡片）
   *   - 退化时用当日峰值（只有超大单/20日均额），面板渲染为复盘表
   */
  private fallbackFromDayLog(): { etfs: RescueEtfView[]; meta: RescueSnapshot['fallback']; note: string } | null {
    const last = this.today.etfLast ?? {}
    const peaks = this.today.etfPeak ?? {}
    const lastEtfs = Object.values(last)
    if (lastEtfs.length === 0 && Object.keys(peaks).length === 0) return null
    const metas = rescueUniverseMeta(this.config.universe, this.config.custom ?? [])
    const meta = {
      day: this.todayKey,
      peaks: metas.map((m) => ({
        secid: m.secid, name: m.name, index: m.index,
        peakSuperVsAvg: typeof peaks[m.secid] === 'number' ? peaks[m.secid] : null,
      })),
    }
    // 无「最后一次成功采样」时，用当日峰值合成卡片（其余字段留空），
    // 保持与正常态一致的卡片布局，而不是退回一张表
    const synth: RescueEtfView[] = lastEtfs.length > 0
      ? lastEtfs
      : metas.map((m) => ({
          secid: m.secid, name: m.name, index: m.index, price: null, pct: null, amount: null,
          volRatio: null, timeAdjMult: null, avgAmt20: null, superNet: null, mainNet: null,
          superShare: null, superVsAvg: typeof peaks[m.secid] === 'number' ? peaks[m.secid] : null,
          pulseMult: null, activity: 0, triggered: false, flowDirection: 'unknown', provisional: true,
        }))
    const note = lastEtfs.length > 0
      ? `上游行情暂不可用：显示当日最后一次成功采样（${lastEtfs.length} 个通道）`
      : '上游行情暂不可用：通道按当日峰值复盘展示（无实时价与成交额）'
    return { etfs: synth, meta, note }
  }

  /**
   * 底部视图：位置 + 日内形态 + 概率（概率来自跨通道合并的历史频率校准）。
   * 概率与形态分开呈现 —— 日内形态没有可回算的历史分钟数据，不进入概率。
   *
   * 不可用时（日线还没拉到 / 校准冷却中 / 校准失败）保留上一次成功视图并标 `stale`：
   * 此前直接 `return undefined`，整块「底部位置 / 形态 / 概率」面板会凭空消失，
   * 而这恰恰发生在上游最抖的时候 —— 用户看到的不是"数据旧"，是"功能没了"。
   */
  private buildBottom(etfs: RescueEtfView[]): RescueSnapshot['bottom'] {
    const lanes = etfs.filter((e) => this.dailyBars[e.secid] !== undefined).slice(0, 8)
    if (lanes.length === 0) return this.retainedBottom()
    // 节流：位置/形态/概率都基于日线与当日快照，没必要每个 tick 重算（15–60s 一次足够）
    const cacheKey = `${this.todayKey}|${lanes.map((l) => `${l.secid}:${l.price ?? 0}`).join(',')}`
    const now = Date.now()
    if (this.bottomCache !== null && this.bottomCache.key === cacheKey && now - this.bottomCache.at < 60_000) {
      return this.bottomCache.view
    }
    // 校准失败（日线拉取失败）后进入冷却，避免每 tick 重跑全量回测
    const cal =
      this.bottomCal ??
      (now < this.bottomCalRetryAfter
        ? null
        : calibrateAcross(Object.values(this.dailyBars).map((b) => b as DailyBarLite[])))
    if (cal === null) return this.retainedBottom()
    const views: RescueBottomLane[] = lanes.map((e) => {
      const bars = this.dailyBars[e.secid] ?? []
      const minutes = this.minutes[e.secid] ?? []
      return buildBottomLane({
        secid: e.secid, name: e.name, bars, price: e.price,
        open: e.open ?? null, high: e.high ?? null, low: e.low ?? null,
        minutes, volumeRatio: e.timeAdjMult, calibration: cal,
      })
    })
    const view: RescueSnapshot['bottom'] = {
      lanes: views,
      model:
        `${cal.rule}；口径为前向 ${cal.horizon} 日内最高价达到当日收盘 × (1+目标) 的历史频率，` +
        `同类样本 ${cal.n}（基线 ${cal.baseN}，覆盖 ${cal.lanes} 个通道）；` +
        `前向收盘收益中位数 ${cal.medianForward === null ? '—' : (cal.medianForward * 100).toFixed(2) + '%'}，` +
        `期间最大回撤中位数 ${cal.medianDrawdown === null ? '—' : (cal.medianDrawdown * 100).toFixed(2) + '%'}`,
      asOf: this.todayKey,
      computedAt: now,
    }
    this.bottomCache = { at: now, key: cacheKey, view }
    this.bottomLast = { at: now, view }
    return view
  }

  /**上次成功算出的底部视图（标 stale 并保留原计算时刻）；从未算出过则为 undefined */
  private retainedBottom(): RescueSnapshot['bottom'] {
    if (this.bottomLast === null) return undefined
    return { ...this.bottomLast.view, stale: true, computedAt: this.bottomLast.at }
  }

  /**近 60 天每日摘要（历史回看） */
  history(limit = 30): RescueDaySummary[] {
    const out: RescueDaySummary[] = []
    for (const day of Object.keys(this.file.days).sort().reverse().slice(0, limit)) {
      const d = this.file.days[day]
      const maxScore = d.intraday.reduce((a, p) => Math.max(a, p.score), d.events.reduce((a, e) => Math.max(a, e.score), 0))
      // A-1：**跳过没有等级的样本**（非交易时段样本不进 intraday，但历史/外来日志里可能是 null）
      const lv = (v: unknown): RescueLevel | null => (typeof v === 'number' && Number.isFinite(v) ? (v as RescueLevel) : null)
      const maxLevel = d.intraday.reduce<RescueLevel>((a, p) => (lv(p.level) === null ? a : Math.max(a, p.level) as RescueLevel), d.events.reduce<RescueLevel>((a, e) => (lv(e.level) === null ? a : Math.max(a, e.level) as RescueLevel), 0))
      const peak = d.intraday.find((p) => p.score === maxScore) ?? null
      out.push({ day, maxLevel, maxScore, events: d.events.filter((e) => e.level >= 1).length, peakHhmm: peak?.hhmm ?? null })
    }
    return out
  }

  intradayOf(day: string): RescueIntradayPoint[] {
    return this.file.days[day]?.intraday ?? []
  }

  /**
   * 近 `limitDays` 个自然日出分日志里的**连续评分**（用于分位）。
   *
   * 口径：只用已落盘的 `days[].scoreLog` 与当日内存里的 `today.scoreLog`（跳过 `file.days` 里的今天，避免重复计）。
   * 样本不足由 `scorePercentile` 如实返回 null —— 这里**不做任何补齐/插值**。
   */
  private recentContinuous(limitDays = 20): number[] {
    const out: number[] = []
    for (const day of Object.keys(this.file.days).sort().filter((d) => d !== this.todayKey).slice(-limitDays)) {
      for (const e of this.file.days[day]?.scoreLog ?? []) {
        if (typeof e.continuous === 'number' && Number.isFinite(e.continuous)) out.push(e.continuous)
      }
    }
    for (const e of this.today.scoreLog ?? []) {
      if (typeof e.continuous === 'number' && Number.isFinite(e.continuous)) out.push(e.continuous)
    }
    return out.slice(-600)
  }

  /**出分日志（P0-7）：阈值漂移回溯用；不传 day 取当日 */
  scoreLogOf(day?: string): Array<Record<string, unknown>> {
    const key = day ?? dayOf(Date.now())
    const log = this.file.days[key]?.scoreLog ?? (key === this.todayKey ? this.today.scoreLog : undefined) ?? []
    return log.map((e) => ({ ...e, factors: e.factors.map((f) => ({ ...f })) }))
  }

  eventsOf(day: string): RescueSignalEvent[] {
    return this.file.days[day]?.events ?? []
  }

  /**立即落盘（跳过节流）：受控入口，供测试与需要"写完再回"的调用方使用 */
  async flush(): Promise<void> {
    await this.persist(true)
  }

  /**本会话是否还没有成功快照（收盘后重启即属此情形） */
  get hasFreshData(): boolean {
    return this.lastSnapshot !== null
  }

  /**自动补采冷却：避免前端轮询把上游打爆 */
  private lastAutoTry = 0
  private static readonly AUTO_TRY_COOLDOWN_MS = 20_000

  /**无新鲜数据时按冷却自动采一次（供路由使用）；返回是否真的采了 */
  async ensureFresh(): Promise<boolean> {
    if (this.hasFreshData) return false
    const now = Date.now()
    if (now - this.lastAutoTry < RescueMonitor.AUTO_TRY_COOLDOWN_MS) return false
    this.lastAutoTry = now
    await this.init()
    if (phaseOf(hhmmOf(now)) === 'pre') return false
    try {
      // 与在飞的定时采样合并（重入守卫）：这里不再叠加第二份全量采样
      await this.tick()
    } catch {
      /* 失败则交由 LKG 兜底 */
    }
    return true
  }

  /**采样健康度：最近一次采样距今是否超过 2 个间隔 */
  stale(): boolean {
    const last = this.lastSnapshot?.lastSampleTs ?? null
    if (last === null) return false
    return inTradingWindow(Date.now()) && Date.now() - last > this.activeIntervalSec() * 1000 * 2.5
  }

  get calibratedInfo(): { progressDays: number; generatedAt: string } {
    return { progressDays: this.file.progressDays || RESCUE_CALIBRATION.progressDays, generatedAt: RESCUE_CALIBRATION.generatedAt }
  }

  /**供前端绘制「同时点基准」用：进度曲线 + F1/F2 锚点 */
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

/**
 * 口径字符串（随结果返回）：六因子怎么算、采样窗、等级区间，以及不能用来断言"国家队已入场"。
 * 三段说明（怎么算/怎么读/不能用来干什么）另见工具描述 —— 界面常驻仍然只留一行。
 */
export const RESCUE_METHODOLOGY =
  '六因子：宽基 ETF 量能倍数、超大单净额、脉冲（5 分钟量能突增）、量价背离、共振（多通道同向）、持续（连续采样同向）；' +
  '采样窗＝盘中每 30s 一次（尾盘自 tailFrom 起 15s 一次），等级 0–3 按综合评分区间给出：' +
  '0 平静 ｜ 1 资金异动 ｜ 2 疑似护盘 ｜ 3 强护盘信号；超大单为东财按单笔金额的分类口径，ETF 天量含做市与套利盘。' +
  '不能用来断言"国家队已入场" —— 汇金/国新/诚通不披露日内成交，这是行为模式识别而非身份确认。'
