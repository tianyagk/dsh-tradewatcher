/**
 * 子进程：对指定的数据目录做一次"采样 +1 → persist(true)"。
 *
 * 用途：`rescuePersist.test.ts` 用它起**两个真进程**同时写同一份 `rescue-log.json`，
 * 断言 `days[今天].samples` 两次都生效（跨进程计数合并，见 docs/AUDIT-IMPL42.md §5.1）。
 *
 * 走的是**真实代码路径**：`init()` 装载 → `rollDay()` 换日（内部记 `samplesBase` 基准）
 * → `today.samples += 1`（与 `tickOnce()` 里那一行同语义）→ `persist(true)`（锁内合并写回）。
 * 不启动定时器、不打上游（`enabled: false`）。
 */
import { RescueMonitor } from './rescue.ts'

const dir = process.argv[2]
if (dir === undefined || dir === '') {
  console.error('用法: node --experimental-strip-types rescuePersist.child.ts <dataDir> [delayMs]')
  process.exit(2)
}
const delayMs = Number(process.argv[3] ?? 0)
// 钉住时钟（跨"北京自然日"边界跑测试时，父子进程可能落在不同的 day key 上 ⇒ 断言会假红）
const pinned = Number(process.env.TW_CHILD_NOW ?? 0)
if (Number.isFinite(pinned) && pinned > 0) Date.now = () => pinned

/** 私有成员在这里按运行时形状取用（测试子进程专用，不改生产可见性） */
interface Internals {
  rollDay(): void
  today: { samples: number }
}
const monitor = new RescueMonitor(dir, { enabled: false, intervalSec: 30, tailIntervalSec: 15, tailFrom: '14:30', universe: [] })
await monitor.init()
const inner = monitor as unknown as Internals
inner.rollDay()
inner.today.samples += 1
if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs))
await monitor.flush()
console.log(`child done: samples=${inner.today.samples}`)
