/**
 * 财经日历：本地事件库 + 自动同步。
 *
 * 手动事件（宏观、未上市公司 IPO 传闻、自定义提醒）由 UI / 会话工具维护；
 * 自动事件来自东方财富数据中心（新股申购/上市、持仓与自选标的的财报预约披露、
 * 分红除权除息），按稳定 autoKey 去重，可单独隐藏。
 *
 * 数据文件：<dataHome>/calendar.json
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { CalCategory, CalEvent, CalImportance } from '../shared/model.ts'
import { dataHome } from './store.ts'

const AUTO_SYNC_TTL = 6 * 3600_000
const KEEP_PAST_DAYS = 60

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
const DC_HOST = 'datacenter-web.eastmoney.com'

interface CalFile {
  v: number
  events: CalEvent[]
  hiddenAutoKeys: string[]
  syncedAt: number
}

/** 供路由使用：今天的 YYYY-MM-DD（可偏移天数） */
export function calToday(offsetDays = 0): string {
  return todayStr(offsetDays)
}

function todayStr(offsetDays = 0): string {
  const d = new Date(Date.now() + offsetDays * 86_400_000)
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

function dayOf(v: unknown): string | null {
  if (typeof v !== 'string' || v.length < 10) return null
  const s = v.slice(0, 10)
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null
}

async function fetchReport(reportName: string, params: Record<string, string>): Promise<Array<Record<string, unknown>>> {
  const q = new URLSearchParams({ reportName, columns: 'ALL', source: 'WEB', client: 'WEB', ...params })
  const url = `https://${DC_HOST}/api/data/v1/get?${q.toString()}`
  const res = await fetch(url, {
    headers: { 'user-agent': UA, referer: 'https://data.eastmoney.com/' },
    signal: AbortSignal.timeout(12_000),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${DC_HOST}`)
  const json = (await res.json()) as { result?: { data?: Array<Record<string, unknown>> } }
  const rows = json?.result?.data
  return Array.isArray(rows) ? rows : []
}

export class CalendarStore {
  private dir: string
  private file: CalFile = { v: 1, events: [], hiddenAutoKeys: [], syncedAt: 0 }
  private loaded: Promise<void> | null = null
  private writeChain: Promise<void> = Promise.resolve()
  private syncing: Promise<void> | null = null
  private seq = 0

  constructor(dir: string = dataHome()) {
    this.dir = dir
  }

  private path(): string {
    return join(this.dir, 'calendar.json')
  }

  async init(): Promise<void> {
    if (this.loaded !== null) return this.loaded
    this.loaded = (async () => {
      await mkdir(this.dir, { recursive: true }).catch(() => undefined)
      try {
        const raw = await readFile(this.path(), 'utf8')
        const parsed = JSON.parse(raw) as Partial<CalFile>
        this.file = {
          v: 1,
          events: Array.isArray(parsed.events) ? parsed.events : [],
          hiddenAutoKeys: Array.isArray(parsed.hiddenAutoKeys) ? parsed.hiddenAutoKeys : [],
          syncedAt: typeof parsed.syncedAt === 'number' ? parsed.syncedAt : 0,
        }
      } catch {
        /* 首次：空库 */
      }
    })()
    return this.loaded
  }

  private persist(): Promise<void> {
    const run = this.writeChain.then(async () => {
      const tmp = `${this.path()}.tmp`
      await mkdir(this.dir, { recursive: true }).catch(() => undefined)
      await writeFile(tmp, JSON.stringify(this.file, null, 1), 'utf8')
      await writeFile(this.path(), JSON.stringify(this.file, null, 1), 'utf8')
      void tmp
    })
    this.writeChain = run.catch(() => undefined)
    return run
  }

  private newId(): string {
    this.seq += 1
    return `ce${Date.now().toString(36)}${this.seq.toString(36)}`
  }

  /** 可见事件（隐藏的自动事件被过滤） */
  list(from: string, to: string): CalEvent[] {
    const hidden = new Set(this.file.hiddenAutoKeys)
    return this.file.events
      .filter((e) => {
        if (e.source === 'auto' && e.autoKey !== undefined && hidden.has(e.autoKey)) return false
        const start = e.date
        const end = e.endDate ?? e.date
        return start <= to && end >= from
      })
      .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : b.importance - a.importance))
  }

  get syncedAt(): number {
    return this.file.syncedAt
  }

  /** 手动事件 CRUD（自动事件只允许隐藏/恢复） */
  async mutate(body: Record<string, unknown>): Promise<CalEvent[]> {
    await this.init()
    const op = String(body.op ?? '')
    if (op === 'add' || op === 'update') {
      const date = String(body.date ?? '')
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('日期格式应为 YYYY-MM-DD')
      const title = String(body.title ?? '').trim()
      if (title === '' || title.length > 80) throw new Error('事件标题必填且 ≤ 80 字')
      const category = String(body.category ?? 'other') as CalCategory
      const importanceRaw = Number(body.importance ?? 2)
      const importance = (importanceRaw === 1 || importanceRaw === 2 || importanceRaw === 3 ? importanceRaw : 2) as CalImportance
      const note = body.note === undefined || body.note === null ? undefined : String(body.note).slice(0, 500)
      const symbol = body.symbol === undefined || body.symbol === null || body.symbol === '' ? undefined : String(body.symbol).slice(0, 24)
      const endDate = /^\d{4}-\d{2}-\d{2}$/.test(String(body.endDate ?? '')) ? String(body.endDate) : undefined
      if (op === 'add') {
        this.file.events.push({ id: this.newId(), date, endDate, title, category, importance, note, symbol, source: 'manual' })
      } else {
        const id = String(body.id ?? '')
        const hit = this.file.events.find((e) => e.id === id)
        if (hit === undefined) throw new Error('事件不存在')
        if (hit.source === 'auto') throw new Error('自动事件不可编辑，只能隐藏')
        Object.assign(hit, { date, endDate, title, category, importance, note, symbol })
      }
    } else if (op === 'remove') {
      const id = String(body.id ?? '')
      const idx = this.file.events.findIndex((e) => e.id === id)
      if (idx === -1) throw new Error('事件不存在')
      if (this.file.events[idx].source === 'auto') throw new Error('自动事件不可删除，只能隐藏')
      this.file.events.splice(idx, 1)
    } else if (op === 'hideAuto' || op === 'restoreAuto') {
      const key = String(body.autoKey ?? '')
      if (key === '') throw new Error('缺少 autoKey')
      const set = new Set(this.file.hiddenAutoKeys)
      if (op === 'hideAuto') set.add(key)
      else set.delete(key)
      this.file.hiddenAutoKeys = [...set]
    } else {
      throw new Error(`未知操作: ${op}`)
    }
    await this.persist()
    return this.file.events
  }

  /** 自动同步（TTL 内直接返回；并发去重）。symbols = 关注标的的 6 位代码 */
  async sync(symbols: string[], force = false): Promise<void> {
    await this.init()
    if (!force && Date.now() - this.file.syncedAt < AUTO_SYNC_TTL) return
    if (this.syncing !== null) return this.syncing
    this.syncing = (async () => {
      const auto: CalEvent[] = []
      const push = (e: Omit<CalEvent, 'id' | 'source'>): void => {
        auto.push({ ...e, id: `auto:${e.autoKey ?? Math.random()}`, source: 'auto' })
      }
      // 1) 新股申购 / 上市
      try {
        const rows = await fetchReport('RPTA_APP_IPOAPPLY', {
          pageSize: '200', pageNumber: '1', sortColumns: 'APPLY_DATE', sortTypes: '-1',
        })
        const from = todayStr(-KEEP_PAST_DAYS)
        const to = todayStr(150)
        for (const r of rows) {
          const code = String(r.SECURITY_CODE ?? '')
          const name = String(r.SECURITY_NAME_ABBR ?? r.SECURITY_NAME_FULL ?? r.SECURITY_NAME ?? code)
          const apply = dayOf(r.APPLY_DATE)
          const listing = dayOf(r.LISTING_DATE)
          const price = r.ISSUE_PRICE !== null && r.ISSUE_PRICE !== undefined && Number(r.ISSUE_PRICE) > 0 ? `发行价 ${r.ISSUE_PRICE}` : ''
          if (apply !== null && apply >= from && apply <= to) {
            push({
              date: apply, title: `${name} 申购`, category: 'ipo', importance: 1, symbol: code,
              autoKey: `ipo:${code}:apply`, note: [price, '新股网上/网下申购日'].filter(Boolean).join(' · '),
            })
          }
          if (listing !== null && listing >= from && listing <= to) {
            push({
              date: listing, title: `${name} 上市`, category: 'ipo', importance: 2, symbol: code,
              autoKey: `ipo:${code}:listing`, note: [price, '新股上市首日'].filter(Boolean).join(' · '),
            })
          }
        }
      } catch {
        /* 单个数据源失败不影响其它 */
      }
      // 2) 关注标的的财报预约披露 + 3) 分红除权
      if (symbols.length > 0) {
        const list = symbols.slice(0, 60).map((c) => `"${c}"`).join(',')
        const from = todayStr(-14)
        const to = todayStr(120)
        try {
          const rows = await fetchReport('RPT_PUBLIC_BS_APPOIN', {
            pageSize: '200', pageNumber: '1',
            filter: `(SECURITY_CODE in (${list}))`,
            sortColumns: 'APPOINT_PUBLISH_DATE', sortTypes: '-1',
          })
          for (const r of rows) {
            const code = String(r.SECURITY_CODE ?? '')
            const name = String(r.SECURITY_NAME_ABBR ?? code)
            const date = dayOf(r.APPOINT_PUBLISH_DATE) ?? dayOf(r.ACTUAL_PUBLISH_DATE)
            if (date === null || date < from || date > to) continue
            const period = String(r.REPORT_TYPE_NAME ?? '')
            const published = String(r.IS_PUBLISH ?? '') === '1'
            push({
              date, title: `${name} ${period}财报`, category: 'earnings',
              importance: published ? 1 : 2, symbol: code,
              autoKey: `earn:${code}:${String(r.REPORT_DATE ?? date).slice(0, 10)}`,
              note: published ? '已披露（实际披露日）' : '预约披露日期',
            })
          }
        } catch {
          /* ignore */
        }
        try {
          const rows = await fetchReport('RPT_SHAREBONUS_DET', {
            pageSize: '200', pageNumber: '1',
            filter: `(SECURITY_CODE in (${list}))`,
            sortColumns: 'PLAN_NOTICE_DATE', sortTypes: '-1',
          })
          for (const r of rows) {
            const code = String(r.SECURITY_CODE ?? '')
            const name = String(r.SECURITY_NAME_ABBR ?? code)
            const profile = String(r.IMPL_PLAN_PROFILE ?? '')
            const reportDate = String(r.REPORT_DATE ?? '').slice(0, 10)
            const ex = dayOf(r.EX_DIVIDEND_DATE)
            const rec = dayOf(r.EQUITY_RECORD_DATE)
            if (ex !== null) {
              push({
                date: ex, title: `${name} 除权除息`, category: 'dividend', importance: 2, symbol: code,
                autoKey: `div:${code}:ex:${reportDate || ex}`, note: profile,
              })
            }
            if (rec !== null) {
              push({
                date: rec, title: `${name} 股权登记`, category: 'dividend', importance: 1, symbol: code,
                autoKey: `div:${code}:rec:${reportDate || rec}`, note: profile,
              })
            }
          }
        } catch {
          /* ignore */
        }
      }
      // 合并：手动事件保留，自动事件按 autoKey upsert，清理过旧自动事件
      const manual = this.file.events.filter((e) => e.source === 'manual')
      const cutoff = todayStr(-KEEP_PAST_DAYS)
      const fresh = auto.filter((e) => e.date >= cutoff)
      const autoKeySet = new Set(fresh.map((e) => e.autoKey))
      const keptAuto = this.file.events.filter(
        (e) => e.source === 'auto' && e.date >= cutoff && e.autoKey !== undefined && !autoKeySet.has(e.autoKey),
      )
      this.file.events = [...manual, ...keptAuto, ...fresh]
      this.file.syncedAt = Date.now()
      await this.persist()
    })()
    try {
      await this.syncing
    } finally {
      this.syncing = null
    }
  }
}
