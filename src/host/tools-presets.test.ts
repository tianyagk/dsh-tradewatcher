/**
 * 预设标的（`secids=cn|intl|commodity|bond|all`）的断言。
 *
 * 为什么单列这篇：v0.40.0 往 `TW_ROWS` 插入「国债」组后，工具侧仍按**位置**取组
 * （`TW_ROWS[2]`）⇒ `commodity` 静默返回**国债指数**、`all` 漏掉全部商品 —— 有价、有出处、
 * 看着完全正常的**静默错答**。这里锁住"每个预设的 secid 集合 == TW_ROWS 对应组"。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { TW_ROWS, twAllSecids, twGroupSecids } from '../shared/model.ts'
import { resolveQuoteIds } from './tools.ts'

test('预设按组 key 解析：每个预设的 secid 集合必须与 TW_ROWS 对应组逐字一致', async () => {
  for (const key of ['cn', 'intl', 'commodity', 'bond']) {
    const got = await resolveQuoteIds(key)
    assert.deepEqual(got, twGroupSecids(key), `预设 ${key} 必须等于 TW_ROWS 的 ${key} 组`)
  }
  const all = await resolveQuoteIds('all')
  assert.deepEqual(all, twAllSecids(), 'all 必须是全部四组的并集（顺序＝组顺序）')
})

/**
 * 上面那条是"实现入口 vs 同源函数"的比较 —— 若**共用函数本身**被改错（例如 `twGroupSecids`
 * 内部又改回按下标取组），两边会一起错、断言恒真（独立验证时注入实测确认过）。
 * 所以这里补两条**互不相同**的独立基准：①直接读 `TW_ROWS` 数据（不经那个函数）；
 * ②字面项数表（任何人改了分组都得同时改这张表，改不动就说明有意的）。
 */
test('独立基准①：按 key 取组必须等于直接读 TW_ROWS 数据里的那一组', () => {
  for (const key of ['cn', 'intl', 'commodity', 'bond']) {
    const row = TW_ROWS.find((r) => r.key === key)
    assert.ok(row, `TW_ROWS 里应有 key=${key} 的组`)
    assert.deepEqual(
      twGroupSecids(key),
      row.items.map((it) => it.secid),
      `twGroupSecids('${key}') 必须来自 TW_ROWS 的 ${key} 组数据本身`,
    )
  }
})

test('独立基准②：字面项数表（6 / 9 / 5 / 8 / 28）', () => {
  const literal: Record<string, number> = { cn: 6, intl: 9, bond: 5, commodity: 8 }
  for (const [key, n] of Object.entries(literal)) {
    assert.equal(twGroupSecids(key).length, n, `${key} 组应有 ${n} 项（顺序无关，只看数量）`)
  }
  assert.equal(twAllSecids().length, 28, '四组合计 28 项')
})

test('回归：commodity 里不许出现国债、且必须含全部商品；all 必须覆盖四组', async () => {
  const commodity = await resolveQuoteIds('commodity')
  const bond = twGroupSecids('bond')
  assert.equal(commodity.length, 8, `commodity 应有 8 只商品（实际 ${commodity.length}）`)
  for (const secid of bond) {
    assert.equal(commodity.includes(secid), false, `commodity 里混进了国债标的 ${secid}（这就是回归本身）`)
  }
  for (const secid of ['122.XAU', '101.HG00Y', '114.lhm']) {
    assert.equal(commodity.includes(secid), true, `commodity 缺 ${secid}`)
  }
  const all = await resolveQuoteIds('all')
  for (const key of ['cn', 'intl', 'commodity', 'bond']) {
    for (const secid of twGroupSecids(key)) {
      assert.equal(all.includes(secid), true, `all 缺 ${key} 组的 ${secid}`)
    }
  }
  assert.equal(all.length, TW_ROWS.reduce((n, r) => n + r.items.length, 0))
  assert.equal(all.length, 28, '四组共 28 张（6+9+8+5）')
})

test('显式清单仍按原样解析（去重不改变大小写），未知预设不静默当空', async () => {
  assert.deepEqual(await resolveQuoteIds('1.000001, 114.lhm ,1.000001'), ['1.000001', '114.lhm'])
  // 未知预设不是"静默当空"，而是当成显式清单 → 解析不出合法代码就**报错**（不返回空数组）
  await assert.rejects(() => resolveQuoteIds('nonsense-preset'), /未解析到合法证券代码/)
  await assert.rejects(() => resolveQuoteIds(''), /必填/)
})
