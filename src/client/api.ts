/** Same-origin JSON calls to the /tradewatcher/* host routes. */
import type {
  BoardRow,
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
  quotes(secids: string[]): Promise<{ ts: number; items: Record<string, QuoteRow> }> {
    const ids = [...new Set(secids)].join(',')
    if (ids === '') return Promise.resolve({ ts: Date.now(), items: {} })
    return request(`/tradewatcher/quotes?ids=${encodeURIComponent(ids)}`)
  },
  trend(secid: string, ndays = 1): Promise<{ trend: TrendData | null }> {
    return request(`/tradewatcher/trend?secid=${encodeURIComponent(secid)}&ndays=${ndays}`)
  },
  kline(secid: string, klt: 101 | 102 | 103 | 104 = 101, lmt = 120): Promise<{ kline: KlineData | null }> {
    return request(`/tradewatcher/kline?secid=${encodeURIComponent(secid)}&klt=${klt}&lmt=${lmt}`)
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
  board(scope: 'industry' | 'concept' | 'etf', sort: 'pct' | 'money' | 'amount', pn = 1): Promise<{ total: number; rows: BoardRow[] }> {
    return request(`/tradewatcher/board?scope=${scope}&sort=${sort}&pn=${pn}&pz=40`)
  },
  rescue(force = false): Promise<{ snapshot: RescueSnapshot; history: RescueDaySummary[]; calibration?: unknown }> {
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
