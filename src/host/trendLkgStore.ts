/**
 * `trends-lkg` 的**分片存储 + 热条内联**（AUDIT-IMPL76 第 3 项 / AUDIT-IMPL77 第 1、4 项）。
 *
 * 布局：
 * ```
 * <dataHome>/trends-lkg.json               ← 清单 v4：
 *   { v:4, ts, caps, migratedFrom?,
 *     entries: [{ key, at, seq, bytes, trend? }],   ← trend 只在"热条"上内联
 *     dropped: [{ key, at, reason }], droppedTotal }
 * <dataHome>/trends-lkg.d/<enc(key)>.json  ← 一条标的的序列（v1：{ v, key, trend }），冷条懒加载
 * <dataHome>/trends-lkg.v2.json.bak        ← 迁移时的老单文件备份（校验通过后才删）
 * ```
 *
 * 为什么要"热条内联"（AUDIT-IMPL77 第 1 项）：AUDIT-IMPL76 拆成分片后，装载要把 111 个分片逐个读回来
 * （实测 **60–65 ms**）。把**最近 N 条**（`TREND_LKG_HOT_MAX`，且受字节预算约束）的 trend 直接放进清单，
 * 装载只需读**一个**文件（清单 ≈ 150 KB）⇒ 目标 ~5 ms；其余条目**懒加载**（首次访问 `ensure()` 才读分片）。
 * 契约不变：
 *  - **逐字节等价**：`ensureAll()` 之后的内存条目序列化与拆分前完全相同（热+冷合并顺序 = `seq`）；
 *  - **单次写 ≤ 512 KB**：热条数量/字节都受预算约束，清单本身也被夹在 `TREND_LKG_MANIFEST_MAX_BYTES`；
 *  - **保留有上限、不静默**：`caps` + `dropped` + `droppedTotal`，守恒判据 `存活 + droppedTotal == 总数`；
 *  - **不丢数据**：分片缺失/损坏如实进 `missing[]`；迁移只在**逐条校验通过**后才删备份，并在清单
 *    `migratedFrom` 里留摘要（条数/字节/时间/sha256）。
 */
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'
import type { TrendData } from '../shared/model.ts'
import { payloadFingerprint } from '../shared/fingerprint.ts'
import {
  TREND_LKG_HOT_MAX, TREND_LKG_MANIFEST_MAX_BYTES, TREND_LKG_MAX, TREND_LKG_MAX_BYTES,
  TREND_LKG_MAX_SHARD_WRITE_BYTES,
} from '../shared/trendRetention.ts'
import { writeFileAtomic } from './atomic.ts'

/** 清单文件（沿用旧路径：迁移检测看版本号） */
export const TREND_LKG_MANIFEST_FILE = 'trends-lkg.json'
/** 分片目录 */
export const TREND_LKG_DIR = 'trends-lkg.d'
/** 迁移时老文件的备份名（校验通过前一直保留） */
export const TREND_LKG_LEGACY_BACKUP = 'trends-lkg.v2.json.bak'
export const LKG_SHARD_V = 1
export const LKG_MANIFEST_V = 4
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
  /** 热条：trend 直接内联在清单里（装载时无需读分片）；冷条没有这个字段 */
  trend?: TrendData
}

export interface LkgDropped {
  key: string
  at: number
  reason: string
}

/** 迁移摘要（AUDIT-IMPL77 第 4 项）：老单文件被拆分/删除的凭据，留在清单里可核对 */
export interface LkgMigratedFrom {
  /** 老文件的格式版本（老单文件没有 v 字段 ⇒ 记 2） */
  v: 2
  /** 迁移时刻（ms） */
  ts: number
  /** 老文件名 */
  file: string
  /** 老文件字节数 */
  bytes: number
  /** 老文件里的条目数 */
  entries: number
  /** 老文件全文的 sha256（十六进制）——删掉之后仍可核对"当时删的是哪份" */
  sha256: string
  /** **逐条校验通过**的分片数；只有 `verifiedShards === entries` 才允许删备份 */
  verifiedShards: number
  /** 校验结论：true 才删备份 */
  verified: boolean
  /** 校验失败的原因（`verified=false` 时必填；界面/日志据此说明"为什么备份还在"） */
  reason: string | null
  /** 备份实际被删除的时刻（`verified=false` ⇒ null） */
  removedAt: number | null
}

export interface LkgManifest {
  v: typeof LKG_MANIFEST_V
  ts: number
  caps: LkgCaps & { maxShardWriteBytes: number; hotMax: number; manifestMaxBytes: number }
  entries: LkgManifestEntry[]
  dropped: LkgDropped[]
  /** 累计被丢弃过的条数（`dropped` 只留最近 20 条明细） */
  droppedTotal: number
  migratedFrom?: LkgMigratedFrom
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
  if (rec.v !== undefined || !Array.isArray(rec.entries)) return null
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
  const v = rec.v
  if ((v !== LKG_MANIFEST_V && v !== 3) || typeof rec.ts !== 'number' || !Array.isArray(rec.entries)) return null
  const caps = rec.caps as LkgManifest['caps'] | undefined
  const entries: LkgManifestEntry[] = []
  for (const e of rec.entries) {
    const row = e as Partial<LkgManifestEntry>
    if (typeof row.key !== 'string' || typeof row.at !== 'number' || typeof row.seq !== 'number' || typeof row.bytes !== 'number') continue
    const trend = row.trend as TrendData | undefined
    const okTrend = trend !== null && typeof trend === 'object' && Array.isArray(trend.points) && trend.points.length >= 2
    entries.push({ key: row.key, at: row.at, seq: row.seq, bytes: row.bytes, ...(okTrend ? { trend } : {}) })
  }
  const migrated = rec.migratedFrom as LkgMigratedFrom | undefined
  const migratedFrom: LkgMigratedFrom | undefined =
    migrated !== undefined && typeof migrated === 'object' && typeof migrated.sha256 === 'string' && typeof migrated.entries === 'number'
      ? {
          v: 2,
          ts: typeof migrated.ts === 'number' ? migrated.ts : 0,
          file: typeof migrated.file === 'string' ? migrated.file : TREND_LKG_LEGACY_BACKUP,
          bytes: typeof migrated.bytes === 'number' ? migrated.bytes : 0,
          entries: migrated.entries,
          sha256: migrated.sha256,
          verifiedShards: typeof migrated.verifiedShards === 'number' ? migrated.verifiedShards : 0,
          verified: migrated.verified === true,
          reason: typeof migrated.reason === 'string' ? migrated.reason : null,
          removedAt: typeof migrated.removedAt === 'number' ? migrated.removedAt : null,
        }
      : undefined
  return {
    v: LKG_MANIFEST_V,
    ts: rec.ts,
    caps: {
      maxEntries: typeof caps?.maxEntries === 'number' ? caps.maxEntries : TREND_LKG_MAX,
      maxBytes: typeof caps?.maxBytes === 'number' ? caps.maxBytes : TREND_LKG_MAX_BYTES,
      maxShardWriteBytes: typeof caps?.maxShardWriteBytes === 'number' ? caps.maxShardWriteBytes : TREND_LKG_MAX_SHARD_WRITE_BYTES,
      hotMax: typeof caps?.hotMax === 'number' ? caps.hotMax : TREND_LKG_HOT_MAX,
      manifestMaxBytes: typeof caps?.manifestMaxBytes === 'number' ? caps.manifestMaxBytes : TREND_LKG_MANIFEST_MAX_BYTES,
    },
    entries,
    dropped: Array.isArray(rec.dropped)
      ? rec.dropped.filter((d): d is LkgDropped => typeof d?.key === 'string' && typeof d?.at === 'number' && typeof d?.reason === 'string').slice(-20)
      : [],
    droppedTotal: typeof rec.droppedTotal === 'number' && rec.droppedTotal >= 0 ? rec.droppedTotal : 0,
    ...(migratedFrom === undefined ? {} : { migratedFrom }),
  }
}

/**
 * **热条选择**（纯函数）：按 `at` 新→旧，最多 `hotMax` 条，且内联后的清单不超过 `manifestMaxBytes`。
 *
 * 为什么还要字节预算：单条 trend 可到几十 KB，`hotMax` 配大了（或某条特别大）会让清单本身
 * 超过"单次写 ≤ 512 KB"的红线。预算不够时就少放几条（宁可变冷，也不越界）。
 */
export function planHotEntries(
  entries: readonly LkgManifestEntry[],
  caps: { hotMax: number; manifestMaxBytes: number; baseBytes: number },
): { hotKeys: Set<string>; hotBytes: number } {
  const hotKeys = new Set<string>()
  if (caps.hotMax <= 0) return { hotKeys, hotBytes: 0 }
  const byNewest = [...entries].filter((e) => e.trend !== undefined).sort((a, b) => b.at - a.at || a.key.localeCompare(b.key))
  let bytes = Math.max(0, caps.baseBytes)
  for (const e of byNewest) {
    if (hotKeys.size >= caps.hotMax) break
    // 内联一条 ≈ 序列化 trend 的长度 + 少量键名；用分片字节数（已记）做上界估计，足够保守
    const cost = (e.trend === undefined ? 0 : Buffer.byteLength(JSON.stringify(e.trend))) + 48
    if (bytes + cost > caps.manifestMaxBytes) break
    hotKeys.add(e.key)
    bytes += cost
  }
  return { hotKeys, hotBytes: bytes }
}

/** 清单序列化（`entries` 按 `seq` 升序；热条内联 `trend`；`dropped` 只留最近 20 条明细） */
export function encodeLkgManifest(input: {
  now: number
  caps: LkgCaps
  entries: readonly LkgManifestEntry[]
  dropped: readonly LkgDropped[]
  droppedTotal: number
  migratedFrom?: LkgMigratedFrom
}): string {
  const manifest: LkgManifest = {
    v: LKG_MANIFEST_V,
    ts: input.now,
    caps: {
      ...input.caps,
      maxShardWriteBytes: TREND_LKG_MAX_SHARD_WRITE_BYTES,
      hotMax: TREND_LKG_HOT_MAX,
      manifestMaxBytes: TREND_LKG_MANIFEST_MAX_BYTES,
    },
    entries: [...input.entries].sort((a, b) => a.seq - b.seq || a.key.localeCompare(b.key)),
    dropped: input.dropped.slice(-20),
    droppedTotal: input.droppedTotal,
    ...(input.migratedFrom === undefined ? {} : { migratedFrom: input.migratedFrom }),
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
  /** 本次装载从磁盘读回来的分片数（热条不读 ⇒ 远小于总数） */
  loadedShards: number
  /** 装载后仍需懒加载的条目数 */
  coldEntries: number
  /** 懒加载实际读回的分片数（`ensure`/`ensureAll`） */
  ensures: number
  missingShards: number
  migrated: number
  /** 迁移时逐条校验通过的分片数 */
  verifiedShards: number
  /** 迁移校验失败 ⇒ 备份保留（0 = 正常） */
  verifyFailures: number
  /** 备份被删除的次数（1 = 迁移完成并清理） */
  backupsRemoved: number
  persists: number
  shardWrites: number
  manifestWrites: number
  /** 单次写入的最大字节（分片或清单；判据：≤ `TREND_LKG_MAX_SHARD_WRITE_BYTES`） */
  maxWriteBytes: number
  /** 单条分片写入的最大字节（判据：单条分片远小于清单/上限） */
  maxShardWriteBytes: number
  totalWriteBytes: number
  shardWriteSkipped: number
  dropped: number
}

const EMPTY_STATS: LkgStoreStats = {
  loadedShards: 0, coldEntries: 0, ensures: 0, missingShards: 0, migrated: 0, verifiedShards: 0,
  verifyFailures: 0, backupsRemoved: 0, persists: 0, shardWrites: 0, manifestWrites: 0,
  maxWriteBytes: 0, maxShardWriteBytes: 0, totalWriteBytes: 0, shardWriteSkipped: 0, dropped: 0,
}

interface Entry {
  at: number
  trend: TrendData | null
  seq: number
  bytes: number
  /** trend 的内容指纹（`trend === null` 时是冷条，未知） */
  fingerprint: number | null
}

/**
 * 分片兜底库。`dirOf()` 每次写/读时现取数据目录（`DSH_HOME` 在测试里会变），
 * `now()` 可注入（节流窗口的用例不必真等 5 秒）。
 */
export class TrendLkgStore {
  private entries = new Map<string, Entry>()
  private droppedLog: LkgDropped[] = []
  private droppedTotal = 0
  private migratedFrom: LkgMigratedFrom | undefined
  private nextSeq = 1
  private dirty = new Set<string>()
  private manifestDirty = false
  private loaded: Promise<{ missing: Array<{ key: string; reason: string }> }> | null = null
  private lastWrite = 0
  private stats: LkgStoreStats = { ...EMPTY_STATS }
  private caps: LkgCaps = { maxEntries: TREND_LKG_MAX, maxBytes: TREND_LKG_MAX_BYTES }
  private inflight = new Map<string, Promise<boolean>>()
  private verifyFaultForTest: string | null = null

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

  /** 装载清单（热条直接可用；冷条登记为待懒加载）。幂等。 */
  load(): Promise<{ missing: Array<{ key: string; reason: string }> }> {
    this.loaded ??= this.doLoad()
    return this.loaded
  }

  private async doLoad(): Promise<{ missing: Array<{ key: string; reason: string }> }> {
    const dir = this.dirOf()
    const manifestPath = join(dir, TREND_LKG_MANIFEST_FILE)
    let rawText: string
    try {
      rawText = await readFile(manifestPath, 'utf8')
    } catch {
      return { missing: [] } // 首次：什么都没有
    }
    const raw = JSON.parse(rawText) as unknown
    const rawVersion = (raw as { v?: unknown }).v
    const manifest = decodeLkgManifest(raw)
    if (manifest !== null) {
      this.caps = { maxEntries: manifest.caps.maxEntries, maxBytes: manifest.caps.maxBytes }
      this.droppedLog = [...manifest.dropped]
      this.droppedTotal = manifest.droppedTotal
      this.migratedFrom = manifest.migratedFrom
      const missing: Array<{ key: string; reason: string }> = []
      let cold = 0
      for (const meta of [...manifest.entries].sort((a, b) => a.seq - b.seq || a.key.localeCompare(b.key))) {
        if (meta.trend !== undefined) {
          // 热条：清单里就有，装载不再读分片
          this.entries.set(meta.key, {
            at: meta.at, trend: meta.trend, seq: meta.seq, bytes: meta.bytes,
            fingerprint: payloadFingerprint(JSON.stringify(meta.trend)),
          })
          this.stats.loadedShards += 1
          continue
        }
        // 冷条：登记占位，首次访问时 ensure() 读分片
        this.entries.set(meta.key, { at: meta.at, trend: null, seq: meta.seq, bytes: meta.bytes, fingerprint: null })
        cold += 1
      }
      this.stats.coldEntries = cold
      this.nextSeq = Math.max(0, ...[...this.entries.values()].map((e) => e.seq)) + 1
      if (this.migratedFrom !== undefined && this.migratedFrom.verified === false && this.migratedFrom.reason !== null) {
        console.warn(`[tradewatcher] trends-lkg 迁移校验未通过 ⇒ 备份 ${this.migratedFrom.file} 保留：${this.migratedFrom.reason}`)
      }
      void this.ensureAll().catch(() => undefined) // 后台补冷条（不阻塞装载；ensure 仍会按需等待）
      if (rawVersion !== LKG_MANIFEST_V) {
        // 老清单（v3：全部冷条）⇒ 后台升级到 v4（热条内联）：下次装载只读一个文件
        this.manifestDirty = true
        void this.persist({ force: true }).catch(() => undefined)
      }
      // 已有备份（v0.106 的分片化留下的 2.3 MB 老文件）：**校验通过才清理**（AUDIT-IMPL77 第 4 项）
      await this.verifyExistingBackup(dir)
      return { missing }
    }
    // 老版单文件 ⇒ 迁移
    const legacy = decodeLegacyLkg(raw)
    if (legacy === null) return { missing: [] }
    return this.migrate(legacy, rawText)
  }

  /**
   * 迁移：老单文件 → 分片 + 清单 v4（热条内联）。
   *
   * **删备份的条件**：把写出去的每个分片**读回来解码**，逐条与内存里的 trend 指纹比对；
   * 只有 `verifiedShards === entries.length` 才删备份并把摘要（条数/字节/时间/sha256）写进清单。
   * 任何一条对不上 ⇒ **保留备份**、把原因写进 `migratedFrom.reason` 并 console.warn（界面/日志可见）。
   */
  private async migrate(
    legacy: Array<{ key: string; at: number; trend: TrendData }>,
    rawText: string,
  ): Promise<{ missing: Array<{ key: string; reason: string }> }> {
    const dir = this.dirOf()
    const backupPath = join(dir, TREND_LKG_LEGACY_BACKUP)
    const sha256 = createHash('sha256').update(rawText).digest('hex')
    for (const e of legacy) {
      this.entries.set(e.key, {
        at: e.at, trend: e.trend, seq: this.nextSeq++, bytes: 0,
        fingerprint: payloadFingerprint(JSON.stringify(e.trend)),
      })
      this.dirty.add(e.key)
    }
    // 先备份（同目录改名，不复制 2.3 MB），再写分片；清单最后写（= 提交点）
    try { await rename(join(dir, TREND_LKG_MANIFEST_FILE), backupPath) } catch { /* 已有备份/目录不存在 */ }
    await this.writeDirtyShards()
    this.stats.migrated += legacy.length
    // 逐条校验（读回 → 解码 → 比指纹）
    const shardDir = join(dir, TREND_LKG_DIR)
    let verified = 0
    const failures: string[] = []
    for (const e of legacy) {
      const key = e.key
      if (this.verifyFaultForTest === key) {
        failures.push(`${key}（注入的校验故障）`)
        continue
      }
      try {
        const text = await readFile(join(shardDir, lkgShardName(key)), 'utf8')
        const trend = decodeLkgShard(JSON.parse(text), key)
        if (trend === null) {
          failures.push(`${key}（分片解码失败）`)
          continue
        }
        if (payloadFingerprint(JSON.stringify(trend)) !== payloadFingerprint(JSON.stringify(e.trend))) {
          failures.push(`${key}（内容与迁移前不一致）`)
          continue
        }
        verified += 1
      } catch (error) {
        failures.push(`${key}（读回失败：${String(error).slice(0, 60)}）`)
      }
    }
    this.stats.verifiedShards += verified
    const allVerified = failures.length === 0 && verified === legacy.length
    let removedAt: number | null = null
    if (allVerified) {
      try {
        await rm(backupPath, { force: true })
        removedAt = this.now()
        this.stats.backupsRemoved += 1
        console.warn(`[tradewatcher] trends-lkg 迁移完成并校验通过（${verified}/${legacy.length} 条）⇒ 已清理老备份 ${TREND_LKG_LEGACY_BACKUP}（sha256 ${sha256.slice(0, 12)}…）`)
      } catch (error) {
        failures.push(`备份删除失败：${String(error).slice(0, 60)}`)
      }
    }
    const ok = allVerified && removedAt !== null
    if (!ok) {
      this.stats.verifyFailures += 1
      console.warn(`[tradewatcher] trends-lkg 迁移校验未通过（${verified}/${legacy.length} 条）⇒ 保留老备份（不静默删） ${TREND_LKG_LEGACY_BACKUP}：${failures.slice(0, 5).join(' / ')}`)
    }
    this.migratedFrom = {
      v: 2,
      ts: this.now(),
      file: TREND_LKG_LEGACY_BACKUP,
      bytes: Buffer.byteLength(rawText),
      entries: legacy.length,
      sha256,
      verifiedShards: verified,
      verified: ok,
      reason: ok ? null : (failures.slice(0, 5).join(' / ') || '未通过逐条校验'),
      removedAt,
    }
    this.manifestDirty = true
    await this.persist({ force: true })
    return { missing: [] }
  }

  /**
   * 已有备份的**校验清理**（AUDIT-IMPL77 第 4 项）：清单已是 v3/v4、但 `trends-lkg.v2.json.bak` 还在。
   *
   * 判据（全部满足才删）：
   *  ① 备份能按老格式解码，且条目数 == 清单 `entries` 数；
   *  ② 每一条 `key` 都在清单里，`at` 一致；
   *  ③ 每一条的 trend 指纹与清单/分片里的**完全一致**。
   * 任一不满足 ⇒ **保留备份**，把原因写进 `migratedFrom.reason` 并 console.warn（不静默删用户数据）。
   */
  private async verifyExistingBackup(dir: string): Promise<void> {
    const backupPath = join(dir, TREND_LKG_LEGACY_BACKUP)
    if (!existsSync(backupPath)) return
    let rawText = ''
    try {
      rawText = await readFile(backupPath, 'utf8')
    } catch (error) {
      console.warn(`[tradewatcher] trends-lkg 备份存在但读不出来（${String(error).slice(0, 80)}）⇒ 不清理`)
      return
    }
    const sha256 = createHash('sha256').update(rawText).digest('hex')
    const legacy = decodeLegacyLkg(JSON.parse(rawText) as unknown)
    const failures: string[] = []
    let verified = 0
    if (legacy === null) {
      failures.push('备份内容不是可识别的老格式')
    } else {
      if (legacy.length !== this.entries.size) failures.push(`条目数不一致（备份 ${legacy.length} / 清单 ${this.entries.size}）`)
      for (const e of legacy) {
        const hit = this.entries.get(e.key)
        if (hit === undefined) {
          failures.push(`${e.key} 在清单里不存在`)
          continue
        }
        if (hit.at !== e.at) {
          failures.push(`${e.key} 的 at 不一致（备份 ${e.at} / 清单 ${hit.at}）`)
          continue
        }
        const mine = hit.trend === null ? await this.ensure(e.key) : true
        const trend = this.entries.get(e.key)?.trend ?? null
        if (!mine || trend === null) {
          failures.push(`${e.key} 的分片读不回来`)
          continue
        }
        if (payloadFingerprint(JSON.stringify(trend)) !== payloadFingerprint(JSON.stringify(e.trend))) {
          failures.push(`${e.key} 的内容与备份不一致`)
          continue
        }
        verified += 1
      }
    }
    const ok = failures.length === 0 && verified === this.entries.size && legacy !== null && verified === legacy.length
    let removedAt: number | null = null
    if (ok) {
      try {
        await rm(backupPath, { force: true })
        removedAt = this.now()
        this.stats.backupsRemoved += 1
        console.warn(`[tradewatcher] trends-lkg 老备份校验通过（${verified}/${this.entries.size} 条）⇒ 已清理 ${TREND_LKG_LEGACY_BACKUP}（sha256 ${sha256.slice(0, 12)}…）`)
      } catch (error) {
        failures.push(`备份删除失败：${String(error).slice(0, 60)}`)
      }
    } else {
      this.stats.verifyFailures += 1
      console.warn(`[tradewatcher] trends-lkg 老备份校验未通过 ⇒ 保留 ${TREND_LKG_LEGACY_BACKUP}（不静默删）：${failures.slice(0, 5).join(' / ')}`)
    }
    this.stats.verifiedShards += verified
    this.migratedFrom = {
      v: 2,
      ts: this.migratedFrom?.ts ?? this.now(),
      file: TREND_LKG_LEGACY_BACKUP,
      bytes: Buffer.byteLength(rawText),
      entries: legacy?.length ?? 0,
      sha256,
      verifiedShards: verified,
      verified: removedAt !== null,
      reason: removedAt === null ? (failures.slice(0, 5).join(' / ') || '未通过逐条校验') : null,
      removedAt,
    }
    this.manifestDirty = true
    await this.persist({ force: true })
  }

  /** 热条 + 内存条目（同步读；冷条返回 null —— 需要数据用 `getOrLoad`） */
  get(key: string): { at: number; trend: TrendData } | undefined {
    const hit = this.entries.get(key)
    if (hit === undefined || hit.trend === null) return undefined
    return { at: hit.at, trend: hit.trend }
  }

  /**
   * 取一条（冷条会**懒加载**分片）。读不到 ⇒ `undefined` 并把原因记进 `missing`。
   * 并发同 key 只读一次（in-flight 合并）。
   */
  async getOrLoad(key: string): Promise<{ at: number; trend: TrendData } | undefined> {
    const hit = this.entries.get(key)
    if (hit === undefined) return undefined
    if (hit.trend !== null) return { at: hit.at, trend: hit.trend }
    const ok = await this.ensure(key)
    if (!ok) return undefined
    const loaded = this.entries.get(key)
    return loaded === undefined || loaded.trend === null ? undefined : { at: loaded.at, trend: loaded.trend }
  }

  /** 懒加载一条冷条；热条直接 true。失败 ⇒ false（原因进 `missing`） */
  async ensure(key: string): Promise<boolean> {
    const hit = this.entries.get(key)
    if (hit === undefined) return false
    if (hit.trend !== null) return true
    const pending = this.inflight.get(key)
    if (pending !== undefined) return pending
    const run = (async (): Promise<boolean> => {
      try {
        const text = await readFile(join(this.dirOf(), TREND_LKG_DIR, lkgShardName(key)), 'utf8')
        const trend = decodeLkgShard(JSON.parse(text), key)
        if (trend === null) {
          this.missing.push({ key, reason: `分片结构不符合预期（${lkgShardName(key)}）` })
          return false
        }
        hit.trend = trend
        hit.bytes = Buffer.byteLength(text)
        hit.fingerprint = payloadFingerprint(JSON.stringify(trend))
        this.stats.ensures += 1
        return true
      } catch (error) {
        this.missing.push({ key, reason: `分片读取失败：${String(error).slice(0, 80)}` })
        return false
      } finally {
        this.inflight.delete(key)
      }
    })()
    this.inflight.set(key, run)
    return run
  }

  /**
   * 把所有冷条读回来（后台预热 / 测试 / 离线核对用；并发 8）。
   *
   * 读完若有新条目变成"有 trend"，就把清单标脏并**补写一次**（让它们进热条）——
   * 否则冷条永远是冷的，每次启动都要为同一个标的读分片。这一次写 ≈ 清单大小（≤512 KB），
   * 只发生在"后台预热读完"之后，不是每条一次。
   */
  async ensureAll(): Promise<void> {
    const coldKeys = [...this.entries.entries()].filter(([, e]) => e.trend === null).map(([k]) => k)
    if (coldKeys.length === 0) return
    const queue = [...coldKeys]
    let loaded = 0
    const workers = Array.from({ length: Math.min(8, Math.max(1, queue.length)) }, async () => {
      for (;;) {
        const key = queue.shift()
        if (key === undefined) return
        if (await this.ensure(key)) loaded += 1
      }
    })
    await Promise.all(workers)
    if (loaded > 0) {
      this.manifestDirty = true
      await this.persist({ force: true }).catch(() => undefined)
    }
  }

  private missing: Array<{ key: string; reason: string }> = []

  get size(): number {
    return this.entries.size
  }

  /**
   * 记一条（`at` = 这次观测时刻）。
   *
   * 分片内容只由 `trend` 决定 ⇒ trend 没变时**不标脏分片**（`at` 的更新走清单）；
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

  /** 写"变了的"分片（迁移与常驻共用）。返回是否全部写成功 */
  private async writeDirtyShards(): Promise<boolean> {
    const dir = this.dirOf()
    const shardDir = join(dir, TREND_LKG_DIR)
    try {
      await mkdir(shardDir, { recursive: true })
    } catch (error) {
      console.warn('[tradewatcher] trends-lkg 分片目录建不出来：', String(error).slice(0, 120))
      return false
    }
    let allWritten = true
    for (const key of [...this.dirty]) {
      const entry = this.entries.get(key)
      if (entry === undefined || entry.trend === null) {
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
      if (bytes > this.stats.maxShardWriteBytes) this.stats.maxShardWriteBytes = bytes
    }
    return allWritten
  }

  /**
   * 落盘（节流 5s；窗口内直接返回，dirty 保留）。`force` 供测试/迁移绕过节流。
   *
   * **串行化**：装载升级、后台预热、业务刷新可能同时触发写；并发写会撞同一个 `*.tmp`
   * （实测过一次 `ENOENT rename trends-lkg.json.tmp`）。这里用一个 promise 链把写排成队。
   */
  async persist(opts: { force?: boolean } = {}): Promise<void> {
    const run = this.writeChain.then(() => this.doPersist(opts))
    this.writeChain = run.catch(() => undefined)
    return run
  }

  private writeChain: Promise<void> = Promise.resolve()

  private async doPersist(opts: { force?: boolean } = {}): Promise<void> {
    const now = this.now()
    if (opts.force !== true && now - this.lastWrite < LKG_PERSIST_MS) return
    if (this.dirty.size === 0 && !this.manifestDirty) return
    this.stats.persists += 1
    const shardsOk = await this.writeDirtyShards()
    // 保留策略（只按最旧丢；每次留痕）
    const trimmed = planLkgTrim(
      [...this.entries.entries()].map(([key, e]) => ({ key, at: e.at, seq: e.seq, bytes: e.bytes })),
      this.caps,
    )
    const dir = this.dirOf()
    for (const d of trimmed.dropped) {
      try { await rm(join(dir, TREND_LKG_DIR, lkgShardName(d.key)), { force: true }) } catch { /* 删不掉不影响本次 */ }
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
    // 清单（热条内联；预算不够就少放几条）
    const allEntries = [...this.entries.entries()].map(([key, e]) => ({
      key, at: e.at, seq: e.seq, bytes: e.bytes,
      ...(e.trend === null ? {} : { trend: e.trend }),
    }))
    const baseBytes = Buffer.byteLength(JSON.stringify({ v: LKG_MANIFEST_V, ts: now, caps: this.caps, dropped: this.droppedLog, droppedTotal: this.droppedTotal })) + 1024
    const hot = planHotEntries(allEntries, { hotMax: TREND_LKG_HOT_MAX, manifestMaxBytes: TREND_LKG_MANIFEST_MAX_BYTES, baseBytes })
    const manifest = encodeLkgManifest({
      now,
      caps: this.caps,
      entries: allEntries.map((e) => (e.trend !== undefined && hot.hotKeys.has(e.key) ? e : { key: e.key, at: e.at, seq: e.seq, bytes: e.bytes })),
      dropped: this.droppedLog,
      droppedTotal: this.droppedTotal,
      ...(this.migratedFrom === undefined ? {} : { migratedFrom: this.migratedFrom }),
    })
    let manifestOk = true
    try {
      await writeFileAtomic(join(dir, TREND_LKG_MANIFEST_FILE), manifest)
      this.stats.manifestWrites += 1
      const len = Buffer.byteLength(manifest)
      this.stats.totalWriteBytes += len
      if (len > this.stats.maxWriteBytes) this.stats.maxWriteBytes = len
    } catch (error) {
      console.warn('[tradewatcher] trends-lkg 清单写入失败：', String(error).slice(0, 120))
      manifestOk = false
    }
    if (shardsOk && manifestOk) {
      this.manifestDirty = false
      this.lastWrite = now
    }
  }

  statsOf(): LkgStoreStats {
    return { ...this.stats }
  }

  /** 装载/懒加载过程中读不到的分片（逐条原因；不静默丢） */
  missingOf(): Array<{ key: string; reason: string }> {
    return [...this.missing]
  }

  /** 迁移摘要（没迁移过 ⇒ undefined） */
  migratedFromOf(): LkgMigratedFrom | undefined {
    return this.migratedFrom
  }

  /** 测试钩子：本次进程当前全部条目（按 seq 升序；**含未加载的冷条**，`trend` 为 null 表示还没读） */
  entriesForTest(): Array<{ key: string; at: number; seq: number; trend: TrendData | null }> {
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
    this.migratedFrom = undefined
    this.nextSeq = 1
    this.dirty.clear()
    this.manifestDirty = false
    this.loaded = null
    this.lastWrite = 0
    this.stats = { ...EMPTY_STATS }
    this.caps = { maxEntries: TREND_LKG_MAX, maxBytes: TREND_LKG_MAX_BYTES }
    this.inflight.clear()
    this.missing = []
  }

  /** 测试钩子：覆盖保留上限（默认取 `shared/trendRetention.ts` 的常量） */
  __setCapsForTest(caps: LkgCaps): void {
    this.caps = { ...caps }
  }

  /** 测试钩子：让某条分片在迁移校验时"读不回来"（验证失败分支：备份必须保留） */
  __failVerifyForTest(key: string | null): void {
    this.verifyFaultForTest = key
  }
}
