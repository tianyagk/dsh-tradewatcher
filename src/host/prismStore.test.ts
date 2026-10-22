import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PrismStore } from './prismStore.ts'
import { PRISM_DEFAULT_SKELETON, PRISM_DEFAULT_TIMES } from '../shared/prism.ts'

test('④ 骨架：首次打开写默认值；可读写', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'prism-store-'))
  try {
    const store = new PrismStore(dir)
    await store.init()
    assert.equal(store.skeleton(), PRISM_DEFAULT_SKELETON)
    const disk = await readFile(join(dir, 'prism-skeleton.md'), 'utf8')
    assert.equal(disk, PRISM_DEFAULT_SKELETON, '首次打开必须落盘默认骨架')
    await store.saveSkeleton('自定义骨架\n第二行')
    const again = new PrismStore(dir)
    await again.init()
    assert.equal(again.skeleton(), '自定义骨架\n第二行', '重启后读到用户编辑的骨架')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('③ 时点：默认四个、可增删、水位落盘', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'prism-store2-'))
  try {
    const store = new PrismStore(dir)
    await store.init()
    assert.deepEqual(store.settings().times, [...PRISM_DEFAULT_TIMES])
    const saved = await store.saveTimes(['09:35', '10:00', '14:40'])
    assert.deepEqual(saved.times, ['09:35', '10:00', '14:40'])
    await store.markFired('2026-10-22', '09:35')
    const again = new PrismStore(dir)
    await again.init()
    assert.deepEqual(again.settings().times, ['09:35', '10:00', '14:40'])
    assert.deepEqual(again.settings().lastFired['2026-10-22'], ['09:35'], '水位必须跨重启保留')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
