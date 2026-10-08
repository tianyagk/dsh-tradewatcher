/** Same-origin JSON calls to the /tradewatcher/* host routes. */
import type {
  BoardRow,
  FqMode,
  KlineData,
  MutatePortBody,
  MutateWatchBody,
  PortPrefs,
  PortfolioView,
  QuoteRow,
  RescueDaySummary,
  RescueIntradayPoint,
  RescueSignalEvent,
  RescueSnapshot,
  QuoteSource,
  StockDetail,
  SuggestItem,
  TrendData,
  WatchData,
  LedgerView,
  TradeMark,
  CalEvent,
} from '../shared/model.ts'

export class ApiError extends Error {
  status: number
  constructor(message: string, status: number) {
    super(message)
    this.status = status
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response
  try {
    res = await fetch(path, {
      ...init,
      headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
      cache: 'no-store',
    })
  } catch (error) {
    throw new ApiError(`网络错误: ${error instanceof Error ? error.message : String(error)}`, 0)
  }
  let payload: { error?: string } & T
  try {
    payload = (await res.json()) as { error?: string } & T
  } catch {
    throw new ApiError(`响应解析失败 (HTTP ${res.status})`, res.status)
  }
  if (!res.ok || payload.error !== undefined) {
    throw new ApiError(payload.error ?? `HTTP ${res.status}`, res.status)
  }
  return payload
}

export const api = {
  /** 导出备份（P0-9）：GET /tradewatcher/backup */
  exportBackup(): Promise<{ ok: boolean; bundle: unknown; unreadable: string[] }> {
    return request('/tradewatcher/backup')
  },
  /** 导入备份（P0-9）：mode=preview 只校验，apply 才覆盖（覆盖前宿主写 .bak） */
  importBackup(mode: 'preview' | 'apply', bundle: unknown): Promise<{
    ok: boolean
    mode: string
    errors: string[]
    summary: Record<string, unknown>
    conflicts: string[]
    backedUp?: string[]
  }> {
    return request('/tradewatcher/backup', { method: 'POST', body: JSON.stringify({ mode, bundle }) })
  },
  /** 涨跌家数 + 历史分位（P1-8） */
  breadth(): Promise<{
    current: { up: number; down: number; even: number; amount: number; ratio: number | null; asOf: number | null; source: string } | null
    percentile: { metric: string; value: number | null; n: number; pct: number | null; sampleSmall: boolean; samples: number[] }
    window: number
    minDays: number
    storedDays: number
    storedThisCall: boolean
    missing: Array<{ what: string; why: string; note: string }>
  }> {
    return request('/tradewatcher/breadth')
  },
  /** 自选异动（P1-4）：放量/异动判定，含"为什么不判定"的原因 */
  anomaly(secids: string[]): Promise<{
    rows: Array<{
      secid: string
      name: string
      kind: 'volume' | 'price' | 'both' | null
      mult: number | null
      samples: number
      pct: number | null
      reasons: string[]
      skip: string[]
    }>
    asOf: number
    missing: Array<{ what: string; why: 'no-source' | 'transient'; note: string }>
    source?: string
    stale?: boolean
  }> {
    const ids = [...new Set(secids)].join(',')
    if (ids === '') return Promise.resolve({ rows: [], asOf: Date.now(), missing: [] })
    return request(`/tradewatcher/anomaly?ids=${encodeURIComponent(ids)}`)
  },
  /** 侧栏徽标（P0-3）：与面板顶部同源的汇总数，不触发新采样 */
  badge(): Promise<{
    level: number
    levelLabel: string | null
    dayPnl: number
    dayPnlPct: number | null
    indexPoint: number | null
    indexPct: number | null
    indexName: string | null
    /** 非采样时段且原因是已收盘/周末 → 加后缀「收」 */
    settled: boolean
    asOf: number | null
    source: string
    missingCount: number
  }> {
    return request('/tradewatcher/badge')
  },
  quotes(secids: string[]): Promise<{
    /** 响应生成时刻（用于触发下游刷新），**不是**数据时刻 */
    ts: number
    items: Record<string, QuoteRow>
    /** 最新一次真实观测到行情的时间（epoch ms）；无有效行为 null */
    asOf: number | null
    /** 至少一行是兜底值/已过期（界面必须如实报警，而不是显示"刚刚更新"） */
    stale: boolean
    staleCount: number
    priced: number
    rows: number
    sources: Record<string, number>
    /** 请求了但没有任何源给出价格的标的（原样大小写）→ 界面显示"暂无可用行情源" */
    missing: string[]
    /** 请求的标的数（含重复与超限项） */
    requested: number
    /** 是否因超过 160 项上限被截断 */
    truncated: boolean
    /** 休市定稿（非交易时段 + 无兜底行 + 有价）：卡片显示"定稿复用"灰点，未开盘不得显示绿色 */
    cached: boolean
  }> {
    const ids = [...new Set(secids)].join(',')
    if (ids === '') {
      return Promise.resolve({ ts: Date.now(), items: {}, asOf: null, stale: false, staleCount: 0, priced: 0, rows: 0, sources: {}, missing: [], requested: 0, truncated: false, cached: false })
    }
    return request(`/tradewatcher/quotes?ids=${encodeURIComponent(ids)}`)
  },
  trend(secid: string, ndays = 1): Promise<{ trend: TrendData | null }> {
    return request(`/tradewatcher/trend?secid=${encodeURIComponent(secid)}&ndays=${ndays}`)
  },
  /** fqt：0=不复权 1=前复权（默认）2=后复权；实际生效口径见回包 kline.fqt */
  kline(secid: string, klt: 101 | 102 | 103 | 104 = 101, lmt = 120, fqt: FqMode = 1): Promise<{ kline: KlineData | null }> {
    return request(`/tradewatcher/kline?secid=${encodeURIComponent(secid)}&klt=${klt}&lmt=${lmt}&fqt=${fqt}`)
  },
  calendar(from: string, to: string, force = false): Promise<{ events: CalEvent[]; syncedAt: number; symbolCount: number }> {
    return request(`/tradewatcher/calendar?from=${from}&to=${to}${force ? '&force=1' : ''}`)
  },
  mutateCalendar(body: Record<string, unknown>): Promise<{ ok: boolean; events: CalEvent[]; syncedAt: number }> {
    return request('/tradewatcher/calendar', { method: 'POST', body: JSON.stringify(body) })
  },
  trades(secid: string): Promise<{ trades: TradeMark[] }> {
    return request(`/tradewatcher/trades?secid=${encodeURIComponent(secid)}`)
  },
  industry(secid: string): Promise<{ industry: { name: string; pct: number | null } | null }> {
    return request(`/tradewatcher/industry?secid=${encodeURIComponent(secid)}`)
  },
  industries(secids: string[]): Promise<{ map: Record<string, { name: string; pct: number | null }> }> {
    const ids = [...new Set(secids)].join(',')
    if (ids === '') return Promise.resolve({ map: {} })
    return request(`/tradewatcher/industries?secids=${encodeURIComponent(ids)}`)
  },
  detail(secid: string): Promise<{ detail: StockDetail | null }> {
    return request(`/tradewatcher/detail?secid=${encodeURIComponent(secid)}`)
  },
  suggest(q: string): Promise<{ hits: SuggestItem[] }> {
    return request(`/tradewatcher/suggest?q=${encodeURIComponent(q)}`)
  },
  board(scope: 'industry' | 'concept' | 'etf', sort: 'pct' | 'money' | 'amount', pn = 1): Promise<{
    total: number
    rows: BoardRow[]
    /** 上游不可用时回落上次成功结果 */
    stale?: boolean
    asOf?: number
    source?: QuoteSource
  }> {
    return request(`/tradewatcher/board?scope=${scope}&sort=${sort}&pn=${pn}&pz=40`)
  },
  rescue(force = false): Promise<{
    snapshot: RescueSnapshot
    history: RescueDaySummary[]
    calibration?: unknown
    breaker?: {
      open: boolean
      allOpen: boolean
      openHosts: number
      hosts: number
      minutesLeft: number
      allMinutesLeft: number
      lastError: string | null
      detail: Array<{ host: string; open: boolean; minutesLeft: number; trips: number; fails: number; lastError: string | null }>
    }
  }> {
    return request(`/tradewatcher/rescue${force ? '?force=1' : ''}`)
  },
  rescueDay(day: string): Promise<{ snapshot: RescueSnapshot; dayEvents: RescueSignalEvent[]; dayIntraday: RescueIntradayPoint[] }> {
    return request(`/tradewatcher/rescue?day=${encodeURIComponent(day)}`)
  },
  watch(): Promise<{ watch: WatchData }> {
    return request('/tradewatcher/watch')
  },
  mutateWatch(body: MutateWatchBody): Promise<{ watch: WatchData }> {
    return request('/tradewatcher/watch', { method: 'POST', body: JSON.stringify(body) })
  },
  portfolio(): Promise<{ view: PortfolioView; stale: number }> {
    return request('/tradewatcher/portfolio')
  },
  mutatePortfolio(body: MutatePortBody): Promise<{ view: PortfolioView; stale: number }> {
    return request('/tradewatcher/portfolio', { method: 'POST', body: JSON.stringify(body) })
  },
  ledger(groupId?: string, posId?: string, limit = 300): Promise<{ entries: LedgerView[] }> {
    const p = new URLSearchParams()
    if (groupId !== undefined) p.set('groupId', groupId)
    if (posId !== undefined) p.set('posId', posId)
    p.set('limit', String(limit))
    return request(`/tradewatcher/ledger?${p.toString()}`)
  },
  prefs(): Promise<{ prefs: PortPrefs }> {
    return request('/tradewatcher/prefs')
  },
  setPrefs(patch: Partial<PortPrefs>): Promise<{ prefs: PortPrefs }> {
    return request('/tradewatcher/prefs', { method: 'POST', body: JSON.stringify({ patch }) })
  },
}
