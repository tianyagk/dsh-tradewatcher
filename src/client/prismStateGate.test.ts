import test from 'node:test'
import assert from 'node:assert/strict'


test('⑦ asOf 每拍变化但内容相同 ⇒ 指纹必须相同（审计 P0）', async () => {
  const { stateSignature } = await import('./prismStateGate.ts')
  const a = { asOf: 1, state: { cash: 100, runs: [{ id: 'r1' }] } }
  const b = { asOf: 999, state: { cash: 100, runs: [{ id: 'r1' }] } }
  const c = { asOf: 999, state: { cash: 101, runs: [{ id: 'r1' }] } }
  assert.equal(stateSignature(a), stateSignature(b), 'asOf 不应参与指纹')
  assert.notEqual(stateSignature(a), stateSignature(c), '内容变化必须改变指纹')
})
