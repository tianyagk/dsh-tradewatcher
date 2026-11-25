/** saveAll 跨进程保护：磁盘上多出的成交/委托 ⇒ 拒绝整份覆盖（审计 D1） */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PrismTradingStore } from './prismAccount.ts'

const fillOf = (n: number) => ({
  orderId: 'o1', secid: '1.600938', name: '中国海油', side: 'buy' as const, price: 30, shares: n * 100,
  amount: 30 * n * 100, fee: 5, at: n, source: '1min' as const,
})

test('① 另一个进程写入成交后，本进程 saveAll 必须拒绝覆盖', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'prism-guard-'))
  try {
    const a = new PrismTradingStore(dir); await a.init()
    const b = new PrismTradingStore(dir); await b.init()
    const base = a.account()
    // B 先写入一笔成交
    await b.saveAll({ account: base, orders: [], fills: [fillOf(1)] })
    // A 仍拿着旧快照（0 笔）⇒ 覆盖会丢成交
    await assert.rejects(
      a.saveAll({ account: base, orders: [], fills: [] }),
      /账本已被其他进程写入/,
    )
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('② 正常路径（磁盘 == 内存）不误报', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'prism-guard2-'))
  try {
    const a = new PrismTradingStore(dir); await a.init()
    await a.saveAll({ account: a.account(), orders: [], fills: [fillOf(2)] })
    await a.saveAll({ account: a.account(), orders: [], fills: [fillOf(2)] })
  } finally { await rm(dir, { recursive: true, force: true }) }
})
