/**
 * 棱镜「引擎正确性」P0 修复（v0.259.4）：
 *   P0-1 总仓上限引擎化：clamp 不再用模型 limits.totalPct 兜底；settings 注入权威值，模型值只回显
 *   P0-3 可买额度：引擎算 buyBudget（现金 − 最低现金留存 − 费用预留，按整手向下取整）并注入快照
 *   P0-5 做T上下文：factorMetricsOf + 只用已完成 bar（date < 今日），门槛数字取自 AUTO_T_RULES
 *   P0-7 零股卖出：一次性清仓（shares === 当前持仓）允许含零股；其余仍要求整手
 *   P0-8 解析失败：parseError / 丢弃项必须让 run.error 非空（不得静默 0 笔）
 *   P0-10 候选池白名单：orders.secid 必须属于「持仓 + 可交易自选」，池外拒单并写原因
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DayBar } from '../shared/model.ts'
import type { PrismAccount, PrismDecision } from '../shared/prism.ts'
import { PrismTradingStore, clampDecision, limitsOf, parseDecisionDetailed, placeDecision, rejectReasonOf } from './prismAccount.ts'
import {
  accountSnapshotOf,
  applyCandidatePoolGate,
  autoTContextOf,
  buyBudgetOf,
  candidatePoolOf,
  limitsTextOf,
  runPrismForSlot,
} from './prismRoutes.ts'
import { PrismStore } from './prismStore.ts'
import { runPrismAnalysis } from './prismPipeline.ts'
import { AUTO_T_RULES } from './prismGates.ts'
import { factorMetricsOf } from './prismFactors.ts'

const DAY = '2026-11-27'
const at = (hhmm = '10:00'): number => Date.parse(`${DAY}T${hhmm}:09+08:00`)

const decisionOf = (orders: PrismDecision['orders'], limits: PrismDecision['limits'] = { singlePct: null, totalPct: null, note: null }): PrismDecision => ({
  limits,
  note: '不买：无新增资金；不卖：未破止损',
  orders,
  cancel: [],
  rejects: [],
  parseError: null,
})

const accountOf = (over: Partial<PrismAccount> = {}): PrismAccount => ({
  day: DAY,
  capital: 1_000_000,
  capitalLimit: 1_000_000,
  cash: 100_000,
  realized: 0,
  dayStartEquity: null,
  positions: [],
  copiedAt: null,
  copyLogs: [],
  ...over,
} as PrismAccount)

/* ────────────────────────── P0-1 总仓上限引擎化 ────────────────────────── */

test('P0-1 ① 未配置 maxPosPct：模型自报 totalPct=100 不参与裁剪（引擎用安全默认 95%）', () => {
  const small = decisionOf([
    { secid: '1.600519', side: 'buy', price: 10, shares: 9000, reason: '加仓' },
  ], { singlePct: 100, totalPct: 100, note: null })
  const a = clampDecision(small, { cash: 100_000, positions: [], limits: small.limits, industries: {}, at: 1 })
  assert.equal(a.decision.orders[0]?.shares, 9000, '90% < 95% 默认上限 ⇒ 不裁')
  // 买 99%（990 000）⇒ 若听信模型 totalPct=100 会放行；必须被引擎默认 95% 裁到 95 000 股
  const big = decisionOf([
    { secid: '1.600519', side: 'buy', price: 10, shares: 99_000, reason: '加仓' },
  ], { singlePct: 100, totalPct: 100, note: null })
  const b = clampDecision(big, { cash: 1_000_000, positions: [], limits: big.limits, industries: {}, at: 1, constraints: {} })
  const ev = b.events.find((e) => e.dimension === 'total')
  assert.ok(ev, '模型写 100 不得取消总仓上限（引擎默认 95% 必须裁）')
  assert.match(String(ev?.basis), /（默认值）/)
  assert.equal(b.decision.orders[0]?.shares, 95_000)
})

test('P0-1 ② 配置 maxPosPct=1 ⇒ 总仓维度生效，basis 写「用户配置」；模型 totalPct=100 无视', () => {
  const d = decisionOf([
    { secid: '1.600519', side: 'buy', price: 10, shares: 9000, reason: '加仓' },
  ], { singlePct: 100, totalPct: 100, note: null })
  const r = clampDecision(d, { cash: 100_000, positions: [], limits: d.limits, industries: {}, at: 1, constraints: { maxPosPct: 1 } })
  const ev = r.events.find((e) => e.dimension === 'total')
  assert.ok(ev, '配置 1% ⇒ 必须裁总仓')
  assert.match(String(ev?.basis), /（用户配置）/)
  assert.equal(r.decision.orders[0]?.shares, 100, '总资产 100 000×1%=1 000 ⇒ 100 股')
})

test('P0-1 ③ 约束段：未配置 maxPosPct 写 95%（默认值；maxPosPct 未设置）', () => {
  const text = limitsTextOf({ perStockPct: 30, maxPosPct: null, minCashPct: 10 })
  assert.ok(text.includes('最大总仓位：95%（默认值；maxPosPct 未设置）（limits.totalPct 回显该值；引擎按此裁剪）'))
  assert.equal(text.includes('最大总仓位：100%'), false, '不得默认 100')
  assert.equal(text.includes('maxPosPct 未设置'), true, '未配置必须写清「未设置」，不能静默成 100')
})

/* ────────────────────────── P0-2 账户快照缺价 ────────────────────────── */

test('P0-2 缺价：市值/总资产/权重写 — + 原因，不再拿成本冒充', () => {
  const account = accountOf({ cash: 100_000, positions: [{ secid: '1.600519', name: '贵州茅台', qty: 100, available: 100, cost: 50 }] })
  const text = accountSnapshotOf(account, {}, [], 0, at())
  assert.match(text, /总资产：—（1 只持仓缺现价：贵州茅台；不拿成本冒充市值）/)
  assert.match(text, /持仓市值：—（缺现价未计入：贵州茅台）/)
  assert.match(text, /当前仓位占比：—（同上，缺现价）/)
  assert.match(text, /市值 —（缺现价，不用成本冒充）/)
  assert.equal(text.includes('150000.00'), false, '成本 50×100=5000 不得被当成市值（总资产 105000 也不得出）')
  assert.equal(text.includes('5000.00'), false, '成本市值不得出现')
})

/* ────────────────────────── P0-3 可买额度 ────────────────────────── */

test('P0-3 ① buyBudget：扣最低现金留存 + 费用预留，按整手向下取整', () => {
  const b = buyBudgetOf({ cash: 200_000, totalAssets: 1_000_000, marketValue: 800_000, minCashPct: 10, refPrice: 10 })
  assert.equal(b.minCashReserve, 100_000, '最低现金留存 = 1 000 000×10%')
  assert.equal(b.feeReserve, 31, '费用预留 = 100 000×(0.0003+0.00001)，上限 5')
  assert.equal(b.cashBudget, 99_969)
  assert.equal(b.totalRoom, null, '未配置 maxPosPct ⇒ 不按总仓限制')
  assert.equal(b.shares, 9_900, '99 969 / (10×100) ⇒ 99 手')
  assert.equal(b.yuan, 99_000)
  assert.equal(b.limitedBy, 'cash')
})

test('P0-3 ② buyBudget：配置 maxPosPct 时取「总仓剩余」更小者', () => {
  const b = buyBudgetOf({ cash: 200_000, totalAssets: 1_000_000, marketValue: 550_000, minCashPct: 10, maxPosPct: 60, refPrice: 10 })
  assert.equal(b.totalRoom, 50_000, '总仓 60%=600 000 − 市值 550 000')
  assert.equal(b.yuan, 50_000)
  assert.equal(b.shares, 5_000)
  assert.equal(b.limitedBy, 'total')
})

test('P0-3 ③ 快照注入：可买额度不再是现金，列出扣项；无参考价时如实写「未按整手折算」', () => {
  const account = accountOf({ cash: 200_000, positions: [{ secid: '1.600519', name: '贵州茅台', qty: 100, available: 100, cost: 2000 }] })
  const text = accountSnapshotOf(account, { '1.600519': 2000 }, [], 0, at(), { minCashPct: 10 })
  // 总资产 400 000，现金 200 000，最低现金留存 40 000，费用预留 49.60（=160 000×0.00031 向上取整）
  assert.match(text, /可买额度：159950\.40 元（现金 200000\.00 − 最低现金留存 40000\.00 − 费用预留 49\.60/)
  assert.match(text, /未取到参考价，未按整手折算/)
  assert.equal(text.includes('可买额度：200000.00 元'), false, '可买额度不得等于现金')
})

test('P0-3 ④ 有参考价：额度按 100 股整手向下取整为元，且不把某一标的的股数写进快照', () => {
  const account = accountOf({ cash: 200_000, positions: [{ secid: '1.600519', name: '贵州茅台', qty: 100, available: 100, cost: 2000 }] })
  const text = accountSnapshotOf(account, { '1.600519': 2000 }, [], 0, at(), { minCashPct: 10, refPrice: 10 })
  assert.match(text, /可买额度：159000\.00 元/)
  assert.match(text, /按 100 股整手向下取整（股数按目标标的现价算）/)
  assert.equal(text.includes('⇒ 15900 股'), false, '不得把参考价折算的股数写进提示词（会被套到别的标的上）')
})

/* ────────────────────────── P0-5 做T上下文 ────────────────────────── */

const barsOf = (withToday: boolean): DayBar[] => {
  const out: DayBar[] = []
  for (let i = 0; i < 40; i += 1) {
    const date = i < 31
      ? `2026-08-${String(i + 1).padStart(2, '0')}`
      : `2026-09-${String(i - 30).padStart(2, '0')}`
    out.push({ date, open: 10 + (i % 3) * 0.1, close: 10 + (i % 5) * 0.05, high: 10.3, low: 9.7, vol: 1_000 })
  }
  if (withToday) out.push({ date: DAY, open: 10, close: 10, high: 20, low: 1, vol: 1_000 })
  return out
}

const autoTDeps = async (dir: string, withToday: boolean): Promise<Parameters<typeof autoTContextOf>[0]> => {
  const store = new PrismStore(dir)
  await store.init()
  await store.patchSettings({ autoT: { enabled: true, positions: { '1.601872': { enabled: true } } } })
  const deps = {
    store,
    kline: async () => ({ days: barsOf(withToday) }),
    now: () => at(),
  }
  return deps as unknown as Parameters<typeof autoTContextOf>[0]
}

test('P0-5 ① autoT 上下文与因子表同口径（factorMetricsOf），当日未完成 bar 被剔除', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'prism-autot-p0-'))
  try {
    const account = accountOf({ positions: [{ secid: '1.601872', name: '招商轮船', qty: 1_000, available: 1_000, cost: 15 }] })
    const clean = await autoTContextOf(await autoTDeps(dir, false), account)
    const dirty = await autoTContextOf(await autoTDeps(dir, true), account)
    assert.equal(dirty, clean, '加一根「今日」未完成 bar 不得改变任何数字（date < 今日 才用）')
    const m = factorMetricsOf(barsOf(false), 'stock')
    assert.ok(m !== null && m.atrPct !== null && m.amp20Pct !== null)
    assert.ok(clean.includes(`ATR14 ${m!.atrPct!.toFixed(2)}%`), `ATR14 必须与 factorMetricsOf 同值：${clean}`)
    assert.ok(clean.includes(`日均振幅 ${m!.amp20Pct!.toFixed(2)}%`), '日均振幅必须是 amp20Pct（不是 30 根 K 线的区间振幅）')
    assert.ok(clean.includes('ATR分位'), '必须给出 ATR 分位（引擎门槛之一）')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('P0-5 ② 门槛数字从 AUTO_T_RULES 派生；提示词里不再硬编码 1.5%/3%', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'prism-autot-p0b-'))
  try {
    const account = accountOf({ positions: [{ secid: '1.601872', name: '招商轮船', qty: 1_000, available: 1_000, cost: 15 }] })
    const text = await autoTContextOf(await autoTDeps(dir, false), account)
    assert.ok(text.includes(`ATR14 ≥${AUTO_T_RULES.minAtrPct}%`), text)
    assert.ok(text.includes(`ATR 分位 ≥${AUTO_T_RULES.minAtrRank}`), text)
    assert.ok(text.includes(`日均振幅 ≥${AUTO_T_RULES.minAmpPct}%`), text)
    assert.ok(text.includes(`价差 ≥${AUTO_T_RULES.minSpreadPct}%`), text)
    const pipe = readFileSync(new URL('./prismPipeline.ts', import.meta.url), 'utf8')
    assert.equal(pipe.includes('ATR14/现价 ≥1.5%'), false, '提示词不得再写死 1.5%')
    assert.equal(pipe.includes('20 日振幅 ≥3%'), false, '提示词不得再写死 3%')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

/* ────────────────────────── P0-7 零股卖出 ────────────────────────── */

test('P0-7 ① rejectReasonOf：120 股持仓卖 120（一次性清仓）放行；卖 100 放行；卖 150 仍拒', () => {
  const limits = limitsOf('1.601872', '招商轮船', 15)
  const base = { limits, suspended: false, positionQty: 120, availableQty: 120 }
  const sell = (shares: number): PrismDecision['orders'][number] => ({ secid: '1.601872', side: 'sell', price: 15, shares, reason: '清仓' })
  assert.equal(rejectReasonOf(sell(120) as never, base), null, '120 股全卖必须通过')
  assert.equal(rejectReasonOf(sell(100) as never, base), null, '整手减仓仍通过')
  assert.match(String(rejectReasonOf(sell(150) as never, base)), /整手/)
  assert.match(String(rejectReasonOf({ ...sell(120), side: 'buy' } as never, base)), /整手/, '买单仍要求整手')
})

test('P0-7 ② clamp：120 → 全卖保持 120（不被向下取整成 100）；120 → 卖 100 保持 100', () => {
  const positions = [{ secid: '1.601872', qty: 120, available: 120, price: 15, name: '招商轮船' }]
  const full = clampDecision(decisionOf([{ secid: '1.601872', side: 'sell', price: 15, shares: 120, reason: '清仓' }]), { cash: 1_000, positions, limits: {}, at: 1 })
  assert.equal(full.decision.orders[0]?.shares, 120)
  assert.equal(full.events.some((e) => e.dimension === 'available'), false, '清仓不是裁剪')
  const part = clampDecision(decisionOf([{ secid: '1.601872', side: 'sell', price: 15, shares: 100, reason: '减仓' }]), { cash: 1_000, positions, limits: {}, at: 1 })
  assert.equal(part.decision.orders[0]?.shares, 100)
})

test('P0-7 ③ placeDecision：120 股全卖落 pending（含零股）；150 股被拒并写原因', async () => {
  const place = async (shares: number): Promise<{ status: string | undefined; shares: number | undefined; reason: string | undefined }> => {
    const dir = await mkdtemp(join(tmpdir(), 'prism-odd-lot-'))
    try {
      const store = new PrismTradingStore(dir)
      await store.init()
      await store.saveAccount(accountOf({ positions: [{ secid: '1.601872', name: '招商轮船', qty: 120, available: 120, cost: 15 }] }))
      const now = at()
      const r = await placeDecision(store, decisionOf([{ secid: '1.601872', side: 'sell', price: 15, shares, reason: '清仓' }]), now, {
        '1.601872': { name: '招商轮船', price: 15, prev: 15 },
      })
      const o = r.orders[0]
      return { status: o?.status, shares: o?.shares, reason: o?.rejectReason }
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }
  const full = await place(120)
  assert.equal(full.status, 'pending', `120 股全卖必须能挂：${full.reason ?? ''}`)
  assert.equal(full.shares, 120)
  const bad = await place(150)
  assert.equal(bad.status, 'rejected')
  assert.match(String(bad.reason), /整手/)
})

/* ────────────────────────── P0-8 解析失败不静默 ────────────────────────── */

test('P0-8 ① parseDecisionDetailed：orders 不是数组 ⇒ parseError 非空（不再静默成 []）', () => {
  const r = parseDecisionDetailed('```json\n{"note":"不买：x；不卖：y","limits":{},"orders":{"a":1},"cancel":[]}\n```')
  assert.equal(r.decision?.orders.length, 0)
  assert.match(String(r.parseError), /orders 不是数组/)
  assert.equal(r.parseError, r.decision?.parseError, '返回值与 decision.parseError 必须一致')
})

test('P0-8 ② 丢弃项 ⇒ run.error 非空（不再把 0 笔当「模型没动作」）', async () => {
  const runWith = async (summary: string): Promise<{ error: string | null }> => {
    const dir = await mkdtemp(join(tmpdir(), 'prism-parse-p0-'))
    try {
      const store = new PrismStore(dir)
      await store.init()
      let n = 0
      const llm = {
        stream: () => {
          n += 1
          const text = n <= 4 ? `分报告${n}` : summary
          return (async function* () { yield { type: 'text-delta', text } })()
        },
      }
      const get = (name: string): unknown => name === 'llm' ? llm : name === 'agentDefaultModel' ? { currentSelection: () => ({ provider: 'p', model: 'm' }) } : undefined
      const run = await runPrismAnalysis(store, '10:00', { positions: '—', quotes: '—', account: '—', news: [], skeleton: '骨架' }, { get, now: () => at() })
      return run
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }
  const dropped = await runWith('汇总\n```json\n{"note":"不买：x；不卖：y","limits":{},"orders":[{"secid":"1.600519","price":10,"shares":100}],"cancel":[]}\n```')
  assert.match(String(dropped.error), /决策解析失败/)
  const nonArray = await runWith('汇总\n```json\n{"note":"不买：x；不卖：y","limits":{},"orders":{},"cancel":[]}\n```')
  assert.match(String(nonArray.error), /决策解析失败/)
})

/* ────────────────────────── P0-10 候选池白名单 ────────────────────────── */

const fakeData = (items: Array<{ secid: string; name: string }>) => ({
  watchData: () => ({ groups: [], items: items.map((x, i) => ({ id: `w${i}`, groupId: 'g1', createdAt: 1, ...x })) }),
  portData: () => ({ groups: [], items: [] }),
  ledgerEntries: () => [],
}) as never

test('P0-10 ① 池 = 持仓 + 可交易自选；池外委托进 rejects、不进 orders', () => {
  const pool = candidatePoolOf([{ secid: '1.600519' }], [{ secid: '1.601872' }, { secid: '116.00700' }])
  assert.equal(pool.has('1.600519'), true, '持仓永远在池内')
  assert.equal(pool.has('1.601872'), true, '可交易自选在池内')
  assert.equal(pool.has('116.00700'), false, '港股/非沪深标的不在池内')
  const dec = decisionOf([
    { secid: '1.601872', side: 'buy', price: 10, shares: 100, reason: '池内' },
    { secid: '116.00700', side: 'buy', price: 10, shares: 100, reason: '池外' },
  ])
  const r = applyCandidatePoolGate(dec, pool)
  assert.deepEqual(r.orders.map((o) => o.secid), ['1.601872'])
  assert.equal(r.rejects.length, 1)
  assert.match(r.rejects[0]?.reason ?? '', /候选池外标的/)
})

test('P0-10 ② 端到端：池外买单被拒并写原因，不落单；limits 回显 settings（未配置 totalPct=95）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'prism-pool-e2e-'))
  try {
    const store = new PrismStore(dir)
    const trading = new PrismTradingStore(dir)
    await store.init(); await trading.init()
    await store.saveConstraints({ perStockPct: 30, maxPosPct: null })
    await trading.saveAccount(accountOf({ cash: 200_000 }))
    let n = 0
    const llm = {
      stream: () => {
        n += 1
        const text = n <= 4
          ? `分报告${n}`
          : '汇总\n```json\n{"note":"不买：无机会；不卖：无持仓","limits":{"singlePct":20,"totalPct":50,"note":"x"},"orders":[{"secid":"1.600519","side":"buy","price":10,"shares":100,"reason":"池外"}],"cancel":[]}\n```'
        return (async function* () { yield { type: 'text-delta', text } })()
      },
    }
    const get = (name: string): unknown => name === 'llm' ? llm : name === 'agentDefaultModel' ? { currentSelection: () => ({ provider: 'p', model: 'm' }) } : undefined
    const run = await runPrismForSlot({
      store,
      trading,
      data: fakeData([{ secid: '1.601872', name: '招商轮船' }]),
      get,
      quotes: (async () => ({ '1.601872': { name: '招商轮船', price: 15, prev: 15, pct: 0 } })) as never,
      now: () => at(),
      industry: async () => ({}),
    }, '10:00')
    assert.equal(run.decision?.orders.length, 0, '池外委托不得进入 orders')
    assert.equal(run.decision?.rejects.some((r) => /候选池外标的/.test(r.reason)), true, '必须留拒单原因')
    assert.equal(trading.orders().length, 0, '不得新增委托')
    assert.equal(run.decision?.limits.singlePct, 30, '单票上限回显 settings')
    assert.equal(run.decision?.limits.totalPct, 95, '未配置 maxPosPct ⇒ totalPct 回显安全默认 95（不是 100）')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('P1-12 动作预算：每轮最多 4 笔新买入 / 2 条 T 计划，卖出不占额度', async () => {
  const { applyRoundBudget } = await import('./prismRoutes.ts')
  const orders: Array<{ secid: string; side: 'buy' | 'sell'; price: number; shares: number; reason: string }> = Array.from({ length: 6 }, (_, i) => ({ secid: `1.60000${i}`, side: 'buy', price: 10, shares: 100, reason: 'x' }))
  orders.push({ secid: '1.600009', side: 'sell', price: 10, shares: 100, reason: '卖' })
  const tPlans = Array.from({ length: 3 }, (_, i) => ({ secid: `1.60001${i}`, direction: 'buy-first' as const, buyPrice: 10, sellPrice: 11, shares: 100 }))
  const d = { limits: { singlePct: null, totalPct: null, note: null }, orders, cancel: [], rejects: [], parseError: null, tPlans }
  const out = applyRoundBudget(d as never)
  assert.equal(out.orders.filter((o) => o.side === 'buy').length, 4)
  assert.equal(out.orders.some((o) => o.side === 'sell'), true)
  assert.equal(out.tPlans?.length, 2)
  assert.equal(out.rejects.length, 2)
})

test('P1-4 PlanState 持久化：保存后新实例可读回', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'prism-plan-'))
  try {
    const a = new PrismStore(dir); await a.init()
    await a.savePlanState({ day: '2026-11-27', updatedAt: 1, roundType: '常规执行', note: 'n', mainOrderIds: ['o1'], tPlanPairIds: ['p1'] })
    const b = new PrismStore(dir); await b.init()
    assert.deepEqual(b.planState(), { day: '2026-11-27', updatedAt: 1, roundType: '常规执行', note: 'n', mainOrderIds: ['o1'], tPlanPairIds: ['p1'] })
  } finally { await rm(dir, { recursive: true, force: true }) }
})
