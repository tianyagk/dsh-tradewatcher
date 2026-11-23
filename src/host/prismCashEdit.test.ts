/** 现金持仓可编辑：POST {action:'cash'} 直接设余额（非负、两位小数），走 runExclusive + saveAll */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const ROUTES = readFileSync(new URL('./prismRoutes.ts', import.meta.url), 'utf8')

test('① 路由有 cash 分支：非负校验 + runExclusive + saveAll', () => {
  const i = ROUTES.indexOf("action === 'cash'")
  assert.ok(i > 0, '缺少 action:cash')
  const seg = ROUTES.slice(i, i + 900)
  assert.match(seg, /Number\.isFinite\(cash\) \|\| cash < 0/)
  assert.match(seg, /runExclusive/)
  assert.match(seg, /saveAll\(\{ account: value/)
})

test('② 现金只改 cash，不动 realized（不是成交，不产生盈亏）', () => {
  const i = ROUTES.indexOf("action === 'cash'")
  const seg = ROUTES.slice(i, i + 900)
  assert.match(seg, /const value = \{ \.\.\.account, cash:/)
  assert.ok(!/realized:/.test(seg), '现金调整不得改 realized')
})

test('③ 反例：负数现金必须 400', () => {
  const i = ROUTES.indexOf("action === 'cash'")
  const seg = ROUTES.slice(i, i + 300)
  assert.match(seg, /send\(res, 400, \{ ok: false, error: '现金必须是非负数' \}\)/)
})
