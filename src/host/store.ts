/**
 * dsh-tradewatcher data store: append-only trade/audit ledger + group/item
 * descriptors, persisted as JSON under ~/.dsh/dsh-tradewatcher/ (DSH_HOME
 * aware). All mutations validate first, append a ledger entry, and write
 * through atomically. Position quantities/costs are NEVER stored — they are
 * derived from the ledger by replay, so the JSON files are the durable record
 * for in-session analysis and the UI can rebuild any state from scratch.
 */
import { copyFile, mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  ACTOR_WEB,
  DEFAULT_PREFS,
  PORT_SORT_KEYS,
  normalizeFxRates,
  normalizePanelOpacity,
  RESCUE_ETF_CATALOG,
  SECID_RE,
  WATCH_SORT_KEYS,
  isFiniteNumber,
  isT0Secid,
  type LedgerEntry,
  type LedgerVerb,
  type MutatePortBody,
  type MutateWatchBody,
  type PortGroup,
  type PortItem,
  type PortPrefs,
  type RescueConfig,
  type RescueCustomChannel,
  type SortState,
  type WatchData,
  type WatchGroup,
  type WatchItem,
} from '../shared/model.ts'
import { log } from './context.ts'
import { shanghaiDayStart } from './time.ts'

const NAME_MAX = 40

/**
 * 持久文件的**结构归一**：只做形状校验与补全，不做业务校验。
 *
 * 背景：此前 readJson 只做 JSON.parse 的 try/catch，任何"合法 JSON 但缺字段"的
 * 文件（例如 ledger.json = {"v":1}）会让 `this.ledger.entries.slice()` 抛
 * TypeError —— /portfolio、/ledger、所有持仓写操作全部 400 且**永不自愈**，
 * 而且下一次落盘会用空库覆盖原文件，等于静默丢弃用户唯一的交易记录。
 * 现在：形状不合法 → 先 quarantine 备份、再从空库开始，且绝不覆盖原文件。
 */
function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function str(v: unknown, max = 64): string | null {
  return typeof v === 'string' && v !== '' && v.length <= max ? v : null
}

function numOrNull(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

export const LEDGER_VERBS = new Set([
  'buy', 'sell', 'adjust', 'add', 'remove', 'gcreate', 'grename', 'gdelete', 'grestore', 'gmove', 'pnote',
])

/** 归一化一条流水；非法则返回 null（跳过该条，而不是整个子系统崩掉） */
function normalizeLedgerEntry(raw: unknown): LedgerEntry | null {
  if (!isRecord(raw)) return null
  const id = str(raw.id)
  const ts = numOrNull(raw.ts)
  // 未知 verb **不丢弃**：保留原样回写，避免"新版写新动词、旧版一读就删"的数据丢失
  const verb = typeof raw.verb === 'string' && raw.verb !== '' ? (raw.verb as LedgerEntry['verb']) : null
  if (id === null || ts === null || verb === null) return null
  const entry: LedgerEntry = {
    id,
    ts,
    actor: raw.actor === 'tool' ? 'tool' : 'web',
    verb,
  }
  const groupId = str(raw.groupId)
  const posId = str(raw.posId)
  const secid = str(raw.secid, 32)
  const name = str(raw.name, NAME_MAX)
  if (groupId !== null) entry.groupId = groupId
  if (posId !== null) entry.posId = posId
  if (secid !== null) entry.secid = secid
  if (name !== null) entry.name = name
  const qty = numOrNull(raw.qty)
  const price = numOrNull(raw.price)
  const fee = numOrNull(raw.fee)
  if (qty !== null) entry.qty = qty
  if (price !== null) entry.price = price
  if (fee !== null) entry.fee = fee
  if (typeof raw.note === 'string') entry.note = raw.note.slice(0, 200)
  if (isRecord(raw.meta)) entry.meta = raw.meta
  return entry
}

/** 归一化账本；同时报出被丢弃的条数（调用方据此决定是否隔离原件并告警） */
export function normalizeLedgerDetailed(raw: unknown): { file: LedgerFile; dropped: number; total: number } | null {
  if (!isRecord(raw) || !Array.isArray(raw.entries)) return null
  const entries: LedgerEntry[] = []
  let dropped = 0
  for (const e of raw.entries) {
    const ok = normalizeLedgerEntry(e)
    if (ok === null) dropped += 1
    else entries.push(ok)
  }
  return { file: { v: numOrNull(raw.v) ?? 1, entries }, dropped, total: raw.entries.length }
}

export function normalizeLedger(raw: unknown): LedgerFile | null {
  const d = normalizeLedgerDetailed(raw)
  return d === null ? null : d.file
}

export function normalizePortFile(raw: unknown): PortFile | null {
  if (!isRecord(raw) || !Array.isArray(raw.groups) || !Array.isArray(raw.items)) return null
  const groups: PortGroup[] = []
  for (const g of raw.groups) {
    if (!isRecord(g)) continue
    const id = str(g.id)
    const name = str(g.name, NAME_MAX)
    if (id === null || name === null) continue
    const group: PortGroup = { id, name, order: numOrNull(g.order) ?? groups.length }
    if (g.archived === true) group.archived = true
    if (typeof g.note === 'string') group.note = g.note.slice(0, 200)
    groups.push(group)
  }
  const items: PortItem[] = []
  for (const it of raw.items) {
    if (!isRecord(it)) continue
    const id = str(it.id)
    const groupId = str(it.groupId)
    const secid = str(it.secid, 32)
    if (id === null || groupId === null || secid === null || !SECID_RE.test(secid)) continue
    const item: PortItem = { id, groupId, secid, name: str(it.name, NAME_MAX) ?? secid, createdAt: numOrNull(it.createdAt) ?? 0 }
    if (typeof it.note === 'string') item.note = it.note.slice(0, 200)
    items.push(item)
  }
  return { v: numOrNull(raw.v) ?? 1, groups, items }
}

export function normalizeWatchFile(raw: unknown): WatchFile | null {
  if (!isRecord(raw) || !Array.isArray(raw.groups) || !Array.isArray(raw.items)) return null
  const groups: WatchGroup[] = []
  for (const g of raw.groups) {
    if (!isRecord(g)) continue
    const id = str(g.id)
    const name = str(g.name, NAME_MAX)
    if (id === null || name === null) continue
    const group: WatchGroup = { id, name, order: numOrNull(g.order) ?? groups.length }
    if (g.archived === true) group.archived = true
    if (typeof g.note === 'string') group.note = g.note.slice(0, 200)
    groups.push(group)
  }
  const items: WatchItem[] = []
  for (const it of raw.items) {
    if (!isRecord(it)) continue
    const id = str(it.id)
    const groupId = str(it.groupId)
    const secid = str(it.secid, 32)
    if (id === null || groupId === null || secid === null || !SECID_RE.test(secid)) continue
    const item: WatchItem = { id, groupId, secid, name: str(it.name, NAME_MAX) ?? secid, createdAt: numOrNull(it.createdAt) ?? 0 }
    if (typeof it.note === 'string') item.note = it.note.slice(0, 200)
    items.push(item)
  }
  return { v: numOrNull(raw.v) ?? 1, groups, items }
}

/**
 * 流水排序的**唯一口径**：ts 升序，同 ts 时按 id 稳定排序。
 * 校验（store）与展示（portfolio）必须共用它，否则"补录过去某天的交易"之后
 * 校验用的数量与用户看到/操作的数量会分叉（误拒超卖或错误放行）。
 */
export function sortLedger(entries: readonly LedgerEntry[]): LedgerEntry[] {
  return [...entries].sort((a, b) => (a.ts - b.ts) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
}
const NOTE_MAX = 240
const QTY_DECIMALS = 4
const PRICE_MAX = 1e9

export function dataHome(): string {
  const base = process.env.DSH_HOME !== undefined && process.env.DSH_HOME !== ''
    ? process.env.DSH_HOME
    : join(homedir(), '.dsh')
  return join(base, 'dsh-tradewatcher')
}

interface WatchFile {
  v: number
  groups: WatchGroup[]
  items: WatchItem[]
}
interface PortFile {
  v: number
  groups: PortGroup[]
  items: PortItem[]
}
interface LedgerFile {
  v: number
  entries: LedgerEntry[]
}

export interface TradeState {
  qty: number
  /** 买入均价（移动加权，含买入费用） */
  avgCost: number
  /** 资金净投入：买入 +（金额+费用），卖出 −（金额−费用）；用于摊薄成本 */
  netCost: number
  realized: number
  /** Cumulative fees on trades that affected qty/cost (audit aid). */
  fees: number
  /**
   * 累计成交额（|数量 × 价格|，买卖双向都计；P1-5）。
   * 用途是算费用占比：`费用 ÷ 成交额` 才能说明"这个账户的手续费贵不贵"，
   * 光给一个绝对金额没有参照物。
   */
  turnover: number
  /**
   * **成本未知期间卖出的股数**（D1b）：应用某笔 `sell` 时 `avgCost <= 0`（成本还没录入），
   * 该笔已实现盈亏算不出来 —— 记下股数、且**不计入** `realized`。
   *
   * 为什么必须记：`adjust(100,0)` → `sell(50,12.5)` → 之后补成本，会让 `costAmountRecorded`
   * 变真、持仓级守卫解除；若那笔卖出仍按 `(12.5 − 0) × 50` 计，界面就会把 625 当成正常数字
   * 展示（真实应为 `(12.5 − 9.5) × 50 = 150`）。按**逐笔**判定而不是持仓级粘性标记：
   * 补录的成本流水 ts 若早于该笔卖出，重放时成本已知 ⇒ 就能正确算出 150。
   */
  realizedUnknownQty: number
}

/** Pure replay of one trade onto an accounting state. */
export function applyTrade(state: TradeState, verb: 'buy' | 'sell' | 'adjust', qty: number, price: number, fee: number): void {
  const feeN = Number.isFinite(fee) && fee > 0 ? fee : 0
  if (verb === 'buy') {
    if (qty <= 0 || !Number.isFinite(qty)) throw new Error('买入数量必须大于 0')
    const total = state.qty + qty
    state.avgCost = total > 0 ? (state.qty * state.avgCost + qty * price + feeN) / total : state.avgCost
    state.qty = total
    state.netCost += qty * price + feeN
    state.fees += feeN
    state.turnover += qty * price
  } else if (verb === 'sell') {
    if (qty <= 0 || !Number.isFinite(qty)) throw new Error('卖出数量必须大于 0')
    if (qty > state.qty + 1e-9) throw new Error(`卖出数量超过持仓（持有 ${state.qty}）`)
    if (state.avgCost > 0) {
      state.realized += (price - state.avgCost) * qty - feeN
    } else {
      // 成本未录入：这笔的已实现盈亏**算不出来**（(卖价 − 0) × 数量 不是收益）。
      // 记股数并在展示层给 null + 原因；不累加进 realized，数字里就永远不会混进假分量。
      state.realizedUnknownQty += qty
    }
    state.qty = Math.max(0, state.qty - qty)
    state.netCost -= qty * price - feeN
    state.fees += feeN
    state.turnover += qty * price
  } else {
    // adjust: set qty (target) and optionally rewrite avgCost; no P&L effect.
    if (qty < 0 || !Number.isFinite(qty)) throw new Error('调整数量不能为负')
    if (qty > 1e9) throw new Error('调整数量过大')
    if (Number.isFinite(price) && price > 0) state.avgCost = price
    state.qty = Math.round(qty * 10 ** QTY_DECIMALS) / 10 ** QTY_DECIMALS
    // 人工调整后重新基准化：摊薄成本与均价一致
    state.netCost = state.qty * state.avgCost
  }
}

/** 一条**未能应用**的流水（账本里有、快照却没算进来）—— 必须能被读到，否则就是静默降级 */
export interface SkippedLedgerEntry {
  id: string
  verb: LedgerVerb
  reason: string
}

export interface ReplayResult {
  state: TradeState
  /** 未应用的流水（含原因）；空数组 = 全部应用成功 */
  skipped: SkippedLedgerEntry[]
}

/**
 * Replay one position's whole ledger into accounting state, **并报告没能应用的条目**（P1-5）。
 *
 * 此前未应用的流水被 `catch {}` 静默吞掉：账本里能看到 5 笔、持仓快照却少一块，
 * 而没有任何标记说明"有 N 条流水没算进来" —— 用户对不上账时无从下手
 * （导入校验会因负持仓报错，但手工改了文件或历史脏数据会走到这里）。
 *
 * 坏流水**不影响**后续流水：保持应用前的状态继续往下走（快照永远给得出来），
 * 但这一次会被记进 `skipped`，由工具与界面如实报出。
 */
export function replayPositionWithSkips(entries: readonly LedgerEntry[], posId: string): ReplayResult {
  const state: TradeState = { qty: 0, avgCost: 0, netCost: 0, realized: 0, fees: 0, turnover: 0, realizedUnknownQty: 0 }
  const skipped: SkippedLedgerEntry[] = []
  for (const e of entries) {
    if (e.posId !== posId) continue
    if (e.verb !== 'buy' && e.verb !== 'sell' && e.verb !== 'adjust') continue
    const qty = e.qty
    const price = e.price
    if (!isFiniteNumber(qty) || !isFiniteNumber(price)) {
      skipped.push({ id: e.id, verb: e.verb, reason: '流水缺少数量或价格（必须是有限数值）' })
      continue
    }
    const fee = isFiniteNumber(e.fee) ? e.fee : 0
    try {
      applyTrade(state, e.verb, qty, price, fee)
    } catch (error) {
      // Malformed/out-of-order history must never break the snapshot: keep
      // prior state (the entry remains visible in the ledger for audit).
      skipped.push({ id: e.id, verb: e.verb, reason: error instanceof Error ? error.message : String(error) })
    }
  }
  return { state, skipped }
}

/** Replay one position's whole ledger into accounting state（只要状态，忽略跳过明细） */
export function replayPosition(entries: readonly LedgerEntry[], posId: string): TradeState {
  return replayPositionWithSkips(entries, posId).state
}

/**
 * 这笔交易之前**可卖**的数量（P1-8）。
 *
 * A股 T+1：当日买入的部分当日不可卖，因此"持有 1000"不等于"可卖 1000"。
 * 时点取**这笔流水自己的时间戳**（而不是"现在"）：补录历史流水时，可卖量按那一天的时点算。
 *
 * 口径：`可卖 = 该时点之前已持有的数量 − 同一天内该时点之前买入的数量`。
 * 同一毫秒的流水按插入序无法分辨先后，一律算作"之前"（宁可少算可卖量，也不放行一笔
 * 券商端不存在的成交）。
 */
export function availableQtyAt(entries: readonly LedgerEntry[], posId: string, at: number): number {
  const dayStart = shanghaiDayStart(at)
  let held = 0
  let sameDayBuys = 0
  for (const e of sortLedger(entries)) {
    if (e.posId !== posId || e.ts > at) continue
    const n = isFiniteNumber(e.qty) ? e.qty : 0
    if (e.verb === 'buy') {
      held += n
      if (e.ts >= dayStart) sameDayBuys += n
    } else if (e.verb === 'sell') {
      held -= n
    } else if (e.verb === 'adjust') {
      held = n
    }
  }
  return Math.max(0, Math.round((held - sameDayBuys) * 1e4) / 1e4)
}

function roundMoney(n: number): number {
  return Math.round(n * 100) / 100
}

// ──────────────────────────────── store ───────────────────────────────────

export class DataStore {
  private dir: string
  private watch: WatchFile = { v: 1, groups: [], items: [] }
  private port: PortFile = { v: 1, groups: [], items: [] }
  private ledger: LedgerFile = { v: 1, entries: [] }
  private prefs: PortPrefs = { ...DEFAULT_PREFS }
  private loaded: Promise<void> | null = null
  private writeChain: Promise<void> = Promise.resolve()
  private seq = 0

  constructor(dir: string = dataHome()) {
    this.dir = dir
  }

  // ---- io ----

  /**
   * 读入 + **结构归一** + 损坏隔离。
   * 形状不合法（含"合法 JSON 但缺字段"）时：先把原文件改名隔离备份，
   * 再从空库开始 —— 绝不静默覆盖用户数据，也绝不让子系统整体 400。
   */
  private async readNormalized<T>(
    file: string,
    normalize: (raw: unknown) => T | null,
    fallback: T,
  ): Promise<T> {
    let text: string
    try {
      text = await readFile(join(this.dir, file), 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return fallback
      log(`store read failed ${file}:`, String(error))
      return fallback
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch (error) {
      await this.quarantine(file)
      log(`corrupt store file ${file} (bad JSON) — quarantined:`, String(error))
      return fallback
    }
    const normalized = normalize(parsed)
    if (normalized === null) {
      await this.quarantine(file)
      log(`invalid store shape ${file} — quarantined, starting from empty`)
      return fallback
    }
    return normalized
  }

  /** 把无法解析的文件改名隔离（保留原字节，便于人工恢复），避免下一步落盘覆盖 */
  private async quarantine(file: string): Promise<void> {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    try {
      await rename(join(this.dir, file), join(this.dir, `${file}.corrupt-${stamp}`))
    } catch (error) {
      log(`quarantine failed ${file}:`, String(error))
    }
  }

  /**
   * 读入账本：整文件形状非法 → 隔离；**单条非法 → 同样隔离并告警**（此前只跳过该条，
   * 下一次写盘即永久丢失且无备份）。
   */
  private async readLedger(): Promise<LedgerFile> {
    let text: string
    try {
      text = await readFile(join(this.dir, 'ledger.json'), 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { v: 1, entries: [] }
      log('ledger read failed:', String(error))
      return { v: 1, entries: [] }
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch (error) {
      await this.quarantine('ledger.json')
      log('corrupt ledger.json (bad JSON) — quarantined:', String(error))
      return { v: 1, entries: [] }
    }
    const detailed = normalizeLedgerDetailed(parsed)
    if (detailed === null) {
      await this.quarantine('ledger.json')
      log('invalid ledger shape — quarantined, starting from empty')
      return { v: 1, entries: [] }
    }
    if (detailed.dropped > 0) {
      await this.quarantine('ledger.json')
      log(`ledger.json 有 ${detailed.dropped}/${detailed.total} 条无法解析 —— 已隔离原件备份，本次仅载入可用条目`)
    }
    // 未知 verb 会被原样保留（见 normalizeLedgerEntry 的说明），但值得告警一声：
    // 通常意味着有人手改了账本或写了未来版本的条目，静默接受会让它一直隐身
    const unknown = [...new Set(detailed.file.entries.map((e) => e.verb).filter((v) => !LEDGER_VERBS.has(v)))]
    if (unknown.length > 0) {
      log(`ledger.json 含未知操作类型（已原样保留）：${unknown.join('、')}`)
    }
    return detailed.file
  }

  /** 与校验/展示共用的排序口径（见 sortLedger 说明） */
  private sortedLedger(): LedgerEntry[] {
    return sortLedger(this.ledger.entries)
  }

  private async persist(file: string, value: unknown): Promise<void> {
    await mkdir(this.dir, { recursive: true })
    const target = join(this.dir, file)
    const tmp = `${target}.tmp`
    await writeFile(tmp, JSON.stringify(value, null, 1), 'utf8')
    await rename(tmp, target)
  }

  async init(): Promise<void> {
    if (this.loaded !== null) return this.loaded
    this.loaded = (async () => {
      await mkdir(this.dir, { recursive: true })
      this.watch = await this.readNormalized<WatchFile>('watch.json', normalizeWatchFile, { v: 1, groups: [], items: [] })
      this.port = await this.readNormalized<PortFile>('positions.json', normalizePortFile, { v: 1, groups: [], items: [] })
      // 账本是用户唯一的交易记录：单条非法也要隔离原件 + 告警（绝不静默丢数据）
      this.ledger = await this.readLedger()
      const loaded = await this.readNormalized<Partial<PortPrefs>>('prefs.json', (raw) => (isRecord(raw) ? (raw as Partial<PortPrefs>) : null), {})
      this.prefs = {
        ...DEFAULT_PREFS,
        ...loaded,
        rescue: { ...DEFAULT_PREFS.rescue, ...(loaded.rescue ?? {}) },
        // 排序偏好来自明文文件（可被手改）：装载时按白名单收敛，非法键回退默认而不是带进界面
        watchSort: safeSortPref(loaded.watchSort, WATCH_SORT_KEYS, DEFAULT_PREFS.watchSort),
        portSort: safeSortPref(loaded.portSort, PORT_SORT_KEYS, DEFAULT_PREFS.portSort),
        // 老 prefs.json 没有 viewMode → 回退完整视图（启动不该因一个坏偏好失败）
        viewMode: loaded.viewMode === 'compact' || loaded.viewMode === 'incognito' ? loaded.viewMode : 'full',
        panelOpacity: normalizePanelOpacity(loaded.panelOpacity, DEFAULT_PREFS.panelOpacity ?? 1),
        blurDigits: loaded.blurDigits === true,
        trendArchive: loaded.trendArchive !== false, // 默认开；只有显式 false 才关
        // live 是"未验证源"，装载时按 none 处理（启动不该因为一个不可用档位就崩）
        fxMode: loaded.fxMode === 'fixed' ? 'fixed' : 'none',
        fxRates: normalizeFxRates(loaded.fxRates),
      }
      // Coherence: drop descriptors that reference missing groups (never drop ledger).
      const groupIds = new Set(this.port.groups.map((g) => g.id))
      this.port.items = this.port.items.filter((p) => groupIds.has(p.groupId))
      const watchIds = new Set(this.watch.groups.map((g) => g.id))
      this.watch.items = this.watch.items.filter((p) => watchIds.has(p.groupId))
    })()
    return this.loaded
  }

  /** Serialize a mutation's writes behind all previous writes. */
  private commit(writes: Array<[string, unknown]>): Promise<void> {
    const run = this.writeChain.then(async () => {
      for (const [file, value] of writes) await this.persist(file, value)
    })
    this.writeChain = run.catch(() => undefined)
    return run
  }

  private nextId(prefix: string): string {
    this.seq += 1
    // seq 定宽（4 位 base36 = 到 168 万次）：sortLedger 用 id 的**字符串序**兜同一毫秒的并列，
    // 不定宽时 '36' 会排在 '35' 之前（同一毫秒内既有买又有卖时会影响均摊成本）
    return `${prefix}${Date.now().toString(36)}${this.seq.toString(36).padStart(4, '0')}${Math.random().toString(36).slice(2, 6)}`
  }

  private appendLedger(entry: LedgerEntry): void {
    this.ledger.entries.push(entry)
  }

  // ---- read faces ----

  /**
   * 导出：把四个数据文件的内容原样读出来（P0-9）。
   *
   * 从**磁盘**读而不是从内存读：内存状态理论上与磁盘一致（每次变更都落盘），
   * 但导出是给"换机器/备份"用的，磁盘才是用户真正拥有的那份。
   * 形状不合法的文件按 null 报出，由上层决定是拒绝还是跳过（不静默当成空表）。
   */
  async exportFiles(): Promise<{
    watch: unknown
    positions: unknown
    ledger: unknown
    prefs: unknown
    unreadable: string[]
  }> {
    const readRaw = async (file: string): Promise<unknown> => {
      try {
        return JSON.parse(await readFile(join(this.dir, file), 'utf8'))
      } catch {
        return undefined
      }
    }
    const [watch, positions, ledger, prefs] = await Promise.all([
      readRaw('watch.json'), readRaw('positions.json'), readRaw('ledger.json'), readRaw('prefs.json'),
    ])
    const unreadable = Object.entries({ 'watch.json': watch, 'positions.json': positions, 'ledger.json': ledger, 'prefs.json': prefs })
      .filter(([, v]) => v === undefined)
      .map(([k]) => k)
    return { watch, positions, ledger, prefs, unreadable }
  }

  /**
   * 导入：覆盖四个数据文件（P0-9）。
   *
   * 顺序很重要：
   *  1) 先把**现值**复制成 `<file>.bak`（覆盖前留退路；用户自己也能回滚）；
   *  2) 再逐文件原子写入（tmp + rename），任何一步失败都不会留下半截文件；
   *  3) 最后重新读回内存，保证之后所有读接口都反映新内容（而不是"写盘了但内存还是旧的"）。
   *
   * 调用方必须先跑 backup.verifyBundle()：这里不做业务校验，只做写入。
   */
  async importFiles(files: {
    watch: unknown
    positions: unknown
    ledger: unknown
    prefs: unknown
  }): Promise<{ backedUp: string[] }> {
    await this.init()
    const backedUp: string[] = []
    const pairs: Array<[string, unknown]> = [
      ['watch.json', files.watch],
      ['positions.json', files.positions],
      ['ledger.json', files.ledger],
      ['prefs.json', files.prefs],
    ]
    for (const [file] of pairs) {
      try {
        await copyFile(join(this.dir, file), join(this.dir, `${file}.bak`))
        backedUp.push(`${file}.bak`)
      } catch {
        /* 原本不存在该文件：没有可备份的内容，不算失败 */
      }
    }
    for (const [file, value] of pairs) await this.persist(file, value)
    // 重读内存：换机导入后立刻可用，不需要重启 dsh web
    this.watch = await this.readNormalized<WatchFile>('watch.json', normalizeWatchFile, { v: 1, groups: [], items: [] })
    this.port = await this.readNormalized<PortFile>('positions.json', normalizePortFile, { v: 1, groups: [], items: [] })
    this.ledger = await this.readLedger()
    const loaded = await this.readNormalized<Partial<PortPrefs>>('prefs.json', (raw) => (isRecord(raw) ? (raw as Partial<PortPrefs>) : null), {})
    this.prefs = {
      ...DEFAULT_PREFS,
      ...loaded,
      rescue: { ...DEFAULT_PREFS.rescue, ...(loaded.rescue ?? {}) },
      watchSort: safeSortPref(loaded.watchSort, WATCH_SORT_KEYS, DEFAULT_PREFS.watchSort),
      portSort: safeSortPref(loaded.portSort, PORT_SORT_KEYS, DEFAULT_PREFS.portSort),
      viewMode: loaded.viewMode === 'compact' || loaded.viewMode === 'incognito' ? loaded.viewMode : 'full',
    }
    return { backedUp }
  }

  /**
   * 数据文件最后写入时刻（epoch ms；文件不存在/读不到 → null）。
   *
   * P0-1 用：纯本地读工具（watchlist/ledger）必须能回答"这份数据是几点落盘的"，
   * 而不是把"响应生成时间"当成数据时刻 —— 那正是 v0.22 之前在行情上修过的同一个错。
   */
  async fileMtime(file: string): Promise<number | null> {
    try {
      const st = await stat(join(this.dir, file))
      return st.mtimeMs
    } catch {
      return null
    }
  }

  watchData(): WatchData {
    return JSON.parse(JSON.stringify({ groups: this.watch.groups, items: this.watch.items }))
  }

  portData(): { groups: PortGroup[]; items: PortItem[] } {
    return JSON.parse(JSON.stringify(this.port))
  }

  ledgerEntries(): LedgerEntry[] {
    return this.ledger.entries.slice()
  }

  getPrefs(): PortPrefs {
    return { ...this.prefs }
  }

  // ---- shared helpers ----

  private newId(prefix: string): string {
    return this.nextId(prefix)
  }

  private sanitizeText(v: unknown, max: number, what: string): string {
    const s = typeof v === 'string' ? v.trim() : ''
    if (s === '' || s.length > max) throw new Error(`${what} 长度需为 1–${max} 字符`)
    return s
  }

  private sanitizeOptional(v: unknown, max: number): string | undefined {
    if (v === undefined || v === null) return undefined
    const s = typeof v === 'string' ? v.trim() : ''
    if (s.length > max) throw new Error(`备注长度需 ≤ ${max} 字符`)
    return s === '' ? undefined : s
  }

  /**
   * 校验证券代码。**保留原始大小写**：`113.rbm` / `114.lhm` 这类商品/期货后缀区分大小写，
   * 上游请求与备用源映射（腾讯/新浪）都以原样为键；改写大小写会让这些标的永久取不到行情
   * （em.ts 里已踩过一次：整体 toUpperCase 让 4 个期货整批丢掉）。
   * 需要"同一标的"语义的地方（去重/冲突检测）用 secidKey() 做大小写无关比较。
   */
  private sanitizeSecid(v: unknown): string {
    const s = typeof v === 'string' ? v.trim() : ''
    if (!SECID_RE.test(s)) throw new Error('证券代码格式非法（如 1.600519 / 100.KOSPI200）')
    return s
  }

  private sanitizeQty(v: unknown): number {
    if (!isFiniteNumber(v) || v <= 0 || v > 1e9) throw new Error('数量必须是大于 0 的数字')
    return Math.round(v * 10 ** QTY_DECIMALS) / 10 ** QTY_DECIMALS
  }

  private sanitizePrice(v: unknown, required: boolean): number {
    if (!required && v === undefined) return 0
    if (!isFiniteNumber(v) || v < 0 || v > PRICE_MAX) {
      if (!required && v === undefined) return 0
      throw new Error('价格必须是 ≥ 0 的数字')
    }
    return v
  }

  private sanitizeFee(v: unknown): number {
    if (v === undefined || v === null) return 0
    if (!isFiniteNumber(v) || v < 0 || v > 1e7) throw new Error('费用必须是 ≥ 0 的数字')
    return v
  }

  // ─────────────────────────── watch mutations ────────────────────────────

  private groupOfWatch(gid: string): WatchGroup {
    const g = this.watch.groups.find((x) => x.id === gid)
    if (g === undefined) throw new Error('自选分组不存在')
    return g
  }

  private itemOfWatch(id: string): WatchItem {
    const it = this.watch.items.find((x) => x.id === id)
    if (it === undefined) throw new Error('自选条目不存在')
    return it
  }

  async mutateWatch(body: MutateWatchBody): Promise<WatchData> {
    await this.init()
    switch (body.op) {
      case 'addGroup': {
        const name = this.sanitizeText(body.name, NAME_MAX, '分组名')
        const order = Math.max(0, ...this.watch.groups.map((g) => g.order)) + 1
        this.watch.groups.push({ id: this.newId('wg'), name, order })
        break
      }
      case 'renameGroup': {
        const g = this.groupOfWatch(this.requireId(body.groupId))
        g.name = this.sanitizeText(body.name, NAME_MAX, '分组名')
        break
      }
      case 'noteGroup': {
        const g = this.groupOfWatch(this.requireId(body.groupId))
        g.note = this.sanitizeOptional(body.note, NOTE_MAX)
        break
      }
      case 'archiveGroup': {
        this.groupOfWatch(this.requireId(body.groupId)).archived = true
        break
      }
      case 'restoreGroup': {
        this.groupOfWatch(this.requireId(body.groupId)).archived = false
        break
      }
      case 'addItem': {
        const gid = this.requireId(body.groupId)
        this.groupOfWatch(gid)
        const secid = this.sanitizeSecid(body.secid)
        if (this.watch.items.some((x) => x.groupId === gid && secidKey(x.secid) === secidKey(secid))) {
          throw new Error('该分组已包含此证券')
        }
        const name = this.sanitizeText(body.symbolName, NAME_MAX, '证券名')
        this.watch.items.push({
          id: this.newId('wi'),
          groupId: gid,
          secid,
          name,
          note: this.sanitizeOptional(body.note, NOTE_MAX),
          createdAt: Date.now(),
        })
        break
      }
      case 'editItem': {
        const it = this.itemOfWatch(this.requireId(body.itemId))
        if (body.groupId !== undefined) {
          const gid = this.requireId(body.groupId)
          this.groupOfWatch(gid)
          it.groupId = gid
        }
        if (body.note !== undefined) it.note = this.sanitizeOptional(body.note, NOTE_MAX)
        if (body.symbolName !== undefined) it.name = this.sanitizeText(body.symbolName, NAME_MAX, '证券名')
        break
      }
      case 'moveItem': {
        const it = this.itemOfWatch(this.requireId(body.itemId))
        const gid = this.requireId(body.groupId)
        this.groupOfWatch(gid)
        if (this.watch.items.some((x) => x.id !== it.id && x.groupId === gid && secidKey(x.secid) === secidKey(it.secid))) {
          throw new Error('目标分组已包含此证券')
        }
        it.groupId = gid
        break
      }
      case 'removeItem': {
        const id = this.requireId(body.itemId)
        const idx = this.watch.items.findIndex((x) => x.id === id)
        if (idx === -1) throw new Error('自选条目不存在')
        this.watch.items.splice(idx, 1)
        break
      }
      default: {
        const op: string = (body as { op?: string }).op ?? ''
        throw new Error(`未知操作: ${op}`)
      }
    }
    await this.commit([['watch.json', this.watch]])
    return this.watchData()
  }

  // ─────────────────────────── portfolio mutations ────────────────────────

  private groupOfPort(gid: string): PortGroup {
    const g = this.port.groups.find((x) => x.id === gid)
    if (g === undefined) throw new Error('持仓分组不存在')
    return g
  }

  private posOf(id: string): PortItem {
    const p = this.port.items.find((x) => x.id === id)
    if (p === undefined) throw new Error('持仓不存在')
    return p
  }

  private ledgerEntry(verb: LedgerVerb, partial: Partial<LedgerEntry>): LedgerEntry {
    const entry: LedgerEntry = {
      id: this.newId('E'),
      ts: Date.now(),
      actor: ACTOR_WEB,
      verb,
      ...partial,
    }
    this.appendLedger(entry)
    return entry
  }

  /** Trade with ts backfill support: validate BEFORE mutating state/files. */
  private async trade(verb: 'buy' | 'sell', body: MutatePortBody): Promise<void> {
    const pos = this.posOf(this.requireId(body.posId))
    const qty = this.sanitizeQty(body.qty)
    const price = this.sanitizePrice(body.price, true)
    const fee = this.sanitizeFee(body.fee)
    const note = this.sanitizeOptional(body.note, NOTE_MAX)
    // Validate against current derived state before writing anything.
    const state = replayPosition(this.sortedLedger(), pos.id)
    // 时点先算：可卖数量按这笔流水自己的 ts 判定（补录历史时按那一天算）
    const ts = this.sanitizeTs(body.ts)
    const rule = (verb: 'buy' | 'sell'): void => {
      if (verb !== 'sell') return
      if (qty > state.qty + 1e-9) {
        throw new Error(`卖出数量超过当前持仓（持有 ${state.qty}）`)
      }
      // P1-8：可用（可卖）数量。此前只校验总持仓，于是可以录出一笔"当日买入、当日卖出"的
      // A股成交 —— 券商端不存在这笔交易，当日盈亏与已实现会随之偏离真实。
      if (!isT0Secid(pos.secid)) {
        const available = availableQtyAt(this.sortedLedger(), pos.id, ts)
        if (qty > available + 1e-9) {
          throw new Error(
            `可用（可卖）数量不足：该时点可用 ${available}，当前持仓 ${state.qty}` +
            '（差额是当日买入的部分，A股 T+1 当日不可卖）。ETF/LOF、港股、美股为 T+0，不受该限制',
          )
        }
      }
    }
    rule(verb)
    this.ledgerEntry(verb, {
      ts,
      posId: pos.id,
      groupId: pos.groupId,
      secid: pos.secid,
      name: pos.name,
      qty,
      price,
      fee,
      note,
      meta: { balanceBefore: Math.round(state.qty * 1e4) / 1e4 },
    })
    await this.commit([['ledger.json', this.ledger]])
  }

  private sanitizeTs(v: unknown): number {
    if (v === undefined || v === null) return Date.now()
    if (!isFiniteNumber(v) || v < 1e12 || v > Date.now() + 3600_000) throw new Error('时间戳非法')
    return Math.round(v)
  }

  async mutatePortfolio(body: MutatePortBody): Promise<void> {
    await this.init()
    switch (body.op) {
      case 'addGroup': {
        const name = this.sanitizeText(body.name, NAME_MAX, '分组名')
        const order = Math.max(0, ...this.port.groups.map((g) => g.order)) + 1
        const id = this.newId('pg')
        this.port.groups.push({ id, name, order })
        this.ledgerEntry('gcreate', { groupId: id, name })
        break
      }
      case 'renameGroup': {
        const g = this.groupOfPort(this.requireId(body.groupId))
        const name = this.sanitizeText(body.name, NAME_MAX, '分组名')
        this.ledgerEntry('grename', { groupId: g.id, name, meta: { old: g.name } })
        g.name = name
        break
      }
      case 'noteGroup': {
        const g = this.groupOfPort(this.requireId(body.groupId))
        g.note = this.sanitizeOptional(body.note, NOTE_MAX)
        this.ledgerEntry('pnote', { groupId: g.id, name: g.name, note: g.note })
        break
      }
      case 'archiveGroup': {
        const g = this.groupOfPort(this.requireId(body.groupId))
        g.archived = true
        this.ledgerEntry('gdelete', { groupId: g.id, name: g.name })
        break
      }
      case 'restoreGroup': {
        const g = this.groupOfPort(this.requireId(body.groupId))
        g.archived = false
        this.ledgerEntry('grestore', { groupId: g.id, name: g.name })
        break
      }
      case 'addPos': {
        const gid = this.requireId(body.groupId)
        const g = this.groupOfPort(gid)
        if (g.archived === true) throw new Error('分组已归档，请先还原')
        const secid = this.sanitizeSecid(body.secid)
        if (this.port.items.some((x) => x.groupId === gid && secidKey(x.secid) === secidKey(secid))) {
          throw new Error('该分组已包含此证券')
        }
        const name = this.sanitizeText(body.symbolName, NAME_MAX, '证券名')
        const id = this.newId('pp')
        this.port.items.push({
          id,
          groupId: gid,
          secid,
          name,
          note: this.sanitizeOptional(body.note, NOTE_MAX),
          createdAt: Date.now(),
        })
        this.ledgerEntry('add', { posId: id, groupId: gid, secid, name })
        break
      }
      case 'editPos': {
        const p = this.posOf(this.requireId(body.posId))
        const meta: Record<string, unknown> = {}
        if (body.groupId !== undefined) {
          const gid = this.requireId(body.groupId)
          const g = this.groupOfPort(gid)
          if (g.archived === true) throw new Error('目标分组已归档')
          if (this.port.items.some((x) => x.id !== p.id && x.groupId === gid && secidKey(x.secid) === secidKey(p.secid))) {
            throw new Error('目标分组已包含此证券')
          }
          meta.oldGroup = p.groupId
          p.groupId = gid
        }
        if (body.symbolName !== undefined) {
          meta.oldName = p.name
          p.name = this.sanitizeText(body.symbolName, NAME_MAX, '证券名')
        }
        if (body.note !== undefined) p.note = this.sanitizeOptional(body.note, NOTE_MAX)
        this.ledgerEntry('gmove', {
          posId: p.id,
          groupId: p.groupId,
          secid: p.secid,
          name: p.name,
          note: body.note !== undefined ? p.note : undefined,
          meta,
        })
        break
      }
      case 'removePos': {
        const p = this.posOf(this.requireId(body.posId))
        const state = replayPosition(this.sortedLedger(), p.id)
        if (state.qty > 1e-9) {
          throw new Error(`请先卖出全部持仓（当前持有 ${state.qty}）再移除，以保留完整交易记录`)
        }
        const idx = this.port.items.findIndex((x) => x.id === p.id)
        this.port.items.splice(idx, 1)
        this.ledgerEntry('remove', {
          posId: p.id,
          groupId: p.groupId,
          secid: p.secid,
          name: p.name,
        })
        break
      }
      case 'buy':
      case 'sell': {
        await this.trade(body.op, body)
        break
      }
      case 'adjust': {
        const pos = this.posOf(this.requireId(body.posId))
        const qty = this.sanitizePrice(body.qty, true) // allow 0
        if (qty > 1e9) throw new Error('数量过大')
        const price = body.price === undefined ? 0 : this.sanitizePrice(body.price, true)
        const fee = this.sanitizeFee(body.fee)
        const note = this.sanitizeOptional(body.note, NOTE_MAX)
        const state = replayPosition(this.sortedLedger(), pos.id)
        // Copy current avg when no cost override given.
        const avg = body.price === undefined ? state.avgCost : price
        this.ledgerEntry('adjust', {
          ts: this.sanitizeTs(body.ts),
          posId: pos.id,
          groupId: pos.groupId,
          secid: pos.secid,
          name: pos.name,
          qty: Math.round(qty * 10 ** QTY_DECIMALS) / 10 ** QTY_DECIMALS,
          price: avg,
          fee,
          note,
          meta: { oldQty: Math.round(state.qty * 1e4) / 1e4, oldAvg: Math.round(state.avgCost * 1e4) / 1e4 },
        })
        break
      }
      default: {
        const op: string = (body as { op?: string }).op ?? ''
        throw new Error(`未知操作: ${op}`)
      }
    }
    await this.commit([
      ['positions.json', this.port],
      ['ledger.json', this.ledger],
    ])
  }

  private requireId(v: unknown): string {
    const s = typeof v === 'string' && v !== '' ? v : ''
    if (s === '') throw new Error('缺少 id')
    return s
  }

  /** Persist current state files (used after direct tool edits, none in v1). */
  async touch(): Promise<void> {
    await this.commit([
      ['positions.json', this.port],
      ['ledger.json', this.ledger],
      ['watch.json', this.watch],
    ])
  }

  async setPrefs(patch: Partial<PortPrefs>): Promise<PortPrefs> {
    await this.init()
    if (patch.theme !== undefined && !['auto', 'light', 'dark'].includes(patch.theme)) {
      throw new Error('theme 必须是 auto/light/dark')
    }
    if (patch.theme !== undefined) this.prefs.theme = patch.theme
    if (patch.costBasis !== undefined) {
      if (patch.costBasis !== 'diluted' && patch.costBasis !== 'average') throw new Error('costBasis 必须是 diluted/average')
      this.prefs.costBasis = patch.costBasis
    }
    if (patch.refreshSec !== undefined) {
      const r = patch.refreshSec
      if (!isFiniteNumber(r) || r < 3 || r > 600) throw new Error('刷新间隔需在 3–600 秒之间')
      this.prefs.refreshSec = Math.round(r)
    }
    if (patch.redUp !== undefined) this.prefs.redUp = patch.redUp === true
    // P2-2：截图/录屏相关的两个偏好。不透明度越界按边界收（而不是报错丢弃整个 patch），
    // 但类型不对必须拒绝 —— 那说明调用方写错了字段
    if (patch.panelOpacity !== undefined) {
      if (!isFiniteNumber(patch.panelOpacity)) throw new Error('panelOpacity 必须是数字')
      this.prefs.panelOpacity = normalizePanelOpacity(patch.panelOpacity)
    }
    if (patch.blurDigits !== undefined) {
      if (typeof patch.blurDigits !== 'boolean') throw new Error('blurDigits 必须是布尔值')
      this.prefs.blurDigits = patch.blurDigits
    }
    if (patch.trendArchive !== undefined) {
      if (typeof patch.trendArchive !== 'boolean') throw new Error('trendArchive 必须是布尔值')
      this.prefs.trendArchive = patch.trendArchive
    }
    // P1-11：折算口径。`live` 明确拒绝并给出理由 —— 实时汇率源尚未验证，
    // 接受它只会让用户以为开了实时折算、实际什么都没算
    if (patch.fxMode !== undefined) {
      if (patch.fxMode === 'live') {
        throw new Error('实时汇率暂不可用：汇率源尚未验证连通性与字段口径。请选「不折算」或填写固定汇率（固定汇率离线可用、口径透明）')
      }
      if (patch.fxMode !== 'none' && patch.fxMode !== 'fixed') throw new Error('fxMode 必须是 none/fixed/live')
      this.prefs.fxMode = patch.fxMode
    }
    if (patch.fxRates !== undefined) {
      if (patch.fxRates === null || typeof patch.fxRates !== 'object' || Array.isArray(patch.fxRates)) {
        throw new Error('fxRates 必须是对象（如 { HKD: 0.92, USD: 7.15 }）')
      }
      this.prefs.fxRates = normalizeFxRates(patch.fxRates)
    }
    // P0-8：视图档位。非法值拒绝而不是回退 —— 回退会让"点了没反应"变成静默行为
    if (patch.viewMode !== undefined) {
      if (patch.viewMode !== 'full' && patch.viewMode !== 'compact' && patch.viewMode !== 'incognito') {
        throw new Error('viewMode 必须是 full/compact/incognito')
      }
      this.prefs.viewMode = patch.viewMode
    }
    // 排序偏好：非法键/非布尔方向一律拒绝（而不是静默写入，否则界面会拿到无法排序的键）
    if (patch.watchSort !== undefined) this.prefs.watchSort = normalizeSortPref(patch.watchSort, WATCH_SORT_KEYS, this.prefs.watchSort, 'watchSort')
    if (patch.portSort !== undefined) this.prefs.portSort = normalizeSortPref(patch.portSort, PORT_SORT_KEYS, this.prefs.portSort, 'portSort')
    if (patch.rescue !== undefined) this.prefs.rescue = normalizeRescuePrefs(patch.rescue, this.prefs.rescue)
    await this.commit([['prefs.json', this.prefs]])
    return this.getPrefs()
  }
}

/**
 * "同一标的"的比较键：大小写无关。
 * 只用于**比较/去重**，绝不用它改写存下来的 secid 原值（见 sanitizeSecid 的说明）。
 */
export function secidKey(secid: string): string {
  return secid.trim().toUpperCase()
}

/** Rounding helper for money display. */
export function money(n: number | null | undefined): number | null {
  if (n === null || n === undefined || !Number.isFinite(n)) return null
  return roundMoney(n)
}

export function clampMoney(n: number): number {
  return roundMoney(n)
}

/**
 * 排序偏好校验：键必须在白名单内、方向必须是布尔值，否则**抛错**而不是回退。
 * 回退会让"点了没反应"变成静默行为（写进去的是无法识别的键）；抛错会让界面提示出来。
 */
function normalizeSortPref<K extends string>(
  raw: unknown,
  keys: readonly K[],
  base: SortState<K>,
  field: string,
): SortState<K> {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`${field} 应为对象`)
  const o = raw as { key?: unknown; desc?: unknown }
  if (typeof o.key !== 'string' || !(keys as readonly string[]).includes(o.key)) {
    throw new Error(`${field}.key 必须是 ${keys.join('/')}`)
  }
  if (o.desc !== undefined && typeof o.desc !== 'boolean') throw new Error(`${field}.desc 必须是布尔值`)
  const desc = o.desc
  return { key: o.key as K, desc: typeof desc === 'boolean' ? desc : base.desc }
}

/** 装载时的宽容版本：非法值回退默认（启动不该因为一个坏偏好而失败） */
function safeSortPref<K extends string>(raw: unknown, keys: readonly K[], base: SortState<K>): SortState<K> {
  try {
    return normalizeSortPref(raw, keys, base, 'sort')
  } catch {
    return { ...base }
  }
}

/** 护盘信号配置校验：频率 5–600s、尾盘时刻 HH:mm、标的池限白名单 */
export function normalizeRescuePrefs(patch: Partial<RescueConfig>, base: RescueConfig): RescueConfig {
  const out: RescueConfig = { ...base }
  if (patch.enabled !== undefined) out.enabled = patch.enabled === true
  const sec = (v: unknown, fallback: number): number => {
    if (!isFiniteNumber(v) || v < 5 || v > 600) return fallback
    return Math.round(v)
  }
  if (patch.intervalSec !== undefined) out.intervalSec = sec(patch.intervalSec, base.intervalSec)
  if (patch.tailIntervalSec !== undefined) out.tailIntervalSec = sec(patch.tailIntervalSec, base.tailIntervalSec)
  if (patch.tailFrom !== undefined) {
    const t = String(patch.tailFrom)
    const m = /^(\d{2}):(\d{2})$/.exec(t)
    if (m === null || Number(m[1]) > 23 || Number(m[2]) > 59) throw new Error('尾盘时刻应为 00:00–23:59 之间的 HH:mm')
    out.tailFrom = t
  }
  if (patch.custom !== undefined) {
    if (!Array.isArray(patch.custom)) throw new Error('custom 应为数组')
    const seen = new Set<string>()
    const out2: RescueCustomChannel[] = []
    for (const raw of patch.custom.slice(0, 20)) {
      // 保留原始大小写（同 sanitizeSecid 的理由）；去重用大小写无关键
      const secid = String((raw as { secid?: unknown })?.secid ?? '').trim()
      const name = String((raw as { name?: unknown })?.name ?? '').trim()
      if (!SECID_RE.test(secid)) throw new Error(`自定义通道代码非法：${secid}`)
      if (name === '' || name.length > 24) throw new Error('自定义通道名称必填且 ≤ 24 字')
      if (seen.has(secidKey(secid))) continue
      seen.add(secidKey(secid))
      const index = String((raw as { index?: unknown })?.index ?? '').trim().slice(0, 16)
      out2.push({ secid, name, index: index === '' ? undefined : index })
    }
    out.custom = out2
  }
  if (patch.universe !== undefined) {
    if (!Array.isArray(patch.universe)) throw new Error('universe 应为 secid 数组')
    const allowed = new Set(RESCUE_ETF_CATALOG.map((e) => e.secid))
    const picked = patch.universe.map(String).filter((s) => allowed.has(s))
    out.universe = picked
  }
  return out
}
