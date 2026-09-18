/**
 * dsh-tradewatcher data store: append-only trade/audit ledger + group/item
 * descriptors, persisted as JSON under ~/.dsh/dsh-tradewatcher/ (DSH_HOME
 * aware). All mutations validate first, append a ledger entry, and write
 * through atomically. Position quantities/costs are NEVER stored — they are
 * derived from the ledger by replay, so the JSON files are the durable record
 * for in-session analysis and the UI can rebuild any state from scratch.
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  ACTOR_WEB,
  DEFAULT_PREFS,
  RESCUE_ETF_CATALOG,
  SECID_RE,
  isFiniteNumber,
  type LedgerEntry,
  type LedgerVerb,
  type MutatePortBody,
  type MutateWatchBody,
  type PortGroup,
  type PortItem,
  type PortPrefs,
  type RescueConfig,
  type WatchData,
  type WatchGroup,
  type WatchItem,
} from '../shared/model.ts'
import { log } from './context.ts'

const NAME_MAX = 40
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
  } else if (verb === 'sell') {
    if (qty <= 0 || !Number.isFinite(qty)) throw new Error('卖出数量必须大于 0')
    if (qty > state.qty + 1e-9) throw new Error(`卖出数量超过持仓（持有 ${state.qty}）`)
    state.realized += (price - state.avgCost) * qty - feeN
    state.qty = Math.max(0, state.qty - qty)
    state.netCost -= qty * price - feeN
    state.fees += feeN
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

/** Replay one position's whole ledger into accounting state. */
export function replayPosition(entries: readonly LedgerEntry[], posId: string): TradeState {
  const state: TradeState = { qty: 0, avgCost: 0, netCost: 0, realized: 0, fees: 0 }
  for (const e of entries) {
    if (e.posId !== posId) continue
    if (e.verb !== 'buy' && e.verb !== 'sell' && e.verb !== 'adjust') continue
    const qty = e.qty
    const price = e.price
    if (!isFiniteNumber(qty) || !isFiniteNumber(price)) continue
    const fee = isFiniteNumber(e.fee) ? e.fee : 0
    try {
      applyTrade(state, e.verb, qty, price, fee)
    } catch {
      // Malformed/out-of-order history must never break the snapshot: keep
      // prior state (the entry remains visible in the ledger for audit).
    }
  }
  return state
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

  private async readJson<T>(file: string, fallback: T): Promise<T> {
    try {
      const text = await readFile(join(this.dir, file), 'utf8')
      const parsed = JSON.parse(text)
      return parsed as T
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return fallback
      log(`corrupt store file ${file}, starting fresh:`, String(error))
      return fallback
    }
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
      this.watch = await this.readJson<WatchFile>('watch.json', { v: 1, groups: [], items: [] })
      this.port = await this.readJson<PortFile>('positions.json', { v: 1, groups: [], items: [] })
      this.ledger = await this.readJson<LedgerFile>('ledger.json', { v: 1, entries: [] })
      const loaded = await this.readJson<Partial<PortPrefs>>('prefs.json', {})
      this.prefs = { ...DEFAULT_PREFS, ...loaded, rescue: { ...DEFAULT_PREFS.rescue, ...(loaded.rescue ?? {}) } }
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
    return `${prefix}${Date.now().toString(36)}${this.seq.toString(36)}${Math.random().toString(36).slice(2, 6)}`
  }

  private appendLedger(entry: LedgerEntry): void {
    this.ledger.entries.push(entry)
  }

  // ---- read faces ----

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

  private sanitizeSecid(v: unknown): string {
    const s = typeof v === 'string' ? v.trim().toUpperCase() : ''
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
        if (this.watch.items.some((x) => x.groupId === gid && x.secid === secid)) {
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
        if (this.watch.items.some((x) => x.id !== it.id && x.groupId === gid && x.secid === it.secid)) {
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
    const state = replayPosition(this.ledger.entries, pos.id)
    const rule = (verb: 'buy' | 'sell'): void => {
      if (verb === 'sell' && qty > state.qty + 1e-9) {
        throw new Error(`卖出数量超过当前持仓（持有 ${state.qty}）`)
      }
    }
    rule(verb)
    const ts = this.sanitizeTs(body.ts)
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
        if (this.port.items.some((x) => x.groupId === gid && x.secid === secid)) {
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
          if (this.port.items.some((x) => x.id !== p.id && x.groupId === gid && x.secid === p.secid)) {
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
        const state = replayPosition(this.ledger.entries, p.id)
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
        const state = replayPosition(this.ledger.entries, pos.id)
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
    if (patch.rescue !== undefined) this.prefs.rescue = normalizeRescuePrefs(patch.rescue, this.prefs.rescue)
    await this.commit([['prefs.json', this.prefs]])
    return this.getPrefs()
  }
}

/** Rounding helper for money display. */
export function money(n: number | null | undefined): number | null {
  if (n === null || n === undefined || !Number.isFinite(n)) return null
  return roundMoney(n)
}

export function clampMoney(n: number): number {
  return roundMoney(n)
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
  if (patch.universe !== undefined) {
    if (!Array.isArray(patch.universe)) throw new Error('universe 应为 secid 数组')
    const allowed = new Set(RESCUE_ETF_CATALOG.map((e) => e.secid))
    const picked = patch.universe.map(String).filter((s) => allowed.has(s))
    out.universe = picked
  }
  return out
}
