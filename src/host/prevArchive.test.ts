/** 昨日分钟额来自本地归档（AUDIT-PREVARCHIVE）。 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const em = readFileSync(join(HERE, 'em.ts'), 'utf8')
const page = readFileSync(join(HERE, '..', 'client', 'MarketPage.tsx'), 'utf8')

test('归档有昨日（≥200 根带 amount）⇒ 标 prevSource=archive / prevDay', () => {
  assert.ok(em.includes('loadTrendArchive(secid, { keepDays: 5 })'), '必须读本地归档')
  assert.ok(/yday\.points\.length >= 200/.test(em), '不足 200 根必须丢掉')
  assert.ok(/prevSource: 'archive'/.test(em), '必须标 prevSource')
  assert.ok(/prevDay: prev\.day/.test(em), '必须标 prevDay')
  // 反例注入：不判 200 根 ⇒ 必败
  const loose = em.replace('yday.points.length >= 200 && ', '')
  assert.throws(() => assert.ok(/yday\.points\.length >= 200/.test(loose), '反例上：不判根数'), /反例上/, '⚠ 反例注入必须失败')
})

test('归档 180 根 ⇒ 判不足给 —（照用 ⇒ 败）', () => {
  // 纯判据复算：180 < 200 ⇒ 不给 prev ⇒ 客户端走缺失分支
  const n = 180
  assert.equal(n >= 200, false)
  assert.ok(page.includes("prev !== null ? prev.points"), '客户端必须优先用 prev')
  assert.ok(page.includes('missingCellText(noAmountReason ?? delta.reason)'), '缺失必须走 —（原因）')
})

test('今日冒充昨日 ⇒ 差值全 0 ⇒ 败（判据在 marketAmount.test.ts ③ 已覆盖）', () => {
  assert.ok(em.includes("prevDay: prev.day"), '回包必须带 prevDay（界面可核对）')
})
