/**
 * rescue-log 按日分片（`docs/AUDIT-HOST-PERF.md` P1-5）的回归断言。
 *
 * 背景：旧实现把 60 天全量单文件（实测 7.67 MB）每分钟整份 parse(73ms)+stringify(53ms)
 * 再写回，交易时段 ~300 次/日 ⇒ ≈2 GB 写盘/日 + ≈33 s CPU/日，而其中**绝大多数历史日一个字节都没变**。
 *
 * 本文件锁住 5 条验收面，每条都带**反例注入**（把实现换回旧行为 ⇒ 判据必须变红）：
 *  ① 写当天分片，其它分片 mtime 一个都不变（反例：整份重写 ⇒ 全部变化）；
 *  ② 旧单文件迁移：每日条目数之和 = 原文件条数，旧文件改名保留且逐字节不变；
 *  ③ 保留 30 天：窗口外的分片被清理并留痕「已清理 N 天」（反例：keepDays=60 ⇒ 一个都不删）；
 *  ④ 读某一天只 open 一个文件（注入 fs 计数；当天走内存 0 open）；
 *  ⑤ 空/损坏分片 ⇒ 没有数据 + 原因，不影响其它天（反例：坏分片让读取抛错或清空别的天）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { RescueMonitor } from './rescue.ts'
import { RescueLogStore, countDayEntries, nodeRescueLogIo, rescueLogKeepDays, rescueLogReadDays, shiftDay, type DayShard, type RescueLogIo } from './rescueLog.ts'

/** 北京 2026-11-23（周一）14:30 —— 钉住时钟，避免跨自然日跑测试时"今天"漂移 */
const NOW = Date.parse('2026-11-23T14:30:00+08:00')
const TODAY = '2026-11-23'
const CONFIG = { enabled: false, intervalSec: 30, tailIntervalSec: 15, tailFrom: '14:30', universe: [] as string[] }

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'tw-rescue-shard-'))
  mkdirSync(dir, { recursive: true })
  return dir
}

/** 一天的日志 fixture（events/intraday/scoreLog 的条数可控 ⇒ 条目守恒可断言） */
function fixtureDay(day: string, opts: { events?: number; intraday?: number; scoreLog?: number; samples?: number } = {}): Record<string, unknown> {
  const base = Date.parse(`${day}T10:00:00+08:00`)
  const events = Array.from({ length: opts.events ?? 2 }, (_, i) => ({
    ts: base + i * 60_000, hhmm: `10:0${i}`, level: 2, score: 60 + i, reason: `（fixture ${day} #${i}）`, engine: 'fixture',
  }))
  const intraday = Array.from({ length: opts.intraday ?? 3 }, (_, i) => ({
    hhmm: `10:${String(i * 5).padStart(2, '0')}`, level: 1, score: 40 + i, timeAdjMult: 1.2, superVsAvg: 0.3,
  }))
  const scoreLog = Array.from({ length: opts.scoreLog ?? 1 }, (_, i) => ({
    ts: base + i * 60_000, hhmm: `10:0${i}`, score: 60, rawScore: 55, timeCoef: 1, continuous: 50 + i,
    inSession: true, engine: 'fixture', factors: [],
  }))
  return { events, intraday, samples: opts.samples ?? 5, gap: false, scoreLog }
}

function writeShard(dir: string, day: string, log: unknown): string {
  const shardDir = join(dir, 'rescue-log')
  mkdirSync(shardDir, { recursive: true })
  const path = join(shardDir, `${day}.json`)
  writeFileSync(path, JSON.stringify({ v: 1, day, log, updatedAt: Date.parse(`${day}T15:00:00+08:00`) } satisfies DayShard<unknown>, null, 1), 'utf8')
  return path
}

function writeLegacy(dir: string, payload: Record<string, unknown>): string {
  mkdirSync(dir, { recursive: true })
  const path = join(dir, 'rescue-log.json')
  writeFileSync(path, JSON.stringify(payload, null, 1), 'utf8')
  return path
}

/** 分片目录里每个日分片的 mtime（ns 精度；"整份重写"会让它们全部变化） */
function shardMtimes(dir: string): Record<string, string> {
  const shardDir = join(dir, 'rescue-log')
  const out: Record<string, string> = {}
  for (const f of readdirSync(shardDir)) {
    if (!/^\d{4}-\d{2}-\d{2}\.json$/.test(f)) continue
    out[f] = statSync(join(shardDir, f), { bigint: true }).mtimeNs.toString()
  }
  return out
}

/** 可推进的假时钟（换日用例要跨到第二天） */
function useClock(start: number): { set(ts: number): void; restore(): void } {
  const real = Date.now
  let now = start
  Date.now = () => now
  return { set(ts) { now = ts }, restore() { Date.now = real } }
}

/** 读路径计数替身：记录每一次 `readText`（= 一次 open） */
function countingIo(): { io: RescueLogIo; opens: string[] } {
  const opens: string[] = []
  return {
    opens,
    io: {
      async readText(path) { opens.push(path); return await nodeRescueLogIo.readText(path) },
      async listDir(path) { return await nodeRescueLogIo.listDir(path) },
      async exists(path) { return await nodeRescueLogIo.exists(path) },
    },
  }
}

test('① 写当天分片：其它分片 mtime 一个都不变（反例注入：整份重写 ⇒ 全变 ⇒ 必败）', async () => {
  const dir = tempDir()
  const clock = useClock(NOW)
  try {
    for (const d of [shiftDay(TODAY, -1), shiftDay(TODAY, -2), shiftDay(TODAY, -3)]) writeShard(dir, d, fixtureDay(d))
    const mon = new RescueMonitor(dir, CONFIG)
    await mon.init()
    const before = shardMtimes(dir)
    await mon.flush()
    const after = shardMtimes(dir)
    assert.ok(`${TODAY}.json` in after, '必须写出当天分片')
    for (const [file, mtime] of Object.entries(before)) {
      assert.equal(after[file], mtime, `历史分片 ${file} 的 mtime 不得变化（只写当天）`)
    }
    // 反例注入：模拟旧行为「整份重写所有分片」—— 同样三条断言必须变红
    for (const file of Object.keys(before)) {
      writeFileSync(join(dir, 'rescue-log', file), readFileSync(join(dir, 'rescue-log', file), 'utf8'))
    }
    const rewritten = shardMtimes(dir)
    const rewrittenHist = Object.fromEntries(Object.keys(before).map((f) => [f, rewritten[f]]))
    assert.notDeepEqual(rewrittenHist, before, '⚠ 注入：整份重写必须让"其它分片 mtime 不变"失败（证明该判据不是恒真）')
  } finally {
    clock.restore()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('② 旧单文件迁移：每日条目数之和 = 原文件条数；旧文件改名保留且逐字节一致', async () => {
  const dir = tempDir()
  const clock = useClock(NOW)
  try {
    const days: Record<string, Record<string, unknown>> = {
      '2026-11-17': fixtureDay('2026-11-17', { events: 2, intraday: 4, scoreLog: 3 }),
      '2026-11-18': fixtureDay('2026-11-18', { events: 0, intraday: 1, scoreLog: 0 }),
      '2026-11-19': fixtureDay('2026-11-19', { events: 5, intraday: 0, scoreLog: 2 }),
    }
    const payload = {
      v: 1,
      days,
      lastSnapshot: { ts: 1, level: 0, score: 0, summary: '（fixture）' },
      baselines: { '1.510300': { avgAmt20: 1e9, day: '2026-11-01', source: 'em' } },
      selfSamples: { '1.510300': [{ day: '2026-11-18', superVsAvg: 0.2 }] },
      progressCurve: null,
      progressDays: 3,
      updatedAt: 1,
    }
    const legacy = writeLegacy(dir, payload)
    const beforeBytes = readFileSync(legacy, 'utf8')
    const expected = Object.values(days).reduce((sum, d) => sum + countDayEntries(d), 0)
    const mon = new RescueMonitor(dir, CONFIG)
    await mon.init()

    let sum = 0
    for (const [day, dayLog] of Object.entries(days)) {
      const shard = JSON.parse(readFileSync(join(dir, 'rescue-log', `${day}.json`), 'utf8')) as DayShard<unknown>
      assert.equal(shard.day, day, `分片自述日期必须是 ${day}`)
      assert.deepEqual(shard.log, dayLog, `${day} 的 log 必须原样搬过去（迁移只搬不改）`)
      sum += countDayEntries(shard.log)
    }
    assert.equal(sum, expected, `拆分后每日条目数之和必须 = 原文件条数（${expected}）`)
    assert.equal(existsSync(legacy), false, '旧单文件不得留在原路径（会诱导下一个版本继续整份读）')
    const renamed = readdirSync(dir).find((f) => f.startsWith('rescue-log.json.migrated-'))
    assert.ok(renamed !== undefined, '旧文件必须改名保留（rescue-log.json.migrated-<ts>）')
    assert.equal(readFileSync(join(dir, renamed), 'utf8'), beforeBytes, '改名后的旧文件必须与原文逐字节一致（不删不改）')

    const status = mon.logStatus()
    assert.equal(status.lastMigration?.days, 3, '迁移报告：拆出 3 个日分片')
    assert.equal(status.lastMigration?.entries, expected, '迁移报告：条目总数守恒')
    assert.ok((status.lastMigration?.ms ?? -1) >= 0, '迁移必须记录耗时（ms）')
    assert.equal(status.legacyPresent, false, '迁移后旧文件不再"存在"')
  } finally {
    clock.restore()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('③ 保留 30 天：窗口外的分片被清理且状态留痕（反例：keepDays=60 ⇒ 一个都不删）', async () => {
  const dir = tempDir()
  const clock = useClock(NOW)
  const boundaries = [shiftDay(TODAY, -29), shiftDay(TODAY, -30), shiftDay(TODAY, -31)]
  try {
    for (const d of [...boundaries, TODAY]) writeShard(dir, d, fixtureDay(d))
    const mon = new RescueMonitor(dir, CONFIG, { keepDays: 30 })
    await mon.init()
    await mon.flush() // 落一次盘 ⇒ meta.json 存在，顺带证明裁剪不会误删 meta
    assert.equal(existsSync(join(dir, 'rescue-log', `${boundaries[0]}.json`)), true, '第 30 天（今天−29）在保留窗口内，不得删')
    assert.equal(existsSync(join(dir, 'rescue-log', `${boundaries[1]}.json`)), false, '今天−30 已超出 30 天窗口 ⇒ 删除')
    assert.equal(existsSync(join(dir, 'rescue-log', `${boundaries[2]}.json`)), false, '31 天前的分片必须被清理')
    assert.equal(existsSync(join(dir, 'rescue-log', 'meta.json')), true, 'meta.json 不受按日裁剪影响')
    const status = mon.logStatus()
    assert.equal(status.lastPrune?.note, '已清理 2 天', '状态里必须留一条「已清理 N 天」')
    assert.deepEqual(status.lastPrune?.removed, [boundaries[1], boundaries[2]].sort(), '被删日期要可追溯')

    // 反例注入：同一批分片 + keepDays=60 ⇒ 一个都不该删（证明上一条不是恒真）
    const dir2 = tempDir()
    for (const d of [...boundaries, TODAY]) writeShard(dir2, d, fixtureDay(d))
    const mon2 = new RescueMonitor(dir2, CONFIG, { keepDays: 60 })
    await mon2.init()
    assert.equal(existsSync(join(dir2, 'rescue-log', `${boundaries[2]}.json`)), true, '⚠ 注入：keepDays=60 时 31 天前的分片必须还在（否则"清理"判据恒真）')
    assert.equal(mon2.logStatus().lastPrune?.note, '无需清理')
    rmSync(dir2, { recursive: true, force: true })
  } finally {
    clock.restore()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('④ 读某一天只 open 一个文件（注入 fs 计数）；当天走内存 0 open', async () => {
  const dir = tempDir()
  const clock = useClock(NOW)
  try {
    for (let i = 1; i <= 8; i += 1) writeShard(dir, shiftDay(TODAY, -i), fixtureDay(shiftDay(TODAY, -i)))
    const counter = countingIo()
    const mon = new RescueMonitor(dir, CONFIG, { logIo: counter.io, readDays: 5 })
    await mon.init()

    const day = shiftDay(TODAY, -7) // 窗口外（readDays=5）⇒ 必须现场读分片
    counter.opens.length = 0
    const view = await mon.dayView(day)
    assert.equal(counter.opens.length, 1, `读一天必须只 open 1 个文件（实际 ${counter.opens.length}：${counter.opens.join(', ')}）`)
    assert.equal(counter.opens[0], join(dir, 'rescue-log', `${day}.json`), '打开的就是该日的分片（不是旧单文件、不是整目录）')
    assert.equal(view.events.length, 2, '该日事件必须读出来')
    assert.equal(view.why, null, '正常分片不带原因')

    counter.opens.length = 0
    const todayView = await mon.dayView(TODAY)
    assert.equal(counter.opens.length, 0, '当天从内存读 ⇒ 0 open（内存比磁盘新）')
    assert.equal(todayView.source, 'memory')

    // 反例注入：一次"整批加载"会 open 很多文件 ⇒ 上面的 ==1 必败
    counter.opens.length = 0
    await mon.ensureDays(8)
    assert.ok(counter.opens.length > 1, '⚠ 注入：按需整批加载会 open 多个文件（所以"只 open 1 个"不是恒真）')
  } finally {
    clock.restore()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('⑤ 启动只加载当天 + 最近 5 天（注入 fs 计数：6 个分片，不再整目录加载）', async () => {
  const dir = tempDir()
  const clock = useClock(NOW)
  try {
    for (let i = 0; i <= 19; i += 1) writeShard(dir, shiftDay(TODAY, -i), fixtureDay(shiftDay(TODAY, -i)))
    const counter = countingIo()
    const mon = new RescueMonitor(dir, CONFIG, { logIo: counter.io })
    await mon.init()
    const dayOpens = counter.opens.filter((p) => /^\d{4}-\d{2}-\d{2}\.json$/.test(basename(p))).map((p) => basename(p))
    const expected = [0, 1, 2, 3, 4, 5].map((i) => `${shiftDay(TODAY, -i)}.json`).sort()
    assert.deepEqual(dayOpens.slice().sort(), expected, '启动只读当天 + 最近 5 天（共 6 份分片）')
    assert.equal(counter.opens.some((p) => p.endsWith('rescue-log.json')), false, '启动不 open 旧单文件（用 stat 探测存在性）')
    assert.deepEqual(mon.logStatus().loadedDays, [0, 1, 2, 3, 4, 5].map((i) => shiftDay(TODAY, -i)).sort(), '内存里只有窗口内的 6 天')

    // 反例注入：整批加载（20 天）会明显超过 6 次 open
    counter.opens.length = 0
    await mon.ensureDays(20)
    const more = counter.opens.filter((p) => /^\d{4}-\d{2}-\d{2}\.json$/.test(basename(p)))
    assert.ok(more.length >= 14, `⚠ 注入：整批加载必须超过 6 个 open（实际 ${more.length}）`)
  } finally {
    clock.restore()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('⑥ 空/损坏分片 ⇒ 没有数据 + 原因，不影响其它天（注入：不得抛错/不得清空别的天）', async () => {
  const dir = tempDir()
  const clock = useClock(NOW)
  const shardDir = join(dir, 'rescue-log')
  try {
    writeShard(dir, '2026-11-20', fixtureDay('2026-11-20'))
    writeFileSync(join(shardDir, '2026-11-19.json'), '', 'utf8')                                              // 空文件
    writeFileSync(join(shardDir, '2026-11-18.json'), '{ 这不是 JSON', 'utf8')                                  // 解析失败
    writeFileSync(join(shardDir, '2026-11-17.json'), JSON.stringify({ v: 1, day: '2026-11-16', log: fixtureDay('2026-11-16') }), 'utf8') // 自述日期不符
    writeFileSync(join(shardDir, '2026-11-15.json'), JSON.stringify({ v: 1, day: '2026-11-15' }), 'utf8')      // 缺 log

    const mon = new RescueMonitor(dir, CONFIG, { readDays: 8 })
    await mon.init()
    const empty = await mon.dayView('2026-11-19')
    assert.equal(empty.events.length, 0, '空分片 ⇒ 事件为空（界面显示「—」）')
    assert.match(empty.why ?? '', /空/, `空分片必须给出原因（实际：${empty.why}）`)
    const broken = await mon.dayView('2026-11-18')
    assert.equal(broken.events.length, 0)
    assert.match(broken.why ?? '', /解析失败/, `坏分片必须给出原因（实际：${broken.why}）`)
    const mismatch = await mon.dayView('2026-11-17')
    assert.match(mismatch.why ?? '', /不一致/, '文件名与自述日期不符必须拒绝加载并说明')
    const noLog = await mon.dayView('2026-11-15')
    assert.match(noLog.why ?? '', /缺少 log/, '缺 log 字段必须说明')
    await assert.doesNotReject(() => mon.dayView('2026-11-18'), '坏分片不得让读取抛错')

    // 反例注入：若读取在第一份坏分片就中止/清空，"别的天"这里会变成 0 条
    const good = await mon.dayView('2026-11-20')
    assert.equal(good.events.length, 2, '⚠ 注入：坏分片不得影响其它天（正常日必须仍是 2 条）')
    assert.equal(good.why, null)
    const issues = mon.logStatus().unreadable
    assert.deepEqual(issues.map((i) => i.day), ['2026-11-15', '2026-11-17', '2026-11-18', '2026-11-19'], '状态里逐日列出读不出来的分片')
    assert.ok(issues.every((i) => i.why.length > 0), '每条都带原因（不是只有一句"读取失败"）')
    assert.equal(issues.some((i) => i.day === '2026-11-20'), false, '正常日不得出现在 unreadable 里')
  } finally {
    clock.restore()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('⑦ 迁移幂等：第二次启动不再迁移、分片逐字节不变、旧文件只有一份 .migrated', async () => {
  const dir = tempDir()
  const clock = useClock(NOW)
  try {
    writeLegacy(dir, { v: 1, days: { '2026-11-18': fixtureDay('2026-11-18'), '2026-11-19': fixtureDay('2026-11-19') }, baselines: {}, selfSamples: {}, lastSnapshot: null, updatedAt: 1 })
    const first = new RescueMonitor(dir, CONFIG)
    await first.init()
    const snapshotAfterFirst = Object.fromEntries(readdirSync(join(dir, 'rescue-log')).map((f) => [f, readFileSync(join(dir, 'rescue-log', f), 'utf8')]))
    const second = new RescueMonitor(dir, CONFIG)
    await second.init()
    assert.equal(second.logStatus().lastMigration, null, '第二次启动不得再迁移（旧文件已不在）')
    const snapshotAfterSecond = Object.fromEntries(readdirSync(join(dir, 'rescue-log')).map((f) => [f, readFileSync(join(dir, 'rescue-log', f), 'utf8')]))
    assert.deepEqual(snapshotAfterSecond, snapshotAfterFirst, '第二次启动不得改动任何分片/小题（逐字节一致）')
    assert.equal(readdirSync(dir).filter((f) => f.startsWith('rescue-log.json.migrated-')).length, 1, '只能有一份 .migrated 归档')
  } finally {
    clock.restore()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('⑧ 原子写：当天分片 + meta 一次提交，无 .tmp 残留，两份都可解析', async () => {
  const dir = tempDir()
  const clock = useClock(NOW)
  try {
    const mon = new RescueMonitor(dir, CONFIG)
    await mon.init()
    const inner = mon as unknown as { today: { samples: number } }
    inner.today.samples = 4
    await mon.flush()
    await mon.flush()
    const shardDir = join(dir, 'rescue-log')
    const files = readdirSync(shardDir).sort()
    assert.ok(files.every((f) => !f.includes('.tmp')), `不得有 .tmp 残留（实际 ${files.join(',')}）`)
    assert.deepEqual(files, [`${TODAY}.json`, 'meta.json'].sort(), '一次落盘只产生当天分片与 meta 两个文件')
    const shard = JSON.parse(readFileSync(join(shardDir, `${TODAY}.json`), 'utf8')) as DayShard<{ samples: number }>
    assert.equal(shard.day, TODAY)
    assert.equal(shard.log.samples, 4, '两次 flush 不得把计数写成 8（同日合并是"磁盘值 + 增量"，不是累加内存快照）')
    const meta = JSON.parse(readFileSync(join(shardDir, 'meta.json'), 'utf8')) as Record<string, unknown>
    assert.equal(typeof meta.updatedAt, 'number', 'meta 必须可解析且带 updatedAt')
    const write = mon.logStatus().lastWrite
    assert.equal(write?.day, TODAY)
    assert.ok((write?.shardBytes ?? 0) > 0 && (write?.metaBytes ?? 0) > 0, '状态里能读到本次写盘的字节数')
  } finally {
    clock.restore()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('⑨ 换日：跨到第二天后写到新分片，前一天分片不再变化', async () => {
  const dir = tempDir()
  const clock = useClock(NOW)
  try {
    const mon = new RescueMonitor(dir, CONFIG)
    await mon.init()
    await mon.flush()
    const day1 = `${TODAY}.json`
    const day1Mtime = shardMtimes(dir)[day1]
    assert.ok(day1Mtime !== undefined, '第一天分片存在')

    clock.set(NOW + 86_400_000) // 北京 2026-11-24 14:30
    await mon.flush()
    const after = shardMtimes(dir)
    assert.ok('2026-11-24.json' in after, '换日后必须写到新一天的分片')
    assert.equal(after[day1], day1Mtime, '前一天的分片不得被改写')
    assert.equal(mon.logStatus().lastWrite?.day, '2026-11-24', '写盘状态跟随当天')
  } finally {
    clock.restore()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('⑩ 跨日小题分离：baselines/lastSnapshot 只进 meta，不进日分片', async () => {
  const dir = tempDir()
  const clock = useClock(NOW)
  try {
    writeLegacy(dir, {
      v: 1,
      days: { '2026-11-20': fixtureDay('2026-11-20') },
      lastSnapshot: { ts: 1, level: 0, score: 0, summary: '（fixture）' },
      baselines: { '1.510300': { avgAmt20: 1e9, day: '2026-11-01', source: 'em' } },
      selfSamples: { '1.510300': [{ day: '2026-11-18', superVsAvg: 0.2 }] },
      progressCurve: null,
      progressSd: null,
      progressDays: 3,
      updatedAt: 1,
    })
    const mon = new RescueMonitor(dir, CONFIG)
    await mon.init()
    const shard = JSON.parse(readFileSync(join(dir, 'rescue-log', '2026-11-20.json'), 'utf8')) as DayShard<Record<string, unknown>>
    assert.equal('baselines' in shard, false, '日分片里不得再有跨日字段')
    assert.equal('selfSamples' in shard, false, '日分片里不得再有自建样本')
    const meta = JSON.parse(readFileSync(join(dir, 'rescue-log', 'meta.json'), 'utf8')) as Record<string, unknown>
    assert.deepEqual(meta.baselines, { '1.510300': { avgAmt20: 1e9, day: '2026-11-01', source: 'em' } }, '基准搬进 meta 且值不变')
    assert.ok(meta.lastSnapshot !== null && meta.lastSnapshot !== undefined, '上次成功快照搬进 meta（重启后还能兜底）')
  } finally {
    clock.restore()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('⑪ 首次启动（空目录）：不建旧单文件，落盘只建分片目录', async () => {
  const dir = tempDir()
  const clock = useClock(NOW)
  try {
    const mon = new RescueMonitor(dir, CONFIG)
    await mon.init()
    assert.deepEqual(mon.logStatus().loadedDays, [TODAY], '空库：内存里只有今天（空壳）')
    assert.equal(mon.logStatus().lastMigration, null, '没有旧文件 ⇒ 不算迁移')
    await mon.flush()
    assert.equal(existsSync(join(dir, 'rescue-log.json')), false, '首次启动不得创建旧单文件')
    assert.equal(existsSync(join(dir, 'rescue-log', `${TODAY}.json`)), true, '当天分片必须写出')
  } finally {
    clock.restore()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('⑬ 迁移时已有分片 ⇒ 合并（按 key 取并集，两边的记录都不丢）', async () => {
  const dir = tempDir()
  const clock = useClock(NOW)
  try {
    // 分片里先有一条 11:00 的事件；旧文件里同一天有另一条 10:00 的事件 + 一条出分日志
    const shardDay = fixtureDay('2026-11-20', { events: 0, intraday: 0, scoreLog: 0 })
    shardDay.events = [{ ts: Date.parse('2026-11-20T11:00:00+08:00'), hhmm: '11:00', level: 1, score: 40, reason: '（分片）', engine: 'fixture' }]
    writeShard(dir, '2026-11-20', shardDay)
    writeLegacy(dir, {
      v: 1,
      days: { '2026-11-20': fixtureDay('2026-11-20', { events: 1, intraday: 1, scoreLog: 1 }) },
      baselines: {}, selfSamples: {}, lastSnapshot: null, updatedAt: 1,
    })
    const mon = new RescueMonitor(dir, CONFIG)
    await mon.init()
    const merged = JSON.parse(readFileSync(join(dir, 'rescue-log', '2026-11-20.json'), 'utf8')) as DayShard<{ events: Array<{ hhmm: string }>; scoreLog?: unknown[] }>
    assert.deepEqual(merged.log.events.map((e) => e.hhmm).sort(), ['10:00', '11:00'], '两边的事件都要留下（覆盖/跳过都会丢一条）')
    assert.equal(merged.log.scoreLog?.length, 1, '旧文件里的出分日志也要并进来')
    assert.equal(mon.logStatus().lastMigration?.days, 1, '合并也算迁移写出的分片数')
  } finally {
    clock.restore()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('⑫ 分片仓库纯函数：日期位移与条目计数（口径单测，防止边界日漂移）', async () => {
  assert.equal(shiftDay('2026-03-01', -1), '2026-02-28')
  assert.equal(shiftDay('2026-01-01', -1), '2025-12-31')
  assert.equal(shiftDay('2026-11-23', 1), '2026-11-24')
  assert.equal(countDayEntries({ events: [1, 2], intraday: [1], scoreLog: [1, 2, 3] }), 6)
  assert.equal(countDayEntries({}), 0)
  assert.equal(countDayEntries(null), 0)
  // 保留/读取天数：默认 30 / 5，环境变量合法值生效、非法值回落（不许 NaN 变成"删光"）
  assert.equal(rescueLogKeepDays({}), 30)
  assert.equal(rescueLogReadDays({}), 5)
  assert.equal(rescueLogKeepDays({ RESCUE_LOG_KEEP_DAYS: '7' }), 7)
  assert.equal(rescueLogReadDays({ RESCUE_LOG_READ_DAYS: '2' }), 2)
  assert.equal(rescueLogKeepDays({ RESCUE_LOG_KEEP_DAYS: 'abc' }), 30)
  assert.equal(rescueLogReadDays({ RESCUE_LOG_READ_DAYS: '0' }), 5)
  // 仓库层的"读一天"对不存在的分片只返回 missing + 原因、不抛错
  const dir = tempDir()
  try {
    const store = new RescueLogStore(dir)
    const got = await store.readDay('2026-11-01')
    assert.equal(got.log, null)
    assert.equal(got.missing, true, '不存在的分片是 missing（不是"损坏"）')
    assert.equal(basename(got.path), '2026-11-01.json')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
