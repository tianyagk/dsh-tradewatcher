/** 批量估值：一次请求解析 PE/PB/市值；失败不抛（缺数据写 —） */
import test from 'node:test'
import assert from 'node:assert/strict'
import { fetchValuationBatch } from './em.ts'

const payload = { data: { diff: [
  { f12: '601872', f13: 1, f14: '招商轮船', f9: 12.3, f23: 1.42, f20: 4.2e10 },
  { f12: '600938', f13: 1, f14: '中国海油', f9: 8.8, f23: 1.1, f20: 1.1e12 },
] } }

test('① 解析 PE/PB/总市值，key 为「市场.代码」', async () => {
  const out = await fetchValuationBatch(['1.601872', '1.600938'], async () => payload)
  assert.equal(out['1.601872']?.pe, 12.3)
  assert.equal(out['1.601872']?.pb, 1.42)
  assert.equal(out['1.601872']?.totalMv, 4.2e10)
  assert.equal(out['1.600938']?.name, '中国海油')
})

test('② 请求失败 ⇒ 返回空对象（调用方按 — 处理，不编）', async () => {
  const out = await fetchValuationBatch(['1.601872'], async () => { throw new Error('boom') })
  assert.deepEqual(out, {})
})

test('③ 空入参 ⇒ 不发请求', async () => {
  let called = 0
  const out = await fetchValuationBatch([], async () => { called += 1; return payload })
  assert.deepEqual(out, {})
  assert.equal(called, 0)
})
