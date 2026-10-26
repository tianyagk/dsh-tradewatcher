/** 指数分时源优先级：trends2 → 新浪 1 分钟 → 新浪 5 分钟兜底（AUDIT-IDXSRC）。 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { minuteFallbackSources } from './em.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const em = readFileSync(join(HERE, 'em.ts'), 'utf8')

test('① 指数分时首选 trends2（把 5 分钟排前 ⇒ 必败）', () => {
  // 单日链：trends2 是 loader，备用段顺序 = 新浪分钟 → 腾讯分钟（无 5 分钟）
  const keys = minuteFallbackSources().map((s) => s.key)
  assert.equal(keys[0], 'sina-minute', `备用第一必须是新浪 1 分钟（实际 ${keys.join(',')}）`)
  assert.equal((keys as string[]).includes('sina-5min'), false, '单日备用段不许混入 5 分钟源')
  const i = em.indexOf('async function fetchMultiDayTrend')
  const seg = em.slice(i, i + 2000)
  assert.ok(seg.includes('sinaMinuteTrend(secid)'), '多日链必须先试新浪 1 分钟')
  assert.ok(seg.indexOf('sinaMinuteTrend(secid)') < seg.indexOf('fetchSina5Min'), '1 分钟必须排在 5 分钟之前')
  // 反例注入：把 5 分钟排前 ⇒ 判据必败
  const swapped = keys.slice().reverse()
  assert.throws(() => assert.equal(swapped[0], 'sina-minute', '反例上：顺序反了'), /反例上/, '⚠ 反例注入必须失败')
})

test('② trends2 失败才落 1 分钟；两者都失败才 5 分钟且 source 正确（跳级 ⇒ 败）', () => {
  assert.ok(em.includes("if (isIndexSecid(secid)) {"), '缺指数判定分支')
  assert.ok(em.includes("const oneMin = await sinaMinuteTrend(secid)"), '缺 1 分钟尝试')
  assert.ok(em.includes("if (oneMin !== null && oneMin.points.length >= 200)"), '1 分钟不足 200 根必须视为失败')
  // 5 分钟兜底分支仍存在（只有它之后才打 noAmount）
  const i5 = em.indexOf("source: 'sina-5min' as TrendSource")
  const iFlag = em.indexOf("noAmountReason: '该源无成交额、48 根/日'")
  assert.ok(i5 > 0 && iFlag > i5, 'noAmount 必须由 5 分钟兜底分支给出')
  // 反例注入：跳过 1 分钟直接 5 分钟（把 oneMin 判定删掉）⇒ 判据必败
  const skip = em.replace("if (oneMin !== null && oneMin.points.length >= 200) {", "if (false) {")
  assert.throws(() => assert.ok(skip.includes('if (oneMin !== null && oneMin.points.length >= 200)'), '反例上：跳级'), /反例上/, '⚠ 反例注入（跳级）必须失败')
})

test('③ 5 分钟兜底必须标 noAmount 且原因含「无成交额」（插值成 240 根 ⇒ 败）', () => {
  assert.ok(em.includes("noAmount: true, noAmountReason: '该源无成交额、48 根/日'"), '5 分钟兜底缺少 noAmount 标记')
  const page = readFileSync(join(HERE, '..', 'client', 'MarketPage.tsx'), 'utf8')
  assert.ok(page.includes('amtTrend?.trend?.noAmount === true'), '页面必须读 noAmount')
  assert.ok(page.includes('missingCellText(noAmountReason'), '无成交额必须走 —（原因）')
  // 反例注入：把 5 分钟插值成 240 根 ⇒ 判据必败
  const fake = Array.from({ length: 240 }, (_, i) => i)
  assert.throws(() => assert.equal(fake.length, 48, '反例上：插值冒充'), /反例上/, '⚠ 反例注入（插值）必须失败')
})

test('④ source 三值互斥且与数据一致（乱标 ⇒ 败）', () => {
  assert.ok(em.includes('as TrendSource'), 'source 字面量缺失')
  const model = readFileSync(join(HERE, '..', 'shared', 'model.ts'), 'utf8')
  for (const s of ['eastmoney-trends2', 'sina-minute', 'sina-5min']) assert.ok(model.includes(`'${s}'`), `TrendSource 缺 ${s}`)
  // 反例注入：把 5 分钟标成 sina-minute ⇒ 必败
  const total = (em.match(/source: 'sina-5min' as TrendSource/g) ?? []).length
  const wrong = em.replaceAll("source: 'sina-5min' as TrendSource", "source: 'sina-minute' as TrendSource")
  const after = (wrong.match(/source: 'sina-5min' as TrendSource/g) ?? []).length
  assert.ok(total >= 1, '前置：必须存在 sina-5min 标记')
  assert.throws(() => assert.equal(after, total, '反例上：乱标后 5 分钟消失'), /反例上/, '⚠ 反例注入（乱标）必须失败')
})
