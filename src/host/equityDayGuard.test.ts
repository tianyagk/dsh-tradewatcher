/** 净值点日期守卫：盘前不得记录（会覆盖上一交易日收盘） */
import test from 'node:test'
import assert from 'node:assert/strict'
import { equityRecordAllowed } from './prismRoutes.ts'

test('① 09:29 之前一律不记录', () => {
  for (const t of ['08:00', '09:00', '09:29']) assert.equal(equityRecordAllowed(t), false, t)
})

test('② 09:30 起（含午休/收盘后）允许记录', () => {
  for (const t of ['09:30', '11:30', '13:00', '15:00']) assert.equal(equityRecordAllowed(t), true, t)
})

test('③ 裁剪上下文缺价必须传 null（不得拿成本冒充现价）', async () => {
  const { readFileSync } = await import('node:fs')
  const r = readFileSync(new URL('./prismRoutes.ts', import.meta.url), 'utf8')
  assert.match(r, /price: quotes\[p\.secid\]\?\.price \?\? null/)
})
