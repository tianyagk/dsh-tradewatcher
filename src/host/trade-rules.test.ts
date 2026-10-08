/**
 * 卖出可用数量判定（P1-8）的断言。
 *
 * 缺陷形态：此前只校验**总持仓**，于是可以录出一笔"A股当天买入、当天卖出"的成交 ——
 * 券商端不存在这笔交易，而当日盈亏与已实现盈亏会按它算出来（数字看着正常、其实错了）。
 *
 * 两类断言：
 *  1. 纯函数 `availableQtyAt`（可卖 = 该时点前已持有 − 同日该时点前买入）；
 *  2. 端到端：宿主 `mutatePortfolio` 真的会驳回（并且 T+0 品种不受限）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { LedgerEntry } from '../shared/model.ts'
import { DataStore, availableQtyAt } from './store.ts'
import { shanghaiDayStart } from './time.ts'

const DAY = 86_400_000
const NOW = Date.now()
const TODAY = shanghaiDayStart(NOW)
const YESTERDAY = TODAY - DAY

const buy = (ts: number, qty: number, price = 10): LedgerEntry => ({ id: `b${ts}`, ts, actor: 'web', verb: 'buy', posId: 'p1', qty, price })
const sell = (ts: number, qty: number): LedgerEntry => ({ id: `s${ts}`, ts, actor: 'web', verb: 'sell', posId: 'p1', qty, price: 11 })

test('availableQtyAt：昨天买入的今天全额可卖', () => {
  const entries = [buy(YESTERDAY + 3600_000, 100)]
  assert.equal(availableQtyAt(entries, 'p1', TODAY + 3600_000), 100)
})

test('availableQtyAt：今日买入的部分不可卖（A股 T+1）', () => {
  const entries = [buy(YESTERDAY + 3600_000, 100), buy(TODAY + 600_000, 50)]
  assert.equal(availableQtyAt(entries, 'p1', TODAY + 3600_000), 100, '总持仓 150，但可卖只有昨天那 100')
  // 只买了今天这一笔时，可卖是 0
  assert.equal(availableQtyAt([buy(TODAY + 600_000, 50)], 'p1', TODAY + 3600_000), 0)
})

test('availableQtyAt：同一时点之前的历史成交按各自时点算（可补录）', () => {
  const entries = [buy(YESTERDAY + 3600_000, 100), sell(TODAY + 600_000, 40), buy(TODAY + 1200_000, 30)]
  // 今天 09:59（那笔卖出之前）：可卖 = 昨天持仓 100
  assert.equal(availableQtyAt(entries, 'p1', TODAY + 300_000), 100)
  // 今天 10:20 之后：held = 100 − 40 + 30 = 90，同日买入 30 → 可卖 60
  assert.equal(availableQtyAt(entries, 'p1', TODAY + 1800_000), 60)
})

test('宿主校验：A股当日买入当日卖出被驳回（含 T+1 原因）；T+0 品种放行', async () => {
  const store = new DataStore(mkdtempSync(join(tmpdir(), 'tw-trade-')))
  await store.init()
  await store.mutatePortfolio({ op: 'addGroup', name: '测试分组' })
  const groupId = store.portData().groups[0].id

  // A股：今天买入 → 今天卖出必须被驳回
  await store.mutatePortfolio({ op: 'addPos', groupId, secid: '1.600519', symbolName: '贵州茅台' })
  const aShare = store.portData().items.find((p) => p.secid === '1.600519')!
  await store.mutatePortfolio({ op: 'buy', posId: aShare.id, qty: 100, price: 1500, fee: 5 })
  await assert.rejects(
    () => store.mutatePortfolio({ op: 'sell', posId: aShare.id, qty: 100, price: 1600 }),
    /可用（可卖）数量不足/,
  )
  // 昨天买入的那部分今天可以卖
  await store.mutatePortfolio({ op: 'buy', posId: aShare.id, qty: 100, price: 1400, fee: 5, ts: YESTERDAY + 6 * 3600_000 })
  await store.mutatePortfolio({ op: 'sell', posId: aShare.id, qty: 100, price: 1600 })
  const ledger = store.ledgerEntries()
  assert.equal(ledger.filter((e) => e.verb === 'sell').length, 1, '只有那笔合法的卖出落了账')

  // T+0（ETF）：当日买入当日可卖，不走 T+1 限制
  await store.mutatePortfolio({ op: 'addPos', groupId, secid: '1.510300', symbolName: '沪深300ETF' })
  const etf = store.portData().items.find((p) => p.secid === '1.510300')!
  await store.mutatePortfolio({ op: 'buy', posId: etf.id, qty: 1000, price: 3.9, fee: 1 })
  await store.mutatePortfolio({ op: 'sell', posId: etf.id, qty: 1000, price: 3.95, fee: 1 })
  assert.equal(store.ledgerEntries().filter((e) => e.posId === etf.id && e.verb === 'sell').length, 1)
})
