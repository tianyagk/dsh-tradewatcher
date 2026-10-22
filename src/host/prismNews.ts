/**
 * 金十快讯（批次 2 的唯一新闻源）。
 *
 * 接口：`GET https://flash-api.jin10.com/get_flash_list?channel=-8200&vip=1&max_time=<YYYY-MM-DD HH:MM:SS>`
 * **必须带** `x-app-id: bVBF4FyRTn5NJF5n` + `x-version: 1.0.0`（裸调实测 502）。
 *
 * 回填纪律（用户裁决）：首次回填 **24 小时**；每批 **≤10 页**、页间 **≥3 秒**；
 * 未完成标「回填中（已 N 页）」；之后用 `lastSeenId` 增量。落 `prism-news.json`（保留 24h）。
 */
import {
  PRISM_NEWS_GAP_MS,
  PRISM_NEWS_KEEP_MS,
  PRISM_NEWS_PAGE_MAX,
  type PrismNewsItem,
  type PrismNewsStatus,
} from '../shared/prism.ts'
import { parseMarketStamp } from './time.ts'
import { withHostBreaker } from './breakerFetch.ts'
import type { PrismStore } from './prismStore.ts'

const JIN10_URL = 'https://flash-api.jin10.com/get_flash_list?channel=-8200&vip=1'
const JIN10_HEADERS: Record<string, string> = {
  'x-app-id': 'bVBF4FyRTn5NJF5n',
  'x-version': '1.0.0',
  referer: 'https://www.jin10.com/',
}

export interface Jin10Page {
  items: PrismNewsItem[]
  /** 本页最旧一条的时间（下一页游标） */
  oldest: string | null
}

export interface PrismNewsDeps {
  fetchPage?: (maxTime: string | undefined) => Promise<Jin10Page>
  sleep?: (ms: number) => Promise<void>
  now?: () => number
}

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms).unref?.())

/** 拉一页（20–21 条）；网络/解析失败抛错（调用方决定是否留痕） */
export async function fetchJin10Page(maxTime: string | undefined): Promise<Jin10Page> {
  const url = maxTime === undefined ? JIN10_URL : `${JIN10_URL}&max_time=${encodeURIComponent(maxTime)}`
  const res = await withHostBreaker('flash-api.jin10.com', () =>
    fetch(url, {
      headers: { 'user-agent': 'Mozilla/5.0', ...JIN10_HEADERS },
      signal: AbortSignal.timeout(12_000),
    }),
  )
  if (!res.ok) throw new Error(`HTTP ${res.status} from jin10`)
  const json = (await res.json()) as { status?: number; data?: unknown }
  if (json.status !== 200 || !Array.isArray(json.data)) throw new Error('金十回包格式不符（status/data）')
  const items: PrismNewsItem[] = []
  let oldest: string | null = null
  for (const raw of json.data as Array<Record<string, unknown>>) {
    const id = typeof raw['id'] === 'string' ? raw.id : ''
    const time = typeof raw['time'] === 'string' ? raw.time : ''
    const data = raw['data'] as Record<string, unknown> | undefined
    const content = data !== undefined && typeof data['content'] === 'string' ? data['content'] : ''
    const title = data !== undefined && typeof data['title'] === 'string' ? data['title'] : ''
    const text = (title !== '' ? title : content).trim().slice(0, 500)
    if (id === '' || time === '' || text === '') continue
    items.push({ id, time, text, important: raw['important'] === 1 || raw['important'] === true })
    if (oldest === null || time < oldest) oldest = time
  }
  return { items, oldest }
}

const cutoffOf = (now: number): number => now - PRISM_NEWS_KEEP_MS

const statusOf = (base: PrismNewsStatus, items: PrismNewsItem[]): PrismNewsStatus => ({
  ...base,
  items: items.length,
})

/**
 * 首次回填：从最新往前翻，最多 10 页、页间 3 秒；翻到 24h 边界或没有更多即完成。
 * 未完成 ⇒ `state:'backfilling'` + 页数（下次调用继续）。
 */
export async function backfillNews(store: PrismStore, deps: PrismNewsDeps = {}): Promise<PrismNewsStatus> {
  const fetchPage = deps.fetchPage ?? fetchJin10Page
  const sleep = deps.sleep ?? defaultSleep
  const now = deps.now ?? Date.now
  const cutoff = cutoffOf(now())
  const collected: PrismNewsItem[] = []
  let cursor: string | undefined
  let pages = 0
  let done = false
  try {
    while (pages < PRISM_NEWS_PAGE_MAX) {
      if (pages > 0) await sleep(PRISM_NEWS_GAP_MS)
      const page = await fetchPage(cursor)
      pages += 1
      if (page.items.length === 0) {
        done = true
        break
      }
      collected.push(...page.items)
      const oldestTs = page.oldest === null ? null : parseMarketStamp(page.oldest)
      if (oldestTs === null || oldestTs < cutoff) {
        done = true
        break
      }
      cursor = page.oldest ?? undefined
    }
    if (pages >= PRISM_NEWS_PAGE_MAX) done = false
  } catch (error) {
    const status = statusOf(
      { state: 'error', pages, lastSeenId: null, fetchedAt: now(), reason: `金十取数失败（${String(error).slice(0, 80)}）`, items: 0 },
      [],
    )
    await store.saveNews([], status)
    return status
  }
  const kept = collected.filter((it) => {
    const ts = parseMarketStamp(it.time)
    return Number.isFinite(ts) && ts >= cutoff
  })
  const newest = kept.slice().sort((a, b) => (a.time < b.time ? 1 : -1))[0] ?? null
  const status: PrismNewsStatus = {
    state: done ? 'ready' : 'backfilling',
    pages,
    lastSeenId: newest?.id ?? null,
    fetchedAt: now(),
    reason: done ? null : `回填中（已 ${pages} 页）`,
    items: kept.length,
  }
  await store.saveNews(kept, status)
  return status
}

/** 增量：只翻第一页（必要时第二页）到 `lastSeenId` 为止；失败留痕不重试 */
export async function incrementalNews(store: PrismStore, deps: PrismNewsDeps = {}): Promise<PrismNewsStatus> {
  const fetchPage = deps.fetchPage ?? fetchJin10Page
  const now = deps.now ?? Date.now
  const before = store.news()
  const seen = before.status.lastSeenId
  const collected: PrismNewsItem[] = []
  try {
    let cursor: string | undefined
    for (let pageNo = 0; pageNo < 2; pageNo += 1) {
      const page = await fetchPage(cursor)
      if (page.items.length === 0) break
      let hit = false
      for (const it of page.items) {
        if (seen !== null && it.id === seen) {
          hit = true
          break
        }
        collected.push(it)
      }
      if (hit) break
      cursor = page.oldest ?? undefined
    }
  } catch (error) {
    const status = statusOf(
      { ...before.status, state: 'error', reason: `金十增量失败（${String(error).slice(0, 80)}）`, fetchedAt: now() },
      before.items,
    )
    await store.saveNews([], status)
    return status
  }
  const newest = collected.slice().sort((a, b) => (a.time < b.time ? 1 : -1))[0] ?? null
  const status = statusOf(
    {
      ...before.status,
      state: 'ready',
      reason: null,
      lastSeenId: newest?.id ?? seen,
      fetchedAt: now(),
    },
    collected,
  )
  await store.saveNews(collected, status)
  return status
}
