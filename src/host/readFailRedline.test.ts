/**
 * R1 红线断言：「读不到」≠「没有」—— 读失败时**不得**整份覆写用户数据。
 *
 * 背景（docs/REVIEW-2-CORRECTNESS.md §R1）：账本 / 日历事件 / 90 天快照三处
 * 都把 EACCES/EIO/半截文件与 ENOENT（首次）等同 ⇒ 返回空数据 ⇒ 下一次落盘整份覆写
 * ⇒ 用户唯一的数据被静默抹掉（复核实测：账本 3 条 → 1 条）。
 *
 * 模拟"读不到"：把文件 `chmod 000`（EACCES）。本机 uid=1000（非 root）⇒ 读确实被拒。
 * ⚠ 写回用的是 tmp+rename，只要**目录**可写，chmod 000 的原文件照样会被替换掉 ——
 * 这正是必须由守卫（而不是靠权限）来拦住的原因。
 *
 * 断言口径：① 变更必须**失败**（不是静默成功）② 磁盘上的原数据**条数不变**
 * ③ 失败原因如实出现在披露面（`readFailures()` / `syncStatus().missing`）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DataStore } from './store.ts'
import { CalendarStore } from './calendar.ts'

const HOME_ROOT = mkdtempSync(join(tmpdir(), 'fix1-r1-'))
if (!HOME_ROOT.startsWith('/tmp')) throw new Error(`拒绝运行：实验目录必须在 /tmp 下（收到 ${HOME_ROOT}）`)

/** 读回文件（先把权限改回来，否则测试自己都读不了） */
function readAfterRestore(path: string): unknown {
  chmodSync(path, 0o600)
  return JSON.parse(readFileSync(path, 'utf8'))
}

test('R1-① 账本：读失败时变更必须失败，且磁盘上的流水条数不变（不被空账本覆写）', async () => {
  const dir = join(HOME_ROOT, 'ledger')
  mkdirSync(dir, { recursive: true })
  const store = new DataStore(dir)
  await store.init()
  await store.mutatePortfolio({ op: 'addGroup', name: '主仓' })
  const groupId = store.portData().groups[0]?.id
  assert.ok(typeof groupId === 'string', '前置：分组已建立')
  await store.mutatePortfolio({ op: 'addPos', groupId, secid: '1.600519', symbolName: '贵州茅台' })
  const posId = store.portData().items[0]?.id
  assert.ok(typeof posId === 'string', '前置：持仓已建立')
  await store.mutatePortfolio({ op: 'buy', posId, qty: 100, price: 1278.25, fee: 5 })
  const ledgerPath = join(dir, 'ledger.json')
  const before = JSON.parse(readFileSync(ledgerPath, 'utf8')) as { entries: unknown[] }
  assert.ok(before.entries.length >= 3, `前置：磁盘上有多条流水（实际 ${before.entries.length} 条）`)
  const baseline = before.entries.length

  // 模拟 EACCES：文件还在、数据还在，就是读不到
  chmodSync(ledgerPath, 0o000)
  const store2 = new DataStore(dir)
  await store2.init()
  assert.ok(
    store2.readFailures().some((f) => f.file === 'ledger.json'),
    `读失败必须被记下来（实际 ${JSON.stringify(store2.readFailures())}）`,
  )
  // 任何会写账本的变更都必须失败
  await assert.rejects(
    async () => store2.mutatePortfolio({ op: 'buy', posId: posId as string, qty: 100, price: 10, fee: 0 }),
    /读不到|UnreadableFileError/,
    '读不到账本时，写账本的变更必须抛错（不许静默成功）',
  )
  await assert.rejects(async () => store2.touch(), /读不到|UnreadableFileError/, 'touch()（三文件落盘）同样必须被拦下')
  const after = readAfterRestore(ledgerPath) as { entries: unknown[] }
  assert.equal(after.entries.length, baseline, `磁盘上的流水条数必须不变（${baseline} 条不能被空账本抹掉）`)
})

test('R1-② 日历：读失败时写回必须被拒，用户手记的事件不被自动同步结果覆盖', async () => {
  const dir = join(HOME_ROOT, 'calendar')
  mkdirSync(dir, { recursive: true })
  const cal = new CalendarStore(dir)
  await cal.init()
  await cal.mutate({ op: 'add', title: '用户手记：分红到账', date: '2026-10-20', category: 'other' })
  const calPath = join(dir, 'calendar.json')
  const before = JSON.parse(readFileSync(calPath, 'utf8')) as { events: Array<{ title: string }> }
  assert.equal(before.events.length, 1, '前置：磁盘上有 1 条手记事件')

  chmodSync(calPath, 0o000)
  const cal2 = new CalendarStore(dir)
  await cal2.init()
  assert.ok(cal2.readFailures().some((f) => f.file.endsWith('calendar.json')), '读失败必须被记下来')
  await assert.rejects(
    async () => cal2.mutate({ op: 'add', title: '第二条', date: '2026-10-21', category: 'other' }),
    /读不到|UnreadableFileError/,
    '读不到本地日历时，写回必须被拒（否则手记事件会被覆盖）',
  )
  // 披露面：同步状态里必须说明"本地文件读不到"，并且整体标记为降级
  const status = cal2.syncStatus()
  assert.ok(
    status.missing.some((m) => m.what.includes('本地日历文件') && m.note.includes('读不到')),
    `syncStatus().missing 必须如实披露本地读不到（实际 ${JSON.stringify(status.missing)}）`,
  )
  assert.equal(status.stale, true, '读不到本地文件时整体必须是降级态')
  const after = readAfterRestore(calPath) as { events: Array<{ title: string }> }
  assert.equal(after.events.length, 1, '磁盘上的手记事件必须还在（条数不变、内容不变）')
  assert.equal(after.events[0]?.title, '用户手记：分红到账', '内容也不能被改写')
})

test('R1-③ 90 天快照：读失败时不得写回，历史 days 不被空快照抹掉', async () => {
  const home = join(HOME_ROOT, 'flow')
  mkdirSync(home, { recursive: true })
  process.env.DSH_HOME = home
  const gf = await import('./globalFlow.ts')
  const rec = {
    scope: 'A股/港股/美国/日本/韩国',
    at: Date.now(),
    total: { net: 1e8 },
    buckets: {},
    majors: [],
    up: 1,
    down: 1,
    even: 0,
  } as unknown as Parameters<typeof gf.writeFlowSnapshot>[1]
  const w1 = await gf.writeFlowSnapshot('2026-10-01', rec)
  const w2 = await gf.writeFlowSnapshot('2026-10-02', rec)
  assert.equal(w1.written && w2.written, true, '前置：两天快照已落盘')
  const path = join(home, 'dsh-tradewatcher', 'global-flow.json')
  const before = JSON.parse(readFileSync(path, 'utf8')) as { days: Record<string, unknown> }
  assert.deepEqual(Object.keys(before.days).sort(), ['2026-10-01', '2026-10-02'], '前置：磁盘上有 2 天历史')

  chmodSync(path, 0o000)
  const file = await gf.readFlowSnapshot()
  assert.deepEqual(Object.keys(file.days), [], '读不到时内存里只能是空的（不能编历史）')
  assert.ok(gf.flowReadFailures().length > 0, `读失败必须被记下来（实际 ${JSON.stringify(gf.flowReadFailures())}）`)
  const w3 = await gf.writeFlowSnapshot('2026-10-12', rec)
  assert.equal(w3.written, false, '读不到时必须拒绝写回')
  assert.match(String(w3.reason), /读不到|拒绝写回/, `拒绝原因必须说清（实际 ${String(w3.reason)}）`)
  const after = readAfterRestore(path) as { days: Record<string, unknown> }
  assert.deepEqual(
    Object.keys(after.days).sort(),
    ['2026-10-01', '2026-10-02'],
    '磁盘上的 2 天历史必须原样保留（不能被"空快照 + 新的一天"整份覆写）',
  )
})

test('R1-④ 首次启动（ENOENT）仍然是合法的空数据 —— 守卫不得把"本来就没有"也拦下', async () => {
  const dir = join(HOME_ROOT, 'fresh')
  mkdirSync(dir, { recursive: true })
  // 空目录：三个文件都不存在 ⇒ 必须照常工作（读失败与"首次"是两件事）
  const store = new DataStore(dir)
  await store.init()
  assert.deepEqual(store.readFailures(), [], '首次启动不得被记成"读失败"')
  await store.mutatePortfolio({ op: 'addGroup', name: '新组' })
  const written = JSON.parse(readFileSync(join(dir, 'positions.json'), 'utf8')) as { groups: unknown[] }
  assert.equal(written.groups.length, 1, '首次启动必须能正常写入（守卫不能一刀切禁写）')

  // 半截/坏 JSON 属于"读到了但内容坏"（不是"读不到"）⇒ 隔离原件（原字节保住）后允许继续
  const brokenDir = join(HOME_ROOT, 'broken')
  mkdirSync(brokenDir, { recursive: true })
  const brokenBody = '{"events": [ {"title": "半截'
  writeFileSync(join(brokenDir, 'calendar.json'), brokenBody)
  const cal = new CalendarStore(brokenDir)
  await cal.init()
  assert.deepEqual(cal.readFailures(), [], '坏 JSON 是"读到了但内容坏"，不该被记成"读不到"')
  const kept = readdirSync(brokenDir).filter((n) => n.startsWith('calendar.json.corrupt-'))
  assert.equal(kept.length, 1, `坏文件必须被隔离留档（实际 ${JSON.stringify(readdirSync(brokenDir))}）`)
  assert.equal(readFileSync(join(brokenDir, kept[0] as string), 'utf8'), brokenBody, '隔离件必须是原字节')
  await cal.mutate({ op: 'add', title: '坏文件之后的新事件', date: '2026-10-22', category: 'other' })
  const now = JSON.parse(readFileSync(join(brokenDir, 'calendar.json'), 'utf8')) as { events: Array<{ title: string }> }
  assert.equal(now.events.length, 1, '坏 JSON 被隔离后，新事件应能正常落盘')
})
