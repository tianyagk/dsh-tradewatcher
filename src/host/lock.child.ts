/**
 * 跨进程并发测试的**子进程夹具**（`lock.test.ts` spawn 它；也可手工跑，用法见 docs/AUDIT-IMPL42.md）。
 *
 * 为什么必须是真子进程：要证明的是**跨进程**互斥。进程内的 Promise 队列
 * （`singleflight.ts` / 本模块的 `writeChain`）挡不住两个 `dsh web` 互相覆盖 ——
 * 用它当证明就是自指。这里的每个模式都是"真实现 + 真文件系统"，没有 mock、没有替身。
 *
 *   bump         锁内 `samples += 1`（`withFileLock` + `bumpJsonCounter`）
 *   naive        反例①：**完全不加锁**的"读 → 改 → 写"（＝修复前的行为）⇒ 断言必须失败
 *   inproc       反例②：只做**进程内队列**（＝"以为串行化就够了"）⇒ 跨进程仍然丢更新
 *   store-add    真 `DataStore`：并发写自选/持仓/流水（走 store 的跨进程锁）
 *   crash-writer 循环"持锁 + 原子写大 payload"，供父进程 `kill -9` 打断
 *   hold         持锁一段时间，供父进程验证"等待是有界的（超时抛错，而不是死等或照写）"
 *
 * 用法：`node --experimental-strip-types src/host/lock.child.ts '<JSON 参数>'`
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { DataStore } from './store.ts'
import { bumpJsonCounter, withFileLock } from './lock.ts'
import { writeJsonAtomic } from './atomic.ts'

/** crash-writer 每份 payload 的填充长度（父进程据此判断"半截写"） */
const PAD_LEN = 20_000

interface Job {
  mode?: string
  file?: string
  dir?: string
  /** 两个子进程的对齐时刻（epoch ms）：让它们真的撞在一起，而不是各自跑得飞快 */
  startAt?: number
  count?: number
  holdMs?: number
  tag?: string
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitFor(startAt: number | undefined): Promise<void> {
  if (startAt === undefined) return
  const delay = startAt - Date.now()
  if (delay > 0) await sleep(delay)
}

function readCounter(file: string): number {
  try {
    const doc = JSON.parse(readFileSync(file, 'utf8')) as { samples?: unknown }
    return typeof doc.samples === 'number' ? doc.samples : -1
  } catch {
    return -1
  }
}

/** 造 secid：`1.<tag><序号>`（满足 shared/model.ts 的 `SECID_RE = /^\d{1,3}\.[A-Za-z0-9]+$/`） */
function secidOf(tag: string, i: number): string {
  return `1.${tag}${String(i).padStart(3, '0')}`
}

function need(v: string | undefined, what: string): string {
  if (v === undefined || v === '') throw new Error(`夹具缺少参数 ${what}`)
  return v
}

const job = JSON.parse(process.argv[2] ?? '{}') as Job
const mode = job.mode ?? ''
const count = job.count ?? 1
const hold = job.holdMs ?? 0
const tag = job.tag ?? 'x'

if (mode === 'bump') {
  const file = need(job.file, 'file')
  await waitFor(job.startAt)
  for (let i = 0; i < count; i += 1) {
    // holdMs 模拟"读-改-写"在锁内占用的时间，让两个子进程真的撞在同一把锁上
    await withFileLock(file, async () => {
      await sleep(hold)
      await bumpJsonCounter(file, ['samples'], 1)
    })
  }
  process.stdout.write(`bump done samples=${readCounter(file)}\n`)
} else if (mode === 'naive') {
  // 反例①：修复前的行为 —— 读出来、改一下、整文件覆写回去，**没有锁也没有队列**
  const file = need(job.file, 'file')
  await waitFor(job.startAt)
  for (let i = 0; i < count; i += 1) {
    const doc = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
    const base = typeof doc.samples === 'number' ? doc.samples : 0
    await sleep(hold) // 拉开"读"与"写"之间的窗口：这正是整文件覆写丢更新的窗口
    writeFileSync(file, JSON.stringify({ ...doc, samples: base + 1 }))
  }
  process.stdout.write(`naive done samples=${readCounter(file)}\n`)
} else if (mode === 'inproc') {
  // 反例②：只串行化**本进程内**的写入（＝"加个 Promise 队列就够了"）。跨进程依然互相覆盖。
  const file = need(job.file, 'file')
  let chain: Promise<void> = Promise.resolve()
  const queuedBump = (): Promise<void> => {
    const run = chain.then(async () => {
      const doc = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
      const base = typeof doc.samples === 'number' ? doc.samples : 0
      await sleep(hold)
      writeFileSync(file, JSON.stringify({ ...doc, samples: base + 1 }))
    })
    chain = run.catch(() => undefined)
    return run
  }
  await waitFor(job.startAt)
  for (let i = 0; i < count; i += 1) await queuedBump()
  process.stdout.write(`inproc done samples=${readCounter(file)}\n`)
} else if (mode === 'store-add') {
  // 真实现：两个进程各自往**同一个数据目录**里建组、加自选、加持仓（每个 op 都走 store 的跨进程锁）
  const dir = need(job.dir, 'dir')
  const store = new DataStore(dir)
  await store.init()
  const watch = await store.mutateWatch({ op: 'addGroup', name: `wg-${tag}` })
  const wgid = watch.groups[watch.groups.length - 1]!.id
  await store.mutatePortfolio({ op: 'addGroup', name: `pg-${tag}` })
  const pgid = store.portData().groups.find((g) => g.name === `pg-${tag}`)!.id
  await waitFor(job.startAt)
  for (let i = 0; i < count; i += 1) {
    await store.mutateWatch({ op: 'addItem', groupId: wgid, secid: secidOf(tag, i), symbolName: `W${tag}${i}` })
    await store.mutatePortfolio({ op: 'addPos', groupId: pgid, secid: secidOf(tag, i), symbolName: `P${tag}${i}` })
  }
  process.stdout.write(`store-add done tag=${tag} items=${count}\n`)
} else if (mode === 'crash-writer') {
  // 循环：持锁 → 原子写一份大 payload → 在锁内停留 holdMs
  //（holdMs=0 ⇒ 写得尽可能密，供"写一半被 kill -9"的检测；holdMs 很大 ⇒ 供"遗留锁"的检测）
  const file = need(job.file, 'file')
  let n = 0
  for (;;) {
    n += 1
    await withFileLock(file, async () => {
      await writeJsonAtomic(file, { n, pad: 'x'.repeat(PAD_LEN) })
      if (hold > 0) await sleep(hold)
    })
  }
} else if (mode === 'hold') {
  const file = need(job.file, 'file')
  await withFileLock(file, async () => {
    process.stdout.write('held\n')
    await sleep(hold)
  })
  process.stdout.write('released\n')
} else {
  throw new Error(`未知夹具模式：${mode}`)
}
