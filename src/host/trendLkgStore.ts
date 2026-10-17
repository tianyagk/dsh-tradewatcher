/**
 * `trends-lkg` 的**分片存储**（AUDIT-IMPL76 第 3 项）。
 *
 * 背景（REVIEW-9-PERF §3.2）：旧实现是**单文件整份重写** —— 真机 2.34 MB / 132 条，
 * 每 5 秒要把整份 2.34 MB 重新序列化并覆写一遍。单看"该不该写"还不够：**写的体量**没变。
 *
 * 现在的布局（一次只写变化的那几条）：
 * ```
 * <dataHome>/trends-lkg.json          ← 清单/元数据（v3）：entries[{key, at, seq, bytes}] + caps + dropped
 * <dataHome>/trends-lkg.d/<enc(key)>.json   ← 一条标的的分时序列（v1：{ v, key, trend }）
 * ```
 *  - **写放大**：一次 persist 只写"变了的标的"分片（每条 ≈ 18 KB）+ 清单（≈ 8 KB）；
 *    单次写入上限 `TREND_LKG_MAX_SHARD_WRITE_BYTES`（512 KB）—— 注入回"整份 blob"必然越界。
 *  - **不丢数据**：清单里逐条给 `key/at/seq/bytes`，重载按 `seq` 还原顺序 ⇒ 重建结果与拆分前**逐字节等价**；
 *    分片缺失/损坏**如实报告**（`missing[]`），不静默当"没有这条"。
 *  - **保留口径可见**：`caps` 与 `dropped` 写进清单（并复用 `shared/trendRetention.ts` 的常量给悬停文案），
 *    裁剪**只按最旧丢**、每次都留痕，不静默截断。
 *  - **迁移**：老版单文件（`{ ts, entries }`）在首次装载时拆成分片 + 清单（先备份为
 *    `trends-lkg.v2.json.bak`，清单最后写 = 提交点；中途崩溃下次会重新迁移，幂等）。
 */
import { mkdir, readFile, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'
import type { TrendData } from '../shared/model.ts'
import { payloadFingerprint } from '../shared/fingerprint.ts'
import {
  TREND_LKG_MAX, TREND_LKG_MAX_BYTES, TREND_LKG_MAX_SHARD_WRITE_BYTES,
} from '../shared/trendRetention.ts'
import { writeFileAtomic } from './atomic.ts'

/** 清单文件（沿用旧路径：老装机的迁移检测就看这个文件里有没有 `v: 3`） */
export const TREND_LKG_MANIFEST_FILE = 'trends-lkg.json'
/** 分片目录 */
export const TREND_LKG_DIR = 'trends-lkg.d'
/** 迁移时老文件的备份名（只改文件名，不复制 2.3 MB） */
export const TREND_LKG_LEGACY_BACKUP = 'trends-lkg.v2.json.bak'
export const LKG_SHARD_V = 1
export const LKG_MANIFEST_V = 3
/** 落盘节流：窗口内只 mark dirty，不序列化、不写盘 */
export const LKG_PERSIST_MS = 5000

export interface LkgCaps {
  maxEntries: number
  maxBytes: number
}

export interface LkgManifestEntry {
  key: string
  at: number
  seq: number
  bytes: number
}

export interface LkgDropped {
  key: string
  at: number
  reason: string
}

export interface LkgManifest {
  v: typeof LKG_MANIFEST_V
  ts: number
  caps: LkgCaps & { maxShardWriteBytes: number }
  entries: LkgManifestEntry[]
  dropped: LkgDropped[]
  /** 累计被丢弃过的条数（`dropped` 只留最近 20 条明细） */
  droppedTotal: number
}

/** 分片文件名：`encodeURIComponent(key)`（`1.600519|1` → `1.600519%7C1.json`；可逆、无碰撞） */
export function lkgShardName(key: string): string {
  return `${encodeURIComponent(key)}.json`
}

/** 一条分片的序列化文本（**只含 trend**：`at` 在清单里，改 `at` 不必重写分片） */
export function encodeLkgShard(key: string, trend: TrendData): string {
  return JSON.stringify({ v: LKG_SHARD_V, key, trend })
}

/** 解码一条分片；结构不对 ⇒ `null`（调用方据此如实报告"分片不可用"，不静默丢） */
export function decodeLkgShard(raw: unknown, expectKey: string): TrendData | null {
  if (raw === null || typeof raw !== 'object') return null
  const rec = raw as { v?: unknown; key?: unknown; trend?: unknown }
  if (rec.v !== LKG_SHARD_V || rec.key !== expectKey) return null
  const trend = rec.trend as TrendData | undefined
  if (trend === null || typeof trend !== 'object' || !Array.isArray(trend.points) || trend.points.length < 2) return null
  return trend
}

/** 编解码老版单文件（`{ ts, entries: [{key, at, trend}] }`） */
export function decodeLegacyLkg(raw: unknown): Array<{ key: string; at: number; trend: TrendData }> | null {
  if (raw === null || typeof raw !== 'object') return null
  const rec = raw as { v?: unknown; entries?: unknown }
  if (rec.v === LKG_MANIFEST_V || !Array.isArray(rec.entries)) return null
  const out: Array<{ key: string; at: number; trend: TrendData }> = []
  for (const e of rec.entries) {
    const row = e as { key?: unknown; at?: unknown; trend?: unknown }
    if (typeof row.key !== 'string' || typeof row.at !== 'number') continue
    const trend = row.trend as TrendData | undefined
    if (trend === null || typeof trend !== 'object' || !Array.isArray(trend.points) || trend.points.length < 2) continue
    out.push({ key: row.key, at: row.at, trend })
  }
  return out
}

export function decodeLkgManifest(raw: unknown): LkgManifest | null {
  if (raw === null || typeof raw !== 'object') return null
  const rec = raw as Partial<LkgManifest>
  if (rec.v !== LKG_MANIFEST_V || typeof rec.ts !== 'number' || !Array.isArray(rec.entries)) return null
  const caps = rec.caps as LkgManifest['caps'] | undefined
  const entries: LkgManifestEntry[] = []
  for (const e of rec.entries) {
    const row = e as Partial<LkgManifestEntry>
    if (typeof row.key !== 'string' || typeof row.at !== 'number' || typeof row.seq !== 'number' || typeof row.bytes !== 'number') continue
    entries.push({ key: row.key, at: row.at, seq: row.seq, bytes: row.bytes })
  }
  return {
    v: LKG_MANIFEST_V,
    ts: rec.ts,
    caps: {
      maxEntries: typeof caps?.maxEntries === 'number' ? caps.maxEntries : TREND_LKG_MAX,
      maxBytes: typeof caps?.maxBytes === 'number' ? caps.maxBytes : TREND_LKG_MAX_BYTES,
      maxShardWriteBytes: typeof caps?.maxShardWriteBytes === 'number' ? caps.maxShardWriteBytes : TREND_LKG_MAX_SHARD_WRITE_BYTES,
    },
    entries,
    dropped: Array.isArray(rec.dropped)
      ? rec.dropped.filter((d): d is LkgDropped => typeof d?.key === 'string' && typeof d?.at === 'number' && typeof d?.reason === 'string').slice(-20)
      : [],
    droppedTotal: typeof rec.droppedTotal === 'number' && rec.droppedTotal >= 0 ? rec.droppedTotal : 0,
  }
}

/** 清单序列化（`entries` 按 `seq` 升序 ⇒ 重载顺序稳定；`dropped` 只留最近 20 条明细） */
export function encodeLkgManifest(input: {
  now: number
  caps: LkgCaps
  entries: readonly LkgManifestEntry[]
  dropped: readonly LkgDropped[]
  droppedTotal: number
}): string {
  const manifest: LkgManifest = {
    v: LKG_MANIFEST_V,
    ts: input.now,
    caps: { ...input.caps, maxShardWriteBytes: TREND_LKG_MAX_SHARD_WRITE_BYTES },
    entries: [...input.entries].sort((a, b) => a.seq - b.seq || a.key.localeCompare(b.key)),
    dropped: input.dropped.slice(-20),
    droppedTotal: input.droppedTotal,
  }
  return JSON.stringify(manifest)
}

/**
 * 保留策略（**纯函数**，可测）：先按条数上限丢最旧，再按总体积上限丢最旧。
 * 每一条被丢的都带**原因**（写进清单的 `dropped` ⇒ 悬停里能读到，不静默截断）。
 */
export function planLkgTrim(
  entries: readonly LkgManifestEntry[],
  caps: LkgCaps = { maxEntries: TREND_LKG_MAX, maxBytes: TREND_LKG_MAX_BYTES },
): { kept: LkgManifestEntry[]; dropped: LkgDropped[] } {
  const sorted = [...entries].sort((a, b) => a.at - b.at || a.key.localeCompare(b.key))
  const dropped: LkgDropped[] = []
  let rest = sorted
  while (rest.length > caps.maxEntries) {
    const victim = rest[0]
    rest = rest.slice(1)
    dropped.push({ key: victim.key, at: victim.at, reason: `超过条数上限 ${caps.maxEntries}（按最旧丢弃）` })
  }
  let total = rest.reduce((s, e) => s + e.bytes, 0)
  while (rest.length > 0 && total > caps.maxBytes) {
    const victim = rest[0]
    rest = rest.slice(1)
    total -= victim.bytes
    dropped.push({ key: victim.key, at: victim.at, reason: `超过体积上限 ${Math.round(caps.maxBytes / 1024 / 1024)} MB（按最旧丢弃）` })
  }
  const droppedKeys = new Set(dropped.map((d) => d.key))
  return { kept: sorted.filter((e) => !droppedKeys.has(e.key)), dropped }
}

export interface LkgStoreStats {
  loadedShards: number
  missingShards: number
  migrated: number
  persists: number
  shardWrites: number
  manifestWrites: number
  /** 单次写入的最大字节（判据：≤ `TREND_LKG_MAX_SHARD_WRITE_BYTES`） */
  maxWriteBytes: number
  totalWriteBytes: number
  /** 内容未变（只 `at` 变了/完全没变）⇒ 分片不重写 */
  shardWriteSkipped: number
  dropped: number
}

const EMPTY_STATS: LkgStoreStats = {
  loadedShards: 0, missingShards: 0, migrated: 0, persists: 0,
  shardWrites: 0, manifestWrites: 0, maxWriteBytes: 0, totalWriteBytes: 0, shardWriteSkipped: 0, dropped: 0,
}

interface Entry {
  at: number
  trend: TrendData
  seq: number
  bytes: number
  /** trend 的内容指纹：指纹相同 ⇒ 分片内容没变（`at` 只进清单） */
  fingerprint: number
}

/**
 * 分片兜底库。`dirOf()` 每次写/读时现取数据目录（`DSH_HOME` 在测试里会变），
 * `now()` 可注入（节流窗口的用例不必真等 5 秒）。
 */
export class TrendLkgStore {
  private entries = new Map<string, Entry>()
  private droppedLog: LkgDropped[] = []
  private droppedTotal = 0
  private nextSeq = 1
  private dirty = new Set<string>()
  private manifestDirty = false
  private loaded: Promise<{ missing: Array<{ key: string; reason: string }> }> | null = null
  private lastWrite = 0
  private stats: LkgStoreStats = { ...EMPTY_STATS }
  private caps: LkgCaps = { maxEntries: TREND_LKG_MAX, maxBytes: TREND_LKG_MAX_BYTES }

  /**
   * ⚠ **不要用构造器参数属性**（`constructor(private readonly dirOf: …)`）：
   * 仓库跑 `node --experimental-strip-types`，它只剥类型、不做转换 ⇒ 参数属性直接语法错误
   * （`ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`，会让**所有** `node --test` 起不来）。显式字段 + 赋值。
   */
  private readonly dirOf: () => string
  private readonly now: () => number

  constructor(dirOf: () => string, now: () => number = Date.now) {
    this.dirOf = dirOf
    this.now = now
  }

  /** 装载（幂等；一次进程一次）。返回"分片缺失/损坏"的逐条原因，调用方负责如实上报 */
  load(): Promise<{ missing: Array<{ key: string; reason: string }> }> {
    this.loaded ??= this.doLoad()
    return this.loaded
  }

  private async doLoad(): Promise<{ missing: Array<{ key: string; reason: string }> }> {
    const dir = this.dirOf()
    const manifestPath = join(dir, TREND_LKG_MANIFEST_FILE)
    let raw: unknown = null
    try {
      raw = JSON.parse(await readFile(manifestPath, 'utf8'))
    } catch {
      return { missing: [] } // 首次：什么都没有
    }
    const manifest = decodeLkgManifest(raw)
    if (manifest !== null) {
      this.caps = { maxEntries: manifest.caps.maxEntries, maxBytes: manifest.caps.maxBytes }
      this.droppedLog = [...manifest.dropped]
      this.droppedTotal = manifest.droppedTotal
      const missing: Array<{ key: string; reason: string }> = []
      const shardDir = join(dir, TREND_LKG_DIR)
      for (const meta of [...manifest.entries].sort((a, b) => a.seq - b.seq || a.key.localeCompare(b.key))) {
        const path = join(shardDir, lkgShardName(meta.key))
        try {
          const text = await readFile(path, 'utf8')
          const trend = decodeLkgShard(JSON.parse(text), meta.key)
          if (trend === null) {
            missing.push({ key: meta.key, reason: `分片结构不符合预期（${path}）` })
            continue
          }
          this.entries.set(meta.key, {
            at: meta.at, trend, seq: meta.seq, bytes: typeof meta.bytes === 'number' ? meta.bytes : Buffer.byteLength(text),
            fingerprint: payloadFingerprint(JSON.stringify(trend)),
          })
          this.stats.loadedShards += 1
        } catch (error) {
          missing.push({ key: meta.key, reason: `分片读取失败：${String(error).slice(0, 80)}` })
        }
      }
      this.stats.missingShards += missing.length
      this.nextSeq = Math.max(0, ...[...this.entries.values()].map((e) => e.seq)) + 1
      if (missing.length > 0) {
        console.warn(`[tradewatcher] trends-lkg 有 ${missing.length} 条分片不可用（不静默丢，清单仍保留这些条目）：`, missing.map((m) => m.key).join(' / '))
      }
      return { missing }
    }
    // 老版单文件 ⇒ 迁移
    const legacy = decodeLegacyLkg(raw)
    if (legacy === null) return { missing: [] }
    return this.migrate(legacy)
  }

  private async migrate(legacy: Array<{ key: string; at: number; trend: TrendData }>): Promise<{ missing: Array<{ key: string; reason: string }> }> {
    const dir = this.dirOf()
    for (const e of legacy) {
      this.entries.set(e.key, {
        at: e.at, trend: e.trend, seq: this.nextSeq++, bytes: 0,
        fingerprint: payloadFingerprint(JSON.stringify(e.trend)),
      })
      this.dirty.add(e.key)
    }
    // 先备份（同目录改名，不复制 2.3 MB），再写分片，清单最后写（= 提交点）
    try { await rename(join(dir, TREND_LKG_MANIFEST_FILE), join(dir, TREND_LKG_LEGACY_BACKUP)) } catch { /* 已有备份/目录不存在 */ }
    this.manifestDirty = true
    await this.persist({ force: true })
    this.stats.migrated += legacy.length
    return { missing: [] }
  }

  get(key: string): { at: number; trend: TrendData } | undefined {
    const hit = this.entries.get(key)
    return hit === undefined ? undefined : { at: hit.at, trend: hit.trend }
  }

  get size(): number {
    return this.entries.size
  }

  /**
   * 记一条（`at` = 这次观测时刻）。
   *
   * 分片内容只由 `trend` 决定 ⇒ trend 没变时**不标脏分片**（`at` 的更新走清单，≈8 KB）；
   * 这是"同一条每次刷新都重写 18 KB"的直接解药。
   */
  set(key: string, at: number, trend: TrendData): void {
    const fingerprint = payloadFingerprint(JSON.stringify(trend))
    const prev = this.entries.get(key)
    if (prev === undefined) {
      this.entries.set(key, { at, trend, seq: this.nextSeq++, bytes: 0, fingerprint })
      this.dirty.add(key)
      this.manifestDirty = true
      return
    }
    const shardChanged = prev.fingerprint !== fingerprint
    const atChanged = prev.at !== at
    if (shardChanged) {
      prev.trend = trend
      prev.fingerprint = fingerprint
      this.dirty.add(key)
    }
    if (shardChanged || atChanged) {
      prev.at = at
      this.manifestDirty = true
    }
  }

  /** 落盘（节流 5s；窗口内直接返回，dirty 保留）。`force` 供测试/迁移绕过节流 */
  async persist(opts: { force?: boolean } = {}): Promise<void> {
    const now = this.now()
    if (opts.force !== true && now - this.lastWrite < LKG_PERSIST_MS) return
    if (this.dirty.size === 0 && !this.manifestDirty) return
    this.stats.persists += 1
    const dir = this.dirOf()
    const shardDir = join(dir, TREND_LKG_DIR)
    try {
      await mkdir(shardDir, { recursive: true })
    } catch (error) {
      console.warn('[tradewatcher] trends-lkg 分片目录建不出来：', String(error).slice(0, 120))
      return // dirty 保留，下一轮再试
    }
    // ① 只写"变了的"分片
    let allWritten = true
    for (const key of [...this.dirty]) {
      const entry = this.entries.get(key)
      if (entry === undefined) {
        this.dirty.delete(key)
        continue
      }
      const text = encodeLkgShard(key, entry.trend)
      const bytes = Buffer.byteLength(text)
      if (bytes > TREND_LKG_MAX_SHARD_WRITE_BYTES) {
        console.warn(`[tradewatcher] trends-lkg 单条分片超过 ${Math.round(TREND_LKG_MAX_SHARD_WRITE_BYTES / 1024)} KB 上限（${key}，${Math.round(bytes / 1024)} KB）⇒ 本次未写（不静默丢：清单不记录它，下次还会重试）`)
        continue
      }
      try {
        await writeFileAtomic(join(shardDir, lkgShardName(key)), text)
      } catch (error) {
        console.warn('[tradewatcher] trends-lkg 分片写入失败：', key, String(error).slice(0, 120))
        allWritten = false
        continue
      }
      entry.bytes = bytes
      this.dirty.delete(key)
      this.stats.shardWrites += 1
      this.stats.totalWriteBytes += bytes
      if (bytes > this.stats.maxWriteBytes) this.stats.maxWriteBytes = bytes
    }
    // ② 保留策略（只按最旧丢；每次留痕）
    const trimmed = planLkgTrim(
      [...this.entries.entries()].map(([key, e]) => ({ key, at: e.at, seq: e.seq, bytes: e.bytes })),
      this.caps,
    )
    for (const d of trimmed.dropped) {
      try { await rm(join(shardDir, lkgShardName(d.key)), { force: true }) } catch { /* 删不掉不影响本次 */ }
      this.entries.delete(d.key)
      this.dirty.delete(d.key)
      this.droppedTotal += 1
      this.stats.dropped += 1
    }
    if (trimmed.dropped.length > 0) {
      this.droppedLog = [...this.droppedLog, ...trimmed.dropped]
      console.warn(`[tradewatcher] trends-lkg 超过保留上限（${this.caps.maxEntries} 条 / ${Math.round(this.caps.maxBytes / 1024 / 1024)} MB）：本次按最旧丢弃 ${trimmed.dropped.length} 条 ⇒ ${trimmed.dropped.map((d) => d.key).join(' / ')}（明细已写进 ${TREND_LKG_MANIFEST_FILE} 的 dropped）`)
      this.manifestDirty = true
    }
    // ③ 清单（提交点：里面是重建所需的全部元数据）
    const manifest = encodeLkgManifest({
      now,
      caps: this.caps,
      entries: [...this.entries.entries()].map(([key, e]) => ({ key, at: e.at, seq: e.seq, bytes: e.bytes })),
      dropped: this.droppedLog,
      droppedTotal: this.droppedTotal,
    })
    try {
      await writeFileAtomic(join(dir, TREND_LKG_MANIFEST_FILE), manifest)
      this.stats.manifestWrites += 1
      this.stats.totalWriteBytes += Buffer.byteLength(manifest)
      if (Buffer.byteLength(manifest) > this.stats.maxWriteBytes) this.stats.maxWriteBytes = Buffer.byteLength(manifest)
    } catch (error) {
      console.warn('[tradewatcher] trends-lkg 清单写入失败：', String(error).slice(0, 120))
      allWritten = false
    }
    if (allWritten) {
      this.manifestDirty = false
      this.lastWrite = now
    }
  }

  statsOf(): LkgStoreStats {
    return { ...this.stats }
  }

  /** 测试钩子：本次进程当前全部条目（按 seq 升序；重建等价性用它做逐字节比较） */
  entriesForTest(): Array<{ key: string; at: number; seq: number; trend: TrendData }> {
    return [...this.entries.entries()]
      .sort((a, b) => a[1].seq - b[1].seq || a[0].localeCompare(b[0]))
      .map(([key, e]) => ({ key, at: e.at, seq: e.seq, trend: e.trend }))
  }

  /** 测试钩子：把"已装载"标记清掉（模拟重启：下次 `load()` 重新从磁盘读） */
  __resetLoadedForTest(): void {
    this.loaded = null
  }

  /** 清空内存状态与统计（测试用；不碰磁盘） */
  __resetForTest(): void {
    this.entries.clear()
    this.droppedLog = []
    this.droppedTotal = 0
    this.nextSeq = 1
    this.dirty.clear()
    this.manifestDirty = false
    this.loaded = null
    this.lastWrite = 0
    this.stats = { ...EMPTY_STATS }
    this.caps = { maxEntries: TREND_LKG_MAX, maxBytes: TREND_LKG_MAX_BYTES }
  }

  /** 测试钩子：覆盖保留上限（默认取 `shared/trendRetention.ts` 的常量） */
  __setCapsForTest(caps: LkgCaps): void {
    this.caps = { ...caps }
  }
}
