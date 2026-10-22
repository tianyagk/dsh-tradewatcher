/**
 * 棱镜的本地状态（批次 1+2）：调度设置 / 骨架 / 金十新闻 / 研判运行。
 *
 * 落盘（`DSH_HOME/dsh-tradewatcher/`）：
 *   · `prism-settings.json`  `{times, lastFired}`（`updateJsonLocked`；读失败走 `ReadGuard`，不覆写）
 *   · `prism-skeleton.md`    纯文本（`writeFileAtomic`；首次打开写默认骨架）
 *   · `prism-news.json`      `{status, items}`（保留 24h）
 *   · `prism-runs.json`      `{runs}`（保留最近 20 次）
 *
 * 坏文件先隔离（`.corrupt-*`）再重建；单进程只允许一个实例（由 core 内核持有）。
 */
import { mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  PRISM_DEFAULT_SKELETON,
  PRISM_DEFAULT_TIMES,
  PRISM_NEWS_KEEP_MS,
  PRISM_RUNS_KEEP,
  type PrismNewsItem,
  type PrismNewsStatus,
  type PrismRun,
  type PrismSettings,
} from '../shared/prism.ts'
import { dataHome } from './store.ts'
import { readJsonForUpdate, updateJsonLocked } from './lock.ts'
import { ReadGuard, quarantineFile } from './readGuard.ts'
import { writeFileAtomic } from './atomic.ts'

const DEFAULT_STATUS: PrismNewsStatus = { state: 'idle', pages: 0, lastSeenId: null, fetchedAt: null, reason: null, items: 0 }

const defaultSettings = (): PrismSettings => ({ times: [...PRISM_DEFAULT_TIMES], lastFired: {} })

export class PrismStore {
  private readonly dir: string
  private readonly guard = new ReadGuard()
  private settingsValue: PrismSettings = defaultSettings()
  private skeletonValue = PRISM_DEFAULT_SKELETON
  private newsStatus: PrismNewsStatus = { ...DEFAULT_STATUS }
  private newsItems: PrismNewsItem[] = []
  private runsValue: PrismRun[] = []
  private initialized = false

  constructor(dir = dataHome()) {
    this.dir = dir
  }

  private pathOf(name: string): string {
    return join(this.dir, name)
  }

  async init(): Promise<void> {
    if (this.initialized) return
    this.initialized = true
    await mkdir(this.dir, { recursive: true })
    await this.loadSettings()
    await this.loadNews()
    await this.loadRuns()
    try {
      this.skeletonValue = await readFile(this.pathOf('prism-skeleton.md'), 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.guard.markUnreadable(this.pathOf('prism-skeleton.md'), error)
      }
      // 首次打开：写默认骨架（用户可编辑）
      if (this.guard.reasonOf(this.pathOf('prism-skeleton.md')) === null) {
        await writeFileAtomic(this.pathOf('prism-skeleton.md'), PRISM_DEFAULT_SKELETON).catch(() => undefined)
      }
    }
  }

  private async loadJson<T>(name: string): Promise<T | null> {
    const file = this.pathOf(name)
    try {
      const disk = await readJsonForUpdate(file, 'null')
      this.guard.clear(file)
      if (disk === null || typeof disk !== 'object') return null
      return disk as T
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        const reason = this.guard.markUnreadable(file, error)
        console.warn(`[tradewatcher] 棱镜状态读不到（${file}）：${reason}`)
      }
      return null
    }
  }

  private async loadSettings(): Promise<void> {
    const disk = await this.loadJson<{ times?: unknown; lastFired?: unknown }>('prism-settings.json')
    if (disk === null) return
    const times = Array.isArray(disk.times) ? disk.times.filter((t): t is string => typeof t === 'string' && /^\d{2}:\d{2}$/.test(t)) : []
    const lastFired: Record<string, string[]> = {}
    if (disk.lastFired !== null && typeof disk.lastFired === 'object') {
      for (const [day, slots] of Object.entries(disk.lastFired as Record<string, unknown>)) {
        if (/^\d{4}-\d{2}-\d{2}$/.test(day) && Array.isArray(slots)) lastFired[day] = slots.filter((s): s is string => typeof s === 'string')
      }
    }
    this.settingsValue = { times: times.length > 0 ? times : [...PRISM_DEFAULT_TIMES], lastFired }
  }

  private async loadNews(): Promise<void> {
    const disk = await this.loadJson<{ status?: unknown; items?: unknown }>('prism-news.json')
    if (disk === null) return
    const items = Array.isArray(disk.items) ? disk.items.filter(isNewsItem) : []
    const cutoff = Date.now() - PRISM_NEWS_KEEP_MS
    this.newsItems = items.filter((it) => Date.parse(it.time.replace(' ', 'T') + '+08:00') >= cutoff)
    const st = disk.status as Partial<PrismNewsStatus> | undefined
    if (st !== undefined && typeof st === 'object' && typeof st.state === 'string') {
      this.newsStatus = {
        state: st.state as PrismNewsStatus['state'],
        pages: typeof st.pages === 'number' ? st.pages : 0,
        lastSeenId: typeof st.lastSeenId === 'string' ? st.lastSeenId : null,
        fetchedAt: typeof st.fetchedAt === 'number' ? st.fetchedAt : null,
        reason: typeof st.reason === 'string' ? st.reason : null,
        items: this.newsItems.length,
      }
    }
  }

  private async loadRuns(): Promise<void> {
    const disk = await this.loadJson<{ runs?: unknown }>('prism-runs.json')
    if (disk === null) return
    this.runsValue = Array.isArray(disk.runs) ? disk.runs.filter(isRun).slice(-PRISM_RUNS_KEEP) : []
  }

  settings(): PrismSettings {
    return JSON.parse(JSON.stringify(this.settingsValue)) as PrismSettings
  }

  async saveTimes(times: string[]): Promise<PrismSettings> {
    const clean = [...new Set(times.map((t) => t.trim()))].filter((t) => /^([01]\d|2[0-3]):[0-5]\d$/.test(t)).sort()
    const next: PrismSettings = { times: clean, lastFired: this.settingsValue.lastFired }
    this.settingsValue = next
    await updateJsonLocked(this.pathOf('prism-settings.json'), () => ({ v: 1, ...next })).catch((error) => {
      this.guard.markUnreadable(this.pathOf('prism-settings.json'), error)
    })
    return this.settings()
  }

  async markFired(day: string, slot: string): Promise<void> {
    const slots = new Set(this.settingsValue.lastFired[day] ?? [])
    slots.add(slot)
    this.settingsValue.lastFired = { ...this.settingsValue.lastFired, [day]: [...slots].sort() }
    // 只保留今天（避免文件无限增长）
    const keep: Record<string, string[]> = { [day]: this.settingsValue.lastFired[day] as string[] }
    this.settingsValue.lastFired = keep
    await updateJsonLocked(this.pathOf('prism-settings.json'), () => ({ v: 1, ...this.settingsValue })).catch(() => undefined)
  }

  skeleton(): string {
    return this.skeletonValue
  }

  async saveSkeleton(text: string): Promise<void> {
    this.skeletonValue = text
    await writeFileAtomic(this.pathOf('prism-skeleton.md'), text)
  }

  news(): { status: PrismNewsStatus; items: PrismNewsItem[] } {
    return { status: { ...this.newsStatus, items: this.newsItems.length }, items: this.newsItems.slice() }
  }

  async saveNews(items: PrismNewsItem[], status: PrismNewsStatus): Promise<void> {
    const cutoff = Date.now() - PRISM_NEWS_KEEP_MS
    const merged = new Map<string, PrismNewsItem>()
    for (const it of [...items, ...this.newsItems]) {
      if (!isNewsItem(it)) continue
      if (Date.parse(it.time.replace(' ', 'T') + '+08:00') < cutoff) continue
      merged.set(it.id, it)
    }
    this.newsItems = [...merged.values()].sort((a, b) => (a.time < b.time ? 1 : -1))
    this.newsStatus = { ...status, items: this.newsItems.length }
    await updateJsonLocked(this.pathOf('prism-news.json'), () => ({ v: 1, status: this.newsStatus, items: this.newsItems })).catch(() => undefined)
  }

  runs(): PrismRun[] {
    return this.runsValue.slice()
  }

  async saveRun(run: PrismRun): Promise<void> {
    this.runsValue = [...this.runsValue, run].slice(-PRISM_RUNS_KEEP)
    await updateJsonLocked(this.pathOf('prism-runs.json'), () => ({ v: 1, runs: this.runsValue })).catch(() => undefined)
  }

  async quarantine(): Promise<void> {
    for (const name of ['prism-settings.json', 'prism-news.json', 'prism-runs.json']) {
      const file = this.pathOf(name)
      try {
        JSON.parse(await readFile(file, 'utf8'))
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
        if (error instanceof SyntaxError) await quarantineFile(file)
      }
    }
  }
}

const isNewsItem = (v: unknown): v is PrismNewsItem => {
  if (v === null || typeof v !== 'object') return false
  const o = v as Record<string, unknown>
  return typeof o['id'] === 'string' && typeof o['time'] === 'string' && typeof o['text'] === 'string' && typeof o['important'] === 'boolean'
}

const isRun = (v: unknown): v is PrismRun => {
  if (v === null || typeof v !== 'object') return false
  const o = v as Record<string, unknown>
  return typeof o['slot'] === 'string' && typeof o['startedAt'] === 'number' && Array.isArray(o['analyses'])
}
