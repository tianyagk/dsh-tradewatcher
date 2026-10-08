/**
 * 多设备导出 / 导入（P0-9）。
 *
 * 不做账号体系与自建云同步（见 README「明确不做」），走**文件**：
 * 导出把 watch/positions/ledger/prefs 打成一份 JSON（带 `schemaVersion` 与校验和），
 * 导入前先预览冲突，覆盖前写 `.bak`。
 *
 * 最硬的一条：**账本重放不一致直接拒绝导入**。宁可不导入，也不能导入一份算不平的账 ——
 * 一旦写进去，之后所有的成本、盈亏、已实现都会建立在一个错的账本上，
 * 而且用户没有任何手段看出来"从哪一天开始不对"。
 *
 * 本文件的校验逻辑是纯函数（不碰 IO），因此可以直接单测。
 */
import { createHash } from 'node:crypto'
import type { LedgerEntry, PortGroup, PortItem, PortPrefs, WatchGroup, WatchItem } from '../shared/model.ts'
import { normalizeLedgerDetailed, normalizePortFile, normalizeWatchFile, replayPosition, sortLedger } from './store.ts'

/** 备份格式版本；结构不兼容时用它给出明确拒绝理由，而不是让字段静默丢失 */
export const BACKUP_SCHEMA_VERSION = 1

export interface BackupFiles {
  watch: { v: number; groups: WatchGroup[]; items: WatchItem[] }
  positions: { v: number; groups: PortGroup[]; items: PortItem[] }
  ledger: { v: number; entries: LedgerEntry[] }
  prefs: Partial<PortPrefs>
}

export interface BackupBundle {
  schemaVersion: number
  /** 写出这份文件的插件版本，便于事后判断口径 */
  app: string
  exportedAt: number
  files: BackupFiles
  /** files 的规范化 JSON 的 sha1（前 16 位），用于发现半截/被改过的文件 */
  checksum: string
}

/**
 * 校验和只覆盖 files（app/exportedAt 变化不该改变内容指纹）。
 *
 * **必须算在「文件里的原始内容」上，而不是归一化之后的内容上**：导入时的
 * 结构校验会先跑一遍 normalize（补默认字段、丢非法项），若拿归一化结果算校验和，
 * 自己导出的文件在导入时必然对不上 —— 那等于把"校验和"变成永远失败的装饰。
 * 用它来判断的是"文件有没有被改动/写了一半"，因此对象必须与落盘字节一一对应。
 */
export function filesChecksum(files: unknown): string {
  return createHash('sha1').update(canonical(files)).digest('hex').slice(0, 16)
}

/** 键排序的稳定序列化：对象键顺序不同不应该算出不同的校验和 */
function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`
}

export function makeBundle(files: BackupFiles, app: string, now = Date.now()): BackupBundle {
  return { schemaVersion: BACKUP_SCHEMA_VERSION, app, exportedAt: now, files, checksum: filesChecksum(files) }
}

export interface BundleCheck {
  ok: boolean
  /** 拒绝原因（逐条具体，不许一句"文件损坏"） */
  errors: string[]
  /** 通过校验后归一化出的文件内容 */
  files: BackupFiles | null
  /** 摘要（预览用）：行数、时间跨度、校验和是否匹配 */
  summary: {
    watchGroups: number
    watchItems: number
    portGroups: number
    portItems: number
    ledgerEntries: number
    ledgerFrom: number | null
    ledgerTo: number | null
    checksumMatch: boolean
    schemaVersion: number | null
    app: string | null
    exportedAt: number | null
  }
}

/**
 * 校验一份导入文件。**任何一条不过就拒绝**（返回 ok:false 与逐条原因）。
 *
 * 检查项：
 *  1. 是对象、`schemaVersion` 存在且不高于本版本（更高的版本意味着更新的插件写的，
 *     我们不知道它多了什么字段，静默接受会丢数据）；
 *  2. 四个文件都存在且形状可归一（复用存储层同一套 normalize，避免"两套解析"分叉）；
 *  3. 校验和匹配（不匹配说明文件被改过或半截写入）；
 *  4. 账本日期范围合法；
 *  5. **账本重放一致**：每条流水引用的 posId/groupId 必须存在；逐笔重放不得出现负持仓。
 */
export function verifyBundle(raw: unknown): BundleCheck {
  const errors: string[] = []
  const summary: BundleCheck['summary'] = {
    watchGroups: 0, watchItems: 0, portGroups: 0, portItems: 0,
    ledgerEntries: 0, ledgerFrom: null, ledgerTo: null,
    checksumMatch: false, schemaVersion: null, app: null, exportedAt: null,
  }
  const fail = (): BundleCheck => ({ ok: false, errors, files: null, summary })

  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    errors.push('文件不是一个 JSON 对象（可能是别的文件，或内容被截断）')
    return fail()
  }
  const b = raw as Partial<BackupBundle>
  if (typeof b.schemaVersion !== 'number' || !Number.isFinite(b.schemaVersion)) {
    errors.push('缺少 schemaVersion：不是本插件导出的备份文件')
    return fail()
  }
  summary.schemaVersion = b.schemaVersion
  if (b.schemaVersion > BACKUP_SCHEMA_VERSION) {
    errors.push(`备份的 schemaVersion=${b.schemaVersion} 高于本插件支持的 ${BACKUP_SCHEMA_VERSION}：请先升级插件再导入（低版本插件无法知道新字段的含义，静默接受会丢数据）`)
    return fail()
  }
  summary.app = typeof b.app === 'string' ? b.app : null
  summary.exportedAt = typeof b.exportedAt === 'number' ? b.exportedAt : null

  const files = b.files as Partial<BackupFiles> | undefined
  if (files === null || files === undefined || typeof files !== 'object') {
    errors.push('缺少 files 字段')
    return fail()
  }
  const watch = normalizeWatchFile(files.watch)
  if (watch === null) errors.push('watch（自选）内容形状非法：既不是合法的分组结构，也不是空表')
  const positions = normalizePortFile(files.positions)
  if (positions === null) errors.push('positions（持仓）内容形状非法')
  if (files.ledger === null || files.ledger === undefined || !Array.isArray((files.ledger as { entries?: unknown }).entries)) {
    errors.push('ledger（流水）缺少 entries 数组')
  }

  const detailed = files.ledger === null || files.ledger === undefined
    ? null
    : normalizeLedgerDetailed(files.ledger)
  if (detailed === null) {
    errors.push('ledger（流水）形状非法')
  } else if (detailed.dropped > 0) {
    // 半截条目是"账算不平"的典型成因，不静默丢
    errors.push(`ledger 有 ${detailed.dropped}/${detailed.total} 条无法解析：这份账本不完整，导入后会算错成本与已实现盈亏`)
  }

  if (errors.length > 0 || watch === null || positions === null || detailed === null) return fail()

  summary.watchGroups = watch.groups.length
  summary.watchItems = watch.items.length
  summary.portGroups = positions.groups.length
  summary.portItems = positions.items.length
  summary.ledgerEntries = detailed.file.entries.length
  const tsList = detailed.file.entries.map((e) => e.ts).filter((t) => Number.isFinite(t))
  summary.ledgerFrom = tsList.length > 0 ? Math.min(...tsList) : null
  summary.ledgerTo = tsList.length > 0 ? Math.max(...tsList) : null

  // 交叉引用 + 重放
  const groupIds = new Set(positions.groups.map((g) => g.id))
  const posIds = new Set(positions.items.map((p) => p.id))
  const sorted = sortLedger(detailed.file.entries)
  const runningQty = new Map<string, number>()
  let badRef = 0
  let negative = 0
  for (const e of sorted) {
    const delta = e.qty === undefined ? 0 : (e.verb === 'buy' ? e.qty : e.verb === 'sell' ? -e.qty : 0)
    if (e.posId !== undefined) {
      if (!posIds.has(e.posId)) badRef += 1
      runningQty.set(e.posId, (runningQty.get(e.posId) ?? 0) + delta)
      if ((runningQty.get(e.posId) ?? 0) < -1e-9) negative += 1
    }
    if (e.groupId !== undefined && !groupIds.has(e.groupId)) badRef += 1
  }
  if (badRef > 0) errors.push(`流水里有 ${badRef} 处引用了不存在的持仓/分组 id：账本与持仓表对不上（可能只导入了其中一份）`)
  if (negative > 0) errors.push(`流水重放出现 ${negative} 次负持仓（卖出超过持有）：这份账本自相矛盾，导入后成本与盈亏都会是错的`)
  // 逐项复算一次（与展示同一套函数），确认没有任何一项抛错
  for (const p of positions.items) {
    try {
      replayPosition(sorted, p.id)
    } catch (error) {
      errors.push(`持仓「${p.name}」的流水无法重放：${error instanceof Error ? error.message : String(error)}`)
      break
    }
  }

  // 原始内容（与落盘字节对应），不是归一化结果 —— 见 filesChecksum 的说明
  const computed = filesChecksum({
    watch: files.watch,
    positions: files.positions,
    ledger: files.ledger,
    prefs: files.prefs ?? {},
  })
  summary.checksumMatch = typeof b.checksum === 'string' && b.checksum === computed
  if (typeof b.checksum !== 'string' || b.checksum === '') {
    errors.push('缺少 checksum：无法判断文件是否被改动或写了一半')
  } else if (!summary.checksumMatch) {
    errors.push(`checksum 不匹配（文件 ${String(b.checksum)}，实算 ${computed}）：文件被改动过，或写入过程中被截断`)
  }

  if (errors.length > 0) return fail()
  return {
    ok: true,
    errors,
    files: { watch, positions, ledger: detailed.file, prefs: (files.prefs ?? {}) as Partial<PortPrefs> },
    summary,
  }
}

/** 预览里的"冲突"描述：与当前内容的行数与最新时间对比 */
export function describeConflicts(
  check: BundleCheck,
  current: { watchGroups: number; watchItems: number; portGroups: number; portItems: number; ledgerEntries: number; ledgerTo: number | null },
): string[] {
  const s = check.summary
  const cmp = (label: string, from: number, to: number): string =>
    `${label}：当前 ${from} → 导入后 ${to}${to === from ? '（条数相同）' : to > from ? `（+${to - from}）` : `（${to - from}）`}`
  const out = [
    cmp('自选分组', current.watchGroups, s.watchGroups),
    cmp('自选条目', current.watchItems, s.watchItems),
    cmp('持仓分组', current.portGroups, s.portGroups),
    cmp('持仓标的', current.portItems, s.portItems),
    cmp('流水条数', current.ledgerEntries, s.ledgerEntries),
  ]
  if (s.ledgerTo !== null) {
    out.push(
      current.ledgerTo === null
        ? `流水最新时间：当前无流水 → 导入后 ${new Date(s.ledgerTo).toLocaleString('zh-CN', { hour12: false })}`
        : `流水最新时间：当前 ${new Date(current.ledgerTo).toLocaleString('zh-CN', { hour12: false })} → 导入后 ${new Date(s.ledgerTo).toLocaleString('zh-CN', { hour12: false })}`,
    )
  }
  return out
}
