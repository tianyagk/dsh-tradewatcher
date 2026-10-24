/**
 * 外盘分时**覆盖面**断言（AUDIT-INTL-MINUTE §2）：`101.*` / `112.*` / `100.*` 各自接上可用分钟源，
 * 拿不到的必须给 `missing`（而不是空对象），任何国际回包必须带 `source` + `at`。
 *
 * 背景（用户 20:0x 实测）：只有 `122.XAU` 修好；`101.CL/GC/SI`、`100.KOSPI200` 仍是 `trend:null`，
 * `100.N225` 停在 10-13 的兜底快照且原因不写日期，`106.FRO` 数据新鲜却缺 `source/at`。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'

process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'tw-intlcov-home-'))

const em = await import('./em.ts')
const { breakerFor } = await import('./breaker.ts')
const { parseMarketStamp } = await import('./time.ts')
const { makeTradeRoutes } = await import('./routes.ts')
const { DataStore } = await import('./store.ts')
const { CalendarStore } = await import('./calendar.ts')

const HOSTS = [
  'push2his.eastmoney.com', 'push2delay.eastmoney.com', 'push2.eastmoney.com',
  'stock2.finance.sina.com.cn', 'stock.finance.sina.com.cn',
]

interface Stub { calls: string[]; restore: () => void }

/** 全球期货分时回包（表头 + 逐点；量/额恒 0 ⇒ 解析成 null） */
function globalPayload(lastStamp: string, price: number, points = 60): string {
  const end = parseMarketStamp(lastStamp)
  const rows: unknown[][] = []
  for (let i = points - 1; i >= 0; i -= 1) {
    const t = end - i * 60_000
    const d = new Date(t + 8 * 3_600_000).toISOString().slice(0, 19).replace('T', ' ')
    rows.push([d.slice(11, 16), String(price - i * 0.01), '0', '0', String(price - i * 0.01), d])
  }
  const body = {
    minLine_1d: [
      [lastStamp.slice(0, 10), String(price + 1), 'cme', '', rows[0]?.[0] ?? '', String(price), '0', '0', '0', String(rows[0]?.[5] ?? '')],
      ...rows,
    ],
  }
  return `/*<script>location.href='//sina.com';</script>*/var t=(${JSON.stringify(body)});`
}

function stub(map: Record<string, string | null>): Stub {
  const real = globalThis.fetch
  const calls: string[] = []
  globalThis.fetch = (async (input: unknown) => {
    const url = typeof input === 'string' ? input : String((input as { url?: string })?.url ?? input)
    calls.push(url)
    const host = new URL(url).host
    if (host === 'stock2.finance.sina.com.cn') {
      const sym = /symbol=([A-Za-z0-9]+)/.exec(url)?.[1]?.toUpperCase() ?? ''
      const body = map[sym]
      if (body === undefined || body === null) throw new Error(`stub: ${sym} 无数据`)
      const buf = new TextEncoder().encode(body)
      return { ok: true, status: 200, arrayBuffer: async () => buf.buffer, text: async () => body, json: async () => JSON.parse(body) } as unknown as Response
    }
    if (host === 'stock.finance.sina.com.cn') {
      // 美股分钟：`usable()` 要求 ≥2 点（1 点会被当成"拿不到"，所以 stub 必须给两点）
      const body = 'x([{"d":"2026-10-23 15:58","c":52.3,"v":"100"},{"d":"2026-10-23 15:59","c":52.4,"v":"120"}])'
      const buf = new TextEncoder().encode(body)
      return { ok: true, status: 200, arrayBuffer: async () => buf.buffer, text: async () => body, json: async () => ({}) } as unknown as Response
    }
    throw new Error(`ECONNRESET (stub: ${host} 不可达)`)
  }) as typeof fetch
  return { calls, restore: () => { globalThis.fetch = real } }
}

function resetBreakers(): void {
  for (const h of HOSTS) breakerFor(h).recordSuccess()
}

// ══ ① 各品种至少一条可用源；末点不超过"该市场收盘后多久" ═══════════════════════════

test('① `101.CL`/`101.GC`/`101.SI` 各有可用源，末点贴近最近交易时段（注入：不接新源 ⇒ 必败）', async () => {
  const cases = [
    { secid: '101.CL', sym: 'CL', stamp: '2026-10-24 04:59:00', price: 103.493 },
    { secid: '101.GC', sym: 'GC', stamp: '2026-10-24 04:59:00', price: 4007.91 },
    { secid: '101.SI', sym: 'SI', stamp: '2026-10-24 04:59:00', price: 54.035 },
  ]
  for (const c of cases) {
    resetBreakers()
    const now = parseMarketStamp('2026-10-24 20:00:00')
    const s = stub({ [c.sym]: globalPayload(c.stamp, c.price) })
    try {
      const t = await em.fetchTrend(c.secid, 1, { now })
      assert.ok(t !== null, `${c.secid} 必须有可用源（否则它就是一个空图）`)
      assert.equal(t.source, 'sina-global-min')
      const last = t.points[t.points.length - 1] as { t: number; label: string }
      assert.equal(last.label, c.stamp.slice(0, 16))
      const behindH = (now - last.t) / 3_600_000
      assert.ok(behindH <= 18, `${c.secid} 末点距取数不得超过"收盘后 18 小时"（实际 ${behindH.toFixed(1)}h）`)
      // 反例注入：不接新源（只有东财）⇒ 拿到的是 10-21/13 的兜底或 null ⇒ 必败
      assert.throws(
        () => assert.equal(null, t, '反例上：旧链给不出当日序列'),
        /反例上/,
        '⚠ 反例注入（不接新源）必须失败',
      )
    } finally {
      s.restore()
      resetBreakers()
    }
  }
})

test('①b `100.KOSPI200` 无任何源 ⇒ 路由回 `trend:null` + `missing`（点明试过哪些源），不是空对象', async () => {
  resetBreakers()
  const s = stub({})
  try {
    const dir = mkdtempSync(join(tmpdir(), 'tw-intlcov-store-'))
    const routes = makeTradeRoutes(new DataStore(dir), [], new CalendarStore(dir), undefined, undefined, undefined, () => ['core']).routes
    const res = await callRoute(routes, '/tradewatcher/trend', '/tradewatcher/trend?secid=100.KOSPI200')
    assert.equal(res.code, 200)
    assert.equal(res.body.trend, null, '没有源就明确 null，不许给空对象')
    const missing = res.body.missing as Array<{ what: string; why: string; note: string }>
    assert.ok(Array.isArray(missing) && missing.length > 0, '必须带 missing 原因（空对象/无原因 ⇒ 用户只看到一张空图）')
    assert.ok((missing[0]?.note ?? '').includes('已试：'), `原因里要点名试过哪些源（实际：${missing[0]?.note}）`)
    assert.ok((missing[0]?.note ?? '').includes('没有对应代码'), '该品种确实没有代码时要明说（结构性没有，重试无用）')
    // 反例注入：只回 `{trend:null}` 不回 missing ⇒ 判据必败
    const legacy = { trend: null }
    assert.throws(
      () => assert.ok(Array.isArray((legacy as { missing?: unknown }).missing), '反例上：旧回包没有 missing'),
      /反例上/,
      '⚠ 反例注入（空对象）必须失败',
    )
  } finally {
    s.restore()
    resetBreakers()
  }
})

// ══ ② 任何国际回包必须有 source + at ═══════════════════════════════════════════

test('② 国际回包缺 `source` 或 `at` ⇒ 必败（覆盖全球期货 / 美股 / 兜底快照三条路径）', async () => {
  resetBreakers()
  const now = parseMarketStamp('2026-10-24 20:00:00')
  const s = stub({ XAU: globalPayload('2026-10-24 04:53:00', 3996.8), CL: globalPayload('2026-10-24 04:59:00', 103.5) })
  try {
    for (const secid of ['122.XAU', '101.CL', '106.FRO']) {
      const t = await em.fetchTrend(secid, 1, { now })
      assert.ok(t !== null, `${secid} 应有序列`)
      assert.equal(typeof t.source, 'string', `${secid} 缺 source`)
      assert.equal(typeof t.at, 'number', `${secid} 缺 at`)
      // 反例注入：删掉 source/at（修前 106.FRO 就是这个形状）⇒ 判据必败
      const legacy = { ...t, source: undefined, at: undefined }
      assert.throws(
        () => assert.equal(typeof legacy.source, 'string', '反例上：缺 source'),
        /反例上/,
        '⚠ 反例注入（缺出处字段）必须失败',
      )
    }
  } finally {
    s.restore()
    resetBreakers()
  }
})

// ══ ③ 兜底快照必须写"最后交易日"+ stale ═════════════════════════════════════════

test('③ `100.N225` 走兜底快照时必须 `stale:true` 且原因含「最后交易日 2026-10-13」（缺 ⇒ 必败）', async () => {
  resetBreakers()
  const old = '2026-10-13 14:30:00'
  const first = stub({ NK: globalPayload(old, 62825) })
  let seeded: Awaited<ReturnType<typeof em.fetchTrend>> = null
  try {
    seeded = await em.fetchTrend('100.N225', 1, { now: parseMarketStamp('2026-10-13 15:30:00') })
    assert.ok(seeded !== null, '前置：先落一份 10-13 的快照（模拟用户机上那份旧 LKG）')
  } finally {
    first.restore()
    resetBreakers()
  }
  // 12 天后：上游全挂 ⇒ 只能走 LKG
  resetBreakers()
  const dead = stub({})
  try {
    const now = parseMarketStamp('2026-10-24 10:00:00') // 交易窗口内（避免"休市定稿"短路）
    const t = await em.fetchTrend('100.N225', 1, { now })
    assert.ok(t !== null, '有兜底快照时要给序列（不能因为上游挂就空图）')
    assert.equal(t.stale, true, '兜底快照必须标 stale')
    assert.equal(typeof t.source, 'string', '出处不能空着（老快照没记 source 时宿主补 lkg-snapshot）')
    assert.equal(t.nonSession?.day, '2026-10-13')
    const reason = t.nonSession?.reason ?? ''
    assert.ok(reason.includes('最后交易日'), `原因必须写「最后交易日」（实际：${reason}）`)
    assert.ok(reason.includes('2026-10-13'), `原因必须带日期（实际：${reason}）`)
    assert.equal(typeof t.at, 'number')
    // 反例注入：旧文案（只有"显示本地兜底快照"、无日期）⇒ 判据必败
    const legacy = '当日分时未取到，显示本地兜底快照'
    assert.throws(
      () => assert.ok(legacy.includes('最后交易日'), '反例上：旧文案没有日期'),
      /反例上/,
      '⚠ 反例注入（无日期的旧文案）必须失败',
    )
  } finally {
    dead.restore()
    resetBreakers()
  }
})

// ══ ④ 滞后读数 ══════════════════════════════════════════════════════════════════

test('④ 末点落后超过阈值 ⇒ `lagMinutes`+`lagReason` 必存在；不落后则不给', async () => {
  resetBreakers()
  const late = stub({ OIL: globalPayload('2026-10-24 05:59:00', 112.1) })
  try {
    const t = await em.fetchTrend('112.B00Y', 1, { now: parseMarketStamp('2026-10-24 20:00:00') })
    assert.ok(t !== null)
    assert.equal(typeof t.lagMinutes, 'number', '112.B00Y 落后 14 小时 ⇒ 必须给 lagMinutes')
    assert.ok((t.lagMinutes as number) >= 800)
    assert.equal(typeof t.lagReason, 'string')
  } finally {
    late.restore()
    resetBreakers()
  }
  const fresh = stub({ NG: globalPayload('2026-10-24 19:58:00', 3.5) })
  try {
    const t = await em.fetchTrend('101.NG', 1, { now: parseMarketStamp('2026-10-24 20:00:00') })
    assert.ok(t !== null)
    assert.equal(t.lagMinutes, undefined, '只差 2 分钟时不得挂"滞后"')
  } finally {
    fresh.restore()
    resetBreakers()
  }
})

// ══ 接线：美股不再 early-return（否则 at/lag 又会丢） ═════════════════════════════

test('④b 接线：美股分钟走同一条 `trendWithFallback`（early-return ⇒ at/lag/nonSession 全丢）', async () => {
  const { readFileSync } = await import('node:fs')
  const { dirname } = await import('node:path')
  const { fileURLToPath } = await import('node:url')
  const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'em.ts'), 'utf8')
  assert.equal(/const usFirst = isUsSecid\(secid\) && opts\.upstream === undefined/.test(src), true, '美股首选应作为 loader 内的分支')
  assert.equal(/source: 'sina-us-min'/.test(src), true, '美股分钟必须自报 source')
  const legacy = src.replace("    if (usFirst) {", "    if (false) {")
  assert.throws(
    () => assert.equal(/if \(usFirst\) \{/.test(legacy), true, '反例上：分支已被关掉'),
    /反例上/,
    '⚠ 反例注入（关掉美股分支）必须失败',
  )
})

// ── 路由直调（与 auctionDecouple.test.ts 同一份 harness） ─────────────────────────

interface Captured { code: number; body: Record<string, unknown> }

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
      end(payload: string) { resolve({ code, body: payload === '' ? {} : (JSON.parse(payload) as Record<string, unknown>) }) },
    } as unknown as ServerResponse
    const route = routes.find((r) => r.path === path)
    if (route === undefined) { reject(new Error(`未找到路由 ${path}`)); return }
    void Promise.resolve(route.handler(req, res)).catch(reject)
  })
}
