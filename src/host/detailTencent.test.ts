/**
 * 详情头腾讯兜底（v0.178.0）：① 10 项至少 8 项非空 ② 手→股 ×100 ③ 东财优先且不请求腾讯
 * ④ 东财失败 ⇒ source=tencent ⑤ 行业缺失 ⇒ `—` + 原因。每条都配反例注入（必败）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { detailWithFallback, parseTencentDetail } from './detailTencent.ts'

/** 造一行腾讯单票回包（49 字段，只填用到的下标） */
function qtLine(over: Partial<Record<number, string>> = {}): string {
  const f = new Array<string>(49).fill('')
  f[1] = '贵州茅台'
  f[3] = '1331.45'
  f[4] = '1355.90'
  f[5] = '1330.00'
  f[31] = '-24.45'
  f[32] = '-1.80'
  f[33] = '1340.00'
  f[34] = '1320.10'
  f[36] = '22012' // 手
  f[37] = '295109' // 万元
  f[38] = '0.18' // 换手率 %
  f[39] = '20.44' // PE
  f[44] = '16644.21' // 流通市值 亿
  f[45] = '16644.21' // 总市值 亿
  f[46] = '6.62' // PB
  for (const [k, v] of Object.entries(over)) f[Number(k)] = v as string
  return `v_sh600519="${f.join('~')}";`
}

test('① 腾讯回包解析：10 项里至少 8 项非空（少于 8 ⇒ 败）', () => {
  const r = parseTencentDetail(qtLine(), '1.600519')
  assert.ok(r !== null)
  const d = r.detail
  const ten = [d.name, d.open, d.prev, d.high, d.low, d.vol, d.amount, d.turnover, d.pe, d.totalMv]
  const filled = ten.filter((v) => (typeof v === 'number' ? Number.isFinite(v) && v > 0 : typeof v === 'string' && v.trim() !== ''))
  assert.ok(filled.length >= 8, `至少 8 项非空（实际 ${filled.length}）`)
  assert.equal(d.name, '贵州茅台')
  assert.equal(d.open, 1330)
  assert.equal(d.prev, 1355.9)
  assert.equal(d.high, 1340)
  assert.equal(d.low, 1320.1)
  // 反例注入：把 4 项抹空 ⇒ 必小于 8
  const few = parseTencentDetail(qtLine({ 5: '', 33: '', 34: '', 39: '' }), '1.600519')!
  const fewFilled = [few.detail.name, few.detail.open, few.detail.prev, few.detail.high, few.detail.low, few.detail.vol, few.detail.amount, few.detail.turnover, few.detail.pe, few.detail.totalMv]
    .filter((v) => (typeof v === 'number' ? Number.isFinite(v) && v > 0 : typeof v === 'string' && v.trim() !== ''))
  assert.throws(() => assert.ok(fewFilled.length >= 8, `反例上：只填了 ${fewFilled.length} 项`), /反例上/, '⚠ 反例注入必须失败')
})

test('② 成交量 手 → 股（×100）；成交额 万元 → 元（漏乘 ⇒ 差 100/10000 倍 ⇒ 败）', () => {
  const d = parseTencentDetail(qtLine(), '1.600519')!.detail
  assert.equal(d.vol, 22012 * 100, '成交量必须是股（2,201,200）')
  assert.equal(d.amount, 295109 * 1e4, '成交额必须是元（2,951,090,000）')
  assert.equal(d.totalMv, 16644.21 * 1e8, '总市值必须是元（亿元 ×1e8）')
  assert.notEqual(d.vol, 22012, '漏乘 100 就退化成手')
  assert.throws(() => assert.equal(d.vol, 22012, '反例上：按手当股'), /反例上/, '⚠ 反例注入（漏乘 ×100）必须失败')
})

test('③ 东财可用 ⇒ source=eastmoney，且**不请求**腾讯（反向 ⇒ 败）', async () => {
  let tencentCalls = 0
  const emDetail = { secid: '1.600519', code: '600519', name: '贵州茅台', price: 1331, chg: -24, pct: -1.8, open: 1330, high: 1340, low: 1320, prev: 1355.9, vol: 2201200, amount: 2951090000, turnover: 0.18, volumeRatio: 1, pe: 20.4, pb: 6.6, totalMv: 1.66e12, floatMv: 1.66e12, up: null, down: null }
  const r = await detailWithFallback('1.600519', {
    eastmoney: async () => emDetail,
    tencent: async () => { tencentCalls += 1; return parseTencentDetail(qtLine(), '1.600519') },
  })
  assert.equal(r.source, 'eastmoney')
  assert.equal(r.detail, emDetail)
  assert.deepEqual(r.missing, [])
  assert.equal(tencentCalls, 0, '东财可用时一条腾讯请求都不许发')
  assert.throws(() => assert.equal(tencentCalls, 1, '反例上：东财已成功仍打腾讯'), /反例上/, '⚠ 反例注入必须失败')
})

test('④ 东财失败 ⇒ source=tencent 且详情非空（仍返回 null ⇒ 败）', async () => {
  let tried = 0
  const r = await detailWithFallback('1.600519', {
    eastmoney: async () => { throw new Error('push2 down') },
    tencent: async () => { tried += 1; return parseTencentDetail(qtLine(), '1.600519') },
  })
  assert.equal(tried, 1)
  assert.equal(r.source, 'tencent')
  assert.ok(r.detail !== null, '兜底成功时 detail 必须非空（否则抽屉又显示"详情暂不可用"）')
  assert.equal(r.detail?.name, '贵州茅台')
  assert.ok(r.missing.length >= 1, '仍缺的字段要列出来（量比/涨跌家数）')
  // 反例注入：兜底也失败 ⇒ detail 必须为 null（此时才允许显示"详情暂不可用"）
  const none = await detailWithFallback('1.600519', { eastmoney: async () => null, tencent: async () => { throw new Error('qt down') } })
  assert.equal(none.detail, null)
  assert.equal(none.source, null)
  assert.throws(() => assert.equal(none.detail !== null, true, '反例上：两边都挂还说详情可用'), /反例上/, '⚠ 反例注入必须失败')
})

/* ── 边界补强（AUDIT-TESTS-1030）：美股成交额单位、量纲判不出、解析失败 ── */

test('⑤ 美股 [37] 是**美元**不乘 1e4（一律 ×1e4 ⇒ 差 10000 倍 ⇒ 败）', () => {
  const line = qtLine().replace('v_sh600519', 'v_usAAPL')
  const us = parseTencentDetail(line, '105.AAPL')
  const cn = parseTencentDetail(qtLine(), '1.600519')
  assert.ok(us !== null && cn !== null)
  assert.equal(cn.detail.amount, 295_109 * 1e4, 'A股 [37] 万元 → 元（×1e4）')
  assert.equal(us.detail.amount, 295_109, '美股 [37] 已是美元 ⇒ 原值')
  assert.equal(cn.detail.amount! / us.detail.amount!, 10_000, '两条分支必须正好差 10000 倍')
  // 反例注入：给美股也乘 1e4 ⇒ 详情头成交额放大一万倍
  const wrong = Math.round(us.detail.amount! * 1e4)
  assert.notEqual(wrong, us.detail.amount)
  assert.throws(() => assert.equal(wrong, us.detail.amount, '反例上：美股也 ×1e4'), /反例上/, '⚠ 反例注入必须失败')
})

test('⑥ 量纲判不出 ⇒ vol:null + missing 里有「成交量」（写 0 或写 100 倍值 ⇒ 败）', () => {
  // [36] 与 [37] 差 450 倍：既不是股也不是手 ⇒ 不猜
  const r = parseTencentDetail(qtLine({ 36: '999999999' }), '1.600519')
  assert.ok(r !== null)
  assert.equal(r.detail.vol, null, '量纲不自洽时必须 null')
  assert.ok(r.missing.some((m) => m.what === '成交量'), 'missing 必须点名「成交量」')
  const note = r.missing.find((m) => m.what === '成交量')!
  assert.match(note.note ?? '', /量纲|100 倍/, '原因要说清是量纲判不出')
  // 反例注入：按「手」硬算 ⇒ 得 999 亿股，与成交额明显矛盾
  const hardValue = 999_999_999 * 100
  assert.throws(() => assert.equal(hardValue, r.detail.vol, '反例上：按手硬算'), /反例上/, '⚠ 反例注入必须失败')
})

test('⑦ 解析失败：无匹配 / 现价为空 ⇒ null（返回半条空壳 ⇒ 败）', () => {
  assert.equal(parseTencentDetail('', '1.600519'), null, '空包必须 null')
  assert.equal(parseTencentDetail('garbage~garbage', '1.600519'), null, '无 v_ 前缀必须 null')
  assert.equal(parseTencentDetail(qtLine({ 3: '' }), '1.600519'), null, '现价为空 ⇒ null（不得拿 0 顶）')
  assert.equal(parseTencentDetail(qtLine({ 3: 'abc' }), '1.600519'), null, '现价非数 ⇒ null')
  // 现价真的是 0（停牌）也走 null 分支：宁可整条不兜底，也不要 0 价
  assert.equal(parseTencentDetail(qtLine({ 3: '0' }), '1.600519')?.detail.price, 0, '0 价能解析（调用方另行判停牌）')
  // 反例注入：把 `price === null` 的闸门去掉 ⇒ 半条空壳会被当成有效详情
  assert.throws(() => assert.notEqual(parseTencentDetail(qtLine({ 3: '' }), '1.600519'), null, '反例上：空现价放行'), /反例上/, '⚠ 反例注入必须失败')
})
