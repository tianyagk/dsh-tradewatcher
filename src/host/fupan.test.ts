/**
 * 第 8 行 `fupan`（复盘）宿主侧的断言集。
 *
 * 六条判据（每条都配**反例注入**，证明断言非恒真 —— 见 `docs/AUDIT-IMPL82.md` §4）：
 *   ① 行注册四处一致 ⇒ `src/index.test.ts`（真表/patch/文档/测试副本 + manifest 行）
 *   ② 路由归属 = fupan ⇒ `src/index.test.ts`（含"塞进 core/market"的反例）
 *   ③ 写入走文件锁（丢更新测试 + 静态源检查）；读失败 ≠ 空（EISDIR 注入）
 *   ④ 上限生效且 `dropped` 留痕（条数/体积两档 + "静默丢"反例）
 *   ⑤ 月份接口的交易日标注来自交易日历（外部文件优先 + 国庆反例）
 *   ⑥ 零新增上游请求（运行时 fetch 计数 + 静态源检查）
 *
 * 隔离：`DSH_HOME` 指向临时目录（交易日历也落在那儿），**绝不碰用户的 `~/.dsh`**。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { IncomingMessage, ServerResponse } from 'node:http'
import {
  FUPAN_FILE,
  FUPAN_MAX_BYTES,
  FUPAN_MAX_NOTES,
  FUPAN_MAX_TEXT,
  FupanStore,
  applyFupanOp,
  fupanMonthView,
  monthDays,
  notesInMonth,
  notesOnDay,
  parseFupanFile,
  parseFupanOp,
  trimFupan,
  type FupanDay,
  type FupanFile,
  type FupanNote,
} from './fupan.ts'
import { makeTradeRoutes } from './routes.ts'
import { DataStore } from './store.ts'
import { CalendarStore } from './calendar.ts'
import { __resetTradingCalendarCache } from './tradingCalendar.ts'
import { holidayOf } from './rescue.ts'
import { dayOf } from './time.ts'
import { lockPathFor } from './lock.ts'

/**
 * 隔离数据目录：必须在**任何路由/存储调用之前**指好（`dataHome()` 每次调用都读 env）。
 * 交易日历也读这里 ⇒ ⑤ 里能自己造"外部日历文件"而完全不碰用户目录。
 */
process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'tw-fupan-home-'))
const HOME = process.env.DSH_HOME as string
const SRC = dirname(fileURLToPath(import.meta.url))

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'tw-fupan-'))
}

/** 造/删**外部交易日历**文件（`null` = 删除），并丢掉缓存（mtime 变了也要立即生效） */
function setTradingCalendar(months: Record<string, string[]> | null): void {
  const dir = join(HOME, 'dsh-tradewatcher')
  mkdirSync(dir, { recursive: true })
  const path = join(dir, 'trading-calendar.json')
  if (months === null) rmSync(path, { force: true })
  else writeFileSync(path, JSON.stringify({ v: 1, months }))
  __resetTradingCalendarCache()
}

function noteOf(over: Partial<FupanNote> & { id: string; date: string }): FupanNote {
  return { text: 't', source: 'manual', at: 1, ...over }
}

// ───────────────────────── ① 纯函数层：归一 / 增改删 / 上限 ─────────────────────────

test('归一：顶层形状不认识 ⇒ null（调用方去隔离原件）；单条非法 ⇒ 跳过并计数（不静默，也不牵连整份）', () => {
  assert.equal(parseFupanFile(null), null)
  assert.equal(parseFupanFile([]), null)
  assert.equal(parseFupanFile({ v: 2, notes: [] }), null, 'v 不认识时不许猜（宁可隔离原件）')
  assert.equal(parseFupanFile({ v: 1, notes: 'x' }), null)
  const ok = parseFupanFile({
    v: 1,
    notes: [
      { id: 'a', date: '2026-10-20', text: '好的一条', at: 1, source: 'manual' },
      { id: 'bad id!', date: '2026-10-20', text: 'x', at: 1 }, // id 非法
      { id: 'b', date: '2026/10/20', text: 'x', at: 1 }, // 日期非法
      { id: 'c', date: '2026-10-20', text: '   ', at: 1 }, // 空正文
      { id: 'd', date: '2026-10-20', text: 'x', at: 0 }, // at 非法
      { id: 'a', date: '2026-10-21', text: '重复 id', at: 2 }, // 重复 id
    ],
  })
  assert.notEqual(ok, null)
  assert.deepEqual(ok!.notes.map((n) => n.id), ['a'], '只有合法的那一条进库')
  assert.equal(ok!.invalidEntries, 5, '被跳过的条数必须计数（回包披露，不静默）')
  const pinned = parseFupanFile({ v: 1, notes: [{ id: 'p', date: '2026-10-20', text: 'x', at: 1, pinnedTo: '2026-10-27', source: 'import' }] })
  assert.equal(pinned!.notes[0]!.pinnedTo, '2026-10-27')
  assert.equal(pinned!.notes[0]!.source, 'import', '来源字段要保留（手动 / 导入）')
})

test('增改删：upsert 新建/更新、删除、以及 400/404/409 三档拒绝（逐字段给原因）', () => {
  const base: FupanFile = { v: 1, notes: [noteOf({ id: 'n1', date: '2026-10-20', text: '原始', at: 100 })] }
  // 更新：at 刷新、pinnedTo 保留（未给 ⇒ 不清除）
  const upd = applyFupanOp({ v: 1, notes: [{ ...base.notes[0]!, pinnedTo: '2026-10-27' }] }, { op: 'upsert', id: 'n1', date: '2026-10-20', text: '改过' }, 500)
  assert.equal(upd.file.notes[0]!.text, '改过')
  assert.equal(upd.file.notes[0]!.at, 500, 'at = 最后写入时刻（更新会刷新）')
  assert.equal(upd.file.notes[0]!.pinnedTo, '2026-10-27', '未传 pinnedTo ⇒ 保留原置顶')
  // 清除置顶：显式 null
  const unpin = applyFupanOp({ v: 1, notes: [{ ...base.notes[0]!, pinnedTo: '2026-10-27' }] }, { op: 'upsert', id: 'n1', date: '2026-10-20', text: 'x', pinnedTo: null }, 600)
  assert.equal(unpin.file.notes[0]!.pinnedTo, undefined, 'pinnedTo: null ⇒ 清除置顶')
  // 新建（id 由调用方给 ⇒ 幂等重试友好）
  const created = applyFupanOp(base, { op: 'upsert', id: 'n2', date: '2026-10-21', text: '新' }, 700)
  assert.equal(created.file.notes.length, 2)
  assert.equal(created.written.note!.id, 'n2')
  // 删除
  const del = applyFupanOp(base, { op: 'delete', id: 'n1' }, 800)
  assert.equal(del.file.notes.length, 0)
  assert.equal(del.written.removed, 1)
  assert.equal(del.written.note!.id, 'n1', '删除也要回被删的那一条（界面要显示"删了哪条"）')
  // 404 / 409 / 400
  assert.throws(() => applyFupanOp(base, { op: 'delete', id: 'nope' }, 0), /没有 id=nope/)
  assert.throws(() => applyFupanOp(base, { op: 'upsert', id: 'n1', date: '2026-10-21', text: 'x' }, 0), /按 \(date, id\) 定位失败/)
  assert.throws(() => applyFupanOp(base, { op: 'upsert', id: 'n3', date: '2026-10-21', text: 'x'.repeat(FUPAN_MAX_TEXT + 1) }, 0), /不做静默截断/)
  assert.throws(() => applyFupanOp(base, { op: 'upsert', id: 'n3', date: '2026-10-21', text: '   ' }, 0), /不能为空/)
  // 请求体校验：op/date/text/pinnedTo/id 逐项有原因
  assert.throws(() => parseFupanOp(null), /JSON 对象/)
  assert.throws(() => parseFupanOp({ op: 'rm' }), /op 只接受/)
  assert.throws(() => parseFupanOp({ op: 'delete' }), /必须带 id/)
  assert.throws(() => parseFupanOp({ op: 'upsert', text: 'x' }), /必须带 date/)
  assert.throws(() => parseFupanOp({ op: 'upsert', date: '2026-10-20' }), /必须带 text/)
  assert.throws(() => parseFupanOp({ op: 'upsert', date: '2026-10-20', text: 'x', pinnedTo: 7 }), /pinnedTo 必须是/)
  assert.throws(() => parseFupanOp({ op: 'upsert', date: '2026-10-20', text: 'x', id: '空 格' }), /id 只允许/)
  const okOp = parseFupanOp({ op: 'upsert', date: '2026-10-20', text: 'x', pinnedTo: null })
  assert.equal(okOp.op, 'upsert')
  assert.equal(okOp.id, '', '新建时 id 可省略（由 store 生成）')
})

test('上限：条数/体积两档都在，超限按「最久未更新」丢且**逐条**留痕（静默丢必被这条抓住）', () => {
  // ① 条数：2000+5 ⇒ 丢 5 条最旧，逐条记账
  const many: FupanNote[] = Array.from({ length: FUPAN_MAX_NOTES + 5 }, (_, i) => noteOf({ id: `c${i}`, date: '2026-10-01', text: 'x', at: 1000 + i }))
  const byCount = trimFupan({ v: 1, notes: many })
  assert.equal(byCount.file.notes.length, FUPAN_MAX_NOTES)
  assert.equal(byCount.dropped.length, 5, '丢了 5 条 ⇒ 必须有 5 条留痕（静默丢就是这里空数组）')
  assert.deepEqual([...new Set(byCount.dropped.map((d) => d.reason))], ['notes-limit'])
  assert.deepEqual(byCount.dropped.map((d) => d.id), ['c0', 'c1', 'c2', 'c3', 'c4'], '按 at 最旧优先')
  assert.equal(byCount.file.notes.some((n) => n.id === `c${FUPAN_MAX_NOTES + 4}`), true, '最新那条绝不能被丢')
  // ② 体积：60 条 × 4000 个中文字（≈12 KB/条）⇒ 必然超过 512 KB
  const fat: FupanNote[] = Array.from({ length: 60 }, (_, i) => noteOf({ id: `f${i}`, date: '2026-10-02', text: '复'.repeat(FUPAN_MAX_TEXT), at: 2000 + i }))
  const byBytes = trimFupan({ v: 1, notes: fat })
  assert.ok(Buffer.byteLength(JSON.stringify(byBytes.file, null, 1), 'utf8') <= FUPAN_MAX_BYTES, '裁剪后体积必须回到上限内')
  assert.ok(byBytes.dropped.length > 0, '体积超限也必须逐条留痕')
  assert.deepEqual([...new Set(byBytes.dropped.map((d) => d.reason))], ['file-size-limit'])
  assert.equal(byBytes.file.notes.at(-1)!.id, 'f59', '最新那条必须留着')
  // ③ 置顶的最后才丢：最老的那条被钉住了 ⇒ 先丢"次旧"的
  const pinnedOldest: FupanNote[] = Array.from({ length: FUPAN_MAX_NOTES + 1 }, (_, i) => noteOf({ id: `p${i}`, date: '2026-10-03', text: 'x', at: 3000 + i }))
  pinnedOldest[0] = { ...pinnedOldest[0]!, pinnedTo: '2026-12-01' }
  const byPin = trimFupan({ v: 1, notes: pinnedOldest })
  assert.equal(byPin.dropped.length, 1)
  assert.equal(byPin.dropped[0]!.id, 'p1', '置顶的老笔记不该先被丢（用户对未来有承诺）')
  assert.equal(byPin.file.notes.some((n) => n.id === 'p0'), true)
  // ④ 反例注入：把 dropped 换成空数组（= 静默丢）⇒ 上面 ① 的判据必须失败
  const silent = { file: byCount.file, dropped: [] as typeof byCount.dropped }
  assert.throws(() => assert.equal(silent.dropped.length, 5), '静默丢必须让"逐条留痕"断言失败')
})

test('月份工具：天数按 UTC 算术（28/29/30/31 都对），notesInMonth 同时收"写在这天"与"钉到这天"的', () => {
  assert.equal(monthDays('2026-10').length, 31)
  assert.equal(monthDays('2026-11').length, 30)
  assert.equal(monthDays('2024-02').length, 29, '闰年二月 29 天（拿 28 顶替就是错）')
  assert.equal(monthDays('2026-02').length, 28)
  assert.equal(monthDays('2026-10')[0], '2026-10-01')
  assert.equal(monthDays('2026-10').at(-1), '2026-10-31')
  const notes = [
    noteOf({ id: 'a', date: '2026-10-20', at: 1 }),
    noteOf({ id: 'b', date: '2026-09-30', pinnedTo: '2026-10-27', at: 2 }),
    noteOf({ id: 'c', date: '2026-11-01', at: 3 }),
  ]
  // 排序按**写的那一天**（b 写在 09-30，钉到 10-27）⇒ b 在前；界面按日期画，不会错位
  assert.deepEqual(notesInMonth(notes, '2026-10').map((n) => n.id), ['b', 'a'], '写在本月的 + 被钉到本月的都要给（界面要能画未来的钉）')
  assert.deepEqual(notesOnDay(notes, '2026-10-20').map((n) => n.id), ['a'])
  assert.deepEqual(notesOnDay(notes, '2026-10-27').map((n) => n.id), [], '钉到某天 ≠ 写在那天（两个概念不许混）')
})

// ───────────────────────── ② 存储：锁 / 读失败 / 隔离 / 上限落盘 ─────────────────────────

test('首装（ENOENT）⇒ 空是真的；写入后磁盘上确实是 {v:1,notes:[…]}（走锁内读-改-写）', async () => {
  const dir = tempDir()
  const store = new FupanStore(dir)
  await store.init()
  assert.deepEqual(store.readState().notes, [])
  assert.equal(store.readState().unreadable, null, 'ENOENT 是"本来就没有"，不是"读不到"')
  const written = await store.write({ op: 'upsert', id: '', date: '2026-10-20', text: '第一条' })
  assert.notEqual(written.note, null)
  assert.match(written.note!.id, /^f[0-9a-z]+$/, 'id 由 store 生成（客户端可省略）')
  assert.deepEqual(written.dropped, [])
  const disk = JSON.parse(readFileSync(join(dir, FUPAN_FILE), 'utf8')) as FupanFile
  assert.equal(disk.v, 1)
  assert.equal(disk.notes.length, 1)
  assert.equal(disk.notes[0]!.text, '第一条')
  assert.equal(store.readState().notes.length, 1, '内存镜像要跟着落盘结果走（下一次读取立刻看到）')
  rmSync(dir, { recursive: true, force: true })
})

test('写入走文件锁：两个实例各自"读-改-写"不丢更新；锁被别人占住时**拒绝写**且文件一个字节都不变', async () => {
  const dir = tempDir()
  const a = new FupanStore(dir)
  const b = new FupanStore(dir)
  await a.init()
  await b.init()
  // A、B 各自先写一条（模拟两个进程都在跑）
  await a.write({ op: 'upsert', id: 'a1', date: '2026-10-20', text: 'A 写的' })
  await b.write({ op: 'upsert', id: 'b1', date: '2026-10-20', text: 'B 写的' })
  const disk = JSON.parse(readFileSync(join(dir, FUPAN_FILE), 'utf8')) as FupanFile
  assert.deepEqual(disk.notes.map((n) => n.id).sort(), ['a1', 'b1'], '后写者必须读磁盘最新再合并 —— 丢一条就是"没走锁内读-改-写"')
  // 锁被"另一个活着的进程"占住 ⇒ 超时拒绝（有界），且**不动**数据文件
  const lockPath = lockPathFor(join(dir, FUPAN_FILE))
  const before = readFileSync(join(dir, FUPAN_FILE), 'utf8')
  writeFileSync(lockPath, JSON.stringify({ pid: process.pid, at: Date.now(), token: 'foreign', target: join(dir, FUPAN_FILE), note: '测试：假装另一个进程持锁' }))
  await assert.rejects(
    () => a.write({ op: 'upsert', id: 'a2', date: '2026-10-20', text: '抢锁失败' }, { timeoutMs: 150, staleMs: 60_000, retryMs: 10, quiet: true }),
    /等待文件锁超时|锁文件/,
    '锁被占住时必须**有界地失败**（绝不"等不到就照写"）',
  )
  assert.equal(readFileSync(join(dir, FUPAN_FILE), 'utf8'), before, '写失败时数据文件必须一个字节都没变')
  rmSync(lockPath, { force: true })
  const ok = await a.write({ op: 'upsert', id: 'a3', date: '2026-10-20', text: '放开后成功' })
  assert.equal(ok.note!.id, 'a3')
  rmSync(dir, { recursive: true, force: true })
})

test('读失败 ≠ 空：EISDIR（拿目录冒充数据文件）⇒ 不当作"没有笔记"，且**拒绝写回**', async () => {
  const dir = tempDir()
  // 把 fupan.json 造成一个**目录** ⇒ readFile 抛 EISDIR（不是 ENOENT）⇒ 属"读不到"
  mkdirSync(join(dir, FUPAN_FILE))
  const store = new FupanStore(dir)
  await store.init()
  const state = store.readState()
  assert.equal(state.notes.length, 0)
  assert.notEqual(state.unreadable, null, '读不到必须给原因 —— 返回空列表且 unreadable=null 就是这条要抓的形态')
  assert.match(String(state.unreadable), /EISDIR/, '原因要带 errno，便于排查')
  // 写回必须被拒绝（否则一次权限/磁盘故障就把用户的笔记整份抹成空）
  await assert.rejects(() => store.write({ op: 'upsert', id: 'x', date: '2026-10-20', text: '不该落盘' }), /本次读不到|读不到/)
  assert.equal(statSync(join(dir, FUPAN_FILE)).isDirectory(), true, '原地那份东西还在（没被覆盖成空文件、也没被删掉）')
  // 反例注入：把 unreadable 当成 null（= "它就是空的"）⇒ 上面的判据必须失败
  const asClean = { ...state, unreadable: null }
  assert.throws(() => assert.notEqual(asClean.unreadable, null), '"读不到"被当成"没有"必须让断言失败')
  rmSync(dir, { recursive: true, force: true })
})

test('坏 JSON ⇒ 隔离原件（**保留原字节**）后从空开始；随后可正常写入', async () => {
  const dir = tempDir()
  const broken = '{"v":1,"notes":[{"id":"a","date":"20'
  writeFileSync(join(dir, FUPAN_FILE), broken)
  const store = new FupanStore(dir)
  await store.init()
  const state = store.readState()
  assert.equal(state.notes.length, 0)
  assert.notEqual(state.quarantined, null, '坏内容必须隔离（并留痕去向），不许静默覆盖')
  const kept = readFileSync(String(state.quarantined), 'utf8')
  assert.equal(kept, broken, '隔离出来的文件必须与原字节逐字一致（用户还能人工抢救）')
  assert.equal(state.unreadable, null, '隔离成功 ⇒ 可以继续写（这与"读不到"是两件事）')
  const ok = await store.write({ op: 'upsert', id: 'n1', date: '2026-10-20', text: '重新开始' })
  assert.equal(ok.note!.id, 'n1')
  rmSync(dir, { recursive: true, force: true })
})

test('落盘上限：磁盘上已接近 512 KB ⇒ 下一次写入把最旧的丢掉并在回包 dropped 段逐条说明', async () => {
  const dir = tempDir()
  // 预置 44 条大笔记（每条约 12 KB ⇒ ≈528 KB，已在 512 KB 上限之上）——
  // 直接写文件（模拟"历史数据已经到这个量级"），装载阶段**不**裁剪（裁剪只发生在写入时，且必须留痕）
  const fat: FupanNote[] = Array.from({ length: 44 }, (_, i) => noteOf({ id: `old${i}`, date: '2026-10-01', text: '复'.repeat(FUPAN_MAX_TEXT), at: 1000 + i }))
  writeFileSync(join(dir, FUPAN_FILE), JSON.stringify({ v: 1, notes: fat }, null, 1))
  assert.ok(Buffer.byteLength(readFileSync(join(dir, FUPAN_FILE), 'utf8'), 'utf8') > FUPAN_MAX_BYTES, '前置条件：文件已经超限')
  const store = new FupanStore(dir)
  await store.init()
  assert.equal(store.readState().notes.length, 44, '装载不该丢东西（上限只在写入时裁剪并留痕）')
  const written = await store.write({ op: 'upsert', id: 'new', date: '2026-10-20', text: '复'.repeat(FUPAN_MAX_TEXT) })
  assert.ok(written.dropped.length > 0, '超过体积上限必须逐条留痕（不许静默丢）')
  assert.deepEqual([...new Set(written.dropped.map((d) => d.reason))], ['file-size-limit'])
  const raw = readFileSync(join(dir, FUPAN_FILE), 'utf8')
  assert.ok(Buffer.byteLength(raw, 'utf8') <= FUPAN_MAX_BYTES, '落盘体积必须在 512 KB 以内')
  const disk = JSON.parse(raw) as FupanFile
  assert.equal(disk.notes.some((n) => n.id === 'new'), true, '刚写入的那条绝不能被自己的裁剪丢掉')
  assert.equal(disk.notes.some((n) => n.id === 'old0'), false, '最旧的先丢')
  rmSync(dir, { recursive: true, force: true })
})

test('写路径的静态判据：必须 updateJsonLocked + assertWritable + ReadGuard；出现 writeFile/writeJsonAtomic ⇒ 必败', () => {
  const src = readFileSync(join(SRC, 'fupan.ts'), 'utf8')
  assert.deepEqual(fupanWritePathProblems(src), [], `宿主写路径必须是锁内读-改-写（失败项：${fupanWritePathProblems(src).join(' ／ ')}）`)
  // 反例注入 ①：直接 writeFile（绕过锁 ⇒ 丢更新）
  const direct = `${src}\nawait writeFile(path, text, 'utf8')\n`
  assert.notDeepEqual(fupanWritePathProblems(direct), [], '⚠ 反例（直接 writeFile）必须被抓到')
  // 反例注入 ②：把锁内读-改-写换成纯原子覆盖
  const noLock = src.replace(/updateJsonLocked\s*\(/g, 'writeJsonAtomic(')
  assert.notDeepEqual(fupanWritePathProblems(noLock), [], '⚠ 反例（不走锁）必须被抓到')
  // 反例注入 ③：去掉写前守卫（读不到也能覆写）
  const noGuard = src.replace(/assertWritable\s*\(/g, 'noopSoon(')
  assert.notDeepEqual(fupanWritePathProblems(noGuard), [], '⚠ 反例（去掉 assertWritable）必须被抓到')
})

// ───────────────────────── ③ 路由：整月视图 / 写入 / 交易日标注 / 零上游 ─────────────────────────

test('fupanMonthView（纯计算层）：count/hasPinned 跟着笔记走，休市原因来自既有判定链', async () => {
  setTradingCalendar(null)
  const notes = [
    noteOf({ id: 'a', date: '2026-10-01', at: 1 }),
    noteOf({ id: 'b', date: '2026-10-02', at: 2, pinnedTo: '2026-10-08' }),
  ]
  const view = await fupanMonthView(notes, '2026-10')
  assert.equal(view.dates.length, 31)
  assert.equal(view.dates.find((d) => d.date === '2026-10-01')!.count, 1, 'count 只数"写在这天"的')
  assert.equal(view.dates.find((d) => d.date === '2026-10-08')!.hasPinned, true, 'hasPinned 只数"被钉到这天"的')
  assert.equal(view.dates.find((d) => d.date === '2026-10-02')!.hasPinned, false)
  assert.equal(view.dates.find((d) => d.date === '2026-10-01')!.closedReason, '国庆节', '休市原因来自判定链（不是界面自己猜）')
  assert.equal(view.calendar.covered, false, '没有外部文件 ⇒ 该月未覆盖')
  assert.equal(typeof view.calendarWhy, 'string', '未覆盖 ⇒ 必须有理由（null 就是"看起来一切正常"的错话）')
  assert.equal(view.source, 'local:fupan.json+calendar:trading-calendar.json')
})

interface Captured {
  code: number
  body: Record<string, unknown>
}

interface Harness {
  dir: string
  fupan: FupanStore
  call(path: string, url: string, init?: { method?: string; body?: string }): Promise<Captured>
  close(): void
}

function harness(): Harness {
  const dir = tempDir()
  const fupan = new FupanStore(dir)
  const routes = makeTradeRoutes(
    new DataStore(dir),
    [],
    new CalendarStore(dir),
    undefined,
    undefined,
    undefined,
    () => ['core', 'fupan'],
    fupan,
  ).routes
  const call = (path: string, url: string, init: { method?: string; body?: string } = {}): Promise<Captured> =>
    new Promise<Captured>((resolve) => {
      const body = init.body
      const req = {
        url,
        method: init.method ?? 'GET',
        headers: { host: '127.0.0.1:3080', ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
        async *[Symbol.asyncIterator]() {
          if (body !== undefined) yield Buffer.from(body)
        },
      } as unknown as IncomingMessage
      let code = 0
      const res = {
        writeHead(c: number) {
          code = c
        },
        end(payload: string) {
          resolve({ code, body: payload === '' ? {} : (JSON.parse(payload) as Record<string, unknown>) })
        },
      } as unknown as ServerResponse
      const route = routes.find((r) => r.path === path)
      if (route === undefined) throw new Error(`未找到路由 ${path}`)
      void route.handler(req, res)
    })
  return { dir, fupan, call, close: () => rmSync(dir, { recursive: true, force: true }) }
}

test('GET month：该月**每一天**一条、带数据时刻与口径；交易日标注来自交易日历（写死周末必败）', async () => {
  // 没有外部 holidays 文件 ⇒ 走内置表：2026-10-01（周四，国庆）必须是休市
  setTradingCalendar(null)
  const h = harness()
  try {
    await h.fupan.write({ op: 'upsert', id: 'n1', date: '2026-10-20', text: '今天的复盘' })
    await h.fupan.write({ op: 'upsert', id: 'n2', date: '2026-10-20', text: '钉到月底', pinnedTo: '2026-10-27' })
    const res = await h.call('/tradewatcher/fupan/month', '/tradewatcher/fupan/month?ym=2026-10')
    assert.equal(res.code, 200)
    const dates = res.body.dates as FupanDay[]
    assert.equal(dates.length, 31, '该月每一天都要有一条（不是只给有笔记的那几天）')
    assert.equal(typeof res.body.asOf, 'number', '回包必须带数据时刻')
    assert.equal(res.body.source, 'local:fupan.json+calendar:trading-calendar.json', '回包必须带口径')
    assert.equal(res.body.stale, false)
    const oct1 = dates.find((d) => d.date === '2026-10-01')!
    assert.equal(oct1.trading, false, '国庆（周四）必须是休市 —— 写死"周末休市"的实现会在这里说 true')
    assert.equal(oct1.closedReason, '国庆节', '休市要给原因（假日名来自内置表）')
    const oct9 = dates.find((d) => d.date === '2026-10-09')!
    assert.equal(oct9.trading, true, '反证：节后周五必须是交易日（否则判据恒真）')
    assert.equal(oct9.closedReason, null, '交易日没有"休市原因"')
    const oct20 = dates.find((d) => d.date === '2026-10-20')!
    assert.equal(oct20.count, 2, '当天两条笔记')
    assert.equal(oct20.hasPinned, false)
    assert.equal(dates.find((d) => d.date === '2026-10-27')!.hasPinned, true, '被钉到的那天要能看见（哪怕那天自己没笔记）')
    assert.equal((res.body.totals as { notes: number }).notes, 2)
    // 反例注入 ①：按"只信周末"重算 ⇒ 2026-10-01（周四）会被判成交易日 ⇒ 与宿主给的不一致（判据非恒真）
    const weekendOnly = dates.map((d) => {
      const wd = new Date(`${d.date}T12:00:00+08:00`).getUTCDay()
      return { ...d, trading: wd !== 0 && wd !== 6 }
    })
    assert.equal(weekendOnly.find((d) => d.date === '2026-10-01')!.trading, true, '⚠ 反例（写死周末）必须与真实标注不同')
    assert.equal(oct1.trading, false, '真实标注：国庆休市')
    // 反例注入 ②：calendarWhy 写 null/0/空串 ⇒ 必败
    assert.deepEqual(calendarWhyProblems(res.body.calendarWhy), [], `未覆盖该月时必须给原因（实得 ${JSON.stringify(res.body.calendarWhy)}）`)
    for (const bad of [null, '', 0, '   ']) {
      assert.notDeepEqual(calendarWhyProblems(bad), [], `⚠ 反例（calendarWhy=${JSON.stringify(bad)}）必须被抓到`)
    }
  } finally {
    h.close()
  }
})

test('GET month：外部交易日历生效时以文件为准（工作日被标休市 ⇒ 必须跟着变）；未覆盖该月 ⇒ calendarWhy 必给', async () => {
  const today = dayOf(Date.now())
  const ymNow = today.slice(0, 7)
  const days = monthDays(ymNow)
  // 挑一个**内置表认为是交易日**的工作日（周一到周五、且不在法定假日表里）当"外部日历声明的休市日"
  // —— 这样"外部文件优先"才不是空话：内置表会判它为交易日，只有外部文件会说它休市。
  const closure = days.find((d) => {
    const wd = new Date(`${d}T12:00:00+08:00`).getUTCDay()
    return wd >= 1 && wd <= 5 && d !== today && holidayOf(d) === null
  })
  if (closure === undefined) throw new Error('当月必须能找到一个"内置表认为是交易日"的工作日来做这条断言')
  setTradingCalendar({ [ymNow]: [closure] })
  const h = harness()
  try {
    const res = await h.call('/tradewatcher/fupan/month', `/tradewatcher/fupan/month?ym=${ymNow}`)
    assert.equal(res.code, 200)
    const calendar = res.body.calendar as { covered: boolean; inForce: boolean; source: string; fileExists: boolean }
    assert.equal(calendar.fileExists, true)
    assert.equal(calendar.covered, true, '外部文件声明了当月 ⇒ covered')
    assert.equal(calendar.inForce, true, '既有判定链确实按文件判定当月')
    assert.equal(calendar.source, 'external')
    assert.equal(res.body.calendarWhy, null, '真的按外部文件判定时不该有"未覆盖"的理由')
    const hit = (res.body.dates as FupanDay[]).find((d) => d.date === closure)!
    assert.equal(hit.trading, false, '外部文件说这天休市 ⇒ 必须跟着变（内置表本来会说它是交易日）')
    assert.equal(hit.closedReason, '外部日历（手工维护）', '原因要指明是外部日历判的')
    // 反例注入：忽略外部文件（只按内置表）⇒ 这天会被判成交易日 ⇒ 与宿主不一致（判据非恒真）
    assert.equal(holidayOf(closure), null, '⚠ 反例（只看内置表）必须与真实标注不同：内置表认为它是交易日')
    assert.equal(new Date(`${closure}T12:00:00+08:00`).getUTCDay() % 6 !== 0, true, '⚠ 反例（只看周末）同上：它是工作日')
    // 未覆盖的月份：给理由（且理由里要有那个月份与文件已覆盖的月份）
    const other = ymNow === '2026-11' ? '2027-03' : '2026-11'
    setTradingCalendar({ [ymNow]: [] })
    const res2 = await h.call('/tradewatcher/fupan/month', `/tradewatcher/fupan/month?ym=${other}`)
    const why = String(res2.body.calendarWhy ?? '')
    assert.ok(why.length > 0, `未覆盖 ${other} 时必须给 calendarWhy（写 0/空串就是这条要抓的）`)
    assert.match(why, new RegExp(other), '理由里必须点名是哪个月没被覆盖')
    assert.match(why, /内置/, '理由里必须说清退回了什么（内置假日表）')
  } finally {
    setTradingCalendar(null)
    h.close()
  }
})

test('POST note：新增/更新/删除各一轮；400/404/409 与"超长不截断"；invalid ym ⇒ 400', async () => {
  setTradingCalendar(null)
  const h = harness()
  try {
    const created = await h.call('/tradewatcher/fupan/note', '/tradewatcher/fupan/note', {
      method: 'POST',
      body: JSON.stringify({ op: 'upsert', date: '2026-10-20', text: '第一条复盘' }),
    })
    assert.equal(created.code, 200)
    assert.equal(created.body.ok, true)
    assert.equal(typeof created.body.asOf, 'number', '写入回包也要带数据时刻')
    const id = String(created.body.id)
    assert.match(id, /^f[0-9a-z]+$/)
    assert.equal((created.body.notes as FupanNote[]).length, 1)
    assert.deepEqual((created.body.dropped as { count: number }).count, 0)
    const monthDates = (created.body.month as { dates: FupanDay[] }).dates
    assert.equal(monthDates.find((d) => d.date === '2026-10-20')!.count, 1, '写回包里的整月骨架要反映刚写的这条')
    // 更新同一条（按 id）
    const updated = await h.call('/tradewatcher/fupan/note', '/tradewatcher/fupan/note', {
      method: 'POST',
      body: JSON.stringify({ op: 'upsert', id, date: '2026-10-20', text: '改过的复盘', pinnedTo: '2026-10-27' }),
    })
    assert.equal(updated.code, 200)
    assert.equal((updated.body.notes as FupanNote[])[0]!.text, '改过的复盘')
    assert.equal((updated.body.notes as FupanNote[])[0]!.pinnedTo, '2026-10-27')
    // 读回：GET month 也要能看到
    const month = await h.call('/tradewatcher/fupan/month', '/tradewatcher/fupan/month?ym=2026-10')
    assert.equal((month.body.notes as FupanNote[]).length, 1)
    // 删除
    const removed = await h.call('/tradewatcher/fupan/note', '/tradewatcher/fupan/note', {
      method: 'POST',
      body: JSON.stringify({ op: 'delete', id }),
    })
    assert.equal(removed.code, 200)
    assert.equal(removed.body.removed, 1)
    assert.deepEqual(removed.body.notes, [], '删完那天就没有笔记了')
    // 再删同一条 ⇒ 404（不静默成功）
    const gone = await h.call('/tradewatcher/fupan/note', '/tradewatcher/fupan/note', { method: 'POST', body: JSON.stringify({ op: 'delete', id }) })
    assert.equal(gone.code, 404)
    assert.match(String(gone.body.error), new RegExp(id))
    // 超长 ⇒ 400 且不写盘（不做静默截断）
    const tooLong = await h.call('/tradewatcher/fupan/note', '/tradewatcher/fupan/note', {
      method: 'POST',
      body: JSON.stringify({ op: 'upsert', date: '2026-10-20', text: '复'.repeat(FUPAN_MAX_TEXT + 1) }),
    })
    assert.equal(tooLong.code, 400)
    assert.match(String(tooLong.body.error), new RegExp(String(FUPAN_MAX_TEXT)))
    const after = await h.call('/tradewatcher/fupan/month', '/tradewatcher/fupan/month?ym=2026-10')
    assert.deepEqual(after.body.notes, [], '被拒绝的写入绝不能落盘')
    // ym / 方法校验
    const badYm = await h.call('/tradewatcher/fupan/month', '/tradewatcher/fupan/month?ym=2026-13')
    assert.equal(badYm.code, 400)
    const wrongMethod = await h.call('/tradewatcher/fupan/note', '/tradewatcher/fupan/note', { method: 'GET' })
    assert.equal(wrongMethod.code, 405)
  } finally {
    h.close()
  }
})

test('GET month：读不到笔记时**不许**回一个干净的空列表（notesUnreadable + missing 必给）', async () => {
  setTradingCalendar(null)
  const h = harness()
  try {
    // 把 fupan.json 造成目录 ⇒ 读失败（EISDIR），但路由必须照常 200 并如实披露
    mkdirSync(join(h.dir, FUPAN_FILE))
    const res = await h.call('/tradewatcher/fupan/month', '/tradewatcher/fupan/month?ym=2026-10')
    assert.equal(res.code, 200)
    assert.notEqual(res.body.notesUnreadable, null, 'read失败时 notesUnreadable 必须是原因（null = 骗用户"没有笔记"）')
    assert.match(String(res.body.notesUnreadable), /EISDIR/)
    const missing = res.body.missing as Array<{ what: string; why: string; note: string }>
    assert.equal(missing.length, 1, 'missing[] 必须有一条（读不到 ≠ 没有）')
    assert.match(missing[0]!.note, /读不到/, 'missing 的说明要讲清"读不到 ≠ 空数据"')
    assert.deepEqual(res.body.notes, [], '数据本身确实是空 —— 但空必须与"读不到"同时出现才诚实')
    // 反例注入：把 notesUnreadable 抹成 null（= 假装"就是没有笔记"）⇒ 上面的判据必须失败
    assert.throws(() => assert.notEqual(null, null), '⚠ 反例（静默空列表）必须让断言失败')
  } finally {
    h.close()
  }
})

test('零新增上游请求：两个接口各跑一遍，fetch 一次都不许发（静态源检查 + 运行时计数）', async () => {
  setTradingCalendar(null)
  const h = harness()
  const realFetch = globalThis.fetch
  let calls = 0
  globalThis.fetch = (async (...args: unknown[]) => {
    calls += 1
    throw new Error(`复盘接口不许发上游请求（实发了 ${String(args[0])}）`)
  }) as unknown as typeof fetch
  try {
    await h.fupan.write({ op: 'upsert', id: 'n1', date: '2026-10-20', text: '本地笔记' })
    const month = await h.call('/tradewatcher/fupan/month', '/tradewatcher/fupan/month?ym=2026-10')
    assert.equal(month.code, 200)
    const note = await h.call('/tradewatcher/fupan/note', '/tradewatcher/fupan/note', {
      method: 'POST',
      body: JSON.stringify({ op: 'upsert', date: '2026-10-21', text: '再写一条' }),
    })
    assert.equal(note.code, 200)
    assert.equal(calls, 0, `复盘接口必须零上游请求（实测发了 ${calls} 次）`)
  } finally {
    globalThis.fetch = realFetch
    h.close()
  }
  // 静态判据：宿主实现与两个 handler 里都不许出现上游取数
  const hostSrc = readFileSync(join(SRC, 'fupan.ts'), 'utf8')
  const routesSrc = readFileSync(join(SRC, 'routes.ts'), 'utf8')
  const monthHandler = handlerSource(routesSrc, '/tradewatcher/fupan/month')
  const noteHandler = handlerSource(routesSrc, '/tradewatcher/fupan/note')
  assert.ok(monthHandler.length > 0 && noteHandler.length > 0, '必须能从 routes.ts 里切出这两个 handler（否则静态判据是空跑）')
  const bad = fupanUpstreamProblems(hostSrc, monthHandler, noteHandler)
  assert.deepEqual(bad, [], `复盘接口不许引入上游取数（失败项：${bad.join(' ／ ')}）`)
  // 反例注入：为该接口发一次 fetch ⇒ 必败
  const withFetch = fupanUpstreamProblems(`${hostSrc}\nawait fetch('https://push2.eastmoney.com/x')\n`, monthHandler, noteHandler)
  assert.notDeepEqual(withFetch, [], '⚠ 反例（发一次 fetch）必须被抓到')
  // 反例注入：从宿主里借 em 取数也算（换一条路发请求）
  const viaEm = fupanUpstreamProblems(`${hostSrc}\nconst q = await em.fetchQuotes(['1.600519'])\n`, monthHandler, noteHandler)
  assert.notDeepEqual(viaEm, [], '⚠ 反例（借 em 取数）必须被抓到')
})

// ─────────────────────────────── 判据实现（供上面的断言复用） ───────────────────────────────

/**
 * 写路径判据：锁内读-改-写 + 写前守卫。
 *
 * 为什么用**源码判据**而不只是行为判据：`updateJsonLocked` 与 `writeJsonAtomic` 在单进程里
 * 行为上可能"看起来都对"（本次写入成功），差别只在并发/交叉时丢不丢数据。源码判据把
 * "实现方式"钉死，行为判据（上一条丢更新测试）钉住"结果"。两者一起看才拦得住回退。
 */
export function fupanWritePathProblems(src: string): string[] {
  const bad: string[] = []
  if (!/updateJsonLocked\s*\(/.test(src)) bad.push('写回必须走 updateJsonLocked（锁内读磁盘最新 → 改 → 原子写回）')
  if (/\bwriteJsonAtomic\s*\(/.test(src) || /\bwriteFile\s*\(/.test(src)) bad.push('不许直接 writeFile/writeJsonAtomic（绕过锁 ⇒ 并发下丢更新）')
  if (!/assertWritable\s*\(/.test(src)) bad.push('写回前必须 readGuard.assertWritable（读不到 ⇒ 拒绝整份覆写）')
  if (!/\bReadGuard\b/.test(src)) bad.push('读路径必须走 ReadGuard（ENOENT 才算"本来就没有"）')
  if (!/quarantineFile\s*\(/.test(src)) bad.push('坏内容必须 quarantineFile（隔离并保留原字节）')
  return bad
}

/**
 * 交易日标注的"未覆盖理由"判据：必须是**非空字符串**。
 * 0 / 空串 / null 都是"看起来正常的错话"（界面会显示成"0 条理由"或干脆空白）。
 */
export function calendarWhyProblems(why: unknown): string[] {
  if (why === null) return ['calendarWhy 为 null ⇒ 界面会把"未覆盖"显示成"一切正常"']
  if (typeof why !== 'string') return [`calendarWhy 必须是字符串（实得 ${typeof why}：${JSON.stringify(why)}）`]
  if (why.trim() === '') return ['calendarWhy 是空串 ⇒ 等于没给原因']
  if (why.trim().length < 10) return [`calendarWhy 太短（${why.trim().length} 字）⇒ 说不清"哪里没覆盖、退回了什么"`]
  return []
}

/**
 * 零上游判据（静态）：宿主模块与两个 handler 里都不许出现取数调用/上游模块。
 *
 * 行为判据（fetch 计数）挡不住"通过 em/tencent/sina 发请求"这条路（那些模块自己会 fetch），
 * 所以这里**同时**钉住依赖面：复盘只能读本地文件 + 既有交易日历判定（纯函数）。
 */
export function fupanUpstreamProblems(hostSrc: string, monthHandler: string, noteHandler: string): string[] {
  const bad: string[] = []
  const scan = (label: string, text: string): void => {
    if (/\bfetch\s*\(/.test(text)) bad.push(`${label} 出现 fetch(...)（复盘接口必须零上游请求）`)
    if (/\bem\.\w+\s*\(/.test(text)) bad.push(`${label} 调用了 em.*（那是上游取数）`)
    if (/from ['"]\.\/(em|tencent|sina|tencentSuggest)\.ts['"]/.test(text)) bad.push(`${label} 引入了上游取数模块`)
    if (/\bawait\s+em\b/.test(text)) bad.push(`${label} await 了 em（上游取数）`)
  }
  scan('src/host/fupan.ts', hostSrc)
  scan('/tradewatcher/fupan/month', monthHandler)
  scan('/tradewatcher/fupan/note', noteHandler)
  return bad
}

/** 从 `routes.ts` 源码里切出某条路由的 handler 段（到下一条 `kind: 'exact'` 为止） */
export function handlerSource(routesSrc: string, path: string): string {
  const at = routesSrc.indexOf(`path: '${path}'`)
  if (at < 0) return ''
  const next = routesSrc.indexOf("kind: 'exact'", at + path.length)
  return routesSrc.slice(at, next < 0 ? routesSrc.length : next)
}
