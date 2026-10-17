/**
 * `/trend` 归档的**写放大**闸（REVIEW-9-PERF §3.2 / §3.3）。
 *
 * 背景（实测）：`trendWithFallback` 在出口对**每一次** `/trend` 调 `archiveTrendDays`
 * （上游/内存缓存/LKG 命中都过一遍，为了"缓存命中也归档"），而旧实现每次：
 *   · 把当天归档文件**整份重写**（17–18 KB，实测 14 731 B/次，`/proc/self/io`）；
 *   · 对**每个** entry 各做一次 `dirSize`（`readdir` + 每文件一次 `statx`）—— 5 日档 6 次 readdir + 60 statx；
 *   · 每次再 `prune` 一次 `readdir`。
 * 自选页迷你图（`mini.ts`，TTL 90s、最多 80 卡）⇒ 最坏 1.2 MB/90s 的**逐字节相同**重写。
 *
 * 这里锁三件事（判据是**计数**，不是耗时 ⇒ 不随机器负载抖）：
 *  ① 内容未变 ⇒ **零写入、零 readdir**（`writes`/`dirreadCalls` 不增），且文件 mtime 不变；
 *  ② 内容变了 ⇒ 恰好写一次；滚动清理只在"真的多出来"时做一次；
 *  ③ 反例：指纹若含 `updatedAt`（时间戳）⇒ 每次都变 ⇒ ① 必败（这就是 `trends-lkg` 失效的形状）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { TrendPoint } from '../shared/model.ts'
import { payloadFingerprint } from '../shared/fingerprint.ts'
import {
  archiveTrendDays, encodeTrendDay, __resetTrendArchiveStats, __trendArchiveStatsOf,
} from './trendArchive.ts'

function freshHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'tw-archive-cost-'))
  process.env.DSH_HOME = home
  __resetTrendArchiveStats()
  return home
}

const pts = (n: number, price = 10): TrendPoint[] =>
  Array.from({ length: n }, (_, i) => ({ t: 1_790_000_000_000 + i * 60_000, label: `2026-10-09 09:${String(i).padStart(2, '0')}`, price: price + i, avg: null, vol: null, amount: null }))

test('① 内容未变 ⇒ 零写入 + 零 readdir（迷你图重复调用的那条路径）', async () => {
  const home = freshHome()
  const entries = Array.from({ length: 5 }, (_, i) => ({ day: `2026-10-${String(12 + i).padStart(2, '0')}`, points: pts(242) }))
  const first = await archiveTrendDays('0.000636', entries)
  assert.equal(first.saved.length, 5, '首次必须真的写 5 天')
  const s1 = __trendArchiveStatsOf()
  assert.equal(s1.writes, 5, `首次写 5 次（实际 ${s1.writes}）`)
  assert.equal(s1.dirreadCalls, 1, `目录只读一次（实际 ${s1.dirreadCalls}）—— 旧实现是每 entry 一次`)
  const file = join(home, 'dsh-tradewatcher', 'trends', '0.000636', '2026-10-12.json')
  const mtime1 = statSync(file).mtimeMs

  // 完全相同的第二次（模拟迷你图 90s 后又问了一遍）
  await new Promise((r) => setTimeout(r, 5))
  const second = await archiveTrendDays('0.000636', entries)
  const s2 = __trendArchiveStatsOf()
  assert.deepEqual(second.saved, [], '内容未变 ⇒ saved 为空（没有发生写入）')
  assert.equal(s2.writes, 5, `写次数不得增加（实际 ${s2.writes}）`)
  assert.equal(s2.dirreadCalls, 1, `零写入那轮不许读目录（实际 ${s2.dirreadCalls}）`)
  assert.equal(s2.skippedSame, 5, `5 天都应记为"内容未变"（实际 ${s2.skippedSame}）`)
  assert.equal(statSync(file).mtimeMs, mtime1, '文件 mtime 不得变化（证明真的没重写）')
})

test('② 内容变了 ⇒ 恰好写一次；5 日档的目录读仍只有一次', async () => {
  freshHome()
  const day = '2026-10-12'
  await archiveTrendDays('0.000636', [{ day, points: pts(200) }])
  const before = __trendArchiveStatsOf()
  await archiveTrendDays('0.000636', [{ day, points: pts(201) }])
  const after = __trendArchiveStatsOf()
  assert.equal(after.writes, before.writes + 1, '内容多一个点 ⇒ 必须重写')
  assert.equal(after.dirreadCalls, before.dirreadCalls + 1, '写入那轮读一次目录')
  assert.equal(after.skippedSame, before.skippedSame, '没有"未变"跳过')
})

test('③ 滚动清理只在"真的多出来"时执行一次（不再每轮 readdir 一遍）', async () => {
  freshHome()
  // keepDays=3：写第 1–3 天不触发清理；第 4 天触发一次，之后每天各触发一次
  for (const d of ['2026-10-01', '2026-10-02', '2026-10-03']) {
    await archiveTrendDays('1.600519', [{ day: d, points: pts(10) }], { keepDays: 3 })
  }
  assert.equal(__trendArchiveStatsOf().pruneCalls, 0, '文件数未超配额 ⇒ 不清理')
  await archiveTrendDays('1.600519', [{ day: '2026-10-06', points: pts(10) }], { keepDays: 3 })
  assert.equal(__trendArchiveStatsOf().pruneCalls, 1, '第 4 个文件 ⇒ 清理一次')
  // 同一天再来一次（内容未变）⇒ 既不写也不清理
  await archiveTrendDays('1.600519', [{ day: '2026-10-06', points: pts(10) }], { keepDays: 3 })
  assert.equal(__trendArchiveStatsOf().pruneCalls, 1, '零写入那轮不许清理')
  assert.equal(__trendArchiveStatsOf().writes, 4, '总共只写过 4 天')
})

test('④ 反例注入：指纹含 `updatedAt` ⇒ 每次都变 ⇒ 去重闸必败（trends-lkg 失效的形状）', () => {
  const points = pts(242)
  const a = payloadFingerprint(JSON.stringify(encodeTrendDay('0.000636', '2026-10-12', points, 1_000)))
  const b = payloadFingerprint(JSON.stringify(encodeTrendDay('0.000636', '2026-10-12', points, 2_000)))
  assert.notEqual(a, b, '⚠ 注入（指纹含 updatedAt）必须改变指纹 —— 正因为如此，实现只用 points 的内容做指纹')
  const c = payloadFingerprint(JSON.stringify(encodeTrendDay('0.000636', '2026-10-12', points, 9_999)))
  assert.notEqual(b, c, '不同 updatedAt ⇒ 指纹不同 ⇒ 含时间戳的指纹永远判"有变化"（这就是守卫失效的机理）')
  // 实现用的是 points 本身：**内容相同、对象不同** ⇒ 指纹必须相同（不是比同一句话的两遍）
  const fpOfA = payloadFingerprint(JSON.stringify(points))
  const fpOfB = payloadFingerprint(JSON.stringify(pts(242)))
  assert.equal(fpOfA, fpOfB, '同一份内容（两次独立构造）⇒ 指纹必须相同')
})
