/** 增量新闻没有新条目时不得写盘（GET /prism 每 30s 一次，旧实现每次重写 380KB） */
import test from 'node:test'
import assert from 'node:assert/strict'
import { incrementalNews } from './prismNews.ts'

const item = (id: string, time: string) => ({ id, time, text: `t${id}`, important: false })

test('① 命中 lastSeenId（无新条目）⇒ 不调用 saveNews', async () => {
  let saves = 0
  const store = {
    news: () => ({ status: { state: 'ready', pages: 1, lastSeenId: 'a2', fetchedAt: 1, reason: null, items: 2 }, items: [item('a2', '2026-11-25 10:00:00')] }),
    saveNews: async () => { saves += 1 },
  } as never
  const status = await incrementalNews(store, {
    fetchPage: async () => ({ items: [item('a2', '2026-11-25 10:00:00')], oldest: '2026-11-25 10:00:00' }),
    now: () => 2,
  } as never)
  assert.equal(saves, 0, '无新条目不得写盘')
  assert.equal(status.state, 'ready')
})

test('② 有新条目 ⇒ 正常写盘', async () => {
  let saves = 0
  const store = {
    news: () => ({ status: { state: 'ready', pages: 1, lastSeenId: 'a1', fetchedAt: 1, reason: null, items: 1 }, items: [item('a1', '2026-11-25 09:00:00')] }),
    saveNews: async () => { saves += 1 },
  } as never
  await incrementalNews(store, {
    fetchPage: async () => ({ items: [item('a2', '2026-11-25 10:00:00'), item('a1', '2026-11-25 09:00:00')], oldest: '2026-11-25 09:00:00' }),
    now: () => 2,
  } as never)
  assert.equal(saves, 1)
})

test('③ 旧新闻缺 important / 时间格式为 ISO 时仍保留（不被静默清空）', async () => {
  const { mkdtemp, writeFile } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { PrismStore } = await import('./prismStore.ts')
  const dir = await mkdtemp(join(tmpdir(), 'prism-news-load-'))
  const nowIso = new Date().toISOString()
  await writeFile(join(dir, 'prism-news.json'), JSON.stringify({ v: 1, status: { state: 'ready' }, items: [
    { id: 'n1', time: nowIso, text: 'a' },
    { id: 'n2', time: nowIso.replace('T', ' ').slice(0, 19), text: 'b', important: true },
  ] }), 'utf8')
  const s = new PrismStore(dir); await s.init()
  assert.equal(s.news().items.length, 2)
  assert.equal(s.news().items.every((i) => typeof i.important === 'boolean'), true)
})
