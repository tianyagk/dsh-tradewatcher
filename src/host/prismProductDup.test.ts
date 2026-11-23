/**
 * 棱镜【同产品重复闸 + 委托价偏离闸】（v0.214.0）。
 *
 * 实机事故：持仓同时有 `1.511130 30年国债ETF博时`（200 股）与 `1.511090 30年国债ETF鹏扬`（400 股），
 * 12 笔长债委托里 11 笔买鹏扬、1 笔买博时——理由都只写「补低波端」，模型从没看见这是同一条腿；
 * 而博时那笔成交价 121.825 取自 511090（该标的当日区间 110.93–111.50），造成 −2 069 元假亏损。
 *
 * 三层修法：
 *   A. `productKeyOf` + `clampDecision` 同产品闸：买单标的是 ETF 且已持另一只同键 ETF（或已有同键挂单）⇒ 拒；
 *      对已持有那只继续加仓不拦。
 *   B. `clampDecision` 委托价偏离闸：|委托价 ÷ 现价 − 1| > 3% ⇒ 拒；无现价 ⇒ 放行但记 `skipped`。
 *   C. `prismInputsOf` 增加【ETF 按产品合并】：同键 ETF 合并一行（名称列表 + 合计权重 + 合计市值）。
 *
 * 每个闸都带反例注入：去掉闸 ⇒ 重复腿进入账户 / 121.825 按错价成交，判据必败。
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readFileSync } from 'node:fs'
import type { DataStore } from './store.ts'
import type { PrismDecision } from '../shared/prism.ts'
import { PrismTradingStore, clampDecision, matchTick, placeDecision, productKeyOf } from './prismAccount.ts'
import { PrismStore } from './prismStore.ts'
import { etfProductsTextOf, prismInputsOf } from './prismRoutes.ts'
import { runPrismAnalysis } from './prismPipeline.ts'

const DAY = '2026-11-23'
const AT = Date.parse(`${DAY}T10:00:00+08:00`)
const BS = { secid: '1.511130', name: '30年国债ETF博时' } as const
const PY = { secid: '1.511090', name: '30年国债ETF鹏扬' } as const

const decisionOf = (orders: PrismDecision['orders']): PrismDecision => ({
  limits: { singlePct: null, totalPct: null, note: null },
  note: '补低波端',
  orders,
  cancel: [],
  rejects: [],
  parseError: null,
})

/** 生产形状的 ctx：行情带名称+现价，持仓带名称（同产品闸两个来源缺一不可） */
const ctxOf = (over: Record<string, unknown> = {}) => ({
  cash: 500_000,
  positions: [{ secid: BS.secid, name: BS.name, qty: 200, price: 111.2, industry: null }],
  limits: {},
  at: AT,
  quotes: {
    [BS.secid]: { name: BS.name, price: 111.2 },
    [PY.secid]: { name: PY.name, price: 111.2 },
  },
  ...over,
})

const accountOf = (over: Record<string, unknown> = {}) => ({
  day: DAY,
  capitalLimit: 1_500_000,
  capital: 1_500_000,
  cash: 500_000,
  realized: 0,
  dayStartEquity: null,
  positions: [{ secid: BS.secid, name: BS.name, qty: 200, available: 200, cost: 111.48 }],
  copiedAt: null,
  copyLogs: [],
  ...over,
})

const quoteLiteOf = (): Record<string, { name: string; price: number | null; prev: number | null }> => ({
  [BS.secid]: { name: BS.name, price: 111.2, prev: 111.3 },
  [PY.secid]: { name: PY.name, price: 111.2, prev: 111.3 },
})

/* ────────────────────────── A. productKeyOf ────────────────────────── */

test('① productKeyOf：博时/鹏扬同键；华泰柏瑞/易方达沪深300 同键；黄金与长债不同键；无 ETF 原样', () => {
  assert.equal(productKeyOf('30年国债ETF博时'), '30年国债ETF', '取 ETF 及之前的部分')
  assert.equal(productKeyOf('30年国债ETF鹏扬'), '30年国债ETF')
  assert.equal(productKeyOf('30年国债ETF博时'), productKeyOf('30年国债ETF鹏扬'), '同一跟踪标的的两只 ETF 必须同键')
  assert.equal(productKeyOf('沪深300ETF华泰柏瑞'), '沪深300ETF')
  assert.equal(productKeyOf('沪深300ETF易方达'), productKeyOf('沪深300ETF华泰柏瑞'), '不同基金公司的沪深300ETF 必须同键')
  assert.notEqual(productKeyOf('黄金ETF华安'), productKeyOf('30年国债ETF鹏扬'), '黄金 ETF 与长债 ETF 不得同键')
  assert.equal(productKeyOf('贵州茅台'), '贵州茅台', '名称里没有 ETF ⇒ 原样返回（不猜）')
  assert.equal(productKeyOf(' 招商轮船 '), '招商轮船', '首尾空白不参与键')
})

/* ────────────────────────── A. 同产品重复闸 ────────────────────────── */

test('② 同产品闸：持博时买鹏扬 ⇒ 拒（原因含名称+代码，orders 为空）', () => {
  const r = clampDecision(decisionOf([{ secid: PY.secid, side: 'buy', price: 111.2, shares: 400, reason: '补低波端' }]), ctxOf())
  assert.equal(r.decision.orders.length, 0, '同产品重复买单不得进入 orders（不撮合/不写 pending）')
  assert.equal(r.rejected.length, 1)
  assert.equal(r.rejected[0]?.reason, `同产品已持有 ${BS.name}（${BS.secid}），不重复建仓；如需加仓请直接加该标的`)
  assert.equal(r.events.length, 0, '同产品闸不是裁剪，不得产生 clampEvents')
})

test('③ 同产品闸反例：持博时买博时（加仓同一只）⇒ 放行', () => {
  const r = clampDecision(decisionOf([{ secid: BS.secid, side: 'buy', price: 111.2, shares: 100, reason: '加仓' }]), ctxOf())
  assert.equal(r.decision.orders.length, 1, '对已持有那只继续加仓必须放行')
  assert.equal(r.rejected.length, 0)
})

test('④ 同产品闸反例：无同键持仓 ⇒ 放行；同键但不同产品（黄金 ETF）⇒ 放行', () => {
  const empty = clampDecision(
    decisionOf([{ secid: PY.secid, side: 'buy', price: 111.2, shares: 400, reason: '建仓' }]),
    ctxOf({ positions: [{ secid: '1.600519', name: '贵州茅台', qty: 100, price: 1600 }] }),
  )
  assert.equal(empty.decision.orders.length, 1, '没有同键持仓时必须放行')
  const gold = clampDecision(
    decisionOf([{ secid: '1.518880', side: 'buy', price: 6.2, shares: 1000, reason: '补黄金' }]),
    ctxOf({ quotes: { '1.518880': { name: '黄金ETF华安', price: 6.2 } } }),
  )
  assert.equal(gold.decision.orders.length, 1, '黄金 ETF 与长债 ETF 不同键，不得误拦')
})

test('⑤ 同产品闸：已有同键 pending 买单 ⇒ 拒；同键 pending 是同一只 ⇒ 放行（加仓）', () => {
  const dup = clampDecision(
    decisionOf([{ secid: PY.secid, side: 'buy', price: 111.2, shares: 400, reason: '补低波端' }]),
    ctxOf({ positions: [], pendingBuys: [{ secid: BS.secid, name: BS.name }] }),
  )
  assert.equal(dup.decision.orders.length, 0, '同键已有挂单不得再建仓')
  assert.match(dup.rejected[0]?.reason ?? '', /同产品已持有 30年国债ETF博时（1\.511130）/, 'pending 命中的原因同样要写清是哪一只')
  const same = clampDecision(
    decisionOf([{ secid: PY.secid, side: 'buy', price: 111.2, shares: 400, reason: '加仓' }]),
    ctxOf({ positions: [], pendingBuys: [{ secid: PY.secid, name: PY.name }] }),
  )
  assert.equal(same.decision.orders.length, 1, '同一只的加仓挂单不受同产品闸影响')
})

/* ────────────────────────── B. 委托价偏离闸 ────────────────────────── */

test('⑥ 偏离闸：121.8 vs 现价 111.2（+9.5%）⇒ 拒；113 vs 111.2（+1.6%）⇒ 放行', () => {
  const bad = clampDecision(decisionOf([{ secid: BS.secid, side: 'buy', price: 121.8, shares: 200, reason: '补低波端' }]), ctxOf())
  assert.equal(bad.decision.orders.length, 0, '偏离 9.5% 的买单必须被拒（不得按错价成交）')
  assert.equal(bad.rejected[0]?.reason, '委托价偏离现价 9.5%，疑似引用错标的，需按现价重报')

  const ok = clampDecision(decisionOf([{ secid: BS.secid, side: 'buy', price: 113, shares: 200, reason: '补低波端' }]), ctxOf())
  assert.equal(ok.decision.orders.length, 1, '偏离 1.6% 属正常报价，必须放行')
  assert.equal(ok.rejected.length, 0)

  const edge = clampDecision(decisionOf([{ secid: BS.secid, side: 'buy', price: 111.2 * 1.03, shares: 200, reason: '补低波端' }]), ctxOf())
  assert.equal(edge.decision.orders.length, 1, '恰好 3% 是闭区间外沿之外：阈值是 >3%，等于 3% 放行')
})

test('⑦ 偏离闸：无现价 ⇒ 放行 + skipped「缺现价，未做偏离校验」；卖出同口径', () => {
  const noPrice = clampDecision(
    decisionOf([{ secid: PY.secid, side: 'buy', price: 121.8, shares: 400, reason: '建仓' }]),
    ctxOf({ positions: [], quotes: { [PY.secid]: { name: PY.name, price: null } } }),
  )
  assert.equal(noPrice.decision.orders.length, 1, '缺现价不得当 0 用，也不得拦单')
  const skipped = noPrice.skipped.find((s) => s.gate === 'deviation')
  assert.equal(skipped?.reason, '缺现价，未做偏离校验')
  assert.equal(skipped?.secid, PY.secid)

  const sell = clampDecision(
    decisionOf([{ secid: BS.secid, side: 'sell', price: 121.825, shares: 200, reason: '减仓' }]),
    ctxOf(),
  )
  assert.equal(sell.decision.orders.length, 0, '卖出引用错价同样会亏钱，必须同口径拦下')
  assert.match(sell.rejected[0]?.reason ?? '', /^委托价偏离现价 9\.6%，疑似引用错标的/)
})

/* ────────────────────────── C. 上下文合并 ────────────────────────── */

const portDataWith = (): DataStore => ({
  watchData: () => ({ groups: [], items: [] }),
  portData: () => ({
    groups: [{ id: 'g1', name: '默认', order: 0 }],
    items: [
      { id: 'p1', groupId: 'g1', secid: BS.secid, name: BS.name, createdAt: 1 },
      { id: 'p2', groupId: 'g1', secid: PY.secid, name: PY.name, createdAt: 2 },
      { id: 'p3', groupId: 'g1', secid: '1.600519', name: '贵州茅台', createdAt: 3 },
    ],
  }),
  ledgerEntries: () => [
    { id: 'l1', ts: Date.parse('2026-10-20T09:30:00+08:00'), actor: 'web', verb: 'buy', groupId: 'g1', posId: 'p1', secid: BS.secid, name: BS.name, qty: 200, price: 111.48 },
    { id: 'l2', ts: Date.parse('2026-10-21T09:30:00+08:00'), actor: 'web', verb: 'buy', groupId: 'g1', posId: 'p2', secid: PY.secid, name: PY.name, qty: 400, price: 111 },
    { id: 'l3', ts: Date.parse('2026-10-22T09:30:00+08:00'), actor: 'web', verb: 'buy', groupId: 'g1', posId: 'p3', secid: '1.600519', name: '贵州茅台', qty: 100, price: 1600 },
  ],
} as unknown as DataStore)

const quotesOf = async (): Promise<Record<string, { name: string; price: number; prev: number; pct: number }>> => ({
  [BS.secid]: { name: BS.name, price: 111.2, prev: 111.3, pct: -0.09 },
  [PY.secid]: { name: PY.name, price: 111.5, prev: 111.6, pct: -0.09 },
  '1.600519': { name: '贵州茅台', price: 1600, prev: 1600, pct: 0 },
})

const inputsOf = async (quotes = quotesOf): Promise<{ inputs: Awaited<ReturnType<typeof prismInputsOf>>; dir: string }> => {
  const dir = await mkdtemp(join(tmpdir(), 'prism-product-ctx-'))
  const store = new PrismStore(dir)
  const trading = new PrismTradingStore(dir)
  await store.init()
  await trading.init()
  const inputs = await prismInputsOf({ store, trading, data: portDataWith(), get: () => undefined, quotes: quotes as never, now: () => AT })
  return { inputs, dir }
}

test('⑧ 上下文：两只 30 年国债 ETF 合并一行，合计权重/市值按组合总市值算', async () => {
  const { inputs, dir } = await inputsOf()
  try {
    assert.ok(inputs.products?.includes('【ETF 按产品合并】'), '必须有独立段落标题')
    const lines = (inputs.products ?? '').split('\n').filter((l) => l.includes('30年国债ETF'))
    assert.equal(lines.length, 1, '同键两只 ETF 只能出现一行（否则模型看不到这是同一条腿）')
    const line = lines[0] ?? ''
    assert.ok(line.includes(`${BS.name}（${BS.secid}）200 股`), '名称列表必须含博时+股数')
    assert.ok(line.includes(`${PY.name}（${PY.secid}）400 股`), '名称列表必须含鹏扬+股数')
    const legMv = 200 * 111.2 + 400 * 111.5
    const totalMv = legMv + 100 * 1600
    assert.equal(legMv, 66_840)
    assert.ok(line.includes(`合计市值 ${legMv.toFixed(2)} 元`), `合计市值必须是 ${legMv.toFixed(2)} 元：${line}`)
    assert.ok(line.includes(`合计权重 ${((legMv / totalMv) * 100).toFixed(2)}%`), `合计权重必须是分母=可计价总市值：${line}`)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('⑨ 上下文：不同键不合并；单只 ETF 不单列；无同产品 ⇒ 占位说明', async () => {
  const only = etfProductsTextOf(
    [
      { secid: BS.secid, name: BS.name, qty: 200, mv: 22_240 },
      { secid: '1.518880', name: '黄金ETF华安', qty: 1000, mv: 6_200 },
    ],
    28_440,
  )
  assert.ok(only.includes('—（无同产品多标的持仓）'), '不同键/单只都不得凑成一行')
  const mixed = etfProductsTextOf(
    [
      { secid: BS.secid, name: BS.name, qty: 200, mv: 22_240 },
      { secid: PY.secid, name: PY.name, qty: 400, mv: 44_600 },
      { secid: '1.518880', name: '黄金ETF华安', qty: 1000, mv: 6_200 },
    ],
    73_040,
  )
  assert.equal(mixed.split('\n').filter((l) => l.includes('30年国债ETF')).length, 1)
  assert.equal(mixed.split('\n').filter((l) => l.includes('黄金ETF')).length, 0, '单只黄金 ETF 不单列')
})

test('⑩ 上下文：同键 ETF 缺价 ⇒ 合计市值/权重给 — 和原因，不拿 0 冒充', () => {
  const text = etfProductsTextOf(
    [
      { secid: BS.secid, name: BS.name, qty: 200, mv: null },
      { secid: PY.secid, name: PY.name, qty: 400, mv: 44_600 },
    ],
    44_600,
  )
  assert.ok(text.includes('合计市值 —（缺价：30年国债ETF博时）'), `缺价必须写清缺哪只：${text}`)
  assert.ok(text.includes('合计权重 —（合计市值不可算）'), '缺价时权重不得算半个数')
})

/* ────────────────────────── 反例注入 ────────────────────────── */

test('⑪ 反例注入 A：去掉同产品闸 ⇒ 同一标的两条腿进账户（必败）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'prism-product-injectA-'))
  try {
    const store = new PrismTradingStore(dir)
    await store.init()
    await store.saveAccount(accountOf() as never)
    // 对照：ctx 不含持仓信息 = 同产品闸看不见已持有的博时（等价于闸被去掉）
    const blind = clampDecision(
      decisionOf([{ secid: PY.secid, side: 'buy', price: 111.2, shares: 400, reason: '补低波端' }]),
      { cash: 500_000, positions: [], limits: {}, at: AT, quotes: { [PY.secid]: { name: PY.name, price: 111.2 } } },
    )
    assert.equal(blind.decision.orders.length, 1, '对照：没有闸时重复腿会进入 orders')
    await placeDecision(store, blind.decision, AT, quoteLiteOf())
    const tick = await matchTick(store, {
      now: () => AT + 60_000,
      quotes: async () => quoteLiteOf(),
      bars: async () => ({ bars: [{ t: AT, high: 111.5, low: 110.93, volume: 100_000 }], source: '1min', reason: null }),
    })
    assert.equal(tick.filled, 1)
    const keys = store.account().positions.map((p) => productKeyOf(p.name))
    assert.deepEqual(keys, ['30年国债ETF', '30年国债ETF'], '不拦就会真的持有同一条腿的两只')
    assert.throws(() => assert.equal(keys.length, 1, '⚠ 注入：去掉同产品闸 ⇒ 同一标的两条腿'), /注入/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('⑫ 反例注入 B：去掉偏离闸 ⇒ 121.825 按错价成交（必败）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'prism-product-injectB-'))
  try {
    const store = new PrismTradingStore(dir)
    await store.init()
    await store.saveAccount(accountOf() as never)
    // 对照：不给现价 = 偏离闸拿不到价格（等价于闸被去掉）
    const blind = clampDecision(
      decisionOf([{ secid: BS.secid, side: 'buy', price: 121.825, shares: 200, reason: '补低波端' }]),
      { cash: 500_000, positions: [], limits: {}, at: AT, quotes: { [BS.secid]: { name: BS.name, price: null } } },
    )
    assert.equal(blind.decision.orders.length, 1, '对照：没有闸时 121.825 的买单会进入 orders')
    assert.equal(blind.skipped.filter((s) => s.gate === 'deviation').length, 1, '缺现价必须留 skipped')
    await placeDecision(store, blind.decision, AT, quoteLiteOf())
    const tick = await matchTick(store, {
      now: () => AT + 60_000,
      quotes: async () => quoteLiteOf(),
      bars: async () => ({ bars: [{ t: AT, high: 111.5, low: 110.93, volume: 100_000 }], source: '1min', reason: null }),
    })
    assert.equal(tick.filled, 1)
    const fill = store.fills()[0]
    assert.equal(fill?.price, 121.825, '对照：错价会按委托价成交')
    assert.throws(() => assert.ok((fill?.price ?? 0) <= 111.5, '⚠ 注入：去掉偏离闸 ⇒ 121.825 按错价成交'), /注入/)
    // 有现价时同一笔必被拦下（正例对照）
    const guarded = clampDecision(
      decisionOf([{ secid: BS.secid, side: 'buy', price: 121.825, shares: 200, reason: '补低波端' }]),
      ctxOf({ positions: [], quotes: { [BS.secid]: { name: BS.name, price: 111.2 } } }),
    )
    assert.equal(guarded.decision.orders.length, 0)
    assert.equal(guarded.rejected[0]?.reason, '委托价偏离现价 9.6%，疑似引用错标的，需按现价重报')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

/* ────────────────────────── 接线（不是只写在注释里） ────────────────────────── */

test('⑬ 接线：runPrismForSlot 把 quotes/pendingBuys/持仓名称交给 clampDecision；run 落 clampSkipped', () => {
  const src = readFileSync(join(process.cwd(), 'src/host/prismRoutes.ts'), 'utf8')
  assert.match(src, /quotes,\n\s+pendingBuys,/, '两个新数据源必须真的传进 clampDecision')
  assert.match(src, /const pendingBuys = deps\.trading\.orders\(\)/)
  assert.match(src, /name: p\.name/, '持仓名必须传（否则同产品闸在实机上永远看不见已持有的那只）')
  assert.match(src, /【ETF 按产品合并】/)
  const engine = readFileSync(join(process.cwd(), 'src/host/prismAccount.ts'), 'utf8')
  assert.match(engine, /productKeyOf\(targetName\)/, '同产品闸必须真的调用 productKeyOf')
  assert.match(engine, /委托价偏离现价 \$\{deviationPct\.toFixed\(1\)\}%/)
  assert.match(engine, /clampSkipped: skipped/)
})

test('⑭ 提示词：5 个请求体都带【ETF 按产品合并】与合并行（不是只藏在 inputs 字段里）', async () => {
  const { inputs, dir } = await inputsOf()
  const dir2 = await mkdtemp(join(tmpdir(), 'prism-product-prompt-'))
  try {
    const store = new PrismStore(dir2)
    await store.init()
    const seen: string[] = []
    let calls = 0
    const llm = {
      stream: (opts: { messages: Array<{ content: unknown }> }) => {
        calls += 1
        const raw = opts.messages[0]?.content
        seen.push(Array.isArray(raw) ? raw.map((b) => (b as { text?: string }).text ?? '').join('') : String(raw))
        const text = calls <= 4
          ? `分报告${calls}`
          : '汇总\n```json\n{"note":"不买：同产品已持有；不卖：未破止损","limits":{"singlePct":20,"totalPct":50,"note":"按总资产"},"orders":[],"cancel":[]}\n```'
        return (async function* () { yield { type: 'text-delta', text } })()
      },
    }
    const get = (name: string): unknown => name === 'llm'
      ? llm
      : name === 'agentDefaultModel' ? { currentSelection: () => ({ provider: 'p', model: 'm' }) } : undefined
    await runPrismAnalysis(store, '10:15', inputs, { get, now: () => AT })
    assert.equal(seen.length, 5, '4 路分析 + 1 汇总')
    assert.equal(seen.every((t) => t.includes('【ETF 按产品合并】')), true, '5 个请求体都必须带合并段')
    assert.equal(
      seen.every((t) => t.includes('30年国债ETF博时（1.511130）200 股 + 30年国债ETF鹏扬（1.511090）400 股')),
      true,
      '合并行必须真的进提示词（同一行两只是同一条腿）',
    )
  } finally {
    await rm(dir, { recursive: true, force: true })
    await rm(dir2, { recursive: true, force: true })
  }
})
