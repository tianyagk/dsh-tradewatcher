/**
 * 测试审查发现的 3 个生产缺陷（v0.183.0），每条都带反例注入：
 *   ① `batchesOf(size=0)` 死循环 ② `bucketIndexOf` ±10 边界方向 ③ `dedupeSecids` 强制大写。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { batchesOf, bucketIndexOf, nineBucketsOf, NINE_FROM_ELEVEN } from './breadthScan.ts'
import { dedupeSecids } from '../shared/pollGate.ts'

test('① size=0/-1/NaN/undefined 必须先抛 RangeError（返回空数组或死循环 ⇒ 败），且 1 秒内返回', () => {
  const t0 = Date.now()
  for (const bad of [0, -1, Number.NaN, undefined, 0.4, Number.POSITIVE_INFINITY]) {
    assert.throws(
      () => batchesOf(['a', 'b'], bad as number),
      (e: unknown) => e instanceof RangeError && (e as Error).message === 'batch size must be >= 1',
      `size=${String(bad)} 必须抛 RangeError('batch size must be >= 1')`,
    )
  }
  assert.equal(Date.now() - t0 < 1000, true, '必须 1 秒内返回（原实现会死循环）')
  assert.deepEqual(batchesOf(['a', 'b', 'c'], 1), [['a'], ['b'], ['c']], 'size=1 ⇒ 批数 = 长度')
  assert.deepEqual(batchesOf([], 0), [], '空数组 ⇒ [] （不进循环、不抛）')
  assert.deepEqual(batchesOf(['a', 'b', 'c'], 2.9), [['a', 'b'], ['c']], '小数向下取整')
  // 反例注入：size=0 的旧循环体（i += 0）在 1 秒内不可能自然结束 —— 用等价判据抓住"未校验"
  const unguarded = (n: number): boolean => !Number.isFinite(n) || n < 1
  assert.equal(unguarded(0), true)
  assert.throws(() => assert.equal(unguarded(0), false, '反例上：size=0 当合法'), /反例上/, '⚠ 反例注入（不校验 0）必须失败')
})

test('② bucketIndexOf 边界左闭右开：+10→>10、+9.99→7~10、−10→≤−10、−9.99→−10~−7（方向反 ⇒ 败）', () => {
  assert.equal(bucketIndexOf(10), 0, '+10.00 必须进「>10」')
  assert.equal(bucketIndexOf(9.99), 1, '+9.99 ⇒ 7~10')
  assert.equal(bucketIndexOf(7), 1, '+7.00 ⇒ 7~10（左闭）')
  assert.equal(bucketIndexOf(5), 2)
  assert.equal(bucketIndexOf(3), 3)
  assert.equal(bucketIndexOf(0.01), 4, '+0.01 ⇒ 0~3')
  assert.equal(bucketIndexOf(0), 5, '0.00 ⇒ 平盘')
  assert.equal(bucketIndexOf(-0.01), 6, '−0.01 ⇒ −3~0')
  assert.equal(bucketIndexOf(-3), 6, '−3.00 ⇒ −3~0（左闭）')
  assert.equal(bucketIndexOf(-5), 7)
  assert.equal(bucketIndexOf(-7), 8)
  assert.equal(bucketIndexOf(-9.99), 9, '−9.99 ⇒ −10~−7')
  assert.equal(bucketIndexOf(-10), 10, '−10.00 ⇒ ≤−10')
  assert.equal(bucketIndexOf(-10.01), 10)
  // 9 档映射后合计不变（11 档合计 == 9 档合计）
  const counts11 = new Array(11).fill(0)
  for (const p of [10, 9.99, 7, 5, 3, 0.01, 0, -0.01, -3, -5, -7, -9.99, -10]) counts11[bucketIndexOf(p)] += 1
  assert.equal(nineBucketsOf(counts11).reduce((a, b) => a + b, 0), 13, '9 档合计必须与样本数一致')
  assert.equal(NINE_FROM_ELEVEN.length, 9)
  // 反例注入：把 +10 判回「7~10」（旧行为）⇒ 必败
  assert.throws(() => assert.equal(bucketIndexOf(10), 1, '反例上：+10 落 7~10'), /反例上/, '⚠ 反例注入（开区间）必须失败')
})

test('③ dedupeSecids 只归一 A 股数字码，字母市场原样保留（改写成大写 ⇒ 败）', () => {
  assert.deepEqual(dedupeSecids(['sh600000', 'SH600000']), ['sh600000'], '大小写重复只留首次出现的原始串')
  assert.deepEqual(dedupeSecids(['usAAPL', 'usaapl']), ['usAAPL', 'usaapl'], '美股代码大小写有别 ⇒ 不许合并')
  assert.deepEqual(dedupeSecids(['hkHSI', 'hk00700', 'HK00700']), ['hkHSI', 'hk00700'], '港股：字母码原样、数字码归一')
  assert.deepEqual(dedupeSecids([' b ', 'a', 'b']), ['b', 'a'], '不许改写成大写')
  assert.deepEqual(dedupeSecids(['1.600000', ' 1.600000 ']), ['1.600000'], '数字 secid 去重')
  // 反例注入：旧实现（toUpperCase 且返回大写）⇒ 必败
  const old = (xs: string[]): string[] => [...new Set(xs.map((x) => x.trim().toUpperCase()))].filter((x) => x !== '')
  assert.deepEqual(old(['sh600000', 'SH600000']), ['SH600000'])
  assert.throws(() => assert.deepEqual(old(['b', 'a', 'b']), ['b', 'a'], '反例上：大写化'), /反例上/, '⚠ 反例注入（强制大写）必须失败')
})
