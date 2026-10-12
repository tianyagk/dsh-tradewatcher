/**
 * 跨进程锁与"不丢更新"的**实测**断言（本轮数据安全修复的证明，见 docs/AUDIT-IMPL42.md）。
 *
 * 纪律（与两份审计报告同一套）：
 *  - 断言锚**真文件系统 + 真子进程**（`spawn` 出 `lock.child.ts`），不用 mock、不用替身、
 *    不"自指"（进程内 Promise 队列挡不住两个 `dsh web`，拿它当证明等于没证明）；
 *  - 每条修法都配**反例注入**：`naive`（完全无锁）与 `inproc`（只做进程内队列）
 *    必须让同一条断言**失败**（`L2`/`L3`）——否则 `L1` 通过说明不了任何事；
 *  - 计数不丢更新的判据是**数字**：两个进程各 `samples += 3` ⇒ 最终必须是 6（少一次就是红）。
 *
 * **反例用例（L2/L3）为什么允许两种表现**（Lead 决定，2026-10-12）：
 * 反例是"故意把互斥去掉"的**对照**，它只证明"没有跨进程互斥就不行"，不证明"失败必然长什么样"。
 * 去掉互斥后，两个进程的实际表现有两种，**两种都算证明**：
 *   ① **丢更新** —— 后写者用自己那份快照整份覆写，先写者的 `+1` 被吞（`samples < 6`）；
 *   ② **崩溃/半截读** —— 无锁的整文件覆写不是原子的，读者可能读到半截 JSON（`JSON.parse` 抛错，
 *      子进程非 0 退出）。
 * 哪一种是时序决定的（文件级并行跑整套测试时更容易撞上 ②）。因此反例的判据写成
 * "**崩溃或丢更新，任一出现即通过**"，**不钉**具体结果、也不钉时序；只有"两次都被完整应用"
 * （＝反例不成立）才算失败。**正例（L1/L9）保持严格**：少一次就是红。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DataStore } from './store.ts'
import { LockTimeoutError, bumpJsonCounter, inspectLock, lockPathFor, mergeByKey, withFileLock, type LockEvent } from './lock.ts'

const FIXTURE = fileURLToPath(new URL('./lock.child.ts', import.meta.url))

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

interface Spawned {
  child: ChildProcess
  done: Promise<{ code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }>
  out: { text: string; err: string }
}

/** 起一个真子进程跑夹具（`--experimental-strip-types` 与主测试同一套加载方式） */
function spawnChild(job: Record<string, unknown>): Spawned {
  const child = spawn(process.execPath, ['--experimental-strip-types', '--no-warnings', FIXTURE, JSON.stringify(job)], {
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const out = { text: '', err: '' }
  child.stdout?.on('data', (b: Buffer) => {
    out.text += b.toString('utf8')
  })
  child.stderr?.on('data', (b: Buffer) => {
    out.err += b.toString('utf8')
  })
  const done = new Promise<{ code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }>((resolve) => {
    child.on('close', (code, signal) => resolve({ code, signal, stdout: out.text, stderr: out.err }))
  })
  return { child, done, out }
}

async function waitUntil(cond: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`等待条件超时（${timeoutMs}ms）`)
    await sleep(10)
  }
}

function readJson(file: string): Record<string, unknown> {
  return JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
}

function seedCounter(file: string, samples = 0): void {
  writeFileSync(file, JSON.stringify({ samples }), 'utf8')
}

/** 读计数器；文件半截/不存在 ⇒ null（＝反例的"崩溃"表现之一） */
function readCounterOrNull(file: string): number | null {
  try {
    const v = (JSON.parse(readFileSync(file, 'utf8')) as { samples?: unknown }).samples
    return typeof v === 'number' ? v : null
  } catch {
    return null
  }
}

/**
 * 反例判据（见文件头"反例为什么允许两种表现"）：无跨进程互斥时，必须出现
 * **崩溃/半截读**（子进程非 0 退出，或最终文件读不出来）**或 丢更新**（`samples < 6`）中的至少一种。
 * 只有"两个进程各 3 次都被完整应用（= 6 且都正常退出）"才判失败 —— 那说明这次对照没有生效。
 */
function assertNoMutexLeavesDamage(
  label: string,
  runs: Array<{ code: number | null; signal: NodeJS.Signals | null; stderr: string }>,
  samples: number | null,
): void {
  const crashed = runs.some((r) => r.code !== 0 || r.signal !== null)
  const unreadable = samples === null
  const lostUpdate = samples !== null && samples < 6
  assert.ok(
    crashed || unreadable || lostUpdate,
    `${label}：去掉互斥后必须出现"崩溃/半截读"或"丢更新"中的至少一种，` +
      `实测退出码=[${runs.map((r) => r.code).join(',')}] samples=${String(samples)}` +
      `（若两者各 3 次都被完整应用 ⇒ 这次对照没生效，必须重跑而不是判过）`,
  )
}

// ─────────────────── L1：跨进程计数合并（不丢更新） ───────────────────

test('L1 跨进程不丢更新：两个真子进程各 samples += 3 ⇒ 最终 6（一次都没被吞）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tw-lock-bump-'))
  const file = join(dir, 'state.json')
  seedCounter(file)
  // 对齐时刻：让两个进程真的同时来抢同一把锁（否则"没并发"会让断言失去意义）
  const startAt = Date.now() + 600
  const a = spawnChild({ mode: 'bump', file, startAt, count: 3, holdMs: 80, tag: 'a' })
  const b = spawnChild({ mode: 'bump', file, startAt, count: 3, holdMs: 80, tag: 'b' })
  const [ra, rb] = await Promise.all([a.done, b.done])
  assert.equal(ra.code, 0, `子进程 A 应正常退出：${ra.stderr || ra.stdout}`)
  assert.equal(rb.code, 0, `子进程 B 应正常退出：${rb.stderr || rb.stdout}`)
  assert.equal(readJson(file).samples, 6, '两次 × 三次都必须生效（丢任何一次都会 < 6）')
  assert.equal(existsSync(lockPathFor(file)), false, '写完之后锁文件必须被释放（不能留成第二个"陈旧锁"来源）')
})

test('L2 反例注入①：**完全无锁**的读-改-写必须露出破损（崩溃/半截读 或 丢更新，任一即证明）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tw-lock-naive-'))
  const file = join(dir, 'state.json')
  seedCounter(file)
  const startAt = Date.now() + 600
  const a = spawnChild({ mode: 'naive', file, startAt, count: 3, holdMs: 200 })
  const b = spawnChild({ mode: 'naive', file, startAt, count: 3, holdMs: 200 })
  const [ra, rb] = await Promise.all([a.done, b.done])
  assertNoMutexLeavesDamage('L2（完全无锁）', [ra, rb], readCounterOrNull(file))
})

test('L3 反例注入②：只做**进程内队列**（没有锁文件）同样不行 ⇒ 跨进程互斥必须靠锁文件', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tw-lock-inproc-'))
  const file = join(dir, 'state.json')
  seedCounter(file)
  const startAt = Date.now() + 600
  const a = spawnChild({ mode: 'inproc', file, startAt, count: 3, holdMs: 200 })
  const b = spawnChild({ mode: 'inproc', file, startAt, count: 3, holdMs: 200 })
  const [ra, rb] = await Promise.all([a.done, b.done])
  // 进程内队列对**本进程**是串行的（所以不会读到半截），但跨进程照样互相覆盖
  assertNoMutexLeavesDamage('L3（只有进程内队列）', [ra, rb], readCounterOrNull(file))
})

// ─────────────────── L4：陈旧锁回收（有原因、不静默） ───────────────────

test('L4 陈旧锁能在有界时间内被回收，且回收**带原因**（不是静默抢锁）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tw-lock-stale-'))
  const file = join(dir, 'rescue-log.json')
  seedCounter(file, 1)
  const lockPath = lockPathFor(file)
  // 模拟"某个被 kill -9 的进程留下的锁"：一个不存在的 pid + 很旧的 mtime
  const holder = { pid: 999_999, at: Date.now() - 60_000, token: 'dead-holder', target: file, note: 'stale-injection' }
  writeFileSync(lockPath, JSON.stringify(holder), 'utf8')
  const old = new Date(Date.now() - 60_000)
  utimesSync(lockPath, old, old)

  const events: LockEvent[] = []
  const t0 = Date.now()
  const value = await bumpJsonCounter(file, ['samples'], 1, {
    staleMs: 500,
    timeoutMs: 5_000,
    onEvent: (e) => events.push(e),
  })
  const elapsed = Date.now() - t0
  assert.equal(value, 2, '回收之后这次 +1 必须生效')
  const reclaim = events.find((e) => e.kind === 'reclaim')
  assert.ok(reclaim !== undefined, `必须有 reclaim 事件（回收不许静默）：${JSON.stringify(events.map((e) => e.kind))}`)
  assert.match(reclaim.reason, /心跳断供|进程已不存在/, `回收原因要写清判据：${reclaim.reason}`)
  assert.match(reclaim.reason, /pid=999999/, `回收原因要带上持有者 pid：${reclaim.reason}`)
  assert.equal(reclaim.holderPid, 999_999)
  assert.ok(elapsed < 5_000, `回收必须有界，实测 ${elapsed}ms`)
  // 原锁文件被**改名留存**（事后能查"是谁留下的"），不是被悄悄删掉
  assert.ok(
    readdirSync(dir).some((f) => f.includes('.lock.reclaimed-')),
    `原锁文件应改名留存，实际目录：${readdirSync(dir).join(',')}`,
  )
})

test('L5 等待是有界的：锁被占用 ⇒ 超时抛 LockTimeoutError，且**不写**（宁可失败也不覆盖）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tw-lock-timeout-'))
  const file = join(dir, 'state.json')
  seedCounter(file)
  const { done, out } = spawnChild({ mode: 'hold', file, holdMs: 2_500 })
  await waitUntil(() => out.text.includes('held'))
  const t0 = Date.now()
  let threw: unknown = null
  try {
    await bumpJsonCounter(file, ['samples'], 1, { staleMs: 60_000, timeoutMs: 250, quiet: true })
  } catch (error) {
    threw = error
  }
  const elapsed = Date.now() - t0
  assert.ok(threw instanceof LockTimeoutError, `应抛 LockTimeoutError，实际：${String(threw)}`)
  // 上界远小于持有者的 2500ms：证明"超时就真的放弃"，不是"等到持有者释放才写"
  assert.ok(elapsed >= 200 && elapsed < 1_500, `超时必须在 timeoutMs 附近（实测 ${elapsed}ms），不能死等也不能立刻放弃`)
  assert.equal(readJson(file).samples, 0, '等待超时后**不许写**：宁可这次失败，也不能覆盖持有者的数据')
  const held = await inspectLock(lockPathFor(file))
  assert.ok(held !== null && held.holder !== null, '此刻锁仍应属于子进程')
  await done
  // 持有者释放后，同一路径立刻可用（超时不会把锁搞坏）
  const value = await bumpJsonCounter(file, ['samples'], 1, { staleMs: 60_000, timeoutMs: 2_000 })
  assert.equal(value, 1)
})

// ─────────────────── L6：崩溃恢复（kill -9） ───────────────────

test('L6a kill -9 打断高频写入：状态文件任何时刻都可解析、不半截（原子写的意义）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tw-lock-crash-'))
  const file = join(dir, 'state.json')
  const { child, done } = spawnChild({ mode: 'crash-writer', file, holdMs: 0 })
  let reads = 0
  let torn = 0
  const deadline = Date.now() + 3_000
  while (Date.now() < deadline && reads < 40) {
    try {
      const doc = readJson(file)
      // 半截写会在这里现形：pad 被截断 ⇒ length < 20000
      if ((doc.pad as string).length !== 20_000) torn += 1
      reads += 1
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') torn += 1
    }
    await sleep(15)
  }
  child.kill('SIGKILL')
  const killed = await done
  assert.equal(killed.signal, 'SIGKILL', '本用例必须用 SIGKILL 打断（不给退出钩子任何机会）')
  assert.ok(reads > 0, '被杀之前必须读到过完整内容')
  assert.equal(torn, 0, `被 kill -9 的进程不可能写出半截文件（临时文件 + rename）：torn=${torn}`)
  const doc = readJson(file)
  assert.equal((doc.pad as string).length, 20_000)
})

test('L6b kill -9 留下的锁在**有界时间**内被回收，且带原因（pid + 年龄）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tw-lock-crash2-'))
  const file = join(dir, 'rescue-log.json')
  // holdMs 很大 ⇒ 子进程必然是在"持锁期间"被杀掉（遗留锁是必然事件，不是碰运气）
  const { child, done } = spawnChild({ mode: 'crash-writer', file, holdMs: 5_000 })
  await waitUntil(() => existsSync(file), 4_000)
  const before = await inspectLock(lockPathFor(file))
  assert.ok(before !== null, '子进程被杀之前应当持有锁')
  child.kill('SIGKILL')
  const killed = await done
  assert.equal(killed.signal, 'SIGKILL')
  assert.ok(existsSync(lockPathFor(file)), 'SIGKILL 不执行退出钩子 ⇒ 锁文件必然留下（这正是要回收的对象）')
  const events: LockEvent[] = []
  const t0 = Date.now()
  await withFileLock(file, () => undefined, { staleMs: 300, timeoutMs: 6_000, onEvent: (e) => events.push(e) })
  const elapsed = Date.now() - t0
  assert.ok(elapsed < 6_000, `回收必须有界，实测 ${elapsed}ms`)
  const reclaim = events.find((e) => e.kind === 'reclaim')
  assert.ok(reclaim !== undefined, '回收陈旧锁必须留痕（事件/日志）')
  assert.match(reclaim.reason, /心跳断供|进程已不存在/, reclaim.reason)
  assert.equal(existsSync(lockPathFor(file)), false, '新持有者释放后锁文件应清空')
})

// ─────────────────── L7：锁的边界（释放安全 / 可重入） ───────────────────

test('L7 自己已被判陈旧后释放：绝不误删别人重建的锁（token 校验）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tw-lock-token-'))
  const file = join(dir, 'state.json')
  seedCounter(file)
  const lockPath = lockPathFor(file)
  const events: LockEvent[] = []
  await withFileLock(
    file,
    () => {
      // 在锁内模拟"我的锁被判陈旧回收了、另一个进程重建了一把"：
      // 若释放时不校验 token，就会把别人的锁删掉 ⇒ 两个进程同时进临界区
      writeFileSync(
        lockPath,
        JSON.stringify({ pid: 4242, at: Date.now(), token: 'someone-else', target: file, note: 'rebuilt' }),
        'utf8',
      )
    },
    { onEvent: (e) => events.push(e) },
  )
  assert.ok(events.some((e) => e.kind === 'release-skipped'), `必须报 release-skipped：${JSON.stringify(events.map((e) => e.kind))}`)
  assert.ok(existsSync(lockPath), '别人的锁必须还在')
  assert.equal(readJson(lockPath).token, 'someone-else', '锁文件内容不许被我的释放动过')
})

test('L8 同进程同一路径可重入：嵌套获取不自锁、也不重复建锁文件', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tw-lock-reentrant-'))
  const file = join(dir, 'state.json')
  seedCounter(file)
  const lockPath = lockPathFor(file)
  const inner: LockEvent[] = []
  const outer: LockEvent[] = []
  await withFileLock(
    file,
    async () => {
      await withFileLock(
        file,
        async () => {
          assert.ok(existsSync(lockPath), '内层执行时锁文件应当存在')
          await bumpJsonCounter(file, ['samples'], 1)
        },
        { onEvent: (e) => inner.push(e) },
      )
      assert.ok(existsSync(lockPath), '内层退出后外层仍持有锁')
      await bumpJsonCounter(file, ['samples'], 1)
    },
    { onEvent: (e) => outer.push(e) },
  )
  assert.equal(readJson(file).samples, 2)
  assert.equal(existsSync(lockPath), false, '最外层释放后锁文件必须消失')
  assert.equal(outer.filter((e) => e.kind === 'acquire').length, 1, '外层只应获取一次')
  assert.equal(inner.filter((e) => e.kind === 'acquire').length, 0, '内层是可重入 ⇒ 不应再获取一次（也不该出现第二把锁）')
})

// ─────────────────── L11：合并基础件（供 rescue-log 等追加式日志用） ───────────────────

test('L11 mergeByKey：两个进程各记的条目并起来（按 ts 升序、同 key 后者为准）', () => {
  const a = [{ ts: 300, who: 'disk' }, { ts: 100, who: 'disk' }]
  const b = [{ ts: 200, who: 'mem' }, { ts: 300, who: 'mem' }]
  assert.deepEqual(
    mergeByKey(a, b, (x) => x.ts),
    [{ ts: 100, who: 'disk' }, { ts: 200, who: 'mem' }, { ts: 300, who: 'mem' }],
    '并集 + 升序 + 同 ts 以本进程为准',
  )
  assert.deepEqual(mergeByKey([], [], (x: { ts: number }) => x.ts), [], '空集不出错')
  assert.deepEqual(
    mergeByKey([{ hhmm: '09:31' }], [{ hhmm: '09:30' }], (x) => x.hhmm),
    [{ hhmm: '09:30' }, { hhmm: '09:31' }],
    '字符串 key 同样按升序（hhmm）',
  )
})

// ─────────────────── L9/L10：真 DataStore 的跨进程行为 ───────────────────

test('L9 真 DataStore 跨进程：两个进程各写自己的自选/持仓/流水 ⇒ 两边都在（不丢更新）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tw-lock-store-'))
  const startAt = Date.now() + 800
  const a = spawnChild({ mode: 'store-add', dir, startAt, count: 6, tag: 'aa' })
  const b = spawnChild({ mode: 'store-add', dir, startAt, count: 6, tag: 'bb' })
  const [ra, rb] = await Promise.all([a.done, b.done])
  assert.equal(ra.code, 0, `A 应正常退出：${ra.stderr || ra.stdout}`)
  assert.equal(rb.code, 0, `B 应正常退出：${rb.stderr || rb.stdout}`)
  const watch = readJson(join(dir, 'watch.json')) as { groups: unknown[]; items: Array<{ name: string }> }
  const port = readJson(join(dir, 'positions.json')) as { groups: unknown[]; items: Array<{ name: string }> }
  const ledger = readJson(join(dir, 'ledger.json')) as { entries: Array<{ verb: string }> }
  for (const tag of ['aa', 'bb']) {
    assert.equal(watch.items.filter((i) => i.name.startsWith(`W${tag}`)).length, 6, `${tag} 的 6 条自选都必须在（被覆盖就会少）`)
    assert.equal(port.items.filter((i) => i.name.startsWith(`P${tag}`)).length, 6, `${tag} 的 6 条持仓都必须在`)
  }
  assert.equal(watch.groups.length, 2, '两个进程各建的自选分组都要在')
  assert.equal(port.groups.length, 2, '两个进程各建的持仓分组都要在')
  assert.equal(watch.items.length, 12, `自选条目总数应为 12，实得 ${watch.items.length}`)
  assert.equal(port.items.length, 12, `持仓条目总数应为 12，实得 ${port.items.length}`)
  assert.equal(ledger.entries.filter((e) => e.verb === 'add').length, 12, '流水一条都不能丢（账本是用户唯一的交易记录）')
  for (const f of ['watch.json', 'positions.json', 'ledger.json']) {
    assert.equal(existsSync(lockPathFor(join(dir, f))), false, `${f} 的锁文件应已释放`)
  }
})

test('L10 覆盖证明：store 的四个状态文件都**真的**在锁内写（外部持锁时写入会等待）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tw-lock-store-wait-'))
  const store = new DataStore(dir)
  await store.init()
  const watch = await store.mutateWatch({ op: 'addGroup', name: 'g1' })
  const gid = watch.groups[0]!.id
  const HOLD_MS = 500
  const cases: Array<[string, () => Promise<unknown>]> = [
    ['watch.json', () => store.mutateWatch({ op: 'renameGroup', groupId: gid, name: `g-${Date.now()}` })],
    ['prefs.json', () => store.setPrefs({ refreshSec: 12 })],
    // 持仓与流水的写入是**同一个** mutatePortfolio（一次写两个文件）⇒ 分别验两个文件的锁
    ['positions.json', () => store.mutatePortfolio({ op: 'addGroup', name: `p-${Date.now()}` })],
    ['ledger.json', () => store.mutatePortfolio({ op: 'addGroup', name: `p2-${Date.now()}` })],
  ]
  for (const [file, op] of cases) {
    const { done, out } = spawnChild({ mode: 'hold', file: join(dir, file), holdMs: HOLD_MS })
    await waitUntil(() => out.text.includes('held'))
    const t0 = Date.now()
    await op()
    const waited = Date.now() - t0
    const finished = await done
    assert.equal(finished.code, 0, `${file} 的持锁子进程应正常退出：${finished.stderr}`)
    assert.ok(
      waited >= HOLD_MS - 200,
      `${file}：外部持锁 ${HOLD_MS}ms 期间写入只等了 ${waited}ms ⇒ 这个文件**没有**被 store 加锁（覆盖清单漏项）`,
    )
  }
})
