/**
 * 取数层的"上游请求数"断言（AUDIT-CACHE-1 / -2 的 P0-1、P0-2、P1-1、P1-2、P1-3、P2-1、P2-2 + 稳态命中率 + 时段）。
 *
 * 断言纪律：
 *   - **锚真实实现**：走 `em.*` / 真实路由 handler，不复制一份被测逻辑；
 *   - **锚真实计数**：`globalThis.fetch` 包一层数请求（熔断器的 `fails` 只记失败次数，当不了计数器）；
 *   - 上游一律由合成 fixture 回答（形状忠实：clist 56 页、行业榜 496 项、分时 242 点、日K 800 根），
 *     所以断言与网络无关、可复现；
 *   - 时钟钉死在北京时间的指定时刻（`Date.now` 覆写），需要跨 TTL 的场景显式推进。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { DataStore } from './store.ts'
import { CalendarStore } from './calendar.ts'
import { RescueMonitor, fetchQuoteSource } from './rescue.ts'
import { makeTradeRoutes } from './routes.ts'
import * as em from './em.ts'
import { breakerFor } from './breaker.ts'
import { BREADTH_CLIST_MAX_PAGES, BreadthCountCache, resolveBreadthCount } from './breadthCount.ts'

/** 测试隔离：`dataHome()` 每次调用都读 env ⇒ 必须在任何取数之前把它指到临时目录 */
process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'tw-dedupe-home-'))

const CLIST_TOTAL = 5513
const BOARD_TOTAL = 496

// ── 上游 fixture（形状忠实：页数、行数、字段名都按真实回包） ────────────────────

function quotePayload(secids: string[], opts: { breadth?: boolean } = {}): unknown {
  const diff = secids.map((secid) => {
    const [mkt, code] = secid.split('.')
    const row: Record<string, unknown> = {
      f12: code, f13: Number(mkt), f14: `${code} 名称`, f2: 100, f3: 1.2, f4: 1.1, f5: 1000, f6: 2000,
      f8: 1.5, f10: 1.8, f15: 101, f16: 99, f17: 100, f18: 99, f20: 1e11, f21: 9e10, f23: 1.4,
      f62: 12345678, f66: 2345678, f124: 1791788400,
    }
    if (opts.breadth !== false) {
      row.f104 = 2100
      row.f105 = 2700
      row.f106 = 213
    }
    return row
  })
  return { rc: 0, data: { total: diff.length, diff } }
}

function clistPayload(pn: number, pz: number, fs: string): unknown {
  if (fs.includes('m:90+t:2')) {
    const start = (pn - 1) * pz
    const rows = Array.from({ length: Math.max(0, Math.min(pz, BOARD_TOTAL - start)) }, (_, i) => ({
      f12: `BK${String(start + i + 1).padStart(4, '0')}`,
      f13: 90,
      f14: `板块${String(start + i + 1).padStart(3, '0')}`,
      f3: ((start + i) % 21) - 10,
      f2: 1000,
      f62: 1,
      f6: 2,
      f128: '龙头',
      f136: 1,
    }))
    return { rc: 0, data: { total: BOARD_TOTAL, diff: rows } }
  }
  const start = (pn - 1) * pz
  const rows = Array.from({ length: Math.max(0, Math.min(pz, CLIST_TOTAL - start)) }, (_, i) => ({
    f3: i % 7 === 0 ? 0 : (start + i) % 3 === 0 ? -2 : 2,
    f12: String(600000 + start + i),
  }))
  return { rc: 0, data: { total: CLIST_TOTAL, diff: rows } }
}

function trendPayload(): unknown {
  const trends: string[] = []
  for (let i = 0; i < 242; i += 1) {
    trends.push(`2026-10-12 ${i < 121 ? '10' : '13'}:${String(i % 60).padStart(2, '0')},100,100.1,100.2,99.9,1000,100100,100.05`)
  }
  return { data: { prePrice: 99.5, trends } }
}

function klinePayload(): unknown {
  const klines: string[] = []
  for (let i = 0; i < 800; i += 1) {
    const d = new Date(Date.UTC(2023, 0, 2) + i * 86_400_000).toISOString().slice(0, 10)
    klines.push(`${d},100,101,102,99,1000,120000,1,1,0.5,0.3`)
  }
  return { data: { klines, total: klines.length } }
}

interface Stub {
  /** 上游请求（按 host+path 计数） */
  calls: Array<{ host: string; path: string; q: string }>
  count: (fragment: string) => number
  uniqueUrls: (fragment: string) => number
  /** 同时在飞的最大请求数（并发行为断言用） */
  peak: () => number
  restore: () => void
  failHosts: Set<string>
}

function stubFetch(options: { breadth?: boolean; delayMs?: number } = {}): Stub {
  const original = globalThis.fetch
  const calls: Array<{ host: string; path: string; q: string }> = []
  const failHosts = new Set<string>()
  let inFlight = 0
  let peak = 0

  const reply = (payload: unknown): Response => {
    const text = JSON.stringify(payload)
    return { ok: true, status: 200, text: async () => text, json: async () => JSON.parse(text) } as unknown as Response
  }

  const respond = (u: URL): Response => {
    if (failHosts.has(u.host)) throw new TypeError('fetch failed')
    if (u.host.endsWith('eastmoney.com')) {
      const p = u.pathname
      if (p === '/api/qt/ulist.np/get') {
        const ids = String(u.searchParams.get('secids') ?? '').split(',').filter((s) => s !== '')
        return reply(quotePayload(ids, options))
      }
      if (p === '/api/qt/clist/get') {
        return reply(clistPayload(Number(u.searchParams.get('pn') ?? 1), Number(u.searchParams.get('pz') ?? 100), String(u.searchParams.get('fs') ?? '')))
      }
      if (p === '/api/qt/stock/trends2/get') return reply(trendPayload())
      if (p === '/api/qt/stock/kline/get') return reply(klinePayload())
      if (p === '/api/qt/stock/get') return reply({ rc: 0, data: { f57: '600519', f58: '名称', f127: industryName } })
      return reply({ rc: 0, data: null })
    }
    throw new TypeError('fetch failed')
  }

  globalThis.fetch = (async (input: unknown) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : String((input as { url?: string })?.url ?? '')
    const u = new URL(url)
    calls.push({ host: u.host, path: u.pathname, q: u.search })
    inFlight += 1
    if (inFlight > peak) peak = inFlight
    try {
      if ((options.delayMs ?? 0) > 0) await new Promise((r) => setTimeout(r, options.delayMs))
      return respond(u)
    } finally {
      inFlight -= 1
    }
  }) as typeof fetch

  return {
    calls,
    count: (fragment) => calls.filter((c) => c.path.includes(fragment)).length,
    uniqueUrls: (fragment) => new Set(calls.filter((c) => c.path.includes(fragment)).map((c) => `${c.host}${c.path}${c.q}`)).size,
    peak: () => peak,
    restore: () => { globalThis.fetch = original },
    failHosts,
  }
}

/**
 * 熔断器是**进程内**状态：本文件里"注入失败"的用例会把它打开，
 * 后续依赖上游可达的用例必须先在隔离的起点上复位（否则它们会以"熔断中快速失败"开局）。
 */
function resetBreakers(): void {
  for (const host of ['push2delay.eastmoney.com', 'push2.eastmoney.com', 'push2his.eastmoney.com']) {
    breakerFor(host).recordSuccess()
  }
}

/** 把"现在"钉在北京时间某一刻；返回恢复函数 */
function pinNow(ts: number): () => void {
  const original = Date.now
  let offset = 0
  Date.now = () => ts + offset
  pinned.advance = (ms: number) => { offset += ms }
  return () => { Date.now = original; pinned.advance = () => undefined }
}
const pinned: { advance: (ms: number) => void } = { advance: () => undefined }

/**
 * 钉死"现在"并**往前推 5 分钟**：保证本用例看到的行情槽/页缓存都是冷的
 * —— 断言不依赖用例顺序（时间戳是从前一个用例延续下来的，回拨会让旧槽看起来仍然新鲜）。
 */
let pinnedSeq = 0
function pinFresh(ts: number = Date.UTC(2026, 9, 12, 2, 30, 0)): () => void {
  const restore = pinNow(ts)
  // 每个用例再往前挪 10 分钟（同一个基准时刻的话，上一个用例写的槽在下个用例看来仍然新鲜）
  pinned.advance(300_000 + (pinnedSeq++) * 600_000)
  return restore
}

/** 钉死一个确定性的行业名（`fetchIndustryOf` 用它去榜里定位） */
let industryName = '板块001'

// ── P0-1：分时并发不合并（实测并发 8 ⇒ 8 次上游） ──────────────────────────────

test('P0-1 分时：并发 8 个同 secid 只发 1 次上游（在飞合并），且 8 个都拿到数据', async () => {
  const s = stubFetch()
  const unpin = pinFresh() // 北京 10:35（盘中）
  resetBreakers()
  try {
    const results = await Promise.all(Array.from({ length: 8 }, () => em.fetchTrend('1.600519', 1, { archive: false })))
    assert.equal(s.count('/stock/trends2/get'), 1, `并发 8 个同 secid 分时：上游必须只发 1 次（实测改前 8 次），实际 ${s.count('/stock/trends2/get')}`)
    assert.equal(results.filter((r) => r !== null && r.points.length > 2).length, 8, '合并不得让任何调用方拿不到数据')
  } finally {
    s.restore()
    unpin()
  }
})

// ── P0-2：同一轮两遍扫共享同一份 clist 页 ─────────────────────────────────────

test('P0-2 clist 页：20s 内重复取同一页只发 1 次上游（源 B 与涨跌分布共享）', async () => {
  const s = stubFetch()
  const unpin = pinFresh()
  try {
    await em.fetchClistPctPage(1, 100)
    await em.fetchClistPctPage(1, 100)
    assert.equal(s.count('/api/qt/clist/get'), 1, '同一页 20s 内第二次必须命中短 TTL 缓存')
    pinned.advance(21_000)
    await em.fetchClistPctPage(1, 100)
    assert.equal(s.count('/api/qt/clist/get'), 2, '过了短 TTL 必须重新取（口径是"同一时刻的截面"）')
  } finally {
    s.restore()
    unpin()
  }
})

test('P0-2 /breadth?dist=1（源 A 缺失）：56 个 URL 各扫一遍，不再 ×2', async () => {
  const store = new DataStore(mkdtempSync(join(tmpdir(), 'tw-dedupe-breadth-')))
  await store.init()
  const routes = makeTradeRoutes(
    store, [], new CalendarStore(process.env.DSH_HOME as string),
    new RescueMonitor(process.env.DSH_HOME as string, { enabled: false, intervalSec: 30, tailIntervalSec: 15, tailFrom: '14:30', universe: [] }),
  ).routes
  const handler = routes.find((r) => r.path === '/tradewatcher/breadth') as unknown as { handler: (req: IncomingMessage, res: ServerResponse) => void }
  const s = stubFetch({ breadth: false }) // 指数行情不带 f104/f105/f106 ⇒ 只能走源 B 自统计
  const unpin = pinFresh()
  resetBreakers()
  try {
    const body = await new Promise<Record<string, unknown>>((resolve) => {
      const req = { url: '/tradewatcher/breadth?dist=1', method: 'GET', headers: { host: '127.0.0.1:3080' }, async *[Symbol.asyncIterator]() {} } as unknown as IncomingMessage
      const res = { writeHead() {}, end(payload: string) { resolve(JSON.parse(payload) as Record<string, unknown>) } } as unknown as ServerResponse
      handler.handler(req, res)
    })
    const clistRequests = s.count('/api/qt/clist/get')
    const unique = s.uniqueUrls('/api/qt/clist/get')
    assert.equal(unique, 56, `沪深A股 5513 只 / 每页 100 ⇒ 必须恰好扫 56 个不同的页 URL，实际 ${unique}`)
    assert.equal(clistRequests, unique, `源 B 与涨跌分布必须共享同一份页数据（改前 112 = 56×2），实际 ${clistRequests}`)
    const current = body.current as { source?: string } | null
    assert.equal(current?.source, 'em-clist', '源 A 缺失时必须由源 B 自统计给出家数')
    const dist = (body.distribution ?? null) as { counts?: number[] | null } | null
    assert.ok(dist !== null && Array.isArray(dist.counts), '扫全了就必须给出分布（不许因为共享缓存而丢结果）')
  } finally {
    s.restore()
    unpin()
  }
})

test('P0-2/P1-2 分布扫描：页数上限与源 B 共用同一常量，且并发不改变结果', () => {
  assert.equal(BREADTH_CLIST_MAX_PAGES, 60, '页数上限写死在常量里（两侧共用；各自写死会漂移）')
})

// ── P1-1：源 B 失败负缓存 ────────────────────────────────────────────────────

test('P1-1 源 B 失败：30s 内第二次调用不再重扫 56 页（负缓存带原因）', async () => {
  const cache = new BreadthCountCache()
  const store = new DataStore(mkdtempSync(join(tmpdir(), 'tw-dedupe-b1-')))
  await store.init()
  const routes = makeTradeRoutes(
    store, [], new CalendarStore(process.env.DSH_HOME as string),
    new RescueMonitor(process.env.DSH_HOME as string, { enabled: false, intervalSec: 30, tailIntervalSec: 15, tailFrom: '14:30', universe: [] }),
    undefined, cache,
  ).routes
  const handler = routes.find((r) => r.path === '/tradewatcher/breadth') as unknown as { handler: (req: IncomingMessage, res: ServerResponse) => void }
  const s = stubFetch({ breadth: false })
  const unpin = pinFresh()
  resetBreakers()
  s.failHosts.add('push2delay.eastmoney.com')
  s.failHosts.add('push2.eastmoney.com')
  s.failHosts.add('push2his.eastmoney.com')
  const call = (): Promise<Record<string, unknown>> => new Promise((resolve) => {
    const req = { url: '/tradewatcher/breadth', method: 'GET', headers: { host: '127.0.0.1:3080' }, async *[Symbol.asyncIterator]() {} } as unknown as IncomingMessage
    const res = { writeHead() {}, end(payload: string) { resolve(JSON.parse(payload) as Record<string, unknown>) } } as unknown as ServerResponse
    handler.handler(req, res)
  })
  try {
    const first = await call()
    const afterFirst = s.count('/api/qt/clist/get')
    assert.ok(afterFirst > 0, '第一次必须真的去扫（证明没走缓存分支）')
    // 调用之间复位熔断器：模拟"半开/刚恢复的一刻"，让"重跑 56 页"这件事以真实请求的形式暴露出来
    for (const host of ['push2delay.eastmoney.com', 'push2.eastmoney.com', 'push2his.eastmoney.com']) breakerFor(host).recordSuccess()
    const second = await call()
    const afterSecond = s.count('/api/qt/clist/get')
    assert.equal(afterSecond, afterFirst, `失败后的 30s 内第二次调用不得重扫分页（改前会再跑一整遍循环），实际多出 ${afterSecond - afterFirst} 条`)
    const missing = (second.missing ?? []) as Array<{ what?: string; note?: string }>
    assert.ok(missing.some((m) => String(m.note ?? '').includes('clist')), '负缓存命中时必须仍然给出具体原因（不许只说"失败"）')
    const firstMissing = (first.missing ?? []) as Array<{ what?: string; note?: string }>
    assert.ok(firstMissing.some((m) => String(m.note ?? '').includes('clist')), '第一次失败也要给出原因')
    pinned.advance(31_000)
    // 再复位一次熔断器：第三次要验的是"负缓存到期 ⇒ 真的回去取数"，不该被上两次留下的熔断挡住
    for (const host of ['push2delay.eastmoney.com', 'push2.eastmoney.com', 'push2his.eastmoney.com']) breakerFor(host).recordSuccess()
    await call()
    assert.ok(s.count('/api/qt/clist/get') > afterSecond, '过 30s 负缓存必须到点重试（恢复后第一次请求不许被长期挡住）')
  } finally {
    s.restore()
    unpin()
  }
})

test('P1-1 源 B 失败：结果级负缓存（30s）——第二次不再调用分页器，过窗口必须重试', async () => {
  const cache = new BreadthCountCache()
  let pageCalls = 0
  const deps = {
    clistPage: async (): Promise<{ rows: Array<number | null>; total: number | null }> => {
      pageCalls += 1
      throw new Error('fetch failed（桩）')
    },
  }
  const t0 = Date.UTC(2026, 9, 12, 2, 30, 0)
  const first = await resolveBreadthCount({ fromIndexQuote: null, indexAsOf: null, deps, now: t0, cache })
  assert.equal(first.counts, null, '上游失败 ⇒ 家数为 null（不许编）')
  const afterFirst = pageCalls
  assert.ok(afterFirst > 0, '第一次必须真的调分页器（证明没走缓存）')
  const second = await resolveBreadthCount({ fromIndexQuote: null, indexAsOf: null, deps, now: t0 + 1_000, cache })
  assert.equal(pageCalls, afterFirst, `30s 窗口内第二次调用不得再跑分页循环（改前每次调用都重跑 56 页），实际多调 ${pageCalls - afterFirst} 次`)
  assert.ok(String(second.reason ?? '').includes('fetch failed'), '负缓存命中时仍要原样带出失败原因')
  await resolveBreadthCount({ fromIndexQuote: null, indexAsOf: null, deps, now: t0 + 31_000, cache })
  assert.ok(pageCalls > afterFirst, '过了负缓存窗口必须重试（恢复后的第一次请求不许被长期挡住）')
})

// ── P1-3：K 线收口到熔断器 ───────────────────────────────────────────────────

test('P1-3 K 线：三台主机全熔断时 0 次上游请求（改前一次 /kline 仍发 6 条）', async () => {
  const s = stubFetch()
  const unpin = pinFresh()
  try {
    for (const host of ['push2his.eastmoney.com', 'push2delay.eastmoney.com', 'push2.eastmoney.com']) {
      for (let i = 0; i < 3; i += 1) breakerFor(host).recordFailure(new Error('fetch failed'))
    }
    assert.equal(em.hostsUnavailable(['push2his.eastmoney.com', 'push2delay.eastmoney.com', 'push2.eastmoney.com']), true, '前置：三台必须都在熔断冷却中')
    const k = await em.fetchKline('114.lhm', 101, 240, 0) // 商品主连：腾讯不覆盖，只能走东财
    assert.equal(s.count('/stock/kline/get'), 0, `熔断冷却中不得再打上游（实测改前 6 条），实际 ${s.count('/stock/kline/get')}`)
    assert.equal(k, null, '取不到就如实给 null（不许编数据）')
  } finally {
    s.restore()
    unpin()
  }
})

test('P1-3 K 线：冷却结束仍能取到数据（腾讯不覆盖的标的，行为不退化）', async () => {
  const s = stubFetch()
  const unpin = pinFresh()
  try {
    for (const host of ['push2his.eastmoney.com', 'push2delay.eastmoney.com', 'push2.eastmoney.com']) {
      for (let i = 0; i < 3; i += 1) breakerFor(host).recordFailure(new Error('fetch failed'))
    }
    pinned.advance(901_000) // 越过退避上限（900s）
    const k = await em.fetchKline('114.lhm', 101, 240, 0)
    assert.ok(k !== null && k.days.length > 0, '冷却结束后必须能取到 K 线（半开探针成功即恢复）')
    assert.equal(s.count('/stock/kline/get'), 1, '半开期只放行一个探针 ⇒ 恰好 1 次请求')
  } finally {
    s.restore()
    unpin()
  }
})

test('P1-3 K 线失败**记账**：三次冷取数（上游全挂）必须把熔断器推起来', async () => {
  const s = stubFetch()
  const unpin = pinFresh()
  s.failHosts.add('push2his.eastmoney.com')
  s.failHosts.add('push2delay.eastmoney.com')
  s.failHosts.add('push2.eastmoney.com')
  try {
    const before = em.hostsUnavailable(['push2his.eastmoney.com', 'push2delay.eastmoney.com', 'push2.eastmoney.com'])
    assert.equal(before, false, '前置：冷却开始时三台都是通的（闭合）')
    const per: number[] = []
    for (const secid of ['114.lhm', '114.jmm', '114.mm']) {
      const n0 = s.count('/stock/kline/get')
      await em.fetchKline(secid, 101, 240, 0)
      per.push(s.count('/stock/kline/get') - n0)
    }
    assert.equal(em.hostsUnavailable(['push2his.eastmoney.com', 'push2delay.eastmoney.com', 'push2.eastmoney.com']), true,
      'K 线的失败必须进熔断账本（改前 trips/fails 一字不变，这条链路的失败对熔断器不可见）')
    assert.equal(per[2], 0, `熔断打开后第三次不得再打上游，实际 ${per[2]} 条`)
  } finally {
    s.restore()
    unpin()
  }
})

// ── 稳态命中率（根因）：服务端槽有效期必须大于客户端间隔 ──────────────────────

test('稳态：服务端槽有效期 = 客户端间隔 + 一档余量（改前两者严格相等 ⇒ 每拍必回源）', () => {
  em.setQuoteFreshnessMs(10_000)
  try {
    const ttl = em.quoteSlotTtlMs()
    assert.ok(ttl > em.quoteFreshnessMs(), `服务端有效期必须严格大于客户端间隔（改前相等 ⇒ 稳态命中率 0%），实际 ${ttl} vs ${em.quoteFreshnessMs()}`)
    assert.ok(ttl <= em.quoteFreshnessMs() * 1.5, '余量必须只有一档（不许把数据压成"两拍前"）')
  } finally {
    em.setQuoteFreshnessMs(10_000)
  }
})

test('稳态：引擎每 10s 一拍、连打 6 拍，上游请求从 6 条降到 3 条（数据最多旧一拍）', async () => {
  const s = stubFetch()
  const unpin = pinFresh()
  const ids = ['1.510300', '1.510050', '0.159915', '1.000905'] // 独占的 secid，避免与其它用例共享槽
  resetBreakers()
  try {
    em.setQuoteFreshnessMs(10_000)
    const per: number[] = []
    for (let tick = 0; tick < 6; tick += 1) {
      const n0 = s.count('/api/qt/ulist.np/get')
      await em.fetchQuotesDetailed(ids)
      per.push(s.count('/api/qt/ulist.np/get') - n0)
      pinned.advance(10_000)
    }
    assert.deepEqual(per, [1, 0, 1, 0, 1, 0], `每拍的上游请求数（改前 [1,1,1,1,1,1]），实际 ${JSON.stringify(per)}`)
  } finally {
    em.setQuoteFreshnessMs(10_000)
    s.restore()
    unpin()
  }
})

// ── 时段判断：收盘后 A 股定稿零回源 ─────────────────────────────────────────

test('时段：收盘后（15:09）A 股行情定稿复用，不再每拍回源', async () => {
  const s = stubFetch()
  const unpin = pinFresh(Date.UTC(2026, 9, 12, 7, 9, 0)) // 北京 2026-10-12 15:14（收盘后 14 分钟）
  const ids = ['1.512100', '1.588000']
  resetBreakers()
  try {
    em.setQuoteFreshnessMs(10_000)
    const first = s.count('/api/qt/ulist.np/get')
    await em.fetchQuotesDetailed(ids)
    assert.equal(s.count('/api/qt/ulist.np/get') - first, 1, '收盘后第一次仍要取一次（槽是空的）')
    for (let tick = 0; tick < 4; tick += 1) {
      pinned.advance(10_000)
      await em.fetchQuotesDetailed(ids)
    }
    assert.equal(s.count('/api/qt/ulist.np/get') - first, 1, `收盘后 A 股行情不会再变 ⇒ 后续每一拍都必须 0 请求（实测改前每拍 1 条），实际 ${s.count('/api/qt/ulist.np/get') - first}`)
  } finally {
    em.setQuoteFreshnessMs(10_000)
    s.restore()
    unpin()
  }
})

test('时段：外盘/商品不受 A 股时段冻结（夜盘/美盘仍在变，必须继续按 TTL 轮询）', async () => {
  const s = stubFetch()
  const unpin = pinFresh(Date.UTC(2026, 9, 12, 7, 9, 0)) // 北京 15:14：A 股已收盘，美股尚未开盘
  try {
    em.setQuoteFreshnessMs(5_000)
    const ids = ['100.NDX'] // 腾讯不覆盖、交易时段与 A 股不同
    resetBreakers()
    await em.fetchQuotesDetailed(ids)
    const n0 = s.count('/api/qt/ulist.np/get')
    pinned.advance(30_000)
    await em.fetchQuotesDetailed(ids)
    assert.equal(s.count('/api/qt/ulist.np/get') - n0, 1, '外盘标的必须仍按 TTL 回源（不许用 A 股收盘把它冻住）')
  } finally {
    em.setQuoteFreshnessMs(10_000)
    s.restore()
    unpin()
  }
})

// ── P2-1：行业榜按需取页 ────────────────────────────────────────────────────

test('P2-1 行业榜：按需取页（第 1 页 ⇒ 1 页），后面的页仍能定位，30s 内再查 0 请求', async () => {
  const s = stubFetch()
  const unpin = pinFresh()
  resetBreakers()
  try {
    industryName = '板块001'
    const info = await em.fetchIndustryOf('1.600519')
    assert.deepEqual(info, { name: '板块001', pct: -10 }, '定位到的板块必须给出真实涨幅（取自榜页那一行，不许编）')
    assert.equal(s.count('/api/qt/clist/get'), 1, `名字在第 1 页 ⇒ 只该翻 1 页（改前固定 5 页），实际 ${s.count('/api/qt/clist/get')}`)

    // 越过页缓存与结果缓存的 30s：换成"名字在第 5 页"的标的，必须仍能定位（不许因按需取页丢结果）
    pinned.advance(31_000)
    industryName = '板块450'
    const n0 = s.count('/api/qt/clist/get')
    const info5 = await em.fetchIndustryOf('0.000858')
    assert.deepEqual(info5, { name: '板块450', pct: -2 }, '名字在后面的页也必须定位到（结果不许因"按需取页"而丢）')
    const pages5 = s.count('/api/qt/clist/get') - n0
    assert.equal(pages5, 5, `名字在第 5 页 ⇒ 翻 5 页（与改前一致，不许退化），实际 ${pages5}`)

    await em.fetchIndustryOf('0.000858')
    assert.equal(s.count('/api/qt/clist/get') - n0, pages5, '30s 窗口内再查必须多 0 页（结果缓存 + 在飞合并）')
  } finally {
    s.restore()
    unpin()
  }
})

// ── P2-2：分时 TTL 口径必须与字面一致（不再有 45s 隐式宽限） ──────────────────

test('P2-2 分时：过了 60s TTL 必须回源（改前 peek 宽限把 60s 拉成 ≈105s）', async () => {
  const s = stubFetch()
  const unpin = pinFresh()
  resetBreakers()
  try {
    await em.fetchTrend('0.300750', 1, { archive: false })
    assert.equal(s.count('/stock/trends2/get'), 1)
    pinned.advance(30_000)
    await em.fetchTrend('0.300750', 1, { archive: false })
    assert.equal(s.count('/stock/trends2/get'), 1, '30s（< 60s TTL）内必须命中缓存')
    pinned.advance(31_000) // 累计 61s
    await em.fetchTrend('0.300750', 1, { archive: false })
    assert.equal(s.count('/stock/trends2/get'), 2, `累计超过 60s 必须回源（TTL 就是字面值），实际 ${s.count('/stock/trends2/get')}`)
  } finally {
    s.restore()
    unpin()
  }
})

// ── 采样器复用同一份行情缓存 ────────────────────────────────────────────────

test('采样器：行情条刚取过数时，护盘采样 0 上游请求（改前各打一遍、互不命中）', async () => {
  const s = stubFetch()
  const unpin = pinFresh()
  const ids = ['1.588170', '0.159915']
  resetBreakers()
  try {
    em.setQuoteFreshnessMs(10_000)
    await em.fetchQuotesDetailed(ids) // 行情条（引擎）先取
    const n0 = s.calls.length
    const got = await fetchQuoteSource(ids)
    assert.equal(s.calls.length - n0, 0, `采样器必须复用行情槽（0 请求），实际 ${s.calls.length - n0} 条`)
    assert.equal(got.source, 'em', '共用槽的数据来自东财 ⇒ 分单资金流可用')
    assert.equal(got.rows['1.588170']?.superNet, 2345678, '超大单净额必须来自共用的那一行（f66）')
    assert.equal(got.rows['1.588170']?.volRatio, 1.8, '量比（f10）也从共用行取，不必再打一条 URL')
  } finally {
    em.setQuoteFreshnessMs(10_000)
    s.restore()
    unpin()
  }
})

test('采样器：行情条不在（无 UI）时仍自己取数 ⇒ 行为不退化，且只有 1 条请求', async () => {
  const s = stubFetch()
  const unpin = pinFresh()
  const ids = ['1.600519', '1.601288'] // 独占集：别的用例没有取过它们的行情槽
  resetBreakers()
  try {
    em.setQuoteFreshnessMs(10_000)
    const n0 = s.calls.length
    const got = await fetchQuoteSource(ids)
    assert.equal(s.calls.length - n0, 1, `没有行情条时采样器要自己取一次（1 条批量），实际 ${s.calls.length - n0}`)
    assert.equal(Object.keys(got.rows).length, 2)
    assert.equal(got.source, 'em')
  } finally {
    em.setQuoteFreshnessMs(10_000)
    s.restore()
    unpin()
  }
})

// ── 采样器与引擎共用字段表：f8/f10/f62/f66 必须在同一条 URL 里 ────────────────

test('共用字段表：引擎那一条 URL 就带 f62/f66/f8/f10（多带两列不增加请求数）', async () => {
  const s = stubFetch()
  const unpin = pinFresh()
  resetBreakers()
  try {
    await em.fetchQuotesDetailed(['1.600887'])
    const url = s.calls.find((c) => c.path === '/api/qt/ulist.np/get')
    assert.ok(url !== undefined)
    for (const f of ['f62', 'f66', 'f8', 'f10']) {
      assert.ok(url.q.includes(f), `字段表必须含 ${f}（采样器与行情条共用同一条 URL 的前提）`)
    }
  } finally {
    s.restore()
    unpin()
  }
})

/**
 * ⚠ 放在文件**最后**：本用例的指数行情**带** f104/f105/f106（这是"源 A 可用、只跑分布扫描"的前提），
 * 而这些行会经 last-known-good 银行留下来 —— 之后任何"源 A 缺失"的用例都会被它污染。
 */
test('P1-2 分布扫描：串行改有限并发（在飞峰值 ≥ 3），扫全的红线不变', async () => {
  // 源 A 可用 ⇒ 源 B（自统计）不参与，峰值只可能来自分布扫描本身
  const store = new DataStore(mkdtempSync(join(tmpdir(), 'tw-dedupe-dist-')))
  await store.init()
  const routes = makeTradeRoutes(
    store, [], new CalendarStore(process.env.DSH_HOME as string),
    new RescueMonitor(process.env.DSH_HOME as string, { enabled: false, intervalSec: 30, tailIntervalSec: 15, tailFrom: '14:30', universe: [] }),
  ).routes
  const handler = routes.find((r) => r.path === '/tradewatcher/breadth') as unknown as { handler: (req: IncomingMessage, res: ServerResponse) => void }
  const s = stubFetch({ delayMs: 20 }) // 人为上游延迟：串行 55 页要 1s+，并发 6 只需 ~200ms
  const unpin = pinFresh()
  resetBreakers()
  try {
    const body = await new Promise<Record<string, unknown>>((resolve) => {
      const req = { url: '/tradewatcher/breadth?dist=1', method: 'GET', headers: { host: '127.0.0.1:3080' }, async *[Symbol.asyncIterator]() {} } as unknown as IncomingMessage
      const res = { writeHead() {}, end(payload: string) { resolve(JSON.parse(payload) as Record<string, unknown>) } } as unknown as ServerResponse
      handler.handler(req, res)
    })
    assert.ok(s.peak() >= 3, `分布扫描必须有限并发（改前串行 ⇒ 在飞峰值 1），实际峰值 ${s.peak()}`)
    assert.equal(s.count('/api/qt/clist/get'), 56, `并发不许改变请求数（56 个唯一页），实际 ${s.count('/api/qt/clist/get')}`)
    const dist = body.distribution as { counts?: number[] | null; scanned?: number; reason?: string | null } | undefined
    assert.equal(dist?.scanned, 5513, '并发必须仍然扫全（红线：没扫全就给 null + 原因）')
    assert.ok(Array.isArray(dist?.counts), '扫全了就必须给分布（并发不得让结果缺失）')
  } finally {
    s.restore()
    unpin()
  }
})

test('目录准备：确保 store 目录存在（后续用例写入不失败）', () => {
  mkdirSync(join(process.env.DSH_HOME as string, 'dsh-tradewatcher'), { recursive: true })
})
