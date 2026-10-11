/**
 * 批量粘贴解析的断言（P2-9）：五种分隔符、缺列/多列/空行/重复行、非数字、两种日期格式、
 * 以及**与逐条手工录入的字段级等价**。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { BULK_OP_LABEL, bulkOpText, manualFieldsOf, parseBulk, parseDay, splitCells, tsOfDay } from './bulkPaste.ts'

const ROW = '1.600519|贵州茅台|2026-03-02|100|1500.5|'

test('五种分隔符等价：半角竖线 / 全角竖线 / 制表符 / 半角逗号 / 全角逗号', () => {
  const variants = [
    '1.600519|贵州茅台|2026-03-02|100|1500.5',
    '1.600519｜贵州茅台｜2026-03-02｜100｜1500.5',
    '1.600519\t贵州茅台\t2026-03-02\t100\t1500.5',
    '1.600519,贵州茅台,2026-03-02,100,1500.5',
    '1.600519，贵州茅台，2026-03-02，100，1500.5',
  ]
  const parsed = variants.map((v) => parseBulk(v))
  for (const p of parsed) {
    assert.equal(p.errors.length, 0, `应无报错：${JSON.stringify(p.errors)}`)
    assert.equal(p.rows.length, 1)
    assert.equal(p.rows[0].secid, '1.600519')
    assert.equal(p.rows[0].symbolName, '贵州茅台')
    assert.equal(p.rows[0].day, '2026-03-02')
    assert.equal(p.rows[0].qty, 100)
    assert.equal(p.rows[0].price, 1500.5)
  }
  // 五种写法解析出的字段必须**逐字相同**
  const strip = (r: { raw: string }): Record<string, unknown> => { const { raw: _r, ...rest } = r as Record<string, unknown>; void _r; return rest }
  for (const p of parsed.slice(1)) assert.deepEqual(strip(p.rows[0]), strip(parsed[0].rows[0]), '五种分隔符 ⇒ 除原文外逐字段相同')
})

test('与逐条手工录入字段级等价（同一组字段：secid/name/qty/price/ts/note）', () => {
  const r = parseBulk(ROW).rows[0]
  const manual = manualFieldsOf(r)
  assert.deepEqual(manual, {
    secid: '1.600519', name: '贵州茅台', qty: 100, price: 1500.5,
    ts: Date.parse('2026-03-02T15:00:00+08:00'), note: '',
  })
  assert.equal(r.ts, tsOfDay('2026-03-02'), '时间戳＝当日 15:00（与手工录入"当天收盘价"同口径）')
})

test('缺列 / 多列：逐行报错并**保留原文**，不静默丢弃', () => {
  const p = parseBulk(['1.600519|贵州茅台|2026-03-02|100', '1.600519|贵州茅台|2026-03-02|100|1500.5|备注|多出来的'].join('\n'))
  assert.equal(p.rows.length, 0)
  assert.equal(p.errors.length, 2)
  assert.ok(p.errors[0].message.includes('列数不足'), p.errors[0].message)
  assert.ok(p.errors[0].message.includes('实际 4 列'))
  assert.ok(p.errors[1].message.includes('列数过多'), p.errors[1].message)
  assert.equal(p.errors[0].raw, '1.600519|贵州茅台|2026-03-02|100', '原文必须保留（用户能复制回去改）')
  assert.equal(p.errors[0].line, 1)
})

test('空行跳过（不算错）、完全重复行报错、非数字报错', () => {
  const text = [ROW, '', ROW, '1.600519|贵州茅台|2026-03-02|abc|1500.5', '1.600519|贵州茅台|2026-03-02|100|xyz'].join('\n')
  const p = parseBulk(text)
  assert.equal(p.rows.length, 1, '只有第一行可用')
  assert.equal(p.errors.length, 3, `重复 1 + 数量 1 + 价格 1（实际 ${p.errors.length}）`)
  assert.ok(p.errors[0].message.includes('重复'), p.errors[0].message)
  assert.ok(p.errors[1].message.includes('数量'), p.errors[1].message)
  assert.ok(p.errors[2].message.includes('价格'), p.errors[2].message)
  assert.equal(p.errors[1].line, 4, '行号要对得上（空行也占一行）')
})

test('日期两种格式都可，非法日期报错', () => {
  assert.equal(parseDay('2026-03-02'), '2026-03-02')
  assert.equal(parseDay('2026/3/2'), '2026-03-02', '单位数也要归一到两位')
  assert.equal(parseDay('2026.03.02'), null)
  assert.equal(parseDay('2026-13-01'), null)
  const p = parseBulk('1.600519|贵州茅台|03/02/2026|100|1500.5')
  assert.equal(p.rows.length, 0)
  assert.ok(p.errors[0].message.includes('日期'))
})

test('建仓/买入/卖出标注与汇总一行', () => {
  const p = parseBulk([
    ROW,
    '0.300750|宁德时代|2026-03-02|200|180',
    '1.600519|贵州茅台|2026-03-03|50|1520.0|卖',
  ].join('\n'), { heldSecids: ['1.600519'] })
  assert.equal(p.rows[0].createsPosition, false, '已有持仓 ⇒ 普通买入')
  assert.equal(bulkOpText(p.rows[0]), '买入')
  assert.equal(p.rows[1].createsPosition, true, '本地没有该持仓 ⇒ 建仓')
  assert.equal(bulkOpText(p.rows[1]), '建仓（买入）')
  assert.equal(p.rows[2].op, 'sell')
  assert.equal(bulkOpText(p.rows[2]), '卖出')
  assert.equal(p.summary, '可写入 3 条 · 建仓 1 · 买入 1 · 卖出 1')
  // 卖出但本地没持仓 ⇒ 直接报错（托管侧必然失败，提前说清楚）
  const bad = parseBulk('0.300750|宁德时代|2026-03-02|200|180|卖')
  assert.equal(bad.rows.length, 0)
  assert.ok(bad.errors[0].message.includes('没有该持仓'), bad.errors[0].message)
  assert.equal(BULK_OP_LABEL.buy, '买入')
})

test('分隔符切列：连续分隔符**不合并**空列（合并会让列错位）', () => {
  assert.deepEqual(splitCells('a||b'), ['a', '', 'b'])
  assert.deepEqual(splitCells(' a ｜ b '), ['a', 'b'])
})
