/**
 * BIS SDMX **后台归档**（用户口径 v0.89.0：单次约 25 秒 ⇒ **只允许后台归档，不得进交互路径**）。
 *
 * 用法：`npm run macro:archive`（人工/定时跑；**不**由插件在页面上调用）
 *   · 先过 `robots.txt` 门禁与「每主机 ≤5 次/小时」预算（与交互路径同一套实现）；
 *   · 归档到 `DSH_HOME/dsh-tradewatcher/macro-archive.json`（只增不改，带抓取时间与来源）；
 *   · BIS 的长期序列很慢，这里只取**最近若干个观测**，一次一条数据集，失败如实记录、不写 0。
 *
 * 为什么单独一个文件：BIS 的形态是"官方长期序列"，与"今天的读数"完全不同的用途 ——
 * 混进交互路径会把页面拖到 25 秒级，正是这次要避免的事。
 */
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { HostBudget, gatedFetch } from '../src/host/robotsGate.ts'
import { dataHome } from '../src/host/store.ts'
import { dayOf } from '../src/host/time.ts'

interface ArchiveFile {
  v: 1
  /** 数据集 id → 最近一次归档结果 */
  sets: Record<string, { at: number; day: string; ok: boolean; note: string; rows: string[] }>
}

/**
 * 归档目标（**只放实测可得的**）：
 *   · `WS_LONG_CPI/M.US` —— 实测 200（本机 2026-10-15 复核），长期 CPI 官方序列；
 *   · 美元指数的 BIS 有效汇率（EER）dataflow **id 未确认**：`WS_EER/M.US[.B|.A]` 三种键形实测全 404
 *     （本小时预算用了 4 次，不再试探）。要接的话先列 dataflow：
 *       `curl -sS 'https://stats.bis.org/api/v1/dataflow/BIS?format=jsondata'`
 *     确认 id 后再加进来 —— **没确认的源不写进代码**（否则就是把 404 当数据）。
 */
const TARGETS: Array<{ id: string; url: string }> = [
  { id: 'BIS_WS_LONG_CPI_M_US', url: 'https://stats.bis.org/api/v1/data/WS_LONG_CPI/M.US?format=csv&lastNObservations=3' },
]

export function macroArchivePath(home = dataHome()): string {
  return join(home, 'macro-archive.json')
}

function readArchive(path: string): ArchiveFile {
  if (!existsSync(path)) return { v: 1, sets: {} }
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as ArchiveFile
    return parsed !== null && typeof parsed === 'object' && typeof parsed.sets === 'object' ? parsed : { v: 1, sets: {} }
  } catch {
    return { v: 1, sets: {} }
  }
}

async function main(): Promise<void> {
  const path = macroArchivePath()
  const file = readArchive(path)
  const budget = new HostBudget()
  const day = dayOf(Date.now())
  for (const target of TARGETS) {
    try {
      // ⚠ 超时给足（BIS 实测 ~25s）；仍然走门禁 ⇒ robots 禁止就不发请求
      const got = await gatedFetch(target.url, { budget, timeoutMs: 60_000, host: 'stats.bis.org' })
      if (!got.ok) {
        file.sets[target.id] = { at: Date.now(), day, ok: false, note: got.note, rows: [] }
        console.log(`[SKIP] ${target.id}：${got.note}`)
        continue
      }
      const text = await got.res.text()
      const rows = text.trim().split('\n').slice(-4)
      file.sets[target.id] = { at: Date.now(), day, ok: true, note: `${rows.length} 行（末行 = 最新观测）`, rows }
      console.log(`[OK] ${target.id}：${rows[rows.length - 1]?.slice(0, 120)}`)
    } catch (error) {
      const note = `失败：${String(error).slice(0, 160)}`
      file.sets[target.id] = { at: Date.now(), day, ok: false, note, rows: [] }
      console.log(`[ERR] ${target.id}：${note}`)
    }
  }
  mkdirSync(dataHome(), { recursive: true })
  writeFileSync(path, JSON.stringify(file, null, 1), 'utf8')
  console.log(`归档已写入 ${path}（每主机本小时用量：${Object.entries(budget.snapshot()).map(([h, t]) => `${h} ${t.length}`).join('，') || '无'}）`)
}

await main()
