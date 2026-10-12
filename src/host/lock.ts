/**
 * 跨进程文件锁 + 锁内「读最新 → 合并 → 写回」。
 *
 * ## 为什么需要它（本轮真实事故）
 *
 * `atomic.ts` 的 tmp + rename 只保证**不写半截文件**（原子），**不保证互斥**：
 * 两个进程各自「读 → 改 → 整文件覆写」时，后写者会整体覆盖先写者的成果 —— 丢更新。
 * 本项目已实测发生：`rescue-log.json` 无跨进程锁，用户 3080 服务与另一实例同时采样时
 * `days['2026-10-12'].samples` 被混入另一个实例的拍数且**无法干净剔除**
 * （见 docs/AUDIT-CACHE-2.md §1.4 / §7.7、docs/AUDIT-IMPL42.md）。
 *
 * ## 协议（获取 / 等待 / 陈旧回收 / 释放 / 崩溃）
 *
 * 1. **获取**：`open(<target>.lock, 'wx')` 独占创建（O_EXCL 是原子判定，只有一个进程能成功）。
 *    锁文件内容记 `{ pid, at, token, target, note }`，并**定时刷新 mtime**（心跳）。
 * 2. **等待**：`EEXIST` ⇒ 抖动退避重试，直到 `timeoutMs` 上限，超时抛 `LockTimeoutError`
 *    （**有界**：绝不无限等，也绝不"等不到就照写"）。
 * 3. **陈旧回收**：锁文件 mtime 超过 `staleMs`（＝心跳断供）或持有者 pid 已消失
 *    （且宽限期已过）⇒ 原子 `rename` 走该锁文件（rename 只有一个赢家，不会两个回收者同时"抢到"），
 *    并把**原因**（年龄、持有者 pid、pid 是否还在运行）写进日志与事件 —— 回收**不静默**。
 *    因此 `kill -9` 留下的锁在**有界时间**（≤ 死主宽限 1s / 心跳断供 staleMs + 重试间隔）内可被回收。
 * 4. **释放**：只删「内容 token 仍属于自己」的锁文件。若自己已被判陈旧、锁已被别人重建，
 *    **绝不误删别人的锁**（记 `release-skipped`）。
 * 5. **崩溃**：`process.on('exit')` 同步清理仍持有的锁；`kill -9` 走第 3 条。
 *
 * 进程内：同一锁路径**可重入**（已持有 ⇒ 直接执行，不重开锁文件、不自锁），未持有时按
 * 路径串行排队（免去同进程内无谓的 wx 争抢）。跨进程的互斥由锁文件本身保证。
 *
 * ## 用法
 *
 * - 只有"读-改-写"才需要锁：`updateJsonLocked(file, (disk) => 合并后要写回的整份文档)`。
 * - 计数（`samples += 1`）**必须**走 `bumpJsonCounter`：它在锁内读最新值再加，写回的是
 *   "磁盘现值 + 本次增量"，而不是"我内存里的快照" ⇒ 两个进程各 +1 的最终值一定是 +2。
 * - 纯覆盖写（无读）不需要本模块 —— `writeFileAtomic` 已够。
 */
import { mkdir, open, readFile, rename, stat, unlink, utimes } from 'node:fs/promises'
import { unlinkSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { dirname } from 'node:path'
import { log } from './context.ts'
import { writeJsonAtomic } from './atomic.ts'

/** 锁文件里记录的持有者信息（人可读：出事后能知道"当时是谁持的锁"） */
export interface LockHolder {
  pid: number
  at: number
  token: string
  target: string
  note?: string
}

/** 锁文件现状快照（`inspectLock` 用；也是回收判据的载体） */
export interface LockSnapshot {
  lockPath: string
  /** null = 文件存在但内容不可解析（刚创建还没写入、或被截断） */
  holder: LockHolder | null
  mtimeMs: number
  ageMs: number
  /** null = 无法判定（内容不可解析）；false = 进程已消失 */
  pidAlive: boolean | null
}

export type LockEventKind = 'acquire' | 'wait' | 'reclaim' | 'release' | 'release-skipped' | 'timeout'

/** 观察点：测试与自检据此断言"回收有原因、等待有记录"（而不是靠读控制台） */
export interface LockEvent {
  kind: LockEventKind
  kindLabel: string
  lockPath: string
  target: string
  /** 锁文件年龄（mtime 至今），ms */
  ageMs?: number
  holderPid?: number | null
  holderAlive?: boolean | null
  waitedMs?: number
  reason: string
}

export interface LockOptions {
  /** 心跳断供多久算陈旧（可回收）。默认 10_000ms */
  staleMs?: number
  /** 等待上限；超时抛 LockTimeoutError（有界）。默认 15_000ms */
  timeoutMs?: number
  /** 重试基础间隔（带抖动）。默认 12ms */
  retryMs?: number
  /** 写进锁文件，便于事后归因 */
  note?: string
  /** 观察点（测试/自检用） */
  onEvent?: (e: LockEvent) => void
  /** 关掉控制台输出（事件仍然照发）。默认 false */
  quiet?: boolean
  /** 连"正常获取/释放"也打进控制台（排查用）。默认 false ⇒ 只打异常 */
  verbose?: boolean
  /** 读到的内容无法解析时：'throw'（默认，拒绝静默覆盖）或 'null' */
  onCorrupt?: 'throw' | 'null'
}

const DEFAULT_STALE_MS = 10_000
const DEFAULT_TIMEOUT_MS = 15_000
const DEFAULT_RETRY_MS = 12
/** 持有者 pid 已消失时的宽限：避免"刚创建、内容还没写完"的锁被误判 */
const DEAD_HOLDER_GRACE_MS = 1_000

const KIND_LABEL: Record<LockEventKind, string> = {
  acquire: '获取',
  wait: '等待',
  reclaim: '回收陈旧锁',
  release: '释放',
  'release-skipped': '跳过释放',
  timeout: '等待超时',
}

export class LockTimeoutError extends Error {
  readonly code = 'LOCK_TIMEOUT'
  readonly lockPath: string
  readonly holder: LockHolder | null
  readonly waitedMs: number

  constructor(lockPath: string, holder: LockHolder | null, waitedMs: number, timeoutMs: number) {
    super(
      `等待文件锁超时（${waitedMs}ms ≥ ${timeoutMs}ms）：${lockPath}` +
      (holder === null ? '（锁文件内容不可解析）' : `，持有者 pid=${holder.pid} at=${new Date(holder.at).toISOString()}${holder.note === undefined ? '' : ` note=${holder.note}`}`),
    )
    this.name = 'LockTimeoutError'
    this.lockPath = lockPath
    this.holder = holder
    this.waitedMs = waitedMs
  }
}

/** 锁文件路径：`<target>.lock`（与目标同目录 ⇒ 同一份数据的写者一定看得见同一把锁） */
export function lockPathFor(target: string): string {
  return `${target}.lock`
}

interface HeldLock {
  lockPath: string
  target: string
  holder: LockHolder
  depth: number
  release(): Promise<void>
}

/** 本进程当前持有的锁（可重入计数靠它） */
const held = new Map<string, HeldLock>()
/** 同进程内同路径的排队链（避免自己人抢自己的锁文件） */
const queues = new Map<string, Promise<void>>()
let exitHookInstalled = false

/** 本进程当前持有的锁文件路径（自检/诊断用） */
export function heldLocks(): string[] {
  return [...held.keys()]
}

function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM = 进程存在但不属于我们（照样算活着）
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

function newToken(): string {
  return `${process.pid.toString(36)}-${Date.now().toString(36)}-${randomBytes(4).toString('hex')}`
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** 抖动退避：多个等待者同时醒来时错开，避免"同一毫秒一起抢" */
function backoffMs(base: number, round: number): number {
  const capped = Math.min(base * 2 ** Math.min(round, 6), 400)
  return Math.round(capped * (0.5 + Math.random()))
}

function emit(opts: LockOptions, event: Omit<LockEvent, 'kindLabel'>): void {
  const full: LockEvent = { ...event, kindLabel: KIND_LABEL[event.kind] }
  // 默认只把**异常**写进控制台（回收陈旧锁 / 跳过释放 / 超时 / 等了一会儿才拿到）：
  // 每一次正常获取都打日志会把宿主控制台刷满（采样器每分钟都在落盘），而"正常"没有信息量。
  // 全部事件仍然照发 onEvent（测试与自检据此断言"回收有原因"）。
  const notable =
    event.kind === 'reclaim' ||
    event.kind === 'release-skipped' ||
    event.kind === 'timeout' ||
    (event.kind === 'acquire' && (event.waitedMs ?? 0) >= 250)
  if (opts.verbose === true || (opts.quiet !== true && notable)) {
    log(`[lock] ${full.kindLabel} ${full.lockPath}：${full.reason}`)
  }
  opts.onEvent?.(full)
}

/** 读取锁文件现状；文件不存在返回 null */
export async function inspectLock(lockPath: string): Promise<LockSnapshot | null> {
  let mtimeMs: number
  try {
    mtimeMs = (await stat(lockPath)).mtimeMs
  } catch {
    return null
  }
  let holder: LockHolder | null = null
  try {
    const parsed: unknown = JSON.parse(await readFile(lockPath, 'utf8'))
    if (parsed !== null && typeof parsed === 'object' && typeof (parsed as { pid?: unknown }).pid === 'number') {
      holder = parsed as LockHolder
    }
  } catch {
    // 空文件/半截内容：只能靠 mtime 判陈旧（pidAlive 保持 null ⇒ "无法判定"）
  }
  const ageMs = Math.max(0, Date.now() - mtimeMs)
  return { lockPath, holder, mtimeMs, ageMs, pidAlive: holder === null ? null : pidAlive(holder.pid) }
}

/** 锁文件是否已陈旧到可回收；是则给出**原因**（人类可读 + 判据字段） */
export function staleReason(snap: LockSnapshot, staleMs: number): string | null {
  const pid = snap.holder?.pid ?? null
  if (snap.ageMs > staleMs) {
    return (
      `锁文件年龄 ${Math.round(snap.ageMs)}ms > staleMs ${staleMs}ms（心跳断供）` +
      `；持有者 pid=${pid ?? '未知'}${snap.pidAlive === null ? '（内容不可解析）' : snap.pidAlive ? '（仍在运行，但心跳已断供）' : '（进程已不存在）'}`
    )
  }
  if (snap.holder !== null && snap.pidAlive === false && snap.ageMs > DEAD_HOLDER_GRACE_MS) {
    return `持有者进程不存在（pid=${snap.holder.pid}，锁文件年龄 ${Math.round(snap.ageMs)}ms > 宽限 ${DEAD_HOLDER_GRACE_MS}ms）`
  }
  return null
}

/** 回收：把陈旧锁文件原子改名走（rename 只有一个赢家；赢家再创建新锁，输家重试） */
async function reclaimLock(snap: LockSnapshot, reason: string, opts: LockOptions, target: string): Promise<boolean> {
  const parking = `${snap.lockPath}.reclaimed-${new Date().toISOString().replace(/[:.]/g, '-')}`
  try {
    await rename(snap.lockPath, parking)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false // 别人先回收了
    throw error
  }
  emit(opts, {
    kind: 'reclaim',
    lockPath: snap.lockPath,
    target,
    ageMs: snap.ageMs,
    holderPid: snap.holder?.pid ?? null,
    holderAlive: snap.pidAlive,
    reason: `${reason}；原锁文件已改名留存为 ${parking}`,
  })
  return true
}

function startHeartbeat(lockPath: string, staleMs: number): () => void {
  const every = Math.max(200, Math.floor(staleMs / 3))
  const timer = setInterval(() => {
    const now = new Date()
    void utimes(lockPath, now, now).catch(() => undefined)
  }, every)
  // 心跳不许把进程（或测试）吊住
  if (typeof timer.unref === 'function') timer.unref()
  return () => clearInterval(timer)
}

async function acquireLock(lockPath: string, target: string, opts: LockOptions): Promise<HeldLock> {
  const staleMs = opts.staleMs ?? DEFAULT_STALE_MS
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const retryMs = opts.retryMs ?? DEFAULT_RETRY_MS
  const startedAt = Date.now()
  const deadline = startedAt + timeoutMs
  await mkdir(dirname(lockPath), { recursive: true }).catch(() => undefined)
  installExitHook()
  let round = 0
  for (;;) {
    const holder: LockHolder = { pid: process.pid, at: Date.now(), token: newToken(), target }
    if (opts.note !== undefined) holder.note = opts.note
    try {
      const fh = await open(lockPath, 'wx', 0o600)
      try {
        await fh.writeFile(JSON.stringify(holder))
      } finally {
        await fh.close()
      }
      const stop = startHeartbeat(lockPath, staleMs)
      emit(opts, {
        kind: 'acquire',
        lockPath,
        target,
        waitedMs: Date.now() - startedAt,
        reason: round === 0 ? '独占创建成功（O_EXCL）' : `等待 ${round} 轮后独占创建成功`,
      })
      return {
        lockPath,
        target,
        holder,
        depth: 1,
        release: async (): Promise<void> => {
          stop()
          await releaseLock(lockPath, holder, target, opts)
        },
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      const snap = await inspectLock(lockPath)
      if (snap !== null) {
        const reason = staleReason(snap, staleMs)
        if (reason !== null) {
          await reclaimLock(snap, reason, opts, target)
          continue // 立刻重试创建
        }
      }
      if (Date.now() >= deadline) {
        emit(opts, {
          kind: 'timeout',
          lockPath,
          target,
          waitedMs: Date.now() - startedAt,
          holderPid: snap?.holder?.pid ?? null,
          holderAlive: snap?.pidAlive ?? null,
          ageMs: snap?.ageMs,
          reason: `等待 ${Date.now() - startedAt}ms 仍未取得锁（timeoutMs ${timeoutMs}）`,
        })
        throw new LockTimeoutError(lockPath, snap?.holder ?? null, Date.now() - startedAt, timeoutMs)
      }
      round += 1
      emit(opts, {
        kind: 'wait',
        lockPath,
        target,
        waitedMs: Date.now() - startedAt,
        holderPid: snap?.holder?.pid ?? null,
        holderAlive: snap?.pidAlive ?? null,
        ageMs: snap?.ageMs,
        reason: `锁被占用（第 ${round} 轮等待）`,
      })
      await sleep(backoffMs(retryMs, round))
    }
  }
}

async function releaseLock(lockPath: string, holder: LockHolder, target: string, opts: LockOptions): Promise<void> {
  const snap = await inspectLock(lockPath)
  if (snap === null) {
    emit(opts, { kind: 'release', lockPath, target, reason: '锁文件已不存在（已被回收或已被释放）' })
    return
  }
  if (snap.holder === null || snap.holder.token !== holder.token) {
    // **数据安全**：自己可能被判陈旧后锁被别人重建 —— 这时删锁会破坏别人的互斥
    emit(opts, {
      kind: 'release-skipped',
      lockPath,
      target,
      holderPid: snap.holder?.pid ?? null,
      holderAlive: snap.pidAlive,
      ageMs: snap.ageMs,
      reason: `锁已易主（token 不匹配）⇒ 不误删别人的锁（当前持有者 pid=${snap.holder?.pid ?? '未知'}）`,
    })
    return
  }
  try {
    await unlink(lockPath)
    emit(opts, { kind: 'release', lockPath, target, reason: '已删除自己的锁文件' })
  } catch (error) {
    emit(opts, {
      kind: 'release-skipped',
      lockPath,
      target,
      reason: `删除锁文件失败：${String(error)}（交给陈旧回收）`,
    })
  }
}

function installExitHook(): void {
  if (exitHookInstalled) return
  exitHookInstalled = true
  process.once('exit', () => {
    for (const lock of held.values()) {
      try {
        unlinkSync(lock.lockPath)
      } catch {
        // 退出阶段尽力而为：删不掉就留给陈旧回收（kill -9 同理）
      }
    }
  })
}

/**
 * 在目标文件的跨进程锁内执行 `fn`。
 *
 * 可重入：同一进程已持有同一路径的锁时直接执行（不自锁、不重开锁文件）。
 * 不同路径按调用方给的顺序获取 —— 多处加锁请用 `withFileLocks`（它按路径排序，杜绝死锁）。
 */
export async function withFileLock<T>(target: string, fn: () => Promise<T> | T, opts: LockOptions = {}): Promise<T> {
  const lockPath = lockPathFor(target)
  const mine = held.get(lockPath)
  if (mine !== undefined) {
    mine.depth += 1
    try {
      return await fn()
    } finally {
      mine.depth -= 1
    }
  }
  const prev = queues.get(lockPath) ?? Promise.resolve()
  let openGate: () => void = () => undefined
  const gate = new Promise<void>((resolve) => {
    openGate = resolve
  })
  const queued = prev.then(() => gate)
  queues.set(lockPath, queued)
  try {
    await prev.catch(() => undefined) // 前一位持有者失败不该连坐我
    const lock = await acquireLock(lockPath, target, opts)
    held.set(lockPath, lock)
    try {
      return await fn()
    } finally {
      held.delete(lockPath)
      await lock.release()
    }
  } finally {
    openGate()
    if (queues.get(lockPath) === queued) queues.delete(lockPath)
  }
}

/**
 * 一次持有多个文件的锁（**按路径排序获取**，杜绝 A 等 B、B 等 A 的死锁）。
 * 用于"一次写入必须同时改多个文件"的场合（例如持仓 + 流水）。
 */
export async function withFileLocks<T>(targets: readonly string[], fn: () => Promise<T> | T, opts: LockOptions = {}): Promise<T> {
  const unique = [...new Set(targets)].sort()
  const step = async (i: number): Promise<T> => {
    if (i >= unique.length) return fn()
    return withFileLock(unique[i]!, () => step(i + 1), opts)
  }
  return step(0)
}

/** 读 JSON；文件不存在返回 null。内容坏掉时默认**抛错**（拒绝在锁内静默覆盖用户数据） */
export async function readJsonForUpdate(file: string, onCorrupt: 'throw' | 'null' = 'throw'): Promise<unknown> {
  let text: string
  try {
    text = await readFile(file, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
  try {
    return JSON.parse(text) as unknown
  } catch (error) {
    if (onCorrupt === 'null') return null
    throw new Error(`${file} 内容无法解析（${String(error)}）：拒绝在锁内改写它（避免把用户数据静默覆盖成空）`)
  }
}

/**
 * **锁内读-改-写**（唯一推荐的合并入口）：
 * 拿到锁 → 读**磁盘最新**内容 → 交给 `update` 算合并结果 → 原子写回 → 释放。
 *
 * 这样"读"与"写"之间没有窗口：另一个进程在此期间不可能插入一次写入（它也要抢同一把锁）。
 */
export async function updateJsonLocked(
  target: string,
  update: (disk: unknown) => unknown | Promise<unknown>,
  opts: LockOptions = {},
): Promise<unknown> {
  return withFileLock(
    target,
    async () => {
      const disk = await readJsonForUpdate(target, opts.onCorrupt ?? 'throw')
      const next = await update(disk)
      await writeJsonAtomic(target, next)
      return next
    },
    opts,
  )
}

/** JSON 对象里按路径取值（'a'/0 皆可；路径不存在返回 undefined） */
function docAt(root: unknown, path: readonly (string | number)[]): unknown {
  let cur: unknown = root
  for (const raw of path) {
    if (cur === null || typeof cur !== 'object') return undefined
    cur = (cur as Record<string, unknown>)[String(raw)]
  }
  return cur
}

/** JSON 对象里按路径写值（中间缺的层补成对象） */
function setDocAt(root: Record<string, unknown>, path: readonly (string | number)[], value: unknown): void {
  let cur = root
  for (let i = 0; i < path.length - 1; i += 1) {
    const key = String(path[i])
    const next = cur[key]
    if (next === null || typeof next !== 'object' || Array.isArray(next)) {
      const fresh: Record<string, unknown> = {}
      cur[key] = fresh
      cur = fresh
    } else {
      cur = next as Record<string, unknown>
    }
  }
  cur[String(path[path.length - 1])] = value
}

/**
 * **计数合并**：在锁内读磁盘现值，加上本次增量再写回（`samples += 1` 的正确实现）。
 *
 * 为什么不能写"我内存里的快照"：两个进程各自记得 `samples = 371`，各自 +1，谁后写谁赢
 * ⇒ 最终 372 而两次都该生效（373）。本函数写回的是"磁盘现值 + 本次增量" ⇒ 两次都在。
 */
export async function bumpJsonCounter(
  target: string,
  path: readonly (string | number)[],
  delta = 1,
  opts: LockOptions = {},
): Promise<number> {
  if (path.length === 0) throw new Error('bumpJsonCounter 需要非空路径（例如 ["samples"]）')
  let next = 0
  await updateJsonLocked(
    target,
    (disk) => {
      const doc: Record<string, unknown> = disk !== null && typeof disk === 'object' && !Array.isArray(disk)
        ? (disk as Record<string, unknown>)
        : {}
      const cur = docAt(doc, path)
      const base = typeof cur === 'number' && Number.isFinite(cur) ? cur : 0
      next = base + delta
      setDocAt(doc, path, next)
      return doc
    },
    opts,
  )
  return next
}

/**
 * 两组"追加式时间序列"的按 key 合并（结果按 key 升序；同 key 时 **b 覆盖 a**）。
 *
 * 为什么给它：两个进程各自往同一份日志里 append 时，"后写者整份覆写"会抹掉先写者刚记下的条目。
 * 正确做法是在 `updateJsonLocked` 的合并回调里把**磁盘那份**与**本进程那份**并起来 ——
 * 这个函数就是那个并集（`events` 按 `ts`、`intraday` 按 `hhmm`、`selfSamples` 按 `day` 都适用）。
 */
export function mergeByKey<T>(a: readonly T[], b: readonly T[], key: (item: T) => string | number): T[] {
  const merged = new Map<string | number, T>()
  for (const item of a) merged.set(key(item), item)
  for (const item of b) merged.set(key(item), item)
  return [...merged.values()].sort((x, y) => {
    const kx = key(x)
    const ky = key(y)
    if (typeof kx === 'number' && typeof ky === 'number') return kx - ky
    return String(kx) < String(ky) ? -1 : String(kx) > String(ky) ? 1 : 0
  })
}

/** 同步清理（仅供退出钩子与测试使用）：删除给定路径的锁文件 */
export function removeLockFileSync(lockPath: string): void {
  try {
    unlinkSync(lockPath)
  } catch {
    /* 不存在即目标达成 */
  }
}
