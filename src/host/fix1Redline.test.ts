/**
 * 红线批（第一批）的断言：R2（K 线失败进正缓存 + 误导性理由）、R3（缺价按 0 价算盈亏）、
 * R6（已清仓且成本未知 ⇒ 合计按 0 计 + 披露被 qty 门控）、R7（组合构成按 1:1 混币种）。
 * 逐条对应 docs/REVIEW-2-CORRECTNESS.md §R2/§R3/§R6/§R7；R1 在 `readFailRedline.test.ts`。
 *
 * 口径：
 *  - 每个用例都走**真实实现**（真 `fetchKline` / 真 `dayTradesOf` / 真 `assemblePortfolio` /
 *    真工具 `execute`+`render`），不自己重算一遍；
 *  - 上游一律 stub（零真实网络），并**计数**请求次数；
 *  - 时钟钉在盘中（K 线那支需要），`DSH_HOME` 隔离在 `/tmp` 下。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { LedgerEntry, PortGroup, PortItem, QuoteRow } from '../shared/model.ts'
import { dayTradesOf } from './dayTrade.ts'
import { assemblePortfolio } from './portfolio.ts'
import { unknownRealizedRows } from '../shared/model.ts'

const ROOT = mkdtempSync(join(tmpdir(), 'fix1-redline-'))
if (!ROOT.startsWith('/tmp')) throw new Error(`拒绝运行：实验目录必须在 /tmp 下（收到 ${ROOT}）`)

/** 钉住"现在"：北京 2026-10-12（周一）10:30（连续竞价中，K 线那支才回源） */
const REAL_NOW = Date.now
const FAKE_NOW = Date.parse('2026-10-12T10:30:00+08:00')

function pinClock(at = FAKE_NOW): void {
  Date.now = () => at
}

// ─────────────────────────────── R2 ───────────────────────────────

test('R2 K 线：失败不得进正缓存（过了负缓存窗口必须重新回源），且理由按"本轮是否真的请求过"给', async () => {
  const home = join(ROOT, 'r2-home')
  mkdirSync(home, { recursive: true })
  process.env.DSH_HOME = home
  pinClock()
  const em = await import('./em.ts')
  const SECID = '1.600519'

  let klineCalls = 0
  const realFetch = globalThis.fetch
  globalThis.fetch = (async (input: unknown) => {
    const url = String(typeof input === 'string' ? input : (input as { url?: string })?.url ?? '')
    const host = (() => {
      try {
        return new URL(url).host
      } catch {
        return ''
      }
    })()
    const isKline = url.includes('kline/get') || url.includes('ulist.np')
    if (isKline) klineCalls += 1
    if (host === 'web.ifzq.gtimg.cn') return { ok: true, status: 200, json: async () => ({ code: 0, msg: '', data: {} }), text: async () => '{"code":0,"data":{}}' } as unknown as Response
    if (isKline) return { ok: true, status: 200, json: async () => ({ rc: 0, data: { klines: [] } }), text: async () => '{"rc":0,"data":{"klines":[]}}' } as unknown as Response
    return { ok: false, status: 503, json: async () => ({}), text: async () => 'down' } as unknown as Response
  }) as typeof fetch
  try {
    const first = await em.fetchKline(SECID, 101, 800, 1)
    assert.equal(first, null, '上游给的是"200 + 空 klines" ⇒ 拿不到 K 线')
    const calls1 = klineCalls
    assert.ok(calls1 > 0, `第一次必须真的请求过上游（实际 ${calls1} 次）`)
    assert.equal(em.klineLastAttempt(SECID)?.requested, true, '第一次的"事实记录"必须是"发过请求"')

    // 负缓存窗口内（≤10s）：不发请求 —— 但理由必须说"本轮没发请求"（不能是"重试无效"）
    const second = await em.fetchKline(SECID, 101, 800, 1)
    assert.equal(second, null)
    assert.equal(klineCalls, calls1, '负缓存窗口内不重复打上游（这是刻意设计，不是漏请求）')
    const reasonInWindow = em.klineMissingReason(SECID, 101)
    assert.equal(reasonInWindow.why, 'transient', `窗口内没发请求 ⇒ 理由必须是 transient（实际 ${reasonInWindow.why}：${reasonInWindow.note}）`)
    assert.ok(
      reasonInWindow.note.includes('没有向上游发请求'),
      `理由必须如实说"没发请求"，不能是"上游可达但没返回、重试无效"（实际：${reasonInWindow.note}）`,
    )
    assert.equal(em.klineLastAttempt(SECID)?.requested, false, '窗口内的这次必须记成"没发请求"')

    // 过了负缓存窗口（+11s）：**必须重新回源** —— 旧实现里失败占了 1 小时正缓存，这里会是 0 次
    pinClock(FAKE_NOW + 11_000)
    const third = await em.fetchKline(SECID, 101, 800, 1)
    assert.equal(third, null)
    assert.ok(
      klineCalls > calls1,
      `过了负缓存窗口必须重新回源（旧实现：失败进了 1 小时正缓存 ⇒ 这里 0 次；实际 ${klineCalls - calls1} 次）`,
    )
    const reasonAfterRetry = em.klineMissingReason(SECID, 101)
    assert.equal(reasonAfterRetry.why, 'no-source', '这次真的请求过了 ⇒ 才允许说"上游可达但没给数据"')
    assert.ok(reasonAfterRetry.note.includes('确实请求过'), `理由要带上事实依据（实际：${reasonAfterRetry.note}）`)
  } finally {
    globalThis.fetch = realFetch
    Date.now = REAL_NOW
  }
})

// ─────────────────────────────── R3 ───────────────────────────────

test('R3 做T：缺成交价的流水不得按 0 价算盈亏（不许编出"净 −10011、胜率 0%"）', () => {
  let seq = 0
  const e = (verb: 'buy' | 'sell', qty: number, price: number | undefined, ts: number): LedgerEntry => ({
    id: `e${++seq}`,
    ts,
    actor: 'web',
    verb,
    posId: 'p1',
    qty,
    ...(price === undefined ? {} : { price }),
  })
  const DAY = Date.UTC(2026, 9, 12, 2, 0, 0) // 北京 10:00
  const r = dayTradesOf([e('buy', 1000, 10, DAY), e('sell', 1000, undefined, DAY + 3_600_000)])
  assert.equal(r.rounds.length, 0, '缺价的卖出不构成往返（旧实现按 0 价配出一次往返，grossPnl = −10000）')
  assert.equal(r.summary.netPnl, null, '有未计价流水 ⇒ 净盈亏必须是 null（不能是 −10011，也不能是 0）')
  assert.equal(r.summary.winRate, null, '胜率同样不可算 ⇒ null（旧实现给 0%）')
  assert.equal(r.summary.avgNet, null)
  assert.equal(r.summary.unpricedCount, 1, '未计价流水条数要如实报')
  const un = r.unmatched.find((u) => u.price === null)
  assert.ok(un !== undefined, `缺价流水必须出现在 unmatched（实际 ${JSON.stringify(r.unmatched)}）`)
  assert.equal(un?.verb, 'sell')
  assert.equal(un?.qty, 1000)
  assert.ok((un?.note ?? '').includes('未取到'), `原因要写清"未取到"（实际 ${String(un?.note)}）`)
  // 价格齐全时照常算（不能在修复里把正常路径也废掉）
  const ok = dayTradesOf([e('buy', 1000, 10, DAY), e('sell', 1000, 11, DAY + 3_600_000)])
  assert.equal(ok.rounds.length, 1)
  assert.equal(ok.summary.netPnl, 1000)
  assert.equal(ok.summary.unpricedCount, 0)
})

// ─────────────────────────────── R6 ───────────────────────────────

const groupG: PortGroup = { id: 'g1', name: '主仓', order: 1 }
const posOf = (id: string, secid: string, name: string): PortItem => ({ id, groupId: 'g1', secid, name, createdAt: 1 })
const quoteOf = (secid: string, price: number): QuoteRow => ({
  secid,
  code: secid.split('.')[1] ?? secid,
  name: secid,
  price,
  chg: 0,
  pct: 0,
  prev: price,
  open: null,
  high: null,
  low: null,
  vol: null,
  amount: null,
  up: null,
  down: null,
  even: null,
  time: null,
})

test('R6 已清仓且成本未知：合计不得按 0 计（如实 null），披露不得被 qty 门控挡掉', async () => {
  let seq = 0
  const entry = (verb: 'adjust' | 'buy' | 'sell', posId: string, qty: number, price: number | undefined, ts: number): LedgerEntry => ({
    id: `L${++seq}`,
    ts,
    actor: 'web',
    verb,
    posId,
    qty,
    ...(price === undefined ? {} : { price }),
  })
  const T = Date.UTC(2026, 9, 1, 2, 0, 0)
  // 甲：成本从未录入（adjust 100@0）→ 全部卖出 ⇒ 已清仓、realized 不可算
  // 乙：正常买卖 ⇒ realized 200（可算）
  const entries: LedgerEntry[] = [
    entry('adjust', 'p1', 100, 0, T),
    entry('sell', 'p1', 100, 12.5, T + 3_600_000),
    entry('buy', 'p2', 100, 10, T),
    entry('sell', 'p2', 100, 12, T + 3_600_000),
  ]
  const items = [posOf('p1', '1.600519', '甲（成本未知已清仓）'), posOf('p2', '0.300750', '乙')]
  const quotes = { '1.600519': quoteOf('1.600519', 12.5), '0.300750': quoteOf('0.300750', 12) }
  const { view } = assemblePortfolio([groupG], items, entries, quotes, { mode: 'none', rates: {} })
  // ① 不可算的行必须被披露（p1 已清仓：qty === 0，旧门控会把它挡掉）
  const unknown = view.positions.filter((p) => p.costUnknown === true || (p.realizedUnknownQty ?? 0) > 0)
  const cleared = unknown.filter((p) => p.qty === 0)
  assert.ok(cleared.length >= 1, `已清仓且不可算的行必须能被识别（实际 ${JSON.stringify(view.positions.map((p) => [p.name, p.qty, p.costUnknown, p.realized, p.realizedUnknownQty]))}）`)
  // ② 合计：任一行不可算 ⇒ 合计如实为 null（旧实现把 null 静默当 0，给出"看着正常的 200.00"）
  assert.equal(view.grand.realized, null, `存在不可算的行 ⇒ 累计已实现必须是 null（实际 ${String(view.grand.realized)}）`)
  assert.ok(
    (view.grand.realizedUnknownCount ?? 0) >= 1,
    `必须给出"少算了几行"（实际 ${String(view.grand.realizedUnknownCount)}）`,
  )
  assert.ok(view.groups.every((g) => g.realized === null), '分组合计同理（不能只让总览诚实）')
  // ③ 工具面：default includeEmpty=false **不得**把披露挡掉
  const { DataStore } = await import('./store.ts')
  const { makeAgentTools } = await import('./tools.ts')
  const dir = join(ROOT, 'r6-store')
  mkdirSync(dir, { recursive: true })
  const store = new DataStore(dir)
  await store.init()
  await store.mutatePortfolio({ op: 'addGroup', name: '主仓' })
  const gid = store.portData().groups[0]?.id as string
  await store.mutatePortfolio({ op: 'addPos', groupId: gid, secid: '1.600519', symbolName: '甲' })
  const p1 = store.portData().items[0]?.id as string
  await store.mutatePortfolio({ op: 'adjust', posId: p1, qty: 100, price: 0 })
  await store.mutatePortfolio({ op: 'sell', posId: p1, qty: 100, price: 12.5 })
  const defs: Array<{
    name: string
    execute: (a: unknown) => Promise<unknown>
    /** 真实结构：渲染函数挂在 `output.render`（不是 def.render） */
    output?: { render?: (a: unknown, v: unknown) => unknown }
  }> = []
  const kernel = makeAgentTools(store, undefined, undefined, undefined, {})
  kernel.registerTools(
    // 真实运行时 API：`tools.register(def)`（见 host/context.ts 的 PluginToolRuntime）
    { register: (def: never) => (defs.push(def), () => undefined) } as never,
    { section: () => () => undefined } as never,
  )
  const def = defs.find((d) => d.name.endsWith('portfolio') && d.name.startsWith('tradewatcher'))
  assert.ok(def !== undefined, `必须注册了 tradewatcher_portfolio（实际 ${defs.map((d) => d.name).join(', ')}）`)
  const realFetch2 = globalThis.fetch
  globalThis.fetch = (() => Promise.reject(new Error('offline (test)'))) as typeof fetch
  const value = (await def.execute({}).finally(() => {
    globalThis.fetch = realFetch2
  })) as {
    view?: { grand?: { realized?: number | null }; positions?: Array<{ qty: number }> }
    unknownRealized?: Array<{ name: string; cleared: boolean }>
  }
  assert.ok(
    (value.unknownRealized ?? []).some((u) => u.cleared),
    `工具回包必须带上"已清仓且不可算"的行（实际 ${JSON.stringify(value.unknownRealized)}）`,
  )
  assert.equal(value.view?.grand?.realized, null, '工具面的累计已实现同样必须是 null')
  assert.ok(typeof def.output?.render === 'function', '工具必须提供 output.render')
  const text = JSON.stringify(def.output.render({}, value))
  assert.ok(text.includes('未取到'), `工具正文必须写出"未取到"（实际 ${text.slice(0, 400)}）`)
  assert.ok(text.includes('甲'), '工具正文必须点名是哪个标的不可算')
  // 判据与聚合同源
  assert.ok(unknownRealizedRows(view.positions).length >= 1, 'shared 的同一份判定必须认这两类行')
})

// ─────────────────────────────── R7 ───────────────────────────────

test('R7 组合构成：真实路径（assemblePortfolio）不得把 HKD/USD 与 CNY 按 1:1 相加', () => {
  const items = [posOf('p1', '1.600519', 'A股'), posOf('p2', '116.00700', '港股'), posOf('p3', '105.TLT', '美股')]
  const entries: LedgerEntry[] = [
    { id: 'e1', ts: 1, actor: 'web', verb: 'buy', posId: 'p1', qty: 100, price: 11 },
    { id: 'e2', ts: 1, actor: 'web', verb: 'buy', posId: 'p2', qty: 200, price: 320 },
    { id: 'e3', ts: 1, actor: 'web', verb: 'buy', posId: 'p3', qty: 10, price: 420 },
  ]
  const quotes = { '1.600519': quoteOf('1.600519', 11), '116.00700': quoteOf('116.00700', 320), '105.TLT': quoteOf('105.TLT', 420) }
  const { view } = assemblePortfolio([groupG], items, entries, quotes, { mode: 'none', rates: {} })
  const comp = view.composition
  assert.ok(comp !== undefined, '组合构成必须存在')
  assert.equal(comp.totalMv, 1100, `分母只能含人民币口径：A股 100×11（旧实现 69300 = 三者 1:1 直接相加）`)
  assert.equal(view.grand.totalMv, 1100, '组合构成与 grand 必须用同一份"能折算才计入"的集合')
  const hk = comp.rows.find((r) => r.secid === '116.00700')
  assert.equal(hk?.weightPct, null, '折不了的港股权重必须是 null（不能是 92.4% 这种按 1:1 算出来的错数）')
  assert.equal(hk?.mv, 64000, '原币种市值照样给出（不隐藏事实）')
  assert.equal(comp.excludedNonCny, 2, '被排除的非人民币条数必须标注')
  assert.ok((comp.concentration.top1 ?? 0) > 0 && comp.concentration.n === 1, '集中度只统计进了分母的行')
  // 开了固定汇率后：按人民币口径计入，权重合计仍 100%±0.01
  const withFx = assemblePortfolio([groupG], items, entries, quotes, { mode: 'fixed', rates: { HKD: 0.92, USD: 7.1 } })
  const c2 = withFx.view.composition
  assert.equal(c2?.totalMv, 1100 + 200 * 320 * 0.92 + 10 * 420 * 7.1, '固定汇率折算后计入')
  const sum = (c2?.rows ?? []).reduce((n, r) => n + (r.weightPct ?? 0), 0)
  assert.ok(Math.abs(sum - 100) <= 0.01, `折算后权重合计仍是 100%±0.01（实际 ${sum}）`)
})
