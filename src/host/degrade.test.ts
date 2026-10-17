/**
 * AUDIT-IMPL70 —— 上游降级语义 / 来源优先级 / 日志聚合的回归断言。
 *
 * 这一批的判据有一个共同点：**它们描述的是"坏掉时会退化成什么"**，
 * 所以每一条都配一个**必败注入**（把实现改回旧行为 ⇒ 该判据必须返回 false）。
 * 没有注入的断言只能证明"这次跑对了"，不能证明"下次坏掉会被抓到"。
 *
 * 上游一律**打桩**（`globalThis.fetch` 按主机分流）：断言不依赖任何真实网络，
 * 也不会因为本机东财此刻通与不通而漂移。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'

/**
 * 测试隔离：`dataHome()` 每次调用都读 env ⇒ 在任何路由调用之前指到临时目录，
 * 否则 `loadLastGood()` 会读用户真实的 quotes-lkg.json，断言会随本机缓存漂移。
 */
process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'tw-degrade-home-'))

import { QUOTE_HOSTS } from './em.ts'
import * as em from './em.ts'
import { breakerFor, hostsAllowed } from './breaker.ts'
import { DataStore } from './store.ts'
import { CalendarStore } from './calendar.ts'
import { RescueMonitor } from './rescue.ts'
import { makeTradeRoutes } from './routes.ts'
import {
  TotalUpstreamError,
  __resetDegraded,
  __resetUpstreamHealth,
  flushDegraded,
  noteHostFailure,
  noteHostSuccess,
  noteDegraded,
  pendingDegraded,
  setDebugSink,
  setDegradedSink,
  upstreamHealth,
} from './degrade.ts'

// ─────────────────────────── 打桩：按主机分流的上游 ─────────────────────────

type Mode = 'ok' | 'down'
interface Net {
  em: Mode
  tencent: Mode
  sina: Mode
  /** 真实发出过的请求（按主机归类），用于断言"零新增请求"与"只发了该发的" */
  calls: string[]
}

/** 腾讯行情一行（字段下标见 tencent.ts 的 `parseTencentQuoteText`） */
function tencentRow(code: string, price: number): string {
  const f = new Array<string>(80).fill('')
  f[1] = `NAME_${code.toUpperCase()}`
  f[2] = code
  f[3] = String(price)
  f[4] = String(price - 1)
  f[5] = String(price - 2)
  f[6] = '1000'
  // 美股走 parseTencentUsStamp（美东墙上时间），其余走 parseTencentStamp（14 位北京时刻）
  f[30] = /^us/i.test(code) ? '2026-10-16 16:00:01' : '20261017150000'
  f[32] = '1.00'
  f[33] = String(price + 1)
  f[34] = String(price - 2)
  f[35] = `${price}/1000/1000000`
  f[37] = '100'
  f[44] = '10.0'
  f[45] = '20.0'
  return `v_${code}="${f.join('~')}";\n`
}

/** 新浪行情一行（字段布局见 sina.ts 的 `parseSinaHq`） */
function sinaLine(symbol: string, parts: string[]): string {
  return `var hq_str_${symbol}="${parts.join(',')}";\n`
}

/** `nf_*`（44 字段）：下标 8 = 最新、5 = 昨收、2/3/4 = 开高低 */
function sinaFutures(price: number): string[] {
  const p = new Array<string>(44).fill('0')
  p[0] = 'FUT'
  p[1] = '230000'
  p[2] = String(price - 1)
  p[3] = String(price + 1)
  p[4] = String(price - 2)
  p[5] = String(price - 3)
  p[8] = String(price)
  return p
}

/** `gb_*`（美股）：下标 1 = 价、2 = 涨跌幅、5/6/7 = 开高低、10 = 量、12 = 总市值、19 = 股本、26 = 昨收、30 = 成交额 */
function sinaUs(price: number): string[] {
  const p = new Array<string>(36).fill('0')
  p[0] = 'US'
  p[1] = String(price)
  p[2] = '1.00'
  p[3] = '2026-10-16 16:00:01'
  p[4] = '0.5'
  p[5] = String(price - 1)
  p[6] = String(price + 1)
  p[7] = String(price - 2)
  p[10] = '1000'
  p[12] = '1000000'
  p[19] = '500000'
  p[24] = '16:00:01'
  p[26] = String(price - 0.5)
  p[29] = '2026'
  p[30] = '2000000'
  return p
}

function hostOf(url: string): 'em' | 'tencent' | 'sina' | 'other' {
  if (/eastmoney\.com/.test(url)) return 'em'
  if (/gtimg\.cn|qq\.com/.test(url)) return 'tencent'
  if (/sinajs\.cn|sina\.com\.cn|sina\.cn/.test(url)) return 'sina'
  return 'other'
}

/**
 * 装/卸打桩。`prices` 给出各标的的假价（**只用于"可达时能取到"**，不是真值）。
 */
function stubNet(mode: { em?: Mode; tencent?: Mode; sina?: Mode }, prices: Record<string, number> = {}): Net {
  const net: Net = { em: mode.em ?? 'ok', tencent: mode.tencent ?? 'ok', sina: mode.sina ?? 'ok', calls: [] }
  const real = globalThis.fetch
  globalThis.fetch = (async (input: unknown, init?: unknown) => {
    const url = typeof input === 'string' ? input : String((input as { url?: string })?.url ?? input)
    const host = hostOf(url)
    net.calls.push(host)
    if (host === 'em') {
      if (net.em === 'down') {
        const err = new TypeError('fetch failed') as TypeError & { cause?: unknown }
        err.cause = { code: 'UND_ERR_SOCKET' }
        throw err
      }
      const secids = [...url.matchAll(/secids=([^&]*)/g)].map((m) => decodeURIComponent(m[1]))
      const all = secids.flatMap((s) => s.split(',')).filter((s) => s !== '')
      const diff = all.map((secid) => {
        const [mkt, code] = secid.split('.')
        return { f12: code, f13: mkt, f14: `EM_${code}`, f2: prices[secid] ?? 10, f3: 1, f4: 0.1, f18: 9.9 }
      })
      return new Response(JSON.stringify({ data: { diff } }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    if (host === 'tencent') {
      if (net.tencent === 'down') throw new TypeError('fetch failed')
      const q = /q=([^&]*)/.exec(url)?.[1] ?? ''
      const codes = q.split(',').filter((c) => c !== '')
      const body = codes.map((code) => tencentRow(code, priceOfTencentCode(code, prices))).join('')
      return new Response(body, { status: 200 })
    }
    if (host === 'sina') {
      if (net.sina === 'down') throw new TypeError('fetch failed')
      const list = /list=([^&]*)/.exec(url)?.[1] ?? ''
      const body = list.split(',').filter((s) => s !== '').map((sym) => {
        const price = priceOfSinaSymbol(sym, prices)
        if (sym.startsWith('nf_')) return sinaLine(sym, sinaFutures(price))
        if (sym.startsWith('hf_')) return sinaLine(sym, sinaFutures(price))
        if (sym.startsWith('gb_')) return sinaLine(sym, sinaUs(price))
        return sinaLine(sym, sinaFutures(price))
      }).join('')
      return new Response(body, { status: 200 })
    }
    return real(input as never, init as never)
  }) as typeof fetch
  return net
}

/** 腾讯代码 → 假价（按 secid 登记；找不到就给一个固定的非零值，保证"可达 ⇒ 有价"） */
function priceOfTencentCode(code: string, prices: Record<string, number>): number {
  const map: Array<[RegExp, string]> = [
    [/^sh(\d{6})$/, '1.$1'],
    [/^sz(\d{6})$/, '0.$1'],
    [/^hk(\d{5})$/, '116.$1'],
  ]
  for (const [re, secid] of map) {
    const m = re.exec(code)
    if (m !== null) {
      const key = secid.replace('$1', m[1])
      if (prices[key] !== undefined) return prices[key]
    }
  }
  const direct: Record<string, string> = { 'us.INX': '100.SPX', 'us.DJI': '100.DJI', 'us.NDX': '100.NDX', hkHSI: '100.HSI' }
  if (direct[code] !== undefined && prices[direct[code]] !== undefined) return prices[direct[code]]
  if (code.startsWith('us')) {
    const ticker = code.slice(2)
    for (const mkt of ['105', '106', '107']) if (prices[`${mkt}.${ticker}`] !== undefined) return prices[`${mkt}.${ticker}`]
  }
  return 21
}

function priceOfSinaSymbol(sym: string, prices: Record<string, number>): number {
  const direct: Record<string, string> = {
    nf_RB0: '113.rbm', nf_JM0: '114.jmm', nf_M0: '114.mm', nf_LH0: '114.lhm',
    hf_XAU: '122.XAU', hf_HG: '101.HG00Y', hf_SI: '101.SI00Y', hf_OIL: '112.B00Y',
  }
  if (direct[sym] !== undefined && prices[direct[sym]] !== undefined) return prices[direct[sym]]
  if (sym.startsWith('gb_')) {
    const ticker = sym.slice(3).toUpperCase()
    for (const mkt of ['105', '106', '107']) if (prices[`${mkt}.${ticker}`] !== undefined) return prices[`${mkt}.${ticker}`]
  }
  return 32
}

function restoreNet(): void {
  globalThis.fetch = realFetch
}
const realFetch = globalThis.fetch

/** 把全部主机的熔断器复位（熔断状态是模块级的，不清会串到下一个用例） */
function resetBreakers(): void {
  for (const host of ['push2delay.eastmoney.com', 'push2.eastmoney.com', 'push2his.eastmoney.com', 'qt.gtimg.cn', 'hq.sinajs.cn']) {
    breakerFor(host).recordSuccess()
  }
}

// ─────────────────────────── 路由调用脚手架 ────────────────────────────────

interface Captured {
  code: number
  body: Record<string, unknown>
}

async function routes(): Promise<{ call: (path: string, url: string) => Promise<Captured> }> {
  const dir = mkdtempSync(join(tmpdir(), 'tw-degrade-'))
  const store = new DataStore(dir)
  await store.init()
  const list = makeTradeRoutes(
    store,
    [],
    new CalendarStore(dir),
    new RescueMonitor(dir, { enabled: false, intervalSec: 30, tailIntervalSec: 15, tailFrom: '14:30', universe: [] }),
  ).routes
  const find = (path: string): { handler: (req: IncomingMessage, res: ServerResponse) => void } => {
    const route = list.find((r) => r.path === path)
    if (route === undefined) throw new Error(`未找到路由 ${path}`)
    return route as unknown as { handler: (req: IncomingMessage, res: ServerResponse) => void }
  }
  return {
    call: (path, url) =>
      new Promise<Captured>((resolve) => {
        const req = { url, method: 'GET', headers: { host: '127.0.0.1:3080' }, async *[Symbol.asyncIterator]() {} } as unknown as IncomingMessage
        let code = 0
        const res = {
          writeHead(c: number) { code = c },
          end(payload: string) { resolve({ code, body: payload === '' ? {} : (JSON.parse(payload) as Record<string, unknown>) }) },
        } as unknown as ServerResponse
        find(path).handler(req, res)
      }),
  }
}

const quotesUrl = (ids: string): string => `/tradewatcher/quotes?ids=${encodeURIComponent(ids)}`

/** `/quotes` 回包里"这只标的有价" */
function hasPrice(body: Record<string, unknown>, secid: string): boolean {
  const items = (body.items ?? {}) as Record<string, { price?: number | null }>
  const row = items[secid]
  return row !== undefined && typeof row.price === 'number' && row.price > 0
}

// ─────────────────────────── ① 来源优先级 ─────────────────────────────────

test('① 取数顺序：东财默认**最后**（兜底）；只有 emFields 才提前；能力表按品种给', () => {
  resetBreakers()
  const ids = ['1.600519', '116.00700', '105.AAPL', '113.rbm', '171.US10Y', '100.N225']
  const plan = em.quoteSourcePlan(ids)
  assert.deepEqual(plan.order, ['tencent', 'sina', 'em'], '东财必须是兜底（顺序最后一位）')
  // 能力表：每一格都由各源自己的映射函数决定（不另抄一份表）
  assert.deepEqual(plan.coverage['1.600519'], ['tencent', 'em'], 'A股：腾讯有映射、新浪没有')
  assert.deepEqual(plan.coverage['116.00700'], ['tencent', 'em'], '港股：只走腾讯')
  assert.deepEqual(plan.coverage['105.AAPL'], ['tencent', 'sina', 'em'], '美股：腾讯 usX / 新浪 gb_x')
  assert.deepEqual(plan.coverage['113.rbm'], ['sina', 'em'], '国内期货：只走新浪 nf_*')
  assert.deepEqual(plan.coverage['171.US10Y'], ['em'], '国债收益率：只有东财')
  assert.deepEqual(plan.coverage['100.N225'], ['em'], '日经：腾讯没有映射 ⇒ 只有东财')
  // 只有东财覆盖的品种单独列出来（missing 归因要用）
  assert.deepEqual([...plan.emOnly].sort(), ['100.N225', '171.US10Y'])
  // 反例注入：把顺序写回"东财优先" ⇒ 第一条判据必须失败
  const oldPlan = { order: ['em', 'tencent', 'sina'] as const }
  assert.notDeepEqual(oldPlan.order, plan.order, '⚠ 反例（东财优先）必须被本判据判为不等')

  // emFields（护盘 f62/f66、涨跌家数 f104-106）⇒ 东财可以提前
  const emFieldsPlan = em.quoteSourcePlan(['1.600519'], { emFields: true })
  assert.deepEqual(emFieldsPlan.order, ['em', 'tencent', 'sina'], '要东财独占字段时东财先行')
  // 东财在熔断时，即使 emFields 也不能把它提前（提前只会换来一次立刻失败的冷却错误）
  for (const host of ['push2delay.eastmoney.com', 'push2.eastmoney.com']) {
    for (let i = 0; i < 3; i += 1) breakerFor(host).recordFailure(new Error('UND_ERR_SOCKET'))
  }
  assert.equal(em.emQuotesWorthTrying(), false, '两台东财主机都冷却 ⇒ 不值得试')
  assert.deepEqual(em.quoteSourcePlan(['1.600519'], { emFields: true }).order, ['tencent', 'sina', 'em'], '东财冷却时顺序回到兜底')
  resetBreakers()
})

// ─────────────────────────── ② 东财挂、腾讯/新浪活着 ──────────────────────

test('② 东财关闭 + 腾讯可达 ⇒ 路由 200，A股/港股/美股**全部有价**（注入 503/整批失败 ⇒ 必败）', async () => {
  resetBreakers()
  __resetUpstreamHealth()
  const sink = setDegradedSink(() => undefined)
  const net = stubNet({ em: 'down', tencent: 'ok', sina: 'down' }, { '1.600519': 1329, '116.00700': 417.8, '105.AAPL': 343.46 })
  try {
    const h = await routes()
    const out = await h.call('/tradewatcher/quotes', quotesUrl('1.600519,116.00700,105.AAPL'))
    /**
     * 判据：**只要还有源能服务就必须 200**，且三只有价。
     * 这里把判据本身写成一个函数，才能对"注入的旧行为"断言必败。
     */
    const ok200AndPriced = (cap: Captured): boolean =>
      cap.code === 200
      && ['1.600519', '116.00700', '105.AAPL'].every((id) => hasPrice(cap.body, id))
      && cap.body.priced === 3
    assert.equal(ok200AndPriced(out), true, `东财不可达时三只都必须有价（实得 code=${out.code} priced=${String(out.body.priced)}）`)
    assert.ok(net.calls.includes('tencent'), '必须真的走了腾讯')
    const sources = out.body.sources as Record<string, number>
    assert.equal(sources.tencent, 3, '三行的来源都应是腾讯')
    assert.equal(out.body.staleCount, 0, '本轮刚取到的行不算降级复用')

    // ⚠ 反例注入：旧行为（整条路由 503）与"整批失败"都必须被判为不可接受
    assert.equal(ok200AndPriced({ code: 503, body: { error: '上游暂时不可用（熔断中）' } }), false, '⚠ 注入 503 必须判为失败')
    assert.equal(ok200AndPriced({ code: 200, body: { priced: 0, items: {}, missing: [] } }), false, '⚠ 注入"整批失败"必须判为失败')
    assert.equal(ok200AndPriced({ code: 200, body: { priced: 3, items: { '1.600519': { price: 1 } }, missing: [] } }), false, '⚠ 注入"只有一只有价"必须判为失败')
  } finally {
    restoreNet()
    setDegradedSink(sink)
    __resetDegraded()
  }
})

// ─────────────────────────── ③ 只有东财覆盖的品种 ──────────────────────────

test('③ 东财关闭 + 只查东财独占品种 ⇒ 200 + 逐标 missing + 原因（注入 503 ⇒ 必败）', async () => {
  resetBreakers()
  __resetUpstreamHealth()
  const sink = setDegradedSink(() => undefined)
  stubNet({ em: 'down', tencent: 'ok', sina: 'ok' })
  try {
    const h = await routes()
    const ids = ['171.US10Y', '100.N225']
    const out = await h.call('/tradewatcher/quotes', quotesUrl(ids.join(',')))
    const missing = (out.body.missingReasons ?? []) as Array<{ what: string; why: string; note: string }>
    const reasonOk = (cap: Captured): boolean => {
      const ms = (cap.body.missingReasons ?? []) as Array<{ what: string; why: string; note: string }>
      return cap.code === 200
        && cap.body.priced === 0
        && ms.length === 2
        && ms.every((m) => m.why === 'transient' && /只有东财一个行情源/.test(m.note) && /等东财恢复/.test(m.note))
    }
    assert.equal(reasonOk(out), true, `实得：${JSON.stringify(out.body).slice(0, 400)}`)
    assert.deepEqual(missing.map((m) => m.what).sort(), ids.slice().sort(), '每只都必须有一条逐标原因')
    // `missing`（纯 id 列表）保留给客户端既有契约；两者必须覆盖同一批标的
    assert.deepEqual((out.body.missing as string[]).slice().sort(), ids.slice().sort(), 'missing 与 missingReasons 必须覆盖同一批')
    // 逐标原因里必须写清"是哪个上游、为什么等它"
    assert.match(missing[0].note, /东财/)
    // ⚠ 反例注入：抛 503 ⇒ 必败
    assert.equal(reasonOk({ code: 503, body: { error: '上游暂时不可用（熔断中，约 2 分钟后自动重试）' } }), false, '⚠ 注入 503 必须判为失败')
    // ⚠ 反例注入：把缺的标的说成"重试无效"（no-source）⇒ 必败（东财恢复后就会有，说反了）
    assert.equal(reasonOk({ code: 200, body: { priced: 0, missingReasons: ids.map((id) => ({ what: id, why: 'no-source', note: '该品种只有东财一个行情源' })) } }), false, '⚠ why 说反必须判为失败')
  } finally {
    restoreNet()
    setDegradedSink(sink)
    __resetDegraded()
  }
})

// ─────────────────────────── ④ 全源关闭 ───────────────────────────────────

test('④ 所有源关闭 ⇒ 每标的 missing 且**不出现 0 价/假价**（注入 0 或编价 ⇒ 必败）', async () => {
  resetBreakers()
  __resetUpstreamHealth()
  const sink = setDegradedSink(() => undefined)
  stubNet({ em: 'down', tencent: 'down', sina: 'down' })
  try {
    const h = await routes()
    const ids = ['100.KOSPI200', '100.FCHI', '101.HG00Y']
    const out = await h.call('/tradewatcher/quotes', quotesUrl(ids.join(',')))
    const noFake = (cap: Captured): boolean => {
      const items = (cap.body.items ?? {}) as Record<string, { price?: number | null }>
      const ms = (cap.body.missingReasons ?? []) as Array<{ what: string }>
      const ids2 = (cap.body.missing ?? []) as string[]
      const rows = Object.values(items)
      return cap.code === 200
        && cap.body.priced === 0
        && ms.length === ids.length
        && ids2.length === ids.length
        && ids.every((id) => ms.some((m) => m.what === id))
        // 红线：没有价 ⇒ price 必须是 null，**不得是 0**，也不得是任何编出来的数
        && rows.every((r) => r.price === null || r.price === undefined)
    }
    assert.equal(noFake(out), true, `实得：${JSON.stringify(out.body).slice(0, 400)}`)
    // ⚠ 反例注入：0 顶替 ⇒ 必败
    assert.equal(noFake({ code: 200, body: { priced: 0, items: { '100.FCHI': { price: 0 } }, missing: ids, missingReasons: ids.map((what) => ({ what })) } }), false, '⚠ 注入 0 价必须判为失败')
    // ⚠ 反例注入：编一个价（真值未知却给了 1.0）⇒ 必败
    assert.equal(noFake({ code: 200, body: { priced: 0, items: { '100.FCHI': { price: 1 } }, missing: ids, missingReasons: ids.map((what) => ({ what })) } }), false, '⚠ 注入假价必须判为失败')
    // ⚠ 反例注入：把 priced 谎报成 0 但缺 missing ⇒ 必败
    assert.equal(noFake({ code: 200, body: { priced: 0, items: {}, missing: [], missingReasons: [] } }), false, '⚠ 注入"缺 missing"必须判为失败')
  } finally {
    restoreNet()
    setDegradedSink(sink)
    __resetDegraded()
  }
})

// ─────────────────────────── ⑤ sources 统计与实际一致 ──────────────────────

test('⑤ 部分成功时 sources 统计必须与实际行数一致（注入"把失败标的计成功"⇒ 必败）', async () => {
  resetBreakers()
  __resetUpstreamHealth()
  const sink = setDegradedSink(() => undefined)
  stubNet({ em: 'down', tencent: 'ok', sina: 'ok' }, { '0.399001': 11802.46 })
  try {
    const h = await routes()
    // 0.399001 腾讯能取到；171.JP10Y 只有东财 ⇒ 部分成功
    const out = await h.call('/tradewatcher/quotes', quotesUrl('0.399001,171.JP10Y'))
    /**
     * 判据不是"等于某个写死的数字"，而是**自洽**：`sources` 的每一项都等于
     * 回包里 `source` 真是该值的行数，且合计 = rows。这样无论上游怎么变，判据都成立，
     * 而"把失败标的计成功"这类错误一定被抓到。
     */
    const sourcesConsistent = (cap: Captured): boolean => {
      const items = (cap.body.items ?? {}) as Record<string, { source?: string }>
      const sources = (cap.body.sources ?? {}) as Record<string, number>
      const tally: Record<string, number> = {}
      for (const row of Object.values(items)) {
        const key = row.source ?? 'em'
        tally[key] = (tally[key] ?? 0) + 1
      }
      const sum = Object.values(sources).reduce((a, b) => a + b, 0)
      const sameKeys = JSON.stringify(Object.keys(sources).sort()) === JSON.stringify(Object.keys(tally).filter((k) => tally[k] > 0).sort())
      const sameCounts = Object.entries(sources).every(([k, v]) => tally[k] === v)
      return cap.code === 200 && sameKeys && sameCounts && sum === (cap.body.rows as number) && cap.body.priced === 1
    }
    assert.equal(sourcesConsistent(out), true, `实得 ${JSON.stringify({ sources: out.body.sources, rows: out.body.rows, priced: out.body.priced })}`)
    assert.equal((out.body.sources as Record<string, number>).tencent, 1, '有价的那一行必须计在腾讯名下')
    assert.equal(out.body.priced, 1)
    const missing = (out.body.missingReasons ?? []) as Array<{ what: string }>
    assert.deepEqual(missing.map((m) => m.what), ['171.JP10Y'], '缺的只有国债收益率')
    // ⚠ 反例注入：把失败标的也算成成功（tencent: 2）⇒ 必败
    const tampered = { code: 200, body: { ...out.body, sources: { ...(out.body.sources as object), tencent: 2 } } }
    assert.equal(sourcesConsistent(tampered), false, '⚠ 注入"把失败标的计成功"必须判为失败')
    // ⚠ 反例注入：sources 合计与 rows 不等 ⇒ 必败
    assert.equal(sourcesConsistent({ code: 200, body: { ...out.body, rows: 9 } }), false, '⚠ 注入 rows 不等于 sources 合计必须判为失败')
    // ⚠ 反例注入：priced 谎报 ⇒ 必败
    assert.equal(sourcesConsistent({ code: 200, body: { ...out.body, priced: 2 } }), false, '⚠ 注入 priced 谎报必须判为失败')
  } finally {
    restoreNet()
    setDegradedSink(sink)
    __resetDegraded()
  }
})

// ─────────────────────────── ⑥ 日志聚合 ───────────────────────────────────

test('⑥ 同一轮 N 个降级标的只产出**1 行**汇总，逐标的明细降到 debug（注入逐标的 1 行 ⇒ 必败）', () => {
  __resetDegraded()
  const warn: string[] = []
  const debug: string[] = []
  const sink = setDegradedSink((line) => warn.push(line))
  const dbg = setDebugSink((line) => debug.push(line))
  const prevDebug = process.env.TW_DEBUG
  process.env.TW_DEBUG = '1'
  try {
    const N = 27
    for (let i = 0; i < N; i += 1) {
      noteDegraded('kline-cache', {
        label: 'K 线缓存降级采用',
        subject: `1.60000${i}_101_1.json`,
        // 同一个原因重复 N 次 ⇒ 汇总行应写 `×27`
        reason: '未完成 bar 已超过 60s TTL ⇒ 回源重取',
        detail: `1.60000${i}_101_1.json：未完成 bar 已超过 60s TTL ⇒ 回源重取（完整原因 #${i}）`,
      })
    }
    // 聚合窗口还没到：此刻一行都不该输出
    assert.equal(warn.length, 0, '窗口内不得逐条打印（这正是刷屏的成因）')
    assert.deepEqual(pendingDegraded().map((b) => [b.kind, b.count]), [['kline-cache', N]], '桶里应只有 1 个 kind、27 个标的')
    const lines = flushDegraded()
    const oneLine = (ls: string[]): boolean =>
      ls.length === 1
      && /K 线缓存降级采用 27 个/.test(ls[0])
      && /×27/.test(ls[0])
      && /样例：/.test(ls[0])
      && /明细见 debug 级/.test(ls[0])
    assert.equal(oneLine(lines), true, `实得 ${lines.length} 行：${lines.join(' | ').slice(0, 300)}`)
    assert.equal(warn.length, 1, 'sink 只该收到 1 行')
    // 逐标的明细在 debug 级（27 条），且**不在** warn 里
    assert.equal(debug.length, N, 'debug 级应逐标的给明细')
    assert.equal(warn.some((l) => /完整原因 #/.test(l)), false, '逐标的细节不得出现在 warn 级')
    // ⚠ 反例注入：逐标的各 1 行 ⇒ 必败
    const perItem = Array.from({ length: N }, (_, i) => `[tradewatcher] K 线缓存降级采用 1 个（…）；样例：1.60000${i}_101_1.json`)
    assert.equal(oneLine(perItem), false, '⚠ 注入"逐标的各 1 行"必须判为失败')
    // ⚠ 反例注入：并成 1 行但丢掉了"几只/原因"⇒ 必败（这就是信息量丢失）
    assert.equal(oneLine(['[tradewatcher] 降级了']), false, '⚠ 注入"信息不足的一行"必须判为失败')
  } finally {
    if (prevDebug === undefined) delete process.env.TW_DEBUG
    else process.env.TW_DEBUG = prevDebug
    setDegradedSink(sink)
    setDebugSink(dbg)
    __resetDegraded()
  }
})

test('⑥b 未开 TW_DEBUG 时逐标的明细一条都不输出（默认安静）', () => {
  __resetDegraded()
  const warn: string[] = []
  const debug: string[] = []
  const sink = setDegradedSink((line) => warn.push(line))
  const dbg = setDebugSink((line) => debug.push(line))
  const prev = process.env.TW_DEBUG
  delete process.env.TW_DEBUG
  try {
    for (let i = 0; i < 3; i += 1) noteDegraded('kline-cache', { label: 'X', subject: `s${i}`, reason: 'r' })
    flushDegraded()
    assert.equal(warn.length, 1, '汇总行仍然要有')
    assert.equal(debug.length, 0, '没有 TW_DEBUG ⇒ 不打明细')
  } finally {
    if (prev !== undefined) process.env.TW_DEBUG = prev
    setDegradedSink(sink)
    setDebugSink(dbg)
    __resetDegraded()
  }
})

// ─────────────────────────── ⑦ 熔断作用域 ─────────────────────────────────

test('⑦ 熔断按**主机**隔离：东财熔断不得影响腾讯（注入"按路由共用一把闸"⇒ 必败）', async () => {
  resetBreakers()
  __resetUpstreamHealth()
  const sink = setDegradedSink(() => undefined)
  // 连续失败到熔断阈值（threshold=3）
  for (let i = 0; i < 3; i += 1) {
    breakerFor('push2delay.eastmoney.com').recordFailure(new Error('UND_ERR_SOCKET'))
    breakerFor('push2.eastmoney.com').recordFailure(new Error('UND_ERR_SOCKET'))
  }
  stubNet({ em: 'down', tencent: 'ok', sina: 'ok' }, { '1.510300': 4.236 })
  try {
    assert.equal(breakerFor('push2delay.eastmoney.com').allow(), false, '东财必须已熔断')
    // 关键判据：一组主机里"还活着的"必须被如实列出（按主机隔离，不是按路由共用一把闸）
    const alive = hostsAllowed(['push2delay.eastmoney.com', 'push2.eastmoney.com', 'qt.gtimg.cn'])
    assert.deepEqual(alive, ['qt.gtimg.cn'], '东财熔断不能把腾讯一起挡掉')
    // ⚠ 反例注入：共用一把闸（整组 0 台可用）⇒ 必败
    assert.notDeepEqual(alive, [], '⚠ 注入"整组共用一把闸"必须判为不等')
    // 端到端：东财熔断期间，腾讯覆盖的标的仍然有价
    const h = await routes()
    const out = await h.call('/tradewatcher/quotes', quotesUrl('1.510300'))
    assert.equal(out.code, 200)
    assert.equal(hasPrice(out.body, '1.510300'), true, '东财熔断时腾讯必须仍能供价')
  } finally {
    restoreNet()
    setDegradedSink(sink)
    resetBreakers()
    __resetDegraded()
  }
})

// ─────────────────────────── ⑧ 上游健康摘要 ───────────────────────────────

test('⑧ 上游健康摘要：逐主机 lastOk/lastFail/连续失败/熔断，且**零新增请求**', async () => {
  resetBreakers()
  __resetUpstreamHealth()
  const net = stubNet({ em: 'down', tencent: 'ok', sina: 'ok' }, { '1.000300': 4170 })
  try {
    const h = await routes()
    // 1.000300 腾讯能供（成功记账）；171.US10Y 只有东财（失败记账）—— 两条都要走到，摘要才有内容
    await h.call('/tradewatcher/quotes', quotesUrl('1.000300,171.US10Y'))
    const before = net.calls.length
    const health = upstreamHealth([...QUOTE_HOSTS, 'qt.gtimg.cn'])
    assert.equal(net.calls.length, before, '读健康摘要不得发出任何上游请求')
    const byHost = new Map(health.hosts.map((r) => [r.host, r]))
    const emRow = byHost.get('push2delay.eastmoney.com')
    const txRow = byHost.get('qt.gtimg.cn')
    assert.ok(emRow !== undefined && txRow !== undefined)
    assert.ok((emRow?.lastFailAt ?? 0) > 0, '东财必须记到最后一次失败时刻')
    assert.ok((emRow?.consecutiveFails ?? 0) > 0, '东财必须记到连续失败次数')
    assert.equal(emRow?.healthy, false)
    assert.ok((txRow?.lastOkAt ?? 0) > 0, '腾讯必须记到最后一次成功时刻')
    assert.equal(txRow?.healthy, true, '腾讯此刻是健康的')
    assert.equal(txRow?.consecutiveFails, 0)
    // 一行摘要：既能给界面又能进日志
    assert.match(health.line, /上游健康/)
    assert.match(health.line, /qt\.gtimg\.cn/)
    assert.match(health.line, /push2delay\.eastmoney\.com/)
    // 反例注入：摘要若把"刚失败过的主机"写成 ✓ ⇒ 必败
    const lying = `${health.line}`.replace(/push2delay\.eastmoney\.com ✗[^｜]*/, 'push2delay.eastmoney.com ✓ 00:00:00')
    assert.notEqual(lying, health.line, '⚠ 反例（把失败写成成功）必须能被判据改写出差异')
    // 路由层也要能看到（/health 带 upstream）
    const res = await h.call('/tradewatcher/health', '/tradewatcher/health')
    const payload = res.body.upstream as { line?: string; hosts?: unknown[] } | undefined
    assert.ok(payload !== undefined, '/health 必须带 upstream 摘要')
    assert.ok(Array.isArray(payload?.hosts) && (payload?.hosts?.length ?? 0) > 0)
    assert.match(String(payload?.line), /上游健康/)
  } finally {
    restoreNet()
    resetBreakers()
    __resetUpstreamHealth()
    __resetDegraded()
  }
})

// ─────────────────────────── ⑨ 全失败的 5xx 才有"上游 × 范围"───────��───────

test('⑨ 只有"全部来源对全部标的都失败"才 5xx，且消息写清「哪个上游 × 哪个范围」', () => {
  __resetUpstreamHealth()
  noteHostSuccess('qt.gtimg.cn')
  noteHostFailure('push2delay.eastmoney.com', new TypeError('fetch failed'))
  const health = upstreamHealth(['qt.gtimg.cn', 'push2delay.eastmoney.com'])
  assert.equal(health.hosts.length, 2)
  // 部分成功 ⇒ 判据说"该 200"
  const partial = { requested: 3, succeeded: 2 }
  assert.equal(partial.succeeded > 0, true, '有任一标的可用 ⇒ 必须 200')
  // 全失败 ⇒ 允许 5xx，但必须点名上游与范围（这条由 TotalUpstreamError 强制）
  const err = new TotalUpstreamError({
    upstreams: ['东财 push2delay.eastmoney.com'],
    scope: '板块榜单',
    subjects: [],
    reason: 'UND_ERR_SOCKET',
  })
  assert.equal(err.status, 503)
  assert.match(err.message, /东财 push2delay\.eastmoney\.com/, '必须写清哪个上游')
  assert.match(err.message, /板块榜单/, '必须写清哪个范围')
  assert.match(err.message, /UND_ERR_SOCKET/, '必须带上真实原因')
  // 反例注入：只说一句"上游暂时不可用"⇒ 判据必须判为不合格
  const vague = '上游暂时不可用（熔断中，约 2 分钟后自动重试）'
  assert.equal(/东财 push2delay/.test(vague), false, '⚠ 反例（旧消息没点名上游）必须被判为不合格')
  __resetUpstreamHealth()
})
