/**
 * `trends-lkg` 真的会被写出来、而且**重启后能从分片重建**（端到端，不是只测纯函数）。
 *
 * 为什么必须有这一条：v0.91.0 在 `persistTrendLkg` 里把"要不要写"的判定写在**状态清零之后**
 * （先 `dirty=false`、先 `lastWrite=now`），判定永远为"跳过"且不报错 ⇒ 这份兜底文件自那版起停止更新。
 * 纯函数测试锁不住"调用方的顺序"，只有走真实取数路径才能。
 *
 * 本文件同时覆盖分片化的两条真实性：
 *  - 写出来的**单次字节** ≤ 512 KB（判据来自真实取数路径，而不是单元测试里的手工 set）；
 *  - **模拟重启**（清内存 + 清"已装载"）后再次取数，能从分片读回（`loadedShards ≥ 1`）。
 *
 * 隔离：本文件在 import `em.ts` **之前**把 `DSH_HOME` 钉到 `/tmp` 下，
 * 所以这里写的是临时目录，不碰真实 `~/.dsh`。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { TrendPoint } from '../shared/model.ts'

process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'tw-lkg-persist-'))

const {
  fetchTrend, lastGoodTrend, __reloadTrendLkgForTest, __resetTrendLkgForTest, __trendLkgStatsOf,
} = await import('./em.ts')

const points: TrendPoint[] = Array.from({ length: 5 }, (_, i) => ({
  t: 1_790_000_000_000 + i * 60_000,
  label: `2026-10-16 10:0${i}`,
  price: 100 + i,
  avg: null,
  vol: null,
  amount: null,
}))
const upstream = async (): Promise<{ secid: string; prePrice: null; points: TrendPoint[]; last: number }> =>
  ({ secid: '1.600519', prePrice: null, points, last: points[points.length - 1].price })

test('一次成功取数必须落盘；单次写入 ≤ 512 KB；模拟重启后能从分片重建', async () => {
  __resetTrendLkgForTest()
  const home = process.env.DSH_HOME as string
  const dir = join(home, 'dsh-tradewatcher')
  const manifestPath = join(dir, 'trends-lkg.json')
  assert.equal(existsSync(manifestPath), false, '前置：本进程还没有这份文件')

  const trend = await fetchTrend('1.600519', 1, { archive: false, upstream })
  assert.ok(trend !== null && trend.points.length === 5, '前置：取数成功（走了 rememberTrend 那条路）')
  await new Promise((r) => setTimeout(r, 300)) // 落盘是 fire-and-forget（不阻塞回包）

  assert.equal(existsSync(manifestPath), true, '清单必须落盘 —— dirty 被提前清掉 / lastWrite 被提前推进，这里就永远不存在')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { v?: number; ts?: number; caps?: { maxShardWriteBytes?: number }; entries?: Array<{ key?: string; at?: number; seq?: number }> }
  assert.equal(manifest.v, 3, '清单是新版 v3（分片布局）')
  assert.equal(typeof manifest.ts, 'number', '落盘文本带 ts（这份文件是什么时候写的）')
  assert.equal(manifest.entries?.length, 1, `必须有一条 entries（实际 ${manifest.entries?.length ?? 0}）`)
  assert.equal(manifest.entries?.[0]?.key, '1.600519|1', '条目键 = secid|ndays')
  assert.equal(typeof manifest.caps?.maxShardWriteBytes, 'number', '保留口径（单次写入上限）必须写进清单')
  const stats = __trendLkgStatsOf()
  assert.ok(stats.shardWrites >= 1, `必须写了分片（实际 ${stats.shardWrites}）`)
  assert.ok(stats.maxWriteBytes <= 512 * 1024, `单次写入必须 ≤ 512 KB（实际 ${stats.maxWriteBytes} B）`)
  assert.ok(stats.maxWriteBytes < 64 * 1024, `真实分片应远小于 512 KB（实际 ${Math.round(stats.maxWriteBytes / 1024)} KB）`)

  // 模拟重启：清内存 + 清"已装载" ⇒ 下一次取数会重新从清单 + 分片重建
  __reloadTrendLkgForTest()
  assert.equal(lastGoodTrend('1.600519', 1), null, '重启后内存为空（还没 load）')
  const again = await fetchTrend('1.600519', 1, { archive: false, upstream })
  assert.ok(again !== null && again.points.length === 5, '重启后取数仍然成功')
  const after = __trendLkgStatsOf()
  assert.ok(after.loadedShards >= 1, `重启后必须从分片读回（loadedShards=${after.loadedShards}）—— 分片丢了这里会是 0`)
})
