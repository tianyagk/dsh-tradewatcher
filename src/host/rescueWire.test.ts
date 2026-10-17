/**
 * 护盘快照的**线上瘦身**（AUDIT-IMPL76 第 4 项）。
 *
 * 实测（REVIEW-9-PERF §4）：`/rescue` 回包 78.7 KB 里 `etfSeries` 占 69.8 KB；
 * 每点 48.1 B 里 **39% 是 `"hhmm":""` / `"price":null`** —— 空串与显式 null 没有信息量。
 * 宿主只在**线上编码**里裁掉它们（`wireRescueSnapshot`），语义不变（缺省 ≡ 空/未知）：
 *  - `amount` **恒在**（`null` = 这一分钟没有读数，**不写 0**）；
 *  - `hhmm` 非空才发、`price` 非 null 才发。
 *
 * 三条判据（都配反例注入）：
 *  ① 回包字节 ≤ 目标（≥ −40%）—— 退回"对象数组里的空字段"必然越界；
 *  ② 客户端归一函数同时吃**新旧两种编码**（`rescueCardPointsOf`），归一后逐点相同；
 *  ③ 序列数值逐点等价（编码无损）：`amount` 原样、`hhmm` 缺省还原成 `''`、`price` 缺省还原成 `null`。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { RescueCardSeries, RescueSnapshot } from '../shared/model.ts'
import { wireRescueSnapshot } from './rescue.ts'
import { rescueCardPointsOf, type RescueCardPoint } from '../client/rescueView.ts'

/** 六通道 × 242 点的密集体（形状与真机一致：hhmm 空串、price null、amount 两位小数） */
function denseCards(): RescueCardSeries[] {
  return ['1.510300', '1.510050', '1.510500', '1.512100', '1.588000', '0.159915'].map((secid, ch) => ({
    secid,
    name: `通道${ch}`,
    caliber: '每分钟成交额（元）·当日；腾讯分钟链的逐分钟值由累计额差分推导（amountDerived）',
    points: Array.from({ length: 242 }, (_, i) => ({
      hhmm: i % 97 === 0 ? `10:${String(i % 60).padStart(2, '0')}` : '',
      amount: i === 3 ? null : 39_545_970.17 + ch * 1_000_000 + i * 66_000.5,
      price: null,
    })),
    why: null,
  }))
}

function snapOf(cards: RescueCardSeries[]): RescueSnapshot {
  return { etfSeries: cards } as unknown as RescueSnapshot
}

const densePoints = (cards: readonly RescueCardSeries[]): RescueCardPoint[] =>
  cards.flatMap((c) => c.points.map((p) => ({ hhmm: p.hhmm, amount: p.amount, price: p.price })))

test('① 线上回包 ≤ 50 KB 且比密集体至少小 40%（退回空字段 ⇒ 必败）', () => {
  const cards = denseCards()
  const denseBytes = Buffer.byteLength(JSON.stringify({ etfSeries: cards }))
  const wireBytes = Buffer.byteLength(JSON.stringify(wireRescueSnapshot(snapOf(cards))))
  const ratio = 1 - wireBytes / denseBytes
  assert.ok(ratio >= 0.4, `瘦身后必须至少小 40%（实际 ${(ratio * 100).toFixed(1)}%：${denseBytes} → ${wireBytes} B）`)
  assert.ok(wireBytes <= 50 * 1024, `线上 etfSeries 块必须 ≤ 50 KB（实际 ${(wireBytes / 1024).toFixed(1)} KB）`)
  // 反例：退回"每点都带空 hhmm / null price"的密集体 ⇒ 上限判据必败
  assert.ok(denseBytes > 50 * 1024, `⚠ 密集体（${(denseBytes / 1024).toFixed(1)} KB）必须超过 50 KB —— 这就是"不裁"的形状`)
  // 空字段真的没被发出去（判据不是"看起来小"）
  const wire = wireRescueSnapshot(snapOf(cards)) as RescueSnapshot
  const pts = (wire.etfSeries?.[0]?.points ?? []) as Array<Record<string, unknown>>
  const sparse = pts.find((p) => !('hhmm' in p))
  assert.ok(sparse !== undefined, '必须有"空 hhmm 不上线"的点')
  assert.equal('price' in (sparse as Record<string, unknown>), false, 'null price 不许上线')
  assert.equal('amount' in (sparse as Record<string, unknown>), true, 'amount 恒在（null 也要发，表示"这一分钟没有读数"）')
  // 有值的那几个点仍然带 hhmm（不是"一律删掉"）
  const withHhmm = wire.etfSeries?.[0]?.points.filter((p) => p.hhmm !== undefined) ?? []
  assert.ok(withHhmm.length > 0 && withHhmm.every((p) => typeof p.hhmm === 'string' && p.hhmm !== ''), '非空 hhmm 必须保留')
})

test('② 客户端归一同时吃新旧两种编码：dense 与稀疏归一后逐点相同（只支持新编码 ⇒ 必败）', () => {
  const cards = denseCards()
  const wire = (wireRescueSnapshot(snapOf(cards)) as RescueSnapshot).etfSeries ?? []
  const fromDense = cards.map((c) => rescueCardPointsOf(c))
  const fromWire = wire.map((c) => rescueCardPointsOf(c))
  assert.deepEqual(fromWire, fromDense, '新旧两种编码归一后必须逐点相同（同一份数据、同一读法）')
  // 反例：只认新编码的归一（缺 hhmm 就直接丢点 / 缺 amount 当 0）⇒ 与 dense 不等
  const onlyNew = (card: { points?: Array<{ hhmm?: string; amount?: number | null; price?: number | null }> }): RescueCardPoint[] =>
    (card.points ?? []).filter((p) => p.hhmm !== undefined).map((p) => ({ hhmm: p.hhmm as string, amount: p.amount ?? 0, price: p.price ?? null }))
  assert.notDeepEqual(wire.map((c) => onlyNew(c)), fromDense, '⚠ 反例（只支持新编码）必须与 dense 读法不一致 —— 判据抓得到')
  // 也覆盖"完全没有 points"的卡：归一给空数组而不是抛
  assert.deepEqual(rescueCardPointsOf({ points: [] }), [])
  assert.deepEqual(rescueCardPointsOf({}), [])
})

test('③ 编码无损：逐点 amount/hhmm/price 等价（缺省按语义还原，编码有损 ⇒ 必败）', () => {
  const cards = denseCards()
  const wire = (wireRescueSnapshot(snapOf(cards)) as RescueSnapshot).etfSeries ?? []
  const expected = densePoints(cards)
  const actual = wire.flatMap((c) => rescueCardPointsOf(c))
  assert.equal(actual.length, expected.length, `点数必须一致（${actual.length} vs ${expected.length}）`)
  for (let i = 0; i < expected.length; i += 1) {
    assert.equal(actual[i].amount, expected[i].amount, `第 ${i} 点 amount 必须逐值相等（null 也是值）`)
    assert.equal(actual[i].hhmm, expected[i].hhmm, `第 ${i} 点 hhmm 必须还原（缺省 ≡ 空串）`)
    assert.equal(actual[i].price, expected[i].price, `第 ${i} 点 price 必须还原（缺省 ≡ null）`)
  }
  // 反例：有损编码（amount 四舍五入到整数）⇒ 上面的逐值相等必败
  const lossy = (card: { points?: Array<{ hhmm?: string; amount?: number | null; price?: number | null }> }): RescueCardPoint[] =>
    (card.points ?? []).map((p) => ({ hhmm: p.hhmm ?? '', amount: p.amount === null || p.amount === undefined ? null : Math.round(p.amount), price: p.price ?? null }))
  const lossyPoints = wire.flatMap((c) => lossy(c))
  assert.notDeepEqual(lossyPoints, actual, '⚠ 反例（编码有损）必须与无损结果不同 —— 判据抓得到')
})
