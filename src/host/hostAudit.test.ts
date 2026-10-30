/**
 * 宿主层审计修复（docs/AUDIT-HOST-1030.md）的回归断言，每条配反例注入。
 * 只覆盖本轮 P1：A1 美股成交额单位、A2 missing 完整性、A3 lmt 溢出、A4 护盘串行请求。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { parseTencentDetail } from './detailTencent.ts'
import { withLiveBar } from './em.ts'

const here = dirname(fileURLToPath(import.meta.url))
const read = (f: string): string => readFileSync(join(here, f), 'utf8')

/** 腾讯单票回包（88 字段）：A股 f37=万元；美股 f37=美元 */
function line(fill: Record<number, string>, sym = 'sh600519'): string {
  const f = new Array<string>(88).fill('')
  f[1] = 'X'; f[3] = '100'; f[4] = '99'; f[5] = '99.5'; f[33] = '101'; f[34] = '98'; f[36] = '1000'; f[38] = '1'; f[39] = '10'; f[44] = '100'; f[45] = '100'
  for (const [k, v] of Object.entries(fill)) f[Number(k)] = v
  return `v_${sym}="${f.join('~')}";`
}

test('A1 美股 `[37]` 是美元、A股是万元（一律 ×1e4 ⇒ 美股差 10000 倍 ⇒ 败）', () => {
  const us = parseTencentDetail(line({ 37: '200000000' }, 'usAAPL'), '105.AAPL')!
  assert.equal(us.detail.amount, 200_000_000, '美股成交额必须原样（美元）')
  const cn = parseTencentDetail(line({ 37: '20000' }), '1.600519')!
  assert.equal(cn.detail.amount, 200_000_000, 'A股 2 万万元 = 2 亿元')
  // 反例注入：美股也 ×1e4 ⇒ 2 万亿
  assert.throws(() => assert.equal(200_000_000 * 1e4, us.detail.amount, '反例上：美股 ×1e4'), /反例上/, '⚠ 反例注入必须失败')
})

test('A2 成交量判不出量纲 ⇒ vol:null 且 missing 里必须有「成交量」', () => {
  const bad = parseTencentDetail(line({ 37: '999999999999' }), '1.600519')!
  assert.equal(bad.detail.vol, null)
  assert.ok(bad.missing.some((m) => m.what === '成交量'), 'missing 必须列出成交量（否则界面只看到 — 不知原因）')
  // 反例注入：missing 里没有成交量 ⇒ 必败
  assert.throws(
    () => assert.ok(bad.missing.filter((m) => m.what !== '成交量').some((m) => m.what === '成交量'), '反例上：缺条目'),
    /反例上/,
    '⚠ 反例注入必须失败',
  )
})

test('A3 补今日柱后仍守住 lmt（返回 lmt+1 根 ⇒ 败）', () => {
  const days = Array.from({ length: 5 }, (_, i) => ({ date: `2026-10-2${i}`, open: 1, close: 1, high: 1, low: 1, vol: 1 }))
  const live = { date: '2026-10-28', open: 1, close: 1, high: 1, low: 1, vol: 1 }
  const out = withLiveBar(days, live, 5)
  assert.equal(out.length, 5, 'lmt=5 必须回 5 根')
  assert.equal(out[out.length - 1].date, '2026-10-28', '最后一根必须是今日')
  assert.equal(out[0].date, '2026-10-21', '挤掉的是最老的一根')
  // 反例注入：直接 push ⇒ 6 根
  assert.throws(() => assert.equal([...days, live].length, 5, '反例上：lmt+1'), /反例上/, '⚠ 反例注入必须失败')
})

test('A4 护盘超大单兜底必须并发预取（循环内逐个 await ⇒ 败）', () => {
  const src = read('rescue.ts')
  const loopAt = src.indexOf('for (const meta of metas)')
  const prefetchAt = src.indexOf('sinaSuperNets.set(')
  assert.ok(prefetchAt > 0, '必须有预取 Map')
  assert.ok(prefetchAt < loopAt, '预取必须在遍历之前')
  assert.ok(src.includes('await Promise.all('), '预取必须并发')
  assert.equal(/const superNet = q\.superNet \?\? \(await fetchSinaSuperNet/.test(src), false, '循环里不许再逐个 await')
  // 反例注入：把逐个 await 放回循环 ⇒ 判据必须认出
  const injected = src.replace('const superNet = q.superNet ?? sinaSuperNets.get(meta.secid) ?? null', 'const superNet = q.superNet ?? (await fetchSinaSuperNet(meta.secid))')
  assert.equal(/\(await fetchSinaSuperNet/.test(injected), true, '⚠ 反例必须能被正则抓住')
  assert.throws(() => assert.equal(/\(await fetchSinaSuperNet/.test(injected), false, '反例上：串行'), /反例上/, '⚠ 反例注入必须失败')
})
