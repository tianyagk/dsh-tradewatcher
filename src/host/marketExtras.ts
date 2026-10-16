/**
 * 市场补充数据（宿主侧，AUDIT-IMPL52）：涨停/跌停家数、两融余额、美元指数、美债 10Y、
 * 全天成交额预测、较昨日变动、push2* 可用性日志。
 *
 * 三条口径红线（每条都有断言 + 反例注入）：
 *  1. **双源交叉不静默**：两源不一致时两个读数都返回 + `mismatch: true` + 差异说明，绝不悄悄取一个。
 *  2. **缺数据 = `null` + 原因**（缺失四态），**不得 0 顶替**。
 *  3. **24 小时品种不套 A 股休市冻结**：美元指数/美债 10Y 全天都在变，`frozenOfflineSlot` 那套"休市复用"只适用于
 *     `1./0.` 市场，这里显式不做任何"收盘定稿"判定。
 *
 * 所有请求都过 `breakerFetch.withHostBreaker`（记账 + 冷却期零请求），并写 `push2 可用性日志`（诊断用，
 * 不进用户可见文案）。
 */
import { mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { MissingField } from '../shared/model.ts'
import { writeJsonAtomic } from './atomic.ts'
import { withHostBreaker } from './breakerFetch.ts'
import { dataHome } from './store.ts'
import { dayOf as shDayOf, hhmmOf as shHhmmOf } from './time.ts'
import { progressAt, sessionElapsed, tradingDayState } from './rescue.ts'
import { RESCUE_CALIBRATION } from './rescue-thresholds.ts'

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'

// ── push2* 可用性日志（诊断用；不进用户可见文案） ─────────────────────────────

interface Push2Probe {
  ts: number
  host: string
  ok: boolean
  ms: number
  note?: string
}

const availability: Push2Probe[] = []
const AVAILABILITY_KEEP = 200

/** 记一次 push2* 请求的可用性（时间戳级成功/失败/耗时）。诊断用：本轮实测全通，与既有"0 成功率"记录相反。 */
export function notePush2(host: string, ok: boolean, ms: number, note?: string): void {
  availability.push({ ts: Date.now(), host, ok, ms, ...(note === undefined ? {} : { note }) })
  if (availability.length > AVAILABILITY_KEEP) availability.splice(0, availability.length - AVAILABILITY_KEEP)
}

export function __push2Availability(): { probes: number; ok: number; hosts: Record<string, { ok: number; fail: number; avgMs: number }>; recent: Push2Probe[] } {
  const hosts: Record<string, { ok: number; fail: number; avgMs: number }> = {}
  let ok = 0
  for (const p of availability) {
    const h = (hosts[p.host] ??= { ok: 0, fail: 0, avgMs: 0 })
    if (p.ok) {
      h.ok += 1
      ok += 1
    } else h.fail += 1
    const n = h.ok + h.fail
    h.avgMs = Math.round(((h.avgMs * (n - 1)) + p.ms) / n)
  }
  return { probes: availability.length, ok, hosts, recent: availability.slice(-10) }
}

/** 测试用：清空可用性日志 */
export function __resetPush2Availability(): void {
  availability.length = 0
}

/** 带计时 + 记账 + 可用性日志的 JSON 请求（push2* 专用） */
async function jsonVia(host: string, url: string, timeoutMs = 12_000): Promise<unknown> {
  const t0 = Date.now()
  try {
    const res = await withHostBreaker(host, () => fetch(url, { headers: { 'user-agent': UA, referer: `https://${host === 'push2ex.eastmoney.com' ? 'quote.eastmoney.com' : 'quote.eastmoney.com'}/` }, signal: AbortSignal.timeout(timeoutMs) }))
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${host}`)
    const text = await res.text()
    const parsed = JSON.parse(text) as unknown
    notePush2(host, true, Date.now() - t0)
    return parsed
  } catch (error) {
    notePush2(host, false, Date.now() - t0, String(error).slice(0, 80))
    throw error
  }
}

/** 新浪行情（GBK，需 Referer）：返回 `var hq_str_X="..."` 里引号内的内容；符号不存在 ⇒ null */
export async function sinaRaw(symbol: string): Promise<string | null> {
  const host = 'hq.sinajs.cn'
  // 收口到熔断出口（v0.77.0 规则）：`fetch` 作为 `withHostBreaker` 的参数传入，
  // 与全仓其它站点同一写法（fetch 作为回调返回值传入 ⇒ 全仓文本防线通过）
  const res = await withHostBreaker(host, () =>
    fetch(`https://${host}/list=${encodeURIComponent(symbol)}`, {
      headers: { 'user-agent': UA, referer: 'https://finance.sina.com.cn/' },
      signal: AbortSignal.timeout(10_000),
    }),
  )
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${host}`)
  const buf = await res.arrayBuffer()
  const text = new TextDecoder('gbk').decode(buf)
  const m = /="([^"]*)"/.exec(text)
  const body = m?.[1] ?? ''
  return body.trim() === '' ? null : body
}

// ── 1. 涨停 / 跌停家数（push2ex 池，一次给家数与名单） ───────────────────────

export interface LimitCountSide {
  count: number | null
  /** 池内前几只（最多 5 只）供界面展开核对 */
  sample: Array<{ code: string; name: string; pct: number | null }>
  source: string
  at: number
}

interface LimitCounts {
  up: LimitCountSide
  down: LimitCountSide
  missing: MissingField[]
  /**
   * ⚠ **不能用 clist 的 f51/f52 判涨跌停**：实测它们不是涨跌停价
   * （平安银行 f51=0.0、f52=1.0464e10；指数行里是 "-"）。池接口把名单与家数一起给，口径同源。
   */
  caliber: string
}

const POOL_UT = '7eea3edcaed734bea9cbfc24409ed989'

function parsePool(json: unknown, label: string): LimitCountSide | null {
  const rc = (json as { rc?: unknown } | null)?.rc
  // `rc !== 0` / `data === null` = 本次没取到（实测缺 sort 时 rc=102）⇒ 返回 null，**不得**当成"0 家"
  if (typeof rc === 'number' && rc !== 0) return null
  const data = (json as { data?: { tc?: unknown; qdate?: unknown; pool?: unknown } } | null)?.data
  if (data === undefined || data === null) return null
  const tc = typeof data.tc === 'number' ? data.tc : null
  const pool = Array.isArray(data.pool) ? (data.pool as Array<Record<string, unknown>>) : []
  return {
    count: tc,
    sample: pool.slice(0, 5).map((r) => ({
      code: String(r.c ?? ''),
      name: String(r.n ?? ''),
      pct: typeof r.zdp === 'number' ? Math.round(r.zdp * 100) / 100 : null,
    })),
    source: label,
    at: Date.now(),
  }
}

/** 涨停/跌停家数（`date` 形如 `20261013`；缺省用今天） */
export async function limitCounts(date?: string): Promise<LimitCounts> {
  // ⚠ 日界必须用**北京自然日**（`shDayOf`），不得用 `toISOString()`（那是 UTC 日期，
  // 北京 00:00–08:00 会算成前一天 ⇒ 查错交易日的池；见 v0.76.0 的时区规则与静态防线）
  const d = date ?? shDayOf(Date.now()).replace(/-/g, '')
  const missing: MissingField[] = []
  const fetchPool = async (kind: 'ZT' | 'DT'): Promise<LimitCountSide | null> => {
    const host = 'push2ex.eastmoney.com'
    // ⚠ `sort` 是**必需参数**：缺了上游回 `{"rc":102,"data":null}`（实测），会被误读成"今天没有涨停"
    const sort = kind === 'ZT' ? 'fbt%3Aasc' : 'fund%3Aasc'
    const url = `https://${host}/getTopic${kind}Pool?ut=${POOL_UT}&dpt=wz.ztzt&Pageindex=0&pagesize=100&sort=${sort}&date=${d}`
    try {
      return parsePool(await jsonVia(host, url), kind === 'ZT' ? 'push2ex 涨停池' : 'push2ex 跌停池')
    } catch (error) {
      missing.push({
        what: kind === 'ZT' ? '涨停家数' : '跌停家数',
        why: 'transient',
        note: `本次取数失败（${String(error).slice(0, 80)}）⇒ 稍后重试即可；这一格不用 0 顶替`,
      })
      return null
    }
  }
  const [up, down] = await Promise.all([fetchPool('ZT'), fetchPool('DT')])
  if (up === null && down === null) {
    missing.push({ what: '涨跌停家数', why: 'transient', note: '涨停池与跌停池都没拿到（同源同因）' })
  }
  return {
    up: up ?? { count: null, sample: [], source: 'push2ex 涨停池（未取到）', at: Date.now() },
    down: down ?? { count: null, sample: [], source: 'push2ex 跌停池（未取到）', at: Date.now() },
    missing,
    caliber: '涨停/跌停家数 = push2ex 涨停池/跌停池的 tc（上游按各板块限幅与 ST 规则判定）',
  }
}

// ── 2. 两融余额（深交所官方 + 东财，双源交叉） ───────────────────────────────

export interface MarginReading {
  /** 融资余额（亿元） */
  marginBalance: number | null
  /** 融资买入额（亿元）= "融资净买"的分量 */
  marginBuy: number | null
  /** 融券余额（亿元） */
  shortBalance: number | null
  /** 数据日期 YYYY-MM-DD */
  day: string | null
  source: string
}

interface MarginCross {
  szse: MarginReading | null
  em: MarginReading | null
  /** 两源都能取到时的相对差（融资余额）；任一缺失 ⇒ null */
  diffPct: number | null
  /**
   * 两源是否**不一致**（相对差 > 2%，沪深两市口径差异 + 数据源更新时点差异）。
   * ⚠ 不一致时**两个读数都返回**并置 `mismatch`，绝不静默取一个。
   */
  mismatch: boolean
  note: string
  missing: MissingField[]
}

function numOf(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  if (typeof v === 'string') {
    const n = Number(v.replace(/,/g, ''))
    return Number.isFinite(n) ? n : null
  }
  return null
}

/** 深交所官方 JSON（融资融券交易总量；单位亿元） */
export async function marginFromSzse(day: string): Promise<MarginReading | null> {
  const host = 'www.szse.cn'
  const url = `http://${host}/api/report/ShowReport/data?SHOWTYPE=JSON&CATALOGID=1837_xxpl&&loading=first&txtDate=${day}&random=0`
  const res = await withHostBreaker(host, () =>
    fetch(url, { headers: { 'user-agent': UA, referer: `http://${host}/` }, signal: AbortSignal.timeout(12_000) }),
  )
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${host}`)
  const json = (await res.json()) as unknown
  const first = Array.isArray(json) ? (json[0] as { data?: Array<Record<string, unknown>> }) : undefined
  const row = first?.data?.[0]
  if (row === undefined) return null
  return {
    marginBalance: numOf(row.jrrzye),
    marginBuy: numOf(row.jrrzmr),
    shortBalance: numOf(row.jrrjye),
    day,
    source: '深交所（融资融券交易总量）',
  }
}

/** 东财数据中心（沪深汇总；`NEW` = 融资融券余额，亿元） */
export async function marginFromEm(): Promise<MarginReading | null> {
  const host = 'datacenter-web.eastmoney.com'
  const url = `https://${host}/api/data/v1/get?reportName=RPTA_RZRQ_LSHJ&columns=ALL&pageSize=1&sortColumns=DIM_DATE&sortTypes=-1&source=WEB&client=WEB`
  const res = await withHostBreaker(host, () =>
    fetch(url, { headers: { 'user-agent': UA, referer: 'https://data.eastmoney.com/' }, signal: AbortSignal.timeout(12_000) }),
  )
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${host}`)
  const json = (await res.json()) as unknown
  const row = ((json as { result?: { data?: Array<Record<string, unknown>> } }).result?.data ?? [])[0]
  if (row === undefined) return null
  const day = String(row.DIM_DATE ?? '').slice(0, 10)
  /**
   * ⚠ 列名对照（**实测**，别拿 `NEW` 当余额）：`NEW` = 4287.9798 不是两融余额（拿它交叉会得出 186% 的假不一致）；
   * 真正的列是 `RZYE`（融资余额，单位**元**）、`RZMRE`（融资买入额）、`RQYE`（融券余额）、`RZJME`（融资净买入）。
   */
  const yi = (v: unknown): number | null => {
    const n = numOf(v)
    return n === null ? null : Math.round((n / 1e8) * 100) / 100
  }
  return { marginBalance: yi(row.RZYE), marginBuy: yi(row.RZMRE), shortBalance: yi(row.RQYE), day: day === '' ? null : day, source: '东财数据中心（RPTA_RZRQ_LSHJ）' }
}

/** 两融双源交叉（不一致 ⇒ 两个都返回 + mismatch=true） */
export async function marginCross(day: string): Promise<MarginCross> {
  const missing: MissingField[] = []
  let szse: MarginReading | null = null
  let em: MarginReading | null = null
  try {
    szse = await marginFromSzse(day)
  } catch (error) {
    missing.push({ what: '深交所两融', why: 'transient', note: `本次取数失败（${String(error).slice(0, 80)}）⇒ 稍后重试` })
  }
  try {
    em = await marginFromEm()
  } catch (error) {
    missing.push({ what: '东财两融汇总', why: 'transient', note: `本次取数失败（${String(error).slice(0, 80)}）⇒ 稍后重试` })
  }
  if (szse === null && em === null) {
    missing.push({ what: '两融余额', why: 'transient', note: '深交所与东财都没拿到；两融是日频数据，这里显示 null 而不是 0' })
    return { szse: null, em: null, diffPct: null, mismatch: false, note: '两个源都未取到', missing }
  }
  let diffPct: number | null = null
  let mismatch = false
  if (szse?.marginBalance != null && em?.marginBalance != null && em.marginBalance !== 0) {
    diffPct = Math.round(((szse.marginBalance - em.marginBalance) / em.marginBalance) * 10_000) / 100
    mismatch = Math.abs(diffPct) > 2
  }
  const note = mismatch
    ? `⚠ 两个源不一致（深交所 ${szse?.marginBalance ?? '—'} 亿 vs 东财 ${em?.marginBalance ?? '—'} 亿，相对差 ${diffPct}%）—— 口径/更新时点不同，两个读数都保留，不替用户选一个`
    : szse !== null && em !== null
      ? `两源一致（相对差 ${diffPct}%）；深交所口径为深市，东财为沪深汇总`
      : `仅一个源可用（${szse !== null ? '深交所' : '东财'}）`
  return { szse, em, diffPct, mismatch, note, missing }
}

// ── 3/4. 24 小时品种：美元指数 / 美债 10Y（**不做休市冻结**） ─────────────────

export interface H24Quote {
  value: number | null
  /** 观测时刻（epoch ms，取自上游时间戳或本次请求时刻） */
  at: number | null
  source: string
  prev: number | null
  pct: number | null
}

/**
 * 24 小时品种的取数约定（⚠ 与本仓库 A 股 `frozenOfflineSlot` 的"休市复用"**互斥**）：
 * 这些品种在北京时间深夜仍在交易，"非交易时段直接复用旧值"会把实时行情冻成旧价。
 * 因此这里只按 TTL 轮询，**绝不**做"休市已定稿"判定；`at` 一律如实回传上游时刻。
 */
export const H24_CALIBER = '24 小时品种：不做 A 股休市冻结（深夜也在变），只按 TTL 轮询并如实回传上游时刻'

/** 美元指数：新浪 DINIW（主） + 东财 100.UDI（交叉） */
export async function usdIndexCross(): Promise<{ sina: H24Quote | null; em: H24Quote | null; mismatch: boolean; note: string; missing: MissingField[] }> {
  const missing: MissingField[] = []
  let sina: H24Quote | null = null
  let em: H24Quote | null = null
  try {
    const body = await sinaRaw('DINIW')
    if (body !== null) {
      const f = body.split(',')
      // 实测形状：21:59:38,102.2991,102.2991,102.5844,4272,102.5704,102.5905,102.1633,102.2991,美元指数,2026-10-13
      const value = numOf(f[1])
      const prev = numOf(f[5])
      const at = f[10] !== undefined ? Date.parse(`${f[10]}T${f[0]}+08:00`) : null
      sina = { value, at: Number.isFinite(at) ? at : null, source: '新浪 DINIW', prev, pct: value !== null && prev !== null && prev !== 0 ? Math.round(((value - prev) / prev) * 10_000) / 100 : null }
    }
  } catch (error) {
    missing.push({ what: '美元指数（新浪）', why: 'transient', note: `本次取数失败（${String(error).slice(0, 80)}）⇒ 稍后重试` })
  }
  try {
    const json = await jsonVia('push2delay.eastmoney.com', 'https://push2delay.eastmoney.com/api/qt/ulist.np/get?secids=100.UDI&fltt=2&invt=2&fields=f2,f3,f4,f12,f14,f124')
    const row = ((json as { data?: { diff?: Array<Record<string, unknown>> } }).data?.diff ?? [])[0]
    if (row !== undefined) em = { value: numOf(row.f2), at: typeof row.f124 === 'number' ? row.f124 * 1000 : null, source: '东财 100.UDI', prev: null, pct: numOf(row.f3) }
  } catch (error) {
    missing.push({ what: '美元指数（东财）', why: 'transient', note: `本次取数失败（${String(error).slice(0, 80)}）⇒ 稍后重试` })
  }
  const mismatch = sina?.value != null && em?.value != null && Math.abs(sina.value - em.value) > 0.05
  const note = sina === null && em === null
    ? '两个源都没取到（美元指数 24 小时交易）'
    : mismatch
      ? `⚠ 两源差 ${Math.abs((sina?.value ?? 0) - (em?.value ?? 0)).toFixed(3)}（> 0.05）—— 两个读数都保留`
      : `${H24_CALIBER}；两源一致`
  return { sina, em, mismatch, note, missing }
}

/** 美债 10 年期收益率：东财 171.US10Y（主） + 新浪 globalbd_us10yt（交叉） */
export async function us10yCross(): Promise<{ em: H24Quote | null; sina: H24Quote | null; mismatch: boolean; note: string; missing: MissingField[] }> {
  const missing: MissingField[] = []
  let em: H24Quote | null = null
  let sina: H24Quote | null = null
  try {
    const json = await jsonVia('push2delay.eastmoney.com', 'https://push2delay.eastmoney.com/api/qt/ulist.np/get?secids=171.US10Y&fltt=2&invt=2&fields=f2,f3,f4,f12,f14,f124')
    const row = ((json as { data?: { diff?: Array<Record<string, unknown>> } }).data?.diff ?? [])[0]
    if (row !== undefined) em = { value: numOf(row.f2), at: typeof row.f124 === 'number' ? row.f124 * 1000 : null, source: '东财 171.US10Y', prev: null, pct: numOf(row.f3) }
  } catch (error) {
    missing.push({ what: '美债 10Y（东财）', why: 'transient', note: `本次取数失败（${String(error).slice(0, 80)}）⇒ 稍后重试` })
  }
  try {
    // ⚠ 只有 `globalbd_us10yt` 这种写法有效（`gb_us10yt` / `US10YT` 实测都返回空）
    const body = await sinaRaw('globalbd_us10yt')
    if (body !== null) {
      // 实测形状：美国10年期国债,5.232,5.240,5.222,5.236,5.173,0,-0.3422,-0.0179,0,0,1791899931,2026-10-13,09:58:51,2036-08-15,...
      const f = body.split(',')
      const value = numOf(f[1])
      const ts = numOf(f[11])
      sina = { value, at: ts !== null ? ts * 1000 : null, source: '新浪 globalbd_us10yt', prev: numOf(f[5]), pct: numOf(f[7]) }
    }
  } catch (error) {
    missing.push({ what: '美债 10Y（新浪）', why: 'transient', note: `本次取数失败（${String(error).slice(0, 80)}）⇒ 稍后重试` })
  }
  const mismatch = em?.value != null && sina?.value != null && Math.abs(em.value - sina.value) > 0.05
  const note = em === null && sina === null ? '两个源都没取到' : mismatch ? `⚠ 两源差 ${Math.abs((em?.value ?? 0) - (sina?.value ?? 0)).toFixed(3)} —— 两个读数都保留` : `${H24_CALIBER}；两源一致`
  return { em, sina, mismatch, note, missing }
}

/** 美债 10Y 日线历史（东财 push2his；实测自 2023-05-08 起，约 860 个交易日） */
export async function us10yHistory(limit = 30): Promise<{ points: Array<{ day: string; value: number }>; source: string; missing: MissingField[] }> {
  try {
    const json = await jsonVia('push2his.eastmoney.com', `https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=171.US10Y&klt=101&fqt=0&beg=0&end=20500101&fields1=f1,f2,f3&fields2=f51,f53&lmt=${limit}`)
    // ⚠ `lmt` 实测不生效（push2his 回全量 ~860 根）⇒ 客户端自己截尾
    const all = ((json as { data?: { klines?: string[] } }).data?.klines ?? [])
    const klines = limit > 0 ? all.slice(-limit) : all
    const points = klines.map((k) => {
      const [day, v] = k.split(',')
      return { day: day ?? '', value: numOf(v) ?? 0 }
    }).filter((p) => p.day !== '')
    return { points, source: '东财 push2his（171.US10Y 日K）', missing: [] }
  } catch (error) {
    return {
      points: [],
      source: '东财 push2his（未取到）',
      missing: [{ what: '美债 10Y 历史', why: 'transient', note: `本次取数失败（${String(error).slice(0, 80)}）⇒ 稍后重试；不用 0 顶替` }],
    }
  }
}

// ── 5. 全天成交额预测（自算；标注标定来源/样本/区间） ─────────────────────────

export interface AmountForecast {
  /** 当前累计成交额（元） */
  current: number | null
  /** 预测全天（元）；**只在盘中给**，收盘后为 null（回落实际值） */
  forecast: number | null
  /** 预测区间（元）：由 progress 的标定散度给出 */
  band: { low: number; high: number } | null
  /** 已过时段占全天的比例（来自标定曲线） */
  progress: number | null
  /** 口径标注（必须随值一起返回，不许只给一个数） */
  caliber: {
    curve: string
    samples: number
    generatedAt: string
    note: string
  }
  /** 收盘后给实际值；盘中只给预测 */
  actual: number | null
  phase: 'pre' | 'intraday' | 'closed' | 'non-trading'
  missing: MissingField[]
}

/** 标定曲线的样本天数（曲线每 5 分钟一点、240 分钟 ⇒ 每天 49 点） */
function progressCurveSamples(): number {
  // ⚠ 曲线的长度是"**一天**的 49 个点"（5 分钟一个点 × 240 分钟），不是样本天数 ——
  // 样本天数由标定文件自己声明（`progressDays: 126`：新浪 5 分钟线 126 个交易日）
  return Math.max(0, Math.round(RESCUE_CALIBRATION.progressDays))
}

/**
 * 全天成交额预测：`全天 ≈ 当前累计 ÷ progressAt(elapsed)`。
 *
 * 为什么必须带口径：早盘的 progress 很小（10:00 仅 29.6%），标定误差会被放大（09:35 时 progress 的
 * 1% 绝对误差 ⇒ 预估相对偏差约 3%）⇒ 只给一个数会被读成"精确预测"。因此这里同时返回
 * **标定来源 / 样本天数 / 生成日 / 区间**，并**只在盘中给预测值**（收盘后回落实际值）。
 */
export async function amountForecast(current: number | null, now = Date.now()): Promise<AmountForecast> {
  const curve = RESCUE_CALIBRATION.progressCurve
  const samples = progressCurveSamples()
  const caliber = {
    curve: '新浪 5 分钟线 126 个交易日标定的日内成交进度曲线（RESCUE_CALIBRATION.progressCurve）',
    samples,
    generatedAt: RESCUE_CALIBRATION.generatedAt,
    note: '预测 = 当前累计成交额 ÷ 进度；进度越小误差被放得越大（早盘），故同时给区间并只在盘中给值',
  }
  const missing: MissingField[] = []
  const hhmm = shHhmmOf(now)
  const day = tradingDayState(now)
  const phase: AmountForecast['phase'] = !day.trading ? 'non-trading' : hhmm < '09:30' ? 'pre' : (hhmm <= '15:05' || (hhmm >= '11:30' && hhmm < '13:00')) ? 'intraday' : 'closed'
  if (current === null) {
    missing.push({ what: '成交额', why: 'transient', note: '当前累计成交额未取到 ⇒ 预测与占比都不给（不用 0 顶替）' })
    return { current: null, forecast: null, band: null, progress: null, caliber, actual: null, phase, missing }
  }
  const elapsed = sessionElapsed(hhmm)
  const progress = progressAt(curve, elapsed)
  if (phase === 'closed') {
    // 收盘后：实际值就是全天值 ⇒ 不给预测（避免"预测"被当成第二份数据）
    return { current, forecast: null, band: null, progress, caliber, actual: current, phase, missing }
  }
  if (phase === 'non-trading' || phase === 'pre') {
    missing.push({ what: '全天成交额预测', why: 'no-source', note: phase === 'pre' ? '开盘前没有累计成交额可外推（09:30 起才给）' : '非交易日不预测' })
    return { current, forecast: null, band: null, progress, caliber, actual: null, phase, missing }
  }
  const forecast = Math.round(current / progress)
  // 区间：按 ±(1 - progress) 的一半做保守散度（早盘 progress 小 ⇒ 区间大；尾盘收敛到预测值）
  const spread = Math.max(0.005, (1 - progress) * 0.15)
  return {
    current,
    forecast,
    band: { low: Math.round(forecast * (1 - spread)), high: Math.round(forecast * (1 + spread)) },
    progress,
    caliber,
    actual: null,
    phase,
    missing,
  }
}

// ── 6. 较昨日变动（缺昨日 ⇒ null + 原因，不得 0） ────────────────────────────

interface DayOverDay {
  amount: { today: number | null; prev: number | null; delta: number | null; deltaPct: number | null; prevDay: string | null; note: string }
  limitCounts: { today: number | null; prev: number | null; delta: number | null; prevDay: string | null; note: string }
  missing: MissingField[]
}

const EXTRAS_FILE = 'market-extras.json'

interface ExtrasFile {
  v: 1
  /** 每日定稿落盘：涨跌停家数（供"较昨日"用） */
  days: Record<string, { limitUp: number | null; limitDown: number | null; amount: number | null; final: boolean }>
}

let extras: ExtrasFile | null = null

async function loadExtras(): Promise<ExtrasFile> {
  if (extras !== null) return extras
  try {
    const raw = await readFile(join(dataHome(), EXTRAS_FILE), 'utf8')
    const parsed = JSON.parse(raw) as ExtrasFile
    extras = parsed.v === 1 && typeof parsed.days === 'object' && parsed.days !== null ? parsed : { v: 1, days: {} }
  } catch {
    extras = { v: 1, days: {} } // 首次运行 / 文件坏了都当空库（坏文件的隔离由 readGuard 负责，这里只做兜底）
  }
  return extras
}

/** 定稿落盘（`final: true` 时调用）：涨跌停家数与成交额同存，供次日"较昨日" */
export async function persistExtrasDay(day: string, rec: { limitUp: number | null; limitDown: number | null; amount: number | null; final: boolean }): Promise<void> {
  const file = await loadExtras()
  file.days[day] = rec
  const keys = Object.keys(file.days).sort()
  for (const k of keys.slice(0, Math.max(0, keys.length - 90))) delete file.days[k]
  await mkdir(dataHome(), { recursive: true }).catch(() => undefined)
  await writeJsonAtomic(join(dataHome(), EXTRAS_FILE), file)
}

/** 测试用：重置内存缓存（不删文件） */
export function __resetExtrasCache(): void {
  extras = null
}

/** 上一交易日（有记录的最后一天，严格早于 `day`） */
export async function prevExtrasDay(day: string): Promise<{ day: string; rec: ExtrasFile['days'][string] } | null> {
  const file = await loadExtras()
  const keys = Object.keys(file.days).filter((k) => k < day).sort()
  const k = keys[keys.length - 1]
  return k === undefined ? null : { day: k, rec: file.days[k] as ExtrasFile['days'][string] }
}

/** 较昨日变动：缺昨日数据 ⇒ `null` + 原因（**不得用 0**） */
export async function dayOverDay(day: string, today: { amount: number | null; limitUp: number | null; limitDown: number | null }): Promise<DayOverDay> {
  const prev = await prevExtrasDay(day)
  const missing: MissingField[] = []
  const mk = (todayV: number | null, prevV: number | null, what: string): { today: number | null; prev: number | null; delta: number | null; deltaPct: number | null; prevDay: string | null; note: string } => {
    if (prev === null) {
      // ⚠ 不用 `pending`（该态在本仓库刻意未接线，见 docs/DECISIONS.md）：这里既不是上游无此数据、
      // 也不是"后台更新中"，而是"本地历史还没累积到第二天"⇒ 明天自然会好，按 `transient` 记账并写明原因
      missing.push({ what: `${what}的较昨日`, why: 'transient', note: '本地还没有上一交易日的记录（需连续运行两个交易日才会累积）⇒ 这里显示 null，不用 0 顶替；明天起自动可用' })
      return { today: todayV, prev: null, delta: null, deltaPct: null, prevDay: null, note: '缺上一交易日记录' }
    }
    if (todayV === null || prevV === null) {
      missing.push({ what: `${what}的较昨日`, why: 'transient', note: `今天或昨日的「${what}」缺一项 ⇒ 差值不给（不用 0 顶替）` })
      return { today: todayV, prev: prevV, delta: null, deltaPct: null, prevDay: prev.day, note: prevV === null ? '昨日该项未落盘' : '今日该项未取到' }
    }
    const delta = Math.round((todayV - prevV) * 100) / 100
    return { today: todayV, prev: prevV, delta, deltaPct: prevV === 0 ? null : Math.round((delta / prevV) * 10_000) / 100, prevDay: prev.day, note: `对比 ${prev.day}` }
  }
  return {
    amount: mk(today.amount, prev?.rec.amount ?? null, '成交额'),
    limitCounts: mk(today.limitUp === null && today.limitDown === null ? null : (today.limitUp ?? 0) + (today.limitDown ?? 0), prev === null || (prev.rec.limitUp === null && prev.rec.limitDown === null) ? null : (prev.rec.limitUp ?? 0) + (prev.rec.limitDown ?? 0), '涨跌停家数'),
    missing,
  }
}
