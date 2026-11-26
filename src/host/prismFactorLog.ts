/**
 * 因子日志：append-only JSONL，按日分文件，保留 30 天。
 * 只记录、不参与决策；写失败不影响交易。
 */
import { appendFile, mkdir, readdir, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { dayOf } from './time.ts'

export const FACTOR_LOG_DAYS = 30

export interface FactorLogEntry {
  at: number
  day: string
  version: string
  secid: string
  name: string
  cutoff: string
  gate: { code: string | null; detail: string; spreadPct: number | null; netYuan: number | null }
  factors: { atrPct: number | null; atrRank120: number | null; amp20Pct: number | null; tickPct: number | null; bars: number }
}

/** 追加一行；目录不存在则创建。返回是否成功（失败静默）。 */
export async function appendFactorLog(dir: string, entry: FactorLogEntry): Promise<boolean> {
  try {
    await mkdir(dir, { recursive: true })
    await appendFile(join(dir, `${entry.day}.jsonl`), JSON.stringify(entry) + '\n', 'utf8')
    return true
  } catch {
    return false
  }
}

/** 删除超过 N 天的日志文件（按文件名 YYYY-MM-DD 判断） */
export async function pruneFactorLogs(dir: string, days = FACTOR_LOG_DAYS): Promise<number> {
  try {
    const files = await readdir(dir)
    const cutoff = dayOf(Date.now() - days * 86_400_000)
    let removed = 0
    for (const f of files) {
      if (!/^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)) continue
      if (f.slice(0, 10) < cutoff) { await unlink(join(dir, f)); removed += 1 }
    }
    return removed
  } catch { return 0 }
}
