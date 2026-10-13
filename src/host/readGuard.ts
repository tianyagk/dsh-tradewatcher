/**
 * 「读不到」≠「没有」。
 *
 * 红线条目 R1（docs/REVIEW-2-CORRECTNESS.md §R1）：账本 / 日历事件 / 90 天快照三处都把
 * **EACCES / EIO / 半截文件** 与 **ENOENT（首次启动）** 当成同一件事 —— 返回空数据，
 * 而三处的写回都是**整份覆写** ⇒ 一次权限错误就把用户唯一的数据静默抹掉。
 * 对照：`lock.ts` 早就立了同一条规矩（"拒绝在锁内改写它，避免把用户数据静默覆盖成空"）。
 *
 * 这里给出**同一份判据、同一个守卫**（三处共用，避免又出现"两种错误两种命运"）：
 *   - `isFirstBoot(error)`  只有 ENOENT 才算"本来就没有"，此时空数据是**真**的；
 *   - `ReadGuard.markUnreadable()` 记下"这个文件这次读不到"；
 *   - `ReadGuard.assertWritable()` 在写回前拦下：读不到 ⇒ **拒绝整份覆写**（抛 `UnreadableFileError`）；
 *   - 重读成功后 `clear()` 自愈（临时故障恢复后不需要重启进程）。
 *
 * 失败原因还会被翻译成对外 `missing[]` 条目（见 `unreadableMissing`），
 * 让界面/工具如实说"这份数据这次没读到"，而不是装作"它就是空的"。
 */
import { rename } from 'node:fs/promises'
import { join } from 'node:path'
import type { MissingField } from '../shared/model.ts'

/** 只有 ENOENT 才是"首次启动/本来就没有"；其它 errno 一律是**读不到** */
export function isFirstBoot(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === 'ENOENT'
}

/** 人类可读的失败原因（带 errno 码，便于排查权限/磁盘/半截文件） */
export function describeReadError(error: unknown): string {
  const code = (error as NodeJS.ErrnoException | null)?.code
  const message = error instanceof Error ? error.message : String(error)
  return typeof code === 'string' && code !== '' ? `${code}: ${message}` : message
}

/** 读不到某个文件时，写回被拒绝（**不是**"空数据可以写"） */
export class UnreadableFileError extends Error {
  readonly file: string
  readonly reason: string
  /** 想做什么被拒了（"写回账本"/"覆盖 90 天快照"…），拼进消息便于定位 */
  readonly action: string

  constructor(file: string, reason: string, action = '整份覆写') {
    super(
      `${file} 本次读不到（${reason}）⇒ 拒绝${action}：读不到 ≠ 空数据，覆写会永久丢掉用户数据。` +
        '修好权限/磁盘后重读即可恢复（本进程不会在未成功读到的情况下写回）。',
    )
    this.name = 'UnreadableFileError'
    this.file = file
    this.reason = reason
    this.action = action
  }
}

/** 每个数据文件一份守卫实例（store / calendar / global-flow 各持一个） */
export class ReadGuard {
  private readonly blocked = new Map<string, string>()

  /** 记下一次读失败（**只对非 ENOENT**）；返回原因供日志/披露复用 */
  markUnreadable(file: string, error: unknown): string {
    const reason = describeReadError(error)
    this.blocked.set(file, reason)
    return reason
  }

  /** 重读成功 ⇒ 解除封锁（临时故障自愈）；返回是否确实解除过 */
  clear(file: string): boolean {
    return this.blocked.delete(file)
  }

  reasonOf(file: string): string | null {
    return this.blocked.get(file) ?? null
  }

  isBlocked(file: string): boolean {
    return this.blocked.has(file)
  }

  /** 快照（`{file, reason}`），供 `missing[]` 与断言读取 */
  get entries(): ReadonlyArray<{ file: string; reason: string }> {
    return [...this.blocked.entries()].map(([file, reason]) => ({ file, reason }))
  }

  /** 写回前的守卫：读不到过的文件一律拒绝整份覆写 */
  assertWritable(file: string, action = '整份覆写'): void {
    const reason = this.blocked.get(file)
    if (reason === undefined) return
    throw new UnreadableFileError(file, reason, action)
  }
}

/**
 * 把"读不到"翻译成对外 `missing[]`。
 *
 * 为什么用 `why: 'transient'`：模型只允许 `transient`（本次失败、稍后重试）与
 * `no-source`（上游根本没有），这里不是"上游没有"⇒ 只能落在 `transient`。
 * 但**不拿 `MISSING_TIER_ADVICE.transient`（"稍后自动重试"）顶替**：权限/磁盘问题
 * 不会自己好，note 里必须说清"要做什么"，否则又是一句看着正常的错话。
 */
export function unreadableMissing(entries: ReadonlyArray<{ file: string; reason: string }>, what: string): MissingField[] {
  return entries.map((e) => ({
    what,
    why: 'transient' as const,
    note:
      `本地文件 ${e.file} 本次读不到（${e.reason}）—— 读不到 ≠ 空数据，` +
      '已停用写回（避免覆盖你的数据）。这不会自动重试：修好文件权限/磁盘后可恢复（重启进程即重新装载）。',
  }))
}

/**
 * 把"读到了但内容坏"的原件改名隔离（保留原字节），与 `store.ts` 的 quarantine 同口径。
 * 返回隔离后的文件名；失败时返回 null（不阻断流程）。
 */
export async function quarantineFile(path: string, stamp = new Date().toISOString().replace(/[:.]/g, '-')): Promise<string | null> {
  const target = `${path}.corrupt-${stamp}`
  try {
    await rename(path, target)
    return target
  } catch {
    return null
  }
}

/** 目录 + 文件名（守卫用完整路径做键，便于日志直接定位） */
export function fileKey(dir: string, file: string): string {
  return join(dir, file)
}
