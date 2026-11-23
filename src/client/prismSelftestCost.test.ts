/** P1-2：prismSelftest 会触发真实 LLM 调用（最长 20s），不得在每次保存后重跑 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const PAGE = readFileSync(new URL('./PrismPage.tsx', import.meta.url), 'utf8')

test('① 自检只在挂载时调用一次', () => {
  const calls = PAGE.match(/api\.prismSelftest\(/g) ?? []
  assert.equal(calls.length, 1, `prismSelftest 只应出现 1 次，实际 ${calls.length}`)
  assert.match(PAGE, /React\.useEffect\(\(\) => \{ load\(\); loadSelf\(\) \}/)
})

test('② load() 里不得再有 selftest（保存后刷新只拉 prismState）', () => {
  const m = PAGE.match(/const load = React\.useCallback\(\(\): void => \{([\s\S]*?)\}, \[\]\)/)
  assert.ok(m, '必须存在 load 回调')
  assert.ok(!/prismSelftest/.test(m[1]), 'load 不得调用 selftest')
  assert.match(m[1], /api\.prismState\(\)/)
})
