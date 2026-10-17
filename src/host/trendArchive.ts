/**
 *  - **体积保护**：单文件 / 该标的总量超过上限时**不写**并如实报告（长期运行的插件不能悄悄写满磁盘）；
 */
import { mkdir, readFile, readdir, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { TrendPoint } from '../shared/model.ts'
import { SECID_RE } from '../shared/model.ts'
import { payloadFingerprint } from '../shared/fingerprint.ts'
import { dataHome } from './store.ts'
import { writeFileAtomic } from './atomic.ts'

/** 保留最近多少个**交易日**的归档（够五日 + 余量） */
export const TREND_ARCHIVE_KEEP_DAYS = 12
/** 单日文件上限：超过就不写（正常一天几十 KB，留足余量） */
export const TREND_ARCHIVE_MAX_FILE_BYTES = 512 * 1024
/** 单标的总量上限：超过就不写（12 天 × 几十 KB 远低于此） */
export const TREND_ARCHIVE_MAX_TOTAL_BYTES = 8 * 1024 * 1024
/** 一天至少这么多点才值得归档（1 个点没有拼接价值） */
export const TREND_ARCHIVE_MIN_POINTS = 2

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/
const DAY_FILE_RE = /^\d{4}-\d{2}-\d{2}\.json$/

/** 归档根目录（`<dataHome>/trends`） */
export function trendArchiveRoot(): string {
  return join(dataHome(), 'trends')
}

/** 某标的的归档目录；secid 非法时返回 null（调用方据此跳过归档，不抛） */
export function trendArchiveDir(secid: string): string | null {
  if (!SECID_RE.test(secid)) return null
  return join(trendArchiveRoot(), secid)
}

interface TrendDayFile {
  v: 1
  secid: string
  day: string
  updatedAt: number
  /** 紧凑列式：[t, price, avg, vol, amount, label] */
  points: Array<[number, number, number | null, number | null, number | null, string]>
}

/** 点位 → 落盘格式（纯函数，便于断言） */
export function encodeTrendDay(secid: string, day: string, points: readonly TrendPoint[], updatedAt = Date.now()): TrendDayFile {
  return {
    v: 1,
    secid,
    day,
    updatedAt,
    points: points.map((p) => [p.t, p.price, p.avg ?? null, p.vol ?? null, p.amount ?? null, p.label]),
  }
}

/** 落盘格式 → 点位；形状不对返回 null（坏文件不让它污染拼接） */
export function decodeTrendDay(raw: unknown): { day: string; points: TrendPoint[] } | null {
  if (typeof raw !== 'object' || raw === null) return null
  const f = raw as Partial<TrendDayFile>
  if (f.v !== 1 || typeof f.day !== 'string' || !DAY_RE.test(f.day)) return null
  if (!Array.isArray(f.points)) return null
  const points: TrendPoint[] = []
  for (const row of f.points) {
    if (!Array.isArray(row) || row.length < 6) continue
    const [t, price, avg, vol, amount, label] = row as [unknown, unknown, unknown, unknown, unknown, unknown]
    if (typeof t !== 'number' || typeof price !== 'number' || typeof label !== 'string') continue
    if (!Number.isFinite(t) || !Number.isFinite(price) || price <= 0) continue
    points.push({
      t,
      label,
      price,
      avg: typeof avg === 'number' && avg > 0 ? avg : null,
      vol: typeof vol === 'number' ? vol : null,
      amount: typeof amount === 'number' ? amount : null,
    })
  }
  return points.length > 0 ? { day: f.day, points } : null
}

/**
 * 同一 secid 的写操作串行化：两次并发请求同时归档同一天时，
 * 不能一个读到半个文件、也不能让 rename 抢同一个目标。
 */
const writeChains = new Map<string, Promise<unknown>>()

function serialize<T>(key: string, task: () => Promise<T>): Promise<T> {
  const prev = writeChains.get(key) ?? Promise.resolve()
  const next = prev.then(task, task)
  writeChains.set(
    key,
    next.catch(() => undefined),
  )
  void next.then(() => {
    if (writeChains.get(key) === next) writeChains.delete(key)
  }).catch(() => undefined)
  return next
}

export interface TrendArchiveWriteResult {
  /** 实际写入（或覆盖）的日期 */
  saved: string[]
  /** 没写的：体积超限 / 点数不足 / secid 非法 / 写失败（原因如实给出） */
  skipped: Array<{ day: string; reason: string }>
  /** 滚动清理删掉的旧文件数 */
  pruned: number
}

export interface TrendArchiveEntry {
  day: string
  points: readonly TrendPoint[]
}

/**
 * **一次** `readdir` 拿到该目录的日期文件名（升序）。
 *
 * ⚠ 为什么单独抽出来：旧实现每个 entry 都调一次 `dirSize`（各自 `readdir` + 每个文件一次 `stat`），
 * 5 日档一次 `/trend` 就是 5 次 readdir + 60 次 statx（REVIEW-9-PERF §3.3 实测 68 statx/次）。
 * 现在**每轮最多一次**，且只有"确实要写"的那轮才会调。
 */
async function readDayNames(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir)).filter((n) => DAY_FILE_RE.test(n)).sort()
  } catch {
    return [] // 目录还不存在：从本版起累积
  }
}

/** 该目录里日期文件的字节和（复用已读到的 names，不再 readdir） */
async function dirSizeOf(dir: string, names: readonly string[]): Promise<number> {
  let total = 0
  for (const name of names) {
    try {
      total += (await stat(join(dir, name))).size
    } catch {
      /* 刚被删掉/读不到就不计入 */
    }
  }
  return total
}

/** 只删自己目录里 `YYYY-MM-DD.json`，保留最近 keepDays 个（按文件名降序即日期降序） */
async function prune(dir: string, keepDays: number, knownNames?: readonly string[]): Promise<number> {
  const names = (knownNames === undefined ? await readDayNames(dir) : [...knownNames]).slice()
  const drop = names.slice(0, Math.max(0, names.length - keepDays))
  for (const name of drop) {
    try {
      await rm(join(dir, name), { force: true })
    } catch {
      /* 删不掉不影响本次归档 */
    }
  }
  return drop.length
}

/**
 * 每 (secid, 日期) 上次**本进程写成功**的内容指纹（键 = 绝对路径 ⇒ 天然含 `DSH_HOME`，
 * 切换数据目录不会误判成"已经写过"）。跨重启为空 ⇒ 首次仍写一遍（安全侧默认）。
 */
const writtenFingerprint = new Map<string, number>()

/** 归档写路径的**测试钩子计数**（`__resetTrendArchiveStats` 清零） */
export interface TrendArchiveStats {
  /** `archiveTrendDays` 被调用次数 */
  calls: number
  /** 真的读目录的次数（零写入的那轮不读） */
  dirreadCalls: number
  /** 真的执行滚动清理的次数 */
  pruneCalls: number
  /** 真的写盘的文件数 */
  writes: number
  /** 因"内容未变"跳过的文件数 */
  skippedSame: number
  /** 真的写盘的字节数 */
  bytesWritten: number
}
let __archiveStats: TrendArchiveStats = { calls: 0, dirreadCalls: 0, pruneCalls: 0, writes: 0, skippedSame: 0, bytesWritten: 0 }

/** 测试钩子：读归档写路径计数 */
export function __trendArchiveStatsOf(): TrendArchiveStats {
  return { ...__archiveStats }
}

/** 测试钩子：清零（同时清掉"已写过"的指纹表，保证用例互不影响） */
export function __resetTrendArchiveStats(): void {
  __archiveStats = { calls: 0, dirreadCalls: 0, pruneCalls: 0, writes: 0, skippedSame: 0, bytesWritten: 0 }
  writtenFingerprint.clear()
}

/** 文件是否还在（"内容未变就跳过"的前置：被外部删掉时必须补写，不能静默不归档） */
async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

/** 归档若干"单日序列"（幂等覆盖；同一天只留一份） */
export async function archiveTrendDays(
  secid: string,
  entries: readonly TrendArchiveEntry[],
  opts: { keepDays?: number; maxFileBytes?: number; maxTotalBytes?: number; now?: number } = {},
): Promise<TrendArchiveWriteResult> {
  const dir = trendArchiveDir(secid)
  const result: TrendArchiveWriteResult = { saved: [], skipped: [], pruned: 0 }
  if (dir === null) {
    for (const e of entries) result.skipped.push({ day: e.day, reason: 'secid 非法，未归档' })
    return result
  }
  const keepDays = Math.max(1, Math.round(opts.keepDays ?? TREND_ARCHIVE_KEEP_DAYS))
  const maxFile = opts.maxFileBytes ?? TREND_ARCHIVE_MAX_FILE_BYTES
  const maxTotal = opts.maxTotalBytes ?? TREND_ARCHIVE_MAX_TOTAL_BYTES
  return serialize(`trends:${secid}`, async () => {
    __archiveStats.calls += 1
    /**
     * **先判"这一天要不要写"**（REVIEW-9-PERF §3.2）：
     *  - 指纹 = `entry.points` 的内容（**不含 `updatedAt`**）。含时间戳会让指纹每次都变 ⇒ 守卫永远失效
     *    （`trends-lkg` 就是这么失效的，见 `em.ts` 的 `trimTrendPayload`）。
     *  - 与上次**本进程写成功**的内容逐字节相同、且文件仍在 ⇒ 跳过：不 mkdir、不 readdir、不 stat 目录、不写盘。
     *    实测：自选页迷你图 80 卡 × 90s 一轮曾产生 1.2MB/90s 的逐字节相同重写。
     *  - 跨进程/重启：内存表为空 ⇒ 第一次仍会写一遍（安全侧默认）。
     */
    const targetKey = (day: string): string => join(dir, `${day}.json`)
    const pending: Array<{ day: string; payload: string; fingerprint: number; target: string }> = []
    for (const entry of entries) {
      if (!DAY_RE.test(entry.day)) {
        result.skipped.push({ day: entry.day, reason: '日期格式非法' })
        continue
      }
      if (entry.points.length < TREND_ARCHIVE_MIN_POINTS) {
        result.skipped.push({ day: entry.day, reason: `点数不足 ${TREND_ARCHIVE_MIN_POINTS}（${entry.points.length}），未归档` })
        continue
      }
      const payload = JSON.stringify(encodeTrendDay(secid, entry.day, entry.points, opts.now ?? Date.now()))
      if (payload.length > maxFile) {
        result.skipped.push({ day: entry.day, reason: `单日归档超过 ${Math.round(maxFile / 1024)}KB 上限（本次 ${Math.round(payload.length / 1024)}KB），未归档` })
        continue
      }
      const target = targetKey(entry.day)
      const fingerprint = payloadFingerprint(JSON.stringify(entry.points))
      if (writtenFingerprint.get(target) === fingerprint && (await fileExists(target))) {
        __archiveStats.skippedSame += 1
        continue
      }
      pending.push({ day: entry.day, payload, fingerprint, target })
    }
    // 全都不需要写 ⇒ 连目录都不碰（零 mkdir / 零 readdir / 零 write）
    if (pending.length === 0) return result
    try {
      await mkdir(dir, { recursive: true })
    } catch (error) {
      for (const e of pending) result.skipped.push({ day: e.day, reason: `归档目录建不出来：${String(error).slice(0, 80)}` })
      return result
    }
    // 目录清单**每轮只读一次**（体积检查与滚动清理共用同一份 names）
    const names = await readDayNames(dir)
    __archiveStats.dirreadCalls += 1
    let total = await dirSizeOf(dir, names)
    for (const item of pending) {
      if (total + item.payload.length > maxTotal) {
        result.skipped.push({ day: item.day, reason: `该标的归档总量超过 ${Math.round(maxTotal / 1024 / 1024)}MB 上限，本次未归档（可清理 ${trendArchiveRoot()} 后恢复）` })
        continue
      }
      try {
        await writeFileAtomic(item.target, item.payload)
        writtenFingerprint.set(item.target, item.fingerprint)
        result.saved.push(item.day)
        total += item.payload.length
        __archiveStats.writes += 1
        __archiveStats.bytesWritten += item.payload.length
      } catch (error) {
        result.skipped.push({ day: item.day, reason: `写入失败：${String(error).slice(0, 80)}` })
      }
    }
    // 滚动清理：只有"确实多出来"的日期文件才清（清单已有，不再 readdir）
    if (result.saved.length > 0) {
      const merged = [...new Set([...names, ...result.saved.map((d) => `${d}.json`)])].sort()
      if (merged.length > keepDays) {
        result.pruned = await prune(dir, keepDays, merged)
        __archiveStats.pruneCalls += 1
      }
    }
    return result
  })
}

export interface TrendArchiveLoad {
  /** 按日期升序的单日序列（坏文件与空文件不在其中） */
  days: TrendArchiveEntry[]
  /** 读不出来的文件：**如实报告**，不静默当作"没有这一天" */
  unreadable: Array<{ day: string; reason: string }>
}

/** 读出归档（缺目录 = 还没归档过，不算错误；坏文件进 `unreadable`） */
export async function loadTrendArchive(secid: string, opts: { keepDays?: number } = {}): Promise<TrendArchiveLoad> {
  const out: TrendArchiveLoad = { days: [], unreadable: [] }
  const dir = trendArchiveDir(secid)
  if (dir === null) return out
  let names: string[]
  try {
    names = (await readdir(dir)).filter((n) => DAY_FILE_RE.test(n)).sort()
  } catch {
    return out // 目录还不存在：从本版起累积，今天就是第 1 天
  }
  const keep = Math.max(1, Math.round(opts.keepDays ?? TREND_ARCHIVE_KEEP_DAYS))
  for (const name of names.slice(-keep)) {
    const day = name.slice(0, 10)
    let raw: string
    try {
      raw = await readFile(join(dir, name), 'utf8')
    } catch (error) {
      out.unreadable.push({ day, reason: `读取失败：${String(error).slice(0, 80)}` })
      continue
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      out.unreadable.push({ day, reason: '文件不是合法 JSON（归档损坏，该日按不可用处理）' })
      continue
    }
    const decoded = decodeTrendDay(parsed)
    if (decoded === null) {
      out.unreadable.push({ day, reason: '归档结构不符合预期（版本/字段不对，该日按不可用处理）' })
      continue
    }
    out.days.push({ day: decoded.day, points: decoded.points })
  }
  return out
}
