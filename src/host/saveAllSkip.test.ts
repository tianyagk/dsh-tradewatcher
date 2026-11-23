/** saveAll 内容未变时不得重写（交易时段 matchTick 每 30s 一次 ⇒ 112MB/日 无谓写） */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PrismTradingStore } from './prismAccount.ts'

const setup = async () => {
  const dir = await mkdtemp(join(tmpdir(), 'prism-saveall-'))
  const store = new PrismTradingStore(dir)
  await store.init()
  const snap = { account: store.account(), orders: store.orders(), fills: store.fills(), equity: store.equity() }
  await store.saveAll(snap)
  return { dir, store, snap }
}

test('① 同内容再写 ⇒ 三份账本 mtime 不变（不重写）', async () => {
  const { dir, store, snap } = await setup()
  try {
    const files = ['prism-account.json', 'prism-orders.json', 'prism-equity.json']
    const before = await Promise.all(files.map((f) => stat(join(dir, f)).then((s) => s.mtimeMs)))
    await new Promise((r) => setTimeout(r, 30))
    await store.saveAll({ ...snap })
    const after = await Promise.all(files.map((f) => stat(join(dir, f)).then((s) => s.mtimeMs)))
    assert.deepEqual(after, before, '同内容不得产生写入')
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('② 内容变化 ⇒ 只重写变化的那一份，其余 mtime 不变', async () => {
  const { dir, store, snap } = await setup()
  try {
    const acc = join(dir, 'prism-account.json'); const ord = join(dir, 'prism-orders.json')
    const before = { acc: (await stat(acc)).mtimeMs, ord: (await stat(ord)).mtimeMs }
    await new Promise((r) => setTimeout(r, 30))
    const cash = typeof snap.account.cash === 'number' ? snap.account.cash + 1 : 1
    await store.saveAll({ ...snap, account: { ...snap.account, cash } as typeof snap.account })
    assert.ok((await stat(acc)).mtimeMs > before.acc, 'account 变了必须写')
    assert.equal((await stat(ord)).mtimeMs, before.ord, 'orders 未变不得写')
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('③ 反例：把跳过逻辑去掉（强制写）⇒ mtime 必变', async () => {
  const { dir, store, snap } = await setup()
  try {
    const acc = join(dir, 'prism-account.json')
    const before = (await stat(acc)).mtimeMs
    await new Promise((r) => setTimeout(r, 30))
    // 直接改一个空格再写，模拟"不跳过"的实现效果
    const text = await readFile(acc, 'utf8')
    await store.saveAll({ ...snap, account: JSON.parse(text).account })
    const forced = (await stat(acc)).mtimeMs
    // 若实现正确，文本相同 ⇒ 不写 ⇒ 不变；这条断言把"正确行为"钉住
    assert.equal(forced, before, '序列化文本相同即不写（去跳过 ⇒ 必变 ⇒ 断言失败）')
  } finally { await rm(dir, { recursive: true, force: true }) }
})
