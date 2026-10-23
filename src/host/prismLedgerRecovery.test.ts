import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PrismTradingStore, placeDecision, rebuildFromOrders } from './prismAccount.ts'
import type { PrismFill, PrismOrder } from '../shared/prism.ts'
import { PrismStore } from './prismStore.ts'
import { runPrismForSlot } from './prismRoutes.ts'

const account = {
  day: '2026-10-23', capitalLimit: 1_600_000, cash: 100_000.16, realized: 0, dayStartEquity: 1, copiedAt: 1,
  positions: [{ secid: '1.588170', name: '半导体', qty: 600000, available: 600000, cost: 0.86, netCost: 516000 }],
  copyLogs: [],
}
const fill: PrismFill = { orderId: 'o1', secid: '1.588170', name: '半导体', side: 'sell', price: 0.698, shares: 100, amount: 69.8, fee: 0.02, at: 1, source: '1min' }
const order: PrismOrder = { id: 'o1', secid: '1.588170', name: '半导体', side: 'sell', price: 0.698, shares: 100, reason: 'x', decidedAt: 1, day: '2026-10-23', status: 'filled', fillPrice: 0.698, fee: 0.02, filledAt: 2, source: '1min' }

async function seed(dir: string, accountBody: unknown, ordersBody?: unknown): Promise<void> {
  await writeFile(join(dir, 'prism-account.json'), JSON.stringify(accountBody))
  if (ordersBody !== undefined) await writeFile(join(dir, 'prism-orders.json'), JSON.stringify(ordersBody))
}

test('① 三种历史账户格式都能读出 positions/fills（读空 ⇒ 败）', async () => {
  const cases: Array<[string, unknown, unknown?]> = [
    ['bare', { ...account, fills: [fill] }],
    ['wrapper', { v: 1, account }, { v: 1, orders: [], fills: [fill] }],
    ['wrapper-fills', { v: 1, account, fills: [fill] }],
  ]
  for (const [name, accBody, ordersBody] of cases) {
    const dir = await mkdtemp(join(tmpdir(), `prism-format-${name}-`))
    try {
      await seed(dir, accBody, ordersBody)
      const s = new PrismTradingStore(dir)
      await s.init()
      assert.equal(s.account().positions.length, 1, `${name}: positions`)
      assert.equal(s.fills().length, 1, `${name}: fills`)
      assert.equal(s.account().cash, account.cash, `${name}: cash`)
    } finally { await rm(dir, { recursive: true, force: true }) }
  }
})

test('② accountWriteGuard：旧有数据 ⇒ 拒绝写空；磁盘不被覆盖', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'prism-guard-'))
  try {
    const s = new PrismTradingStore(dir)
    await s.init()
    await s.saveAccount({ ...account, cash: 1000 }, { explicitReset: true })
    const empty = { ...account, cash: 1_600_000, positions: [] }
    await assert.rejects(() => s.saveAccount(empty), /accountWriteGuard/)
    const disk = JSON.parse(await readFile(join(dir, 'prism-account.json'), 'utf8')) as { account: { positions: unknown[] } }
    assert.equal(disk.account.positions.length, 1, '拒绝后磁盘必须保留旧持仓')
    await s.saveAccount(empty, { explicitReset: true })
    assert.equal(s.account().positions.length, 0, '显式 reset 才允许清空')
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('③ 重建：orders.json 的已成交单能算出 fills 与 cash（空 ⇒ 败）', () => {
  const buys: PrismOrder[] = [
    { ...order, id: 'b1', side: 'buy', price: 1, shares: 100, fillPrice: 1, fee: 0, status: 'filled' },
    { ...order, id: 'b2', side: 'buy', price: 2, shares: 100, fillPrice: 2, fee: 0.1, status: 'filled' },
  ]
  const r = rebuildFromOrders({ ...account, capitalLimit: 1000 }, buys)
  assert.equal(r.fills.length, 2)
  assert.equal(r.cash, 699.9)
  assert.doesNotMatch(r.note, /重建|recovered|rebuilt/)
  assert.throws(() => assert.equal(rebuildFromOrders(account, []).fills.length, 2, '注入：重建为空'), /注入/)
})

test('④ 自动 run 路径落单并写 placement（只写 runs ⇒ 败）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'prism-auto-place-'))
  try {
    const store = new PrismStore(dir)
    const trading = new PrismTradingStore(dir)
    await store.init(); await trading.init()
    let n = 0
    const llm = {
      stream: () => {
        n += 1
        const text = n <= 4 ? `报告${n}` : '汇总\n```json\n{"note":"不买：无现金；不卖：未破位","limits":{"singlePct":20,"totalPct":50,"note":"x"},"orders":[{"secid":"1.600519","side":"buy","price":10,"shares":100,"reason":"测试"}],"cancel":[]}\n```'
        return (async function* () { yield { type: 'text-delta', text } })()
      },
    }
    const get = (name: string): unknown => name === 'llm' ? llm : name === 'agentDefaultModel' ? { currentSelection: () => ({ provider: 'p', model: 'm' }) } : undefined
    const data = { portData: () => ({ groups: [], items: [] }), watchData: () => ({ groups: [], items: [] }), ledgerEntries: () => [] }
    const quotes = async () => ({ '1.600519': { name: '贵州茅台', price: 10, prev: 10 } })
    const run = await runPrismForSlot({ store, trading, data: data as never, get, quotes: quotes as never, now: () => Date.parse('2026-10-23T14:59:09+08:00') }, '09:35')
    assert.notEqual(run.placement, undefined, '每个 run 必须有 placement')
    assert.equal(trading.orders().length > 0, true, '自动路径必须落单')
    assert.equal(trading.orders()[0]?.status, 'pending', '14:59:09 必须可下单（<15:00）')
    assert.equal(run.placement?.placed, 1)
    assert.equal(run.placement?.skippedReasons?.length ?? 0, run.placement?.skipped ?? 0)
    assert.equal(store.runs().at(-1)?.placement !== undefined, true)
    const first = trading.orders()[0]
    assert.notEqual(first, undefined)
    const dup = await placeDecision(trading, run.decision!, first!.decidedAt, { '1.600519': { name: '贵州茅台', price: 10, prev: 10 } })
    assert.equal(dup.placement.skipped, 1, '重复委托必须计入 skipped')
    assert.match(String(dup.placement.skippedReasons[0]?.reason), /重复/)
    console.log('AUTO_PLACEMENT', JSON.stringify({ placement: run.placement, orders: trading.orders().length }))
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('⑤ orders.json 是唯一读取源，账户内嵌只兜底；GET 重读磁盘', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'prism-orders-source-'))
  try {
    await writeFile(join(dir, 'prism-account.json'), JSON.stringify({ v: 1, account, orders: [{ ...order, id: 'embedded' }], fills: [fill] }))
    const two = [{ ...order, id: 'file1' }, { ...order, id: 'file2' }]
    await writeFile(join(dir, 'prism-orders.json'), JSON.stringify({ v: 1, orders: two, fills: [fill, fill] }))
    const s = new PrismTradingStore(dir)
    await s.init()
    assert.equal(s.orders().length, 2, '磁盘 2 笔必须胜过账户内嵌 1 笔')
    assert.equal(s.fills().length, 2)
    const three = [...two, { ...order, id: 'file3' }]
    await writeFile(join(dir, 'prism-orders.json'), JSON.stringify({ v: 1, orders: three, fills: [fill, fill, fill] }))
    await s.reloadOrders()
    assert.equal(s.orders().length, 3, 'reloadOrders 必须读到新磁盘')
    assert.equal(s.fills().length, 3)
    const routes = readFileSync(join(process.cwd(), 'src/host/prismRoutes.ts'), 'utf8')
    const get = routes.slice(routes.indexOf("if (req.method === 'GET')"), routes.indexOf("if (req.method !== 'POST')"))
    assert.match(get, /await deps\.trading\.reloadOrders\(\)/, 'GET 必须重读 prism-orders.json')
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('⑥ 恢复回包不得含 重建/recovered/rebuilt；source 仍是 1min', async () => {
  const r = rebuildFromOrders({ ...account, capitalLimit: 1_600_000 }, [order])
  const payload = JSON.stringify(r)
  assert.doesNotMatch(payload, /重建|recovered|rebuilt/)
  assert.equal(r.fills[0]?.source, '1min')
  const ui = readFileSync(join(process.cwd(), 'src/client/PrismPage.tsx'), 'utf8')
  assert.doesNotMatch(ui, /重建|recovered|rebuilt/)
})

test('⑦ 14:59:09 可下单、15:00:00 才判盘后（口径 = 下单时刻）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'prism-close-boundary-'))
  try {
    const s = new PrismTradingStore(dir)
    await s.init()
    await s.saveAccount({ ...account, day: '2026-10-23', cash: 200000, positions: [], copiedAt: null }, { explicitReset: true })
    const d = { limits: { singlePct: 20, totalPct: 50, note: 'x' }, note: '不买：test；不卖：test', orders: [{ secid: '1.600519', side: 'buy' as const, price: 10, shares: 100, reason: 'x' }], cancel: [], rejects: [], parseError: null }
    const q = { '1.600519': { name: '贵州茅台', price: 10, prev: 10 } }
    const before = await placeDecision(s, d, Date.parse('2026-10-23T14:59:09+08:00'), q)
    assert.equal(before.placement.placed, 1, '14:59:09 必须在盘内')
    assert.equal(s.orders()[0]?.status, 'pending')
    const after = await placeDecision(s, { ...d, orders: [{ ...d.orders[0]!, shares: 200 }] }, Date.parse('2026-10-23T15:00:00+08:00'), q)
    assert.equal(after.placement.rejects[0]?.reason.includes('盘后不下单'), true, '15:00:00 才判盘后')
  } finally { await rm(dir, { recursive: true, force: true }) }
})
