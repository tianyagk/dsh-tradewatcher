/**
 * 棱镜「重复被拒委托」修复（v0.213.0）：
 *   A. 上下文必须带「今日已被风控拒绝的委托」（近 10 条、倒序、原因不编）；
 *   B. 汇总提示词追加「【强制·不得重复被拒】」，既有规则一条不少；
 *   C. `clampDecision` 去重闸：同标的/同向/股数差 ≤100/价格差 ≤0.5% ⇒ 直接拒，不进撮合。
 *
 * 每条判据都带反例注入：去掉去重闸 / 去掉上下文段落 ⇒ 断言必败。
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DataStore } from './store.ts'
import type { PrismDecision, PrismOrder, PrismRun } from '../shared/prism.ts'
import { PrismTradingStore, clampDecision, isDuplicateRejected } from './prismAccount.ts'
import { PrismStore } from './prismStore.ts'
import { prismInputsOf, rejectedReasonOf, rejectedTodayOf, rejectedTodayTextOf, runPrismForSlot } from './prismRoutes.ts'
import { runPrismAnalysis } from './prismPipeline.ts'

const TODAY = '2026-11-23'
const REASON = 'T+1 不可卖（今日可卖 1700 股）'
const at = (hhmm: string): number => Date.parse(`${TODAY}T${hhmm}:10+08:00`)

let seq = 0
const orderOf = (over: Partial<PrismOrder> = {}): PrismOrder => {
  seq += 1
  return {
    id: `o-test-${seq}`,
    secid: '1.601872',
    name: '招商轮船',
    side: 'sell',
    price: 15.24,
    shares: 3100,
    reason: '减仓',
    decidedAt: at('09:40'),
    day: TODAY,
    status: 'rejected',
    rejectReason: REASON,
    origin: 'auto',
    ...over,
  }
}

const fakeData = (): DataStore => ({
  watchData: () => ({ groups: [], items: [{ id: 'w1', groupId: 'g1', secid: '1.601872', name: '招商轮船', createdAt: 1 }] }),
  portData: () => ({ groups: [], items: [] }),
  ledgerEntries: () => [],
} as unknown as DataStore)

const quotes = async (): Promise<Record<string, { name: string; price: number; prev: number; pct: number }>> =>
  ({ '1.601872': { name: '招商轮船', price: 15.29, prev: 15.45, pct: -1.04 } })

const inputsWithOrders = async (orders: PrismOrder[]): Promise<{ quotes: string; dir: string }> => {
  const dir = await mkdtemp(join(tmpdir(), 'prism-reject-ctx-'))
  const store = new PrismStore(dir)
  const trading = new PrismTradingStore(dir)
  await store.init()
  await trading.init()
  await trading.saveOrders(orders, [])
  const inputs = await prismInputsOf({
    store,
    trading,
    data: fakeData(),
    get: () => undefined,
    quotes: quotes as never,
    now: () => at('10:15'),
  })
  return { quotes: inputs.quotes, dir }
}

const decisionOf = (orders: PrismDecision['orders']): PrismDecision => ({
  limits: { singlePct: null, totalPct: null, note: null },
  note: '不买：无新增资金；不卖：未破止损',
  orders,
  cancel: [],
  rejects: [],
  parseError: null,
})

test('① 上下文：今日 4 条被拒全部出现、按 decidedAt 倒序；昨日被拒与今日挂单不混入', async () => {
  const four = [
    orderOf({ shares: 3100, price: 15.24, decidedAt: at('09:40') }),
    orderOf({ shares: 2900, price: 15.2, decidedAt: at('09:50') }),
    orderOf({ shares: 4000, price: 15.3, decidedAt: at('10:00') }),
    orderOf({ shares: 3500, price: 15.29, decidedAt: at('10:10') }),
  ]
  const yesterday = orderOf({ shares: 9900, price: 99.99, decidedAt: at('14:00'), day: '2026-11-22' })
  const pending = orderOf({ id: 'p-keep', shares: 5000, price: 9.99, status: 'pending', rejectReason: undefined })
  const { quotes: text, dir } = await inputsWithOrders([...four, yesterday, pending])
  try {
    assert.ok(text.includes('【今日已被风控拒绝的委托】'), '必须有独立段落标题')
    assert.ok(text.includes(`09:40 卖出 招商轮船 3,100 股 @15.24 — 原因：${REASON}`), '第一条（09:40/3,100/15.24）必须出现')
    assert.ok(text.includes(`09:50 卖出 招商轮船 2,900 股 @15.2 — 原因：${REASON}`), '第二条必须出现')
    assert.ok(text.includes(`10:00 卖出 招商轮船 4,000 股 @15.3 — 原因：${REASON}`), '第三条必须出现')
    assert.ok(text.includes(`10:10 卖出 招商轮船 3,500 股 @15.29 — 原因：${REASON}`), '第四条必须出现')
    const idx = (s: string): number => text.indexOf(s)
    assert.equal(idx('10:10') < idx('10:00') && idx('10:00') < idx('09:50') && idx('09:50') < idx('09:40'), true, '必须按 decidedAt 倒序（10:10 → 09:40）')
    assert.equal(text.includes('9,900'), false, '前一日（11-22）被拒不得进入今日段落')
    assert.equal(text.includes('5,000 股 @9.99'), false, '今日 pending 单不得混入被拒段落')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('② 上下文：无被拒 ⇒ —（今日无被拒委托）；最多 10 条，取最近十条', async () => {
  const empty = await inputsWithOrders([])
  try {
    assert.ok(empty.quotes.includes('【今日已被风控拒绝的委托】\n—（今日无被拒委托）'), '无被拒必须写占位符，不能空着')
    assert.equal(empty.quotes.includes('—（今日无被拒委托）'), true)
  } finally {
    await rm(empty.dir, { recursive: true, force: true })
  }
  const many = Array.from({ length: 12 }, (_, i) => orderOf({
    shares: (i + 1) * 100,
    price: 10 + i * 0.01,
    decidedAt: at(`09:${String(i).padStart(2, '0')}`),
  }))
  const twelve = await inputsWithOrders(many)
  try {
    const lines = rejectedTodayTextOf(rejectedTodayOf(many, TODAY)).split('\n')
    assert.equal(lines.length, 10, '最多 10 条（12 条输入 ⇒ 截 10 条）')
    assert.equal(lines[0]?.startsWith('09:11'), true, '第一条必须是最新 09:11')
    assert.equal(lines[9]?.startsWith('09:02'), true, '第 10 条必须是 09:02（最近十条）')
    assert.equal(twelve.quotes.includes('09:01 卖出'), false, '最旧两条不得出现在上下文')
  } finally {
    await rm(twelve.dir, { recursive: true, force: true })
  }
})

test('③ 原因取值：skipReason → rejectReason → 当日 rejects 对应条目 → —', () => {
  assert.equal(rejectedReasonOf(orderOf({ skipReason: '本轮不成交：量缺失', rejectReason: REASON })), '本轮不成交：量缺失', 'skipReason 优先')
  assert.equal(rejectedReasonOf(orderOf({ rejectReason: REASON })), REASON, '缺 skipReason 用 rejectReason')
  const run = {
    day: TODAY,
    decision: { rejects: [{ secid: '1.601872', side: 'sell', price: 15.24, shares: 3100, reason: '模型侧拒绝原因' }] },
  } as unknown as PrismRun
  assert.equal(rejectedReasonOf(orderOf({ rejectReason: undefined }), [run]), '模型侧拒绝原因', '再缺则取当日 rejects 对应条目')
  assert.equal(rejectedReasonOf(orderOf({ rejectReason: undefined })), '—', '全缺必须写 —，不得编原因')
})

test('④ 提示词：新增「不得重复被拒」，既有强制规则一条不少', async () => {
  const src = readFileSync(join(process.cwd(), 'src/host/prismPipeline.ts'), 'utf8')
  const rules = src.match(/【强制·[^】]+】/g) ?? []
  assert.equal(rules.length, 5, '强制规则 = 风险暴露/双侧/空单说明/不得重复被拒/只认棱镜账户')
  for (const key of ['风险暴露', '双侧', '空单说明', '不得重复被拒', '只认棱镜账户']) assert.ok(rules.some((r) => r.includes(key)), `缺规则：${key}`)
  const rule = '今日已因同一原因被拒的委托，不得原样重发；若仍要交易，必须先核对可用数量/可用资金，并说明与上次不同的依据。'
  assert.equal(src.includes(rule), true, '新规则文案必须逐字存在')
  const injected = src.replace('【强制·不得重复被拒】', '')
  assert.equal(injected.includes('【强制·不得重复被拒】'), false)
  assert.throws(() => assert.match(injected, /【强制·不得重复被拒】/, '⚠ 注入：提示词缺新规则'), /注入/)

  // 运行时证据：汇总请求体真的带上 5 条强制规则（不是只写在源码注释里）
  const dir = await mkdtemp(join(tmpdir(), 'prism-reject-prompt-'))
  try {
    const store = new PrismStore(dir)
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
          : '汇总\n```json\n{"note":"不买：无资金；不卖：未破止损","limits":{"singlePct":20,"totalPct":50,"note":"按总资产"},"orders":[],"cancel":[]}\n```'
        return (async function* () { yield { type: 'text-delta', text } })()
      },
    }
    const get = (name: string): unknown => name === 'llm'
      ? llm
      : name === 'agentDefaultModel' ? { currentSelection: () => ({ provider: 'p', model: 'm' }) } : undefined
    await runPrismAnalysis(store, '10:15', { positions: '—', quotes: '—', account: '—', news: [], skeleton: '骨架' }, { get, now: () => at('10:15') })
    assert.equal(seen.length, 5)
    const summary = seen[4] ?? ''
    assert.ok(summary.includes('【强制·不得重复被拒】'), '汇总请求体必须带新规则')
    assert.equal((summary.match(/【强制·/g) ?? []).length, 5, '汇总请求体必须带满 5 条强制规则')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('⑤ isDuplicateRejected 边界：≤100 股/≤0.5% 判重；200 股/1%/反向/异标的放行', () => {
  const prior = { secid: '1.601872', side: 'sell' as const, price: 15.24, shares: 3100, reason: REASON }
  assert.notEqual(isDuplicateRejected({ secid: '1.601872', side: 'sell', price: 15.24, shares: 3200 }, [prior]), null, '差 100 股（≤100）必须判重')
  assert.equal(isDuplicateRejected({ secid: '1.601872', side: 'sell', price: 15.24, shares: 3300 }, [prior]), null, '差 200 股必须放行')
  assert.notEqual(isDuplicateRejected({ secid: '1.601872', side: 'sell', price: 15.3162, shares: 3100 }, [prior]), null, '价格差恰好 0.5% 必须判重')
  assert.equal(isDuplicateRejected({ secid: '1.601872', side: 'sell', price: 15.3924, shares: 3100 }, [prior]), null, '价格差 1% 必须放行')
  assert.equal(isDuplicateRejected({ secid: '1.601872', side: 'buy', price: 15.24, shares: 3100 }, [prior]), null, '不同 direction 必须放行')
  assert.equal(isDuplicateRejected({ secid: '1.600519', side: 'sell', price: 15.24, shares: 3100 }, [prior]), null, '不同标的必须放行')
})

test('⑥ 去重闸：命中直接进 rejects、不进 orders/events；同轮多个重复只记一条', () => {
  const prior = { secid: '1.601872', side: 'sell' as const, price: 15.24, shares: 3100, reason: REASON }
  const ctx = { cash: 1_000_000, positions: [], limits: {}, at: 1, rejectedToday: [prior] }
  const dup = clampDecision(decisionOf([{ secid: '1.601872', side: 'sell', price: 15.3, shares: 3200, reason: '减仓' }]), ctx)
  assert.equal(dup.decision.orders.length, 0, '重复单不得进入 orders（不撮合/不写 pending）')
  assert.equal(dup.rejected.length, 1, '必须留一条 reject')
  assert.equal(dup.rejected[0]?.reason, `重复委托（前次拒绝：${REASON}）`, '原因文案必须带前次原因')
  assert.equal(dup.events.length, 0, '去重不是裁剪，不得产生 clampEvents')

  const two = clampDecision(decisionOf([
    { secid: '1.601872', side: 'sell', price: 15.3, shares: 3200, reason: '减仓' },
    { secid: '1.601872', side: 'sell', price: 15.29, shares: 3150, reason: '减仓' },
  ]), ctx)
  assert.equal(two.decision.orders.length, 0)
  assert.equal(two.rejected.length, 1, '同一轮多个重复只记一条 reject（避免刷屏）')

  const pass = clampDecision(decisionOf([{ secid: '1.601872', side: 'sell', price: 15.24, shares: 3300, reason: '减仓' }]), ctx)
  assert.equal(pass.decision.orders.length, 1, '股数差 200 ⇒ 放行到下单')
  assert.equal(pass.rejected.length, 0)

  const buy = clampDecision(decisionOf([{ secid: '1.601872', side: 'buy', price: 15.24, shares: 3100, reason: '加仓' }]), ctx)
  assert.equal(buy.decision.orders.length, 1, '不同 direction ⇒ 放行')
})

test('⑦ 前一日被拒不影响今日：rejectedTodayOf 按 day 过滤，同委托今日可下单', () => {
  const yesterday = orderOf({ day: '2026-11-22', decidedAt: Date.parse('2026-11-22T14:00:00+08:00') })
  assert.equal(rejectedTodayOf([yesterday], TODAY).length, 0, '昨日拒绝不得进入今日列表')
  assert.equal(rejectedTodayOf([yesterday], '2026-11-22').length, 1, '昨日自己的列表仍应保留（不是丢数据）')
  const r = clampDecision(
    decisionOf([{ secid: '1.601872', side: 'sell', price: 15.24, shares: 3100, reason: '减仓' }]),
    { cash: 1_000_000, positions: [], limits: {}, at: 1, rejectedToday: rejectedTodayOf([yesterday], TODAY) },
  )
  assert.equal(r.decision.orders.length, 1, '今天第一次提交同参数卖单必须放行')
  assert.equal(r.rejected.length, 0)
})

test('⑧ 反例注入：去掉去重闸 ⇒ 重复单进入下单，判据必败', () => {
  const withoutGate = clampDecision(
    decisionOf([{ secid: '1.601872', side: 'sell', price: 15.3, shares: 3200, reason: '减仓' }]),
    { cash: 1_000_000, positions: [], limits: {}, at: 1 },
  )
  assert.equal(withoutGate.decision.orders.length, 1, '对照：无去重闸时重复单会进入 orders')
  assert.throws(() => assert.equal(withoutGate.decision.orders.length, 0, '⚠ 注入：去掉去重闸 ⇒ 重复单未被拦'), /注入/)
  const src = readFileSync(join(process.cwd(), 'src/host/prismAccount.ts'), 'utf8')
  assert.match(src, /isDuplicateRejected\(order, ctx\.rejectedToday \?\? \[\]\)/)
  const injected = src.replace('isDuplicateRejected(order, ctx.rejectedToday ?? [])', 'null')
  assert.notEqual(injected, src)
  assert.throws(() => assert.match(injected, /isDuplicateRejected\(order, ctx\.rejectedToday \?\? \[\]\)/, '⚠ 注入：去掉去重调用'), /注入/)
})

test('⑨ 反例注入：上下文不含被拒段 ⇒ 判据必败', async () => {
  const { quotes: text, dir } = await inputsWithOrders([orderOf()])
  try {
    const withoutSection = text.replace(/\n【今日已被风控拒绝的委托】[\s\S]*$/, '')
    assert.equal(withoutSection.includes('【今日已被风控拒绝的委托】'), false)
    assert.throws(() => assert.ok(withoutSection.includes('09:40 卖出 招商轮船'), '⚠ 注入：上下文不含被拒段'), /注入/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
  const src = readFileSync(join(process.cwd(), 'src/host/prismRoutes.ts'), 'utf8')
  assert.match(src, /【今日已被风控拒绝的委托】/)
  assert.match(src, /rejectedTodayTextOf\(rejectedTodayOf\(allOrders, dayOf\(\(deps\.now \?\? Date\.now\)\(\)\), deps\.store\.runs\(\)\)\)/)
})

test('⑩ 端到端：上一轮被拒进上下文；本轮同参数卖单被去重闸拦下并落盘留痕，不新增委托', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'prism-reject-e2e-'))
  try {
    const store = new PrismStore(dir)
    const trading = new PrismTradingStore(dir)
    await store.init()
    await trading.init()
    const prior = orderOf({ shares: 3100, price: 15.24, decidedAt: at('09:40') })
    await trading.saveOrders([prior], [])
    const seen: string[] = []
    let calls = 0
    const llm = {
      stream: (opts: { messages: Array<{ content: unknown }> }) => {
        calls += 1
        const raw = opts.messages[0]?.content
        seen.push(Array.isArray(raw) ? raw.map((b) => (b as { text?: string }).text ?? '').join('') : String(raw))
        const text = calls <= 4
          ? `分报告${calls}`
          : '汇总\n```json\n{"note":"不买：无新增资金；不卖：T+1 可卖不足","limits":{"singlePct":20,"totalPct":50,"note":"按总资产"},"orders":[{"secid":"1.601872","side":"sell","price":15.3,"shares":3150,"reason":"减仓"}],"cancel":[]}\n```'
        return (async function* () { yield { type: 'text-delta', text } })()
      },
    }
    const get = (name: string): unknown => name === 'llm'
      ? llm
      : name === 'agentDefaultModel' ? { currentSelection: () => ({ provider: 'p', model: 'm' }) } : undefined
    const run = await runPrismForSlot(
      { store, trading, data: fakeData(), get, quotes: quotes as never, now: () => at('09:50') },
      '09:50',
    )
    assert.equal(seen.length, 5)
    assert.equal(seen.every((t) => t.includes(`09:40 卖出 招商轮船 3,100 股 @15.24 — 原因：${REASON}`)), true, '5 个请求体都必须带上一轮被拒记录')
    assert.equal(run.decision?.orders.length, 0, '重复单不得进入本轮 orders')
    assert.equal(run.decision?.rejects.some((r) => r.reason === `重复委托（前次拒绝：${REASON}）`), true, '本轮 rejects 必须有去重留痕')
    assert.equal(trading.orders().length, 1, '不得新增 pending/rejected 委托（只有上一轮那条）')
    assert.equal(trading.orders()[0]?.id, prior.id)
    assert.equal(store.runs().at(-1)?.decision?.rejects.some((r) => r.reason.includes('重复委托（前次拒绝：')), true, '落盘 run 必须保留去重留痕（不被 placeDecision 覆盖）')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
