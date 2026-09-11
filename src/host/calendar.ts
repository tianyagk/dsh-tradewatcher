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
/** 东财财经日历（H5 数据中心，国际/国内宏观数据公布 + 会议事件） */
const EMCAL_HOST = 'emdatah5.eastmoney.com'

/** 宏观日历覆盖窗口：过去 7 天 ~ 未来 92 天 */
const MACRO_PAST = 7
const MACRO_FUTURE = 92
const MACRO_PAGE_CAP = 26
const MACRO_PAGE_SIZE = 50
const MACRO_CONCURRENCY = 4

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

/** ── 东财财经日历（宏观）───────────────────────────────────────────────
 * 接口：https://emdatah5.eastmoney.com/dc/CJRL/GetIndexData
 *   参数 startDate/endDate（YYYY-MM-DD）、type、pIndex、pSize（服务端固定上限 50）
 *   返回 [{ Data: [{ STARTDATE, ENDDATE, FINCODE, FINNAME, TDATE, TOTALCOUNT }] }]
 * FINNAME 形如「美国:非农就业人数:季调(报告期:2026年08月)」「美联储议息会议」，
 * STARTDATE 为北京时间公布时刻。无 actual/forecast/previous 字段。
 */
interface EmCalRow {
  STARTDATE?: string
  ENDDATE?: string
  FINCODE?: string | number
  FINNAME?: string
}

/** 核心经济体归一化（其余经济体不入库，避免日历被小众数据淹没） */
const EM_ECONOMY: Record<string, string> = {
  美国: '美国',
  中国: '中国',
  中国香港: '中国香港',
  中国台湾: '中国台湾',
  中国澳门: '中国澳门',
  欧元区: '欧元区',
  欧盟: '欧盟',
  日本: '日本',
  英国: '英国',
  德国: '德国',
  法国: '法国',
  意大利: '意大利',
  加拿大: '加拿大',
  澳大利亚: '澳大利亚',
  瑞士: '瑞士',
  韩国: '韩国',
  印度: '印度',
  俄罗斯: '俄罗斯',
  巴西: '巴西',
  新加坡: '新加坡',
}

export function canonicalEconomy(key: string): string | null {
  if (EM_ECONOMY[key] !== undefined) return EM_ECONOMY[key]
  // 「美国EIA原油库存」「欧元区19国」「欧盟27国」等带后缀的写法归一
  if (key.startsWith('美国')) return '美国'
  if (key.startsWith('欧元区')) return '欧元区'
  if (key.startsWith('欧盟')) return '欧盟'
  if (key.startsWith('中国')) return '中国'
  return null
}

const MACRO_CN_ECONOMIES = new Set(['中国', '中国香港', '中国台湾', '中国澳门'])

const RE_MACRO_INTL = /(美联储|美国|欧央行|欧洲央行|欧元区|欧盟|日本央行|英国央行|鲍威尔|FOMC)/
const RE_MACRO_CN = /(中国|国务院|发改委|财政部|统计局|人民银行|央行|证监会|中央经济工作会议|两会|政治局|上交所|深交所|北交所)/

const RE_IMP3 = /(议息|利率决议|联邦基金利率|贷款市场报价利率|LPR|非农|CPI|消费者物价|PCE|GDP|国内生产总值|中央经济工作会议|两会|政治局|关税|加息|降息|上市首日)/
const RE_IMP2 = /(PPI|生产者价格|PMI|采购经理|零售|工业增加值|社会融资|M2|货币供应|新增人民币贷款|进出口|贸易帐|失业率|失业金|ADP|消费者信心|成屋|新屋|工业订单|库存|外汇储备|工业产出|通胀|价格指数|出口金额|进口金额|制造业)/

/** 重要性启发式：先命中高优先关键词，再中，最后低 */
export function macroImportance(text: string): CalImportance {
  // 「中国：库存:铁矿石:46港」这类高频库存分项降级
  if (/库存/.test(text) && /(48港|46港|45港|港口|保税区)/.test(text)) return 1
  if (RE_IMP3.test(text)) return 3
  if (RE_IMP2.test(text)) return 2
  return 1
}

export function macroCategory(economy: string | null, raw: string): CalCategory {
  if (economy !== null) return MACRO_CN_ECONOMIES.has(economy) ? 'macro-cn' : 'macro-intl'
  if (RE_MACRO_INTL.test(raw)) return 'macro-intl'
  if (RE_MACRO_CN.test(raw)) return 'macro-cn'
  return 'other'
}

/** 「2026/9/17 2:00:00」→ { date:'2026-09-17', time:'02:00', endDate? }；00:00 视为未定时刻 */
export function parseEmDate(start: unknown, end: unknown): { date: string; time?: string; endDate?: string } | null {
  const m = /^(\d{4})\/(\d{1,2})\/(\d{1,2})(?:\s+(\d{1,2}):(\d{2}))?/.exec(String(start ?? '').trim())
  if (m === null) return null
  const p = (n: number): string => String(n).padStart(2, '0')
  const date = `${m[1]}-${p(Number(m[2]))}-${p(Number(m[3]))}`
  const hh = m[4] === undefined ? 0 : Number(m[4])
  const mm = m[5] === undefined ? 0 : Number(m[5])
  const time = hh === 0 && mm === 0 ? undefined : `${p(hh)}:${p(mm)}`
  const e = /^(\d{4})\/(\d{1,2})\/(\d{1,2})/.exec(String(end ?? '').trim())
  const endDate = e === null ? undefined : `${e[1]}-${p(Number(e[2]))}-${p(Number(e[3]))}`
  return { date, time, endDate: endDate !== undefined && endDate > date ? endDate : undefined }
}

/** 把东财财经日历原始行转成日历事件（纯函数，便于自检） */
export function macroEventsFromEm(rows: EmCalRow[]): Array<Omit<CalEvent, 'id' | 'source'>> {
  const out = new Map<string, Omit<CalEvent, 'id' | 'source'>>()
  for (const row of rows) {
    const name = String(row.FINNAME ?? '').trim()
    if (name === '') continue
    const when = parseEmDate(row.STARTDATE, row.ENDDATE)
    if (when === null) continue
    let economy: string | null = null
    let body = name
    const prefix = /^([^:：]{1,14})[:：]\s*(.+)$/.exec(name)
    if (prefix !== null) {
      economy = canonicalEconomy(prefix[1])
      if (economy === null) continue // 非核心经济体：跳过
      body = prefix[2].trim()
    }
    const periodMatch = /\(报告期[:：]?\s*([^)]*)\)/.exec(body)
    const period = periodMatch === null ? '' : periodMatch[1].trim()
    body = body.replace(/\(报告期[:：]?[^)]*\)/g, '').replace(/\s{2,}/g, ' ').trim()
    if (body === '') continue
    const title = economy === null ? body : `${economy} ${body}`
    const code = String(row.FINCODE ?? '')
    const stamp = `${when.date.replace(/-/g, '')}${(when.time ?? '0000').replace(':', '')}`
    const autoKey = `macro:${code !== '' ? code : title}:${stamp}`
    if (out.has(autoKey)) continue
    out.set(autoKey, {
      date: when.date,
      endDate: when.endDate,
      time: when.time,
      title: title.slice(0, 80),
      category: macroCategory(economy, name),
      importance: macroImportance(name),
      autoKey,
      note: [period === '' ? '' : `报告期 ${period}`, '东方财富财经日历'].filter(Boolean).join(' · '),
    })
  }
  return [...out.values()]
}

/** 分页抓取东财财经日历（服务端 pSize 上限 50，按 TOTALCOUNT 决定页数）
 * 整体 20s 预算：超时后放弃剩余页，已有数据照常入库，避免单源拖慢日历请求。 */
async function fetchEconomicCalendar(start: string, end: string): Promise<EmCalRow[]> {
  const deadline = Date.now() + 20_000
  const page = async (pIndex: number): Promise<EmCalRow[]> => {
    const budget = deadline - Date.now()
    if (budget <= 0) return []
    const q = new URLSearchParams({
      startDate: start, endDate: end, type: 'economics', pIndex: String(pIndex), pSize: String(MACRO_PAGE_SIZE),
    })
    const res = await fetch(`https://${EMCAL_HOST}/dc/CJRL/GetIndexData?${q.toString()}`, {
      headers: { 'user-agent': UA, referer: `https://${EMCAL_HOST}/dc/cjrl/index` },
      signal: AbortSignal.timeout(Math.min(8000, budget)),
    })
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${EMCAL_HOST}`)
    const text = await res.text()
    const groups = JSON.parse(text) as Array<{ Data?: EmCalRow[] }>
    const rows = Array.isArray(groups) ? groups[0]?.Data : undefined
    return Array.isArray(rows) ? rows : []
  }
  const first = await page(1)
  if (first.length === 0) return []
  const total = Number((first[0] as { TOTALCOUNT?: string | number }).TOTALCOUNT ?? first.length)
  const pages = Math.min(MACRO_PAGE_CAP, Math.max(1, Math.ceil(total / MACRO_PAGE_SIZE)))
  const rest = Array.from({ length: pages - 1 }, (_, i) => i + 2)
  const out: EmCalRow[] = [...first]
  for (let i = 0; i < rest.length; i += MACRO_CONCURRENCY) {
    const batch = rest.slice(i, i + MACRO_CONCURRENCY)
    const got = await Promise.all(batch.map((p) => page(p).catch((): EmCalRow[] => [])))
    for (const rows of got) out.push(...rows)
  }
  return out
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
      .sort((a, b) => {
        if (a.date !== b.date) return a.date < b.date ? -1 : 1
        if (a.importance !== b.importance) return b.importance - a.importance
        return (a.time ?? '99:99').localeCompare(b.time ?? '99:99')
      })
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
      // 4) 国际 / 国内宏观数据公布与会议事件（东财财经日历）
      try {
        const rows = await fetchEconomicCalendar(todayStr(-MACRO_PAST), todayStr(MACRO_FUTURE))
        for (const e of macroEventsFromEm(rows)) push(e)
      } catch {
        /* 单个数据源失败不影响其它 */
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
