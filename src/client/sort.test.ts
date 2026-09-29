/**
 * 排序逻辑测试（node --test）。
 *
 * 这组断言的重点是两条容易出错、又极难在界面上发现的约定：
 * 「无效值恒沉底」与「同值保持原顺序」—— 两者出错都表现为"每次刷新列表在跳"。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  PORT_SORT_KEYS, WATCH_SORT_KEYS, nextSortState, normalizeSortState, sortArrow,
  sortByNumber, sortPositions, sortValue, sortWatch, weightOf,
} from './sort.ts'

interface WatchItem { secid: string }

const watchInput = (rows: Record<string, { pct: number | null; totalMv: number | null }>) =>
  (it: WatchItem) => rows[it.secid] ?? { pct: null, totalMv: null }

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

test('sortPositions：四个键各自可用，盈亏跟随口径，占比按总市值', () => {
  const rows = [
    { posId: 'a', mv: 100, pnl: -5, dayPnl: 3, weight: 0.1 },
    { posId: 'b', mv: 300, pnl: 20, dayPnl: -8, weight: 0.3 },
    { posId: 'c', mv: 200, pnl: null, dayPnl: 1, weight: 0.2 },
  ]
  const inputOf = (r: (typeof rows)[number]) => ({ mv: r.mv, pnl: r.pnl, dayPnl: r.dayPnl, weight: r.weight })
  assert.deepEqual(sortPositions(rows, { key: 'default', desc: true }, inputOf).map((r) => r.posId), ['a', 'b', 'c'])
  assert.deepEqual(sortPositions(rows, { key: 'mv', desc: true }, inputOf).map((r) => r.posId), ['b', 'c', 'a'])
  assert.deepEqual(sortPositions(rows, { key: 'pnl', desc: true }, inputOf).map((r) => r.posId), ['b', 'a', 'c'])
  assert.deepEqual(sortPositions(rows, { key: 'pnl', desc: false }, inputOf).map((r) => r.posId), ['a', 'b', 'c'])
  assert.deepEqual(sortPositions(rows, { key: 'dayPnl', desc: true }, inputOf).map((r) => r.posId), ['a', 'c', 'b'])
  assert.deepEqual(sortPositions(rows, { key: 'weight', desc: true }, inputOf).map((r) => r.posId), ['b', 'c', 'a'])
  // 盈亏缺失（行情暂缺）沉底
  assert.equal(sortPositions(rows, { key: 'pnl', desc: true }, inputOf).at(-1)?.posId, 'c')
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
