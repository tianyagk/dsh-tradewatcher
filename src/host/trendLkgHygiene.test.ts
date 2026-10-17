/**
 * `trends-lkg` 分片存储的**数据卫生**（AUDIT-IMPL76 第 3 项）。
 *
 * 旧实现是单文件 2.34 MB / 132 条、每 5 秒整份重写（REVIEW-9-PERF §3.2）。拆成分片后必须继续锁住四件事：
 *  ① **保留有上限、且不静默**：超条数/超体积时只按最旧丢，每一条都在清单 `dropped` 里带原因
 *     （守恒判据：`存活 + 累计丢弃 == 写入过的总数`）；
 *  ② **只写变化的分片**：`trend` 没变（只有 `at` 变）⇒ 分片 0 写入、只写清单（≈8 KB）；
 *  ③ **分片里只有 trend**（`ts`/`at` 不进分片）：时间进分片会让"内容未变"永远判成"变了"；
 *  ④ **节流语义**：窗口内不写、且 dirty 必须保留（下一轮重试）—— v0.91.0 的两个顺序 bug 就是在这里丢的。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { TrendData } from '../shared/model.ts'
import {
  LKG_MANIFEST_V, LKG_PERSIST_MS, TrendLkgStore, decodeLkgManifest, encodeLkgShard, lkgShardName, planLkgTrim,
} from './trendLkgStore.ts'
import { TREND_LKG_MAX, TREND_LKG_MAX_BYTES } from '../shared/trendRetention.ts'

function freshDir(): string {
  return mkdtempSync(join(tmpdir(), 'tw-lkg-hyg-'))
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

test('① 保留策略：超条数/超体积只按最旧丢，每条带原因（守恒：存活 + 丢弃 == 总数）', () => {
  const entries = Array.from({ length: 12 }, (_, i) => ({ key: `k${i}|1`, at: 1_000 + i * 10, seq: i + 1, bytes: 10 }))
  const byCount = planLkgTrim(entries, { maxEntries: 10, maxBytes: TREND_LKG_MAX_BYTES })
  assert.equal(byCount.dropped.length, 2, `超 2 条 ⇒ 丢 2 条（实际 ${byCount.dropped.length}）`)
  assert.deepEqual(byCount.dropped.map((d) => d.key), ['k0|1', 'k1|1'], '丢的必须是最旧的两条')
  assert.ok(byCount.dropped.every((d) => d.reason.includes('条数上限')), `原因要写清是条数上限：${JSON.stringify(byCount.dropped)}`)
  // 体积上限：每条形如 10 字节，上限 25 字节 ⇒ 只能留 2 条（新的）
  const byBytes = planLkgTrim(entries, { maxEntries: 100, maxBytes: 25 })
  assert.equal(byBytes.dropped.length, 10, `体积超限 ⇒ 丢 10 条（实际 ${byBytes.dropped.length}）`)
  assert.ok(byBytes.dropped.every((d) => d.reason.includes('体积上限')), '原因要写清是体积上限')
  assert.deepEqual(byBytes.kept.map((k) => k.key), ['k10|1', 'k11|1'], '留下的是最新的两条')
  // 守恒：存活 + 丢弃 == 总数（静默截断会让这个等式不成立）
  assert.equal(byCount.kept.length + byCount.dropped.length, entries.length)
  assert.equal(byBytes.kept.length + byBytes.dropped.length, entries.length)
})

test('② 只写变化的分片：trend 未变（只有 at 变）⇒ 分片 0 写、只写清单；trend 变 ⇒ 恰好 1 次分片写', async () => {
  const dir = freshDir()
  const store = new TrendLkgStore(() => dir)
  store.set('1.600519|1', 1_000, trendOf(30))
  await store.persist({ force: true })
  const first = store.statsOf()
  assert.equal(first.shardWrites, 1, `首次必须写 1 条分片（实际 ${first.shardWrites}）`)
  assert.equal(first.manifestWrites, 1, '同时写清单')
  // 同一份 trend、只有 at 变（每次取数都会刷新 at）⇒ 分片不许重写
  store.set('1.600519|1', 2_000, trendOf(30))
  // 节流窗口内 ⇒ 不写（交给 ④ 验证）；这里 force 绕过
  await store.persist({ force: true })
  const second = store.statsOf()
  assert.equal(second.shardWrites, 1, `trend 未变 ⇒ 分片写入次数不得增加（实际 ${second.shardWrites}）`)
  assert.equal(second.manifestWrites, 2, 'at 变了 ⇒ 清单要更新（清单只有几 KB）')
  // trend 变了 ⇒ 恰好 1 次
  store.set('1.600519|1', 3_000, trendOf(31))
  await store.persist({ force: true })
  assert.equal(store.statsOf().shardWrites, 2, `trend 变了 ⇒ 分片写 1 次（累计 2，实际 ${store.statsOf().shardWrites}）`)
})

test('③ 分片里只有 trend（不含 ts/at）；清单带 caps/dropped/entries(seq)；注入 ts ⇒ 必败', async () => {
  const dir = freshDir()
  const store = new TrendLkgStore(() => dir)
  store.set('1.600519|1', 1_234, trendOf(5))
  await store.persist({ force: true })
  const shard = JSON.parse(readFileSync(join(dir, 'trends-lkg.d', lkgShardName('1.600519|1')), 'utf8')) as Record<string, unknown>
  assert.deepEqual(Object.keys(shard).sort(), ['key', 'trend', 'v'], `分片只允许这三个键（实际 ${Object.keys(shard).join(',')}）`)
  assert.equal('at' in shard, false, 'at 只在清单里（进分片会让"内容未变"永远判成变了）')
  assert.equal('ts' in shard, false, 'ts 不许进分片')
  const manifestRaw = JSON.parse(readFileSync(join(dir, 'trends-lkg.json'), 'utf8')) as unknown
  const manifest = decodeLkgManifest(manifestRaw)
  assert.ok(manifest !== null, '清单必须可解码（v3）')
  assert.equal(manifest.v, LKG_MANIFEST_V)
  assert.deepEqual(manifest.caps, { maxEntries: TREND_LKG_MAX, maxBytes: TREND_LKG_MAX_BYTES, maxShardWriteBytes: 512 * 1024 }, '保留口径必须写进清单（悬停文案与它同源）')
  assert.equal(manifest.entries.length, 1)
  assert.equal(manifest.entries[0].key, '1.600519|1')
  assert.equal(manifest.entries[0].at, 1_234, 'at 在清单里')
  assert.equal(typeof manifest.entries[0].seq, 'number', 'seq 决定重载顺序')
  assert.ok(manifest.entries[0].bytes > 0, '字节数也记下来（体积上限不必每次 stat）')
  // 反例注入：把 at 塞回分片 ⇒ 上面对键集合的断言必败
  const injected = JSON.parse(encodeLkgShard('1.600519|1', trendOf(5))) as Record<string, unknown>
  injected.at = 1_234
  assert.notDeepEqual(Object.keys(injected).sort(), ['key', 'trend', 'v'], '⚠ 注入（分片里塞 at）必须被键集合判据抓住')
})

test('④ 节流：窗口内不写且 **dirty 保留**；过窗后写（v0.91.0 的两个顺序 bug 的形状）', async () => {
  const dir = freshDir()
  let now = 10_000_000
  const store = new TrendLkgStore(() => dir, () => now)
  store.set('a|1', now, trendOf(3))
  await store.persist() // 第一次：lastWrite=now
  const base = store.statsOf()
  assert.equal(base.persists, 1)
  // 窗口内再改：persist 必须什么都不做
  now += Math.floor(LKG_PERSIST_MS / 2)
  store.set('b|1', now, trendOf(4))
  await store.persist()
  assert.equal(store.statsOf().persists, 1, '节流窗口内不许 persist')
  assert.equal(store.statsOf().shardWrites, 1, '窗口内不许写分片')
  // 过窗：上一轮的 dirty 必须**还在**（丢掉它 = 这条永远不落盘）
  now += LKG_PERSIST_MS + 1
  await store.persist()
  assert.equal(store.statsOf().persists, 2, '过窗后必须真的 persist')
  assert.equal(store.statsOf().shardWrites, 2, 'b|1 的分片必须补写（dirty 被保住）')
  // 反例：窗口内把 dirty 清掉（旧 bug）⇒ 过窗后不会有第 2 次写
  const fresh = new TrendLkgStore(() => freshDir(), () => now)
  fresh.set('c|1', now, trendOf(3))
  await fresh.persist()
  fresh.__resetForTest()
  assert.equal(fresh.statsOf().persists, 0, '⚠ 反例形状：清掉 dirty（reset）后窗口内一次都不会写')
})
