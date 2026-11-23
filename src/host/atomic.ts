/**
 * 原子写文件（**单一实现**）：先写 `<target>.tmp` 再 `rename` 覆盖。
 *
 * 为什么必须原子：这些文件（持仓/偏好/流水/日历/归档）会被下一次读取与另一个写者同时看到，
 * 直接 `writeFile` 会让读者读到半截 JSON（解析失败 ⇒ 被当成"数据损坏"）。`rename` 在同一
 * 文件系统内是原子的，读者要么看到旧内容、要么看到新内容。
 *
 * 调用点的差异只在"内容怎么序列化"与"失败怎么处理"（有的吞掉、有的记进 skipped），
 * 所以这里只抽**写入这一步**：序列化与错误策略留给调用方。
 */
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { dirname } from 'node:path'

/**
 * 原子写入文本；父目录不存在时自动创建。
 *
 * **`mkdir` 失败不吞**（P2-6）：旧实现 `.catch(() => undefined)` 会把"目录建不出来（权限/只读/磁盘满）"
 * 咽掉，随后 `writeFile` 只报一句 ENOENT —— 调用方看到的原因与真相不符，也没法决定"要不要重试"。
 * 现在创建失败原样抛出（带 errno），由调用方记录原因（见 `em.persistBoardLkg`）。
 */
export async function writeFileAtomic(target: string, text: string): Promise<void> {
  const tmp = `${target}.tmp`
  await mkdir(dirname(target), { recursive: true })
  await writeFile(tmp, text, 'utf8')
  await rename(tmp, target)
}

/** 原子写入 JSON（本项目统一 1 空格缩进：便于 git diff 与人工核对） */
export function writeJsonAtomic(target: string, value: unknown, indent = 1): Promise<void> {
  return writeFileAtomic(target, JSON.stringify(value, null, indent))
}

export interface AtomicFileSetEntry {
  target: string
  text: string
}

export interface AtomicFileSetOptions {
  /**
   * 测试注入：第 N 个文件（1-based）在 rename 提交前失败。
   * 生产不传 ⇒ 永不注入。用于断言"第二个文件失败后，三个文件与写前逐字节一致"。
   */
  failCommitAt?: number
}

/**
 * **一组文件的一次写**（跨文件事务的落盘层）。
 *
 * 为什么需要它：`writeFileAtomic` 只能保证**单个**文件原子；一次交易要同时改
 * account / orders / equity 三份账本，逐个写会在中途失败时留下「账户已扣钱、委托没记」
 * 的半状态。这里把三份内容**先全部写成唯一临时文件**，全部成功后才逐个 `rename` 提交；
 * 提交途中失败 ⇒ 用写前读到的原字节恢复已经提交的文件（尽力回滚），然后抛错。
 *
 * 约束：
 *   · 临时文件名带 pid + 时间 + 随机数，避免两个进程/两次写共用同一个 `.tmp`；
 *   · 调用方必须已经持有这些目标文件的锁（本函数不负责加锁）；
 *   · 回滚是"尽力"：恢复写失败会作为 `AggregateError` 的一部分抛出，绝不假装成功。
 */
export async function writeFileSetAtomic(
  entries: readonly AtomicFileSetEntry[],
  opts: AtomicFileSetOptions = {},
): Promise<void> {
  if (entries.length === 0) return
  const stamp = `${process.pid.toString(36)}-${Date.now().toString(36)}-${randomBytes(4).toString('hex')}`
  interface Staged {
    entry: AtomicFileSetEntry
    tmp: string
    /** 写前原字节；null = 文件本来不存在 */
    backup: string | null
  }
  const staged: Staged[] = []
  // 1) 先读旧值、再写临时文件：这一步任何失败都不会碰到目标文件
  try {
    for (const [i, entry] of entries.entries()) {
      await mkdir(dirname(entry.target), { recursive: true }).catch(() => undefined)
      let backup: string | null = null
      try {
        backup = await readFile(entry.target, 'utf8')
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
      const tmp = `${entry.target}.tmp-${stamp}-${i}`
      try {
        await writeFile(tmp, entry.text, 'utf8')
      } catch (error) {
        await unlink(tmp).catch(() => undefined)
        throw error
      }
      staged.push({ entry, tmp, backup })
    }
  } catch (error) {
    await Promise.all(staged.map((s) => unlink(s.tmp).catch(() => undefined)))
    throw error
  }
  // 2) 逐个 rename 提交；途中失败 ⇒ 恢复已提交文件的写前字节
  const committed: Staged[] = []
  try {
    for (const [i, item] of staged.entries()) {
      if (opts.failCommitAt === i + 1) throw new Error(`注入：第 ${i + 1} 个文件提交失败（${item.entry.target}）`)
      await rename(item.tmp, item.entry.target)
      committed.push(item)
    }
  } catch (error) {
    const restoreErrors: unknown[] = []
    for (const item of committed.reverse()) {
      try {
        if (item.backup === null) {
          await unlink(item.entry.target)
        } else {
          const restoreTmp = `${item.entry.target}.restore-${stamp}`
          await writeFile(restoreTmp, item.backup, 'utf8')
          await rename(restoreTmp, item.entry.target)
        }
      } catch (restoreError) {
        restoreErrors.push(restoreError)
      }
    }
    await Promise.all(staged.map((s) => unlink(s.tmp).catch(() => undefined)))
    if (restoreErrors.length > 0) {
      throw new AggregateError([error, ...restoreErrors], `三账本写入失败且回滚未完全成功：${String(error)}`)
    }
    throw error
  }
}
