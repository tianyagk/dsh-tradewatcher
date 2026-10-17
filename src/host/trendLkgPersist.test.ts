/**
 * `trends-lkg.json` 真的会被写出来（**端到端**，不是只测纯函数）。
 *
 * 为什么必须有这一条：v0.91.0 在 `persistTrendLkg` 里加了"要不要写"的判定，但把状态**先改了再判**：
 *   ① 先 `trendLkgDirty = false`，再把清完的值传给 `trendWriteDecision` ⇒ 判定永远看到 `dirty:false`；
 *   ② 先 `trendLkgLastWrite = now`，再让判定算 `now - lastWrite < 5000` ⇒ 永远"节流窗口内"。
 * 两个 bug 都**不报错、不写日志**，后果是这份兜底文件自 v0.91.0 起停止更新（本机实测停在 10-16 10:03）。
 * 纯函数测试（`trendLkgHygiene.test.ts` ③/④）锁不住"调用方顺序"——只有走真实取数路径才能。
 *
 * 隔离：本文件在 import `em.ts` **之前**把 `DSH_HOME` 钉到 `/tmp` 下（em 的 `dataHome()` 每次调用现读 env），
 * 所以这里写的是临时目录，不碰真实 `~/.dsh`。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'tw-lkg-persist-'))

const { fetchTrend } = await import('./em.ts')

test('一次成功取数必须把 trends-lkg.json 写出来（两个顺序 bug 都会让它永远不写）', async () => {
  const path = join(process.env.DSH_HOME as string, 'dsh-tradewatcher', 'trends-lkg.json')
  assert.equal(existsSync(path), false, '前置：本进程还没有这份文件')
  const points = Array.from({ length: 5 }, (_, i) => ({
    t: 1_790_000_000_000 + i * 60_000,
    label: `2026-10-16 10:0${i}`,
    price: 100 + i,
    avg: null,
    vol: null,
    amount: null,
  }))
  const trend = await fetchTrend('1.600519', 1, {
    archive: false,
    upstream: async () => ({ secid: '1.600519', prePrice: null, points, last: points[points.length - 1].price }),
  })
  assert.ok(trend !== null && trend.points.length === 5, '前置：取数成功（走了 rememberTrend 那条路）')
  await new Promise((r) => setTimeout(r, 300)) // 落盘是 fire-and-forget（不阻塞回包）
  assert.equal(existsSync(path), true, '必须落盘 —— dirty 被提前清掉、或 lastWrite 被提前推进，这里就永远不存在')
  const saved = JSON.parse(readFileSync(path, 'utf8')) as { ts?: number; entries?: Array<{ key?: string; at?: number }> }
  assert.equal(typeof saved.ts, 'number', '落盘文本带 ts（这份文件是什么时候写的）')
  assert.equal(saved.entries?.length, 1, `必须有一条 entries（实际 ${saved.entries?.length ?? 0}）`)
  assert.equal(saved.entries?.[0]?.key, '1.600519|1', '条目键 = secid|ndays')
})
