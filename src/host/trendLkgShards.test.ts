/**
 * `trends-lkg` 分片化的三条硬判据（AUDIT-IMPL76 第 3 项）。
 *
 *  ① **单次写入 ≤ 512 KB**：旧的单文件形状是 2.34 MB 整份重写；分片后一次只写"变了的那几条"
 *     （每条 ≈ 18 KB）+ 清单（≈ 8 KB）。判据用 `maxWriteBytes`（单次 write 的最大字节），
 *     并给出反例对照：把同一批 entries 拼成旧形状的 blob，**必然**超过上限。
 *  ② **重启后重建逐字节等价**：清单（key/at/seq/bytes）是唯一事实源，分片只放 trend；
 *     重载后 `entriesForTest()` 的序列化必须与重启前**逐字节相同**。丢一个分片 ⇒ 必须报
 *     `missing` 且不再等价（不静默当"没有这条"）。
 *  ③ **保留有上限且口径可见**：超限只按最旧丢，`dropped` 逐条带原因、`droppedTotal` 计数；
 *     守恒判据 `存活 + 累计丢弃 == 写入总数`（静默截断会让等式不成立）。
 *     悬停文案与常量同源（`shared/trendRetention.ts`）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { TrendData } from '../shared/model.ts'
import {
  TREND_LKG_DIR, TREND_LKG_LEGACY_BACKUP, TREND_LKG_MANIFEST_FILE, TrendLkgStore,
  decodeLkgManifest, decodeLegacyLkg, lkgShardName,
} from './trendLkgStore.ts'
import { TREND_LKG_MAX, TREND_LKG_MAX_BYTES, TREND_LKG_MAX_SHARD_WRITE_BYTES, TREND_LKG_RETENTION_NOTE } from '../shared/trendRetention.ts'

function freshDir(): string {
  return mkdtempSync(join(tmpdir(), 'tw-lkg-shard-'))
}

function trendOf(points: number, seed = 1): TrendData {
  return {
    secid: '1.600519',
    prePrice: null,
    points: Array.from({ length: points }, (_, i) => ({
      t: 1_790_000_000_000 + i * 60_000,
      label: `2026-10-16 10:${String(i % 60).padStart(2, '0')}`,
      price: 100 + (i % 7) + seed,
      avg: null,
      vol: null,
      amount: null,
    })),
    last: 100,
  }
}

test('① 单次写入 ≤ 512 KB：40 条 × 242 点只写 41 次小文件；旧形状（整份 blob）必然越界', async () => {
  const dir = freshDir()
  const store = new TrendLkgStore(() => dir)
  const entries: Array<{ key: string; at: number; trend: TrendData }> = []
  for (let i = 0; i < 40; i += 1) {
    const key = `1.6005${String(i).padStart(2, '0')}|1`
    const at = 1_000 + i
    const trend = trendOf(242, i)
    entries.push({ key, at, trend })
    store.set(key, at, trend)
  }
  await store.persist({ force: true })
  const stats = store.statsOf()
  assert.equal(stats.shardWrites, 40, `40 条都必须写（实际 ${stats.shardWrites}）`)
  assert.ok(stats.maxWriteBytes <= TREND_LKG_MAX_SHARD_WRITE_BYTES,
    `单次写入必须 ≤ ${TREND_LKG_MAX_SHARD_WRITE_BYTES} B（实际 ${stats.maxWriteBytes} B）`)
  assert.ok(stats.maxWriteBytes < 64 * 1024, `实测单条分片应 < 64 KB（实际 ${Math.round(stats.maxWriteBytes / 1024)} KB）`)
  assert.ok(stats.manifestWrites === 1, '清单只写一次')
  // 反例对照：旧形状把 40 条拼成一个 blob ⇒ 必然超过单次写入上限（注入回整份重写 ⇒ ① 必败）
  const legacyBlobBytes = Buffer.byteLength(JSON.stringify({ ts: Date.now(), entries }))
  assert.ok(legacyBlobBytes > TREND_LKG_MAX_SHARD_WRITE_BYTES,
    `旧形状（整份 ${Math.round(legacyBlobBytes / 1024)} KB）必须超过单次上限 ${TREND_LKG_MAX_SHARD_WRITE_BYTES} B —— 这正是拆分要解决的问题`)
  assert.ok(legacyBlobBytes > stats.maxWriteBytes * 10, '拆分后单次写入至少小一个数量级')
})

test('② 重启后重建**逐字节等价**；丢一个分片 ⇒ 必须报 missing 且不再等价', async () => {
  const dir = freshDir()
  const store = new TrendLkgStore(() => dir, () => 5_000)
  for (let i = 0; i < 5; i += 1) store.set(`1.6005${i}|1`, 1_000 + i, trendOf(20, i))
  await store.persist({ force: true })
  const before = JSON.stringify(store.entriesForTest())
  // 模拟重启：清内存 + 清"已装载"，重新从磁盘读
  store.__resetForTest()
  const loaded = await store.load()
  assert.deepEqual(loaded.missing, [], '正常磁盘上不该有缺失分片')
  assert.equal(JSON.stringify(store.entriesForTest()), before, '重启后的条目必须与重启前**逐字节相同**（key/at/seq/trend 全等）')
  const manifest = decodeLkgManifest(JSON.parse(readFileSync(join(dir, TREND_LKG_MANIFEST_FILE), 'utf8')))
  assert.ok(manifest !== null)
  assert.deepEqual(manifest.entries.map((e) => e.key), ['1.60050|1', '1.60051|1', '1.60052|1', '1.60053|1', '1.60054|1'], '清单顺序 = seq 顺序')
  // 反例注入：删掉一个分片 ⇒ 重载必须报 missing（不静默丢），且重建结果不再等价
  rmSync(join(dir, TREND_LKG_DIR, lkgShardName('1.60052|1')))
  store.__resetForTest()
  const broken = await store.load()
  assert.equal(broken.missing.length, 1, `丢分片必须报出来（实际 ${broken.missing.length}）`)
  assert.equal(broken.missing[0].key, '1.60052|1')
  assert.notEqual(JSON.stringify(store.entriesForTest()), before, '⚠ 丢分片后重建结果不再等价 —— 这条判据抓得到')
})

test('③ 保留上限可见且不静默：守恒（存活 + 累计丢弃 == 总数），caps/dropped 写进清单', async () => {
  const dir = freshDir()
  const store = new TrendLkgStore(() => dir)
  store.__setCapsForTest({ maxEntries: 10, maxBytes: TREND_LKG_MAX_BYTES })
  const total = 12
  for (let i = 0; i < total; i += 1) store.set(`1.6005${i}|1`, 1_000 + i, trendOf(3, i))
  await store.persist({ force: true })
  const manifest = decodeLkgManifest(JSON.parse(readFileSync(join(dir, TREND_LKG_MANIFEST_FILE), 'utf8')))
  assert.ok(manifest !== null)
  assert.equal(manifest.entries.length, 10, `存活 10 条（实际 ${manifest.entries.length}）`)
  assert.equal(manifest.droppedTotal, 2, `累计丢弃 2 条（实际 ${manifest.droppedTotal}）`)
  assert.equal(manifest.entries.length + manifest.droppedTotal, total, '⚠ 守恒：存活 + 累计丢弃必须 == 写入总数（静默截断会破坏它）')
  assert.equal(manifest.dropped.length, 2, 'dropped 明细要写进清单')
  assert.ok(manifest.dropped.every((d) => d.reason.includes('条数上限')), `每条都要带原因：${JSON.stringify(manifest.dropped)}`)
  assert.equal(manifest.caps.maxEntries, 10, '生效的 cap 写进清单（口径可见）')
  assert.equal(manifest.caps.maxShardWriteBytes, TREND_LKG_MAX_SHARD_WRITE_BYTES)
  // 反例：静默截断（丢了但不记）会让守恒等式不成立
  const silent = { kept: manifest.entries.slice(0, 10), dropped: [] as unknown[] }
  assert.notEqual(silent.kept.length + silent.dropped.length, total, '⚠ 静默截断的形状必然破坏守恒 —— 判据抓得到')
  // 悬停文案与常量同源（客户端那一行）
  assert.ok(TREND_LKG_RETENTION_NOTE.includes(String(TREND_LKG_MAX)), '文案里必须写保留条数上限')
  assert.ok(TREND_LKG_RETENTION_NOTE.includes('MB'), '文案里必须写体积上限')
  assert.ok(TREND_LKG_RETENTION_NOTE.includes('dropped'), '文案里必须说明丢弃有留痕')
})

test('④ 迁移：老版单文件 → 分片 + 清单，逐条不丢；老文件改名备份', async () => {
  const dir = freshDir()
  const entries = Array.from({ length: 3 }, (_, i) => ({ key: `1.6006${i}|1`, at: 2_000 + i, trend: trendOf(15, i) }))
  writeFileSync(join(dir, TREND_LKG_MANIFEST_FILE), JSON.stringify({ ts: 1, entries }), 'utf8')
  const store = new TrendLkgStore(() => dir)
  const loaded = await store.load()
  assert.deepEqual(loaded.missing, [], '迁移不该丢条目')
  assert.equal(store.size, 3, `3 条都要在（实际 ${store.size}）`)
  assert.equal(store.statsOf().migrated, 3, '要记迁移条数（留痕/可观测）')
  const manifest = decodeLkgManifest(JSON.parse(readFileSync(join(dir, TREND_LKG_MANIFEST_FILE), 'utf8')))
  assert.ok(manifest !== null && manifest.entries.length === 3, '清单已是 v3 且 3 条')
  assert.ok(readFileSync(join(dir, TREND_LKG_LEGACY_BACKUP), 'utf8').includes('1.60060|1'), '老文件改名备份（不复制 2.3 MB）')
  // 迁移后的分片仍可逐字节重建
  const before = JSON.stringify(store.entriesForTest())
  store.__resetForTest()
  await store.load()
  assert.equal(JSON.stringify(store.entriesForTest()), before, '迁移后的存储也必须支持逐字节重建')
  // 老格式解码器的反例：v3 清单不会被当成老格式
  assert.equal(decodeLegacyLkg({ v: 3, entries: [] }), null, 'v3 清单不得被误判成老格式')
})
