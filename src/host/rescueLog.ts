/**
 * rescue-log 按日分片存储（`docs/AUDIT-HOST-PERF.md` P1-5）。
 *
 * 旧布局是**单文件** `rescue-log.json`：60 天全量（实测 7.67 MB）每分钟被
 * `updateJsonLocked` 整份 parse（73 ms）+ 合并 + stringify（53 ms）再原子写，
 * 交易时段 ~300 次/日 ⇒ ≈2 GB 写盘 + ≈33 s CPU/日；而且每次写都把**没有变化的
 * 历史日**原样重写一遍。
 *
 * 新布局：
 *   <dataHome>/rescue-log/<YYYY-MM-DD>.json    当日分片（只写当天；原子写）
 *   <dataHome>/rescue-log/meta.json            跨日小题（baselines / lastSnapshot / selfSamples / 进度曲线）
 *   <dataHome>/rescue-log.json.migrated-<ts>   旧单文件（首次启动拆分后改名保留，永不删除）
 *
 * 读路径只打开窗口内的分片（默认**当天 + 最近 5 天**）；历史回看按日期读单份分片。
 * 保留上限按**文件**裁剪（默认 30 天，`RESCUE_LOG_KEEP_DAYS` 可配），裁剪结果记进状态。
 *
 * 设计约束（为什么这么写）：
 *  · 分片自描述（带 `day` 字段）：文件名与内容对不上即视为损坏 —— 否则会静默把 A 日的数据
 *    当成 B 日的读出来；
 *  · 损坏/空分片**只影响那一天**：读出来是「没有数据 + 原因」，不抛给调用方、不拖累其它天；
 *  · 迁移是一次性的：先把每天写成独立分片（`writeFileSetAtomic` 一次提交），再把旧文件改名；
 *    中途失败时旧文件还在，下次启动重跑，**已存在的分片不会被覆盖**；
 *  · 迁移只做「搬」不做「改」：每日 `log` 原样搬过去，条目数守恒（有断言守着）。
 */
import { readFile, readdir, rename, stat, unlink } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { writeFileSetAtomic, type AtomicFileSetEntry } from './atomic.ts'
import { withFileLocks } from './lock.ts'
import { dayOf, hhmmOf } from './time.ts'

/** 分片目录名（与旧单文件同层） */
export const RESCUE_LOG_DIRNAME = 'rescue-log'
/** 旧单文件名（迁移后改名保留） */
export const RESCUE_LOG_LEGACY = 'rescue-log.json'
/** 跨日小题文件名（不带日期 ⇒ 永远不会被按日裁剪） */
export const RESCUE_LOG_META = 'meta.json'
/** 默认保留天数（分片文件） */
export const RESCUE_LOG_DEFAULT_KEEP_DAYS = 30
/** 默认读取窗口：当天 + 最近 N 天 */
export const RESCUE_LOG_DEFAULT_READ_DAYS = 5
/** 分片文件名（严格 YYYY-MM-DD.json；`meta.json` 不匹配） */
export const RESCUE_DAY_FILE_RE = /^(\d{4}-\d{2}-\d{2})\.json$/

/** 分片文件：自描述（`day` 与文件名必须一致） */
export interface DayShard<T> {
  v: 1
  day: string
  log: T
  updatedAt: number
}

export interface DayReadResult<T> {
  day: string
  path: string
  log: T | null
  /** `log === null` 时的原因（可直接展示成「—」旁边的说明） */
  why: string | null
  /** true = 文件不存在（该日没有记录/已被清理），不是损坏 */
  missing: boolean
  bytes: number
}

export interface MetaReadResult {
  meta: Record<string, unknown> | null
  why: string | null
  quarantined: string | null
}

export interface MigrationReport {
  at: number
  /** 从读到旧文件到旧文件改名完成的墙钟耗时（ms，含 IO） */
  ms: number
  /** 旧文件字节数 */
  bytes: number
  /** 这次写出的日分片数 */
  days: number
  /** 拆出来的条目总数（events + intraday + scoreLog） */
  entries: number
  /** 旧文件改名后的路径；null = 没有改名（损坏隔离或已被别的进程迁移） */
  renamedTo: string | null
  /** 未拆分的日期键（不是合法日期 / 值不是对象） */
  skipped: string[]
  why: string | null
}

export interface PruneReport {
  at: number
  keepDays: number
  removed: string[]
  /** 状态里写的一条留痕：「已清理 N 天」 */
  note: string
}

/** 注入点：测试用它统计"读了哪些文件"（只覆盖读路径；写路径走 atomic.ts） */
export interface RescueLogIo {
  /** 读文本；文件不存在返回 null（其余错误照常抛出） */
  readText(path: string): Promise<string | null>
  /** 列目录；目录不存在返回空数组 */
  listDir(path: string): Promise<string[]>
  /** 是否存在（用 `stat`，不产生"打开文件"的 open —— 启动探测旧文件时不该算一次读） */
  exists(path: string): Promise<boolean>
}

export const nodeRescueLogIo: RescueLogIo = {
  async readText(path) {
    try {
      return await readFile(path, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    }
  },
  async listDir(path) {
    try {
      return await readdir(path)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
  },
  async exists(path) {
    try {
      await stat(path)
      return true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
      throw error
    }
  },
}

/** 保留天数（`RESCUE_LOG_KEEP_DAYS`，非法值回落默认 30） */
export function rescueLogKeepDays(env: NodeJS.ProcessEnv = process.env): number {
  return positiveInt(env.RESCUE_LOG_KEEP_DAYS, RESCUE_LOG_DEFAULT_KEEP_DAYS)
}

/** 读取窗口天数（`RESCUE_LOG_READ_DAYS`，非法值回落默认 5） */
export function rescueLogReadDays(env: NodeJS.ProcessEnv = process.env): number {
  return positiveInt(env.RESCUE_LOG_READ_DAYS, RESCUE_LOG_DEFAULT_READ_DAYS)
}

function positiveInt(raw: string | undefined, fallback: number): number {
  const n = Number(raw)
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : fallback
}

/**
 * 北京日历日 ± N 天（纯函数）。
 *
 * 用 `Date.UTC` 做「日历日」算术：中国无夏令时，日长恒 86 400 000 ms，
 * 因此不会出现"夏令时把 23 点算成第二天"的偏差；也避免用宿主时区解析日期串。
 */
export function shiftDay(day: string, delta: number): string {
  const [y, m, d] = day.split('-').map(Number)
  const t = new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1) + delta * 86_400_000)
  const yy = String(t.getUTCFullYear()).padStart(4, '0')
  const mm = String(t.getUTCMonth() + 1).padStart(2, '0')
  const dd = String(t.getUTCDate()).padStart(2, '0')
  return `${yy}-${mm}-${dd}`
}

/** YYYY-MM-DD 且必须是真实存在的日历日（2026-02-31 不算） */
export function isDayKey(day: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return false
  return shiftDay(day, 0) === day
}

/**
 * 北京时间的时间戳标签 `YYYYMMDD-HHmmss`（旧文件改名 / 隔离备份共用）。
 *
 * 秒不用 `getSeconds()`：全仓红线是"市场时间一律走 `time.ts` 的北京出口"，`getSeconds()`
 * 读的是宿主时区（本机若不是 +08:00，标签里的秒仍一样，但这条调用开了坏先例，扫描会判红）。
 * 北京偏移是**整分钟**（+08:00）⇒ epoch 秒对 60 取模就是本地秒。
 */
export function dayStamp(ts: number): string {
  const sec = String(((Math.floor(ts / 1000) % 60) + 60) % 60).padStart(2, '0')
  return `${dayOf(ts).replace(/-/g, '')}-${hhmmOf(ts).replace(':', '')}${sec}`
}

/** 一天分片里的条目数（events + intraday + scoreLog）—— 迁移守恒断言用 */
export function countDayEntries(log: unknown): number {
  if (log === null || typeof log !== 'object') return 0
  const row = log as { events?: unknown; intraday?: unknown; scoreLog?: unknown }
  const len = (v: unknown): number => (Array.isArray(v) ? v.length : 0)
  return len(row.events) + len(row.intraday) + len(row.scoreLog)
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function msSince(startedAt: number): number {
  return Math.round((performance.now() - startedAt) * 10) / 10
}

/**
 * 分片仓库：只管「文件怎么摆、怎么读、怎么迁移、怎么裁剪」；
 * 合并语义（同日计数相加、跨日小题取最新）留在 `rescue.ts` 里 —— 那是业务规则。
 */
export class RescueLogStore {
  readonly baseDir: string
  private readonly io: RescueLogIo

  constructor(baseDir: string, io: RescueLogIo = nodeRescueLogIo) {
    this.baseDir = baseDir
    this.io = io
  }

  get dir(): string {
    return join(this.baseDir, RESCUE_LOG_DIRNAME)
  }

  get legacyPath(): string {
    return join(this.baseDir, RESCUE_LOG_LEGACY)
  }

  get metaPath(): string {
    return join(this.dir, RESCUE_LOG_META)
  }

  shardPath(day: string): string {
    return join(this.dir, `${day}.json`)
  }

  /** 磁盘上现有的日分片（升序；`meta.json` 不在内） */
  async listDays(): Promise<string[]> {
    const names = await this.io.listDir(this.dir)
    const days: string[] = []
    for (const name of names) {
      const m = RESCUE_DAY_FILE_RE.exec(name)
      if (m !== null && isDayKey(m[1]!)) days.push(m[1]!)
    }
    return days.sort()
  }

  /** 读一天的分片。空/损坏/日期不符 ⇒ `log: null` + `why`，绝不抛错拖累其它天 */
  async readDay<T = unknown>(day: string): Promise<DayReadResult<T>> {
    const path = this.shardPath(day)
    if (!isDayKey(day)) return { day, path, log: null, why: `"${day}" 不是合法的北京日期（YYYY-MM-DD）`, missing: false, bytes: 0 }
    let raw: string | null
    try {
      raw = await this.io.readText(path)
    } catch (error) {
      return { day, path, log: null, why: `分片读取失败（${reasonOf(error)}）`, missing: false, bytes: 0 }
    }
    if (raw === null) return { day, path, log: null, why: '该日无分片（没有记录，或已按保留上限清理）', missing: true, bytes: 0 }
    const bytes = Buffer.byteLength(raw, 'utf8')
    if (raw.trim() === '') {
      return { day, path, log: null, why: '分片为空（0 字节）⇒ 该日显示为「—」', missing: false, bytes }
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(raw) as unknown
    } catch (error) {
      return { day, path, log: null, why: `分片 JSON 解析失败（${reasonOf(error)}）⇒ 该日显示为「—」`, missing: false, bytes }
    }
    const shard = (parsed !== null && typeof parsed === 'object' ? parsed : null) as Partial<DayShard<T>> | null
    if (shard === null || shard.log === null || typeof shard.log !== 'object') {
      return { day, path, log: null, why: '分片缺少 log 字段（格式不符）⇒ 该日显示为「—」', missing: false, bytes }
    }
    if (typeof shard.day === 'string' && shard.day !== day) {
      return { day, path, log: null, why: `分片自述日期 ${shard.day} 与文件名 ${day} 不一致 ⇒ 拒绝加载`, missing: false, bytes }
    }
    return { day, path, log: shard.log, why: null, missing: false, bytes }
  }

  /** 读跨日小题（损坏 ⇒ 隔离改名 + 原因，调用方按空库启动） */
  async readMeta(now = Date.now()): Promise<MetaReadResult> {
    let raw: string | null
    try {
      raw = await this.io.readText(this.metaPath)
    } catch (error) {
      return { meta: null, why: `meta 读取失败（${reasonOf(error)}）`, quarantined: null }
    }
    if (raw === null) return { meta: null, why: null, quarantined: null }
    if (raw.trim() === '') {
      const quarantined = await this.quarantine(this.metaPath, now)
      return { meta: null, why: `meta 为空（0 字节）⇒ 已隔离归档，本次按空库启动`, quarantined }
    }
    try {
      const parsed = JSON.parse(raw) as unknown
      if (parsed === null || typeof parsed !== 'object') throw new Error('顶层不是对象')
      return { meta: parsed as Record<string, unknown>, why: null, quarantined: null }
    } catch (error) {
      const quarantined = await this.quarantine(this.metaPath, now)
      return { meta: null, why: `meta 解析失败（${reasonOf(error)}）⇒ 已隔离归档${quarantined === null ? '（改名失败）' : `为 ${basename(quarantined)}`}，本次按空库启动`, quarantined }
    }
  }

  /**
   * 写路径专用读：坏分片会**先隔离改名**再返回 null（绝不静默覆盖用户数据，也绝不让坏文件卡死写盘）。
   * 调用方必须已持有该文件的锁。
   */
  async readShardForMerge<T>(day: string, now = Date.now()): Promise<{ log: T | null; why: string | null; quarantined: string | null }> {
    const got = await this.readDay<T>(day)
    if (got.log !== null) return { log: got.log, why: null, quarantined: null }
    if (got.missing) return { log: null, why: null, quarantined: null }
    const quarantined = await this.quarantine(got.path, now)
    return { log: null, why: `${got.why}；已隔离归档${quarantined === null ? '（改名失败）' : `为 ${basename(quarantined)}`}并重建分片`, quarantined }
  }

  /** 写路径专用读 meta（同 `readShardForMerge` 的语义） */
  async readMetaForMerge(now = Date.now()): Promise<{ meta: Record<string, unknown> | null; why: string | null; quarantined: string | null }> {
    const got = await this.readMeta(now)
    return { meta: got.meta, why: got.why, quarantined: got.quarantined }
  }

  /** 隔离改名（`.corrupt-<ts>`）：保留现场，不删。返回新路径（改名失败返回 null） */
  async quarantine(path: string, now = Date.now()): Promise<string | null> {
    const dest = `${path}.corrupt-${dayStamp(now)}`
    try {
      await rename(path, dest)
      return dest
    } catch {
      return null
    }
  }

  /**
   * 首次启动：把旧单文件 `rescue-log.json` 按 `days` 拆成日分片。
   *
   * - 旧文件不存在 ⇒ 返回 null（正常路径，零成本）；
   * - 旧文件损坏 ⇒ 隔离改名（`.corrupt-<ts>`，保留不删），不拆分；
   * - 已存在的分片**合并**（按 key 取并集；可能是上次迁移中途失败，或旧实例在迁移后仍写旧文件）；
   * - 全部写完才把旧文件改名 `rescue-log.json.migrated-<ts>`，旧文件永不删除。
   */
  async migrateLegacy(now = Date.now()): Promise<MigrationReport | null> {
    const startedAt = performance.now()
    if (!(await this.io.exists(this.legacyPath))) return null
    // 迁移会写：旧文件（改名）、meta、已存在的分片（合并）。
    // 把这些路径的锁**一起**拿住（按路径排序 ⇒ 无死锁），避免与正在跑的实例互相覆盖。
    const existing = new Set(await this.listDays())
    const targets = [this.legacyPath, this.metaPath, this.shardPath(dayOf(now)), ...[...existing].map((d) => this.shardPath(d))]
    return await withFileLocks(targets, async () => {
      // 拿到锁后重读：另一进程可能刚刚迁移完（旧文件已改名）⇒ 本进程什么都不做
      const raw = await this.io.readText(this.legacyPath)
      if (raw === null) return null
      return await this.splitLegacy(raw, now, startedAt, existing)
    }, { note: 'rescue-log-migrate' })
  }

  private async splitLegacy(raw: string, now: number, startedAt: number, existing: ReadonlySet<string>): Promise<MigrationReport> {
    const bytes = Buffer.byteLength(raw, 'utf8')
    const base: MigrationReport = { at: now, ms: 0, bytes, days: 0, entries: 0, renamedTo: null, skipped: [], why: null }
    let parsed: unknown
    try {
      parsed = JSON.parse(raw) as unknown
    } catch (error) {
      const dest = await this.quarantine(this.legacyPath, now)
      return {
        ...base,
        ms: msSince(startedAt),
        renamedTo: dest,
        why: `旧文件不是合法 JSON（${reasonOf(error)}）⇒ 已隔离归档${dest === null ? '（改名失败）' : `为 ${basename(dest)}`}，未拆分`,
      }
    }
    const doc = (parsed !== null && typeof parsed === 'object' ? parsed : {}) as Record<string, unknown>
    const rawDays = (doc.days !== null && typeof doc.days === 'object' ? doc.days : {}) as Record<string, unknown>
    const entries: AtomicFileSetEntry[] = []
    const skipped: string[] = []
    let written = 0
    let count = 0
    for (const day of Object.keys(rawDays).sort()) {
      const log = rawDays[day]
      if (!isDayKey(day) || log === null || typeof log !== 'object') {
        skipped.push(day)
        continue
      }
      count += countDayEntries(log)
      // 分片已存在（上次迁移中途失败 / 旧实例在迁移后仍往旧文件追加）⇒ **合并**，不覆盖也不丢：
      // 覆盖会丢掉已有分片里的记录，跳过会丢掉旧文件里的记录。
      if (existing.has(day)) {
        const prev = await this.readShardForMerge<Record<string, unknown>>(day, now)
        if (prev.log === null) {
          entries.push({ target: this.shardPath(day), text: JSON.stringify({ v: 1, day, log, updatedAt: now } satisfies DayShard<unknown>, null, 1) })
          written += 1
          continue
        }
        entries.push({
          target: this.shardPath(day),
          text: JSON.stringify({ v: 1, day, log: mergeDayForMigration(prev.log, log as Record<string, unknown>), updatedAt: now } satisfies DayShard<unknown>, null, 1),
        })
        written += 1
        continue
      }
      entries.push({ target: this.shardPath(day), text: JSON.stringify({ v: 1, day, log, updatedAt: now } satisfies DayShard<unknown>, null, 1) })
      written += 1
    }
    // 跨日小题：旧文件里没有日期的那部分原样搬进 meta（已有更新的 meta 就不动它）
    const existingMeta = await this.readMeta(now)
    if (existingMeta.meta === null) {
      entries.push({ target: this.metaPath, text: JSON.stringify(metaOfLegacy(doc, now), null, 1) })
    }
    if (entries.length > 0) await writeFileSetAtomic(entries)
    const dest = `${this.legacyPath}.migrated-${dayStamp(now)}`
    let renamedTo: string | null = dest
    try {
      await rename(this.legacyPath, dest)
    } catch (error) {
      renamedTo = null
      return {
        ...base,
        ms: msSince(startedAt),
        days: written,
        entries: count,
        skipped,
        why: `旧文件改名失败（${reasonOf(error)}）⇒ 旧文件保留原处；分片已写出，下次启动会跳过已存在的分片`,
      }
    }
    return {
      at: now,
      ms: msSince(startedAt),
      bytes,
      days: written,
      entries: count,
      renamedTo,
      skipped,
      why: skipped.length > 0 ? `有 ${skipped.length} 个日期未拆分（键不是合法的 YYYY-MM-DD 北京日期，或值不是对象）：${skipped.slice(0, 3).join('、')}` : null,
    }
  }

  /**
   * 保留上限：删掉窗口外的日分片（`meta.json` 不匹配日期正则 ⇒ 永不被删）。
   * 只删 `< 今天 − (keepDays − 1)` 的文件，即保留「今天 + 最近 keepDays−1 天」。
   */
  async prune(keepDays: number, today: string, now = Date.now()): Promise<PruneReport> {
    const keep = Math.max(1, Math.floor(keepDays))
    const boundary = shiftDay(today, -(keep - 1))
    const removed: string[] = []
    for (const day of await this.listDays()) {
      if (day >= boundary) continue
      try {
        await unlink(this.shardPath(day))
        removed.push(day)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    }
    return { at: now, keepDays: keep, removed, note: removed.length === 0 ? '无需清理' : `已清理 ${removed.length} 天` }
  }
}

/**
 * 迁移时「分片已存在」的合并：按 key 取并集，标量以**已有分片**为准。
 *
 * 为什么以分片为准：分片是新代码写的（计数/缺口标记更可信）；旧文件里同一天的内容可能
 * 只是旧实例的一份旧快照。数组按 key 合并 ⇒ 两边的记录都不丢。
 */
function mergeDayForMigration(disk: Record<string, unknown>, legacy: Record<string, unknown>): Record<string, unknown> {
  const union = (a: unknown, b: unknown, key: string): unknown[] => {
    const seen = new Set<string>()
    const out: unknown[] = []
    for (const row of [...(Array.isArray(a) ? a : []), ...(Array.isArray(b) ? b : [])]) {
      const k = String((row !== null && typeof row === 'object' ? (row as Record<string, unknown>)[key] : row))
      if (seen.has(k)) continue
      seen.add(k)
      out.push(row)
    }
    return out
  }
  const peak: Record<string, unknown> = { ...((legacy.etfPeak ?? {}) as Record<string, unknown>) }
  for (const [secid, v] of Object.entries((disk.etfPeak ?? {}) as Record<string, unknown>)) {
    const prev = peak[secid]
    if (typeof prev !== 'number' || (typeof v === 'number' && v > prev)) peak[secid] = v
  }
  return {
    ...legacy,
    ...disk,
    events: union(disk.events, legacy.events, 'ts'),
    intraday: union(disk.intraday, legacy.intraday, 'hhmm').slice(-120),
    ...(disk.scoreLog === undefined && legacy.scoreLog === undefined ? {} : { scoreLog: union(disk.scoreLog, legacy.scoreLog, 'ts') }),
    etfPeak: peak,
    etfLast: { ...((legacy.etfLast ?? {}) as Record<string, unknown>), ...((disk.etfLast ?? {}) as Record<string, unknown>) },
  }
}

/** 旧单文件里"没有日期"的那部分 ⇒ meta 的初始内容 */
function metaOfLegacy(doc: Record<string, unknown>, now: number): Record<string, unknown> {
  return {
    v: 1,
    lastSnapshot: doc.lastSnapshot ?? null,
    baselines: doc.baselines ?? {},
    selfSamples: doc.selfSamples ?? {},
    progressCurve: doc.progressCurve ?? null,
    progressSd: doc.progressSd ?? null,
    progressDays: typeof doc.progressDays === 'number' ? doc.progressDays : 0,
    updatedAt: typeof doc.updatedAt === 'number' ? doc.updatedAt : now,
  }
}
