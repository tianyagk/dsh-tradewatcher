/**
 * `klines/` 两处加锁落点的**真两进程**端到端断言（AUDIT-IMPL42 §5.2 交付给我的部分）。
 *
 * 覆盖两件事（这两处此前只有代码级复核）：
 *   ① `saveKlineCache`：两个进程同时保存**同一个** `<secid>_<klt>_<fqt>.json`，
 *      各自带一组**互不重复**的 bar ⇒ 最终文件里**两组都在**（锁内「读磁盘最新 → 合并 → 写回」）。
 *   ② `pruneKlineCache`：两个进程同时触发裁剪（目录超配额）⇒ ① 文件数收敛到配额内
 *      ② 非缓存条目（点文件 / 非 `.json`）**不被删**（清单过滤；`.klines.lock` 正属这一类）
 *      ③ 目录里 0 个 `.tmp` 残留；④ 两次裁剪的删除数之和 == 创建数 − 配额（证明**串行**发生）。
 *
 * 反例注入（各自贴证据后恢复，见 docs/AUDIT-IMPL41.md §10）：
 *   - 把 `saveKlineCache` 退回 `writeFileAtomic` 整份覆写 ⇒ ① 必须失败（只剩后写者的 bar）。
 *   - 去掉 `readdir` 的 `*.json` / 点文件过滤 ⇒ ② 必须失败（哨兵文件被当最早的候选删掉）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = fileURLToPath(new URL('.', import.meta.url))
const childPath = join(here, 'klineLock.child.ts')

interface DayBar { date: string; close: number }

function spawnChild(args: string[]): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(process.execPath, ['--experimental-strip-types', childPath, ...args], { timeout: 90_000 }, (error, stdout, stderr) => {
      if (error !== null) reject(new Error(`子进程失败：${String(error)}\n${stdout}\n${stderr}`))
      else resolve({ stdout, stderr })
    })
  })
}

/** 子进程内已经把 DSH_HOME 钉成 /tmp 下（并在自己那边硬断言），这里再核一次 */
function assertIsolated(dir: string): void {
  assert.ok(dir.startsWith('/tmp'), `测试目录必须在 /tmp 下（实际 ${dir}）—— 不许碰用户真实数据目录`)
}

const DAY = 86_400_000

test('① K 线缓存：两进程同时保存同一文件 ⇒ 互不重复的两组 bar 都在（锁内合并）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tw-kline-lock-'))
  assertIsolated(dir)
  mkdirSync(join(dir, 'dsh-tradewatcher', 'klines'), { recursive: true })
  // 两个进程在同一时刻开跑：A 给 D0..D399，B 给 D300..D700（重叠 101 根，并集 701 根）
  const startAt = Date.now() + 800
  const [a, b] = await Promise.all([
    spawnChild(['save', dir, '0', '400', String(startAt)]),
    spawnChild(['save', dir, '300', '401', String(startAt)]),
  ])
  assert.ok(a.stdout.includes('child done') && b.stdout.includes('child done'), `两个子进程都要正常结束：${a.stdout} / ${b.stdout}`)
  const file = join(dir, 'dsh-tradewatcher', 'klines', '1.600519_101_1.json')
  const saved = JSON.parse(readFileSync(file, 'utf8')) as { bars: DayBar[]; updatedAt: number }
  const dates = saved.bars.map((x) => x.date)
  const BASE = Date.parse('2024-01-01T00:00:00+08:00')
  const day = (i: number): string => new Date(BASE + i * DAY).toISOString().slice(0, 10)
  assert.equal(dates[0], day(0), `首根必须是最早那组的第一根（实际 ${dates[0]}）`)
  assert.equal(dates[dates.length - 1], day(700), `末根必须是最晚那组的最后一根（实际 ${dates[dates.length - 1]}）—— 后写者覆盖前者会丢掉另一端`)
  assert.equal(dates.length, 701, `并集必须是 400 + 401 − 重叠 101 = 701 根（实际 ${dates.length}）`)
  assert.equal(new Set(dates).size, dates.length, '不得有重复日期（mergeBars 按日期合并）')
})

test('② K 线缓存裁剪：两进程同时裁剪 ⇒ 收敛到配额内、非缓存条目不被删、0 个 .tmp、删除数之和正确', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tw-kline-prune-'))
  assertIsolated(dir)
  const klines = join(dir, 'dsh-tradewatcher', 'klines')
  mkdirSync(klines, { recursive: true })
  // 配额 300：塞 320 个缓存文件；另外放两个"非缓存条目"哨兵（**mtime 最旧** ⇒ 不过滤时它们会被当最早的候选删掉）
  const OLD = new Date(Date.now() - 10 * DAY)
  for (let i = 0; i < 320; i += 1) {
    // ⚠ 名字必须与子进程真正要写的 secid 不同（`1.600036` / `1.600519` 都在 600000+i 的区间里）
    const f = join(klines, `dummy-${String(i).padStart(4, '0')}_101_1.json`)
    writeFileSync(f, JSON.stringify({ v: 3, secid: `dummy-${i}`, klt: 101, fqt: 1, updatedAt: Date.now(), partial: false, bars: [] }))
    // 让它们都比哨兵新：先写文件，再把 mtime 设成"最近 9 天内的不同时刻"
    utimesSync(f, OLD, new Date(Date.now() - (9 * DAY) + i * 1000))
  }
  const sentinelDot = join(klines, '.keepme') // 点文件（`.klines.lock` 同属这一类）
  const sentinelTxt = join(klines, 'keepme.txt') // 非 .json
  writeFileSync(sentinelDot, 'sentinel')
  writeFileSync(sentinelTxt, 'sentinel')
  utimesSync(sentinelDot, OLD, OLD)
  utimesSync(sentinelTxt, OLD, OLD)

  const startAt = Date.now() + 800
  const [a, b] = await Promise.all([
    spawnChild(['prune', dir, '1.600519', String(startAt)]),
    spawnChild(['prune', dir, '1.600036', String(startAt)]),
  ])
  const jsonFiles = readdirSync(klines).filter((n) => n.endsWith('.json'))
  const tmpFiles = readdirSync(klines).filter((n) => n.endsWith('.tmp'))
  const lockFiles = readdirSync(klines).filter((n) => n.endsWith('.lock'))
  // 两个子进程各自落了一次盘（各 +1 个 .json）⇒ 创建数 = 322，配额 300 ⇒ 删除总数必须是 22
  const deleted = [...`${a.stdout}\n${b.stdout}`.matchAll(/清理 (\d+) 个/g)].reduce((sum, m) => sum + Number(m[1]), 0)
  assert.ok(jsonFiles.length <= 300, `文件数必须收敛到配额内（≤300，实际 ${jsonFiles.length}）`)
  assert.ok(readdirSync(klines).includes('.keepme'), '点文件（.klines.lock 同属这一类）不得被裁剪删掉')
  assert.ok(readdirSync(klines).includes('keepme.txt'), '非 .json 文件不得被裁剪删掉')
  assert.equal(tmpFiles.length, 0, `目录里不得残留 .tmp（原子写的半成品），实际 ${JSON.stringify(tmpFiles)}`)
  assert.equal(lockFiles.length, 0, `锁都必须被正常释放（不得残留 .lock），实际 ${JSON.stringify(lockFiles)}`)
  assert.equal(deleted, 22, `两次裁剪的删除总数必须等于"创建数 322 − 配额 300"= 22（证明两次裁剪串行、第二次看到的是第一次的结果）；实际 ${deleted}（${a.stdout.split('\n').filter((l) => l.includes('清理')).join(' | ')} / ${b.stdout.split('\n').filter((l) => l.includes('清理')).join(' | ')}）`)
})
