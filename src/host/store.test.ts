/**
 * 动词文案与流水动词集合的一致性断言（S4）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { LEDGER_VERB_LABEL } from '../shared/model.ts'
import { LEDGER_VERBS } from './store.ts'

test('S4：动词文案的键集必须与 LEDGER_VERBS 完全一致（少一个就会渲染成英文动词）', () => {
  const keys = Object.keys(LEDGER_VERB_LABEL).sort()
  assert.deepEqual(keys, [...LEDGER_VERBS].sort(), `两边不一致：${keys.join(',')}`)
  assert.notEqual(LEDGER_VERB_LABEL.gmove, '', '每个动词都要有中文名')
})
