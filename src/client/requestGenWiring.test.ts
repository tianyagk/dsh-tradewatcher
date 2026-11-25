/** 静默刷新必须有请求代号（旧回包不得覆盖新状态） */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

test('① PrismPage 的 load/refresh 都领代号并判 stale', () => {
  const src = readFileSync(new URL('./PrismPage.tsx', import.meta.url), 'utf8')
  assert.match(src, /createRequestGen/)
  assert.equal((src.match(/reqGenRef\.current\.next\(\)/g) ?? []).length >= 2, true, 'load 与 refresh 都要领代号')
  assert.equal((src.match(/current\.stale\(gen\)/g) ?? []).length >= 2, true, '落地前都要判 stale')
})
