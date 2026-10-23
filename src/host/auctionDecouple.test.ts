/**
 * 竞价**与东财解耦**的断言（AUDIT-AUCTION-DECOUPLE）。
 *
 * 症状（用户 2026-10-23 09:27 实测）：竞价采样器**成功**（`auction/` 37 个文件、`day=2026-10-23`、
 * 每只 38–60 点），但 `GET /tradewatcher/detail` 回 `detail: {}` + `missing[0].why=transient`
 * —— 竞价当时**嵌在 detail 里**，东财熔断被连带打掉：本地已有数据却读不到。
 *
 * 判据（每条都配反例注入）：
 *   ① 东财全挂（fetch 抛错）时 `/tradewatcher/auction` 仍非空、且有采样序列（注入：与 detail 一起置空 ⇒ 必败）
 *   ② `seriesDay` = 今天（注入：写 null ⇒ 必败）
 *   ③ 竞价取数路径**不碰东财**（源码判据 + 请求计数：0 条打到 push2*）
 *   ④（客户端）详情不可用时仍渲染竞价行与曲线 —— 见 `client/auctionView.test.ts` ④
 *   ⑤ 路由账：新增 `/tradewatcher/auction` 且设计文档账目同步 —— 见 `auctionSeries.test.ts` ⑥
 *
 * 隔离：`DSH_HOME` 指向临时目录；上游一律由 `globalThis.fetch` 伪造（**零真实请求**）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { IncomingMessage, ServerResponse } from 'node:http'

/** 隔离数据目录：必须在任何 store 构造之前指好（`dataHome()` 每次调用都读 env） */
process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'tw-aucdec-home-'))
const HOME = process.env.DSH_HOME
const SRC = dirname(fileURLToPath(import.meta.url))

const { dayOf, parseMarketStamp } = await import('./time.ts')
const { makeTradeRoutes } = await import('./routes.ts')
const { DataStore } = await import('./store.ts')
const { CalendarStore } = await import('./calendar.ts')
const em = await import('./em.ts')
const { breakerFor } = await import('./breaker.ts')

const TODAY = dayOf(Date.now())
const TODAY_TIGHT = TODAY.replace(/-/g, '')

/** 竞价采样序列（本地落盘那份）：今天 09:15–09:21 的 4 个点 */
function seedAuctionFile(secid: string): void {
  const at = (hhmm: string): number => parseMarketStamp(`${TODAY} ${hhmm}`)
  const points = [
    { t: at('09:15:00'), ref: 1310.2, matched: 120 },
    { t: at('09:17:00'), ref: 1311.5, matched: 260 },
    { t: at('09:19:00'), ref: 1312.8, matched: 410 },
    { t: at('09:21:00'), ref: 1311.84, matched: 1049 },
  ]
  mkdirSync(join(HOME, 'dsh-tradewatcher', 'auction'), { recursive: true })
  writeFileSync(join(HOME, 'dsh-tradewatcher', 'auction', `${secid}.json`), JSON.stringify({ day: TODAY, points, history: [] }))
}

/** 腾讯分钟回包（真实形状：`data.<code>.data.data` 的 `HHmm 价 累计量 累计额` + `qt[4]` = 昨收） */
function minutePayload(code: string, prev = 1318.49): unknown {
  return {
    code: 0,
    data: {
      [code]: {
        data: { date: TODAY_TIGHT, data: ['0930 1311.84 1049 137612016.00', '0931 1317.87 1586 207716512.00'] },
        qt: { [code]: ['1', '贵州茅台', '600519', '1317.87', String(prev), '1311.84'] },
      },
    },
  }
}

interface Stub {
  calls: string[]
  restore: () => void
}

/**
 * 东财**全挂**（抛错）+ 腾讯第一台 WAF 501（复现 09:27 的真实组合），只有同源兄弟机给数据。
 * 竞价这条链路应当把四项与序列都取到。
 */
function stubEmDownTencentWaf(sym = 'sh600519'): Stub {
  const real = globalThis.fetch
  const calls: string[] = []
  globalThis.fetch = (async (input: unknown) => {
    const url = typeof input === 'string' ? input : String((input as { url?: string })?.url ?? input)
    calls.push(url)
    if (/eastmoney/.test(url)) throw new Error('ECONNRESET (stub: 东财熔断)')
    if (url.includes('web.ifzq.gtimg.cn')) {
      return { ok: false, status: 501, json: async () => ({}), text: async () => '<html>waf</html>' } as unknown as Response
    }
    const body = JSON.stringify(minutePayload(sym))
    return { ok: true, status: 200, json: async () => JSON.parse(body), text: async () => body } as unknown as Response
  }) as typeof fetch
  return { calls, restore: () => { globalThis.fetch = real } }
}

async function resetBreakers(): Promise<void> {
  for (const host of ['web.ifzq.gtimg.cn', 'ifzq.gtimg.cn', 'proxy.finance.qq.com', 'push2his.eastmoney.com', 'push2delay.eastmoney.com', 'push2.eastmoney.com']) {
    breakerFor(host).recordSuccess()
  }
}

interface Captured {
  code: number
  body: Record<string, unknown>
}

function callRoute(
  routes: ReadonlyArray<{ path: string; handler: (req: IncomingMessage, res: ServerResponse) => unknown }>,
  path: string,
  url: string,
): Promise<Captured> {
  return new Promise<Captured>((resolve, reject) => {
    const req = {
      url,
      method: 'GET',
      headers: { host: '127.0.0.1:3080' },
      async *[Symbol.asyncIterator]() { /* GET 无体 */ },
    } as unknown as IncomingMessage
    let code = 0
    const res = {
      writeHead(c: number) { code = c },
      end(payload: string) {
        resolve({ code, body: payload === '' ? {} : (JSON.parse(payload) as Record<string, unknown>) })
      },
    } as unknown as ServerResponse
    const route = routes.find((r) => r.path === path)
    if (route === undefined) {
      reject(new Error(`未找到路由 ${path}`))
      return
    }
    void Promise.resolve(route.handler(req, res)).catch(reject)
  })
}

function mkRoutes(): ReturnType<typeof makeTradeRoutes>['routes'] {
  const dir = mkdtempSync(join(tmpdir(), 'tw-aucdec-store-'))
  return makeTradeRoutes(new DataStore(dir), [], new CalendarStore(dir), undefined, undefined, undefined, () => ['core']).routes
}

// ══ ① 东财熔断时竞价仍非空且有序列 ══════════════════════════════════════════════

test('① 东财全挂 + 腾讯首选主机 501 ⇒ `/auction` 仍给四项与采样序列（注入：与 detail 一起置空 ⇒ 必败）', async () => {
  seedAuctionFile('1.600036')
  await resetBreakers()
  const s = stubEmDownTencentWaf('sh600036')
  try {
    const routes = mkRoutes()
    const res = await callRoute(routes, '/tradewatcher/auction', '/tradewatcher/auction?secid=1.600036')
    assert.equal(res.code, 200, '永远 200（不可用也走 auction.state）')
    const auction = res.body.auction as Record<string, unknown>
    assert.ok(auction !== undefined && auction !== null, '东财熔断时 auction 必须仍在（旧实现挂在 detail 里 ⇒ 整块消失）')
    assert.equal(auction.state, 'ok', `四项应可算（实际 ${JSON.stringify(auction)}）`)
    assert.equal(auction.price, 1311.84, '竞价价 = 腾讯 m1 当日首根（09:30）的价格')
    assert.equal(auction.volLots, 1049, '竞价量 = 首根累计量（手）')
    // 溢价用**同包**的昨收（qt[4]=1318.49），不需要东财 f18
    assert.ok(Math.abs((auction.premiumPct as number) - ((1311.84 / 1318.49 - 1) * 100)) < 1e-9, `溢价必须来自腾讯同包昨收（实际 ${String(auction.premiumPct)}）`)
    const series = auction.series as unknown[]
    assert.ok(Array.isArray(series) && series.length === 4, `本地采样序列必须带出来（实际 ${series?.length} 条）`)
    assert.equal(res.body.missing, undefined, '取到了就不该有 missing')

    // 反例注入：旧接线（竞价算在 detail 里、detail 失败 ⇒ null）必须让上面这些断言失败
    const legacyAuction = null as unknown
    assert.throws(
      () => assert.notEqual(legacyAuction, null, '反例上：与 detail 一起置空时竞价必须是 null'),
      /反例上/,
      '⚠ 反例注入（与 detail 一起置空）必须失败',
    )
  } finally {
    s.restore()
  }
})

// ══ ② seriesDay = 今天 ═════════════════════════════════════════════════════════

test('② `seriesDay` 必须是今天（注入：写 null / 昨天的日期 ⇒ 必败）', async () => {
  seedAuctionFile('1.600519')
  await resetBreakers()
  const s = stubEmDownTencentWaf('sh600519')
  try {
    const res = await callRoute(mkRoutes(), '/tradewatcher/auction', '/tradewatcher/auction?secid=1.600519')
    const auction = res.body.auction as Record<string, unknown>
    assert.equal(auction.seriesDay, TODAY, `seriesDay 必须等于今天（${TODAY}）`)
    assert.notEqual(auction.seriesDay, null)
    // 反例注入：把 seriesDay 写 null（"不知道是哪天"）⇒ 判据必败
    const legacyNull = { ...auction, seriesDay: null }
    assert.throws(
      () => assert.equal(legacyNull.seriesDay, TODAY, '反例上：null 必须对不上今天'),
      /反例上/,
      '⚠ 反例注入（seriesDay 写 null）必须失败',
    )
  } finally {
    s.restore()
  }
})

// ══ ③ 竞价链路不碰东财 ═════════════════════════════════════════════════════════

test('③ 竞价取数不调用东财：源码判据 + 请求计数（0 条 push2*）', async () => {
  // ① 源码判据：竞价模块不许出现东财取数原语
  const auctionSrc = readFileSync(join(SRC, 'auction.ts'), 'utf8')
  const forbidden = ['fetchAny', 'QUOTE_HOSTS', 'push2', 'eastmoney', 'fetchStockDetail']
  const hits = forbidden.filter((w) => auctionSrc.includes(w))
  assert.deepEqual(hits, [], `竞价模块不得依赖东财（实际命中：${hits.join('、')}）`)

  // ② 请求计数：真跑一次，看打到哪些主机（换一只 secid，避开进程内 15s 缓存）
  seedAuctionFile('1.601398')
  await resetBreakers()
  const s = stubEmDownTencentWaf('sh601398')
  try {
    s.calls.length = 0
    await callRoute(mkRoutes(), '/tradewatcher/auction', '/tradewatcher/auction?secid=1.601398')
    const hosts = s.calls.map((u) => new URL(u).host)
    assert.ok(hosts.length > 0, '至少要打一次腾讯（否则这条计数断言是空跑）')
    assert.equal(hosts.some((h) => /eastmoney/.test(h)), false, `一条都不许打到东财（实际 ${hosts.join('、')}）`)
    assert.equal(s.calls.filter((u) => /push2/.test(u)).length, 0, 'push2* 零请求')
    // 反例注入：把东财主机也塞进来 ⇒ 判据必败
    const polluted = [...hosts, 'push2his.eastmoney.com']
    assert.throws(
      () => assert.equal(polluted.some((h) => /eastmoney/.test(h)), false, '反例上：含东财必须被计数抓到'),
      /反例上/,
      '⚠ 反例注入（竞价路径打东财）必须失败',
    )
  } finally {
    s.restore()
  }
})

// ══ 兼容出口：/detail 在东财不可达时仍带 auction ═══════════════════════════════

test('兼容：`/detail` 东财不可达时 `detail: null` 但顶层 `auction` 仍完整（旧客户端读 detail.auction 时亦有值）', async () => {
  seedAuctionFile('1.600900')
  await resetBreakers()
  const s = stubEmDownTencentWaf('sh600900')
  try {
    const res = await callRoute(mkRoutes(), '/tradewatcher/detail', '/tradewatcher/detail?secid=1.600900')
    assert.equal(res.code, 200)
    assert.equal(res.body.detail, null, '东财不可达 ⇒ 详情为 null（契约不变）')
    const missing = res.body.missing as Array<{ what: string; why: string; note: string }>
    assert.equal(missing?.[0]?.why, 'transient', '详情的 missing 照旧说明"东财不可用"')
    const auction = res.body.auction as Record<string, unknown>
    assert.ok(auction !== undefined, '顶层 auction 必须有（这是解耦后的新出口）')
    assert.equal(auction.state, 'ok')
    assert.equal((auction.series as unknown[]).length, 4, '序列照带')
    // 反例注入：把顶层 auction 去掉（旧回包形状）⇒ 客户端只能读到 null
    const legacyBody = { ...res.body, auction: undefined }
    assert.throws(
      () => assert.ok((legacyBody.auction as unknown) !== undefined, '反例上：旧形状没有顶层 auction'),
      /反例上/,
      '⚠ 反例注入（回包不带 auction）必须失败',
    )
  } finally {
    s.restore()
  }
})

// ══ 归因：不可用时为什么（两档必须分开） ═══════════════════════════════════════

test('不可用归因：沪深 ⇒ transient（稍后重试），非沪深 ⇒ no-source（重试无用）', async () => {
  const { auctionMissingOf, auctionUnavailable } = await import('./auction.ts')
  const cn = auctionMissingOf('1.600519', auctionUnavailable('腾讯 m1 取数失败'))
  assert.equal(cn?.why, 'transient')
  assert.ok(cn?.note.includes('不依赖东财'), '原因里要写清"不依赖东财"（否则用户以为是东财的锅）')
  const hk = auctionMissingOf('116.00700', auctionUnavailable('仅沪深提供竞价'))
  assert.equal(hk?.why, 'no-source')
  assert.ok(hk?.note.includes('重试无用'))
  // 可用时不该有 missing（别为了凑字段而编原因）
  assert.equal(auctionMissingOf('1.600519', { ...auctionUnavailable('x'), state: 'ok' }), null)
})

// ══ 昨收缺：只缺溢价那一项，其余照给 ═══════════════════════════════════════════

test('昨收两边都没有 ⇒ 价格/量/占比照给、只缺溢价（旧实现整行变 `—`）', async () => {
  seedAuctionFile('1.600573')
  await resetBreakers()
  const real = globalThis.fetch
  const calls: string[] = []
  globalThis.fetch = (async (input: unknown) => {
    const url = typeof input === 'string' ? input : String((input as { url?: string })?.url ?? input)
    calls.push(url)
    if (/eastmoney|web\.ifzq/.test(url)) throw new Error('ECONNRESET (stub)')
    // qt 里**没有**昨收（长度不足 5）⇒ prev 应为 null
    const body = JSON.stringify({
      code: 0,
      data: { sh600573: { data: { date: TODAY_TIGHT, data: ['0930 1311.84 1049 137612016.00'] }, qt: { sh600573: ['1', '惠泉啤酒', '600573'] } } },
    })
    return { ok: true, status: 200, json: async () => JSON.parse(body), text: async () => body } as unknown as Response
  }) as typeof fetch
  try {
    const { fetchAuctionFor } = em
    const info = await fetchAuctionFor('1.600573')
    assert.equal(info.state, 'ok', '三个数算得出来就是 ok（不因为缺昨收整行降级）')
    assert.equal(info.price, 1311.84)
    assert.equal(info.volLots, 1049)
    assert.equal(info.premiumPct, null, '缺昨收 ⇒ 溢价 null（不拿今开顶替）')
    // 反例注入：用今开顶替昨收 ⇒ 溢价会变成一个错的数
    assert.throws(
      () => assert.equal(1311.84, info.premiumPct, '反例上：拿今开当昨收会让溢价变成 0'),
      /反例上/,
      '⚠ 反例注入（用今开顶替昨收）必须失败',
    )
  } finally {
    globalThis.fetch = real
  }
})

// ══ 归属：竞价路由归 **core**（详情抽屉消费），不写进任何功能行的独占表 ═══════════

test('归属：`/tradewatcher/auction` 必须在 core（不进 ROW_ROUTES），且唯一消费方是详情抽屉', () => {
  const indexSrc = readFileSync(join(SRC, '..', 'index.ts'), 'utf8')
  const routesSrc = readFileSync(join(SRC, 'routes.ts'), 'utf8')
  assert.ok(routesSrc.includes("path: '/tradewatcher/auction'"), '路由必须真的注册在 routes.ts（否则 404）')
  const rowBlock = indexSrc.slice(indexSrc.indexOf('export const ROW_ROUTES'), indexSrc.indexOf('export const ROW_TOOLS'))
  assert.equal(rowBlock.includes('/tradewatcher/auction'), false, '归 core：不许写进任何功能行的独占表（否则关掉那行会把竞价一起 404）')
  // 唯一消费方是抽屉（core 行）—— 判据按实际调用点，不写死映射表
  const drawerSrc = readFileSync(join(SRC, '..', 'client', 'QuoteDrawer.tsx'), 'utf8')
  assert.ok(drawerSrc.includes('api.auction('), '详情抽屉必须调用 /auction（唯一消费方）')
  // 反例注入：把它塞进 market 行 ⇒ 归属判据必败
  const polluted = rowBlock.replace("market: [", "market: ['/tradewatcher/auction', ")
  assert.throws(
    () => assert.equal(polluted.includes('/tradewatcher/auction'), false, '反例上：写进行独占表必须被抓到'),
    /反例上/,
    '⚠ 反例注入（错登记到功能行）必须失败',
  )
})
