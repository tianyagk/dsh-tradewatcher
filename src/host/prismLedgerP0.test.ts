/**
 * P0-1 / P0-2 回归（AUDIT-HOST-PERF §三）：
 *   ① 并发 10 个 matchTick + 1 个 placeDecision ⇒ orders/fills/account 三者一致（数量与现金对得上）；
 *   ② 写第二个文件失败 ⇒ 三文件逐字节回到写前（不得半状态）；
 *   ③ 损坏 account ⇒ degraded + account null 语义 + 30s 节拍内零写入 + POST 400；
 *   ④ ledgerRepair 从 *.bak 恢复成功后才解除 degraded，修复后恢复可写。
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { PrismTradingStore, matchTick, placeDecision } from './prismAccount.ts'
import type { PrismAccount, PrismDecision, PrismFill, PrismOrder } from '../shared/prism.ts'
import { PrismStore } from './prismStore.ts'
import { makePrismRoutes } from './prismRoutes.ts'

const DAY = '2026-10-22'
const NOW = Date.parse(`${DAY}T10:05:00+08:00`)
const BAR = Date.parse(`${DAY}T10:00:00+08:00`)

const accountOf = (over: Partial<PrismAccount> = {}): PrismAccount => ({
  day: DAY,
  capitalLimit: 100_000,
  capital: 100_000,
  cash: 100_000,
  realized: 0,
  dayStartEquity: null,
  positions: [],
  copiedAt: null,
  copyLogs: [],
  ...over,
})

const orderOf = (over: Partial<PrismOrder> = {}): PrismOrder => ({
  id: 'o-buy-1',
  secid: '1.600000',
  name: '测试一号',
  side: 'buy',
  price: 10,
  shares: 100,
  reason: 'test',
  decidedAt: Date.parse(`${DAY}T09:35:00+08:00`),
  day: DAY,
  status: 'pending',
  origin: 'auto',
  ...over,
})

const decisionOf = (orders: PrismDecision['orders']): PrismDecision => ({
  limits: { singlePct: null, totalPct: null, note: null },
  note: 'test',
  orders,
  cancel: [],
  rejects: [],
  parseError: null,
})

const depsOf = () => ({
  now: () => NOW,
  quotes: async () => ({
    '1.600000': { name: '测试一号', price: 10, prev: 10 },
    '1.600001': { name: '测试二号', price: 10, prev: 10 },
  }),
  bars: async (secid: string) => secid === '1.600000'
    ? { bars: [{ t: BAR, high: 10.5, low: 9.5, volume: 100_000 }], source: '1min' as const, reason: null }
    : { bars: [], source: '1min' as const, reason: null },
  participationRate: 0.1,
})

const readLedgerText = async (dir: string): Promise<Record<string, string>> => ({
  account: await readFile(join(dir, 'prism-account.json'), 'utf8'),
  orders: await readFile(join(dir, 'prism-orders.json'), 'utf8'),
  equity: await readFile(join(dir, 'prism-equity.json'), 'utf8'),
})

const mtimesOf = async (dir: string): Promise<Record<string, number>> => {
  const out: Record<string, number> = {}
  for (const f of ['prism-account.json', 'prism-orders.json', 'prism-equity.json']) out[f] = (await stat(join(dir, f))).mtimeMs
  return out
}

/* ── ① 并发单飞：10 × matchTick + 1 × placeDecision ── */

test('P0-1 ① 并发 10 个 matchTick + 1 个下单：orders/fills/account 一致，现金可复算', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'prism-p0-conc-'))
  try {
    const store = new PrismTradingStore(dir)
    await store.init()
    await store.saveAll({ account: accountOf(), orders: [orderOf()], fills: [], equity: [] })

    const decision = decisionOf([{ secid: '1.600001', side: 'buy', price: 10, shares: 200, reason: '并发下单' }])
    const ticks = Array.from({ length: 10 }, () => matchTick(store, depsOf()))
    const placed = placeDecision(store, decision, NOW, await depsOf().quotes())
    const results = await Promise.allSettled([...ticks, placed])
    assert.equal(results.filter((r) => r.status === 'rejected').length, 0, '并发操作不得有失败')

    const orders = store.orders()
    const fills = store.fills()
    const account = store.account()

    // 数量对得上：委托的 filledShares = 该委托 fills 合计；成交数不多不少
    assert.equal(orders.length, 2, '原挂单 + 新下单各一笔')
    assert.equal(fills.length, 1, '同一 bar 只能成交一次（并发重入不得重复成交）')
    const filledOrder = orders.find((o) => o.id === 'o-buy-1')
    assert.equal(filledOrder?.status, 'filled')
    assert.equal(filledOrder?.filledShares, 100)
    const fill = fills[0] as PrismFill
    assert.equal(fill.orderId, 'o-buy-1')
    assert.equal(fill.shares, 100)
    assert.equal(orders.find((o) => o.id === fill.orderId) !== undefined, true, '每笔成交必须有对应委托')

    // 现金对得上：初始现金 − Σ(买入 amount+fee) + Σ(卖出 amount−fee)
    const expectedCash = Math.round((
      accountOf().cash +
      fills.reduce((sum, f) => sum + (f.side === 'sell' ? f.amount - f.fee : -(f.amount + f.fee)), 0)
    ) * 100) / 100
    assert.equal(account.cash, expectedCash)
    assert.equal(account.positions.find((p) => p.secid === '1.600000')?.qty, 100)
    assert.equal(account.positions.reduce((sum, p) => sum + p.qty, 0), fills.filter((f) => f.side === 'buy').reduce((sum, f) => sum + f.shares, 0) - fills.filter((f) => f.side === 'sell').reduce((sum, f) => sum + f.shares, 0))

    // 磁盘与内存一致（同一个事务的三账本）
    const diskOrders = JSON.parse(await readFile(join(dir, 'prism-orders.json'), 'utf8')) as { orders: PrismOrder[]; fills: PrismFill[] }
    const diskAccount = JSON.parse(await readFile(join(dir, 'prism-account.json'), 'utf8')) as { account: PrismAccount }
    assert.equal(diskOrders.orders.length, orders.length)
    assert.equal(diskOrders.fills.length, fills.length)
    assert.equal(diskAccount.account.cash, account.cash)
    assert.equal(diskAccount.account.cash, expectedCash)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

/* ── ② 事务写：第二个文件失败 ⇒ 三文件回滚 ── */

test('P0-1 ② 注入「写第二个文件失败」：恢复后三文件与写前逐字节一致', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'prism-p0-rollback-'))
  try {
    const store = new PrismTradingStore(dir)
    await store.init()
    const baseAccount = accountOf()
    const baseOrder = orderOf()
    await store.saveAll({ account: baseAccount, orders: [baseOrder], fills: [], equity: [] })
    const before = await readLedgerText(dir)

    const changed = {
      account: { ...baseAccount, cash: 1 },
      orders: [baseOrder, orderOf({ id: 'o-buy-2', secid: '1.600001' })],
      fills: [{ orderId: 'o-buy-1', secid: '1.600000', name: '测试一号', side: 'buy' as const, price: 10, shares: 100, amount: 1000, fee: 5.01, at: BAR, source: '1min' as const }],
    }
    await assert.rejects(() => store.saveAll(changed, { failCommitAt: 2 }), /注入：第 2 个文件提交失败/)
    const after = await readLedgerText(dir)
    assert.deepEqual(after, before, '三个文件必须逐字节回到写前（不得半状态）')
    assert.equal(store.account().cash, baseAccount.cash, '失败后内存也不得前进')
    assert.equal(store.orders().length, 1)
    assert.equal(store.fills().length, 0)
    const leftovers = (await readdir(dir)).filter((f) => f.includes('.tmp-') || f.includes('.restore-'))
    assert.deepEqual(leftovers, [], '失败后不得遗留临时文件')

    // 同一事务不注入 ⇒ 正常落盘，三账本一起前进
    await store.saveAll(changed)
    const ok = await readLedgerText(dir)
    assert.notEqual(ok.account, before.account)
    assert.equal((JSON.parse(ok.orders) as { orders: unknown[] }).orders.length, 2)
    assert.equal((JSON.parse(ok.account) as { account: { cash: number } }).account.cash, 1)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

/* ── ③ 坏账本 fail-closed：30 秒节拍零写入 + POST 400 ── */

const fakeData = () => ({
  portData: () => ({ groups: [], items: [] }),
  watchData: () => ({ groups: [], items: [] }),
  ledgerEntries: () => [],
}) as never

const callRoute = async (store: PrismStore, trading: PrismTradingStore, body: unknown): Promise<{ status: number; body: Record<string, any> }> => {
  const route = makePrismRoutes({ store, trading, data: fakeData(), get: () => undefined }).find((r) => r.path === '/tradewatcher/prism')
  let text = ''
  const res = {
    statusCode: 200,
    setHeader: () => undefined,
    end: (s: string) => { text = s },
  } as unknown as ServerResponse
  const req = { method: 'POST', [Symbol.asyncIterator]: async function* () { yield Buffer.from(JSON.stringify(body)) } } as unknown as IncomingMessage
  await route?.handler(req, res)
  return { status: (res as unknown as { statusCode: number }).statusCode, body: JSON.parse(text) as Record<string, any> }
}

test('P0-2 ③ 损坏 account：degraded + null 语义 + 30 秒节拍零写入 + POST 下单 400', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'prism-p0-corrupt-'))
  try {
    const goodOrder = orderOf()
    const goodFill: PrismFill = { orderId: 'o-old', secid: '1.600000', name: '测试一号', side: 'sell', price: 10, shares: 100, amount: 1000, fee: 6.01, at: BAR, source: '1min' }
    await writeFile(join(dir, 'prism-account.json'), '{"v":1,"account":{ 半截')
    await writeFile(join(dir, 'prism-orders.json'), JSON.stringify({ v: 1, orders: [goodOrder], fills: [goodFill] }))
    await writeFile(join(dir, 'prism-equity.json'), JSON.stringify({ v: 1, points: [] }))

    const trading = new PrismTradingStore(dir)
    await trading.init()
    assert.equal(trading.degraded, true, '坏账本必须 degraded')
    assert.equal((trading.account() as unknown as { cash: number | null }).cash, null, 'account 必须是 null 语义')
    assert.match(trading.ledgerError() ?? '', /prism-account\.json/)

    const before = await mtimesOf(dir)
    const results = await Promise.allSettled(Array.from({ length: 10 }, () => matchTick(trading, depsOf())))
    assert.equal(results.every((r) => r.status === 'rejected'), true, 'degraded 时撮合必须全部拒绝')
    for (const r of results) assert.match(String((r as PromiseRejectedResult).reason), /账本不可读/)
    // 再模拟 30 秒节拍再打两拍：仍不得写任何文件
    for (let i = 0; i < 2; i += 1) await matchTick(trading, depsOf()).catch(() => undefined)
    const after = await mtimesOf(dir)
    assert.deepEqual(after, before, 'degraded 期间三账本 mtime 必须完全不变（30 秒节拍也不写）')

    const prism = new PrismStore(dir)
    await prism.init()
    const run = await callRoute(prism, trading, { action: 'run', slot: 'manual' })
    assert.equal(run.status, 400, 'POST 下单（run）必须 400')
    assert.match(run.body.error, /账本不可读/, '错误必须说清账本不可读')
    const pos = await callRoute(prism, trading, { action: 'position', op: 'buy', secid: '1.600000', shares: 100, cost: 10, confirm: true })
    assert.equal(pos.status, 400)
    assert.match(pos.body.error, /账本不可读/)

    // 修复：从 *.bak 恢复
    const backupAccount = accountOf({ cash: 123_456, positions: [{ secid: '1.588170', name: '半导体', qty: 600_000, available: 600_000, cost: 0.86, netCost: 516_000 }] })
    await writeFile(join(dir, 'prism-account.json.bak-20260101'), JSON.stringify({ v: 1, account: backupAccount }))
    const repaired = await callRoute(prism, trading, { action: 'ledgerRepair', backupOf: 'prism-account.json.bak-20260101' })
    assert.equal(repaired.status, 200)
    assert.equal(repaired.body.ok, true)
    assert.equal(trading.degraded, false, '修复成功后才解除 degraded')
    assert.equal(trading.account().cash, 123_456)
    assert.equal(trading.account().positions.length, 1)

    // 修复后恢复可写：下一拍 matchTick 正常落盘（mtime 前进）
    const beforeWrite = await mtimesOf(dir)
    await matchTick(trading, depsOf())
    const afterWrite = await mtimesOf(dir)
    assert.equal(afterWrite['prism-account.json'] > beforeWrite['prism-account.json'], true, '修复后必须恢复可写')
    assert.equal(trading.fills().some((f) => f.orderId === 'o-old'), true, '修复后撮合仍能读到原成交（不得被覆盖）')
    assert.equal(trading.fills().length, 2, '原成交 + 本次撮合各一笔')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

/* ── ④ 源码守卫：四个写路径必须走 runExclusive ── */

test('P0-1 ④ 源码：matchTick / placeDecision / priceCorrection / position 都走 runExclusive', async () => {
  const src = await readFile(new URL('./prismAccount.ts', import.meta.url), 'utf8')
  for (const fn of ['export async function placeDecision', 'export async function matchTick']) {
    const start = src.indexOf(fn)
    assert.notEqual(start, -1, `${fn} 必须存在`)
    const body = src.slice(start, src.indexOf('\n}\n', src.indexOf('store.runExclusive', start)) + 3)
    assert.match(body, /store\.runExclusive\(/, `${fn} 必须整段走 runExclusive`)
  }
  const routes = await readFile(new URL('./prismRoutes.ts', import.meta.url), 'utf8')
  const priceStart = routes.indexOf("if (action === 'priceCorrection')")
  assert.notEqual(priceStart, -1)
  const priceBlock = routes.slice(priceStart, routes.indexOf("if (action === 'model')", priceStart))
  assert.match(priceBlock, /runExclusive\(/)
  assert.match(priceBlock, /saveAll\(/)
  const posStart = routes.indexOf("if (action === 'position')")
  const posBlock = routes.slice(posStart, routes.indexOf("if (action === 'constraints')", posStart))
  assert.match(posBlock, /runExclusive\(/)
  assert.match(posBlock, /saveAll\(/)
})
