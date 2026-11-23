/** P1-8：lastSampleTs 可能是 undefined（老快照/部分回包），`!== null` 漏判 ⇒ shClockText(undefined) 抛 RangeError ⇒ 白屏 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const SRC = readFileSync(new URL('./RescuePanel.tsx', import.meta.url), 'utf8')

test('① 所有 lastSampleTs 判断必须用 != null（同时覆盖 null 与 undefined）', () => {
  const bad = SRC.match(/lastSampleTs !== null/g) ?? []
  assert.equal(bad.length, 0, `仍有 ${bad.length} 处 !== null（undefined 会漏过）`)
  const ok = SRC.match(/lastSampleTs != null/g) ?? []
  assert.ok(ok.length >= 3, `应至少 3 处 != null，实际 ${ok.length}`)
})

test('② 反例注入：!== null 的写法对 undefined 会放行（说明为什么必须改）', () => {
  const v: number | null | undefined = undefined
  assert.equal(v !== null, true, 'undefined !== null 为 true ⇒ 旧写法确实会继续调用 shClockText')
  assert.equal(v != null, false, 'undefined != null 为 false ⇒ 新写法正确拦住')
})
