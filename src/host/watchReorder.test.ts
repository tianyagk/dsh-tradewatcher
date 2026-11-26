import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DataStore } from './store.ts'

test('自选分组拖动排序：reorderGroups 按给定顺序落盘', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tw-watch-order-'))
  try {
    const store = new DataStore(dir)
    await store.init()
    await store.mutateWatch({ op: 'addGroup', name: 'A' })
    await store.mutateWatch({ op: 'addGroup', name: 'B' })
    const before = [...store.watchData().groups].sort((a, b) => a.order - b.order).map((g) => g.id)
    assert.equal(before.length, 2)
    await store.mutateWatch({ op: 'reorderGroups', groupIds: [before[1]!, before[0]!] })
    const after = [...store.watchData().groups].sort((a, b) => a.order - b.order).map((g) => g.id)
    assert.deepEqual(after, [before[1], before[0]])
    await assert.rejects(() => store.mutateWatch({ op: 'reorderGroups', groupIds: [before[0]!, before[0]!] }), /重复/)
  } finally { await rm(dir, { recursive: true, force: true }) }
})
