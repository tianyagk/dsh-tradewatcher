/**
 * 杠杆温度计（宿主侧）——A 股两融杠杆热度。
 *
 * ## 口径（实测出处见 `docs/PROBE-LEVERAGE.md`）
 * 数据源只有一个报表：东财数据中心 `RPTA_RZRQ_LSHJ`（**沪深北三市场算术和**，已用沪/深/京
 * 分市场报表逐列对拍：三者之和与合计报表**一分不差**）。一次请求就给出温度计要的全部读数：
 *
 *   - `RZYE`   融资余额（元）
 *   - `RQYE`   融券余额（元）
 *   - `RZJME`  当日融资净买入（元）＝ `RZMRE − RZCHE`（实测仅元级舍入差）
 *   - `LTSZ`   流通市值合计（元）——已用深交所「市场总貌」股票流通市值对拍（差 0.01 亿元＝截断）
 *   - `RZYEZB` 显性融资比例（融资余额 ÷ 流通市值 × 100）——4018 行全部满足该恒等式
 *
 * 两融是 **T+1 披露**（实测：10-20 19:21 时最新一条仍是 10-19）⇒ 回包的 `asOf` 是**上一交易日**，
 * 文案不能说"今日"。这也决定了两件事：**一天最多打一次上游**（当天数据不会中途变），
 * 以及 `pageSize` 实测被上游截到 **800 行/页** ⇒ 全历史（4018 交易日）要 **6 页**回填。
 *
 * ## 温度怎么算（唯一允许的口径：**以 2024 为基准线重标定**）
 * 样本是**全历史**（2010-03-31 起 4018 行，**不删任何年份**），三步：
 *   1. `P(ratio)` = `RZYEZB` 的**全历史扩张窗口分位**（0–100，1 位小数，无前视）；
 *   2. `P0` = **基准年（`LEVERAGE_ANCHOR = 2024-01-01`）各日 `P[i]` 的中位**（分位轴上的常量）
 *      ⇒ **2024 整段落在 50 上**，温度的含义 = "相对 2024 年的水平"；
 *   3. `temperature = clamp(P(ratio) − P0 + 50, 0, 100)`。
 * 全历史样本 < `LEVERAGE_MIN_SAMPLES`（250）⇒ `null`（**不给 0**）；样本够时**全周期都有温度**
 * （曲线只在最前面 249 个交易日为 `null`，因为那时窗口样本不足）。
 *
 * 为什么不是"直接拿全历史分位当温度"：那样早年永远低位、近期永远高位（样本越攒越多，位置只会往上爬），
 * 读不出"现在比 2024 年典型水平热多少"；也不是"只算 2024 之后的样本"（那会把全周期砍掉一半）。
 * 逐点同规则 ⇒ 历史点不会被今天改写；最后一点与 `temperature` 恒等。
 *
 * ## 落盘
 * `<DSH_HOME>/dsh-tradewatcher/leverage.json`：`{v,lastFetchDay,lastAttemptAt,cross,rows[]}`，
 * 行 = `{d,rzye,rqye,ltsz,rzyezb,rzjme}`（`null` 表示上游没给，**不是 0**）。
 * 读走 `ReadGuard`（ENOENT 才算"本来就没有"），写走 `updateJsonLocked`（锁内读磁盘最新 →
 * 按日去重合并 → 升序 → 裁剪 → 原子写回），坏文件先隔离再重建。体积上限见 `LEVERAGE_MAX_BYTES`。
 *
 * ## 交叉校验（**只内部记录，不进回包**）
 * 深交所官方「融资融券交易总量」给的是**深市单市**，东财合计是**沪深北** ⇒ 两者不能做等值比对
 * （差 50% 是口径，不是错误）。这里只校验一条量级关系：深市余额 > 0、小于合计、且占合计
 * 落在 30–70%。结果落盘到 `cross`，用于离线排查；**回包不含它**（契约冻结）。
 */
import { mkdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { withHostBreaker } from './breakerFetch.ts'
import { log } from './context.ts'
import { updateJsonLocked } from './lock.ts'
import { marginFromSzse, type MarginReading } from './marketExtras.ts'
import { isFirstBoot, quarantineFile, ReadGuard } from './readGuard.ts'
import { dataHome } from './store.ts'
import { dayOf, hhmmOf, weekdayOf } from './time.ts'

// ── 常量（全部写死在一处，避免路由/测试各抄一份而漂移） ─────────────────────

/** 落盘文件名 */
export const LEVERAGE_FILE = 'leverage.json'
/** 分位所需的最小样本数（低于它 ⇒ `temperature: null`，**不给 0**） */
export const LEVERAGE_MIN_SAMPLES = 250
/** 回包窗口：250 / 750 个交易日 / 全历史 */
export const LEVERAGE_RANGES = [250, 750, 'all'] as const
export type LeverageRange = (typeof LEVERAGE_RANGES)[number]
/** 纯函数接受的窗口（数字 = 最近 N 个交易日；测试与将来的其它窗口也走这里） */
export type LeverageWindow = number | 'all'
export const LEVERAGE_DEFAULT_RANGE: LeverageRange = 750
/**
 * **基准年标识：`2024-01-01`；2024 年整段落在 50（段中位 = 50），含义 = "相对 2024 年的水平"**
 * （用户裁决 B，v0.119.x；此前的三种口径见报告 §9.6）。
 *
 * ⚠ 它**不是**"删掉 2024 年之前的数据"：样本始终是**全历史**（2010-03-31 起 4018 行），
 * 全周期都有温度；2024 只是**定基准线** —— 把"2024 年的典型水平"放到温度轴的 **50** 上，
 * 于是早年和今天都相对这条基准线上下浮动（见 `baselineTemperatures`）。
 *
 * 为什么需要基准：全历史分位跨越两次制度断点（2014-09-22 起两融总量并入"调出标的"、
 * 2023 年北交所并入合计 ⇒ 早期读数系统性偏低、今天的位置略偏高）。固定一条"以 2024 为 50"
 * 的基准线后，曲线的**相对高低**可跨版本比较，而样本仍然是全周期。
 *
 * ⚠ 唯一真源：任何地方要"基准年 P80/P95 的比例等价值"，必须用**同一批全历史样本**算；
 * 客户端两条阈值线固定在温度轴 80 / 95，所以回包里的 `thresholds` 仍是常量 `{p80:80,p95:95}`。
 */
export const LEVERAGE_ANCHOR = '2024-01-01'
/** 基准值取法：`year-median`（默认）= 基准年**各日分位的中位**；`first-day` = 基准年首个交易日的分位 */
export type BaselineMode = 'year-median' | 'first-day'
/**
 * 基准值取法（默认 `year-median`）。
 *
 * 两种取法**都在分位轴上取值**（不是比例轴上），只影响基准值 `P0`：
 *   · `year-median`：基准年**各日 `P[i]` 的中位** ⇒ **基准年整段落在 50**（段中位 = 50），
 *     含义 = "相对 2024 年的水平"（用户裁决，v0.119.x）；
 *   · `first-day` ：基准年**首个交易日的 `P[i]`** ⇒ 更"点位化"，会被单日噪音带偏（留作备选）。
 */
export const LEVERAGE_BASELINE_MODE: BaselineMode = 'year-median'
/** 图上的两条阈值线（**温度轴**口径，不是比例口径；比例等价值见 `LEVERAGE_ANCHOR` 的注释） */
export const LEVERAGE_THRESHOLDS = { p80: 80, p95: 95 } as const
/** 上游单页上限（实测：`pageSize=2000` 仍只回 800 行，且 `pages` 按 800 折算） */
export const LEVERAGE_PAGE_SIZE = 800
/** 全历史回填页数（4018 交易日 ÷ 800 ⇒ 6 页；实测 `pages=6`） */
export const LEVERAGE_BACKFILL_PAGES = 6
/** 两融披露窗口（北京时间的时:分）——早于它拉到的往往是"上一日之前"的数，见 `needsDailyFetch` */
export const LEVERAGE_DISCLOSE_HHMM = '09:30'
/**
 * 落盘上限：行数 + 字节。
 *
 * 实测（2026-10-20）：全历史 4018 行按**落盘真实序列化**（`writeJsonAtomic` 的 1 空格缩进）
 * = **600 KB**；同一份数据紧凑序列化是 459 KB。缩进是既有口径（`atomic.ts` 定死，改不了），
 * 所以上限按真实字节取 1 MB —— 它不是增长闸（按日只增 1 行），**行数上限才是**：
 * 4500 行 ≈ 跑满 17 年才会丢最旧的。
 */
export const LEVERAGE_MAX_ROWS = 4500
export const LEVERAGE_MAX_BYTES = 1024 * 1024
/** 深市占合计的合理区间（只用于内部 `cross.ok`，不是投资判断） */
export const LEVERAGE_SZSE_SHARE_MIN = 30
export const LEVERAGE_SZSE_SHARE_MAX = 70

const HOST = 'datacenter-web.eastmoney.com'
const REPORT = 'RPTA_RZRQ_LSHJ'
const COLUMNS = 'DIM_DATE,RZYE,RQYE,RZJME,LTSZ,RZYEZB'
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
const REFERER = 'https://data.eastmoney.com/'
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/

// ── 类型（回包字段名已冻结：客户端按同一份契约编码，**不许改名**） ─────────────

/** 落盘的一行（`null` = 上游没给这个字段；**绝不写 0** 冒充） */
export interface LeverageRow {
  d: string
  rzye: number | null
  rqye: number | null
  ltsz: number | null
  rzyezb: number | null
  rzjme: number | null
}

/** 内部交叉校验记录（不进回包） */
export interface LeverageCross {
  /** 校验对应的交易日（两融数据日） */
  d: string
  /** 深交所「融资融券交易总量」的融资余额（**亿元**，深市单市） */
  szseRzye: number | null
  /** 东财合计的融资余额（**亿元**，沪深北） */
  emRzye: number | null
  /** 深市 ÷ 合计（%）；口径不同，只当量级指标看 */
  sharePct: number | null
  /** 量级关系是否成立（深市 > 0、< 合计、份额在 30–70%） */
  ok: boolean
  /** 口径说明（写进磁盘，便于日后排查"为什么不是等值比对"） */
  note: string
}

/** 落盘文件 */
export interface LeverageFile {
  v: 1
  /** 最近一次**发起**上游取数的北京自然日（失败也记 ⇒ 一天最多一次） */
  lastFetchDay: string | null
  /** 最近一次取数的时刻（epoch ms），用于"披露窗口前拉早了"的补拉判断 */
  lastAttemptAt: number | null
  cross: LeverageCross | null
  rows: LeverageRow[]
}

/** 冻结契约：`GET /tradewatcher/leverage` 的回包 */
export interface LeveragePayload {
  /** 截至交易日 `YYYY-MM-DD`；**没有可用数据时是空串**（不是 null：客户端会 slice/格式化它） */
  asOf: string
  /**
   * 温度 0–100（1 位小数）= `clamp(全历史扩张窗口分位 − P0 + 50, 0, 100)`，
   * 其中 `P0` = 基准年（`LEVERAGE_ANCHOR`，2024）**各日分位的中位** ⇒ **2024 整段落在 50 上**。
   * **样本是全历史**（2010-03-31 起），全周期都有值；全历史样本 < `LEVERAGE_MIN_SAMPLES`（250）⇒ null。
   * 口径换过三次（v0.116 全历史 → v0.116.x 锚定删数据[废弃] → v0.119-A 比例轴基准[同日被 B 取代]
   * → v0.119-B 分位轴基准 = 现行），**字段名与形状始终不变**。
   */
  temperature: number | null
  /** `RZYEZB` 原值（%），2 位小数 */
  ratioPct: number | null
  /** `(RZYE+RQYE)/LTSZ*100`（%），2 位小数 */
  ratioWithShortPct: number | null
  /** 融资余额（元） */
  marginBalance: number | null
  /** 融券余额（元） */
  shortBalance: number | null
  /** 流通市值合计（元） */
  floatMv: number | null
  /** 当日融资净买入（元） */
  netBuy: number | null
  thresholds: { p80: number; p95: number }
  /** 升序，长度 = 返回窗口（`all` ⇒ 全历史） */
  dates: string[]
  temp: Array<number | null>
  ratio: Array<number | null>
  net: Array<number | null>
}

// ── 纯函数：取数形状 → 行 ────────────────────────────────────────────────

/**
 * 上游数字 → `number | null`。
 *
 * ⚠ 空串必须给 `null`，**不是 0**：`Number('') === 0`，而把"上游没给"读成 0 会让
 * 「融资余额 0 元」「温度 0 分」这类假读数一路画到界面上（`marketExtras.ts`/`sina.ts`
 * 都踩过同一个坑，这里沿用同一口径）。
 */
function numOf(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  if (typeof v === 'string') {
    const text = v.replace(/,/g, '').trim()
    if (text === '') return null
    const n = Number(text)
    return Number.isFinite(n) ? n : null
  }
  return null
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** 上游一行 → 落盘行；日期不合法 ⇒ null（跳过该行，不让整个回填失败） */
export function toLeverageRow(raw: unknown): LeverageRow | null {
  if (!isRecord(raw)) return null
  const stamp = typeof raw.DIM_DATE === 'string' ? raw.DIM_DATE.slice(0, 10) : ''
  if (!DAY_RE.test(stamp)) return null
  return {
    d: stamp,
    rzye: numOf(raw.RZYE),
    rqye: numOf(raw.RQYE),
    ltsz: numOf(raw.LTSZ),
    rzyezb: numOf(raw.RZYEZB),
    rzjme: numOf(raw.RZJME),
  }
}

/** 日期升序比较（`YYYY-MM-DD` 字典序即时间序） */
function byDay(a: LeverageRow, b: LeverageRow): number {
  return a.d < b.d ? -1 : a.d > b.d ? 1 : 0
}

export function round1(v: number | null): number | null {
  return v === null || !Number.isFinite(v) ? null : Math.round(v * 10) / 10
}

export function round2(v: number | null): number | null {
  return v === null || !Number.isFinite(v) ? null : Math.round(v * 100) / 100
}

// ── 纯函数：分位 ─────────────────────────────────────────────────────────

/**
 * `current` 在 `samples` 里的百分位（0–100，1 位小数）；样本不足 `minSamples` ⇒ null。
 *
 * 定义：小于等于 current 的样本数 ÷ 样本总数 × 100（与 `host/breadth.ts` 的 `percentileOf`
 * 同一口径）。`null` 样本不参与（`RZYEZB` 历史实测 0 缺失，但上游哪天抽风不该把分母改小）。
 */
export function percentileRank(
  current: number | null,
  samples: readonly (number | null)[],
  minSamples = LEVERAGE_MIN_SAMPLES,
): number | null {
  const vals = samples.filter((v): v is number => typeof v === 'number' && Number.isFinite(v))
  if (current === null || !Number.isFinite(current) || vals.length < minSamples) return null
  let le = 0
  for (const v of vals) if (v <= current) le += 1
  return round1((le / vals.length) * 100)
}

/**
 * 逐日**扩张窗口**分位：第 i 天只用 `values[0..i]`（无前视），样本不足给 `null`。
 *
 * 为什么不做"全样本分位"：那样今天的新数据会把整条历史曲线改写（同一根 K 线的颜色会
 * 随未来数据变化），是典型的未来函数。最后一点的全样本分位与扩张窗口分位**恒等**，
 * 所以回包的 `temperature` 两种算法在这个位置上一致。
 */
export function expandingPercentiles(
  values: readonly (number | null)[],
  minSamples = LEVERAGE_MIN_SAMPLES,
): Array<number | null> {
  const sorted: number[] = []
  const out: Array<number | null> = []
  for (const raw of values) {
    if (typeof raw !== 'number' || !Number.isFinite(raw)) {
      out.push(null)
      continue
    }
    // 有序插入（lowerBound）⇒ 单次 O(n)，全程 O(n²) 但 n≈4000，实测毫秒级
    let lo = 0
    let hi = sorted.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (sorted[mid] < raw) lo = mid + 1
      else hi = mid
    }
    sorted.splice(lo, 0, raw)
    if (sorted.length < minSamples) {
      out.push(null)
      continue
    }
    // 小于等于 raw 的个数 = 最后一个等于 raw 的下标 + 1（刚才插入了一个 raw）
    let up = lo
    while (up < sorted.length && sorted[up] <= raw) up += 1
    out.push(round1((up / sorted.length) * 100))
  }
  return out
}

/**
 * 基准年样本（`anchor` 的年份内、且 `d >= anchor` 的行）。
 *
 * "基准年"是**定基准线用的**，不是"只算这几年"：样本集永远是全历史，这里只挑出
 * 用来算基准值 `P0` 的那一段。
 */
export function baselineYearRows(rows: readonly LeverageRow[], anchor: string = LEVERAGE_ANCHOR): LeverageRow[] {
  const year = anchor.slice(0, 4)
  return [...rows].sort(byDay).filter((r) => r.d >= anchor && r.d.slice(0, 4) === year)
}

function isNum(v: number | null): v is number {
  return typeof v === 'number' && Number.isFinite(v)
}

/** 中位数（偶数个取中间两个的均值；空数组 ⇒ null） */
export function medianOf(values: readonly number[]): number | null {
  const v = values.filter((x) => Number.isFinite(x)).sort((a, b) => a - b)
  if (v.length === 0) return null
  const mid = (v.length - 1) / 2
  const lo = Math.floor(mid)
  const hi = Math.ceil(mid)
  return (v[lo] + v[hi]) / 2
}

/**
 * **基准值 `P0`**：把"基准年的水平"落到**分位轴**上的位置（0–100，1 位小数）。
 *
 * 口径（`LEVERAGE_BASELINE_MODE`，两种都在**分位轴**上取值）：
 *   · `year-median`（默认）：`P0 = median{ P[i] | i ∈ 基准年 }` ⇒ **基准年整段落在 50**，
 *     温度的含义 = "**相对 2024 年的水平**"（用户裁决，v0.119.x）；
 *   · `first-day` ：`P0 = P[基准年首个交易日]`。
 *
 * 无基准年样本 ⇒ `null`（温度整列随之 `null`，**不给 0**）。
 * 注意：`P[i]` 自己是**扩张窗口分位**（无前视），所以这里取的是"基准年那段时间当时的分位"的中位，
 * 而不是"基准年中位比例放到全历史分位轴上"——后者会让基准年整段偏到 50 之上（见报告 §9.2）。
 */
export function baselinePercentile(
  rows: readonly LeverageRow[],
  opts: { anchor?: string; mode?: BaselineMode; minSamples?: number } = {},
): number | null {
  const ordered = [...rows].sort(byDay)
  const minSamples = opts.minSamples ?? LEVERAGE_MIN_SAMPLES
  const p = expandingPercentiles(ordered.map((r) => r.rzyezb), minSamples)
  return baselineFromSeries(ordered, p, opts)
}

/** 基准值的内部实现（复用已经算好的分位序列，避免重复 O(n log n)） */
function baselineFromSeries(
  ordered: readonly LeverageRow[],
  p: ReadonlyArray<number | null>,
  opts: { anchor?: string; mode?: BaselineMode } = {},
): number | null {
  const anchor = opts.anchor ?? LEVERAGE_ANCHOR
  const mode = opts.mode ?? LEVERAGE_BASELINE_MODE
  const pos = new Map<string, number>()
  ordered.forEach((r, i) => pos.set(r.d, i))
  const yearRows = baselineYearRows(ordered, anchor)
  if (yearRows.length === 0) return null
  if (mode === 'first-day') {
    const first = pos.get(yearRows[0].d)
    return first === undefined ? null : (p[first] ?? null)
  }
  const yearP = yearRows.map((r) => p[pos.get(r.d) ?? -1]).filter(isNum)
  const med = medianOf(yearP)
  return med === null ? null : round1(med)
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v))
}

export interface BaselineSeries {
  /** 逐日**全历史扩张窗口**分位（0–100，1 位小数；前 249 天窗口不足 ⇒ null） */
  p: Array<number | null>
  /** 基准值 `P0`（基准年典型水平落在分位轴上的位置）；null ⇒ 温度整列为 null */
  baseline: number | null
  /** 逐日温度 = clamp(P − P0 + 50, 0, 100)，1 位小数 ⇒ **基准年典型水平 = 50** */
  temp: Array<number | null>
}

/**
 * **温度序列（唯一口径）**：以 `LEVERAGE_ANCHOR`（2024）为基准线，全周期相对它上下浮动。
 *
 * 三步，逐点在**全历史**上算（**不删任何年份**）：
 *   1. `p[i]` = `RZYEZB[i]` 在「第 0 天 … 第 i 天」里的百分位（扩张窗口 ⇒ **无前视**）；
 *   2. `P0` = 基准年典型水平（默认中位比例）落在**全历史**分位轴上的位置（常量）；
 *   3. `temp[i] = clamp(p[i] − P0 + 50, 0, 100)` ⇒ 基准年典型水平 = **50**（基准线）。
 *
 * 为什么减 P0 再加 50：直接把分位当温度会让"早年"永远显示低位、近期永远高位（样本只会越攒越多）；
 * 减去基准年后，读数的含义变成"**相对 2024 年典型水平**偏热/偏冷多少"，全周期可比。
 */
export function baselineTemperatures(
  rows: readonly LeverageRow[],
  opts: { anchor?: string; mode?: BaselineMode; minSamples?: number } = {},
): BaselineSeries {
  const minSamples = opts.minSamples ?? LEVERAGE_MIN_SAMPLES
  const ordered = [...rows].sort(byDay)
  const p = expandingPercentiles(ordered.map((r) => r.rzyezb), minSamples)
  const baseline = baselineFromSeries(ordered, p, opts)
  const temp = p.map((v) =>
    v === null || baseline === null ? null : round1(clamp(v - baseline + 50, 0, 100)),
  )
  return { p, baseline, temp }
}

// ── 纯函数：窗口切片 / 回包组装 ──────────────────────────────────────────

/** `?range=` → 合法窗口；非法/缺省一律默认值（**路由永不因此 4xx**） */
export function parseLeverageRange(raw: string | null | undefined): LeverageRange {
  const text = String(raw ?? '').trim().toLowerCase()
  if (text === 'all') return 'all'
  if (text === '250') return 250
  if (text === '750') return 750
  return LEVERAGE_DEFAULT_RANGE
}

/** 取窗口切片（升序；`all` ⇒ 全部） */
export function sliceLeverageWindow(rows: readonly LeverageRow[], range: LeverageWindow): LeverageRow[] {
  const ordered = [...rows].sort(byDay)
  return range === 'all' ? ordered : ordered.slice(-range)
}

/**
 * 组装回包（纯函数：给定行集合与窗口，结果确定）。
 *
 * 逐字段规则：上游没给 ⇒ `null`；`RZYEZB` 有值但 `LTSZ` 缺失时 `ratioPct` 仍给（原值可用），
 * 而 `ratioWithShortPct` 需要三者齐全才算（缺一个就 null，**不拿 0 补**）。
 */
export function buildLeveragePayload(
  rows: readonly LeverageRow[],
  range: LeverageWindow,
  opts: { minSamples?: number; anchor?: string; mode?: BaselineMode } = {},
): LeveragePayload {
  const min = opts.minSamples ?? LEVERAGE_MIN_SAMPLES
  const ordered = [...rows].sort(byDay)
  const window = sliceLeverageWindow(ordered, range)
  // 温度口径：全历史扩张窗口分位 − 基准年基准值 P0 + 50（基准年典型水平 = 50，全周期都有值）
  const { temp: temps } = baselineTemperatures(ordered, { anchor: opts.anchor, mode: opts.mode, minSamples: min })
  const posOf = new Map<string, number>()
  ordered.forEach((r, i) => posOf.set(r.d, i))

  const last = ordered.length > 0 ? ordered[ordered.length - 1] : null
  const lastIdx = ordered.length - 1
  const temperature = last === null ? null : (temps[lastIdx] ?? null)
  const ratioPct = last === null ? null : round2(last.rzyezb)
  const ratioWithShortPct =
    last === null || last.rzye === null || last.rqye === null || last.ltsz === null || last.ltsz <= 0
      ? null
      : round2(((last.rzye + last.rqye) / last.ltsz) * 100)

  return {
    asOf: last === null ? '' : last.d,
    temperature,
    ratioPct,
    ratioWithShortPct,
    marginBalance: last === null ? null : last.rzye,
    shortBalance: last === null ? null : last.rqye,
    floatMv: last === null ? null : last.ltsz,
    netBuy: last === null ? null : last.rzjme,
    thresholds: { ...LEVERAGE_THRESHOLDS },
    dates: window.map((r) => r.d),
    temp: window.map((r) => temps[posOf.get(r.d) ?? -1] ?? null),
    ratio: window.map((r) => round2(r.rzyezb)),
    net: window.map((r) => r.rzjme),
  }
}

/** 整块不可用时的回包（契约要求：**永远 200 + 全 null**，不是 5xx、也不是空对象） */
export function emptyLeveragePayload(_range: LeverageRange = LEVERAGE_DEFAULT_RANGE): LeveragePayload {
  return {
    asOf: '',
    temperature: null,
    ratioPct: null,
    ratioWithShortPct: null,
    marginBalance: null,
    shortBalance: null,
    floatMv: null,
    netBuy: null,
    thresholds: { ...LEVERAGE_THRESHOLDS },
    dates: [],
    temp: [],
    ratio: [],
    net: [],
  }
}

// ── 纯函数：落盘文件的解析 / 合并 / 裁剪 ─────────────────────────────────

function emptyFile(): LeverageFile {
  return { v: 1, lastFetchDay: null, lastAttemptAt: null, cross: null, rows: [] }
}

/** 磁盘内容 → `LeverageFile`；顶层形状不认识 ⇒ null（调用方负责隔离） */
export function parseLeverageFile(raw: unknown): LeverageFile | null {
  if (!isRecord(raw)) return null
  const rowsRaw = Array.isArray(raw.rows) ? raw.rows : null
  if (rowsRaw === null) return null
  const rows: LeverageRow[] = []
  for (const item of rowsRaw) {
    const row = parseLeverageRow(item)
    if (row !== null) rows.push(row)
  }
  const cross = parseCross(raw.cross)
  return {
    v: 1,
    lastFetchDay: typeof raw.lastFetchDay === 'string' && DAY_RE.test(raw.lastFetchDay) ? raw.lastFetchDay : null,
    lastAttemptAt: typeof raw.lastAttemptAt === 'number' && Number.isFinite(raw.lastAttemptAt) ? raw.lastAttemptAt : null,
    cross,
    rows: rows.sort(byDay),
  }
}

function parseLeverageRow(raw: unknown): LeverageRow | null {
  if (!isRecord(raw)) return null
  const d = typeof raw.d === 'string' && DAY_RE.test(raw.d) ? raw.d : null
  if (d === null) return null
  return {
    d,
    rzye: numOf(raw.rzye),
    rqye: numOf(raw.rqye),
    ltsz: numOf(raw.ltsz),
    rzyezb: numOf(raw.rzyezb),
    rzjme: numOf(raw.rzjme),
  }
}

function parseCross(raw: unknown): LeverageCross | null {
  if (!isRecord(raw)) return null
  const d = typeof raw.d === 'string' && DAY_RE.test(raw.d) ? raw.d : null
  if (d === null) return null
  return {
    d,
    szseRzye: numOf(raw.szseRzye),
    emRzye: numOf(raw.emRzye),
    sharePct: numOf(raw.sharePct),
    ok: raw.ok === true,
    note: typeof raw.note === 'string' ? raw.note.slice(0, 200) : '',
  }
}

/** 按日合并（同一天以 `incoming` 为准 ⇒ 重跑同一批数据是**幂等**的） */
export function mergeLeverageRows(
  disk: readonly LeverageRow[],
  incoming: readonly LeverageRow[],
): { rows: LeverageRow[]; added: number } {
  const map = new Map<string, LeverageRow>()
  for (const row of disk) map.set(row.d, row)
  let added = 0
  for (const row of incoming) {
    if (!map.has(row.d)) added += 1
    map.set(row.d, row)
  }
  return { rows: [...map.values()].sort(byDay), added }
}

/**
 * 落盘字节数：**必须与 `writeJsonAtomic` 的序列化一致**（1 空格缩进）。
 * 用紧凑 JSON 会低估约 30%（4018 行：459 KB vs 600 KB），字节闸就会假通过。
 */
function fileBytes(file: LeverageFile): number {
  return Buffer.byteLength(JSON.stringify(file, null, 1), 'utf8')
}

/** 裁剪到上限（丢最旧的，留痕 `dropped`；最新一行绝不丢） */
export function trimLeverageRows(
  rows: readonly LeverageRow[],
  maxRows = LEVERAGE_MAX_ROWS,
  maxBytes = LEVERAGE_MAX_BYTES,
): { rows: LeverageRow[]; dropped: number } {
  const out = [...rows].sort(byDay)
  let dropped = 0
  while (out.length > maxRows) {
    out.shift()
    dropped += 1
  }
  // 字节上限：从最旧的开始丢，但保留最后一行（否则"当前读数"会凭空消失）
  while (out.length > 1 && fileBytes({ ...emptyFile(), rows: out }) > maxBytes) {
    out.shift()
    dropped += 1
  }
  return { rows: out, dropped }
}

// ── 取数 ────────────────────────────────────────────────────────────────

export interface LeveragePageRequest {
  page: number
  pageSize: number
  order: 'asc' | 'desc'
}

export interface LeveragePage {
  rows: LeverageRow[]
  /** 上游给的总页数（未知 ⇒ 1） */
  pages: number
}

/**
 * 取一页两融历史（升序用于回填，「取最新一行」用 `order:'desc'` + `pageSize:1`）。
 *
 * 与 `marketExtras.marginFromEm` 同一个上游主机与同一套头；一并计入该主机的熔断器
 * （`withHostBreaker`）⇒ 上游挂掉时不会在这里反复重试。
 */
export async function fetchLeveragePage(req: LeveragePageRequest): Promise<LeveragePage> {
  const page = Math.max(1, Math.round(req.page))
  const size = Math.max(1, Math.min(LEVERAGE_PAGE_SIZE, Math.round(req.pageSize)))
  const sort = req.order === 'desc' ? -1 : 1
  const url =
    `https://${HOST}/api/data/v1/get?reportName=${REPORT}&columns=${COLUMNS}` +
    `&pageSize=${size}&pageNumber=${page}&sortColumns=DIM_DATE&sortTypes=${sort}&source=WEB&client=WEB`
  const res = await withHostBreaker(HOST, () =>
    fetch(url, { headers: { 'user-agent': UA, referer: REFERER }, signal: AbortSignal.timeout(12_000) }),
  )
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${HOST}`)
  const json = (await res.json()) as unknown
  const result = isRecord(json) && isRecord(json.result) ? json.result : null
  const data = result === null || !Array.isArray(result.data) ? [] : result.data
  const pagesRaw = result === null ? null : numOf(result.pages)
  const pages = pagesRaw === null ? 1 : Math.max(1, Math.round(pagesRaw))
  const rows: LeverageRow[] = []
  for (const item of data) {
    const row = toLeverageRow(item)
    if (row !== null) rows.push(row)
  }
  return { rows: rows.sort(byDay), pages }
}

// ── 存储（ReadGuard 读 + updateJsonLocked 锁内读改写） ────────────────────

export interface LeverageReadState {
  file: LeverageFile
  /** 读不到的原因（null = 读到了或本来就没有）。**读不到 ≠ 没有** */
  unreadable: string | null
  /** 内容坏 ⇒ 已隔离的原件路径 */
  quarantined: string | null
}

export interface LeverageSaveResult {
  added: number
  total: number
  dropped: number
}

export class LeverageStore {
  private readonly dir: string
  private readonly readGuard = new ReadGuard()
  private loaded: Promise<void> | null = null
  /** 上次读到/写下时的 mtime（`null` = 还没读到过 ⇒ 下次 `syncFromDisk` 会重读） */
  private mtimeMs: number | null = null
  private state: LeverageReadState = { file: emptyFile(), unreadable: null, quarantined: null }

  constructor(dir: string = dataHome()) {
    this.dir = dir
  }

  path(): string {
    return join(this.dir, LEVERAGE_FILE)
  }

  /** 幂等装载：首装（ENOENT）⇒ 空是真的；其它 errno ⇒ 记封锁并拒绝写回；坏内容 ⇒ 隔离原件 */
  async init(): Promise<void> {
    if (this.loaded !== null) return this.loaded
    this.loaded = this.load()
    return this.loaded
  }

  private async load(): Promise<void> {
    await mkdir(this.dir, { recursive: true }).catch(() => undefined)
    let raw: string
    try {
      raw = await readFile(this.path(), 'utf8')
      this.readGuard.clear(this.path())
    } catch (error) {
      if (isFirstBoot(error)) {
        this.mtimeMs = await this.statMtime()
        return /* 首装：确实还没有这份文件 */
      }
      const reason = this.readGuard.markUnreadable(this.path(), error)
      this.state.unreadable = reason
      log(`leverage read failed: ${reason} —— 读不到 ≠ 没有历史：本次拒绝写回 ${LEVERAGE_FILE}`)
      return
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch (error) {
      const kept = await quarantineFile(this.path())
      this.state.quarantined = kept
      if (kept === null) this.state.unreadable = this.readGuard.markUnreadable(this.path(), error)
      log(`corrupt ${LEVERAGE_FILE} (bad JSON) — ${kept === null ? '隔离失败，改为不写回' : `已隔离为 ${kept}`}`)
      return
    }
    const file = parseLeverageFile(parsed)
    if (file === null) {
      const kept = await quarantineFile(this.path())
      this.state.quarantined = kept
      if (kept === null) this.state.unreadable = this.readGuard.markUnreadable(this.path(), new Error('顶层形状不认识'))
      log(`invalid ${LEVERAGE_FILE} shape — ${kept === null ? '隔离失败，改为不写回' : `已隔离为 ${kept}`}`)
      return
    }
    this.state.file = file
    this.mtimeMs = await this.statMtime()
  }

  private async statMtime(): Promise<number | null> {
    try {
      return (await stat(this.path())).mtimeMs
    } catch {
      return null
    }
  }

  /**
   * 别处（另一个实例/另一个进程）写过这个文件 ⇒ 重新装载。
   *
   * 为什么需要：`dsh web` 里可能有两份路由集各自持一个 store（`index.ts` 的两个注册点），
   * 光靠"内存里的 `lastFetchDay`"会让第二个实例以为今天还没拉过 ⇒ 一天打两次上游。
   * 用 **mtime** 判"变没变"：本地 `stat` 极便宜，变了才读文件（一天一次）。
   */
  async syncFromDisk(): Promise<void> {
    await this.init()
    const mtime = await this.statMtime()
    if (mtime === null) return
    if (this.mtimeMs !== null && mtime === this.mtimeMs) return
    if (this.readGuard.isBlocked(this.path())) return
    await this.load()
  }

  readState(): LeverageReadState {
    return this.state
  }

  get rows(): readonly LeverageRow[] {
    return this.state.file.rows
  }

  get lastFetchDay(): string | null {
    return this.state.file.lastFetchDay
  }

  get lastAttemptAt(): number | null {
    return this.state.file.lastAttemptAt
  }

  get cross(): LeverageCross | null {
    return this.state.file.cross
  }

  /** 最新一行的日期（无数据 ⇒ null） */
  latestDay(): string | null {
    const rows = this.state.file.rows
    return rows.length === 0 ? null : rows[rows.length - 1].d
  }

  /**
   * 锁内读-改-写：磁盘最新 + 本次行 → 按日去重 → 升序 → 裁剪 → 原子写回。
   *
   * `patch` 里没出现的键保持磁盘值（避免"内存快照覆写别人刚写的东西"）。
   * 幂等：同样的行写两次，第二次 `added = 0`，文件字节不变。
   */
  async save(
    rows: readonly LeverageRow[],
    patch: { lastFetchDay?: string | null; lastAttemptAt?: number | null; cross?: LeverageCross | null } = {},
    opts: { maxRows?: number; maxBytes?: number } = {},
  ): Promise<LeverageSaveResult> {
    await this.init()
    this.readGuard.assertWritable(this.path(), '写回杠杆历史')
    const out: { value?: LeverageSaveResult } = {}
    const written = (await updateJsonLocked(
      this.path(),
      (disk) => {
        // 锁内再判一次：读不到过的文件绝不允许拿空库整份覆写（纵深防御）
        this.readGuard.assertWritable(this.path(), '写回杠杆历史')
        const current = disk === null ? emptyFile() : parseLeverageFile(disk)
        if (current === null) {
          throw new Error(`${LEVERAGE_FILE} 内容形状不合法：拒绝在锁内改写它（先修好该文件）`)
        }
        const merged = mergeLeverageRows(current.rows, rows)
        const trimmed = trimLeverageRows(merged.rows, opts.maxRows ?? LEVERAGE_MAX_ROWS, opts.maxBytes ?? LEVERAGE_MAX_BYTES)
        const next: LeverageFile = {
          v: 1,
          lastFetchDay: patch.lastFetchDay === undefined ? current.lastFetchDay : patch.lastFetchDay,
          lastAttemptAt: patch.lastAttemptAt === undefined ? current.lastAttemptAt : patch.lastAttemptAt,
          cross: patch.cross === undefined ? current.cross : patch.cross,
          rows: trimmed.rows,
        }
        out.value = { added: merged.added, total: next.rows.length, dropped: trimmed.dropped }
        return next
      },
      { note: 'leverage:rows' },
    )) as LeverageFile
    this.state.file = written
    this.state.unreadable = null
    this.mtimeMs = null
    const result = out.value
    if (result === undefined) throw new Error('leverage save 未产生结果（锁内回调没有跑完）')
    return result
  }
}

// ── 每日取数门闸（纯函数，便于断言"一天最多一次"） ────────────────────────

export interface LeverageGateState {
  lastFetchDay: string | null
  lastAttemptAt: number | null
  latestDay: string | null
}

/** 上一个"工作日"（只跳过周末；法定假日由"数据本来就没有"兜住，不会误拉爆预算） */
export function previousWeekday(day: string): string {
  let ms = Date.parse(`${day}T12:00:00+08:00`) - 86_400_000
  for (let i = 0; i < 10; i += 1) {
    const wd = weekdayOf(ms)
    if (wd !== 0 && wd !== 6) return dayOf(ms)
    ms -= 86_400_000
  }
  return dayOf(ms)
}

/**
 * 今天还要不要打上游？
 *
 * 默认规则（红线）：`lastFetchDay === today` ⇒ **不再打**。两融是 T+1 数据，一天只更新一次，
 * 每次面板刷新都回源既没信息增量，也会把上游预算烧光（实测面板每次加载本来就要打两融）。
 *
 * 唯一例外：**今天那次拉取发生在披露窗口（09:30）之前**，而现在已过窗口，且库里的最新一日
 * 仍落后于「上一工作日」——说明那次拉早了，只补一次。除此之外**一律不打**。
 */
export function needsDailyFetch(state: LeverageGateState, today: string, now: number): boolean {
  if (state.lastFetchDay !== today) return true
  if (state.lastAttemptAt === null) return false
  const beforeWindow = hhmmOf(state.lastAttemptAt) < LEVERAGE_DISCLOSE_HHMM
  const afterWindow = hhmmOf(now) >= LEVERAGE_DISCLOSE_HHMM
  if (!beforeWindow || !afterWindow) return false
  const expect = previousWeekday(today)
  return state.latestDay !== null && state.latestDay < expect
}

// ── 服务：门闸 + 回填 + 交叉校验 + 回包 ──────────────────────────────────

export interface LeverageDeps {
  /** 取一页（测试注入；生产走 `fetchLeveragePage`） */
  fetchPage?: (req: LeveragePageRequest) => Promise<LeveragePage>
  /** 深交所单市（测试注入；生产走 `marketExtras.marginFromSzse`） */
  fetchSzse?: (day: string) => Promise<MarginReading | null>
  /** 当前时刻（测试注入） */
  now?: () => number
}

export interface LeverageServiceOptions {
  /** 是否允许首次后台回填（测试可关；默认开） */
  backfill?: boolean
  minSamples?: number
}

export class LeverageService {
  private readonly store: LeverageStore
  private readonly deps: LeverageDeps
  private readonly options: LeverageServiceOptions
  private backfilling: Promise<void> | null = null

  constructor(store: LeverageStore = new LeverageStore(), deps: LeverageDeps = {}, options: LeverageServiceOptions = {}) {
    this.store = store
    this.deps = deps
    this.options = options
  }

  get minSamples(): number {
    return this.options.minSamples ?? LEVERAGE_MIN_SAMPLES
  }

  /** 测试/自检用：当前存储实例 */
  get storage(): LeverageStore {
    return this.store
  }

  private now(): number {
    return this.deps.now === undefined ? Date.now() : this.deps.now()
  }

  private page(req: LeveragePageRequest): Promise<LeveragePage> {
    return this.deps.fetchPage === undefined ? fetchLeveragePage(req) : this.deps.fetchPage(req)
  }

  private szse(day: string): Promise<MarginReading | null> {
    return this.deps.fetchSzse === undefined ? marginFromSzse(day) : this.deps.fetchSzse(day)
  }

  /**
   * 回包。**这条路径永不抛**：上游/磁盘出问题时回"全 null 的 200"，
   * 因为契约要求路由永远 200（缺数据是常态，不是 5xx 的理由）。
   */
  async payload(range: LeverageRange = LEVERAGE_DEFAULT_RANGE): Promise<LeveragePayload> {
    try {
      await this.refresh()
    } catch (error) {
      log(`leverage refresh failed: ${error instanceof Error ? error.message : String(error)}`)
    }
    try {
      return buildLeveragePayload(this.store.rows, range, { minSamples: this.minSamples })
    } catch (error) {
      log(`leverage payload failed: ${error instanceof Error ? error.message : String(error)}`)
      return emptyLeveragePayload(range)
    }
  }

  /** 每天最多一次的两融取数（+ 首次历史回填的触发点） */
  private async refresh(): Promise<void> {
    await this.store.syncFromDisk()
    if (this.store.readState().unreadable !== null) return /* 读不到就不写、也不拿旧值冒充新值 */
    const now = this.now()
    const today = dayOf(now)
    const need = needsDailyFetch(
      { lastFetchDay: this.store.lastFetchDay, lastAttemptAt: this.store.lastAttemptAt, latestDay: this.store.latestDay() },
      today,
      now,
    )
    if (!need) return
    const wasEmpty = this.store.rows.length === 0
    let latest: LeverageRow | null = null
    try {
      const page = await this.page({ page: 1, pageSize: 1, order: 'desc' })
      latest = page.rows.length > 0 ? page.rows[page.rows.length - 1] : null
      await this.store.save(latest === null ? [] : [latest], { lastFetchDay: today, lastAttemptAt: now })
    } catch (error) {
      // 失败也记"今天试过了"：两融一天只更新一次，重试的收益低于反复打上游的代价
      await this.store.save([], { lastFetchDay: today, lastAttemptAt: now }).catch(() => undefined)
      log(`leverage daily fetch failed: ${error instanceof Error ? error.message : String(error)}`)
      return
    }
    // 交叉校验（只内部记录；失败只记日志，不影响回包）
    await this.crossCheck(latest)
    // 首次：先回答"当日数值 + temperature: null"，历史回填在后台跑（不阻塞本次响应）
    if (wasEmpty && latest !== null && this.options.backfill !== false) void this.startBackfill()
  }

  /** 深交所单市交叉校验（**不进回包**） */
  private async crossCheck(latest: LeverageRow | null): Promise<void> {
    if (latest === null) return
    let szse: MarginReading | null = null
    try {
      szse = await this.szse(latest.d)
    } catch (error) {
      log(`leverage cross-check failed: ${error instanceof Error ? error.message : String(error)}`)
      return
    }
    if (szse === null) return
    const szseRzye = round2(szse.marginBalance)
    const emRzye = latest.rzye === null ? null : round2(latest.rzye / 1e8)
    const sharePct = szseRzye === null || emRzye === null || emRzye <= 0 ? null : round2((szseRzye / emRzye) * 100)
    const ok =
      szseRzye !== null &&
      emRzye !== null &&
      szseRzye > 0 &&
      szseRzye < emRzye &&
      sharePct !== null &&
      sharePct >= LEVERAGE_SZSE_SHARE_MIN &&
      sharePct <= LEVERAGE_SZSE_SHARE_MAX
    const cross: LeverageCross = {
      d: latest.d,
      szseRzye,
      emRzye,
      sharePct,
      ok,
      note: '深交所=深市单市，东财=沪深北合计 ⇒ 只校验「深市 >0、小于合计、占 30–70%」的量级关系，不做等值比对',
    }
    await this.store.save([], { cross }).catch((error: unknown) => {
      log(`leverage cross save failed: ${error instanceof Error ? error.message : String(error)}`)
    })
  }

  /** 首次历史回填：6 页 × 800 行（一次即可，之后每天 1 行） */
  startBackfill(): Promise<void> {
    if (this.backfilling !== null) return this.backfilling
    if (this.store.rows.length >= this.minSamples) return Promise.resolve()
    this.backfilling = this.runBackfill().finally(() => {
      this.backfilling = null
    })
    return this.backfilling
  }

  private async runBackfill(): Promise<void> {
    try {
      const first = await this.page({ page: 1, pageSize: LEVERAGE_PAGE_SIZE, order: 'asc' })
      await this.store.save(first.rows)
      const pages = Math.max(1, Math.min(LEVERAGE_BACKFILL_PAGES, first.pages))
      for (let p = 2; p <= pages; p += 1) {
        const page = await this.page({ page: p, pageSize: LEVERAGE_PAGE_SIZE, order: 'asc' })
        await this.store.save(page.rows)
      }
      log(`leverage backfilled ${this.store.rows.length} rows (pages=${pages})`)
    } catch (error) {
      log(`leverage backfill failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
}
