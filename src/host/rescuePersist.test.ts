/**
 * 跨进程计数合并的端到端断言（`rescue-log.json`）。
 *
 * 背景：`RescueMonitor.persist()` 是**整份覆写**，而 `today.samples += 1` 加在本进程内存里
 * ⇒ 两个进程（用户的 `dsh web` + 临时实例；或两条审计链）各自 +1 时，谁后写谁赢，
 * 另一次的拍数被静默吞掉（AUDIT-CACHE-2 §7.6 实测 `samples=371` 无法归因）。
 * 修法见 `docs/AUDIT-IMPL42.md` §5.1：`updateJsonLocked` 锁内「读磁盘最新 → 合并 → 写回」。
 *
 * 这里用**两个真子进程**各自做一次"采样 +1 → persist(true)"，断言最终计数 = 初值 + 2；
 * 反例注入（把 `updateJsonLocked` 换回裸覆写）⇒ 必须变成 +1（见报告 §5）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { dayOf } from './time.ts'

const here = fileURLToPath(new URL('.', import.meta.url))
const childPath = join(here, 'rescuePersist.child.ts')

interface LogShape {
  days?: Record<string, { samples?: number; events?: unknown[] }>
}

/** 钉住"现在"：跨北京自然日边界跑测试时，父子进程可能落在不同的 day key 上 */
const PINNED_NOW = Date.UTC(2026, 9, 12, 7, 0, 0) // 北京 2026-10-12 15:00

function spawnChild(dir: string, delayMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      ['--experimental-strip-types', childPath, dir, String(delayMs)],
      { timeout: 60_000, env: { ...process.env, TW_CHILD_NOW: String(PINNED_NOW) } },
      (error, stdout, stderr) => {
        if (error !== null) reject(new Error(`子进程失败：${String(error)}\n${stdout}\n${stderr}`))
        else resolve(stdout)
      },
    )
  })
}

test('rescue-log 跨进程：两个真进程各 samples += 1 ⇒ 计数是 +2（不是 +1）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tw-rescue-persist-'))
  mkdirSync(dir, { recursive: true })
  const file = join(dir, 'rescue-log.json')
  const today = dayOf(PINNED_NOW)
  // 初值 7：两个进程各 +1 ⇒ 必须是 9
  writeFileSync(file, JSON.stringify({ v: 1, days: { [today]: { events: [], intraday: [], samples: 7, gap: false } }, lastSnapshot: null, baselines: {}, selfSamples: {}, progressCurve: null, progressDays: 0, updatedAt: 0 }))
  // 同时起两个进程（第二个稍晚一点点，制造"读同一份旧值"的窗口）
  const [a, b] = await Promise.all([spawnChild(dir, 0), spawnChild(dir, 150)])
  assert.ok(a.includes('child done') && b.includes('child done'), `两个子进程都要正常结束：${a} / ${b}`)
  const after = JSON.parse(readFileSync(file, 'utf8')) as LogShape
  assert.equal(after.days?.[today]?.samples, 9, `两次采样都必须留下（初值 7 + 2 = 9）；实际 ${after.days?.[today]?.samples} —— 若为 8 说明后写者覆盖了先写者`)
})
