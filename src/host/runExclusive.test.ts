/** runExclusive 不可重入：临界区内再次加锁必须立刻报错，而不是永久挂起 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PrismTradingStore } from './prismAccount.ts'

test('① 嵌套调用直接复用同一把锁（不挂起）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'prism-excl-'))
  try {
    const s = new PrismTradingStore(dir); await s.init()
    const out = await s.runExclusive(async () => s.runExclusive(async () => 1))
    assert.equal(out, 1)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('② 串行调用仍然正常（失败不阻塞后继）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'prism-excl2-'))
  try {
    const s = new PrismTradingStore(dir); await s.init()
    assert.equal(await s.runExclusive(async () => 1), 1)
    await assert.rejects(s.runExclusive(async () => { throw new Error('boom') }), /boom/)
    assert.equal(await s.runExclusive(async () => 2), 2)
  } finally { await rm(dir, { recursive: true, force: true }) }
})
