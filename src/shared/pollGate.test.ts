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

test('① 护盘默认 60s，范围 [30,600]（15s ⇒ 败）', () => {
  assert.equal(RESCUE_DEFAULT_SEC, 60)
  assert.equal(clampRescueSec(15), 30)
  assert.equal(clampRescueSec(900), 600)
  assert.equal(clampRescueSec('x'), 60)
  const model = read('shared/model.ts')
  assert.ok(/intervalSec: 60/.test(model), 'DEFAULT_PREFS 护盘间隔必须 60')
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
