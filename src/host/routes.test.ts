/**
 * 路由层测试（node:test，零新增依赖，不依赖网络可用性）。
 *
 * 存在的理由：host 自检（selftest.ts）一直**直调模块函数**，于是 249 条断言全绿的同时，
 * 路由层的大小写规范化把 4 个商品主连整批丢掉也没人发现 —— `/tradewatcher/quotes` 是
 * 界面唯一的数据入口，它必须有断言。这里的断言分两类：
 *
 *   1. **结构不变量**（与上游是否可用无关）：`items + missing` 必须覆盖全部请求项、
 *      返回键必须等于请求时的写法（不得被改写成大写）、截断必须如实回报；
 *   2. **错误语义**：400 / 413 / 415 / 503 与 `retry-after`、信任围栏 403。
 *
 * 每个测试文件由 node 的测试运行器单独起进程，因此这里对熔断器的改动不会影响其它文件。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { TW_ALL_SECIDS } from '../shared/model.ts'
import { DataStore } from './store.ts'
import { CalendarStore } from './calendar.ts'
import { RescueMonitor } from './rescue.ts'
import { makeTradeRoutes } from './routes.ts'
import { QUOTE_HOSTS, HISTORY_HOSTS } from './em.ts'
import { breakerFor } from './breaker.ts'

/**
 * 测试隔离：`dataHome()` 每次调用都读 env，因此这里把它指到临时目录 ——
 * 否则 `loadLastGood()` 会读**用户真实**的 quotes-lkg.json（甚至写回），
 * 断言结果就会随本机缓存状态漂移。必须在任何路由调用之前设置。
 */
process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'tw-routes-home-'))

interface Captured {
  code: number
  headers: Record<string, string>
  body: Record<string, unknown>
}

interface Harness {
  call(path: string, url: string, init?: { method?: string; body?: string; headers?: Record<string, string> }): Promise<Captured>
  store: DataStore
  dir: string
  close(): void
}

async function harness(): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), 'tw-routes-'))
  const store = new DataStore(dir)
  await store.init()
  const routes = makeTradeRoutes(
    store,
    [],
    new CalendarStore(dir),
    new RescueMonitor(dir, { enabled: false, intervalSec: 30, tailIntervalSec: 15, tailFrom: '14:30', universe: [] }),
  ).routes
  const find = (path: string): { handler: (req: IncomingMessage, res: ServerResponse) => void } => {
    const route = routes.find((r) => r.path === path)
    if (route === undefined) throw new Error(`未找到路由 ${path}`)
    return route as unknown as { handler: (req: IncomingMessage, res: ServerResponse) => void }
  }
  return {
    store,
    dir,
    call: (path, url, init = {}) =>
      new Promise<Captured>((resolve) => {
        const body = init.body
        const req = {
          url,
          method: init.method ?? 'GET',
          headers: { host: '127.0.0.1:3080', ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(init.headers ?? {}) },
          async *[Symbol.asyncIterator]() {
            if (body !== undefined) yield Buffer.from(body)
          },
        } as unknown as IncomingMessage
        let code = 0
        let headers: Record<string, string> = {}
        const res = {
          writeHead(c: number, h: Record<string, string>) {
            code = c
            headers = h
          },
          end(payload: string) {
            resolve({ code, headers, body: payload === '' ? {} : (JSON.parse(payload) as Record<string, unknown>) })
          },
        } as unknown as ServerResponse
        find(path).handler(req, res)
      }),
    close: () => rmSync(dir, { recursive: true, force: true }),
  }
}

const idsOf = (body: Record<string, unknown>): string[] => Object.keys((body.items ?? {}) as Record<string, unknown>)

/**
 * 让东财主机进入熔断：取数立刻走备用源（腾讯/新浪）路径。
 * 大小写 bug 正是死在这条路径上（映射表以小写为键），因此这里主动走它，
 * 顺带把每个取数测试从 3–6 秒压到 1 秒内、且不再依赖东财此刻是否可达。
 */
function tripEmHosts(): void {
  for (const host of [...QUOTE_HOSTS, ...HISTORY_HOSTS]) for (let i = 0; i < 3; i++) breakerFor(host).recordFailure(new Error('selftest: tripped'))
}
function resetEmHosts(): void {
  for (const host of [...QUOTE_HOSTS, ...HISTORY_HOSTS]) breakerFor(host).recordSuccess()
}

test('路由 /quotes：items + missing 必须覆盖全部请求项（不许静默丢标的）', async () => {
  const h = await harness()
  tripEmHosts()
  try {
    const res = await h.call('/tradewatcher/quotes', `/tradewatcher/quotes?ids=${TW_ALL_SECIDS.join(',')}`)
    assert.equal(res.code, 200)
    const rows = res.body.rows as number
    const missing = res.body.missing as string[]
    const requested = res.body.requested as number
    assert.equal(requested, TW_ALL_SECIDS.length, `requested 应为 ${TW_ALL_SECIDS.length}`)
    assert.equal(rows + missing.length, requested, '返回项 + missing 必须等于请求项（否则就是静默丢弃）')
    assert.equal(res.body.truncated, false)
    assert.equal(idsOf(res.body).length, rows)
  } finally {
    resetEmHosts()
    h.close()
  }
})

test('路由 /quotes：返回键必须保持请求时的写法（大小写回归）', async () => {
  const h = await harness()
  try {
    tripEmHosts()
    // 114.lhm 曾因路由层 toUpperCase 变成 114.LHM，导致上游请求与备用源映射双双落空
    const asked = ['114.lhm', '113.rbm', '1.510300']
    const res = await h.call('/tradewatcher/quotes', `/tradewatcher/quotes?ids=${asked.join(',')}`)
    assert.equal(res.code, 200)
    const keys = idsOf(res.body)
    const missing = res.body.missing as string[]
    for (const id of asked) {
      assert.ok(
        keys.includes(id) || missing.includes(id),
        `${id} 必须出现在 items 或 missing 中，实际 keys=${keys.join(',')} missing=${missing.join(',')}`,
      )
      assert.ok(!keys.includes(id.toUpperCase()) || id.toUpperCase() === id, `${id} 不得被改写成大写键`)
    }
    // 覆盖完整性：请求 3 项，items + missing 必须正好 3
    assert.equal(keys.length + missing.length, asked.length)
  } finally {
    resetEmHosts()
    h.close()
  }
})

test('路由 /quotes：超过 160 项上限时如实回报截断', async () => {
  const h = await harness()
  try {
    tripEmHosts()
    const many = Array.from({ length: 200 }, (_, i) => `1.${600000 + i}`)
    const res = await h.call('/tradewatcher/quotes', `/tradewatcher/quotes?ids=${many.join(',')}`)
    assert.equal(res.code, 200)
    assert.equal(res.body.requested, 200)
    assert.equal(res.body.truncated, true)
    const accounted = (res.body.rows as number) + (res.body.missing as string[]).length
    assert.equal(accounted, 160, '被接受的 160 项也必须逐项有交代')
  } finally {
    resetEmHosts()
    h.close()
  }
})

test('错误语义：参数 400 / 请求体 413 / 非 JSON 400 / 类型 415', async () => {
  const h = await harness()
  try {
    const bad = await h.call('/tradewatcher/trend', '/tradewatcher/trend?secid=BAD!')
    assert.equal(bad.code, 400)
    assert.match(String(bad.body.error), /secid/)

    const nonJson = await h.call('/tradewatcher/prefs', '/tradewatcher/prefs', { method: 'POST', body: '{not json' })
    assert.equal(nonJson.code, 400)

    const wrongType = await h.call('/tradewatcher/prefs', '/tradewatcher/prefs', {
      method: 'POST',
      body: JSON.stringify({ patch: { theme: 'dark' } }),
      headers: { 'content-type': 'text/plain' },
    })
    assert.equal(wrongType.code, 415, '非 application/json 的写请求应被拒（表单无法伪造该类型）')

    const big = await h.call('/tradewatcher/prefs', '/tradewatcher/prefs', {
      method: 'POST',
      body: JSON.stringify({ patch: { note: 'x'.repeat(300 * 1024) } }),
    })
    assert.equal(big.code, 413)

    const badPatch = await h.call('/tradewatcher/prefs', '/tradewatcher/prefs', { method: 'POST', body: JSON.stringify({ patch: [1, 2] }) })
    assert.equal(badPatch.code, 400)
  } finally {
    h.close()
  }
})

test('错误语义：上游熔断 → 503 且带 retry-after（无备用源的路由）', async () => {
  const h = await harness()
  const hosts = [...QUOTE_HOSTS, ...HISTORY_HOSTS]
  try {
    for (const host of hosts) for (let i = 0; i < 3; i++) breakerFor(host).recordFailure(new Error('selftest: fetch failed'))
    const res = await h.call('/tradewatcher/detail', '/tradewatcher/detail?secid=1.600519')
    assert.equal(res.code, 503)
    assert.ok(Number(res.headers['retry-after']) > 0, `retry-after 应为正秒数，实际 ${res.headers['retry-after']}`)
    assert.match(String(res.body.error), /熔断|不可用/)
    // 熔断中应该快速失败，而不是继续打上游
  } finally {
    for (const host of hosts) breakerFor(host).recordSuccess()
    h.close()
  }
})

test('信任围栏：缺少 Host 或跨站 Origin → 403', async () => {
  const h = await harness()
  try {
    const noHost = await h.call('/tradewatcher/health', '/tradewatcher/health', { headers: { host: '' } })
    assert.equal(noHost.code, 403)
    const crossSite = await h.call('/tradewatcher/health', '/tradewatcher/health', { headers: { origin: 'https://evil.example' } })
    assert.equal(crossSite.code, 403)
    const ok = await h.call('/tradewatcher/health', '/tradewatcher/health')
    assert.equal(ok.code, 200)
    const breaker = ok.body.breaker as { hosts: number; detail: unknown[] }
    assert.equal(breaker.hosts, 3, '熔断聚合应去重为 3 台主机（行情 2 + 历史 3 去重）')
    assert.equal(breaker.detail.length, 3)
  } finally {
    h.close()
  }
})

test('自选写入：secid 大小写原样入库，且大小写不同的重复添加被拒', async () => {
  const h = await harness()
  try {
    await h.store.mutateWatch({ op: 'addGroup', name: 'G' })
    const gid = h.store.watchData().groups[0].id
    await h.store.mutateWatch({ op: 'addItem', groupId: gid, secid: '114.lhm', symbolName: '生猪主连' })
    const items = h.store.watchData().items
    assert.equal(items.length, 1)
    assert.equal(items[0].secid, '114.lhm', '入库不得改写大小写')
    await assert.rejects(
      () => h.store.mutateWatch({ op: 'addItem', groupId: gid, secid: '114.LHM', symbolName: '重复' }),
      /已包含/,
      '大小写不同的同一标的应被判为重复',
    )
    // 接口读回也必须是原样
    const got = await h.call('/tradewatcher/watch', '/tradewatcher/watch')
    const watch = got.body.watch as { items: Array<{ secid: string }> }
    assert.equal(watch.items[0].secid, '114.lhm')
  } finally {
    h.close()
  }
})

test('持仓流水：secid 大小写无关匹配（K 线 B/S 标记依赖它）', async () => {
  const h = await harness()
  try {
    await h.store.mutatePortfolio({ op: 'addGroup', name: 'P' })
    const gid = h.store.portData().groups[0].id
    await h.store.mutatePortfolio({ op: 'addPos', groupId: gid, secid: '114.lhm', symbolName: '生猪主连' })
    const posId = h.store.portData().items[0].id
    await h.store.mutatePortfolio({ op: 'buy', posId, qty: 2, price: 10000, fee: 0 })
    const lower = await h.call('/tradewatcher/trades', '/tradewatcher/trades?secid=114.lhm')
    const upper = await h.call('/tradewatcher/trades', '/tradewatcher/trades?secid=114.LHM')
    assert.equal((lower.body.trades as unknown[]).length, 1, '按原样写法应查得到流水')
    assert.equal((upper.body.trades as unknown[]).length, 1, '按大写写法也应查得到（同一标的）')
  } finally {
    h.close()
  }
})

test('排序偏好：合法值落盘、非法值 400', async () => {
  const h = await harness()
  try {
    const ok = await h.call('/tradewatcher/prefs', '/tradewatcher/prefs', {
      method: 'POST',
      body: JSON.stringify({ patch: { watchSort: { key: 'mv', desc: false }, portSort: { key: 'weight', desc: true } } }),
    })
    assert.equal(ok.code, 200)
    const prefs = ok.body.prefs as { watchSort: { key: string; desc: boolean }; portSort: { key: string } }
    assert.equal(prefs.watchSort.key, 'mv')
    assert.equal(prefs.watchSort.desc, false)
    assert.equal(prefs.portSort.key, 'weight')

    const bad = await h.call('/tradewatcher/prefs', '/tradewatcher/prefs', {
      method: 'POST',
      body: JSON.stringify({ patch: { watchSort: { key: 'bogus', desc: true } } }),
    })
    assert.equal(bad.code, 400)
    const after = await h.call('/tradewatcher/prefs', '/tradewatcher/prefs')
    assert.equal((after.body.prefs as { watchSort: { key: string } }).watchSort.key, 'mv', '被拒的写入不得污染已有偏好')
  } finally {
    h.close()
  }
})

/** 数上游真实请求次数：包一层 globalThis.fetch（熔断器的 fails 只记失败，当不了计数器） */
function countFetch(): { calls: () => number; restore: () => void } {
  const original = globalThis.fetch
  let calls = 0
  globalThis.fetch = ((...args: Parameters<typeof fetch>) => {
    calls += 1
    return original(...args)
  }) as typeof fetch
  return { calls: () => calls, restore: () => { globalThis.fetch = original } }
}

interface FixtureBar {
  date: string
  open: number
  close: number
  high: number
  low: number
  vol: number
}

/** 造一份"昨天收盘就已落袋"的日K缓存：300 根，updatedAt = 生成时刻 */
function writeKlineFixture(secid: string, klt: number, n: number): FixtureBar[] {
  const dir = join(process.env.DSH_HOME as string, 'dsh-tradewatcher', 'klines')
  mkdirSync(dir, { recursive: true })
  const now = Date.now()
  const bars: FixtureBar[] = []
  for (let i = n - 1; i >= 0; i -= 1) {
    const date = new Date(now - i * 86_400_000).toISOString().slice(0, 10)
    bars.push({ date, open: 100 + i, close: 100.5 + i, high: 101 + i, low: 99 + i, vol: 1000 + i })
  }
  writeFileSync(join(dir, `${secid}_${klt}.json`), JSON.stringify({ v: 1, secid, klt, updatedAt: now, bars }))
  return bars
}

/** 把"现在"钉在北京时间某一刻（其余代码一律走 Date.now，故必须成对恢复） */
function pinNow(ts: number): () => void {
  const original = Date.now
  Date.now = () => ts
  return () => {
    Date.now = original
  }
}

test('K 线盘缓存：休市定稿后整条链路零回源，且如实标注 cached', async () => {
  const h = await harness()
  // 北京 2026-10-03（周六）12:00
  const unpin = pinNow(Date.UTC(2026, 9, 3, 4, 0, 0))
  const counter = countFetch()
  try {
    const secid = '1.600519'
    const bars = writeKlineFixture(secid, 101, 300)
    const url = `/tradewatcher/kline?secid=${secid}&klt=101&lmt=240`
    const first = await h.call('/tradewatcher/kline', url)
    assert.equal(first.code, 200)
    const k1 = first.body.kline as { days: Array<{ date: string }>; cached?: boolean; stale?: boolean }
    assert.equal(k1.days.length, 240, '休市复用本地 300 根 → 取最近 240 根')
    assert.equal(k1.days[0].date, bars[60].date)
    assert.equal(k1.days[239].date, bars[299].date, '末根必须是本地缓存里那根')
    assert.equal(counter.calls(), 0, '休市定稿：一次上游请求都不该发')
    assert.equal(k1.cached, true, '必须标注"定稿复用"')
    assert.notEqual(k1.stale, true, '定稿不是过期数据')
    const second = await h.call('/tradewatcher/kline', url)
    assert.equal(counter.calls(), 0, '反复开关抽屉也不得回源')
    assert.equal(((second.body.kline as { days: unknown[] }).days).length, 240)
  } finally {
    counter.restore()
    unpin()
    h.close()
  }
})

test('K 线盘缓存：盘中上游全挂 → 如实标 stale + 旧缓存照给，绝不当定稿', async () => {
  const h = await harness()
  // 北京 2026-09-30（周三）10:00
  const unpin = pinNow(Date.UTC(2026, 8, 30, 2, 0, 0))
  // 上游全挂：让每一次 fetch 都直接失败（含腾讯/新浪兜底），断言才不依赖真实网络状态
  const original = globalThis.fetch
  let tries = 0
  globalThis.fetch = (() => {
    tries += 1
    return Promise.reject(new Error('fetch failed'))
  }) as typeof fetch
  try {
    const secid = '1.600519'
    writeKlineFixture(secid, 101, 300)
    const res = await h.call('/tradewatcher/kline', `/tradewatcher/kline?secid=${secid}&klt=101&lmt=240`)
    assert.equal(res.code, 200)
    const k = res.body.kline as { days: unknown[]; cached?: boolean; stale?: boolean }
    assert.equal(k.cached, undefined, '盘中永不得标 cached（哪怕请求失败）')
    assert.equal(k.stale, true, '上游不可用时必须如实标 stale')
    assert.equal(k.days.length, 240, '旧缓存仍要完整给出来，不能因为刷新失败就清空')
    assert.ok(tries > 0, '盘中必须真的尝试过回源（证明没走定稿分支）')
  } finally {
    globalThis.fetch = original
    unpin()
    h.close()
  }
})
