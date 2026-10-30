/** 轮询降频（AUDIT-BACKOFF）：护盘 60s、盘后/午休停、熔断跳过纯东财、去重。 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { RESCUE_DEFAULT_SEC, clampRescueSec, dedupeSecids, pollableSecids, shouldPollQuotes, shouldPollRescue } from './pollGate.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const read = (p: string): string => readFileSync(join(HERE, '..', p), 'utf8')
/** 北京时间 → epoch（UTC+8） */
const bj = (h: number, m: number, dow = 1): number => Date.UTC(2026, 9, 26 + ((dow - 1 + 7) % 7), h - 8, m)

test('① 护盘默认 300s，范围 [30,600]（60s ⇒ 败）', () => {
  assert.equal(RESCUE_DEFAULT_SEC, 300)
  assert.equal(clampRescueSec(15), 30)
  assert.equal(clampRescueSec(900), 600)
  assert.equal(clampRescueSec('x'), 300)
  const model = read('shared/model.ts')
  assert.ok(/intervalSec: 300/.test(model), 'DEFAULT_PREFS 护盘间隔必须 300（5 分钟）')
  // 反例注入：默认改回 15 ⇒ 必败
  assert.throws(() => assert.equal(15, RESCUE_DEFAULT_SEC, '反例上：15s'), /反例上/, '⚠ 反例注入必须失败')
})

test('② 盘后/非交易日 ⇒ 护盘与行情都不轮询（仍请求 ⇒ 败）', () => {
  assert.equal(shouldPollRescue(bj(15, 5)), false)
  assert.equal(shouldPollQuotes(bj(15, 5)), false)
  assert.equal(shouldPollRescue(bj(10, 0, 6)), false)
  assert.equal(shouldPollQuotes(bj(10, 0, 7)), false)
  // 反例注入：盘后仍轮询 ⇒ 必败
  assert.throws(() => assert.equal(shouldPollRescue(bj(16, 0)), true, '反例上：盘后还在轮询'), /反例上/, '⚠ 反例注入必须失败')
})

test('③ 熔断 open ⇒ 纯东财标的请求数 0，有备用源仍请求', () => {
  const ids = ['113.600519', '101.CL', '118.X', '1.000001', '0.300750']
  const fallback = (s: string): boolean => s === '1.000001' || s === '0.300750'
  const open = pollableSecids(ids, { open: true }, fallback)
  assert.deepEqual(open, ['1.000001', '0.300750'])
  assert.equal(pollableSecids(ids, { open: false }, fallback).length, ids.length)
  // 反例注入：熔断开还全发 ⇒ 必败
  assert.throws(() => assert.equal(open.length, ids.length, '反例上：全发'), /反例上/, '⚠ 反例注入必须失败')
})

test('④ 同一 secid 一轮只请求一次（重复 ⇒ 败）', () => {
  assert.deepEqual(dedupeSecids(['1.000001', '1.000001', '0.300750', ' 0.300750 ']), ['1.000001', '0.300750'])
  // 反例注入：不去重 ⇒ 必败
  assert.throws(() => assert.equal(['a', 'a'].length, 1, '反例上：重复'), /反例上/, '⚠ 反例注入必须失败')
})

test('⑤ 午休 11:30–13:00 行情请求数 0（照发 ⇒ 败）', () => {
  assert.equal(shouldPollQuotes(bj(11, 31)), false)
  assert.equal(shouldPollQuotes(bj(12, 30)), false)
  assert.equal(shouldPollQuotes(bj(13, 1)), true)
  assert.equal(shouldPollQuotes(bj(11, 30)), true, '11:30 整点仍算上午收盘瞬间')
  // 反例注入：午休照发 ⇒ 必败
  assert.throws(() => assert.equal(shouldPollQuotes(bj(12, 0)), true, '反例上：午休在轮询'), /反例上/, '⚠ 反例注入必须失败')
})

test('⑥ 熔断关闭后下一周期恢复轮询（不恢复 ⇒ 败）', () => {
  const ids = ['113.600519', '1.000001']
  assert.deepEqual(pollableSecids(ids, { open: true }, () => false), [])
  assert.deepEqual(pollableSecids(ids, { open: false }, () => false), ids)
  // 反例注入：关闭后仍跳过 ⇒ 必败
  assert.throws(() => assert.equal(pollableSecids(ids, { open: false }, () => false).length, 0, '反例上：不恢复'), /反例上/, '⚠ 反例注入必须失败')
})

/* ── 边界补强（AUDIT-TESTS-1030）：钳位数值边界、去重归一、时段四端点 ── */

test('⑦ clampRescueSec 数值边界：NaN/±Infinity/字符串回默认 300，小数四舍五入后再钳（截断 ⇒ 败）', () => {
  assert.equal(clampRescueSec(30), 30, '下界本身保留')
  assert.equal(clampRescueSec(29.6), 30, '29.6 先四舍五入到 30，再保留下界')
  assert.equal(clampRescueSec(600), 600)
  assert.equal(clampRescueSec(600.4), 600)
  assert.equal(clampRescueSec(NaN), 300, 'NaN ⇒ 默认')
  assert.equal(clampRescueSec(Number.POSITIVE_INFINITY), 300, 'Infinity ⇒ 默认（不是 600）')
  assert.equal(clampRescueSec(Number.NEGATIVE_INFINITY), 300)
  assert.equal(clampRescueSec(null), 300)
  assert.equal(clampRescueSec(undefined), 300)
  assert.equal(clampRescueSec({}), 300)
  assert.equal(clampRescueSec(-5), 30, '负数先被下界兜住')
  // 反例注入：把 Number.isFinite 去掉 ⇒ Infinity 会被 Math.min(600, Infinity) 钳成 600（一个"看起来合法"的值）
  assert.equal(Math.min(600, Math.max(30, Math.round(Number.POSITIVE_INFINITY))), 600)
  assert.throws(() => assert.equal(Math.min(600, Math.max(30, Math.round(Number.POSITIVE_INFINITY))), 300, '反例上：Infinity 未拦'), /反例上/, '⚠ 反例注入必须失败')
})

test('⑧ 时段四端点：09:30 开、11:30 仍在（收盘瞬间）、11:31 停、13:00 开、15:00 停（差一分钟 ⇒ 败）', () => {
  assert.equal(shouldPollQuotes(bj(9, 30)), true, '09:30 开盘即轮询')
  assert.equal(shouldPollQuotes(bj(9, 29)), false, '09:29 未开盘')
  assert.equal(shouldPollQuotes(bj(11, 30)), true, '11:30 当分钟仍算（收盘瞬间）')
  assert.equal(shouldPollQuotes(bj(11, 31)), false, '11:31 已休市')
  assert.equal(shouldPollQuotes(bj(12, 59)), false, '午后开盘前不轮询')
  assert.equal(shouldPollQuotes(bj(13, 0)), true, '13:00 开盘即轮询')
  assert.equal(shouldPollQuotes(bj(14, 59)), true, '14:59 仍在盘中')
  assert.equal(shouldPollQuotes(bj(15, 0)), false, '15:00 收盘即停')
  assert.equal(shouldPollRescue(bj(15, 0)), false, '护盘 15:00 也停（m < 900）')
  assert.equal(shouldPollRescue(bj(9, 15)), true, '护盘 09:15 起（含集合竞价）')
  assert.equal(shouldPollRescue(bj(9, 14)), false, '护盘 09:14 不起')
  // 反例注入：把 15:00 的 afterClose 判据漏掉 ⇒ 收盘瞬间会照发一轮
  assert.throws(() => assert.equal(shouldPollQuotes(bj(15, 0)), true, '反例上：收盘仍轮询'), /反例上/, '⚠ 反例注入必须失败')
})

test('⑨ dedupeSecids：空白/大小写/空串归一后去重，且**保持首次出现顺序**（打乱顺序 ⇒ 败）', () => {
  assert.deepEqual(dedupeSecids(['1.510300', ' 1.510300 ', '1.510300']), ['1.510300'], '空白与重复只留一个')
  assert.deepEqual(dedupeSecids(['b', 'a', 'b']), ['b', 'a'], '保持首次出现顺序，且**不改写大小写**')
  assert.deepEqual(dedupeSecids(['', '  ', 'a']), ['a'], '空串/纯空白直接丢弃')
  assert.deepEqual(dedupeSecids([]), [])
  // v0.183.0：只对 A 股数字码做大小写归一；字母市场的代码原样保留
  assert.equal(dedupeSecids(['sh600000'])[0], 'sh600000', 'A 股码保持首次出现的原始串（不再 toUpperCase）')
  assert.deepEqual(dedupeSecids(['usAAPL', 'usaapl']), ['usAAPL', 'usaapl'], '美股代码大小写有别 ⇒ 不许合并')
  // 反例注入：用 sort 替代"首次出现顺序" ⇒ 顺序会被打乱
  const sorted = [...new Set(['b', 'a'])].sort()
  assert.notDeepEqual(sorted, dedupeSecids(['b', 'a']))
  assert.throws(() => assert.deepEqual(sorted, dedupeSecids(['b', 'a']), '反例上：按字典序'), /反例上/, '⚠ 反例注入必须失败')
})
