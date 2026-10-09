/**
 * 每日分时的本地归档 —— 多日拼接的数据来源。
 *
 * 为什么要单独建目录：`trends-lkg.json` 是"每标的只留最新一次"的兜底快照（键 `secid|ndays`），
 * **没有按日归档**，所以用户提的"拿缓存的每日分时拼接出五日"在它身上拿不到历史。
 * 本归档从**本版起累积**：今天只有 1 天，之后逐日变多 —— 界面与回包都如实说明，不假装。
 *
 * 路径：`<dataHome>/trends/<secid>/<YYYY-MM-DD>.json`
 *  - **原子写**（tmp + rename），与 store 的持久化约定一致；
 *  - **幂等覆盖**：同一天重复取到就覆盖（后到的更完整），不会追加成两份；
 *  - **滚动清理**：只保留最近 `TREND_ARCHIVE_KEEP_DAYS` 个交易日，写入时清理，
 *    且**只删自己目录里形如 `YYYY-MM-DD.json` 的文件**；
 *  - **体积保护**：单文件 / 该标的总量超过上限时**不写**并如实报告（长期运行的插件不能悄悄写满磁盘）；
 *  - 坏文件 / 缺目录：**不崩、不静默** —— 坏文件进 `unreadable` 并带原因，缺目录就是"还没有归档"。
 */
import { mkdir, readFile, readdir, rm, stat, writeFile, rename } from 'node:fs/promises'
import { join } from 'node:path'
import type { TrendPoint } from '../shared/model.ts'
import { SECID_RE } from '../shared/model.ts'
import { dataHome } from './store.ts'

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

async function dirSize(dir: string): Promise<number> {
  let total = 0
  for (const name of await readdir(dir)) {
    if (!DAY_FILE_RE.test(name)) continue
    try {
      total += (await stat(join(dir, name))).size
    } catch {
      /* 刚被删掉/读不到就不计入 */
    }
  }
  return total
}

/** 只删自己目录里 `YYYY-MM-DD.json`，保留最近 keepDays 个（按文件名降序即日期降序） */
async function prune(dir: string, keepDays: number): Promise<number> {
  let names: string[]
  try {
    names = (await readdir(dir)).filter((n) => DAY_FILE_RE.test(n)).sort()
  } catch {
    return 0
  }
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
    try {
      await mkdir(dir, { recursive: true })
    } catch (error) {
      for (const e of entries) result.skipped.push({ day: e.day, reason: `归档目录建不出来：${String(error).slice(0, 80)}` })
      return result
    }
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
      if ((await dirSize(dir)) + payload.length > maxTotal) {
        result.skipped.push({ day: entry.day, reason: `该标的归档总量超过 ${Math.round(maxTotal / 1024 / 1024)}MB 上限，本次未归档（可清理 ${trendArchiveRoot()} 后恢复）` })
        continue
      }
      const target = join(dir, `${entry.day}.json`)
      const tmp = `${target}.tmp`
      try {
        await writeFile(tmp, payload, 'utf8')
        await rename(tmp, target)
        result.saved.push(entry.day)
      } catch (error) {
        result.skipped.push({ day: entry.day, reason: `写入失败：${String(error).slice(0, 80)}` })
      }
    }
    result.pruned = await prune(dir, keepDays)
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
