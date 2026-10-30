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

/* ── 边界补强（AUDIT-TESTS-1030）：负数/科学计数、除零、代码边界 ── */

test('⑦ 解析边界：负号 / 科学计数 / 缺一字段 ⇒ null（用 0 顶替 ⇒ 败）', () => {
  // 负值：新浪在净流出时可能给负号；正则只收 [0-9.] ⇒ 判不出就 null，不猜
  assert.equal(parseSinaSuperNet('"r0_in":"-5","r0_out":"10"'), null, '负号字段不得解析成一个数')
  // 科学计数法（1e3）同样不匹配 ⇒ null
  assert.equal(parseSinaSuperNet('"r0_in":"1e3","r0_out":"10"'), null, '科学计数不得被 Number() 撞对')
  // 只有一半字段
  assert.equal(parseSinaSuperNet('"r0_in":"100"'), null, '缺 r0_out ⇒ null')
  assert.equal(parseSinaSuperNet('"r0_out":"100"'), null, '缺 r0_in ⇒ null')
  assert.equal(parseSinaSuperNet(''), null, '空串 ⇒ null')
  // 正常值仍然要能解析（证明上面对 null 的断言不是恒真）
  assert.equal(parseSinaSuperNet('"r0_in":"120","r0_out":"20"'), 100)
  // 反例注入：把 null 改成 0 顶替 ⇒ 与「真的净额为 0」无法区分
  const substituted: number | null = null
  assert.throws(() => assert.equal((substituted ?? 0), null, '反例上：缺数据写 0'), /反例上/, '⚠ 反例注入必须失败')
})

test('⑧ 占成交额：成交额 0/负/缺失 ⇒ null；净额真为 0 且成交额 >0 ⇒ 0（两件事必须分开）', () => {
  assert.equal(superShareOf(100, 0), null, '成交额 0 不得做除数')
  assert.equal(superShareOf(100, -1), null, '负成交额不得做除数')
  assert.equal(superShareOf(100, null), null)
  assert.equal(superShareOf(null, 1000), null)
  assert.equal(superShareOf(0, 1000), 0, '净额真为 0 时必须给 0（不是 null）')
  assert.notEqual(superShareOf(0, 1000), superShareOf(100, 0), '「净额为 0」与「成交额为 0」必须可区分')
  // 反例注入：把 `amount > 0` 放宽成 `amount >= 0` ⇒ 0 做除数得 Infinity/NaN
  const bad = 100 / 0
  assert.ok(!Number.isFinite(bad), '除零会得到 Infinity —— 正是必须拦掉的原因')
  assert.throws(() => assert.ok(Number.isFinite(bad), '反例上：除零放行'), /反例上/, '⚠ 反例注入必须失败')
})

test('⑨ 代码映射边界：只有 `0.`/`1.` + 6 位数字才算沪深（多一位/少一位/别的前缀 ⇒ null）', () => {
  assert.equal(sinaSymbolOf('1.510300'), 'sh510300')
  assert.equal(sinaSymbolOf('0.159915'), 'sz159915')
  assert.equal(sinaSymbolOf('2.510300'), null, '市场号只有 0/1')
  assert.equal(sinaSymbolOf('1.51030'), null, '5 位数字不算')
  assert.equal(sinaSymbolOf('1.5103000'), null, '7 位数字不算')
  assert.equal(sinaSymbolOf('sh510300'), null, '非 secid 形式')
  assert.equal(sinaSymbolOf(' 1.510300'), null, '带空格不得被 trim 后放行（保持严格）')
  // 反例注入：把 `^...$` 去掉（改成 test 而非 exec 全匹配）⇒ 7 位数字会被接受
  const loose = /([01])\.(\d{6})/.test('1.5103000')
  assert.equal(loose, true, '反例：非全匹配的正则确实会放过 7 位')
  assert.throws(() => assert.equal(sinaSymbolOf('1.5103000'), 'sh5103000', '反例上：7 位被接受'), /反例上/, '⚠ 反例注入必须失败')
})
