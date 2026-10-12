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
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import {
  __resetFlowCache,
  FLOW_MARKET_ORDER,
  alignSeries,
  buildCurve,
  flowSnapshotPath,
  globalFlowPayload,
  momentumOf,
  momentumRanks,
  readFlowSnapshot,
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
import { makeTradeRoutes } from './routes.ts'
import { DataStore } from './store.ts'
import { CalendarStore } from './calendar.ts'

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

const DATES = tradingDays(200)

/** 各市场规模（原币）：与实测同一量级（SPY 8222 亿美元 / 510300 1063.5 亿元 …） */
const AUM: Record<string, { totalMv: string; shares: string }> = {
  // 下标 12 = 总市值（用户口径的"字段 13"，1 起数），下标 19 = 股本（用于交叉校验）
  spy: { totalMv: '822272781554.0000', shares: '1056132116' },
  vgk: { totalMv: '29219072367.0000', shares: '339638177' },
  ewj: { totalMv: '23809338000.0000', shares: '243300000' },
  eem: { totalMv: '30961800000.0000', shares: '463500000' },
}
const PRICE: Record<string, number> = { spy: 778.57, vgk: 86.03, ewj: 97.86, eem: 66.8 }
const CN_NMC_WAN = '10635037.4372'

interface StubOptions {
  /** 让这些上游符号失败（按 URL 片段匹配） */
  fail?: string[]
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
}

interface Stub {
  calls: Array<{ host: string; path: string; q: string }>
  total: () => number
  count: (fragment: string) => number
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

/** 各市场收盘价序列：`distinct` 时涨速不同（名次确定），`same` 时完全一致 */
function closeOf(symbol: string, i: number, opts: StubOptions): number {
  const base: Record<string, number> = { spy: 600, vgk: 85, ewj: 95, eem: 65, '510300': 4.3, '000300': 4300 }
  const slope: Record<string, number> = { spy: 0.30, vgk: 0.02, ewj: 0.10, eem: 0.06, '510300': -0.05, '000300': -0.05 }
  const s = opts.seriesMode === 'same' ? 0.05 : (slope[symbol] ?? 0.05)
  return (base[symbol] ?? 100) * (1 + (s * i) / DATES.length) + 0.0
}

function tencentDaily(param: string, opts: StubOptions): string {
  const code = param.split(',')[0]
  const rows = DATES.map((d, i) => [d, closeOf(code, i, opts).toFixed(3), closeOf(code, i, opts).toFixed(3), '0', '0', '1000'])
    .filter((r) => !(opts.gapDay !== undefined && opts.gapDay.symbol === code && opts.gapDay.day === r[0]))
  const node: Record<string, unknown> = { [code]: { day: rows, qfqday: rows } }
  return JSON.stringify({ code: 0, data: node })
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
  const fail = opts.fail ?? []
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
      if (list === 'fx_susdcny') return reply('var hq_str_fx_susdcny="20:48:01,6.6932,6.6935,6.6929,25.0,6.6930,6.6940,6.6915,6.6937,USDCNY,0.0120,0.0008,0.0025";')
      const symbols = list.split(',').filter((s) => s.startsWith('gb_')).map((s) => s.slice(3))
      if (symbols.length === 0) throw new TypeError('fetch failed (fixture: unknown sina list)')
      return reply(symbols.map((s) => gbLine(s, AUM[s]?.totalMv ?? '1000000.0000', AUM[s]?.shares ?? '100000')).join('\n'))
    }
    if (u.host === 'stock.finance.sina.com.cn') {
      const symbol = String(u.searchParams.get('symbol') ?? '')
      return reply(usDailyJsonp(symbol, opts))
    }
    if (u.host === 'vip.stock.finance.sina.com.cn') {
      if (u.pathname.includes('MoneyFlow')) return reply(moneyFlowPayload(opts.moneyFlow ?? defaultMoneyFlow()))
      return reply(etfNodePayload(opts))
    }
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
    for (const m of payload.markets) assert.notEqual(m.sharePct, null, `${m.name} 这一轮应当有份额`)
    // 曲线里每一天都要成立（缺值的日子只按有值市场算，但仍必须是 100%）
    assert.ok(payload.curve.points.length >= 180, `曲线至少 180 个序列日（实际 ${payload.curve.points.length}）`)
    for (const p of payload.curve.points) near(sharesSumPct(p.share), 100, 0.1, `${p.day} 的份额合计`)

    // 有市场缺值时同样成立（这是用户口径的硬要求：合计恒为 100%，缺的市场不进分母）
    __resetFlowCache()
    const s2 = stubFetch({ fail: ['gb_vgk'] })
    try {
      const partial = await globalFlowPayload({ now: NOW })
      const eu = partial.markets.find((m) => m.key === 'eu')
      assert.equal(eu?.sharePct, null, '取不到数的市场必须是 null（不是 0）')
      near(sharesSumPct(partial.markets.map((m) => m.share)), 100, 0.1, '缺一个市场后的合计仍为 100%')
    } finally {
      s2.restore()
    }
  } finally {
    s.restore()
  }
})

// ── ② 某市场失败 ⇒ 该行「未取到」+ 原因；整表不显示 0 ────────────────────────

test('② 某市场取数失败 ⇒ 该行「未取到」+ 原因，且整表不显示 0（含客户端渲染层）', async () => {
  freshHome()
  const s = stubFetch({ fail: ['gb_vgk', 'symbol=vgk'] })
  try {
    const payload = await globalFlowPayload({ now: NOW })
    const eu = payload.markets.find((m) => m.key === 'eu')
    assert.equal(eu?.aumUsd, null, '欧股规模取不到 ⇒ null')
    assert.equal(eu?.sharePct, null, '份额也必须 null')
    assert.ok((eu?.missing ?? '').length > 0, '该行必须带原因（缺什么 + 为什么）')
    assert.ok(
      payload.missing.some((m) => m.what.includes('欧股')),
      `整份载荷的 missing 里要有这一条：${JSON.stringify(payload.missing.map((m) => m.what))}`,
    )
    // 其余四个市场照常，且合计仍 100%
    assert.equal(payload.markets.filter((m) => m.aumUsd !== null).length, 4, '另外四个市场不受影响')
    near(sharesSumPct(payload.markets.map((m) => m.share)), 100, 0.1, '有值部分的合计')

    // 客户端渲染层：那一行显示「未取到」，并且**整表没有 0 顶替**
    const model = detailModel(cakeTool, globalFlowToolData(payload, 0))
    assert.equal(model.market.rows.length, 5, '五行都要在（缺数据的那行也要在，不许整行消失）')
    const euRow = model.market.rows[1]
    assert.deepEqual(euRow.slice(2, 5), [NOT_FETCHED, NOT_FETCHED, NOT_FETCHED], `欧股行的规模/份额/变化必须是「${NOT_FETCHED}」：${JSON.stringify(euRow)}`)
    assert.ok((model.market.rowNotes[1] ?? '').includes('欧股'), '行下必须给出这一行的原因')
    for (const row of model.market.rows) {
      for (const cell of row) {
        assert.equal(/^[+-]?0(\.0+)?\s*%?$/.test(cell.trim()), false, `整表不许出现 0 顶替：${JSON.stringify(row)}`)
      }
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
    assert.ok((cn?.missing ?? '').length > 0 || payload.missing.some((m) => m.what.includes('汇率')), '必须标注口径不一致')
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
  near(points[0].share[0], 1, 1e-9, '只有一个市场时份额 100%')

  const withSnap: FlowPoint[] = buildCurve({
    anchors: [1000],
    chartSeries: [chart],
    observed: new Map([['2026-10-12', { at: NOW, fx: null, aumNative: [1234] }]]),
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
  assert.equal(toUsd(100, 'USD', null), 100, '美元不需要汇率')
  assert.equal(toUsd(100, 'CNY', null), null, '⚠ 没有汇率 ⇒ null（不许静默当美元）')
  assert.equal(toUsd(100, 'CNY', 7), 100 / 7, '有汇率才折算')
  assert.equal(toUsd(null, 'USD', 7), null, '没有值就是 null')
  assert.equal(toUsd(0, 'USD', 7), null, '0 不是"规模为零"，当缺失处理')
})

// ── 视图层：整表不显示 0（构造用例） ────────────────────────────────────────

test('视图：五个市场全缺 ⇒ 每一格都是「未取到」+ 原因（整表零数字、零 0）', async () => {
  freshHome()
  const s = stubFetch({ fail: ['hq.sinajs.cn', 'finance.sina.com.cn', 'gtimg.cn'] })
  try {
    const payload = await globalFlowPayload({ now: NOW })
    assert.equal(payload.markets.every((m) => m.aumUsd === null), true, '全上游失败 ⇒ 五市场都没有规模')
    assert.ok(payload.missing.length >= 5, '每一处缺失都要有原因')
    const model = detailModel(cakeTool, globalFlowToolData(payload, 0))
    for (const row of model.market.rows) {
      for (const cell of row.slice(2)) {
        assert.equal(cell.trim(), NOT_FETCHED, `缺数据的格子必须是「${NOT_FETCHED}」：${JSON.stringify(row)}`)
      }
    }
    for (const note of model.market.rowNotes) assert.ok((note ?? '').length > 0, '每一行都要给原因')
    // 饼图/曲线没有数据 ⇒ 走空态（含原因），不许画一个空饼糊弄
    assert.deepEqual(model.pie.slices, [], '没有份额 ⇒ 不许有饼图分块')
    assert.equal(/^0(\.0+)?/.test(model.market.footnotes[0] ?? ''), false, `脚注也不许出现 0：${model.market.footnotes[0]}`)
  } finally {
    s.restore()
  }
})
