/**
 * 全球五市场（工具箱 → 工具①「五市场蛋糕」）的断言集。
 *
 * 覆盖任务点名的六件事（每条都配反例注入，证据见 `docs/AUDIT-IMPL45.md` §4）：
 *   ① 份额合计 = 100%（±0.1 显示位）—— 所有市场都有值时、以及**有市场缺值时**都成立；
 *   ② 某市场取数失败 ⇒ 该行「未取到」+ 原因，且**整表不显示 0**（含客户端渲染层）；
 *   ③ 轮动文案：有轮动 = `从 X 转向 Y`；**无轮动 = 等价写法**（不许硬凑），判不了 = 第三种；
 *   ④ A股净流入**不参与**份额计算（构造用例：只改它，份额逐项不变）；
 *   ⑤ 并发 2 次同请求 ⇒ 上游只打 1 次（在飞合并）；TTL 内再取 = 0 次；
 *   ⑥ 30 日回放/`source=snapshot` **零上游请求**（含路由层与客户端换帧）。
 *
 * 另有口径断言：汇率取不到 ⇒ A股 不折算、不进美元合计（不许静默混算）；快照一天一条、保留 90 天；
 * 前向填充（跨市场交易日不同）；动量样本不足 ⇒ null（不给 0）。
 *
 * 隔离：`DSH_HOME` 指向 `/tmp` 下的临时目录（每个用例一个），上游一律由合成 fixture 回答
 * （形状忠实：字段名/下标与真实回包一致，见 docs/AUDIT-IMPL45.md §2 的实测样例）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { breakerFor } from './breaker.ts'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import {
  __resetFlowCache,
  FLOW_GREED_WINDOW,
  greedOf,
  percentileRanks,
  preferenceOf,
  sharesFromScores,
  FLOW_MARKET_ORDER,
  alignSeries,
  buildCurve,
  flowSnapshotPath,
  globalFlowPayload,
  momentumOf,
  momentumRanks,
  readFlowSnapshot,
  writeFlowSnapshot,
  FLOW_MARKETS,
  FLOW_SCOPE,
  flowSnapshotPurged,
  rotationOf,
  sharesOf,
  sharesSumPct,
  toUsd,
  trimSnapshotDays,
  type FlowPoint,
} from './globalFlow.ts'
import { cakeTool } from '../client/tools/cake.ts'
import { globalFlowToolData, globalFlowToolPayload } from '../client/tools/globalFlowView.ts'
import { detailModel, NOT_FETCHED } from '../client/toolRegistry.ts'
import { looksLikeZeroStandIn } from '../client/toolText.ts'
import type { GlobalFlowMarketDto, GlobalFlowPayloadDto } from '../client/api.ts'
import { makeTradeRoutes } from './routes.ts'
import { DataStore } from './store.ts'
import { CalendarStore } from './calendar.ts'

/** 按 market key 找行下标（成分顺序是口径的一部分，断言里不许写死下标） */
function rowIdxOf(payload: GlobalFlowPayloadDto, key: GlobalFlowMarketDto['key']): number {
  const i = payload.markets.findIndex((m) => m.key === key)
  assert.notEqual(i, -1, `载荷里必须有 ${key} 这个市场`)
  return i
}

/** 最小载荷骨架（只填渲染断言会用到的字段；③ 的渲染层断言用） */
function payloadShell(): GlobalFlowPayloadDto {
  const mk = (key: GlobalFlowMarketDto['key'], name: string, etf: string, currency: 'USD' | 'CNY' | 'HKD') => ({
    key, name, etf, aumSource: '公开源', currency, benchmark: '基准', benchmarkSource: '腾讯日线',
    aumNative: null, aumUsd: null, sharePct: null, pref: 0.5, prefSource: '偏好分口径（夹具）', delta1Pp: null, delta5Pp: null,
    momentum: null, rank: null, missing: null,
  })
  return {
    asOf: NOW, day: DAY, source: 'live', fallbackDay: null,
    fx: { usdCny: 6.6937, usdHkd: 7.8473, at: NOW, source: '新浪 fx_susdcny / fx_susdhkd', note: null },
    // 成分 v2：A股、港股、美国、日本、韩国（顺序 = 展示顺序）
    markets: [mk('cn', 'A股', '510300', 'CNY'), mk('hk', '港股', '02800 盈富基金', 'HKD'), mk('us', '美国', 'SPY', 'USD'), mk('jp', '日本', 'EWJ', 'USD'), mk('kr', '韩国', 'EWY', 'USD')],
    totalUsd: null, totalNote: null,
    rotation: { kind: 'unknown', fromKey: null, toKey: null, maxAbsPp: null, comparable: 0, window: 5, text: '判不了' },
    curve: { points: [], window: 365, windowOptions: [90, 180, 365], observedDays: 0, rebuiltDays: 0, note: '曲线口径' },
    replay: { days: [], max: 0, note: '回放口径' },
    netFlow: { code: 'sh510300', label: '净流入', days: 0, sumCny: null, asOf: null, series: [], basis: '口径', miss: '未取到' },
    snapshot: { path: '/tmp/x.json', days: 0, bytes: null, firstDay: null, lastDay: null, purged: [] },
    notes: { kpi: 'k', curve: 'c', pie: 'p', market: 'm', boundary: 'b' },
    boundary: ['宿主边界'],
    missing: [],
  }
}

/** 钉死的"现在"：北京 2026-10-12 21:00（`dayOf` ⇒ 2026-10-12） */
const NOW = Date.UTC(2026, 9, 12, 13, 0, 0)
const DAY = '2026-10-12'

/** 每个用例一个隔离数据目录（`dataHome()` 每次调用都读 env） */
function freshHome(): string {
  const dir = mkdtempSync(join(tmpdir(), 'tw-globalflow-'))
  if (!dir.startsWith('/tmp')) throw new Error(`拒绝运行：DSH_HOME 必须在 /tmp 下（收到 ${dir}）`)
  process.env.DSH_HOME = dir
  __resetFlowCache()
  return dir
}

// ── 合成 fixture（形状与真实回包一致） ───────────────────────────────────────

/** 倒推 `count` 个交易日（跳过周末）；最后一个 = DAY */
function tradingDays(count: number): string[] {
  const out: string[] = []
  const d = new Date(`${DAY}T00:00:00Z`)
  while (out.length < count) {
    const wd = d.getUTCDay()
    if (wd !== 0 && wd !== 6) out.push(d.toISOString().slice(0, 10))
    d.setUTCDate(d.getUTCDate() - 1)
  }
  return out.reverse()
}

// 480 根：要同时覆盖"曲线窗口 365 + 贪婪值热身 60"（否则曲线最前面约 60 天会因为样本不足而空掉）
const DATES = tradingDays(480)

/**
 * 各市场规模（原币）：与 2026-10-12 真网络实测同一量级（见 docs/AUDIT-IMPL47.md §1）
 *   · A股 510300：新浪 ETF 节点 nmc = 10635037.4372 万元 = 1063.50 亿元（人民币）
 *   · 港股 02800：腾讯 f45 = 1262.1791 亿港元
 *   · 美国 SPY ：新浪 gb_spy 总市值 = 822272781554 美元
 *   · 日本 EWJ ：新浪 gb_ewj 总市值 = 23809338000 美元
 *   · 韩国 EWY ：腾讯 f71 股本 = 142550000 × 最新价（新浪该标的的总市值字段实测为 0）
 */
const AUM: Record<string, { totalMv: string; shares: string }> = {
  // 下标 12 = 总市值（用户口径的"字段 13"，1 起数），下标 19 = 股本（用于交叉校验）
  spy: { totalMv: '822272781554.0000', shares: '1056132116' },
  ewj: { totalMv: '23809338000.0000', shares: '243300000' },
  ewy: { totalMv: '0.0000', shares: '0' }, // ⚠ 实测为 0 ⇒ 必须走腾讯 f71×价 的推导路径
}
const PRICE: Record<string, number> = { spy: 778.57, ewj: 97.86, ewy: 170.62 }
const CN_NMC_WAN = '10635037.4372'
/** 腾讯行情：hk02800 的 f45（亿港元）+ 三只美股 ETF 的 f71（股本） */
const TENCENT_AUM: Record<string, { price: string; totalMvYi: string | null; shares: string | null }> = {
  hk02800: { price: '24.900', totalMvYi: '1262.1791', shares: null },
  usSPY: { price: '778.570', totalMvYi: null, shares: '1055532000' },
  usEWJ: { price: '97.860', totalMvYi: null, shares: '243300000' },
  usEWY: { price: '170.620', totalMvYi: null, shares: '142550000' },
}
/** 两条汇率（1 美元 = 多少原币）：与实测同一量级 */
const FXRATE: Record<string, string> = { fx_susdcny: '6.6937', fx_susdhkd: '7.8473' }

interface StubOptions {
  /** 让这些上游符号失败（按 URL 片段匹配） */
  fail?: string[]
  /** 宏观两档（`globalbd_us10yt` / `DINIW`）整体失败（模拟上游宕机） */
  macroOff?: boolean
  /** 规模口径：real = 各市场不同量级；equal = 五家一样大（用来构造"份额持平/无轮动"） */
  aumMode?: 'real' | 'equal'
  /** 动量形状：distinct = 各市场涨速不同；same = 完全一致（⇒ 名次并列、轮动为持平） */
  seriesMode?: 'distinct' | 'same'
  /** 上游延迟（ms），用于并发合并断言 */
  delayMs?: number
  /** 资金流序列（默认 20 天递增） */
  moneyFlow?: Array<{ day: string; net: number }>
  /** 某个市场少一天日线（前向填充断言用） */
  gapDay?: { symbol: string; day: string }
  /** 把某个 gb 符号的「总市值」乘一个系数（自校告警断言用：与 price×股本 对不上） */
  aumDrift?: Record<string, number>
  /** 从腾讯行情批量里**去掉**这些代码（模拟"只有走腾讯那条路径的市场取不到数"） */
  tencentDrop?: string[]
  /** 把某个市场的规模放大 N 倍（构造"规模巨大但偏好分很低"的反例断言用） */
  aumBoost?: { key: 'spy' | 'ewj' | 'ewy'; factor: number }
}

interface Stub {
  calls: Array<{ host: string; path: string; q: string }>
  total: () => number
  count: (fragment: string) => number
  /** 可变失败集合：`clear()` 用来模拟"上游恢复"（断言失败不进缓存要用） */
  fail: Set<string>
  restore: () => void
}

function gbLine(symbol: string, totalMv: string, shares: string): string {
  const f: string[] = new Array(36).fill('0.00')
  f[0] = `${symbol.toUpperCase()} ETF`
  f[1] = String(PRICE[symbol] ?? 10)
  f[2] = '0.60'
  f[3] = '2026-10-12 20:47:52'
  f[4] = '0.64'
  f[5] = '776.2400'
  f[6] = '779.4200'
  f[7] = '775.1400'
  f[10] = '22624488'
  f[12] = totalMv
  f[19] = shares
  return `var hq_str_gb_${symbol}="${f.join(',')}";`
}

function usDailyJsonp(symbol: string, opts: StubOptions): string {
  const rows = DATES.map((d, i) => {
    const close = closeOf(symbol, i, opts)
    return { d, o: close.toFixed(2), h: (close * 1.002).toFixed(2), l: (close * 0.998).toFixed(2), c: close.toFixed(2), v: '1000', a: '0' }
  }).filter((r) => !(opts.gapDay !== undefined && opts.gapDay.symbol === symbol && opts.gapDay.day === r.d))
  return `/*<script>location.href='//sina.com';</script>*/x(${JSON.stringify(rows)});`
}

/** 各标的收盘价序列：`distinct` 时涨速不同（名次确定），`same` 时完全一致 */
function closeOf(symbol: string, i: number, opts: StubOptions): number {
  const base: Record<string, number> = { spy: 600, ewj: 95, ewy: 160, '510300': 4.3, '000300': 4300, '02800': 22, hsi: 24000 }
  // 涨速（distinct 时各市场不同 ⇒ 动量名次确定）
  const slope: Record<string, number> = { spy: 0.30, ewj: 0.10, ewy: 0.42, '510300': -0.05, '000300': -0.05, '02800': 0.16, hsi: 0.18 }
  // ⚠ 'same' 模式要**足够大**：偏好分的贪婪值看 60 日区间，斜率太小（如 0.05 全年）会被
  //    fixture 的 toFixed 取整磨成阶梯，各市场的分位不再相等 ⇒ 会凭空造出"轮动"（假阴性）。
  const s = opts.seriesMode === 'same' ? 1.0 : (slope[symbol] ?? 0.05)
  return (base[symbol] ?? 100) * (1 + (s * i) / DATES.length) + 0.0
}

function tencentDaily(param: string, opts: StubOptions): string {
  const code = param.split(',')[0]
  const key = code === 'hkHSI' ? 'hsi' : code
  const rows = DATES.map((d, i) => [d, closeOf(key, i, opts).toFixed(3), closeOf(key, i, opts).toFixed(3), '0', '0', '1000'])
    .filter((r) => !(opts.gapDay !== undefined && opts.gapDay.symbol === key && opts.gapDay.day === r[0]))
  const node: Record<string, unknown> = { [code]: { day: rows, qfqday: rows } }
  return JSON.stringify({ code: 0, data: node })
}

/** 腾讯行情批量（`qt.gtimg.cn/q=...`）：f44/f45 = 总市值（亿），f71 = 股本（美股） */
function tencentQuotePayload(opts: StubOptions): string {
  const lines: string[] = []
  const drop = new Set(opts.tencentDrop ?? [])
  for (const [code, row] of Object.entries(TENCENT_AUM)) {
    if (drop.has(code)) continue
    const f: string[] = new Array(80).fill('0.00')
    f[1] = code
    f[3] = row.price
    f[30] = '2026-10-12 16:08:24'
    if (row.totalMvYi !== null) {
      f[44] = row.totalMvYi
      f[45] = row.totalMvYi
    }
    if (row.shares !== null) f[71] = row.shares
    lines.push(`v_${code}="${f.join('~')}"`)
  }
  return `${lines.join(';')};`
}

function etfNodePayload(opts: StubOptions): string {
  const nmc = opts.aumMode === 'equal' ? 82227278.1554 : Number(CN_NMC_WAN)
  return JSON.stringify([{ symbol: 'sh510300', code: '510300', name: 'HS300 ETF', trade: '4.360', changepercent: '-0.57', mktcap: 8246891.03284, nmc }])
}

function moneyFlowPayload(rows: Array<{ day: string; net: number }>): string {
  return JSON.stringify(rows.map((r) => ({ opendate: r.day, netamount: r.net.toFixed(4), trade: '4.36', r0_net: '1' })))
}

function defaultMoneyFlow(): Array<{ day: string; net: number }> {
  return Array.from({ length: 20 }, (_, i) => ({ day: DATES[DATES.length - 1 - i], net: (i + 1) * 1_000_000 }))
}

function stubFetch(opts: StubOptions = {}): Stub {
  const original = globalThis.fetch
  const calls: Array<{ host: string; path: string; q: string }> = []
  const fail = new Set(opts.fail ?? [])
  const reply = (text: string): Response => {
    const buf = Buffer.from(text, 'utf8')
    return {
      ok: true,
      status: 200,
      text: async () => text,
      json: async () => JSON.parse(text) as unknown,
      arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer,
    } as unknown as Response
  }
  globalThis.fetch = (async (input: unknown) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : String((input as { url?: string })?.url ?? '')
    const u = new URL(url)
    calls.push({ host: u.host, path: u.pathname, q: u.search })
    if ((opts.delayMs ?? 0) > 0) await new Promise((r) => setTimeout(r, opts.delayMs))
    const full = `${u.host}${u.pathname}${u.search}`
    for (const f of fail) if (full.includes(f)) throw new TypeError('fetch failed (fixture)')
    if (u.host === 'hq.sinajs.cn') {
      // ⚠ 新浪这个端点把代码列表放在**路径**里（`/list=gb_spy`），不是查询串 —— 按 searchParams 取会是空
      const list = decodeURIComponent(u.pathname.replace(/^\/list=/, ''))
      if (list.startsWith('fx_')) {
        const rate = FXRATE[list]
        if (rate === undefined) throw new TypeError(`fetch failed (fixture: unknown fx ${list})`)
        // 下标：0 时刻 / 3 昨收 / 8 最新 / 9 名称（见 sina.parseSinaFx）
        return reply(`var hq_str_${list}="20:48:01,${rate},${rate},${rate},25.0,${rate},${rate},${rate},${rate},FAKE,0.0120,0.0008,0.0025";`)
      }
      // 宏观两档（`globalbd_us10yt` / `DINIW`）：与真实源同布局（US10Y 现值在下标 1、时间戳下标 11；DINIW 现值下标 8）
      if (list.includes('globalbd_us10yt') || list.includes('DINIW')) {
        if (opts.macroOff === true) throw new TypeError('fetch failed (fixture: macro off)')
        const lines: string[] = []
        if (list.includes('globalbd_us10yt')) lines.push(`var hq_str_globalbd_us10yt="美国10年期国债,5.156,5.190,5.084,5.156,5.077,0,-2.0444,-0.1061,0,0,${Math.floor(Date.now() / 1000)},2026-10-15,08:15:13,2036-08-15,4.625,1年2次,96.477,美国";`)
        if (list.includes('DINIW')) lines.push(`var hq_str_DINIW="20:15:18,102.1343,102.1343,102.5296,6914,102.5293,102.5654,101.8740,102.1343,美元指数,2026-10-15";`)
        return reply(lines.join('\n'))
      }
      const symbols = list.split(',').filter((s) => s.startsWith('gb_')).map((s) => s.slice(3))
      if (symbols.length === 0) throw new TypeError('fetch failed (fixture: unknown sina list)')
      const drift = opts.aumDrift ?? {}
      const boost = opts.aumBoost
      return reply(
        symbols
          .map((sym) => {
            const base = Number(AUM[sym]?.totalMv ?? '1000000.0000')
            const up = boost !== undefined && boost.key === sym ? boost.factor : 1
            const scaled = (base * (drift[sym] ?? 1) * up).toFixed(4)
            return gbLine(sym, scaled, AUM[sym]?.shares ?? '100000')
          })
          .join('\n'),
      )
    }
    if (u.host === 'stock.finance.sina.com.cn') {
      const symbol = String(u.searchParams.get('symbol') ?? '')
      return reply(usDailyJsonp(symbol, opts))
    }
    if (u.host === 'vip.stock.finance.sina.com.cn') {
      if (u.pathname.includes('MoneyFlow')) return reply(moneyFlowPayload(opts.moneyFlow ?? defaultMoneyFlow()))
      return reply(etfNodePayload(opts))
    }
    if (u.host === 'qt.gtimg.cn') return reply(tencentQuotePayload(opts))
    if (u.host === 'web.ifzq.gtimg.cn') {
      const param = String(u.searchParams.get('param') ?? '')
      if (param.startsWith('us.INX')) {
        const rows = DATES.map((d, i) => [d, closeOf('spy', i, opts).toFixed(2), closeOf('spy', i, opts).toFixed(2), '0', '0', '1000'])
        return reply(JSON.stringify({ code: 0, data: { 'us.INX': { day: rows } } }))
      }
      return reply(tencentDaily(param, opts))
    }
    throw new TypeError(`fetch failed (fixture: ${u.host})`)
  }) as typeof fetch
  return {
    calls,
    total: () => calls.length,
    count: (fragment) => calls.filter((c) => `${c.host}${c.path}${c.q}`.includes(fragment)).length,
    fail,
    restore: () => {
      globalThis.fetch = original
    },
  }
}

const near = (a: number | null, b: number, tol: number, msg: string): void => {
  assert.notEqual(a, null, `${msg}（实际 null）`)
  assert.ok(Math.abs((a as number) - b) <= tol, `${msg}（实际 ${String(a)}，期望 ${b} ±${tol}）`)
}

// ── ① 份额合计 = 100% ────────────────────────────────────────────────────────

test('① 份额合计 = 100%（±0.1 显示位）：五市场全有值时，以及有市场缺值时', async () => {
  freshHome()
  const s = stubFetch()
  try {
    // 纯函数层：分母只含有值市场
    assert.deepEqual(sharesOf([1, 1, 2]), [0.25, 0.25, 0.5], '份额 = 自身 ÷ 有值之和')
    assert.deepEqual(sharesOf([1, null, 3]), [0.25, null, 0.75], '缺值的市场不进分子也不进分母')
    assert.deepEqual(sharesOf([null, null]), [null, null], '全缺 ⇒ 全 null（不许给 0/1/N 这种假值）')
    near(sharesSumPct(sharesOf([1, null, 3])), 100, 1e-9, '有值部分合计 100%')

    const payload = await globalFlowPayload({ now: NOW })
    near(sharesSumPct(payload.markets.map((m) => m.share)), 100, 0.1, '当期份额合计')
    // ② A股 的规模单元格必须**同时**给出人民币原值与折算值（不许只剩折美元后的份额）
    const view0 = globalFlowToolData(payload, 0)
    const cnCell = view0.market?.rows[rowIdxOf(payload, 'cn')][2] ?? ''
    assert.equal(cnCell.includes('亿元'), true, `A股 规模单元格要显示人民币原值：${cnCell}`)
    assert.equal(cnCell.includes('≈'), true, `A股 规模单元格要显示折算关系：${cnCell}`)
    assert.equal(cnCell.includes('亿美元'), true, `A股 规模单元格要显示折算后的美元值：${cnCell}`)
    for (const m of payload.markets) assert.notEqual(m.sharePct, null, `${m.name} 这一轮应当有份额`)
    // 曲线里每一天都要成立（缺值的日子只按有值市场算，但仍必须是 100%）
    assert.ok(payload.curve.points.length >= 365, `曲线至少 365 个序列日（实际 ${payload.curve.points.length}）`)
    // 热身窗口生效：曲线最前面那一天也要能算出偏好分（否则整段开头会空掉）
    assert.equal(payload.curve.points[0].pref.some((v) => v !== null), true, '曲线第一天就应当有偏好分（热身窗口 60 根）')
    for (const p of payload.curve.points) near(sharesSumPct(p.share), 100, 0.1, `${p.day} 的份额合计`)

    // 有市场缺值时同样成立（这是用户口径的硬要求：合计恒为 100%，缺的市场不进分母）
    __resetFlowCache()
    const s2 = stubFetch({ tencentDrop: ['hk02800'] })
    try {
      const partial = await globalFlowPayload({ now: NOW })
      const hk = partial.markets.find((m) => m.key === 'hk')
      // ⚠ 口径 v0.82.0：权重来自**偏好分**（无量纲），规模取不到**不影响**它在分母里的位置
      assert.equal(hk?.aumUsd, null, '规模取不到 ⇒ 规模列 null（不用 0 顶替）')
      assert.notEqual(hk?.sharePct, null, '规模缺 ≠ 权重缺：偏好份额仍然算得出来')
      assert.notEqual(hk?.pref, null, '偏好分来自日线，与规模取数无关')
      near(sharesSumPct(partial.markets.map((m) => m.share)), 100, 0.1, '五个市场仍在分母里 ⇒ 合计仍为 100%')
    } finally {
      s2.restore()
    }
  } finally {
    s.restore()
  }
})

// ── 口径 v2：五市场成分（A股、港股、美国、日本、韩国） ──────────────────────

test('① 五市场名称/顺序/代码/币种逐字 = 需求 T-5（A股、港股、美国、日本、韩国）', async () => {
  freshHome()
  const s = stubFetch()
  try {
    const payload = await globalFlowPayload({ now: NOW })
    assert.deepEqual(payload.markets.map((m) => m.name), ['A股', '港股', '美国', '日本', '韩国'], '五市场名称与顺序逐字')
    assert.deepEqual(payload.markets.map((m) => m.key), ['cn', 'hk', 'us', 'jp', 'kr'], '内部键与展示顺序一致')
    assert.deepEqual(payload.markets.map((m) => m.currency), ['CNY', 'HKD', 'USD', 'USD', 'USD'], '原币：A股人民币 / 港股港元 / 美日韩 美元')
    // 旧成分（v1：美股/欧股/日股/新兴市场）一个都不许留
    const dump = JSON.stringify(payload)
    for (const stale of ['欧股', '新兴市场', 'VGK', 'EEM', "'em'", 'gb_vgk', 'gb_eem']) {
      assert.equal(dump.includes(stale), false, `口径 v2 之后不许再出现旧成分「${stale}」`)
    }
    // 展示顺序 = 需求文档的列举顺序（不是按规模排序）
    assert.equal(payload.markets[0].name, 'A股', '第一行必须是 A股（需求列举顺序）')
  } finally {
    s.restore()
  }
})

test('① 成分表本身就是口径：每条都要有规模来源与动量来源（不许留空）', () => {
  assert.deepEqual([...FLOW_MARKET_ORDER], ['cn', 'hk', 'us', 'jp', 'kr'])
  for (const def of FLOW_MARKETS) {
    assert.ok(def.aumSource.length > 0, `${def.name} 必须写明规模来源`)
    assert.ok(def.benchmark.length > 0 && def.benchmarkSource.length > 0, `${def.name} 必须写明动量口径与来源`)
    assert.equal(def.etf.length > 0, true, `${def.name} 必须写明代理标的`)
  }
  // 港股走"腾讯总市值"、韩国走"腾讯股本×价"（两条都是实测确认过的路径）
  assert.equal(FLOW_MARKETS.find((m) => m.key === 'hk')?.aumSource.includes('亿港元'), true)
  assert.equal(FLOW_MARKETS.find((m) => m.key === 'kr')?.aumSource.includes('f71'), true)
})

test('② 份额合计恒为 100%：缺汇率 / 缺规模都不动摇分母；只有"算不出偏好分"才不进分母', async () => {
  freshHome()
  // 只缺美元/人民币 ⇒ **权重逐项不变**（无量纲），只有"规模（美元）"这一列变成未折算
  {
    const s = stubFetch({ fail: ['fx_susdcny'] })
    try {
      const p = await globalFlowPayload({ now: NOW })
      const cn = p.markets.find((m) => m.key === 'cn')
      assert.equal(cn?.aumNative !== null && cn?.aumNative !== undefined, true, '人民币原值仍在（缺的只是折算）')
      assert.equal(cn?.aumUsd, null, '没有汇率 ⇒ 美元规模必须是 null')
      assert.notEqual(cn?.sharePct, null, '⚠ 权重不依赖汇率 ⇒ 份额照旧')
      assert.equal(p.markets.filter((m) => m.sharePct !== null).length, 5, '五个市场都在分母里')
      near(sharesSumPct(p.markets.map((m) => m.share)), 100, 0.1, '合计仍是 100%')
      // 逐项对拍：与"两条汇率都在"的那一轮**完全相同**
      __resetFlowCache()
      const s2 = stubFetch()
      try {
        const base = await globalFlowPayload({ now: NOW })
        const a = base.markets.map((m) => m.share)
        const b = p.markets.map((m) => m.share)
        for (let i = 0; i < a.length; i += 1) {
          assert.ok(Math.abs((a[i] as number) - (b[i] as number)) < 1e-12, `缺汇率不许改动第 ${i} 个市场的权重（${a[i]} vs ${b[i]}）`)
        }
      } finally {
        s2.restore()
      }
    } finally {
      s.restore()
    }
  }
  // 只缺美元/港元 ⇒ 同上
  {
    __resetFlowCache()
    const s = stubFetch({ fail: ['fx_susdhkd'] })
    try {
      const p = await globalFlowPayload({ now: NOW })
      const hk = p.markets.find((m) => m.key === 'hk')
      assert.equal(hk?.aumNative !== null && hk?.aumNative !== undefined, true, '港元原值仍在')
      assert.equal(hk?.aumUsd, null, '没有港元汇率 ⇒ 美元规模 null')
      assert.notEqual(hk?.sharePct, null, '权重照旧（不缺分母）')
      near(sharesSumPct(p.markets.map((m) => m.share)), 100, 0.1, '合计仍 100%')
    } finally {
      s.restore()
    }
  }
  // 两条都缺 ⇒ 五个市场照样都在分母里
  {
    __resetFlowCache()
    const s = stubFetch({ fail: ['fx_susdcny', 'fx_susdhkd'] })
    try {
      const p = await globalFlowPayload({ now: NOW })
      assert.equal(p.markets.filter((m) => m.sharePct !== null).length, 5, '汇率两条都缺也还是五个市场')
      near(sharesSumPct(p.markets.map((m) => m.share)), 100, 0.1, '合计仍 100%')
      for (const pnt of p.curve.points) near(sharesSumPct(pnt.share), 100, 0.1, `${pnt.day} 的合计`)
    } finally {
      s.restore()
    }
  }
  // **算不出偏好分**的市场（这里让港股的日线整条失败）⇒ 才不进分母
  {
    __resetFlowCache()
    const s = stubFetch({ fail: ['param=hk02800'] })
    try {
      const p = await globalFlowPayload({ now: NOW })
      const hk = p.markets.find((m) => m.key === 'hk')
      assert.equal(hk?.pref, null, '日线取不到 ⇒ 偏好分算不出 ⇒ null')
      assert.equal(hk?.sharePct, null, '算不出偏好分 ⇒ 不进分母（份额 null，不许用 0 顶替）')
      assert.equal(p.markets.filter((m) => m.sharePct !== null).length, 4, '另外四个照常')
      near(sharesSumPct(p.markets.map((m) => m.share)), 100, 0.1, '四个有值市场的合计仍是 100%')
    } finally {
      s.restore()
    }
  }
})

test('③ 缺汇率 ⇒ 规模列未折算 + 行级给原因；**权重逐项不变**（无量纲）', async () => {
  freshHome()
  const cases = [
    { fail: 'fx_susdcny', key: 'cn' as const, nativeWord: '亿元', currencyWord: '人民币', pair: '美元/人民币' },
    { fail: 'fx_susdhkd', key: 'hk' as const, nativeWord: '亿港元', currencyWord: '港元', pair: '美元/港元' },
  ]
  const baseline = (() => null)()
  void baseline
  for (const c of cases) {
    __resetFlowCache()
    // 先跑一轮"汇率都在"的基线，用来对拍权重
    let baseShares: Array<number | null> = []
    {
      const sb = stubFetch()
      try {
        baseShares = (await globalFlowPayload({ now: NOW })).markets.map((m) => m.share)
      } finally {
        sb.restore()
      }
    }
    __resetFlowCache()
    const s = stubFetch({ fail: [c.fail] })
    try {
      const p = await globalFlowPayload({ now: NOW })
      const view = globalFlowToolData(p, 0)
      const idx = rowIdxOf(p, c.key)
      const row = view.market?.rows[idx] ?? []
      const note = view.market?.rowNotes?.[idx] ?? null
      assert.equal(row[2].includes(c.nativeWord), true, `${c.key} 行必须显示原币值：${row[2]}`)
      assert.equal(row[2].includes('未折算'), true, `${c.key} 行必须写"未折算"：${row[2]}`)
      // ⚠ 权重口径 v0.82.0：份额**不再**因为缺汇率而变成「未取到」
      assert.notEqual(row[3], NOT_FETCHED, `${c.key} 的份额不该因为缺汇率而消失：${row[3]}`)
      const nowShares = p.markets.map((m) => m.share)
      for (let i = 0; i < baseShares.length; i += 1) {
        assert.ok(Math.abs((baseShares[i] as number) - (nowShares[i] as number)) < 1e-12, `缺 ${c.pair} 不许改动第 ${i} 个市场的权重`)
      }
      assert.notEqual(note, null, `${c.key} 必须有行级原因（规模列的问题也要给原因）`)
      assert.equal(note?.includes(c.currencyWord), true, `行级原因要说清币种：${note}`)
      assert.equal(note?.includes(c.pair), true, `行级原因要指名缺的是哪条汇率：${note}`)
      assert.equal(note?.includes('偏好份额不受影响'), true, `行级原因要说清"权重不受影响"（否则读者会以为权重也没了）：${note}`)
      // 载荷层也必须有对应条目（两处都要有，不是二选一）
      assert.equal(p.missing.some((m) => m.what.includes(c.pair)), true, `载荷 missing 要有 ${c.pair} 这条`)
    } finally {
      s.restore()
    }
  }
})

test('④ 旧口径快照不被采用：v1（美股/欧股/日股/A股/新兴）整份作废 + 留痕', async () => {
  freshHome()
  // ⚠ 用 flowSnapshotPath()（= DSH_HOME/dsh-tradewatcher/...），不是 DSH_HOME 根
  const path = flowSnapshotPath()
  mkdirSync(dirname(path), { recursive: true })
  // 手写一份 v0.72.0 形状的旧快照（含旧成分的市场键）
  const oldDay = {
    at: NOW - 86_400_000,
    fx: 6.7,
    markets: {
      us: { aumNative: 822272781554, aumUsd: 822272781554, share: 0.89, currency: 'USD', aumSource: '新浪 gb_spy 总市值' },
      eu: { aumNative: 29219072367, aumUsd: 29219072367, share: 0.03, currency: 'USD', aumSource: '新浪 gb_vgk 总市值' },
      jp: { aumNative: 23809338000, aumUsd: 23809338000, share: 0.026, currency: 'USD', aumSource: '新浪 gb_ewj 总市值' },
      cn: { aumNative: 106350374372, aumUsd: 15887190204, share: 0.017, currency: 'CNY', aumSource: '新浪 ETF 节点 nmc' },
      em: { aumNative: 30961800000, aumUsd: 30961800000, share: 0.034, currency: 'USD', aumSource: '新浪 gb_eem 总市值' },
    },
    momentum: { us: null, eu: null, jp: null, cn: null, em: null },
    ranks: { us: null, eu: null, jp: null, cn: null, em: null },
    totalUsd: 936383101921,
    rotationText: '从 新兴市场 转向 美股',
    missing: [],
  }
  writeFileSync(path, JSON.stringify({ v: 1, days: { '2026-10-11': oldDay }, writtenAt: NOW }), 'utf8')

  const s = stubFetch()
  try {
    const snap = await readFlowSnapshot()
    assert.deepEqual(Object.keys(snap.days), [], '⚠ 旧口径的 days 一律不采用（不许与新成分混用）')
    assert.equal(snap.scope, FLOW_SCOPE)
    const purged = flowSnapshotPurged()
    assert.equal(purged.length, 1, `作废必须留痕（实际 ${purged.length} 条）`)
    assert.equal(purged[0].day, '2026-10-11')
    assert.equal(purged[0].reason.includes('口径'), true, `留痕要写清原因：${purged[0].reason}`)

    // 载荷里也不许出现旧成分的历史点
    const p = await globalFlowPayload({ now: NOW })
    const dump = JSON.stringify(p.curve.points)
    assert.equal(dump.includes('2026-10-11'), false, '旧口径的日期不许出现在曲线里')
    assert.equal(p.curve.observedDays, 1, '只有"今天"这一次实测（旧快照不算）')
    // 落盘后文件里要能看到 purged 留痕 + 新的 scope
    await writeFlowSnapshot(p.day, {
      at: NOW,
      rates: { usdCny: 6.69, usdHkd: 7.85 },
      scope: FLOW_SCOPE,
      markets: {} as never,
      momentum: {} as never,
      ranks: {} as never,
      totalUsd: null,
      rotationText: '',
      missing: [],
    })
    const onDisk = JSON.parse(readFileSync(path, 'utf8')) as { v: number; scope: string; purged?: Array<{ day: string }> }
    assert.equal(onDisk.v, 2, '落盘后文件版本 = 2')
    assert.equal(onDisk.scope, FLOW_SCOPE, '落盘后文件带口径标识')
    assert.equal((onDisk.purged ?? []).some((x) => x.day === '2026-10-11'), true, '作废留痕要写回文件（只增不删）')

    // 留痕必须**在界面上说得出来**（不能只躺在文件里）：状态行要主动解释"历史为什么这么短"
    const liveAfter = await globalFlowPayload({ now: NOW })
    const viewAfter = globalFlowToolData(liveAfter, 0)
    assert.equal(liveAfter.snapshot.purged.length > 0, true, '载荷要把作废留痕带出来（否则界面无从解释）')
    // v0.86.0（用户口径）：作废这件事**不再常驻**（一次性迁移说明不该占常驻行）⇒ 事实必须能在悬停里读到
    assert.equal(viewAfter.status.includes('旧口径快照已作废'), false, `常驻行不许再出现作废提示：${viewAfter.status}`)
    assert.equal((viewAfter.statusDetail ?? '').includes('旧口径快照已作废'), true, `作废这件事必须能在悬停详情里读到：${viewAfter.statusDetail}`)
    assert.equal((viewAfter.statusDetail ?? '').includes('2026-10-11'), true, `悬停详情要给出被作废的日期示例：${viewAfter.statusDetail}`)
    assert.equal(viewAfter.status.includes('2026-10-11'), false, `常驻行不再出现作废日期：${viewAfter.status}`)

    // 二级防线：**同一份 v2 文件里**混进一条没有口径标识的旧记录 ⇒ 逐日校验必须丢掉它（不是只信文件头）
    __resetFlowCache()
    const mixed = {
      v: 2,
      scope: FLOW_SCOPE,
      days: {
        '2026-10-11': { ...oldDay, scope: 'v1:us,eu,jp,cn,em' },
        '2026-10-12': {
          at: NOW, rates: { usdCny: 6.69, usdHkd: 7.85 }, scope: FLOW_SCOPE,
          markets: { cn: { aumNative: 1, aumUsd: 1, share: 0.5, currency: 'CNY', aumSource: 'x' }, hk: { aumNative: 1, aumUsd: 1, share: 0.5, currency: 'HKD', aumSource: 'x' }, us: { aumNative: 1, aumUsd: 1, share: null, currency: 'USD', aumSource: 'x' }, jp: { aumNative: 1, aumUsd: 1, share: null, currency: 'USD', aumSource: 'x' }, kr: { aumNative: 1, aumUsd: 1, share: null, currency: 'USD', aumSource: 'x' } },
          momentum: { cn: null, hk: null, us: null, jp: null, kr: null },
          ranks: { cn: null, hk: null, us: null, jp: null, kr: null },
          totalUsd: 5, rotationText: '', missing: [],
        },
      },
      purged: [],
      writtenAt: NOW,
    }
    writeFileSync(path, JSON.stringify(mixed), 'utf8')
    const again = await readFlowSnapshot()
    assert.deepEqual(Object.keys(again.days), ['2026-10-12'], '只有带当前口径标识的那一天能用')
    const mixedPurged = flowSnapshotPurged()
    assert.equal(mixedPurged.some((x) => x.day === '2026-10-11' && x.scope === 'v1:us,eu,jp,cn,em'), true, '混进来的旧记录也要留痕')
  } finally {
    s.restore()
  }
})

// ── 权重口径 v0.82.0：偏好分（不是资产规模）──────────────────────────────────

test('⑦ 偏好分纯函数：贪婪值窗口 60 / 横截面分位 / 55-30-15 权重 / 0 是合法权重', () => {
  // 贪婪值 = 自身 60 根收盘价的区间分位
  const ramp = Array.from({ length: FLOW_GREED_WINDOW }, (_, i) => 100 + i)
  assert.equal(greedOf(ramp), 1, '单调上行 ⇒ 末根就是最高 ⇒ 分位 1')
  assert.equal(greedOf(ramp.map((v) => 300 - (v - 100))), 0, '单调下行 ⇒ 分位 0')
  assert.equal(greedOf(ramp.slice(0, FLOW_GREED_WINDOW - 1)), null, `样本不足 ${FLOW_GREED_WINDOW} 根 ⇒ null（不许给中性默认值）`)
  assert.equal(greedOf(new Array(FLOW_GREED_WINDOW).fill(100)), null, '区间为 0 ⇒ 算不出分位 ⇒ null')
  assert.equal(FLOW_GREED_WINDOW, 60, '窗口写死 60（改口径要同步文档与断言）')
  // 横截面分位：名次 → 0–1；并列取平均名次；缺值 null；只有一个市场 ⇒ null
  assert.deepEqual(percentileRanks([3, 2, 1]), [1, 0.5, 0], '最好 ⇒ 1，最差 ⇒ 0')
  assert.deepEqual(percentileRanks([1, 1, 1]), [0.5, 0.5, 0.5], '全并列 ⇒ 全 0.5（不是 1/0）')
  assert.deepEqual(percentileRanks([5, null, 1]), [1, null, 0], '缺值不参与排名、也不给分位')
  assert.deepEqual(percentileRanks([5]), [null], '只有一个市场 ⇒ 无法比较 ⇒ null（不许当 0.5）')
  // 组合权重：55% / 30% / 15%，三分量任一缺 ⇒ null
  assert.ok(Math.abs((preferenceOf({ greed: 1, mom5: 0, mom20: 0 }) as number) - 0.55) < 1e-12, '贪婪值权重 = 55%')
  assert.ok(Math.abs((preferenceOf({ greed: 0, mom5: 1, mom20: 0 }) as number) - 0.3) < 1e-12, '5 日动量分位权重 = 30%')
  assert.ok(Math.abs((preferenceOf({ greed: 0, mom5: 0, mom20: 1 }) as number) - 0.15) < 1e-12, '20 日动量分位权重 = 15%')
  assert.equal(preferenceOf({ greed: 1, mom5: 1, mom20: 1 }), 1)
  assert.equal(preferenceOf({ greed: 0, mom5: 0, mom20: 0 }), 0, '真的可以得 0')
  assert.equal(preferenceOf({ greed: null, mom5: 1, mom20: 1 }), null, '任一分量缺 ⇒ 偏好分 null（不进分母）')
  // 0 是**合法权重**：得 0 分的市场留在分母里（份额 0%），不许被当成"缺值"踢掉
  assert.deepEqual(sharesFromScores([1, 0, 1]), [0.5, 0, 0.5], '0 分市场仍在分母里 ⇒ 另两家各 50%')
  assert.deepEqual(sharesFromScores([null, null]), [null, null], '全缺 ⇒ 全 null')
  assert.deepEqual(sharesFromScores([0, 0]), [null, null], '分之和为 0 ⇒ 归一化无意义 ⇒ null（不许给 0/1）')
})

test('② 权重**不得**等于规模占比：规模放大一百倍、偏好分垫底的市场，份额必须低', async () => {
  freshHome()
  // 构造：把美股（SPY）的规模放大 100 倍，同时让它的日线**下行**（贪婪值 0、动量分位垫底）
  const s = stubFetch({ aumBoost: { key: 'spy', factor: 100 }, seriesMode: 'distinct', aumMode: 'real' })
  try {
    const p = await globalFlowPayload({ now: NOW })
    const us = p.markets.find((m) => m.key === 'us')
    const hk = p.markets.find((m) => m.key === 'hk')
    // 规模上美股仍是最大（事实）
    assert.ok((us?.aumUsd ?? 0) > (hk?.aumUsd ?? 0) * 10, '构造生效：美股规模仍然远大于港股')
    // 但权重不看规模 ⇒ 美股的偏好份额**不该**接近 100%
    const sizeShare = (us?.aumUsd ?? 0) / p.markets.reduce((acc, m) => acc + (m.aumUsd ?? 0), 0)
    assert.ok(sizeShare > 0.9, `构造生效：按规模算美股占 ${(sizeShare * 100).toFixed(1)}%`)
    assert.ok((us?.sharePct ?? 0) < 50, `⚠ 权重必须来自偏好分、不是规模：美股份额 ${us?.sharePct}%（规模占比 ${(sizeShare * 100).toFixed(1)}%）`)
    // 反例注入：一旦退回"规模权重"，上面这条必红
    const sizeShares = sharesOf(p.markets.map((m) => m.aumUsd))
    const usIdx = rowIdxOf(p, 'us')
    assert.ok((sizeShares[usIdx] as number) > 0.9, `⚠ 反例（规模权重）下美股占 >90%（实际 ${(sizeShares[usIdx] as number) * 100}%）⇒ 与上面的断言互斥（断言不是恒真）`)
    near(sharesSumPct(p.markets.map((m) => m.share)), 100, 0.1, '偏好份额合计仍是 100%')
  } finally {
    s.restore()
  }
})

test('③ 去掉汇率 ⇒ 权重**逐项不变**（无量纲）；只有规模列受影响', async () => {
  freshHome()
  const run = async (fail: string[]): Promise<{ shares: Array<number | null>; aums: Array<number | null> }> => {
    __resetFlowCache()
    const s = stubFetch({ fail })
    try {
      const p = await globalFlowPayload({ now: NOW })
      return { shares: p.markets.map((m) => m.share), aums: p.markets.map((m) => m.aumUsd) }
    } finally {
      s.restore()
    }
  }
  const withFx = await run([])
  const noFx = await run(['fx_susdcny', 'fx_susdhkd'])
  assert.deepEqual(noFx.shares, withFx.shares, '⚠ 用户口径：去掉汇率后，五个权重逐项完全相同（分位/动量都是无量纲的）')
  assert.notDeepEqual(noFx.aums, withFx.aums, '规模列必须真的受影响（A股/港股变成未折算 ⇒ null）')
  assert.equal(noFx.aums.filter((v) => v === null).length, 2, '缺两条汇率 ⇒ A股与港股的规模列 null')
})

test('④ 算不出偏好分的市场不进分母 + 行级给原因；其余市场照常', async () => {
  freshHome()
  const s = stubFetch({ fail: ['param=hk02800'] })
  try {
    const p = await globalFlowPayload({ now: NOW })
    const hk = p.markets.find((m) => m.key === 'hk')
    assert.equal(hk?.pref, null, '日线取不到 ⇒ 偏好分 null')
    assert.equal(hk?.sharePct, null, '不进分母 ⇒ 份额 null（不用 0 顶替）')
    assert.equal(p.missing.some((m) => m.what.includes('序列')), true, `载荷 missing 必须说明是哪条序列取不到：${JSON.stringify(p.missing.map((m) => m.what))}`)
    assert.ok((hk?.missing ?? '').includes('取数失败') || (hk?.missing ?? '').includes('未取到'), `行级原因必须给出失败事实：${hk?.missing}`)
    near(sharesSumPct(p.markets.map((m) => m.share)), 100, 0.1, '其余四个市场的合计仍是 100%')
    const view = globalFlowToolData(p, 0)
    const idx = rowIdxOf(p, 'hk')
    assert.equal(view.market?.rows[idx][3], NOT_FETCHED, '界面上该行份额显示「未取到」')
    assert.notEqual(view.market?.rowNotes?.[idx] ?? null, null, '界面上该行必须有原因')
  } finally {
    s.restore()
  }
})

test('⑤ 口径行必须写清「偏好分归一化、非资产规模、非跨境资金净流入」（工具 + 数据源两处）', () => {
  const d = detailModel(cakeTool)
  const all = [d.kpi.note, d.curve.note, d.pie.note, d.market.note, d.boundary.note, ...d.boundary.lines].join('\n')
  for (const must of ['偏好分', '非资产规模', '非跨境资金净流入']) {
    assert.equal(all.includes(must), true, `口径/边界声明必须出现「${must}」：${all.slice(0, 160)}…`)
  }
  // 反例注入：把关键词删掉 ⇒ 上面必红
  const stripped = all.replaceAll('非资产规模', '').replaceAll('非跨境资金净流入', '')
  assert.equal(stripped.includes('非资产规模') || stripped.includes('非跨境资金净流入'), false, '⚠ 反例（删关键词）必须让断言失败')
  // 数据源（宿主）那一侧也必须有：口径行来自 ToolData.note
  assert.equal(typeof d.market.note, 'string')
})

// ── ② 某市场失败 ⇒ 该行「未取到」+ 原因；整表不显示 0 ────────────────────────

test('② 某市场取数失败 ⇒ 该行「未取到」+ 原因，且整表不显示 0（含客户端渲染层）', async () => {
  freshHome()
  const s = stubFetch({ tencentDrop: ['hk02800'] })
  try {
    const payload = await globalFlowPayload({ now: NOW })
    const hk = payload.markets.find((m) => m.key === 'hk')
    assert.equal(hk?.aumUsd, null, '港股规模取不到 ⇒ 规模列 null')
    // ⚠ 权重口径 v0.82.0：份额来自偏好分（日线），规模取不到**不影响**份额
    assert.notEqual(hk?.sharePct, null, '规模缺 ≠ 权重缺（偏好份额仍在）')
    assert.ok((hk?.missing ?? '').length > 0, '该行必须带原因（缺什么 + 为什么）')
    assert.ok(
      payload.missing.some((m) => m.what.includes('港股')),
      `整份载荷的 missing 里要有这一条：${JSON.stringify(payload.missing.map((m) => m.what))}`,
    )
    // 其余四个市场照常，且合计仍 100%
    assert.equal(
      payload.markets.filter((m) => m.aumUsd !== null).length,
      4,
      `另外四个市场不受影响（实际有值的：${payload.markets.filter((m) => m.aumUsd !== null).map((m) => m.name).join('、')}）`,
    )
    near(sharesSumPct(payload.markets.map((m) => m.share)), 100, 0.1, '有值部分的合计')

    // 客户端渲染层：那一行显示「未取到」，并且**整表没有 0 顶替**
    const model = detailModel(cakeTool, globalFlowToolData(payload, 0))
    assert.equal(model.market.rows.length, 5, '五行都要在（缺数据的那行也要在，不许整行消失）')
    const hkIdx = rowIdxOf(payload, 'hk')
    const hkRow = model.market.rows[hkIdx]
    // ⚠ 口径 v0.82.0：这一轮坏的是**规模**取数 ⇒ 只有"规模"列是「未取到」；
    //    偏好份额 / 偏好分来自日线，照旧有值（这正是"权重不再依赖规模"的可观测形态）
    assert.equal(hkRow[2], NOT_FETCHED, `港股行的"规模"必须是「${NOT_FETCHED}」：${JSON.stringify(hkRow)}`)
    assert.notEqual(hkRow[3], NOT_FETCHED, `偏好份额不该消失：${JSON.stringify(hkRow)}`)
    assert.equal(String(hkRow[4]).includes('—') || /\d/.test(String(hkRow[4])), true, `偏好分应当是数值：${JSON.stringify(hkRow)}`)
    assert.equal(payload.markets.find((m) => m.key === 'hk')?.aumUsd, null, '港股规模列确实没有值')
    assert.ok((model.market.rowNotes[hkIdx] ?? '').includes('港股'), '行下必须给出这一行的原因')
    // 0 顶替判据用**单点实现**（`looksLikeZeroStandIn`），并先自证它非恒真：
    // 手写锚定正则过的那次（`/^0(\.0+)?/`）就是教训（AUDIT-HY4-1 §2）
    assert.equal(looksLikeZeroStandIn('0.00%'), true, '判据必须抓到 0.00%')
    assert.equal(looksLikeZeroStandIn('0.00 亿美元'), true, '判据必须抓到带单位的 0')
    assert.equal(looksLikeZeroStandIn('-0.00'), true, '判据必须抓到负零')
    assert.equal(looksLikeZeroStandIn('0.00pp'), false, '变化列的 0.00pp 是真实的"没变化"，判据不该误报它')
    assert.equal(looksLikeZeroStandIn('未取到'), false, '判据不许把「未取到」当成 0 顶替')
    assert.equal(looksLikeZeroStandIn('+0.01pp'), false, '判据不许把真的小变化当成 0')
    // 只扫「规模」「份额」两列：这两列**不该为 0**（份额 0% 意味着没有规模）。
    // 「份额变化」「动量」可以是真实的 0（没变化），它们的缺失由下面的显式断言看守。
    assert.equal(model.market.rows.length, 5, '五行都要在（否则下面的循环会真空通过）')
    for (const row of model.market.rows) {
      for (const cell of row.slice(2, 4)) {
        assert.equal(looksLikeZeroStandIn(cell), false, `规模/份额列不许出现 0 顶替：${JSON.stringify(row)}`)
      }
      assert.equal(looksLikeZeroStandIn(row[4]) && row[4] !== '0.00pp', false, `变化列不许出现 0 顶替（0.00pp 是真实的"没变化"）：${JSON.stringify(row)}`)
    }
    // 份额列合计仍是 100%（页面脚注会显示它）
    const footnote = model.market.footnotes.join(' ／ ')
    assert.ok(footnote.includes('100.00%'), `脚注要给出合计：${footnote}`)
  } finally {
    s.restore()
  }
})

// ── ③ 轮动文案：无轮动时给等价写法 ──────────────────────────────────────────

test('③ 轮动文案：有轮动 = 从 X 转向 Y；无轮动 = 等价写法（不许硬凑）；判不了 = 第三种', () => {
  const KEY = FLOW_MARKET_ORDER
  const flat = rotationOf({ latest: [0.4, 0.2, 0.2, 0.1, 0.1], previous: [0.4, 0.2, 0.2, 0.1, 0.1] })
  assert.equal(flat.kind, 'flat', '两端完全相同 ⇒ 必须是"未见明确轮动"')
  assert.equal(flat.text.includes('转向'), false, `无轮动时不许出现"转向"：${flat.text}`)
  assert.ok(flat.text.includes('未见明确轮动'), `无轮动必须给等价文案：${flat.text}`)
  assert.equal(flat.fromKey, null, '无轮动时不许指认"从 X"')
  const tiny = rotationOf({ latest: [0.4001, 0.2, 0.2, 0.1, 0.0999], previous: [0.4, 0.2, 0.2, 0.1, 0.1] })
  assert.equal(tiny.kind, 'flat', '变动低于判定线（0.05pp）⇒ 同样算"未见明确轮动"')

  const clear = rotationOf({ latest: [0.5, 0.1, 0.2, 0.1, 0.1], previous: [0.4, 0.2, 0.2, 0.1, 0.1] })
  assert.equal(clear.kind, 'rotation')
  assert.equal(clear.toKey, KEY[0], '份额上升最多的是"转向"的目标')
  assert.equal(clear.fromKey, KEY[1], '份额下降最多的是"转向"的来源')
  assert.match(clear.text, /^从 .+ 转向 .+/, `有轮动时的文案格式：${clear.text}`)

  const unknown = rotationOf({ latest: [0.5, 0.1], previous: null })
  assert.equal(unknown.kind, 'unknown', '序列不够 ⇒ 判不了（不许当成"没有轮动"）')
  assert.ok(unknown.text.includes('判不了'), `判不了要说明：${unknown.text}`)
})

test('③ 整链路：各市场涨速一致 ⇒ 轮动区给"未见明确轮动"（不是硬凑的从 X 转向 Y）', async () => {
  freshHome()
  const s = stubFetch({ aumMode: 'equal', seriesMode: 'same' })
  try {
    const payload = await globalFlowPayload({ now: NOW })
    assert.equal(payload.rotation.kind, 'flat', `涨速一致时不该出现轮动：${payload.rotation.text}`)
    assert.equal(payload.rotation.text.includes('转向'), false, payload.rotation.text)
  } finally {
    s.restore()
  }
})

// ── ④ A股净流入不参与份额计算 ───────────────────────────────────────────────

test('④ A股净流入不参与份额计算：只改它 ⇒ 份额/规模逐项不变', async () => {
  freshHome()
  const s = stubFetch()
  let first: Awaited<ReturnType<typeof globalFlowPayload>>
  try {
    first = await globalFlowPayload({ now: NOW })
    assert.notEqual(first.netFlow.sumCny, null, '这一轮净流入要有值（否则这条断言证不了什么）')
    const sharesBefore = first.markets.map((m) => m.share)
    const aumBefore = first.markets.map((m) => m.aumUsd)

    // 换一份完全不同的资金流（同一个上游符号），清掉缓存后重算
    s.restore()
    const s2 = stubFetch({ moneyFlow: Array.from({ length: 20 }, (_, i) => ({ day: DATES[DATES.length - 1 - i], net: -(i + 1) * 9_000_000 })) })
    try {
      __resetFlowCache()
      const second = await globalFlowPayload({ now: NOW })
      assert.notDeepEqual(second.netFlow.sumCny, first.netFlow.sumCny, '净流入必须真的变了（否则这条用例无效）')
      assert.deepEqual(second.markets.map((m) => m.share), sharesBefore, '净流入变化不许影响任何份额')
      assert.deepEqual(second.markets.map((m) => m.aumUsd), aumBefore, '净流入变化不许影响任何规模')
      near(sharesSumPct(second.markets.map((m) => m.share)), 100, 0.1, '改净流入后的合计')
    } finally {
      s2.restore()
    }
  } finally {
    s.restore()
  }
})

// ── ⑤ 并发 2 次同请求 ⇒ 上游只打 1 次 ───────────────────────────────────────

test('⑤ 并发 2 次同请求 ⇒ 上游只打 1 遍；TTL 内再取 = 0 次', async () => {
  freshHome()
  // 先量出"一次冷启动"的请求数
  const s1 = stubFetch({ delayMs: 20 })
  let cold = 0
  try {
    await globalFlowPayload({ now: NOW })
    cold = s1.total()
    assert.ok(cold > 0, `冷启动应当有上游请求（实际 ${cold}）`)
  } finally {
    s1.restore()
  }

  freshHome()
  const s2 = stubFetch({ delayMs: 20 })
  try {
    // 并发两次（同时，冷缓存）
    const [a, b] = await Promise.all([globalFlowPayload({ now: NOW }), globalFlowPayload({ now: NOW })])
    assert.equal(s2.total(), cold, `并发 2 次必须只打一遍上游（单次冷启动 = ${cold}，实际 ${s2.total()}）`)
    assert.deepEqual(a.markets.map((m) => m.share), b.markets.map((m) => m.share), '两个并发调用方都要拿到同一份数据')
    // TTL 内再取 ⇒ 0 次
    const after = s2.total()
    await globalFlowPayload({ now: NOW + 60_000 })
    assert.equal(s2.total(), after, '载荷 TTL（10 分钟）内再取 ⇒ 上游 0 次')
  } finally {
    s2.restore()
  }
})

// ── ⑥ 回放/快照模式零上游请求 ───────────────────────────────────────────────

test('⑥ source=snapshot 与 30 日回放：零上游请求（含路由层与客户端换帧）', async () => {
  const home = freshHome()
  const s = stubFetch()
  try {
    const live = await globalFlowPayload({ now: NOW })
    assert.ok(live.curve.points.length > 0, '先要有一次现取（同时落一天快照）')
    const snapFile = await readFlowSnapshot()
    assert.equal(Object.keys(snapFile.days).length, 1, '一天一条：当天只写了一条')
    assert.ok(Object.keys(snapFile.days)[0] === DAY, `快照 key 用北京时间的日期：${Object.keys(snapFile.days).join(',')}`)
    assert.equal(flowSnapshotPath().startsWith(home), true, '快照必须落在隔离目录里')

    __resetFlowCache()
    const before = s.total()
    const snap = await globalFlowPayload({ source: 'snapshot', now: NOW })
    assert.equal(s.total() - before, 0, `source=snapshot 不许发任何上游请求（实际发了 ${s.total() - before}）`)
    assert.equal(snap.source, 'snapshot')
    assert.ok(snap.curve.points.length >= 1, '快照模式下曲线只含已记录的日期')

    // 客户端换帧（30 日回放）同样零请求
    const handle = globalFlowToolPayload(snap)
    const n0 = s.total()
    for (const step of [0, 3, 10, handle.replayMax]) handle.at(step)
    assert.equal(s.total() - n0, 0, '拖动回放滑块不许发上游请求（换帧是纯函数）')
    assert.ok(handle.replayMax >= 0 && snap.replay.days.length <= 30, `回放窗口最多 30 个交易日（实际 ${snap.replay.days.length}）`)

    // 路由层：?source=snapshot ⇒ 0 上游；坏参数 ⇒ 400；默认 ⇒ 现取
    const routes = makeTradeRoutes(new DataStore(), [], new CalendarStore())
    const route = routes.routes.find((r) => r.path === '/tradewatcher/tools/global-flow')
    assert.ok(route !== undefined, '工具箱的数据路由必须注册在 /tradewatcher/tools/global-flow')
    const call = async (url: string): Promise<{ status: number; body: Record<string, unknown> }> =>
      await new Promise((resolve) => {
        const req = { url, method: 'GET', headers: { host: '127.0.0.1:3080' }, async *[Symbol.asyncIterator]() {} } as unknown as IncomingMessage
        const res = {
          writeHead() {},
          end(payload: string) {
            resolve({ status: 200, body: JSON.parse(payload) as Record<string, unknown> })
          },
        } as unknown as ServerResponse
        void route.handler(req, res)
      })
    __resetFlowCache()
    const n1 = s.total()
    const got = await call('/tradewatcher/tools/global-flow?source=snapshot')
    assert.equal(s.total() - n1, 0, '路由 source=snapshot 同样零上游请求')
    assert.equal(got.body.source, 'snapshot')
    assert.ok(Array.isArray(got.body.markets) && (got.body.markets as unknown[]).length === 5, '五市场五行固定')
    const bad = await new Promise<number>((resolve) => {
      const req = { url: '/tradewatcher/tools/global-flow?source=whatever', method: 'GET', headers: { host: '127.0.0.1:3080' }, async *[Symbol.asyncIterator]() {} } as unknown as IncomingMessage
      const res = { writeHead(code: number) { resolve(code) }, end() {} } as unknown as ServerResponse
      void route.handler(req, res)
    })
    assert.equal(bad, 400, 'source 只接受 auto / snapshot（认不出就 400，不许静默当 auto）')
  } finally {
    s.restore()
  }
})

// ── 口径断言：汇率 / 快照保留 / 前向填充 / 动量样本 ─────────────────────────

test('口径：汇率取不到 ⇒ A股 不折算、不进美元合计（不静默混算），并如实标注', async () => {
  freshHome()
  const s = stubFetch({ fail: ['fx_susdcny'] })
  try {
    const payload = await globalFlowPayload({ now: NOW })
    const cn = payload.markets.find((m) => m.key === 'cn')
    assert.equal(payload.fx.usdCny, null, '汇率取不到 ⇒ null（不许用默认汇率顶上）')
    assert.notEqual(cn?.aumNative, null, 'A股 的人民币规模仍然要显示出来')
    assert.equal(cn?.aumUsd, null, '⚠ 没有汇率就不许把人民币当美元（aumUsd 必须 null）')
    assert.equal(payload.missing.some((m) => m.what.includes('汇率')), true, '载荷 missing 里必须标出口径不一致')
    // ② 行级原因必须**被渲染层消费**（原因只在载荷 missing[] 里等于没给用户 —— review §3）
    const view = globalFlowToolData(payload, 0)
    const cnIdx = payload.markets.findIndex((m) => m.key === 'cn')
    const cnRow = view.market?.rows[cnIdx] ?? []
    assert.equal(cnRow[2].includes('亿元'), true, `A股 行必须显示人民币原值：${cnRow[2]}`)
    assert.equal(cnRow[2].includes('未折算'), true, `汇率缺时要说"未折算"：${cnRow[2]}`)
    assert.notEqual(cnRow[3], NOT_FETCHED, `⚠ 没有汇率不该让份额消失（权重无量纲）：${cnRow[3]}`)
    assert.equal(String(cnRow[3]).includes('%'), true, `份额应当是百分比读数：${cnRow[3]}`)
    const cnNote = view.market?.rowNotes[cnIdx] ?? null
    assert.notEqual(cnNote, null, '⚠ A股 行必须有行级原因（不许只在载荷 missing[] 里）')
    assert.equal(cnNote?.includes('汇率'), true, `行级原因要说清是汇率的问题：${cnNote}`)
    assert.equal(cnNote?.includes('不进美元合计'), true, `行级原因要说清后果：${cnNote}`)
    // 有值时也要显示原币 + 折算值（正常路径同样不许只剩折美元）
    const usCell = view.market?.rows[rowIdxOf(payload, 'us')][2] ?? ''
    assert.equal(usCell.includes('亿美元'), true, `美元市场显示亿美元口径：${usCell}`)
    const usdTotal = payload.markets.filter((m) => m.key !== 'cn').reduce((acc, m) => acc + (m.aumUsd ?? 0), 0)
    near(payload.totalUsd, usdTotal, 1, '合计只含能折算成美元的市场')
    assert.ok((payload.totalNote ?? '').includes('有值市场'), `合计口径要写清楚：${payload.totalNote}`)
  } finally {
    s.restore()
  }
})

test('快照：一天一条、保留 90 天（第 91 天起丢最旧的）', () => {
  const days: Record<string, unknown> = {}
  for (let i = 0; i < 95; i += 1) {
    const d = new Date(Date.UTC(2026, 6, 1) + i * 86_400_000).toISOString().slice(0, 10)
    days[d] = { at: 1 }
  }
  const keysBefore = Object.keys(days).sort()
  const kept = trimSnapshotDays(days as never)
  const keys = Object.keys(kept).sort()
  assert.equal(keys.length, 90, `保留 90 天（实际 ${keys.length}）`)
  assert.equal(keys[0], keysBefore[5], '丢掉的是最旧的 5 天')
  assert.equal(keys[keys.length - 1], keysBefore[keysBefore.length - 1], '最新的必须留着')
  assert.deepEqual(trimSnapshotDays({ a: { at: 1 } } as never), { a: { at: 1 } }, '不足 90 天时原样保留')
})

test('前向填充：某市场缺一天 ⇒ 该天沿用最近一个已知收盘价（不插值、不断线）', () => {
  const a = [
    { date: '2026-10-08', close: 100 },
    { date: '2026-10-09', close: 110 },
    { date: '2026-10-12', close: 121 },
  ]
  const b = [
    { date: '2026-10-08', close: 50 },
    // 10-09 缺（该市场休市）
    { date: '2026-10-12', close: 55 },
  ]
  const { days, closes } = alignSeries([a, b], 10)
  assert.deepEqual(days, ['2026-10-08', '2026-10-09', '2026-10-12'])
  assert.deepEqual(closes[1], [50, 50, 55], '缺的那天用前值 50（不是 0、不是插值）')

  // 窗口裁剪 + 快照日并入轴
  const { days: days2 } = alignSeries([a], 2, ['2026-10-10'])
  assert.deepEqual(days2, ['2026-10-10', '2026-10-12'], '轴 = 交易日 ∪ 快照日，取最后 window 个')
})

test('曲线：锚定当日实测规模，历史日按收盘价之比重建；实测日与重建日分开标注', () => {
  const chart = [{ date: '2026-10-09', close: 100 }, { date: '2026-10-12', close: 200 }]
  const points = buildCurve({
    anchors: [1000],
    chartSeries: [chart],
    observed: new Map(),
    marketCurrency: ['USD'],
    window: 10,
  })
  assert.deepEqual(points.map((p) => p.origin), ['rebuilt', 'rebuilt'], '没有快照 ⇒ 全是重建日')
  near(points[1].aumUsd[0], 1000, 1e-6, '最后一天锚定实测规模')
  near(points[0].aumUsd[0], 500, 1e-6, '前一天按收盘价之比（100/200）折回去')
  // ⚠ 口径 v0.82.0：份额来自**横截面**偏好分 ⇒ 只有一个市场时无法排名（没有第二者可比较），
  //    因此份额是 null（"样本不足不进分母"），**不许**给 1 或 100% 这种假值
  assert.equal(points[0].share[0], null, '只有一个市场 ⇒ 横截面分位不存在 ⇒ 份额 null（不许给 100%）')
  assert.equal(points[0].pref[0], null, '偏好分同样算不出来')

  const withSnap: FlowPoint[] = buildCurve({
    anchors: [1000],
    chartSeries: [chart],
    observed: new Map([['2026-10-12', { at: NOW, rates: { usdCny: null, usdHkd: 7.8 }, aumNative: [1234] }]]),
    marketCurrency: ['USD'],
    window: 10,
  })
  assert.deepEqual(withSnap.map((p) => p.origin), ['rebuilt', 'observed'], '有快照的那天标成实测')
  near(withSnap[1].aumUsd[0], 1234, 1e-6, '实测日用实测值（不是重建值）')
})

test('动量：20/60/120 日收益率 + 横截面排名；样本不足 ⇒ null（不给 0）', () => {
  const short = Array.from({ length: 25 }, (_, i) => ({ date: DATES[i], close: 100 + i }))
  const m = momentumOf(short)
  assert.notEqual(m.d20, null, '25 根 ⇒ 20 日口径算得出')
  assert.equal(m.d60, null, '样本不足 ⇒ null（不是 0）')
  assert.equal(m.d120, null)
  assert.deepEqual(momentumOf([]), { d20: null, d60: null, d120: null }, '空序列 ⇒ 三项都 null')

  const ranks = momentumRanks([
    { d20: 5, d60: 5, d120: 5 },
    { d20: 1, d60: 1, d120: 1 },
    { d20: 3, d60: 3, d120: 3 },
  ])
  assert.deepEqual(ranks, [1, 3, 2], '横截面排名：1 = 最强')
  assert.deepEqual(momentumRanks([{ d20: 1, d60: null, d120: null }, { d20: null, d60: null, d120: null }]), [1, null], '算不出的市场不给名次')
  assert.deepEqual(momentumRanks([{ d20: 2, d60: 2, d120: 2 }, { d20: 2, d60: 2, d120: 2 }]), [1, 1], '并列取最靠前的名次')
})

test('币种：只有拿到汇率才允许把人民币折成美元', () => {
  const noRates = { usdCny: null, usdHkd: null }
  const rates = { usdCny: 6.6937, usdHkd: 7.8473 }
  assert.equal(toUsd(100, 'USD', noRates), 100, '美元不需要汇率')
  assert.equal(toUsd(100, 'CNY', noRates), null, '⚠ 没有汇率 ⇒ null（不许静默当美元）')
  assert.equal(toUsd(100, 'HKD', noRates), null, '⚠ 港元没有汇率 ⇒ null')
  assert.equal(toUsd(100, 'CNY', rates), 100 / 6.6937, '有汇率才折算')
  assert.equal(toUsd(100, 'HKD', rates), 100 / 7.8473, '港元走美元/港元那条')
  assert.equal(toUsd(100, 'CNY', { usdCny: 6.6937, usdHkd: null }), 100 / 6.6937, '两条汇率互相独立')
  assert.equal(toUsd(null, 'USD', rates), null, '没有值就是 null')
  assert.equal(toUsd(0, 'USD', rates), null, '0 不是"规模为零"，当缺失处理')
})

test('自校告警必须被消费：总市值与「最新价×股本」对不上时，界面必须看见（不许静默用）', async () => {
  freshHome()
  const s = stubFetch({ aumDrift: { spy: 0.5 } }) // 把美股规模砍半（模拟"上游换了下标 12 的含义"）
  try {
    const payload = await globalFlowPayload({ now: NOW })
    const us = payload.markets.find((m) => m.key === 'us')
    assert.notEqual(us?.aumUsd, null, '对不上也照旧给出值（不静默丢数据）')
    const warn = payload.missing.find((m) => m.what.includes('美国'))
    assert.ok(warn !== undefined, `口径存疑必须进 missing（否则界面看不到）：${JSON.stringify(payload.missing.map((m) => m.what))}`)
    assert.equal(warn.note.includes('差 50'), true, `告警要说清差多少：${warn.note}`)
    assert.equal(warn.note.includes('存疑'), true, `告警要说清口径存疑：${warn.note}`)
    const view = globalFlowToolData(payload, 0)
    const usIdx = rowIdxOf(payload, 'us')
    assert.equal((view.market?.rowNotes[usIdx] ?? '').includes('存疑'), true, `行级说明必须带上这条告警：${view.market?.rowNotes[usIdx]}`)
  } finally {
    s.restore()
  }
})

// ── ③ 红线加锁：实测日的洞必须是真洞 ────────────────────────────────────────

test('红线：实测日缺的市场必须留成真洞（不许拿重建值补）—— 含"能补而没补"的对照组', () => {
  // 70 根日线：保证偏好分算得出来（贪婪值要 60 根样本），这样"规模洞"与"权重"才能分别断言
  const dayAt = (i: number): string => new Date(Date.UTC(2026, 5, 1 + i)).toISOString().slice(0, 10)
  const chart = Array.from({ length: 70 }, (_, i) => ({ date: dayAt(i), close: 100 + i }))
  const chart2 = chart.map((r, i) => ({ date: r.date, close: 100 + i * 0.5 }))
  const common = { anchors: [1000, 500], chartSeries: [chart, chart2], marketCurrency: ['USD', 'USD'] as Array<'USD' | 'CNY'>, window: 10 }
  const lastDay = chart[chart.length - 1].date
  const midDay = chart[chart.length - 5].date
  // 对照组：**没有**快照 ⇒ 那天第二家会被重建出来（证明"补洞"这件事在实现里是有的）
  const rebuiltOnly = buildCurve({ ...common, observed: new Map() })
  const rebuiltDay = rebuiltOnly.find((p) => p.day === midDay)
  assert.equal(rebuiltDay?.origin, 'rebuilt')
  assert.notEqual(rebuiltDay?.aumUsd[1], null, '对照组：没有快照的日子第二家会被重建（不是 null）')

  // 正题：那天有快照、且第二家缺规模 ⇒ **规模列**必须留成真洞
  const withSnap = buildCurve({ ...common, observed: new Map([[midDay, { at: NOW, rates: { usdCny: null, usdHkd: null }, aumNative: [900, null] }]]) })
  const day = withSnap.find((p) => p.day === midDay)
  assert.equal(day?.origin, 'observed', '有快照的日期必须是实测日')
  assert.equal(day?.aumUsd[1], null, '⚠ 实测日缺的市场必须是 null（规模列真洞）—— 不许拿重建值补上')
  assert.equal(day?.aumUsd[0], 900, '有值的市场用实测值（不是重建值）')
  assert.equal(day?.partial, true, '实测日有缺值 ⇒ partial 必须为 true')
  // ⚠ 口径 v0.82.0：份额来自**偏好分**（日线），与规模列无关 ⇒ 规模洞不会影响权重
  const noHole = buildCurve({ ...common, observed: new Map([[midDay, { at: NOW, rates: { usdCny: null, usdHkd: null }, aumNative: [900, 800] }]]) })
  const dayNoHole = noHole.find((p) => p.day === midDay)
  assert.equal(day?.pref[1], dayNoHole?.pref[1], '规模有洞 vs 没洞 ⇒ 偏好分逐项相同（权重不吃规模）')
  assert.equal(day?.share[1], dayNoHole?.share[1], '份额同样逐项相同')
  assert.notEqual(day?.share[1], null, '样本够（70 根）⇒ 份额算得出来（不是 null）')
  near(sharesSumPct(day?.share ?? []), 100, 1e-9, '实测日的份额合计仍是 100%')
  // 最后一天（没有快照 ⇒ 重建日）也要一致：规模按收盘价比重建，权重与规模无关
  const last = withSnap[withSnap.length - 1]
  assert.equal(last.day, lastDay)

  // 渲染层同样不许出现"补洞"后的份额
  const view = globalFlowToolData(
    {
      ...payloadShell(),
      curve: { points: withSnap, window: 10, windowOptions: [90, 180, 365], observedDays: 1, rebuiltDays: 2, note: '曲线口径' },
      replay: { days: withSnap.map((p) => p.day), max: withSnap.length - 1, note: '回放口径' },
    },
    // 回放步 = "从最新往回数"：实测日（midDay）在曲线里的位置换算成 step
    withSnap.length - 1 - withSnap.findIndex((p) => p.day === midDay),
  )
  // 界面上：那一行的**规模**列是「未取到」（真洞），而**偏好份额/偏好分**仍是有值读数 ——
  // 这正是"权重不再依赖规模"在人眼可见层面的形态（口径 v0.82.0）
  const viewHoleRow = view.market?.rows[1] ?? []
  assert.equal(viewHoleRow[2], NOT_FETCHED, `实测日缺的市场：规模列必须是「${NOT_FETCHED}」：${JSON.stringify(viewHoleRow)}`)
  assert.notEqual(viewHoleRow[3], NOT_FETCHED, `偏好份额不该被规模洞连坐：${JSON.stringify(viewHoleRow)}`)
  assert.equal(viewHoleRow[4].includes('.'), true, `偏好分应当是数值：${JSON.stringify(viewHoleRow)}`)
})

// ── ⑤ 失败不进缓存 / 回退态 provenance ──────────────────────────────────────

test('失败不进缓存：汇率与资金流本次失败 ⇒ 上游恢复后必须重打（30 分钟 TTL 不锁失败）', async () => {
  freshHome()
  const s = stubFetch({ fail: ['fx_susdcny', 'MoneyFlow'] })
  try {
    const first = await globalFlowPayload({ now: NOW })
    assert.equal(first.fx.usdCny, null, '汇率失败 ⇒ null')
    assert.equal(first.netFlow.sumCny, null, '资金流失败 ⇒ null')
    const fx0 = s.count('fx_susdcny')
    const nf0 = s.count('MoneyFlow')
    assert.equal(fx0, 1, `汇率失败轮打了 ${fx0} 次（期望 1 次）`)
    assert.equal(nf0, 1, `资金流失败轮打了 ${nf0} 次（期望 1 次）`)

    // 上游恢复；把"现在"推进到**残缺载荷 TTL（2 分钟）之外**，其余 TTL（30 分钟）之内
    s.fail.clear()
    const second = await globalFlowPayload({ now: NOW + 3 * 60_000 })
    assert.ok(s.count('fx_susdcny') > fx0, `汇率失败不许进 30 分钟缓存（实际仍停在 ${s.count('fx_susdcny')} 次）`)
    assert.ok(s.count('MoneyFlow') > nf0, `资金流失败不许进 30 分钟缓存（实际仍停在 ${s.count('MoneyFlow')} 次）`)
    assert.notEqual(second.fx.usdCny, null, '恢复后必须拿到汇率')
    assert.notEqual(second.netFlow.sumCny, null, '恢复后必须拿到资金流')
  } finally {
    s.restore()
  }
})

test('回退态 provenance：上游全失败但有快照 ⇒ source=fallback，状态行不许谎称"不发上游请求"', async () => {
  freshHome()
  const s1 = stubFetch()
  try {
    await globalFlowPayload({ now: NOW }) // 先成功一次，落一天快照
  } finally {
    s1.restore()
  }
  const s2 = stubFetch({ fail: ['hq.sinajs.cn', 'finance.sina.com.cn', 'gtimg.cn'] })
  try {
    __resetFlowCache()
    const p = await globalFlowPayload({ now: NOW + 5 * 60_000 })
    assert.equal(p.source, 'fallback', '上游全失败 + 有快照 ⇒ source 必须是 fallback')
    assert.equal(p.fallbackDay, DAY)
    const view = globalFlowToolData(p, 0)
    assert.equal(view.status.includes('上游全部失败'), true, `状态行要说清"这次上游全失败"：${view.status}`)
    assert.equal(view.status.includes('不是实时值'), true, `状态行要说清"不是实时值"：${view.status}`)
    assert.equal(view.status.includes('不发上游请求'), false, `回退态不许说"不发上游请求"（本次发了上游且全失败）：${view.status}`)
    assert.ok((p.missing[0]?.note ?? '').includes(DAY), `missing 要指出快照是哪一天：${p.missing[0]?.note}`)
  } finally {
    s2.restore()
  }
})

test('全缺且无快照：不许引用"快照"（没有兜底就不许说有）', async () => {
  freshHome()
  const s = stubFetch({ fail: ['hq.sinajs.cn', 'finance.sina.com.cn', 'gtimg.cn'] })
  try {
    const p = await globalFlowPayload({ now: NOW })
    assert.equal(p.source, 'live', '压根没有快照时不该伪装成 snapshot/fallback')
    assert.equal(p.snapshot.days, 0)
    assert.equal((p.missing[0]?.note ?? '').includes('还没有任何快照'), true, `missing 要说清"连快照都没有"：${p.missing[0]?.note}`)
    const view = globalFlowToolData(p, 0)
    assert.equal(view.status.includes('来自最近一次本地快照'), false, `不许声称数据来自快照：${view.status}`)
    assert.equal(view.status.includes('本地还没有任何快照'), true, `要说清没有兜底：${view.status}`)
    assert.equal(view.status.includes('上游本次全部失败'), true, view.status)
  } finally {
    s.restore()
  }
})

// ── 视图层：整表不显示 0（构造用例） ────────────────────────────────────────

test('视图：五个市场全缺 ⇒ 每一格都是「未取到」+ 原因（整表零数字、零 0）', async () => {
  freshHome()
  const s = stubFetch({ fail: ['hq.sinajs.cn', 'finance.sina.com.cn', 'gtimg.cn'] })
  try {
    const payload = await globalFlowPayload({ now: NOW })
    assert.equal(payload.markets.every((m) => m.aumUsd === null), true, '全上游失败 ⇒ 五市场都没有规模')
    assert.ok(payload.missing.length >= 5, '每一处缺失都要有原因')
    // 全缺时曲线上**不许有任何点**：更不许出现一个"什么都没测到的实测点"
    //（否则曲线区会画出一张空图、图例还标着"实测日"，把空态顶掉）
    assert.deepEqual(payload.curve.points, [], '全缺时曲线不该有点')
    assert.equal(payload.curve.observedDays, 0, '全缺时不许登记"实测日"')
    assert.equal(payload.curve.rebuiltDays, 0, '全缺时也没有重建日')
    const view = globalFlowToolData(payload, 0)
    const model = detailModel(cakeTool, view)
    assert.deepEqual(model.curve.days, [], '界面上的曲线不该有日期轴')
    assert.deepEqual(model.curve.series, [], '界面上不该有曲线序列')
    assert.deepEqual(model.curve.marks, [], '不该有"实测日"圆点')
    assert.equal(model.curve.empty.includes(NOT_FETCHED), true, `曲线区要走空态（未取到 + 原因）：${model.curve.empty}`)
    for (const row of model.market.rows) {
      for (const cell of row.slice(2)) {
        assert.equal(cell.trim(), NOT_FETCHED, `缺数据的格子必须是「${NOT_FETCHED}」：${JSON.stringify(row)}`)
      }
    }
    for (const note of model.market.rowNotes) assert.ok((note ?? '').length > 0, '每一行都要给原因')
    // 饼图/曲线没有数据 ⇒ 走空态（含原因），不许画一个空饼糊弄
    assert.deepEqual(model.pie.slices, [], '没有份额 ⇒ 不许有饼图分块')
    // ① 脚注：**全缺时不许出现 0.00%**（旧断言用 `^0` 锚定 ⇒ 对「份额合计 = 0.00%」视而不见，恒真；
    //    这里改成"整串里不许出现 0.00%、且必须给「未取到」+ 原因"）
    const footnotes = model.market.footnotes.join(' ／ ')
    assert.equal(footnotes.includes('0.00%'), false, `全缺时脚注不许出现 0.00%（那是把"没有值"求和成 0）：${footnotes}`)
    assert.equal(footnotes.includes(NOT_FETCHED), true, `全缺时脚注必须给「${NOT_FETCHED}」+ 原因：${footnotes}`)
    assert.equal(footnotes.includes('没有一个市场拿到规模'), true, `脚注要说清为什么没有合计：${footnotes}`)
    // 状态行不许声称"数据来自快照"（这次确实没有快照）；说"本地还没有任何快照"是诚实的
    assert.equal(view.status.includes('来自最近一次本地快照'), false, `没有快照时不许说数据来自快照：${view.status}`)
    assert.equal(view.status.includes('只读本地快照'), false, `没有快照时不许说自己只读快照：${view.status}`)
    assert.equal(view.status.includes('本地还没有任何快照'), true, `要说清"连兜底都没有"：${view.status}`)
    assert.equal(view.status.includes('上游本次全部失败'), true, `状态行要说清事故：${view.status}`)
  } finally {
    s.restore()
  }
})

test('⑤ 宏观两档：新浪双源真值 + 自采样给"较上日/5 日变化" + 缺数据给原因（不写 0）', async () => {
  freshHome()
  // 上游可达的用例必须先在隔离的起点上复位熔断（前面若有用例把新浪打挂，这里会以"熔断中"开局）
  for (const host of ['hq.sinajs.cn', 'hq.sinajs.cn/macro', 'push2delay.eastmoney.com/macro']) breakerFor(host).recordSuccess()
  const stub = stubFetch()
  try {
    const { macroRaws, macroLogPath, readMacroLog, writeMacroSample } = await import('./globalFlow.ts')
    // 首次：没有自采样 ⇒ 现值有、history 空（"较上日"由界面如实说未取到）
    const first = await macroRaws()
    assert.equal(first.us10y?.value, 5.156, 'US10Y 现值必须来自真源解析（下标 1）')
    assert.equal(first.dxy?.value, 102.1343, '美元指数现值必须来自 DINIW（下标 8）')
    assert.deepEqual(first.us10y?.history, [], '第一次没有自采样 ⇒ history 为空（不许编一个昨收）')
    assert.ok((first.us10y?.source ?? '').includes('24 小时品种'), '来源口径必须写明 24 小时品种')
    // 交叉核对：本机东财不可达 ⇒ 必须**如实记一条**，但不影响主源读数
    assert.ok(first.notes.some((n) => n.what.includes('东财交叉核对')), '交叉源状态必须如实记进 missing（诚实披露）')
    // 落盘自采样（隔离 DSH_HOME 下）。⚠ 写是**尽力而为、不阻塞载荷**的 ⇒ 等一小会儿再断言
    await new Promise((r) => setTimeout(r, 200))
    assert.equal(existsSync(macroLogPath()), true, '自采样文件要落盘（本机 DSH_HOME 隔离在 /tmp）')
    // 种入 7 个历史交易日 ⇒ 再取一次应当拿到 history（旧→新）
    // 日期递增、值也递增 ⇒ 既锁"旧 → 新"的顺序，也锁"取最近 7 条"
    for (let i = 1; i <= 7; i += 1) {
      await writeMacroSample(`2026-10-${String(i).padStart(2, '0')}`, { dxy: 101 + i * 0.1, us10y: 5 + i / 100, at: Date.now() })
    }
    const log = await readMacroLog()
    assert.equal(Object.keys(log.days).length >= 7, true, '自采样要能累积多天')
    const second = await macroRaws()
    assert.equal(second.us10y?.history.length, 7, `history 取最近 7 条（实得 ${second.us10y?.history.length}）`)
    const h = second.us10y?.history ?? []
    assert.equal(h[0]! < h[6]!, true, `history 顺序 = 旧 → 新（实得 ${h.map((x) => x.toFixed(2)).join(',')}）`)
    assert.equal(Math.round(h[6]! * 100) / 100, 5.07, 'history 末位 = 最近一个采样日（旧→新的"新"端）')
    assert.equal(second.dxy?.samples, 8, '样本数 = 历史 + 今天')
    // 24 小时口径：宿主层**没有任何 A 股休市/交易时段判断**（这两个是 24 小时品种）
    const src = readFileSync(new URL('./globalFlow.ts', import.meta.url), 'utf8')
    const block = src.slice(src.indexOf('宏观两档：美国 10Y'), src.indexOf('曲线/饼图/市场表共用的口径行'))
    assert.equal(/inSession|inTradingSession|tradingDayState|isTradingDay/.test(block), false, '宏观取数不许套 A 股休市/交易时段口径')
    // 反例注入：上游整体失败 ⇒ 现值 null + 原因（不许 0 顶替）
    stub.restore()
    const stubDown = stubFetch({ macroOff: true })
    const third = await macroRaws()
    assert.equal(third.us10y, null, '上游失败 ⇒ 现值 null（不写 0）')
    assert.equal(third.dxy, null, '上游失败 ⇒ 现值 null（不写 0）')
    assert.ok(third.notes.some((n) => n.what.includes('新浪宏观行情') && n.why === 'transient'), `失败原因必须如实给出：${JSON.stringify(third.notes)}`)
    stubDown.restore()
  } finally {
    stub.restore()
  }
})
