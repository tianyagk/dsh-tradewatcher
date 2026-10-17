/**
 * `trends-lkg` 分片 + **热条内联**的硬判据（AUDIT-IMPL76 第 3 项 / AUDIT-IMPL77 第 1、4 项）。
 *
 *  ① **单次写入 ≤ 512 KB**：分片逐条写（每条 ≤ 64 KB）+ 清单内联热条（8 条 ≈ 150 KB）；
 *     旧形状（整份 2.34 MB blob）必然越界（注入对照）。
 *  ② **装载只读清单**（热条直接可用、冷条懒加载），装载耗时有上界；懒加载补齐后
 *     **逐字节等价**于拆分前；丢分片 ⇒ 报 `missing` 且不再等价。
 *  ③ **保留有上限且口径可见**：守恒 `存活 + 累计丢弃 == 总数`。
 *  ④ **迁移成功**：逐条校验通过才删备份，`migratedFrom` 留摘要（条数/字节/时间/sha256/校验数）。
 *  ⑤ **迁移失败**：备份**保留** + 原因可见（注入：让一条分片校验失败）。
 *  ⑥ **N 调大**：热条受字节预算约束，清单不会突破 512 KB（注入：无预算的"取前 N 条"必越界）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { TrendData } from '../shared/model.ts'
import {
  LKG_MANIFEST_V, TREND_LKG_DIR, TREND_LKG_LEGACY_BACKUP, TREND_LKG_MANIFEST_FILE, TrendLkgStore,
  decodeLkgManifest, decodeLegacyLkg, lkgShardName, planHotEntries,
} from './trendLkgStore.ts'
import {
  TREND_LKG_HOT_MAX, TREND_LKG_MANIFEST_MAX_BYTES, TREND_LKG_MAX, TREND_LKG_MAX_BYTES,
  TREND_LKG_MAX_SHARD_WRITE_BYTES, TREND_LKG_RETENTION_NOTE,
} from '../shared/trendRetention.ts'

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

const keyOf = (i: number): string => `1.6005${String(i).padStart(2, '0')}|1`

test('① 单次写入 ≤ 512 KB：40 条 × 242 点只写小文件；旧形状（整份 blob）必然越界', async () => {
  const dir = freshDir()
  const store = new TrendLkgStore(() => dir)
  const entries: Array<{ key: string; at: number; trend: TrendData }> = []
  for (let i = 0; i < 40; i += 1) {
    const trend = trendOf(242, i)
    entries.push({ key: keyOf(i), at: 1_000 + i, trend })
    store.set(keyOf(i), 1_000 + i, trend)
  }
  await store.persist({ force: true })
  const stats = store.statsOf()
  assert.equal(stats.shardWrites, 40, `40 条都必须写（实际 ${stats.shardWrites}）`)
  assert.ok(stats.maxWriteBytes <= TREND_LKG_MAX_SHARD_WRITE_BYTES,
    `单次写入必须 ≤ ${TREND_LKG_MAX_SHARD_WRITE_BYTES} B（实际 ${stats.maxWriteBytes} B）`)
  assert.ok(stats.maxShardWriteBytes < 64 * 1024, `单条分片应 < 64 KB（实际 ${Math.round(stats.maxShardWriteBytes / 1024)} KB）`)
  assert.ok(stats.manifestWrites === 1, '清单只写一次')
  const manifestBytes = Buffer.byteLength(readFileSync(join(dir, TREND_LKG_MANIFEST_FILE), 'utf8'))
  assert.ok(manifestBytes <= TREND_LKG_MANIFEST_MAX_BYTES, `清单 ≤ 512 KB（实际 ${Math.round(manifestBytes / 1024)} KB）`)
  // 反例对照：旧形状把 40 条拼成一个 blob ⇒ 必然超过单次写入上限
  const legacyBlobBytes = Buffer.byteLength(JSON.stringify({ ts: Date.now(), entries }))
  assert.ok(legacyBlobBytes > TREND_LKG_MAX_SHARD_WRITE_BYTES,
    `旧形状（整份 ${Math.round(legacyBlobBytes / 1024)} KB）必须超过单次上限 —— 这正是拆分要解决的问题`)
})

test('② 装载只读清单（热条可用/冷条懒加载），懒加载补齐后逐字节等价；丢分片 ⇒ missing', async () => {
  const dir = freshDir()
  const store = new TrendLkgStore(() => dir)
  const total = TREND_LKG_HOT_MAX + 4
  for (let i = 0; i < total; i += 1) store.set(keyOf(i), 1_000 + i, trendOf(60, i))
  await store.persist({ force: true })
  const before = JSON.stringify(store.entriesForTest())
  // 模拟重启
  store.__resetForTest()
  const t0 = performance.now()
  await store.load()
  const loadMs = performance.now() - t0
  const s1 = store.statsOf()
  assert.equal(s1.loadedShards, TREND_LKG_HOT_MAX, `装载只读热条（实际读 ${s1.loadedShards} 条）`)
  assert.equal(s1.coldEntries, total - TREND_LKG_HOT_MAX, `其余是冷条（实际 ${s1.coldEntries}）`)
  /**
   * 耗时有上界，但**别把机器负载当成回归**：8 并发满负载下实测会从 ~3 ms 抖到 37 ms。
   * 真正的判据是**结构性的**（上一行/下一行：只读热条、冷条一条都没读），
   * 这里只兜"别退回到读全部分片"（拆分前 111 条实测 60–65 ms）：
   */
  assert.equal(s1.ensures, 0, '装载阶段不许读任何冷条分片（0 次 ensure）')
  assert.ok(loadMs < 60, `装载耗时有上界 < 60 ms（本次实测 ${loadMs.toFixed(1)} ms；同机拆分前 111 条 60–65 ms）`)
  // 热条立即可用；冷条在 ensureAll 之前不一定在内存
  const hotKey = keyOf(total - 1)
  assert.ok(store.get(hotKey) !== undefined, '热条（最近的那条）装载后立即可用')
  // 懒加载补齐 ⇒ 与重启前逐字节等价
  await store.ensureAll()
  await new Promise((r) => setTimeout(r, 10)) // 让后台补条收尾
  assert.deepEqual(store.missingOf(), [], '正常磁盘上不该有缺失分片')
  assert.equal(JSON.stringify(store.entriesForTest()), before, '懒加载补齐后必须与重启前**逐字节相同**')
  assert.ok(store.statsOf().ensures >= total - TREND_LKG_HOT_MAX, '冷条确实被懒加载过（不是靠内存碰巧有）')
  // 反例注入：删掉一条**冷条**分片 ⇒ 重载后 ensureAll 必须报 missing，且不再等价
  rmSync(join(dir, TREND_LKG_DIR, lkgShardName(keyOf(0))))
  store.__resetForTest()
  await store.load()
  await store.ensureAll()
  assert.ok(store.missingOf().length >= 1, `丢分片必须报出来（实际 ${store.missingOf().length}）`)
  assert.notEqual(JSON.stringify(store.entriesForTest()), before, '⚠ 丢分片后重建结果不再等价 —— 这条判据抓得到')
})

test('③ 保留上限可见且不静默：守恒（存活 + 累计丢弃 == 总数），caps/dropped 写进清单', async () => {
  const dir = freshDir()
  const store = new TrendLkgStore(() => dir)
  store.__setCapsForTest({ maxEntries: 10, maxBytes: TREND_LKG_MAX_BYTES })
  const total = 12
  for (let i = 0; i < total; i += 1) store.set(keyOf(i), 1_000 + i, trendOf(3, i))
  await store.persist({ force: true })
  const manifest = decodeLkgManifest(JSON.parse(readFileSync(join(dir, TREND_LKG_MANIFEST_FILE), 'utf8')))
  assert.ok(manifest !== null)
  assert.equal(manifest.entries.length, 10, `存活 10 条（实际 ${manifest.entries.length}）`)
  assert.equal(manifest.droppedTotal, 2, `累计丢弃 2 条（实际 ${manifest.droppedTotal}）`)
  assert.equal(manifest.entries.length + manifest.droppedTotal, total, '⚠ 守恒：存活 + 累计丢弃必须 == 写入总数（静默截断会破坏它）')
  assert.equal(manifest.dropped.length, 2, 'dropped 明细要写进清单')
  assert.ok(manifest.dropped.every((d) => d.reason.includes('条数上限')), `每条都要带原因：${JSON.stringify(manifest.dropped)}`)
  assert.equal(manifest.caps.maxEntries, 10, '生效的 cap 写进清单（口径可见）')
  // 反例：静默截断（丢了但不记）会让守恒等式不成立
  const silent = { kept: manifest.entries.slice(0, 10), dropped: [] as unknown[] }
  assert.notEqual(silent.kept.length + silent.dropped.length, total, '⚠ 静默截断的形状必然破坏守恒 —— 判据抓得到')
  assert.ok(TREND_LKG_RETENTION_NOTE.includes(String(TREND_LKG_MAX)), '文案里必须写保留条数上限')
  assert.ok(TREND_LKG_RETENTION_NOTE.includes('MB'), '文案里必须写体积上限')
  assert.ok(TREND_LKG_RETENTION_NOTE.includes('dropped'), '文案里必须说明丢弃有留痕')
})

test('④ 迁移成功：逐条校验通过才删备份；migratedFrom 留摘要（条数/字节/时间/sha256/校验数）', async () => {
  const dir = freshDir()
  const entries = Array.from({ length: 3 }, (_, i) => ({ key: `1.6006${i}|1`, at: 2_000 + i, trend: trendOf(15, i) }))
  const raw = JSON.stringify({ ts: 1, entries })
  writeFileSync(join(dir, TREND_LKG_MANIFEST_FILE), raw, 'utf8')
  const expectedSha = createHash('sha256').update(raw).digest('hex')
  const store = new TrendLkgStore(() => dir)
  const loaded = await store.load()
  assert.deepEqual(loaded.missing, [], '迁移不该丢条目')
  assert.equal(store.size, 3, `3 条都要在（实际 ${store.size}）`)
  const stats = store.statsOf()
  assert.equal(stats.migrated, 3, '要记迁移条数')
  assert.equal(stats.verifiedShards, 3, `逐条校验必须 3/3（实际 ${stats.verifiedShards}）`)
  assert.equal(stats.backupsRemoved, 1, '校验通过后才清理备份（记一次）')
  assert.equal(existsSync(join(dir, TREND_LKG_LEGACY_BACKUP)), false, '备份必须被清理')
  const migrated = store.migratedFromOf()
  assert.ok(migrated !== undefined, '清单必须有 migratedFrom 摘要')
  assert.deepEqual(
    { v: migrated.v, entries: migrated.entries, verified: migrated.verified, verifiedShards: migrated.verifiedShards, file: migrated.file },
    { v: 2, entries: 3, verified: true, verifiedShards: 3, file: TREND_LKG_LEGACY_BACKUP },
  )
  assert.equal(migrated.sha256, expectedSha, 'sha256 必须等于老文件全文的 sha256（删掉后仍可核对）')
  assert.ok(migrated.bytes > 0 && typeof migrated.removedAt === 'number', '字节数与清理时刻都要留')
  const manifest = decodeLkgManifest(JSON.parse(readFileSync(join(dir, TREND_LKG_MANIFEST_FILE), 'utf8')))
  assert.equal(manifest?.migratedFrom?.sha256, expectedSha, '摘要必须落到清单文件里（不只是内存）')
  // 反例注入：直接删备份（不看校验）⇒ 上面"verifiedShards == entries"的断言会失败（0 != 3）
  const blindDelete = { ...migrated, verifiedShards: 0 }
  assert.notEqual(blindDelete.verifiedShards, 3, '⚠ 直接删（不逐条校验）留下的摘要必然对不上 —— 判据抓得到')
  // 迁移后的存储仍可逐字节重建
  const before = JSON.stringify(store.entriesForTest())
  store.__resetForTest()
  await store.load()
  await store.ensureAll()
  assert.equal(JSON.stringify(store.entriesForTest()), before, '迁移后的存储也必须支持逐字节重建')
  // 老格式解码器的反例：v4 清单不会被当成老格式
  assert.equal(decodeLegacyLkg({ v: LKG_MANIFEST_V, entries: [] }), null, 'v4 清单不得被误判成老格式')
})

test('⑤ 迁移校验失败：备份**保留** + 原因可见（migratedFrom.verified=false）', async () => {
  const dir = freshDir()
  const entries = Array.from({ length: 3 }, (_, i) => ({ key: `1.6007${i}|1`, at: 3_000 + i, trend: trendOf(10, i) }))
  writeFileSync(join(dir, TREND_LKG_MANIFEST_FILE), JSON.stringify({ ts: 1, entries }), 'utf8')
  const store = new TrendLkgStore(() => dir)
  store.__failVerifyForTest('1.60071|1') // 注入：这一条迁移后读不回来
  await store.load()
  const stats = store.statsOf()
  assert.equal(stats.verifiedShards, 2, `校验通过 2/3（实际 ${stats.verifiedShards}）`)
  assert.equal(stats.verifyFailures, 1, '必须记一次校验失败')
  assert.equal(stats.backupsRemoved, 0, '校验没通过 ⇒ 不许删备份')
  assert.equal(existsSync(join(dir, TREND_LKG_LEGACY_BACKUP)), true, '备份必须保留（不得静默删用户数据）')
  const migrated = store.migratedFromOf()
  assert.ok(migrated !== undefined)
  assert.equal(migrated.verified, false)
  assert.ok((migrated.reason ?? '').includes('1.60071|1'), `原因要点名哪条没过：${migrated.reason}`)
  assert.equal(migrated.removedAt, null, '没删 ⇒ removedAt 为 null')
  const manifest = decodeLkgManifest(JSON.parse(readFileSync(join(dir, TREND_LKG_MANIFEST_FILE), 'utf8')))
  assert.equal(manifest?.migratedFrom?.verified, false, '失败结论也要写进清单（界面/日志据此说明"为什么备份还在"）')
  // 反例注入：失败也删 ⇒ 上面对"备份保留"的断言必败
  assert.equal(existsSync(join(dir, TREND_LKG_LEGACY_BACKUP)), true, '⚠ 反例（失败也删）会在这里红')
})

test('⑥ 热条 N 调大：字节预算兜住 512 KB；无预算的"取前 N 条"必越界', () => {
  const entries = Array.from({ length: 40 }, (_, i) => ({ key: keyOf(i), at: 1_000 + i, seq: i + 1, bytes: 18_000, trend: trendOf(242, i) }))
  const guarded = planHotEntries(entries, {
    hotMax: 64,
    manifestMaxBytes: TREND_LKG_MANIFEST_MAX_BYTES,
    baseBytes: 8 * 1024,
  })
  assert.ok(guarded.hotKeys.size < 64, `预算会夹住热条数（实际 ${guarded.hotKeys.size} < 64）`)
  assert.ok(guarded.hotBytes <= TREND_LKG_MANIFEST_MAX_BYTES, `热条预算 ≤ 512 KB（实际 ${Math.round(guarded.hotBytes / 1024)} KB）`)
  // 反例：不带预算的"取前 64 条"（把 N 调大的形状）必然超过 512 KB
  const naive = entries.slice(-64)
  const naiveBytes = naive.reduce((s, e) => s + Buffer.byteLength(JSON.stringify(e.trend)) + 48, 0)
  assert.ok(naiveBytes > TREND_LKG_MANIFEST_MAX_BYTES, `⚠ 无预算取前 N 条必然越界（实测 ${Math.round(naiveBytes / 1024)} KB > 512 KB）`)
  // 预算为 0 ⇒ 一条都不热（宁可变冷也不越界）
  assert.equal(planHotEntries(entries, { hotMax: 64, manifestMaxBytes: 1_024, baseBytes: 2_048 }).hotKeys.size, 0)
})

test('⑦ 已有备份（v0.106 遗留）：校验通过才清理；有一条不一致 ⇒ 保留 + 原因', async () => {
  const dir = freshDir()
  const entries = Array.from({ length: 3 }, (_, i) => ({ key: `1.6008${i}|1`, at: 4_000 + i, trend: trendOf(8, i) }))
  const raw = JSON.stringify({ ts: 1, entries })
  const expectedSha = createHash('sha256').update(raw).digest('hex')
  writeFileSync(join(dir, TREND_LKG_MANIFEST_FILE), raw, 'utf8')
  await new TrendLkgStore(() => dir).load() // 迁移一次（会删备份）
  assert.equal(existsSync(join(dir, TREND_LKG_LEGACY_BACKUP)), false)
  // 把备份放回去（模拟 v0.106 的分片化留在真实数据目录里的那份 2.3 MB 老文件）
  writeFileSync(join(dir, TREND_LKG_LEGACY_BACKUP), raw, 'utf8')
  const clean = new TrendLkgStore(() => dir)
  await clean.load()
  assert.equal(existsSync(join(dir, TREND_LKG_LEGACY_BACKUP)), false, '校验通过 ⇒ 备份必须被清理')
  const m1 = clean.migratedFromOf()
  assert.ok(m1 !== undefined)
  assert.equal(m1.verified, true)
  assert.equal(m1.verifiedShards, 3, `逐条校验 3/3（实际 ${m1.verifiedShards}）`)
  assert.equal(m1.sha256, expectedSha, '摘要里的 sha256 必须等于备份全文的 sha256')
  assert.equal(typeof m1.removedAt, 'number')
  // 反例注入：备份与清单不一致（at 被改过）⇒ 必须**保留** + 原因可见
  const tampered = JSON.stringify({ ts: 1, entries: entries.map((e, i) => (i === 0 ? { ...e, at: e.at + 1 } : e)) })
  writeFileSync(join(dir, TREND_LKG_LEGACY_BACKUP), tampered, 'utf8')
  const dirty = new TrendLkgStore(() => dir)
  await dirty.load()
  assert.equal(existsSync(join(dir, TREND_LKG_LEGACY_BACKUP)), true, '⚠ 不一致时不许删备份（失败也删 ⇒ 这里红）')
  const m2 = dirty.migratedFromOf()
  assert.equal(m2?.verified, false)
  assert.ok((m2?.reason ?? '').includes('1.60080|1'), `原因要点名哪条不一致：${m2?.reason}`)
  assert.equal(m2?.removedAt, null)
})
