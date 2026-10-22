/**
 * 【竞价参考价曲线】的宿主侧：竞价时段采样 + 落盘 + 读取。
 *
 * 窗口：交易日 **09:15:00–09:25:30**（Asia/Shanghai），每 10 秒一拍。
 * 交易日判定：用**行情源时间 `f30`**（不猜节假日）——`f30` 的日期必须等于本地今天。
 * 采样值：`ref = f9`（买一价，实测 `f9 === f19`）、`matched = f10`（买一量，手）；
 * **`f9 !== f19` 的这一拍不记录**（说明已进入连续竞价）。
 *
 * 落盘：`<DSH_HOME>/dsh-tradewatcher/auction/<secid>.json`，根结构 `{day, points[]}`（今天），
 * `history` 保留最近 4 个交易日（合计 5 日）；单日 ≤120 点（超限丢最旧）。写走
 * `updateJsonLocked`（锁内读-改-写），读失败走 `ReadGuard`（读不到 ≠ 空数据，不覆写）；
 * 坏文件先 `quarantineFile` 隔离，再重建。
 *
 * 不新增路由：曲线随既有 `/tradewatcher/detail` 的 `StockDetail.auction.series` 下发。
 */
import { mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { AuctionPoint } from '../shared/model.ts'
import { dataHome } from './store.ts'
import { updateJsonLocked, readJsonForUpdate } from './lock.ts'
import { ReadGuard, quarantineFile } from './readGuard.ts'
import { dayOf, parseMarketStamp } from './time.ts'
import { parseTencentStamp, tencentQuoteCode, tencentQuoteText } from './tencent.ts'

/** `f30`（`YYYYMMDDHHMMSS`）→ epoch ms；**显式按北京墙上时间**解析（宿主 TZ=UTC 时也不漂） */
function auctionStamp(text: string | undefined): number | null {
  const t = (text ?? '').trim()
  if (/^\d{14}$/.test(t)) {
    const parsed = parseMarketStamp(`${t.slice(0, 4)}-${t.slice(4, 6)}-${t.slice(6, 8)} ${t.slice(8, 10)}:${t.slice(10, 12)}:${t.slice(12, 14)}`)
    return Number.isFinite(parsed) ? parsed : null
  }
  // 港股是 `2026/10/22 09:20:00`；本采样只覆盖沪深，这里只作兜底
  return parseTencentStamp(text)
}

/* ────────────────────────────── 窗口 ────────────────────────────── */

/** 竞价采样窗口：09:15:00 ≤ t ≤ 09:25:30（Asia/Shanghai，按秒判；含两端） */
export function inAuctionWindow(ts: number): boolean {
  if (!Number.isFinite(ts)) return false
  const day = dayOf(ts)
  const start = parseMarketStamp(`${day} 09:15:00`)
  const end = parseMarketStamp(`${day} 09:25:30`)
  if (!Number.isFinite(start) || !Number.isFinite(end)) return false
  return ts >= start && ts <= end
}

/* ────────────────────────────── 行情字段 ────────────────────────────── */

export interface AuctionQuoteRow {
  secid: string
  /** f9 买一价 */
  bid1: number | null
  /** f10 买一量（手） */
  bid1Vol: number | null
  /** f19 卖一价 */
  ask1: number | null
  /** f20 卖一量（手） */
  ask1Vol: number | null
  /** f30 行情源时间（epoch ms） */
  stamp: number | null
}

const num = (v: string | undefined): number | null => {
  if (v === undefined) return null
  const n = Number(v.trim())
  return Number.isFinite(n) ? n : null
}

/** 解析腾讯 `qt.gtimg.cn` 原始文本（只取竞价需要的 5 个字段） */
export function parseAuctionQuoteText(text: string, keyOf: (code: string) => string | undefined): AuctionQuoteRow[] {
  const out: AuctionQuoteRow[] = []
  for (const line of text.split(';')) {
    const eq = line.indexOf('=')
    if (eq < 0) continue
    const code = line.slice(0, eq).trim().replace(/^v_/, '')
    const secid = keyOf(code)
    if (secid === undefined) continue
    const raw = line.slice(eq + 1).trim().replace(/^"/, '').replace(/"$/, '')
    const f = raw.split('~')
    out.push({
      secid,
      bid1: num(f[9]),
      bid1Vol: num(f[10]),
      ask1: num(f[19]),
      ask1Vol: num(f[20]),
      stamp: auctionStamp(f[30]),
    })
  }
  return out
}

/** 取竞价行情（复用腾讯行情链；不新增源） */
export async function fetchAuctionQuotes(secids: string[]): Promise<AuctionQuoteRow[]> {
  const map = new Map<string, string>()
  for (const secid of secids) {
    const code = tencentQuoteCode(secid)
    if (code !== null) map.set(code, secid)
  }
  if (map.size === 0) return []
  const text = await tencentQuoteText([...map.keys()])
  return parseAuctionQuoteText(text, (code) => map.get(code))
}

/**
 * 单只标的的一拍 → 采样点（不满足就返回 null）：
 *   · 源时间在窗口内、且源时间日期 = 本地今天（交易日）
 *   · `f9 === f19` 且都 > 0（否则已进入连续竞价）
 *   · `f10 > 0`
 */
export function auctionPointOf(row: AuctionQuoteRow, now: number): AuctionPoint | null {
  const t = row.stamp
  if (t === null || !Number.isFinite(t)) return null
  if (!inAuctionWindow(t)) return null
  if (dayOf(t) !== dayOf(now)) return null
  if (row.bid1 === null || row.ask1 === null || row.bid1 <= 0 || row.ask1 <= 0) return null
  if (row.bid1 !== row.ask1) return null
  if (row.bid1Vol === null || row.bid1Vol <= 0) return null
  return { t, ref: row.bid1, matched: row.bid1Vol }
}

/* ────────────────────────────── 标的范围 ────────────────────────────── */

export interface AuctionUniverseSource {
  watchData(): { items: ReadonlyArray<{ secid: string }> }
  portData(): { items: ReadonlyArray<{ secid: string }> }
}

/** 自选 ∪ 持仓（自选顺序优先，去重），上限 60（截断数留痕） */
export function universeOf(source: AuctionUniverseSource, max = 60): { secids: string[]; truncated: number } {
  const seen = new Set<string>()
  const all: string[] = []
  for (const it of [...source.watchData().items, ...source.portData().items]) {
    const secid = typeof it?.secid === 'string' ? it.secid.trim() : ''
    if (secid === '' || seen.has(secid)) continue
    seen.add(secid)
    all.push(secid)
  }
  return { secids: all.slice(0, max), truncated: Math.max(0, all.length - max) }
}

/* ────────────────────────────── 落盘 ────────────────────────────── */

export const AUCTION_MAX_POINTS = 120
export const AUCTION_KEEP_DAYS = 5

export interface AuctionDayRecord {
  day: string
  points: AuctionPoint[]
}

/** 文件根：`{day, points[]}` 是**今天**，`history` 是最近 4 个交易日 */
export interface AuctionFile extends AuctionDayRecord {
  history: AuctionDayRecord[]
}

const isPoint = (p: unknown): p is AuctionPoint => {
  if (p === null || typeof p !== 'object') return false
  const o = p as Record<string, unknown>
  return typeof o['t'] === 'number' && Number.isFinite(o['t']) && typeof o['ref'] === 'number' && Number.isFinite(o['ref']) &&
    o['ref'] > 0 && typeof o['matched'] === 'number' && Number.isFinite(o['matched']) && o['matched'] > 0
}

const normPoints = (raw: unknown): AuctionPoint[] =>
  Array.isArray(raw) ? raw.filter(isPoint).slice().sort((a, b) => a.t - b.t) : []

const normRecord = (raw: unknown): AuctionDayRecord | null => {
  if (raw === null || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  if (typeof o['day'] !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(o['day'])) return null
  const points = normPoints(o['points'])
  return points.length === 0 ? null : { day: o['day'], points }
}

/**
 * 合并一拍（纯函数，锁内调用）：
 *   · 同一天 ⇒ 追加（按 `t` 去重）、按时间排序、超 120 丢最旧；
 *   · 新的一天 ⇒ 把旧的 `{day, points}` 推进 `history`，合计只留 5 日（今天 + 4）；
 *   · 旧的日期才来的点 ⇒ 若 history 里有那一天就补进去，否则忽略。
 */
export function mergeAuctionFile(disk: unknown, day: string, point: AuctionPoint): AuctionFile {
  if (!isPoint(point)) throw new Error('竞价点不合法（t/ref/matched 必须为正的有限数）')
  const root = disk !== null && typeof disk === 'object' ? (disk as Record<string, unknown>) : {}
  const today = normRecord({ day: root['day'], points: root['points'] })
  const history = Array.isArray(root['history'])
    ? root['history'].map(normRecord).filter((r): r is AuctionDayRecord => r !== null)
    : []
  if (today === null) return { day, points: [point], history: [] }

  let nextToday: AuctionDayRecord
  let nextHistory = history
  if (today.day === day) {
    nextToday = { day, points: [...today.points, point] }
  } else if (today.day < day) {
    nextToday = { day, points: [point] }
    nextHistory = [today, ...history]
  } else {
    // 旧日期的迟到点：只补进已有的历史日，不改变"今天"
    const idx = history.findIndex((r) => r.day === day)
    if (idx < 0) return { day: today.day, points: today.points, history }
    const rec = history[idx] as AuctionDayRecord
    nextHistory = history.map((r, i) => (i === idx ? { day, points: [...rec.points, point] } : r))
    nextToday = today
  }

  const dedupe = (points: AuctionPoint[]): AuctionPoint[] => {
    const map = new Map<number, AuctionPoint>()
    for (const p of points) map.set(p.t, p)
    return [...map.values()].sort((a, b) => a.t - b.t).slice(-AUCTION_MAX_POINTS)
  }
  const trimmedHistory = nextHistory
    .map((r) => ({ day: r.day, points: dedupe(r.points) }))
    .filter((r) => r.points.length > 0 && r.day !== nextToday.day)
    .sort((a, b) => (a.day < b.day ? 1 : -1))
    .slice(0, AUCTION_KEEP_DAYS - 1)
  return { day: nextToday.day, points: dedupe(nextToday.points), history: trimmedHistory }
}

export class AuctionStore {
  private readonly dir: string
  private readonly guard = new ReadGuard()

  constructor(dir = join(dataHome(), 'auction')) {
    this.dir = dir
  }

  private pathOf(secid: string): string {
    return join(this.dir, `${secid.replace(/[^0-9A-Za-z._-]/g, '_')}.json`)
  }

  /** 写一拍（坏文件先隔离；读不到记录进 ReadGuard 并跳过，不覆写） */
  async addPoint(secid: string, day: string, point: AuctionPoint): Promise<void> {
    const file = this.pathOf(secid)
    await mkdir(this.dir, { recursive: true })
    if (await this.isCorrupt(file)) {
      await quarantineFile(file)
    }
    try {
      await updateJsonLocked(file, (disk) => mergeAuctionFile(disk, day, point))
      this.guard.clear(file)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        const reason = this.guard.markUnreadable(file, error)
        console.warn(`[tradewatcher] 竞价序列写入跳过（${file}）：${reason}`)
      }
    }
  }

  /** 读某天的点（没有/坏文件 ⇒ null ⇒ 界面显示 `—`） */
  async seriesOf(secid: string, day: string): Promise<AuctionDayRecord | null> {
    const file = this.pathOf(secid)
    try {
      const disk = await readJsonForUpdate(file, 'null')
      this.guard.clear(file)
      const root = disk !== null && typeof disk === 'object' ? (disk as Record<string, unknown>) : null
      if (root === null) return null
      if (root['day'] === day) {
        const points = normPoints(root['points'])
        return points.length > 0 ? { day, points } : null
      }
      const hist = Array.isArray(root['history'])
        ? root['history'].map(normRecord).filter((r): r is AuctionDayRecord => r !== null)
        : []
      return hist.find((r) => r.day === day) ?? null
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') this.guard.markUnreadable(file, error)
      return null
    }
  }

  /** 读文件里"今天"的日（用于诊断/测试） */
  async daysOf(secid: string): Promise<{ today: string | null; history: string[] }> {
    const file = this.pathOf(secid)
    try {
      const disk = await readJsonForUpdate(file, 'null')
      const root = disk !== null && typeof disk === 'object' ? (disk as Record<string, unknown>) : null
      if (root === null) return { today: null, history: [] }
      const hist = Array.isArray(root['history'])
        ? root['history'].map(normRecord).filter((r): r is AuctionDayRecord => r !== null).map((r) => r.day)
        : []
      return { today: typeof root['day'] === 'string' ? root['day'] : null, history: hist }
    } catch {
      return { today: null, history: [] }
    }
  }

  private async isCorrupt(file: string): Promise<boolean> {
    try {
      JSON.parse(await readFile(file, 'utf8'))
      return false
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'ENOENT') return false
      if (error instanceof SyntaxError) return true
      // 读不到（权限/磁盘）⇒ 记进 ReadGuard，本轮不写（避免覆盖）
      this.guard.markUnreadable(file, error)
      return false
    }
  }
}

/* ────────────────────────────── 采样 ────────────────────────────── */

export const AUCTION_INTERVAL_MS = 10_000

export interface AuctionTickDeps {
  now: () => number
  source: AuctionUniverseSource
  loadQuotes: (secids: string[]) => Promise<AuctionQuoteRow[]>
  savePoint: (secid: string, day: string, point: AuctionPoint) => Promise<void>
  maxSymbols?: number
}

export interface AuctionTickResult {
  inWindow: boolean
  day: string
  considered: number
  sampled: number
  skipped: number
  truncated: number
}

/** 一拍：窗口外直接返回；窗口内取行情 → 过滤 → 写点 */
export async function auctionTick(deps: AuctionTickDeps): Promise<AuctionTickResult> {
  const now = deps.now()
  const day = dayOf(now)
  if (!inAuctionWindow(now)) {
    return { inWindow: false, day, considered: 0, sampled: 0, skipped: 0, truncated: 0 }
  }
  const { secids, truncated } = universeOf(deps.source, deps.maxSymbols ?? 60)
  const rows = secids.length === 0 ? [] : await deps.loadQuotes(secids)
  let sampled = 0
  let skipped = 0
  for (const row of rows) {
    const point = auctionPointOf(row, now)
    if (point === null) {
      skipped += 1
      continue
    }
    await deps.savePoint(row.secid, day, point)
    sampled += 1
  }
  const found = new Set(rows.map((r) => r.secid))
  skipped += secids.filter((s) => !found.has(s)).length
  return { inWindow: true, day, considered: secids.length, sampled, skipped, truncated }
}

export interface AuctionSamplerOptions {
  intervalMs?: number
  now?: () => number
  loadQuotes?: (secids: string[]) => Promise<AuctionQuoteRow[]>
}

/** 后台采样器：每 10 秒一拍，只在窗口内有动作（测试进程不启动真实定时器） */
export class AuctionSampler {
  private timer: ReturnType<typeof setInterval> | null = null
  private running = false
  private warnedTruncated = false
  private readonly source: AuctionUniverseSource
  private readonly store: AuctionStore
  private readonly opts: AuctionSamplerOptions

  constructor(source: AuctionUniverseSource, store: AuctionStore = new AuctionStore(), opts: AuctionSamplerOptions = {}) {
    this.source = source
    this.store = store
    this.opts = opts
  }

  get isRunning(): boolean {
    return this.running
  }

  start(): void {
    if (this.running) return
    // 测试进程（node --test）不启动真实采样器：单测通过 `auctionTick` 直接驱动
    if (process.env.NODE_TEST_CONTEXT !== undefined) return
    this.running = true
    this.timer = setInterval(() => {
      void this.tick().catch(() => undefined)
    }, this.opts.intervalMs ?? AUCTION_INTERVAL_MS)
    this.timer.unref?.()
  }

  stop(): void {
    this.running = false
    if (this.timer !== null) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  async tick(): Promise<AuctionTickResult> {
    const result = await auctionTick({
      now: this.opts.now ?? Date.now,
      source: this.source,
      loadQuotes: this.opts.loadQuotes ?? fetchAuctionQuotes,
      savePoint: (secid, day, point) => this.store.addPoint(secid, day, point),
    })
    if (result.truncated > 0 && !this.warnedTruncated) {
      this.warnedTruncated = true
      console.warn(`[tradewatcher] 竞价采样标的超过 60 只：已按自选顺序截断（丢 ${result.truncated} 只）`)
    }
    return result
  }
}
