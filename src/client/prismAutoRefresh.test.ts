/** 棱镜自动刷新：页面必须自己看到宿主按周期写入的新决策，不能依赖手动刷新 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const PAGE = readFileSync(new URL('./PrismPage.tsx', import.meta.url), 'utf8')

test('① 页面有 30s 静默刷新定时器', () => {
  assert.match(PAGE, /const PRISM_AUTO_REFRESH_MS = 30_000/)
  assert.match(PAGE, /setInterval\(/)
  assert.match(PAGE, /\}, PRISM_AUTO_REFRESH_MS\)/)
})

test('② 静默刷新只拉 prismState，不跑 selftest、不清错误', () => {
  const m = PAGE.match(/const refresh = React\.useCallback\(\(\): void => \{([\s\S]*?)\}, \[\]\)/)
  assert.ok(m, '必须存在 refresh 回调')
  assert.match(m[1], /api\.prismState\(\)/)
  assert.ok(!/prismSelftest/.test(m[1]), '刷新不得重复跑 selftest')
  assert.ok(!/setErr/.test(m[1]), '刷新不得清错误态')
})

test('③ 页面隐藏时不刷新，重新可见立即刷新一次', () => {
  assert.match(PAGE, /document\.visibilityState === 'hidden'/)
  assert.match(PAGE, /addEventListener\('visibilitychange'/)
  assert.match(PAGE, /removeEventListener\('visibilitychange'/)
})

test('④ 首屏仍走 load()（含 selftest），刷新不替换它', () => {
  assert.match(PAGE, /React\.useEffect\(\(\) => \{ load\(\) \}, \[load\]\)/)
})
