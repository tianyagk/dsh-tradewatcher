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
import { mkdir, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

/** 原子写入文本；父目录不存在时自动创建 */
export async function writeFileAtomic(target: string, text: string): Promise<void> {
  const tmp = `${target}.tmp`
  await mkdir(dirname(target), { recursive: true }).catch(() => undefined)
  await writeFile(tmp, text, 'utf8')
  await rename(tmp, target)
}

/** 原子写入 JSON（本项目统一 1 空格缩进：便于 git diff 与人工核对） */
export function writeJsonAtomic(target: string, value: unknown, indent = 1): Promise<void> {
  return writeFileAtomic(target, JSON.stringify(value, null, indent))
}
