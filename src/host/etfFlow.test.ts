/** 六张 ETF 卡的「量比 / 超大单净额 / 占成交额」+ 护盘 5 分钟（v0.181.0） */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseSinaSuperNet, sinaSymbolOf, superShareOf } from './etfFlow.ts'
import { parseTencentQuoteText } from './tencent.ts'
import { RESCUE_DEFAULT_SEC, RESCUE_MAX_SEC, RESCUE_MIN_SEC, shouldPollRescue } from '../shared/pollGate.ts'

const ETFS: Array<[string, string]> = [
  ['1.510300', 'sh510300'], ['1.510050', 'sh510050'], ['1.510500', 'sh510500'],
  ['1.512100', 'sh512100'], ['1.588000', 'sh588000'], ['0.159915', 'sz159915'],
]

/** 造腾讯单票回包（88 字段，f49=量比） */
function qtLine(code: string, f49: string): string {
  const f = new Array<string>(88).fill('')
  f[1] = code.toUpperCase(); f[3] = '4.145'; f[4] = '4.12'; f[5] = '4.13'; f[6] = '1000'
  f[45] = '1503.16'; f[47] = '4.535'; f[48] = '3.711'; f[49] = f49
  return `v_${code}="${f.join('~')}";`
}

test('① 六张卡的「量比」非空（全部 — ⇒ 败）', () => {
  const text = ETFS.map(([, sym], i) => qtLine(sym, (0.44 + i * 0.1).toFixed(2))).join('\n')
  const rows = parseTencentQuoteText(text, (code) => code)
  const vals = ETFS.map(([, sym]) => rows[sym]?.volumeRatio ?? null)
  assert.equal(vals.every((v) => v !== null && v > 0), true, `六只都必须有量比（实际 ${JSON.stringify(vals)}）`)
  // 反例注入：把 f49 清空 ⇒ 全部 null ⇒ 必败
  const empty = ETFS.map(([, sym]) => qtLine(sym, '')).join('\n')
  const rows2 = parseTencentQuoteText(empty, (code) => code)
  const vals2 = ETFS.map(([, sym]) => rows2[sym]?.volumeRatio ?? null)
  assert.throws(() => assert.equal(vals2.every((v) => v !== null), true, '反例上：全空'), /反例上/, '⚠ 反例注入（无量比）必须失败')
})

test('② 超大单净额与占成交额同源一致（≠ 净额/成交额 ⇒ 败）', () => {
  const amount = 3_630_000_000
  const net = parseSinaSuperNet('{"r0_in":"1482694931.8750","r0_out":"1420983517.6780"}')
  assert.ok(net !== null)
  assert.equal(Math.round(net), 61_711_414)
  const share = superShareOf(net, amount)
  assert.ok(share !== null)
  assert.equal(share, net / amount, '占成交额必须严格等于 净额/成交额')
  assert.ok(Math.abs(share - 0.017) < 0.002, `实测约 1.7%（实际 ${(share * 100).toFixed(2)}%）`)
  // 反例注入：用 netamount（全部单）冒充超大单 ⇒ 数值不同 ⇒ 必败
  const allNet = 64_391_121.945
  assert.notEqual(allNet, net)
  assert.throws(() => assert.equal(allNet, net, '反例上：拿全部单净额当超大单'), /反例上/, '⚠ 反例注入必须失败')
})

test('③ 缺数据 ⇒ null（不是 0），占成交额两者缺一 ⇒ null', () => {
  assert.equal(parseSinaSuperNet('{"r0_in":"1"}'), null, '缺 r0_out ⇒ null')
  assert.equal(parseSinaSuperNet('<html>'), null)
  assert.equal(superShareOf(null, 100), null, '净额缺 ⇒ 不算占比')
  assert.equal(superShareOf(10, null), null, '成交额缺 ⇒ 不算占比')
  assert.equal(superShareOf(10, 0), null, '成交额 0 ⇒ 不算（除法无意义）')
  assert.notEqual(superShareOf(null, 100), 0, '缺失不许写 0')
  // 反例注入：把缺失写成 0 ⇒ 必败
  assert.throws(() => assert.equal(superShareOf(null, 100), 0, '反例上：0 顶替'), /反例上/, '⚠ 反例注入必须失败')
})

test('④ RESCUE_DEFAULT_SEC === 300，范围仍 [30,600]（60 ⇒ 败）', () => {
  assert.equal(RESCUE_DEFAULT_SEC, 300)
  assert.equal(RESCUE_MIN_SEC, 30)
  assert.equal(RESCUE_MAX_SEC, 600)
  assert.ok(RESCUE_DEFAULT_SEC >= RESCUE_MIN_SEC && RESCUE_DEFAULT_SEC <= RESCUE_MAX_SEC)
  assert.throws(() => assert.equal(RESCUE_DEFAULT_SEC, 60, '反例上：仍是 60s'), /反例上/, '⚠ 反例注入（60s）必须失败')
})

test('⑤ 盘后/非交易日 shouldPollRescue === false（照轮询 ⇒ 败）', () => {
  const at = (s: string): number => Date.parse(s)
  assert.equal(shouldPollRescue(at('2026-10-28T15:30:00+08:00')), false, '盘后不轮询')
  assert.equal(shouldPollRescue(at('2026-10-28T20:00:00+08:00')), false)
  assert.equal(shouldPollRescue(at('2026-10-24T10:00:00+08:00')), false, '周六不轮询')
  assert.equal(shouldPollRescue(at('2026-10-28T10:00:00+08:00')), true, '盘中才轮询')
  assert.throws(() => assert.equal(shouldPollRescue(at('2026-10-28T15:30:00+08:00')), true, '反例上：盘后照轮询'), /反例上/, '⚠ 反例注入必须失败')
})

test('⑥ 新浪代码映射（沪深只认 0/1 开头）', () => {
  assert.equal(sinaSymbolOf('1.510300'), 'sh510300')
  assert.equal(sinaSymbolOf('0.159915'), 'sz159915')
  assert.equal(sinaSymbolOf('116.00700'), null)
})
