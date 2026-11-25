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
