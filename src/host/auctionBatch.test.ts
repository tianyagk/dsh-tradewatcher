/**
 * P2-4（`docs/AUDIT-HOST-PERF.md`）：竞价采样落盘的 IO 次数 + 单飞闸。
 *
 * 旧实现每个点做三次文件操作（`mkdir` + `isCorrupt` 读+parse + `updateJsonLocked` 锁内再读），
 * 40 标的 = 40×3 = **120 次"读类" fs 操作**；定时器 `setInterval(10s)` 直接 `void tick()`，
 * 一拍超过 10s 时两拍会重叠、同一批文件被重复读写。
 *
 * 本文件的判据（fs 由注入的 `AuctionIo` 计数，不靠猜）：
 *   ① 一拍 40 标的 ⇒ 读类操作 **≤41**（一次 mkdir + 每标的一次锁内读）、写恰好 40 次；
 *   ② 两拍并发 ⇒ 第二拍 `skippedByFlight` 且 `skippedTicks=1`，**没有第二次写**；
 *   ③ 坏文件仍被隔离（`.corrupt-*`）后重建 —— 判坏只在"读/parse 失败"路径上发生。
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  AuctionSampler,
  AuctionStore,
  AUCTION_WRITE_CONCURRENCY,
  auctionTick,
  type AuctionIo,
  type AuctionQuoteRow,
  type AuctionUniverseSource,
} from './auctionSeries.ts'
import { writeFileAtomic } from './atomic.ts'
import { parseMarketStamp } from './time.ts'

const at = (label: string): number => parseMarketStamp(label) as number
const DAY = '2026-10-22'
const STAMP = at('2026-10-22 09:20:00')
const NOW = at('2026-10-22 09:20:01')

interface Counters {
  /** `readText` 次数（每个标的一次） */
  reads: number
  /** `mkdir` 次数（一拍一次） */
  mkdirs: number
  /** `writeText` 次数（每个标的一次） */
  writes: number
}

/** 计数版 IO：与真实实现同样的语义，只是把每次调用记下来 */
function countingIo(): { io: AuctionIo; counters: Counters } {
  const counters: Counters = { reads: 0, mkdirs: 0, writes: 0 }
  const io: AuctionIo = {
    mkdir: async (dir) => {
      counters.mkdirs += 1
      await mkdir(dir, { recursive: true })
    },
    readText: async (file) => {
      counters.reads += 1
      return await readFile(file, 'utf8')
    },
    writeText: async (file, text) => {
      counters.writes += 1
      await writeFileAtomic(file, text)
    },
  }
  return { io, counters }
}

/** 40 个标的（一拍的上限量级） */
const SECIDS = Array.from({ length: 40 }, (_, i) => `1.60${String(1000 + i)}`)

const sourceOf = (secids: readonly string[]): AuctionUniverseSource => ({
  watchData: () => ({ items: secids.map((secid) => ({ secid })) }),
  portData: () => ({ items: [] }),
})

const rowsOf = (secids: readonly string[]): AuctionQuoteRow[] =>
  secids.map((secid) => ({ secid, bid1: 10, bid1Vol: 100, ask1: 10, ask1Vol: 80, stamp: STAMP }))

/** 每个用例一个临时目录（不碰真实 `~/.dsh`） */
async function withDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'tw-auction-batch-'))
  try {
    await fn(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

test('P2-4①：一拍 40 标的的读类操作 120 → ≤41（一次 mkdir + 每标的一次锁内读），写 40 次', async () => {
  await withDir(async (dir) => {
    const { io, counters } = countingIo()
    const store = new AuctionStore(dir, io)
    const rows = rowsOf(SECIDS)
    const result = await auctionTick({
      now: () => NOW,
      source: sourceOf(SECIDS),
      loadQuotes: async () => rows,
      savePoints: (items) => store.addPoints(items).then(() => undefined),
    })
    assert.equal(result.inWindow, true)
    assert.equal(result.sampled, SECIDS.length)

    const baseline = SECIDS.length * 3 // 旧实现：mkdir + isCorrupt 读 + updateJsonLocked 读
    assert.equal(baseline, 120, '旧口径 40×3 = 120 次读类操作')
    assert.equal(counters.mkdirs, 1, '一拍只 mkdir 一次（不是每标的每拍一次）')
    assert.equal(counters.reads, SECIDS.length, '每标的正常路径只读一次（锁内那一次）')
    assert.ok(counters.reads + counters.mkdirs <= 41, `读类操作必须 ≤41，实测 ${counters.reads + counters.mkdirs}`)
    assert.equal(counters.writes, SECIDS.length, '每标的恰好写一次')
    assert.ok(counters.writes < SECIDS.length * 2, '不能出现"写前预读 + 重写"的重复写')
    assert.equal(AUCTION_WRITE_CONCURRENCY, 8)

    // 落盘内容正确：每个文件一个点
    const one = await store.seriesOf(SECIDS[0] as string, DAY)
    assert.equal(one?.points.length, 1)
    assert.equal(one?.points[0]?.t, STAMP)

    // 反例注入：把"每标的一读"改成"每标的三读"⇒ 判据必须失败（证明上限不是随手写的）
    const inflated = { reads: SECIDS.length * 3, mkdirs: SECIDS.length }
    assert.throws(() => assert.ok(inflated.reads + inflated.mkdirs <= 41, '反例'), /反例/, '⚠ 反例（旧口径 120）必须失败')
  })
})

test('P2-4②：两拍并发 ⇒ 第二拍 skipped（skippedTicks=1），且只写一遍', async () => {
  await withDir(async (dir) => {
    const { io, counters } = countingIo()
    const store = new AuctionStore(dir, io)
    const rows = rowsOf(SECIDS)
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const sampler = new AuctionSampler(sourceOf(SECIDS), store, {
      now: () => NOW,
      loadQuotes: async () => {
        await gate
        return rows
      },
    })

    const first = sampler.tick()
    const second = await sampler.tick() // 第一拍还卡在取行情 ⇒ 必须被单飞闸挡下
    assert.equal(second.skippedByFlight, true, '第二拍必须标记 skippedByFlight')
    assert.equal(second.inWindow, true, 'skipped 不等于"不在窗口"：这一拍确实在 09:15–09:25 内，只是上一拍没跑完')
    assert.equal(second.sampled, 0)
    assert.equal(sampler.skippedTicks, 1, 'skippedTicks 计数 +1')
    assert.equal(sampler.busy, true)
    assert.equal(counters.writes, 0, '第二拍不许触发任何写')

    release()
    const done = await first
    assert.equal(done.sampled, SECIDS.length)
    assert.equal(counters.writes, SECIDS.length, '40 个点只写一遍（不是 80）')
    assert.equal(sampler.skippedTicks, 1)
    assert.equal(sampler.busy, false, '第一拍结束后在飞闸复位')

    // 闸复位后再来一拍照常工作（不是"一次后就永久跳过"）
    const third = await sampler.tick()
    assert.equal(third.skippedByFlight, undefined)
    assert.equal(third.sampled, SECIDS.length)
    assert.equal(counters.writes, SECIDS.length * 2)
  })
})

test('P2-4③：坏文件仍被隔离（只在读/parse 失败时判坏），随后重建', async () => {
  await withDir(async (dir) => {
    const { io } = countingIo()
    const store = new AuctionStore(dir, io)
    const secid = SECIDS[0] as string
    await writeFile(join(dir, `${secid}.json`), '{bad json', 'utf8')

    const result = await store.addPoints([{ secid, day: DAY, point: { t: STAMP, ref: 10, matched: 100 } }])
    assert.equal(result.written, 1)
    assert.equal(result.quarantined, 1, '坏文件必须被隔离')

    const files = await readdir(dir)
    assert.ok(files.some((f) => f.includes('.corrupt-')), `坏文件必须改名留存：${files.join(',')}`)
    const after = await store.seriesOf(secid, DAY)
    assert.equal(after?.points.length, 1, '隔离后从空重建为 1 个新点')
  })
})

test('P2-4④：写路径读失败（EACCES）⇒ 不覆写、failed=1（R1 红线不回退）', async () => {
  await withDir(async (dir) => {
    const secid = SECIDS[0] as string
    const file = join(dir, `${secid}.json`)
    // 先用真实 IO 写一份真数据
    const good = new AuctionStore(dir)
    await good.addPoints([{ secid, day: DAY, point: { t: STAMP, ref: 10, matched: 100 } }])
    const before = await readFile(file, 'utf8')

    // 注入"读不到"（权限/磁盘类错误，非 ENOENT、非 SyntaxError）⇒ 本轮必须放弃写
    let writes = 0
    const store = new AuctionStore(dir, {
      mkdir: async (d) => {
        await mkdir(d, { recursive: true })
      },
      readText: async () => {
        const error = new Error('注入：拒绝读取') as NodeJS.ErrnoException
        error.code = 'EACCES'
        throw error
      },
      writeText: async (f, text) => {
        writes += 1
        await writeFileAtomic(f, text)
      },
    })
    const result = await store.addPoints([{ secid, day: DAY, point: { t: STAMP + 10_000, ref: 10, matched: 120 } }])
    assert.equal(result.written, 0)
    assert.equal(result.failed, 1)
    assert.equal(writes, 0, '读不到 ≠ 空数据：绝不能整份覆写')
    assert.equal(await readFile(file, 'utf8'), before, '原文件必须逐字未改')
  })
})
