/**
 * 大盘宽度显示口径的断言（`node --test` 直跑，不打网络）。
 *
 * 这组断言的重点只有一个，但它必须被锁死：**缺失不许编码成 0**。
 * `up=null` 时若返回 0，界面就会显示"上涨 0"或"下跌 0"，而这两句话
 * 在 A 股语境里都是确定的错信息（"全市场没有一只上涨"/"没有一只下跌"）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { type BreadthLeg, breadthCells, upDownPair } from './breadthView.ts'

interface Overrides {
  sh?: number | null
  sz?: number | null
  shDown?: number | null
  szDown?: number | null
  shEven?: number | null
  szEven?: number | null
  shAmt?: number | null
  szAmt?: number | null
}

/** 默认两腿齐全；显式传 null 表示"该字段缺失" */
const pair = (o: Overrides = {}): [BreadthLeg, BreadthLeg] => [
  { up: o.sh === undefined ? 1000 : o.sh, down: o.shDown === undefined ? 800 : o.shDown, even: o.shEven === undefined ? 50 : o.shEven, amount: o.shAmt === undefined ? 5e11 : o.shAmt },
  { up: o.sz === undefined ? 2000 : o.sz, down: o.szDown === undefined ? 1200 : o.szDown, even: o.szEven === undefined ? 60 : o.szEven, amount: o.szAmt === undefined ? 6e11 : o.szAmt },
]

test('breadthCells：两腿齐全时求和，0 是合法值', () => {
  const a = breadthCells(...pair())
  assert.equal(a.countsOk, true)
  assert.equal(a.up, 3000)
  assert.equal(a.down, 2000)
  assert.equal(a.even, 110)
  assert.equal(a.amountOk, true)
  assert.equal(a.amount, 1.1e12)
  assert.equal(a.reason, null)
  // 当天真的没有一只上涨 → 显示 0（与"取不到"完全不同）
  const b = breadthCells(...pair({ sh: 0, sz: 0 }))
  assert.equal(b.countsOk, true)
  assert.equal(b.up, 0)
})

test('breadthCells：任一家数缺失 → 三格全 null（不得返回 0），并给原因与缺失分量', () => {
  const cases: Array<[string, Overrides]> = [
    ['沪市上涨缺失', { sh: null }],
    ['深市下跌缺失', { szDown: null }],
    ['沪市平盘缺失', { shEven: null }],
    ['深市整腿缺失', { sz: null, szDown: null, szEven: null }],
  ]
  for (const [name, o] of cases) {
    const c = breadthCells(...pair(o))
    assert.equal(c.countsOk, false, name)
    assert.equal(c.up, null, `${name}：不得用 0 顶替上涨`)
    assert.equal(c.down, null, `${name}：不得用 0 顶替下跌`)
    assert.equal(c.even, null, name)
    // M5：理由只说原因（"为什么不能显示 0"由 upDownPair/UPDOWN_MISSING_NOTE 那一处承担）
    assert.ok(c.reason !== null && c.reason.includes('未取到'), `${name}：缺失必须给出原因`)
    assert.ok(c.missingParts.length > 0, name)
  }
  // 具体到审计里的那个例子：up 有值而 down 缺失，不得出现 "1234 / 0"
  const one = breadthCells(...pair({ sh: 1234, shDown: null }))
  assert.equal(one.down, null)
  assert.ok(one.missingParts.includes('沪市下跌家数'))
})

test('breadthCells：成交额与家数分开判（家数可用不因成交额缺失而消失）', () => {
  const c = breadthCells(...pair({ shAmt: null }))
  assert.equal(c.countsOk, true)
  assert.equal(c.up, 3000)
  assert.equal(c.amountOk, false)
  assert.equal(c.amount, null, '成交额缺失不得用 0 顶替')
  // 成交额为 0（极端情况）同样视为不可用：0 会被读成"两市没有成交"
  const z = breadthCells(...pair({ shAmt: 0 }))
  assert.equal(z.amountOk, false)
  assert.equal(z.amount, null)
})

test('upDownPair：一侧缺失 → 整对不可用（不留 1234 / 0）', () => {
  assert.deepEqual(upDownPair(1234, 999), { ok: true, up: 1234, down: 999 })
  assert.deepEqual(upDownPair(0, 0), { ok: true, up: 0, down: 0 })
  assert.deepEqual(upDownPair(1234, null), { ok: false, up: null, down: null })
  assert.deepEqual(upDownPair(null, 999), { ok: false, up: null, down: null })
  assert.deepEqual(upDownPair(undefined, undefined), { ok: false, up: null, down: null })
  assert.deepEqual(upDownPair(Number.NaN, 1), { ok: false, up: null, down: null })
})
