/**
 * 排序逻辑测试（node --test）。
 *
 * 这组断言的重点是两条容易出错、又极难在界面上发现的约定：
 * 「无效值恒沉底」与「同值保持原顺序」—— 两者出错都表现为"每次刷新列表在跳"。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  PORT_COLUMNS, PORT_SORT_KEYS, WATCH_COLUMNS, WATCH_SORT_KEYS, nextSortState, normalizeSortState, sortArrow,
  sortByNumber, sortPositions, sortValue, sortWatch, weightOf,
} from './sort.ts'

interface WatchItem { secid: string }

/** 每行只需写要断言的那几个字段，其余按"缺失"处理（缺失 = null，排序时沉底） */
interface WatchInputRow {
  pct?: number | null
  totalMv?: number | null
  amount?: number | null
  chg?: number | null
  alpha?: number | null
}

const watchInput = (rows: Record<string, WatchInputRow>) =>
  (it: WatchItem) => {
    const r = rows[it.secid] ?? {}
    return { pct: r.pct ?? null, totalMv: r.totalMv ?? null, amount: r.amount ?? null, chg: r.chg ?? null, alpha: r.alpha ?? null }
  }

const w = (secid: string): WatchItem => ({ secid })

test('sortValue：非有限值与缺失一律视为无效', () => {
  assert.equal(sortValue(3), 3)
  assert.equal(sortValue(0), 0)
  assert.equal(sortValue(-1.5), -1.5)
  assert.equal(sortValue(null), null)
  assert.equal(sortValue(undefined), null)
  assert.equal(sortValue(Number.NaN), null)
  assert.equal(sortValue(Number.POSITIVE_INFINITY), null)
})

test('sortByNumber：无效值恒沉底（升序也不许跑到最前）', () => {
  const rows = [{ v: 5 }, { v: null }, { v: 1 }, { v: 3 }]
  assert.deepEqual(sortByNumber(rows, (r) => r.v, true).map((r) => r.v), [5, 3, 1, null])
  assert.deepEqual(sortByNumber(rows, (r) => r.v, false).map((r) => r.v), [1, 3, 5, null])
  // 全部无效 → 原顺序
  const allNull = [{ v: null }, { v: null }]
  assert.deepEqual(sortByNumber(allNull, (r) => r.v, true).map((r) => r.v), [null, null])
})

test('sortByNumber：同值稳定（不因排序重排同值条目）', () => {
  const rows = [{ id: 'a', v: 1 }, { id: 'b', v: 2 }, { id: 'c', v: 1 }, { id: 'd', v: 2 }]
  assert.deepEqual(sortByNumber(rows, (r) => r.v, true).map((r) => r.id), ['b', 'd', 'a', 'c'])
  assert.deepEqual(sortByNumber(rows, (r) => r.v, false).map((r) => r.id), ['a', 'c', 'b', 'd'])
})

test('sortWatch：默认顺序原样返回副本，市值/涨幅可排序', () => {
  const items = [w('1.a'), w('1.b'), w('1.c')]
  const inputs = { '1.a': { pct: 2.1, totalMv: 3e11 }, '1.b': { pct: -1.5, totalMv: 9e11 }, '1.c': { pct: null, totalMv: null } }
  const inputOf = watchInput(inputs)
  const copy = sortWatch(items, { key: 'default', desc: true }, inputOf)
  assert.deepEqual(copy.map((i) => i.secid), ['1.a', '1.b', '1.c'])
  assert.notEqual(copy, items, '返回副本，不改动原数组')
  assert.deepEqual(sortWatch(items, { key: 'mv', desc: true }, inputOf).map((i) => i.secid), ['1.b', '1.a', '1.c'])
  assert.deepEqual(sortWatch(items, { key: 'pct', desc: true }, inputOf).map((i) => i.secid), ['1.a', '1.b', '1.c'])
  assert.deepEqual(sortWatch(items, { key: 'pct', desc: false }, inputOf).map((i) => i.secid), ['1.b', '1.a', '1.c'])
})

test('sortWatch：列头新增的成交额/涨跌额/行业α 三个键各自可用，缺失恒沉底', () => {
  const items = [w('1.a'), w('1.b'), w('1.c')]
  const inputOf = watchInput({
    '1.a': { amount: 1e8, chg: 0.5, alpha: 1.2 },
    '1.b': { amount: 3e8, chg: -0.3, alpha: -0.8 },
    '1.c': { amount: null, chg: null, alpha: null },
  })
  assert.deepEqual(sortWatch(items, { key: 'amount', desc: true }, inputOf).map((i) => i.secid), ['1.b', '1.a', '1.c'])
  assert.deepEqual(sortWatch(items, { key: 'amount', desc: false }, inputOf).map((i) => i.secid), ['1.a', '1.b', '1.c'], '升序时缺失仍在最后')
  assert.deepEqual(sortWatch(items, { key: 'chg', desc: true }, inputOf).map((i) => i.secid), ['1.a', '1.b', '1.c'])
  assert.deepEqual(sortWatch(items, { key: 'chg', desc: false }, inputOf).map((i) => i.secid), ['1.b', '1.a', '1.c'])
  assert.deepEqual(sortWatch(items, { key: 'alpha', desc: true }, inputOf).map((i) => i.secid), ['1.a', '1.b', '1.c'])
  // α 需要个股与板块两侧都有值：板块缺失的条目（alpha=null）不能混进数值比较里当 0
  assert.equal(sortWatch(items, { key: 'alpha', desc: true }, inputOf).at(-1)?.secid, '1.c')
})

test('列头定义：有数值来源的列才可排，键必须在白名单内且不重复', () => {
  assert.deepEqual(WATCH_COLUMNS.map((c) => c.label), ['名称', '成交额', '市值', '涨跌', '涨跌幅', '行业 α'])
  assert.deepEqual(PORT_COLUMNS.map((c) => c.label), ['名称', '市值', '成本', '现价', '盈亏', '当日', '仓位'])
  assert.equal(WATCH_COLUMNS[0].key, null, '名称列没有排序键（排序契约是数值比较，中文名顺序依赖运行环境的排序表）')
  assert.equal(PORT_COLUMNS[0].key, null)
  assert.match(WATCH_COLUMNS[0].hint, /不做排序/)
  assert.match(PORT_COLUMNS[0].hint, /不做排序/)
  for (const c of WATCH_COLUMNS) {
    if (c.key !== null) assert.ok(WATCH_SORT_KEYS.includes(c.key), `${c.label} 的键 ${c.key} 必须在 prefs 白名单里`)
    assert.ok(c.hint.length > 0, `${c.label} 必须有口径提示`)
  }
  for (const c of PORT_COLUMNS) {
    if (c.key !== null) assert.ok(PORT_SORT_KEYS.includes(c.key), `${c.label} 的键 ${c.key} 必须在 prefs 白名单里`)
    assert.ok(c.hint.length > 0, `${c.label} 必须有口径提示`)
  }
  const watchKeys = WATCH_COLUMNS.map((c) => c.key).filter((k) => k !== null)
  const portKeys = PORT_COLUMNS.map((c) => c.key).filter((k) => k !== null)
  assert.equal(new Set(watchKeys).size, watchKeys.length, '同一个键不能在两个列头上出现（否则"当前列"标记会同时出现在两处）')
  assert.equal(new Set(portKeys).size, portKeys.length)
  // 白名单里除 'default'（由「↺ 默认顺序」承载）以外的每个键都必须能在列头点到
  for (const k of WATCH_SORT_KEYS) if (k !== 'default') assert.ok(watchKeys.includes(k), `自选列头缺少排序键 ${k}`)
  for (const k of PORT_SORT_KEYS) if (k !== 'default') assert.ok(portKeys.includes(k), `持仓列头缺少排序键 ${k}`)
})

test('sortPositions：六个键各自可用，盈亏跟随口径，占比按总市值', () => {
  const rows = [
    { posId: 'a', mv: 100, pnl: -5, dayPnl: 3, weight: 0.1, price: 12, cost: 10 },
    { posId: 'b', mv: 300, pnl: 20, dayPnl: -8, weight: 0.3, price: 30, cost: 25 },
    { posId: 'c', mv: 200, pnl: null, dayPnl: 1, weight: 0.2, price: null, cost: 8 },
  ]
  const inputOf = (r: (typeof rows)[number]) => ({ mv: r.mv, pnl: r.pnl, dayPnl: r.dayPnl, weight: r.weight, price: r.price, cost: r.cost })
  assert.deepEqual(sortPositions(rows, { key: 'default', desc: true }, inputOf).map((r) => r.posId), ['a', 'b', 'c'])
  assert.deepEqual(sortPositions(rows, { key: 'mv', desc: true }, inputOf).map((r) => r.posId), ['b', 'c', 'a'])
  assert.deepEqual(sortPositions(rows, { key: 'pnl', desc: true }, inputOf).map((r) => r.posId), ['b', 'a', 'c'])
  assert.deepEqual(sortPositions(rows, { key: 'pnl', desc: false }, inputOf).map((r) => r.posId), ['a', 'b', 'c'])
  assert.deepEqual(sortPositions(rows, { key: 'dayPnl', desc: true }, inputOf).map((r) => r.posId), ['a', 'c', 'b'])
  assert.deepEqual(sortPositions(rows, { key: 'weight', desc: true }, inputOf).map((r) => r.posId), ['b', 'c', 'a'])
  // 盈亏缺失（行情暂缺）沉底
  assert.equal(sortPositions(rows, { key: 'pnl', desc: true }, inputOf).at(-1)?.posId, 'c')
})

test('sortPositions：列头新增的现价/成本两个键各自可用，无价者沉底', () => {
  const rows = [
    { posId: 'a', mv: 100, pnl: -5, dayPnl: 3, weight: 0.1, price: 12, cost: 10 },
    { posId: 'b', mv: 300, pnl: 20, dayPnl: -8, weight: 0.3, price: 30, cost: 25 },
    { posId: 'c', mv: 200, pnl: null, dayPnl: 1, weight: 0.2, price: null, cost: 8 },
  ]
  const inputOf = (r: (typeof rows)[number]) => ({ mv: r.mv, pnl: r.pnl, dayPnl: r.dayPnl, weight: r.weight, price: r.price, cost: r.cost })
  assert.deepEqual(sortPositions(rows, { key: 'price', desc: true }, inputOf).map((r) => r.posId), ['b', 'a', 'c'])
  assert.deepEqual(sortPositions(rows, { key: 'price', desc: false }, inputOf).map((r) => r.posId), ['a', 'b', 'c'], '升序时无现价的持仓仍在最后')
  assert.deepEqual(sortPositions(rows, { key: 'cost', desc: true }, inputOf).map((r) => r.posId), ['b', 'a', 'c'])
  assert.deepEqual(sortPositions(rows, { key: 'cost', desc: false }, inputOf).map((r) => r.posId), ['c', 'a', 'b'])
})

test('weightOf：除零保护', () => {
  assert.equal(weightOf(100, 400), 0.25)
  assert.equal(weightOf(100, 0), null)
  assert.equal(weightOf(100, -1), null)
  assert.equal(weightOf(Number.NaN, 400), null)
})

test('nextSortState：同键翻转方向，换键回到默认降序', () => {
  assert.deepEqual(nextSortState({ key: 'mv' as const, desc: true }, 'mv'), { key: 'mv', desc: false })
  assert.deepEqual(nextSortState({ key: 'mv' as const, desc: false }, 'mv'), { key: 'mv', desc: true })
  assert.deepEqual(nextSortState({ key: 'default' as const, desc: false }, 'pct'), { key: 'pct', desc: true })
  assert.equal(sortArrow(true), '↓')
  assert.equal(sortArrow(false), '↑')
})

test('normalizeSortState：prefs 被手改成任意值时回退', () => {
  const keys = WATCH_SORT_KEYS
  assert.deepEqual(normalizeSortState({ key: 'mv', desc: false }, keys, { key: 'default', desc: true }), { key: 'mv', desc: false })
  assert.deepEqual(normalizeSortState({ key: 'nope', desc: false }, keys, { key: 'default', desc: true }), { key: 'default', desc: false })
  assert.deepEqual(normalizeSortState({ key: 42, desc: 'x' }, keys, { key: 'pct', desc: true }), { key: 'pct', desc: true })
  assert.deepEqual(normalizeSortState(null, keys, { key: 'default', desc: true }), { key: 'default', desc: true })
  assert.deepEqual(normalizeSortState([1, 2], PORT_SORT_KEYS, { key: 'default', desc: true }), { key: 'default', desc: true })
})

test('新增排序键进入 prefs 契约：白名单与列头一致，非法键仍然回退', () => {
  // 宿主的偏好校验用的是同一份键表（store.ts 引 shared/model.ts），因此这里断言的就是"能不能存进 prefs"
  for (const k of WATCH_SORT_KEYS) {
    assert.deepEqual(normalizeSortState({ key: k, desc: false }, WATCH_SORT_KEYS, { key: 'default', desc: true }), { key: k, desc: false })
  }
  for (const k of PORT_SORT_KEYS) {
    assert.deepEqual(normalizeSortState({ key: k, desc: true }, PORT_SORT_KEYS, { key: 'default', desc: true }), { key: k, desc: true })
  }
  assert.deepEqual(normalizeSortState({ key: 'name', desc: true }, WATCH_SORT_KEYS, { key: 'default', desc: true }), { key: 'default', desc: true }, '名称列没有键，写进来要回退')
})
