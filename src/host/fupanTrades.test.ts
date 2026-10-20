/**
 * 复盘行（第 8 行 `fupan`）「持仓交易记录」宿主侧断言集（`fupanTrades.ts` + `/tradewatcher/fupan/trades`）。
 *
 * 八条判据 + 读取失败口径（每条都配**反例注入**，证明断言不是恒真）：
 *   ① 只计入 buy/sell/adjust —— 建仓/移除/改名等记账动不得出现在逐笔里；
 *   ② 归属日 = `ts` 的**北京日**（UTS 23:30 与 00:30 落在不同北京日；用宿主/UTC 日会串日）；
 *   ③ 当日盈亏**取持仓核算值**（按逐笔重算会得到另一个数）；
 *   ④ 算不出 ⇒ `null` + 原因（写 0 会被读成"今天没赚没亏"）；
 *   ⑤ 单日 600 笔 ⇒ `truncated {shown:500,total:600}`；
 *   ⑥ 同日结果缓存 60 秒 + **流水落盘后立刻失效**（无缓存/永不失效都要被抓到）；
 *   ⑦ 零新增上游请求（运行时 fetch 计数 + 源码判据）；
 *   ⑧ 路由归属 = `fupan`（塞进 core/其它行必败）。
 * 另：流水读不到 ⇒ HTTP 200 + `trades: []`（用户口径：界面按 0 笔处理），但回包**仍带** `readFailed`。
 *
 * 隔离：`DSH_HOME` 指向临时目录；不碰用户 `~/.dsh`。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { LedgerEntry, LedgerVerb, PortfolioView } from '../shared/model.ts'
import { CalendarStore } from './calendar.ts'
import * as em from './em.ts'
import { FupanStore } from './fupan.ts'
import {
  FUPAN_TRADES_MAX,
  FUPAN_TRADE_VERBS,
  __fupanTradesStats,
  __resetFupanTradesCache,
  accountingDayPnl,
  fupanTradesCached,
  readFupanTrades,
  tradesOfDay,
} from './fupanTrades.ts'
import { assemblePortfolio } from './portfolio.ts'
import { makeTradeRoutes } from './routes.ts'
import { DataStore } from './store.ts'
import { dayOf } from './time.ts'

process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'tw-fupan-trades-home-'))
const SRC = dirname(fileURLToPath(import.meta.url))
/** 当日盈亏恒按"今天"（持仓核算用的是 `Date.now()`），所以测试也按今天的北京日取数 */
const TODAY = dayOf(Date.now())
const BJ = (s: string): number => Date.parse(s)

// ─────────────────────────────── 夹具 ───────────────────────────────

interface Fixture {
  ledger?: LedgerEntry[]
  groups?: unknown[]
  items?: unknown[]
  /** `ledger.json` 建成**目录**（读失败注入：EISDIR） */
  ledgerAsDir?: boolean
}

const GROUP = { id: 'pg1', name: '底仓', order: 0 }
function pos(id: string, secid: string, name: string): unknown {
  return { id, groupId: GROUP.id, secid, name, createdAt: 1 }
}

function entry(over: Partial<LedgerEntry> & { id: string; ts: number; verb: LedgerVerb }): LedgerEntry {
  return { actor: 'web', ...over }
}

function makeDir(fixture: Fixture = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'tw-fupan-trades-'))
  if (fixture.ledgerAsDir === true) mkdirSync(join(dir, 'ledger.json'))
  else if (fixture.ledger !== undefined) writeFileSync(join(dir, 'ledger.json'), JSON.stringify({ v: 1, entries: fixture.ledger }))
  if (fixture.groups !== undefined) {
    writeFileSync(join(dir, 'positions.json'), JSON.stringify({ v: 1, groups: fixture.groups, items: fixture.items ?? [] }))
  }
  return dir
}

interface Captured {
  code: number
  body: Record<string, unknown>
}

interface Harness {
  dir: string
  store: DataStore
  call(path: string, url: string, init?: { method?: string; body?: string }): Promise<Captured>
  close(): void
}

async function harness(fixture: Fixture = {}): Promise<Harness> {
  const dir = makeDir(fixture)
  const store = new DataStore(dir)
  await store.init()
  const routes = makeTradeRoutes(
    store,
    [],
    new CalendarStore(dir),
    undefined,
    undefined,
    undefined,
    () => ['core', 'fupan'],
    new FupanStore(dir),
  ).routes
  const call = (path: string, url: string, init: { method?: string; body?: string } = {}): Promise<Captured> =>
    new Promise<Captured>((resolve) => {
      const body = init.body
      const req = {
        url,
        method: init.method ?? 'GET',
        headers: { host: '127.0.0.1:3080', ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
        async *[Symbol.asyncIterator]() {
          if (body !== undefined) yield Buffer.from(body)
        },
      } as unknown as IncomingMessage
      let code = 0
      const res = {
        writeHead(c: number) {
          code = c
        },
        end(payload: string) {
          resolve({ code, body: payload === '' ? {} : (JSON.parse(payload) as Record<string, unknown>) })
        },
      } as unknown as ServerResponse
      const route = routes.find((r) => r.path === path)
      if (route === undefined) throw new Error(`未找到路由 ${path}`)
      void route.handler(req, res)
    })
  return { dir, store, call, close: () => rmSync(dir, { recursive: true, force: true }) }
}

/** 行情打桩：只答腾讯快照，其余一律当离线（顺便计数"有没有为这条路由发请求"） */
function stubQuotes(prices: Record<string, { price: number; prev: number }>): { count: () => number; restore: () => void } {
  const original = globalThis.fetch
  let calls = 0
  globalThis.fetch = (async (input: unknown) => {
    const url = typeof input === 'string' ? input : String((input as { url?: string })?.url ?? input)
    if (!url.includes('qt.gtimg.cn')) throw new TypeError('offline (test)')
    calls += 1
    const q = /q=([^&]*)/.exec(url)?.[1] ?? ''
    const body = q
      .split(',')
      .filter((c) => c !== '')
      .map((code) => {
        const hit = prices[code]
        const f = new Array<string>(80).fill('')
        f[1] = `NAME_${code.toUpperCase()}`
        f[2] = code
        f[3] = String(hit?.price ?? 0)
        f[4] = String(hit?.prev ?? 0)
        f[5] = String(hit?.price ?? 0)
        f[6] = '1000'
        f[30] = '20261020113000'
        f[32] = '1.00'
        f[33] = String(hit?.price ?? 0)
        f[34] = String(hit?.price ?? 0)
        f[35] = `${hit?.price ?? 0}/1000/1000000`
        return `v_${code}="${f.join('~')}";`
      })
      .join('')
    return new Response(body, { status: 200 })
  }) as typeof fetch
  return {
    count: () => calls,
    restore: () => {
      globalThis.fetch = original
    },
  }
}

// ─────────────────────────────── 判据（供断言与反例注入共用） ───────────────────────────────

/** ① 方向过滤：逐笔方向必须**恰好**是 buy/sell/adjust */
export function verbFilterProblems(sides: readonly string[]): string[] {
  const bad: string[] = []
  const allowed = new Set<string>(FUPAN_TRADE_VERBS)
  for (const s of sides) if (!allowed.has(s)) bad.push(`逐笔里出现了不计入的方向 ${s}（建仓/移除/改名不属于交易记录）`)
  for (const v of FUPAN_TRADE_VERBS) if (!sides.includes(v)) bad.push(`该日明明有 ${v} 却没出现在逐笔里`)
  return bad
}

/** ③ 当日盈亏必须取持仓核算值，且必须与"按逐笔重算"不同 */
export function pnlSourceProblems(o: { dayPnl: unknown; accounting: unknown; naive: unknown }): string[] {
  const bad: string[] = []
  if (o.dayPnl !== o.accounting) bad.push(`当日盈亏必须取持仓核算值 ${JSON.stringify(o.accounting)}（实得 ${JSON.stringify(o.dayPnl)}）`)
  if (o.dayPnl === o.naive) bad.push('当日盈亏与"按逐笔重算"相同 ⇒ 说明没走持仓核算（两者本该不同）')
  return bad
}

/** ④ 算不出 ⇒ null + 原因（0 会被读成"今天没赚没亏"） */
export function pnlMissingProblems(p: { dayPnl?: unknown; dayPnlReason?: unknown }): string[] {
  const bad: string[] = []
  if (p.dayPnl !== null) bad.push(`算不出时 dayPnl 必须是 null（实得 ${JSON.stringify(p.dayPnl)}）`)
  if (typeof p.dayPnlReason !== 'string' || p.dayPnlReason.trim() === '') bad.push('算不出时必须给 dayPnlReason')
  return bad
}

/** ⑤ 截断：shown 必须是 min(total, 上限) */
export function truncationProblems(o: { total: number; shown: number }): string[] {
  const bad: string[] = []
  const want = Math.min(o.total, FUPAN_TRADES_MAX)
  if (o.shown !== want) bad.push(`shown 必须是 min(total, ${FUPAN_TRADES_MAX})（total=${o.total} ⇒ 应 ${want}，实得 ${o.shown}）`)
  return bad
}

/** ⑥ 缓存：60 秒内重复读只构建 1 次；流水落盘后缓存必须没了、下次读重新构建 1 次 */
export function cacheProblems(o: { readsWithinTtl: number; cachedAfterWrite: boolean; readsAfterWrite: number }): string[] {
  const bad: string[] = []
  if (o.readsWithinTtl !== 1) bad.push(`60 秒内读两次应只构建 1 次（实得 ${o.readsWithinTtl}：2 = 没缓存，0 = 根本没读）`)
  if (o.cachedAfterWrite) bad.push('流水落盘后缓存必须立即清空（还在 ⇒ 失效钩子没挂上写路径）')
  if (o.readsAfterWrite !== 1) bad.push(`写后首次读必须重新构建 1 次（实得 ${o.readsAfterWrite}：0 = 永不失效）`)
  return bad
}

/** ⑦ 零上游请求（运行时计数） */
export function upstreamProblems(fetchCount: number): string[] {
  return fetchCount === 0 ? [] : [`复盘交易记录必须零上游请求（实测发了 ${fetchCount} 次 fetch）`]
}

/** ⑦ 零上游请求（源码判据：只允许 `em.peekQuotes` 这条本地读出口） */
export function upstreamSourceProblems(hostSrc: string, handler: string): string[] {
  const bad: string[] = []
  const scan = (label: string, text: string): void => {
    if (/\bfetch\s*\(/.test(text)) bad.push(`${label} 出现 fetch(...)`)
    if (/\bem\.(?!peekQuotes\b)\w+\s*\(/.test(text)) bad.push(`${label} 调用了 em 的取数出口（只允许 em.peekQuotes = 纯本地读）`)
    if (/\bawait\s+em\b/.test(text)) bad.push(`${label} await 了 em`)
    if (/\bloadQuoteRowsShared\b|\bfetchQuotesDetailed\b/.test(text)) bad.push(`${label} 引入共享取数入口（会打上游）`)
  }
  scan('src/host/fupanTrades.ts', hostSrc)
  scan('/tradewatcher/fupan/trades', handler)
  return bad
}

/** ⑧ 归属：该路由必须只在 `fupan` 行 */
export function ownershipProblems(indexSrc: string): string[] {
  const rows = [...indexSrc.matchAll(/\n {2}([a-z]+): \[([^\]]*)\]/g)].map((m) => ({
    row: m[1] as string,
    routes: [...(m[2] as string).matchAll(/'([^']+)'/g)].map((x) => x[1] as string),
  }))
  const target = '/tradewatcher/fupan/trades'
  const holders = rows.filter((r) => r.routes.includes(target)).map((r) => r.row)
  const bad: string[] = []
  if (!holders.includes('fupan')) bad.push(`${target} 未声明在 fupan 行（core 会兜底注册 ⇒ 复盘行关不掉）`)
  for (const h of holders) if (h !== 'fupan') bad.push(`${target} 同时声明在 ${h} 行`)
  return bad
}

/** 月历笔数：每一天都必须带 `trades`（数字），且与期望逐日相等 */
export function monthCountsProblems(
  dates: ReadonlyArray<{ date: string; trades?: unknown }>,
  expect: Record<string, number>,
): string[] {
  const bad: string[] = []
  for (const d of dates) {
    if (typeof d.trades !== 'number') {
      bad.push(`${d.date} 没有 trades（不是 number：${JSON.stringify(d.trades)}）—— 不填会让月历把"有交易"看成"没有"`)
      continue
    }
    const want = expect[d.date] ?? 0
    if (d.trades !== want) bad.push(`${d.date} 笔数 ${d.trades} ≠ 期望 ${want}`)
  }
  return bad
}

/** 月历读失败：每格必须是 `null`（0 会被读成"那天没有交易"） */
export function monthReadFailProblems(dates: ReadonlyArray<{ date: string; trades?: unknown }>): string[] {
  return dates.filter((d) => d.trades !== null).map((d) => `${d.date} 读不到时必须为 null（实得 ${JSON.stringify(d.trades)}）`)
}

/** 月历笔数 × 逐日明细：同一天两条路由必须同数 */
export function crossCountProblems(pairs: ReadonlyArray<{ day: string; month: unknown; daily: unknown }>): string[] {
  const bad: string[] = []
  for (const p of pairs) {
    if (p.month !== p.daily) bad.push(`${p.day}：月历 ${JSON.stringify(p.month)} ≠ 逐日 ${JSON.stringify(p.daily)}（两条路由各算一套口径）`)
  }
  return bad
}

/** 读取失败口径：HTTP 200 + 0 笔 + `readFailed` 仍在 */
export function readFailProblems(res: { code: number; body: Record<string, unknown> }): string[] {
  const bad: string[] = []
  if (res.code !== 200) bad.push(`读取失败必须仍回 200（实得 ${res.code}：抛错会让界面空掉，用户要的是 0 笔）`)
  if (!Array.isArray(res.body.trades)) bad.push('trades 必须是数组')
  else if ((res.body.trades as unknown[]).length !== 0) bad.push('读取失败时 trades 必须是空数组')
  if (res.body.total !== 0) bad.push('读取失败时 total 必须是 0')
  if (res.body.readFailed !== true) bad.push('读取失败必须**仍然**在回包里标 readFailed: true（数据层不许撒谎）')
  if (typeof res.body.readFailedReason !== 'string' || (res.body.readFailedReason as string).trim() === '') bad.push('必须给 readFailedReason')
  if (res.body.dayPnl !== null) bad.push('读取失败时 dayPnl 必须是 null（不是 0）')
  return bad
}

/** 从 routes.ts 切出某条路由的 handler 段（到下一条 `kind:` 为止） */
function handlerSource(routesSrc: string, path: string): string {
  const at = routesSrc.indexOf(`path: '${path}'`)
  if (at < 0) return ''
  const next = routesSrc.indexOf("kind: 'exact'", at + path.length + 1)
  return routesSrc.slice(at, next < 0 ? routesSrc.length : next)
}

// ─────────────────────────────── ① 方向过滤 ───────────────────────────────

test('① 逐笔只含 buy/sell/adjust：建仓/移除/改名/笔记等记账动作不出现在交易记录里', async () => {
  const at = BJ('2026-10-19T10:00:00+08:00')
  const ledger = [
    entry({ id: 'l-buy', ts: at, verb: 'buy', name: '贵州茅台', qty: 100, price: 1680, fee: 5 }),
    entry({ id: 'l-sell', ts: at + 60_000, verb: 'sell', name: '贵州茅台', qty: 20, price: 1700, fee: 5 }),
    entry({ id: 'l-adjust', ts: at + 120_000, verb: 'adjust', name: '贵州茅台', qty: 5 }),
    entry({ id: 'l-add', ts: at + 180_000, verb: 'add', name: '贵州茅台' }),
    entry({ id: 'l-remove', ts: at + 240_000, verb: 'remove', name: '贵州茅台' }),
    entry({ id: 'l-rename', ts: at + 300_000, verb: 'grename', name: '底仓' }),
    entry({ id: 'l-note', ts: at + 360_000, verb: 'pnote', name: '贵州茅台', note: '备注' }),
  ]
  const h = await harness({ ledger })
  try {
    const res = await h.call('/tradewatcher/fupan/trades', '/tradewatcher/fupan/trades?day=2026-10-19')
    assert.equal(res.code, 200)
    const trades = res.body.trades as Array<{ ledgerId: string; side: string }>
    assert.deepEqual(verbFilterProblems(trades.map((t) => t.side)), [])
    assert.deepEqual(trades.map((t) => t.ledgerId), ['l-buy', 'l-sell', 'l-adjust'], '按时序升序，且只这三条')
    assert.equal(res.body.total, 3)
    assert.equal((res.body.summary as { count: number }).count, 3)
    // 反例注入：不分方向（全量返回）⇒ 必败
    const all = ledger.map((e) => e.verb)
    assert.notDeepEqual(verbFilterProblems(all), [], '⚠ 反例（全量返回，含 add/remove/grename/pnote）必须被抓到')
    // 反例注入：漏掉 adjust ⇒ 必败
    assert.notDeepEqual(verbFilterProblems(['buy', 'sell']), [], '⚠ 反例（漏掉 adjust）必须被抓到')
  } finally {
    h.close()
  }
})

// ─────────────────────────────── ② 北京日 ───────────────────────────────

test('② 归属日按**北京日**：UTC 23:30 与 00:30 落在不同北京日（用宿主/UTC 日会串日）', async () => {
  const lateUtc = BJ('2026-10-19T23:30:00Z') // 北京 2026-10-20 07:30
  const earlyUtc = BJ('2026-10-19T00:30:00Z') // 北京 2026-10-19 08:30
  assert.equal(dayOf(lateUtc), '2026-10-20')
  assert.equal(dayOf(earlyUtc), '2026-10-19')
  const ledger = [
    entry({ id: 'l-late', ts: lateUtc, verb: 'buy', name: 'A', qty: 1, price: 10 }),
    entry({ id: 'l-early', ts: earlyUtc, verb: 'buy', name: 'B', qty: 1, price: 20 }),
  ]
  const h = await harness({ ledger })
  try {
    const d20 = await h.call('/tradewatcher/fupan/trades', '/tradewatcher/fupan/trades?day=2026-10-20')
    const d19 = await h.call('/tradewatcher/fupan/trades', '/tradewatcher/fupan/trades?day=2026-10-19')
    const ids20 = (d20.body.trades as Array<{ ledgerId: string; time: string }>).map((t) => t.ledgerId)
    const ids19 = (d19.body.trades as Array<{ ledgerId: string; time: string }>).map((t) => t.ledgerId)
    assert.deepEqual(ids20, ['l-late'], '23:30Z 属于**北京 10-20**')
    assert.deepEqual(ids19, ['l-early'], '00:30Z 属于**北京 10-19**')
    assert.equal((d20.body.trades as Array<{ time: string }>)[0]?.time, '07:30', '时刻也必须是北京时刻')
    assert.equal((d19.body.trades as Array<{ time: string }>)[0]?.time, '08:30')
    // 反例注入：按 UTC 日归属 ⇒ late 被塞进 10-19（该日 2 笔、10-20 空）
    const utcDayOf = (ts: number): string => new Date(ts).toISOString().slice(0, 10)
    assert.equal(utcDayOf(lateUtc), '2026-10-19', '⚠ 反例（UTC 日）确实与北京日不同')
    const naive = ledger.filter((e) => utcDayOf(e.ts) === '2026-10-19').map((e) => e.id)
    assert.notDeepEqual(naive, ids19, '⚠ 反例（按 UTC/宿主日）分出来的组必须与真实不同')
    // 非法 day ⇒ 400（不是"这天没有交易"）
    const bad = await h.call('/tradewatcher/fupan/trades', '/tradewatcher/fupan/trades?day=2026/10/20')
    assert.equal(bad.code, 400)
  } finally {
    h.close()
  }
})

// ─────────────────────────────── ③ 当日盈亏 = 持仓核算 ───────────────────────────────

test('③ 当日盈亏取**持仓核算值**（含隔夜持仓那部分），不是按逐笔重算', async () => {
  const stub = stubQuotes({ sh600519: { price: 11, prev: 10 } })
  try {
    const overnight = entry({
      id: 'l-overnight', ts: BJ(`${TODAY}T10:00:00+08:00`) - 3 * 86_400_000,
      verb: 'buy', posId: 'p1', groupId: GROUP.id, secid: '1.600519', name: '贵州茅台', qty: 100, price: 10,
    })
    const todayBuy = entry({
      id: 'l-today', ts: BJ(`${TODAY}T09:31:00+08:00`),
      verb: 'buy', posId: 'p1', groupId: GROUP.id, secid: '1.600519', name: '贵州茅台', qty: 100, price: 11, fee: 5,
    })
    const h = await harness({ ledger: [overnight, todayBuy], groups: [GROUP], items: [pos('p1', '1.600519', '贵州茅台')] })
    try {
      await em.fetchQuotes(['1.600519']) // 打桩预热：把现价/昨收放进共用槽（路由自己**不许**再发请求）
      const res = await h.call('/tradewatcher/fupan/trades', `/tradewatcher/fupan/trades?day=${TODAY}`)
      assert.equal(res.code, 200)
      // 同一来源：直接用持仓核算再算一遍（assemblePortfolio 是持仓页那条链的唯一入口）
      const port = h.store.portData()
      const quotes = em.peekQuotes([...new Set(port.items.map((p) => p.secid))])
      const { view } = assemblePortfolio(port.groups, port.items, h.store.ledgerEntries(), quotes, { mode: 'none', rates: {} })
      const accounting = view.grand.dayPnl
      const naive = 100 * (11 - 11) - 5 // 只按今天的逐笔重算（漏隔夜持仓）⇒ −5
      assert.equal(accounting, 95, '持仓核算：100×(11−10) + (100×(11−11) − 5) = 95')
      assert.deepEqual(
        pnlSourceProblems({ dayPnl: res.body.dayPnl, accounting, naive }),
        [],
        `当日盈亏必须等于持仓核算值（实得 ${String(res.body.dayPnl)}）`,
      )
      assert.equal(res.body.dayPnlReason, null, '算得出来时不给原因（空话会让人以为降级了）')
      assert.equal(res.body.dayPnl, 95)
      // 反例注入：按逐笔重算 ⇒ 必败
      assert.notDeepEqual(pnlSourceProblems({ dayPnl: naive, accounting, naive }), [], '⚠ 反例（逐笔重算 −5）必须被抓到')
      assert.notDeepEqual(pnlSourceProblems({ dayPnl: 0, accounting, naive }), [], '⚠ 反例（写 0）必须被抓到')
      // 汇总：只报买卖笔数与数量，不编"净买入/净额"
      const summary = res.body.summary as { count: number; buy: { count: number; qty: number }; amount: number | null; fees: number }
      assert.equal(summary.count, 1, `当天只有一笔买入（实得 ${summary.count}）`)
      assert.equal(summary.buy.qty, 100)
      assert.equal(summary.fees, 5)
      assert.equal(summary.amount, 1100)
      // 历史日期：持仓核算只有"今天"这一个日期 ⇒ 不许把今天的盈亏冒充那一天
      const past = dayOf(Date.now() - 3 * 86_400_000)
      const pastRes = await h.call('/tradewatcher/fupan/trades', `/tradewatcher/fupan/trades?day=${past}`)
      assert.equal(pastRes.code, 200)
      assert.equal(pastRes.body.dayPnl, null, '历史日期不给当日盈亏（0 会被读成"那天没赚没亏"）')
      assert.match(String(pastRes.body.dayPnlReason), /不是今天/, '必须说清为什么这个日期没有当日盈亏')
      assert.equal((pastRes.body.trades as unknown[]).length, 1, '逐笔照给：那天的买入记录仍在（隔夜买入在 3 天前）')
    } finally {
      h.close()
    }
  } finally {
    stub.restore()
  }
})

// ─────────────────────────────── ④ 算不出 ⇒ null + 原因 ───────────────────────────────

test('④ 当日盈亏算不出 ⇒ null + 原因（写 0 必败）；持仓在但本地没有行情时如实说"缺现价/昨收"', async () => {
  const noQuote = entry({
    id: 'l-nq', ts: BJ(`${TODAY}T10:00:00+08:00`) - 2 * 86_400_000,
    verb: 'buy', posId: 'p9', groupId: GROUP.id, secid: '1.600000', name: '浦发银行', qty: 1000, price: 9,
  })
  const h = await harness({ ledger: [noQuote], groups: [GROUP], items: [pos('p9', '1.600000', '浦发银行')] })
  const realFetch = globalThis.fetch
  globalThis.fetch = (() => Promise.reject(new Error('offline (test)'))) as typeof fetch
  try {
    const res = await h.call('/tradewatcher/fupan/trades', `/tradewatcher/fupan/trades?day=${TODAY}`)
    assert.equal(res.code, 200)
    assert.deepEqual(pnlMissingProblems(res.body), [], `算不出时必须 null + 原因（实得 dayPnl=${String(res.body.dayPnl)}）`)
    assert.match(String(res.body.dayPnlReason), /浦发银行/, '原因里必须点名是哪只算不出')
    // 反例注入：写 0 / 不给原因 ⇒ 必败
    assert.notDeepEqual(pnlMissingProblems({ dayPnl: 0, dayPnlReason: null }), [], '⚠ 反例（写 0）必须被抓到')
    assert.notDeepEqual(pnlMissingProblems({ dayPnl: null, dayPnlReason: '  ' }), [], '⚠ 反例（空原因）必须被抓到')
    // 空仓：没有持仓也算得出来（0 是真的 0，不是"不知道"）
    const empty = accountingDayPnl({ positions: [], grand: { dayPnl: 0 } } as unknown as PortfolioView)
    assert.equal(empty.dayPnl, 0)
    assert.equal(empty.reason, null)
  } finally {
    globalThis.fetch = realFetch
    h.close()
  }
})

// ─────────────────────────────── ⑤ 上限 500 ───────────────────────────────

test('⑤ 单日 600 笔 ⇒ 返回前 500 + truncated{shown:500,total:600}（不截断必败）', async () => {
  const base = BJ(`${TODAY}T09:30:00+08:00`)
  const ledger = Array.from({ length: 600 }, (_, i) => entry({
    id: `l-${String(i).padStart(3, '0')}`,
    ts: base + i * 1000,
    verb: 'buy',
    name: '批量',
    qty: 1,
    price: 10,
  }))
  const h = await harness({ ledger })
  try {
    const res = await h.call('/tradewatcher/fupan/trades', `/tradewatcher/fupan/trades?day=${TODAY}`)
    assert.equal(res.code, 200)
    const trades = res.body.trades as Array<{ ledgerId: string; time: string }>
    const truncated = res.body.truncated as { shown: number; total: number }
    assert.equal(trades.length, FUPAN_TRADES_MAX, '单日上限 500')
    assert.equal(truncated.shown, 500)
    assert.equal(truncated.total, 600)
    assert.deepEqual(truncationProblems({ total: truncated.total, shown: truncated.shown }), [])
    assert.equal(res.body.total, 600, 'total 是该日计入的全部笔数（不受截断影响）')
    assert.equal((res.body.summary as { count: number }).count, 600, '汇总按全日算（不是"前 500 笔的合计"）')
    assert.equal(trades[0]?.ledgerId, 'l-000', '截断保留最早的那批（按时间序）')
    assert.equal(trades[499]?.ledgerId, 'l-499')
    // 反例注入：不截断 ⇒ 必败
    assert.notDeepEqual(truncationProblems({ total: 600, shown: 600 }), [], '⚠ 反例（不截断）必须被抓到')
    // 直接调纯函数也一致（路由层没有第二套口径）
    const pure = tradesOfDay(h.store.ledgerEntries(), TODAY)
    assert.equal(pure.trades.length, 500)
    assert.equal(pure.total, 600)
  } finally {
    h.close()
  }
})

// ─────────────────────────────── ⑥ 缓存 60s + 写后失效 ───────────────────────────────

test('⑥ 同日结果缓存 60 秒，流水落盘即失效（无缓存 / 永不失效都必败）', async () => {
  const buy = entry({
    id: 'l-1', ts: BJ(`${TODAY}T09:31:00+08:00`),
    verb: 'buy', posId: 'p1', groupId: GROUP.id, secid: '1.600519', name: '贵州茅台', qty: 100, price: 11,
  })
  const h = await harness({ ledger: [buy], groups: [GROUP], items: [pos('p1', '1.600519', '贵州茅台')] })
  try {
    __resetFupanTradesCache(h.store)
    const t0 = Date.now()
    readFupanTrades(h.store, TODAY, t0)
    readFupanTrades(h.store, TODAY, t0 + 59_000)
    const readsWithinTtl = __fupanTradesStats.builds
    assert.equal(readsWithinTtl, 1, '60 秒内读两次只构建 1 次')
    assert.equal(fupanTradesCached(h.store, TODAY), true)
    readFupanTrades(h.store, TODAY, t0 + 61_000)
    assert.equal(__fupanTradesStats.builds, 2, '过了 60 秒必须重新构建')

    // 写路径失效：录入一笔流水 ⇒ 缓存立刻消失，下次读重新构建
    __resetFupanTradesCache(h.store)
    readFupanTrades(h.store, TODAY, t0)
    assert.equal(__fupanTradesStats.builds, 1)
    await h.store.mutatePortfolio({ op: 'buy', posId: 'p1', qty: 1, price: 11, fee: 0 })
    const cachedAfterWrite = fupanTradesCached(h.store, TODAY)
    assert.equal(cachedAfterWrite, false, '流水落盘后缓存必须立刻清空（不用轮询）')
    readFupanTrades(h.store, TODAY, t0 + 1000)
    const readsAfterWrite = __fupanTradesStats.builds - 1
    assert.deepEqual(cacheProblems({ readsWithinTtl, cachedAfterWrite, readsAfterWrite }), [])
    // 反例注入：无缓存（60 秒内构建 2 次）/ 永不失效（写后仍命中缓存、不再构建）⇒ 必败
    assert.notDeepEqual(cacheProblems({ readsWithinTtl: 2, cachedAfterWrite: false, readsAfterWrite: 1 }), [], '⚠ 反例（无缓存）必须被抓到')
    assert.notDeepEqual(cacheProblems({ readsWithinTtl: 1, cachedAfterWrite: true, readsAfterWrite: 0 }), [], '⚠ 反例（永不失效）必须被抓到')
  } finally {
    h.close()
  }
})

// ─────────────────────────────── ⑦ 零上游请求 ───────────────────────────────

test('⑦ 零新增上游请求：运行时 fetch 计数为 0；源码里只允许 em.peekQuotes（发一次 fetch 必败）', async () => {
  const buy = entry({
    id: 'l-1', ts: BJ(`${TODAY}T09:31:00+08:00`),
    verb: 'buy', posId: 'p1', groupId: GROUP.id, secid: '1.600519', name: '贵州茅台', qty: 100, price: 11,
  })
  const stub = stubQuotes({ sh600519: { price: 11, prev: 10 }, sh600036: { price: 30, prev: 29 } })
  const h = await harness({ ledger: [buy], groups: [GROUP], items: [pos('p1', '1.600519', '贵州茅台')] })
  try {
    await em.fetchQuotes(['1.600519']) // 预热（这一次是测试自己发的）
    const before = stub.count()
    const res = await h.call('/tradewatcher/fupan/trades', `/tradewatcher/fupan/trades?day=${TODAY}`)
    assert.equal(res.code, 200)
    const delta = stub.count() - before
    assert.deepEqual(upstreamProblems(delta), [], `这条路由必须零上游请求（实测 ${delta} 次）`)
    // 反例注入：为它发一次 fetch ⇒ 计数必须不同（判据非恒真）
    await em.fetchQuotes(['1.600036'])
    assert.notDeepEqual(upstreamProblems(stub.count() - before), [], '⚠ 反例（发一次上游请求）必须被抓到')
  } finally {
    stub.restore()
    h.close()
  }
  // 静态判据：宿主模块与 handler 都不许出现取数调用
  const hostSrc = readFileSync(join(SRC, 'fupanTrades.ts'), 'utf8')
  const routesSrc = readFileSync(join(SRC, 'routes.ts'), 'utf8')
  const handler = handlerSource(routesSrc, '/tradewatcher/fupan/trades')
  assert.ok(handler.length > 0, '必须能从 routes.ts 切出这条 handler（否则静态判据是空跑）')
  assert.deepEqual(upstreamSourceProblems(hostSrc, handler), [])
  assert.match(handler, /readFupanTrades\s*\(/, 'handler 必须走 readFupanTrades（缓存 + 口径的唯一入口）')
  // 反例注入：发一次 fetch / 借 em 取数 ⇒ 必败
  assert.notDeepEqual(upstreamSourceProblems(`${hostSrc}\nawait fetch('https://push2.eastmoney.com/x')\n`, handler), [], '⚠ 反例（fetch）必须被抓到')
  assert.notDeepEqual(upstreamSourceProblems(`${hostSrc}\nconst q = await em.fetchQuotes(['1.600519'])\n`, handler), [], '⚠ 反例（借 em 取数）必须被抓到')
})

// ─────────────────────────────── ⑧ 归属 = fupan ───────────────────────────────

test('⑧ 路由归属 = fupan（塞进 core/其它行必败）', () => {
  const indexSrc = readFileSync(join(SRC, '..', 'index.ts'), 'utf8')
  assert.deepEqual(ownershipProblems(indexSrc), [], '真实源码：这条路由只属于 fupan 行')
  // 反例注入 ①：从 fupan 行删掉 ⇒ core 兜底
  const dropped = indexSrc.replace("'/tradewatcher/fupan/trades'", "''")
  assert.notEqual(dropped, indexSrc, '注入必须真的改到了源码')
  assert.notDeepEqual(ownershipProblems(dropped), [], '⚠ 反例（删掉 ⇒ 归 core）必须被抓到')
  // 反例注入 ②：同时塞进 market 行
  const intoMarket = indexSrc.replace(
    "market: ['/tradewatcher/breadth'",
    "market: ['/tradewatcher/fupan/trades', '/tradewatcher/breadth'",
  )
  assert.notEqual(intoMarket, indexSrc)
  assert.notDeepEqual(ownershipProblems(intoMarket), [], '⚠ 反例（塞进 market）必须被抓到')
})

// ─────────────────────────────── 读取失败口径 ───────────────────────────────

test('读取失败：HTTP 200 + 0 笔（用户口径），但 readFailed/readFailedReason 必须如实留在回包里', async () => {
  const h = await harness({ ledgerAsDir: true, groups: [GROUP], items: [pos('p1', '1.600519', '贵州茅台')] })
  try {
    assert.ok(h.store.readFailures().some((f) => f.file === 'ledger.json'), '夹具必须真的让 ledger.json 读不到')
    const res = await h.call('/tradewatcher/fupan/trades', `/tradewatcher/fupan/trades?day=${TODAY}`)
    assert.deepEqual(readFailProblems(res), [], `读取失败口径不对：${JSON.stringify(res.body).slice(0, 200)}`)
    assert.equal((res.body.missing as unknown[]).length, 1, 'missing[] 也要如实带一条（服务端仍记录）')
    // 反例注入 ①：失败时连 readFailed 都不给 ⇒ 必败
    const { readFailed: _drop, ...noFlag } = res.body
    assert.notDeepEqual(readFailProblems({ code: 200, body: noFlag }), [], '⚠ 反例（不给 readFailed）必须被抓到')
    // 反例注入 ②：失败时抛 500 ⇒ 必败（用户要 0 笔，不是报错）
    assert.notDeepEqual(readFailProblems({ code: 500, body: {} }), [], '⚠ 反例（抛 500）必须被抓到')
    // 反例注入 ③：失败时写 0 当盈亏 ⇒ 必败
    assert.notDeepEqual(readFailProblems({ code: 200, body: { ...res.body, dayPnl: 0 } }), [], '⚠ 反例（dayPnl=0）必须被抓到')
  } finally {
    h.close()
  }
})

test('正常回包：readFailed 恒存在（false），逐笔字段齐全且缺值给 null', async () => {
  const ledger = [
    entry({ id: 'l-a', ts: BJ('2026-10-19T09:31:00+08:00'), verb: 'buy', name: '贵州茅台', qty: 100, price: 1680, fee: 5 }),
    entry({ id: 'l-b', ts: BJ('2026-10-19T10:31:00+08:00'), verb: 'adjust', name: '贵州茅台' }),
  ]
  const h = await harness({ ledger })
  try {
    const res = await h.call('/tradewatcher/fupan/trades', '/tradewatcher/fupan/trades?day=2026-10-19')
    assert.equal(res.body.readFailed, false, 'readFailed 必须恒存在（界面据此判断不画三角）')
    assert.equal(res.body.readFailedReason, null)
    assert.equal(typeof res.body.asOf, 'number')
    assert.equal(res.body.source, 'local:ledger.json+portfolio')
    const [buy, adjust] = res.body.trades as Array<Record<string, unknown>>
    assert.deepEqual(Object.keys(buy!).sort(), ['direction', 'fee', 'ledgerId', 'name', 'price', 'qty', 'side', 'time', 'ts'].sort())
    assert.equal(buy!.time, '09:31')
    assert.equal(buy!.side, 'buy')
    assert.equal(buy!.direction, '买')
    assert.equal(buy!.ledgerId, 'l-a')
    assert.equal(adjust!.side, 'adjust')
    assert.equal(adjust!.direction, '调整')
    assert.equal(adjust!.qty, null, '未填数量 ⇒ null（不补 0）')
    assert.equal(adjust!.price, null)
    assert.equal((res.body.summary as { unpriced: number }).unpriced, 0, '调整没有成交价，不算进"缺价"')
    assert.equal((res.body.summary as { amount: number | null }).amount, 168000, '调整不进成交额')
  } finally {
    h.close()
  }
})

// ─────────────────────────────── 月历笔数（`dates[].trades`） ───────────────────────────────

test('月历：`dates[].trades` 逐日笔数与逐日明细**同一份口径**（含 verb 过滤与交叉一致性）', async () => {
  const mk = (id: string, day: string, verb: LedgerVerb, extra: Partial<LedgerEntry> = {}): LedgerEntry =>
    entry({ id, ts: BJ(`${day}T10:00:00+08:00`), verb, name: '贵州茅台', qty: 100, price: 10, ...extra })
  const ledger = [
    mk('l-1', '2026-09-08', 'buy'),
    mk('l-2', '2026-09-08', 'sell'),
    mk('l-3', '2026-09-15', 'adjust'),
    // 非交易动词：同月同日都不许进笔数
    mk('l-4', '2026-09-08', 'add'),
    mk('l-5', '2026-09-09', 'remove'),
    mk('l-6', '2026-09-09', 'grename'),
    mk('l-7', '2026-09-15', 'pnote', { note: '复盘备注' }),
  ]
  const h = await harness({ ledger })
  try {
    const month = await h.call('/tradewatcher/fupan/month', '/tradewatcher/fupan/month?ym=2026-09')
    assert.equal(month.code, 200)
    const dates = month.body.dates as Array<{ date: string; trades?: number }>
    assert.equal(dates.length, 30)
    assert.deepEqual(monthCountsProblems(dates, { '2026-09-08': 2, '2026-09-15': 1 }), [])
    assert.equal(dates.find((d) => d.date === '2026-09-09')?.trades, 0, '那天只有 remove/grename ⇒ 0（真的没有交易）')
    assert.equal((month.body.totals as { days: number }).days, 30, '笔数不影响既有的日期骨架')
    // 交叉一致性：同一天两条路由必须同数（同 3 笔、分布在 2 天）
    const days = dates.filter((d) => (d.trades ?? 0) > 0)
    assert.equal(days.length, 2, '3 笔落在 2 天')
    const pairs: Array<{ day: string; month: unknown; daily: unknown }> = []
    for (const d of dates) {
      const one = await h.call('/tradewatcher/fupan/trades', `/tradewatcher/fupan/trades?day=${d.date}`)
      pairs.push({ day: d.date, month: d.trades, daily: one.body.total })
    }
    assert.deepEqual(crossCountProblems(pairs), [])
    // 反例注入 ①：不填这个字段 ⇒ 必败
    assert.notDeepEqual(monthCountsProblems(dates.map((d) => ({ date: d.date })), {}), [], '⚠ 反例（不填 trades）必须被抓到')
    // 反例注入 ②：把 create/remove/rename 也算进笔数 ⇒ 09-08=4、09-09=2 ⇒ 必败
    const allVerbs = ledger.reduce<Record<string, number>>((acc, e) => {
      const day = dayOf(e.ts)
      acc[day] = (acc[day] ?? 0) + 1
      return acc
    }, {})
    assert.equal(allVerbs['2026-09-08'], 3, '⚠ 反例前提：09-08 共 3 条流水（buy/sell/add）')
    assert.notDeepEqual(monthCountsProblems(dates, allVerbs), [], '⚠ 反例（含 add/remove/grename）必须被抓到')
    // 反例注入 ③：两套口径（月历按全量、逐日按过滤）⇒ 交叉一致性必败
    const mismatched = dates.map((d) => ({ day: d.date, month: allVerbs[d.date] ?? 0, daily: d.trades ?? 0 }))
    assert.notDeepEqual(crossCountProblems(mismatched), [], '⚠ 反例（两套口径）必须被抓到')
  } finally {
    h.close()
  }
})

test('月历：流水读不到 ⇒ 每格 `trades: null`（不是 0）+ readFailed；写 0 必败', async () => {
  const h = await harness({ ledgerAsDir: true })
  try {
    const month = await h.call('/tradewatcher/fupan/month', '/tradewatcher/fupan/month?ym=2026-09')
    assert.equal(month.code, 200)
    assert.equal(month.body.readFailed, true, '月历也要带 readFailed（界面据此不画 ▲n）')
    assert.equal(typeof month.body.readFailedReason, 'string')
    const dates = month.body.dates as Array<{ date: string; trades?: number | null }>
    assert.equal(dates.every((d) => d.trades === null), true, '读不到 ⇒ 每格 null（不是 0）')
    assert.equal((month.body.missing as unknown[]).length, 1, 'missing[] 里要有流水那条')
    // 反例注入：写 0 ⇒ 必败（月历会把"读不到"画成"没有交易"）
    assert.deepEqual(monthReadFailProblems(dates), [])
    assert.notDeepEqual(monthReadFailProblems(dates.map((d) => ({ date: d.date, trades: 0 }))), [], '⚠ 反例（写 0）必须被抓到')
    assert.notDeepEqual(monthReadFailProblems(dates.map((d) => ({ date: d.date, trades: undefined }))), [], '⚠ 反例（不填）必须被抓到')
    // 与逐日路由同一口径：那边也是读失败 ⇒ 0 笔 + readFailed
    const one = await h.call('/tradewatcher/fupan/trades', '/tradewatcher/fupan/trades?day=2026-09-08')
    assert.equal(one.body.readFailed, true)
    assert.deepEqual(one.body.trades, [])
  } finally {
    h.close()
  }
})

test('月历：仍零新增上游请求（发一次 fetch 必败）；handler 里只允许本地读', async () => {
  const stub = stubQuotes({ sh600519: { price: 11, prev: 10 }, sh600036: { price: 30, prev: 29 }, sh601318: { price: 50, prev: 49 } })
  const h = await harness({ ledger: [] })
  try {
    const before = stub.count()
    const month = await h.call('/tradewatcher/fupan/month', '/tradewatcher/fupan/month?ym=2026-09')
    assert.equal(month.code, 200)
    const delta = stub.count() - before
    assert.deepEqual(upstreamProblems(delta), [], `月历也必须零上游请求（实测 ${delta} 次）`)
    await em.fetchQuotes(['1.601318']) // 反例注入：发一次请求 ⇒ 计数不同（这个标的没被预热过）
    assert.notDeepEqual(upstreamProblems(stub.count() - before), [], '⚠ 反例（发一次上游请求）必须被抓到')
  } finally {
    stub.restore()
    h.close()
  }
  const hostSrc = readFileSync(join(SRC, 'fupanTrades.ts'), 'utf8')
  const routesSrc = readFileSync(join(SRC, 'routes.ts'), 'utf8')
  const handler = handlerSource(routesSrc, '/tradewatcher/fupan/month')
  assert.ok(handler.length > 0, '必须能切出 month handler')
  assert.deepEqual(upstreamSourceProblems(hostSrc, handler), [], 'month handler 里不许出现取数调用')
  assert.match(handler, /readFupanMonthTrades\s*\(/, 'month handler 必须走 readFupanMonthTrades（与逐日同一份缓存与口径）')
})
