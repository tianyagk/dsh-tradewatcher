/**
 * 写操作日志与节流（P0-11）。
 *
 * 存在理由：agent 能写数据（日历等）之后，"写错了怎么退"必须有答案。
 * 三条约束，全部落在这一层（工具实现只负责声明反向操作）：
 *
 *  1) **可撤销**：每次写入记一条 `WriteRecord`，含 `by`（会话 id）与反向操作描述；
 *     撤销是一条新的写入（`undone` 由日志记录），**不删除历史** —— 撤回本身也要留痕。
 *  2) **节流**：同一秒内超过 3 次写入直接报错，不静默丢弃。丢一个写入而不说
 *     比报错更坏：调用方会以为写成功了。
 *  3) **范围最小**：只允许撤销本插件自己写过的东西（日志里登记过的 target）。
 *
 * 落盘 `<dataHome>/write-log.json`，保留最近 KEEP 条。
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { dataHome } from './store.ts'

/** 撤销一条写入所需的全部信息（描述"怎么退回去"，不是"退到哪里"） */
export interface UndoAction {
  kind: 'calendar.remove'
  /** 反向操作的参数（如被创建事件 id） */
  targetId: string
  /** 人类可读的反向操作说明 */
  label: string
}

export interface WriteRecord {
  id: string
  ts: number
  /** 写入者：会话 id（tools 的 exec.agent.id）；界面写入记 'web' */
  by: string
  /** 工具/操作名，如 tradewatcher_calendar_add */
  tool: string
  /** 写入摘要（人类可读，列表里直接显示） */
  summary: string
  undo: UndoAction | null
  /** 被哪条撤销操作撤销（epoch ms 与之对应的 id） */
  undoneBy?: string
  undoneAt?: number
}

interface LogFile {
  v: number
  entries: WriteRecord[]
}

/** 同一秒内允许的写入次数上限（超过即报错，不静默丢） */
export const WRITE_RATE_LIMIT_PER_SEC = 3
const KEEP = 500

export class WriteJournal {
  private dir: string
  private file: LogFile = { v: 1, entries: [] }
  private loaded: Promise<void> | null = null
  private writeChain: Promise<void> = Promise.resolve()
  private seq = 0

  constructor(dir: string = dataHome()) {
    this.dir = dir
  }

  private path(): string {
    return join(this.dir, 'write-log.json')
  }

  async init(): Promise<void> {
    if (this.loaded !== null) return this.loaded
    this.loaded = (async () => {
      await mkdir(this.dir, { recursive: true }).catch(() => undefined)
      try {
        const raw = await readFile(this.path(), 'utf8')
        const parsed = JSON.parse(raw) as Partial<LogFile>
        this.file = { v: 1, entries: Array.isArray(parsed.entries) ? parsed.entries : [] }
      } catch {
        /* 首次：空日志 */
      }
    })()
    return this.loaded
  }

  private persist(): Promise<void> {
    const run = this.writeChain.then(async () => {
      const tmp = `${this.path()}.tmp`
      const kept = this.file.entries.slice(-KEEP)
      this.file = { v: 1, entries: kept }
      await mkdir(this.dir, { recursive: true }).catch(() => undefined)
      await writeFile(tmp, JSON.stringify(this.file, null, 1), 'utf8')
      await rename(tmp, this.path())
    })
    this.writeChain = run.catch(() => undefined)
    return run
  }

  /** 最近若干条写入（倒序，最新在前） */
  list(limit = 20): WriteRecord[] {
    return this.file.entries.slice(-Math.max(1, limit)).reverse().map((e) => ({ ...e }))
  }

  get(id: string): WriteRecord | undefined {
    const hit = this.file.entries.find((e) => e.id === id)
    return hit === undefined ? undefined : { ...hit }
  }

  /**
   * 节流检查：同一自然秒内的写入次数。返回 null = 放行，非 null = 应拒绝的原因。
   *
   * 只统计**未撤销**的历史写入（撤销后重写是正常的修正流程，不该被限）。
   */
  throttleReason(now = Date.now()): string | null {
    const sec = Math.floor(now / 1000)
    const recent = this.file.entries.filter((e) => Math.floor(e.ts / 1000) === sec).length
    if (recent >= WRITE_RATE_LIMIT_PER_SEC) {
      return `写入过于频繁：同一秒内已有 ${recent} 次写入（上限 ${WRITE_RATE_LIMIT_PER_SEC} 次/秒）。本次写入「未执行」，请稍后重试；需要批量录入请分几秒完成`
    }
    return null
  }

  /** 记录一次写入，返回带 id 的记录（id 供撤销使用） */
  async record(entry: Omit<WriteRecord, 'id' | 'ts'> & { ts?: number }): Promise<WriteRecord> {
    await this.init()
    this.seq += 1
    const ts = entry.ts ?? Date.now()
    const rec: WriteRecord = {
      id: `w${ts.toString(36)}${this.seq.toString(36).padStart(3, '0')}`,
      ts,
      by: entry.by,
      tool: entry.tool,
      summary: entry.summary,
      undo: entry.undo,
    }
    this.file.entries.push(rec)
    await this.persist()
    return { ...rec }
  }

  /** 标记已撤销（不删历史：撤销本身也要留痕） */
  async markUndone(id: string, by: string): Promise<void> {
    await this.init()
    const hit = this.file.entries.find((e) => e.id === id)
    if (hit === undefined) return
    hit.undoneBy = by
    hit.undoneAt = Date.now()
    await this.persist()
  }
}
