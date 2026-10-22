import assert from 'node:assert/strict'
import test from 'node:test'
import { dueSlots } from './prismScheduler.ts'
import { parseMarketStamp } from './time.ts'
import type { PrismSettings } from '../shared/prism.ts'

const at = (label: string): number => parseMarketStamp(label) as number
const settings = (times: string[], fired: Record<string, string[]> = {}): PrismSettings => ({ times, lastFired: fired })

test('③ 时点：交易日窗口内触发、非交易日不跑、已触发不重复', () => {
  const s = settings(['09:35', '11:20', '13:10', '14:40'])
  assert.deepEqual(dueSlots(s, at('2026-10-22 09:36:00')).due, ['09:35'])
  assert.deepEqual(dueSlots(s, at('2026-10-22 09:30:00')).due, [], '未到时点不跑')
  assert.deepEqual(dueSlots(s, at('2026-10-22 09:50:00')).due, [], '超过 10 分钟不自动追（手动补跑）')
  assert.deepEqual(dueSlots(settings(['09:35'], { '2026-10-22': ['09:35'] }), at('2026-10-22 09:36:00')).due, [], '已触发不重复')
  const weekend = dueSlots(s, at('2026-10-24 09:36:00')) // 2026-10-24 是周六
  assert.equal(weekend.trading, false)
  assert.deepEqual(weekend.due, [])
})

test('③ 时点可增删：任意数量都按序判定', () => {
  const s = settings(['09:36', '09:40', '14:40'])
  const plan = dueSlots(s, at('2026-10-22 09:41:00'))
  assert.deepEqual(plan.due, ['09:36', '09:40'], '两个都在 10 分钟窗口内 ⇒ 都触发（顺序固定）')
})
