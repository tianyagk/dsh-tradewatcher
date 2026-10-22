import assert from 'node:assert/strict'
import test from 'node:test'
import { backfillNews, incrementalNews, type Jin10Page } from './prismNews.ts'
import { PrismStore } from './prismStore.ts'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseMarketStamp } from './time.ts'

const at = (label: string): number => parseMarketStamp(label) as number

const page = (times: string[]): Jin10Page => ({
  items: times.map((t, i) => ({ id: `id-${t}-${i}`, time: t, text: `快讯 ${t}`, important: false })),
  oldest: times[times.length - 1] ?? null,
})

test('⑤ 金十两个头齐备（真实请求构造）', async () => {
  const calls: Array<{ url: string; headers: Record<string, string> }> = []
  const realFetch = globalThis.fetch
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), headers: (init?.headers ?? {}) as Record<string, string> })
    return new Response(JSON.stringify({ status: 200, data: [] }), { status: 200 })
  }) as typeof fetch
  try {
    const { fetchJin10Page } = await import('./prismNews.ts')
    await fetchJin10Page('2026-10-22 15:00:00')
  } finally {
    globalThis.fetch = realFetch
  }
  assert.equal(calls.length, 1)
  assert.equal(calls[0]?.headers['x-app-id'], 'bVBF4FyRTn5NJF5n')
  assert.equal(calls[0]?.headers['x-version'], '1.0.0')
  assert.match(calls[0]?.url ?? '', /channel=-8200/)
  assert.match(calls[0]?.url ?? '', /max_time=2026-10-22/)
})

test('⑥ 回填：每批 ≤10 页、页间 ≥3s；未完成标「回填中（已 N 页）」', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'prism-news-'))
  try {
    const store = new PrismStore(dir)
    await store.init()
    const now = at('2026-10-22 15:00:00')
    const gaps: number[] = []
    let pages = 0
    const status = await backfillNews(store, {
      now: () => now,
      sleep: async (ms) => { gaps.push(ms) },
      fetchPage: async () => {
        pages += 1
        // 每页都用"刚刚"的时间，确保一直落在 24h 内且未完成
        return page([`2026-10-22 14:${String(59 - pages).padStart(2, '0')}:00`])
      },
    })
    assert.equal(pages, 10, '单批最多 10 页')
    assert.equal(status.state, 'backfilling')
    assert.equal(status.pages, 10)
    assert.match(String(status.reason), /回填中（已 10 页）/)
    assert.deepEqual(gaps, Array(9).fill(3000), '页间 3 秒（10 页 ⇒ 9 个间隔）')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('⑥ 增量：翻到 lastSeenId 即停，24h 外的新闻丢弃', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'prism-news2-'))
  try {
    const store = new PrismStore(dir)
    await store.init()
    const now = at('2026-10-22 15:00:00')
    const incPage = page(['2026-10-22 14:00:00', '2026-10-22 10:00:00'])
    const seedId = incPage.items[1]?.id as string
    await store.saveNews(
      [{ id: seedId, time: '2026-10-22 10:00:00', text: '旧', important: false }],
      { state: 'ready', pages: 1, lastSeenId: seedId, fetchedAt: now, reason: null, items: 1 },
    )
    const seen: string[] = []
    const status = await incrementalNews(store, {
      now: () => now,
      fetchPage: async () => {
        seen.push('page')
        return incPage
      },
    })
    assert.equal(seen.length, 1, '命中 lastSeenId 后不再翻页')
    assert.equal(status.state, 'ready')
    assert.equal(status.lastSeenId, 'id-2026-10-22 14:00:00-0')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
