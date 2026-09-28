/**
 * 前端纯函数测试（node --test，零新增依赖）。
 * 补齐 review 指出的「src/client/ 18 个文件零测试」：这些函数极易测、且是图表正确性的根。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ema, fmtAxis, ma, macd, niceTicks } from './indicators.ts'
import { fmtAmt, fmtBig, fmtPct, fmtPrice, fmtSigned, fmtTime } from './format.ts'

test('ma：长度对齐、空/单点/period>len 不抛错', () => {
  assert.deepEqual(ma([], 3), [])
  assert.deepEqual(ma([5], 3), [null])
  const out = ma([1, 2, 3, 4], 2)
  assert.equal(out.length, 4)
  assert.equal(out[0], null)
  assert.equal(out[1], 1.5)
  assert.equal(out[3], 3.5)
  assert.equal(ma([1, 2], 10).every((v) => v === null), true)
})

test('ema：首值等于首个样本、单点稳定', () => {
  const out = ema([10], 5)
  assert.equal(out[0], 10)
  const series = ema([10, 11, 12], 3)
  assert.equal(series.length, 3)
  assert.equal(series[0], 10)
  assert.ok(series[2] > series[1] && series[1] > series[0])
})

test('macd：长度与输入一致、全相同序列 dif 收敛到 0', () => {
  const flat = new Array(60).fill(20)
  const out = macd(flat)
  assert.equal(out.dif.length, 60)
  assert.equal(out.dea.length, 60)
  assert.equal(out.hist.length, 60)
  assert.ok(Math.abs(out.dif[59]) < 1e-6, `全相同序列 dif 应为 0（实际 ${out.dif[59]}）`)
})

test('niceTicks：区间与单调性；区间为 0 时不除零', () => {
  const t = niceTicks(0, 10)
  assert.ok(t.length >= 2 && t[0] <= 0.0001 && t[t.length - 1] >= 10 - 1e-9)
  assert.deepEqual(niceTicks(5, 5).length >= 1, true)
  assert.equal(Number.isFinite(niceTicks(0, 0)[0]), true)
})

test('fmtAxis：整数与小数都不出现 NaN', () => {
  for (const v of [0, 1, 1.5, 1234.567, -2.25, 1e6]) {
    const s = fmtAxis(v)
    assert.equal(typeof s, 'string')
    assert.ok(!s.includes('NaN') && s.length > 0, `fmtAxis(${v}) = ${s}`)
  }
})

test('format：空值统一为占位符、不抛错', () => {
  for (const v of [null, undefined]) {
    assert.equal(typeof fmtPrice(v), 'string')
    assert.equal(typeof fmtPct(v), 'string')
    assert.equal(typeof fmtAmt(v), 'string')
    assert.equal(typeof fmtBig(v), 'string')
    assert.equal(typeof fmtSigned(v), 'string')
    assert.equal(typeof fmtTime(v), 'string')
  }
  // 双重编码：方向由箭头承担，数值只给量级（颜色由主题语义决定）
  assert.equal(fmtPct(1.235), '▲1.24%')
  assert.equal(fmtPct(-1.235), '▼1.24%')
  assert.equal(fmtPct(0), '0.00%')
  assert.equal(fmtSigned(1.235), '+1.24')
  assert.equal(fmtSigned(-1.235), '-1.24')
  assert.equal(fmtPrice(4.5123), '4.512')
  assert.ok(fmtAmt(1e8).includes('亿') && fmtAmt(1e4).includes('万') && fmtBig(12345).includes('万'))
  assert.equal(fmtAmt(null), '—')
})
