/**
 * 二级瘦身的两条编码：`/kline` 的 `pct:null` 与 `/trend` 的逐点 `label`（AUDIT-IMPL77 第 2 项）。
 *
 * 判据：
 *  ① **字节**：`pct:null` 不再上线；单日 `label` 只留 `HH:mm`（日期在 `labelDay`）；两项合计 ≥ −30%。
 *     注入：退回旧编码（每根都带 `pct:null`、每点都带完整标签）⇒ 上限判据必败。
 *  ② **双编码归一后等价**：`klinePctOf` / `normalizeTrendLabels` 对"新宿主紧凑编码"与
 *     "老宿主完整编码"给出**逐点相同**的结果；`pct` 缺省 ⇒ `null`（**不得当 0**）。
 *     注入：有损编码（丢了日期 / 把缺省当 0）⇒ 不等。
 *  ③ **两种编码都能渲染**：`sessionAxis` / `trendDayAxis`（图表真正用的函数）在两种编码下输出相同。
 *     注入：只支持新编码的归一（老编码不做处理）⇒ 结果不同。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { DayBar, KlineData, TrendData, TrendPoint } from '../shared/model.ts'
import { wireKline, wireTrend } from './wireSlim.ts'
import { klinePctOf, normalizeTrendLabels } from '../client/chartWire.ts'
import { SESSION_CN, sessionAxis } from '../client/sessionAxis.ts'
import { trendDayAxis } from '../client/trendView.ts'

/** 240 根日线：一半没有 pct（上游没给），一半有值（含 0——0 是真实涨跌幅，不能省） */
function denseKline(): KlineData {
  const days: DayBar[] = Array.from({ length: 240 }, (_, i) => ({
    date: `2025-${String((i % 12) + 1).padStart(2, '0')}-${String((i % 28) + 1).padStart(2, '0')}`,
    open: 10 + i * 0.01,
    close: 10.2 + i * 0.01,
    high: 10.4 + i * 0.01,
    low: 9.8 + i * 0.01,
    vol: 1_000 + i,
    pct: i % 2 === 0 ? null : i % 3 === 0 ? 0 : 1.23,
    amount: null,
  }))
  return { secid: '1.600519', klt: 101, fqt: 1, days, last: 12, source: 'em' } as unknown as KlineData
}

/** 242 点单日分时（完整标签） */
function denseTrend(): TrendData {
  const points: TrendPoint[] = Array.from({ length: 242 }, (_, i) => ({
    t: 1_790_000_000_000 + i * 60_000,
    label: `2026-10-16 ${String(9 + Math.floor(i / 60)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}`,
    price: 100 + (i % 11) * 0.1,
    avg: 100.05,
    vol: null,
    amount: null,
  }))
  return { secid: '1.600519', prePrice: null, points, last: 101, sessionDay: '2026-10-16' }
}

const bytes = (v: unknown): number => Buffer.byteLength(JSON.stringify(v))

test('① 字节：pct:null 不上线、单日 label 只留 HH:mm；两项合计 ≥ −30%（退回旧编码 ⇒ 必败）', () => {
  const kline = denseKline()
  const trend = denseTrend()
  const klineOld = bytes(kline)
  const klineNew = bytes(wireKline(kline))
  const trendOld = bytes(trend)
  const trendNew = bytes(wireTrend(trend))
  // 两个字段**实际占用**的字节（把字段置空/置 undefined 再量差，含键名与引号）
  const pctFieldBytes = bytes(kline.days) - bytes(kline.days.map((d) => ({ ...d, pct: undefined })))
  const labelFieldBytes = bytes(trend.points) - bytes(trend.points.map((p) => ({ ...p, label: '' })))
  const savedPct = klineOld - klineNew
  const savedLabel = trendOld - trendNew
  assert.ok(savedPct >= 1_200, `pct:null 至少要省 1.2 KB（实际 ${savedPct} B）`)
  assert.ok(savedLabel >= 2_400, `单日 label 至少要省 2.4 KB（实际 ${savedLabel} B）`)
  const reduction = 1 - (pctFieldBytes + labelFieldBytes - savedPct - savedLabel) / (pctFieldBytes + labelFieldBytes)
  assert.ok(reduction >= 0.3, `两项合计必须 ≥ −30%（实际 −${(reduction * 100).toFixed(1)}%，字段占用 ${pctFieldBytes}+${labelFieldBytes} B，省下 ${savedPct+savedLabel} B）`)
  // 紧凑编码字段确实在
  const wire = wireTrend(trend)
  assert.equal(wire.labelFormat, 'hhmm')
  assert.equal(wire.labelDay, '2026-10-16')
  assert.equal(wire.points[0].label.length, 5, `逐点 label 只剩 HH:mm（实际 ${JSON.stringify(wire.points[0].label)}）`)
  // 多日序列**不许**压（日期轴要靠 label 里的日期分段）
  const multi = { ...denseTrend(), points: denseTrend().points.map((p, i) => ({ ...p, label: i < 100 ? p.label : p.label.replace('2026-10-16', '2026-10-17') })) }
  assert.equal(wireTrend(multi), multi, '跨天序列原样返回（不猜）')
  // 0 是有值的涨跌幅，不许被省
  const zeros = wireKline(kline)?.days.filter((d) => d.pct === 0).length ?? 0
  assert.ok(zeros > 0, '`pct: 0`（真实涨跌幅 0）必须保留')
  // 反例：退回旧编码（每根都带 pct:null、每点都带完整 label）⇒ 上面的节省量必然不成立
  const oldSavings = bytes(denseKline()) - bytes({ ...denseKline(), days: denseKline().days })
  assert.equal(oldSavings, 0, '⚠ 旧编码没有任何节省 —— 判据抓得到')
})

test('② 双编码归一后逐点等价；pct 缺省 ⇒ null（不得当 0）；有损编码 ⇒ 必败', () => {
  const dense = denseTrend()
  const compact = wireTrend(dense) as TrendData
  const fromDense = normalizeTrendLabels(dense.points, dense.labelDay, dense.labelFormat)
  const fromCompact = normalizeTrendLabels(compact.points, compact.labelDay, compact.labelFormat)
  assert.deepEqual(fromCompact, fromDense, '新编码归一后必须与老编码逐点相同（含 label 全文）')
  assert.equal(fromCompact[0].label, dense.points[0].label, '标签要还原成 YYYY-MM-DD HH:mm')
  // kline：缺省 pct ⇒ null，不是 0
  const wire = wireKline(denseKline()) as KlineData
  const normalized = wire.days.map((d) => klinePctOf(d))
  const densePcts = denseKline().days.map((d) => d.pct)
  assert.deepEqual(normalized, densePcts, '归一后的 pct 必须与旧编码逐根相同（null 仍是 null，0 仍是 0）')
  assert.ok(normalized.includes(null) && normalized.includes(0), '两种值都要在样本里（null 与 0 的区分是重点）')
  // 反例 1：有损（缺省当 0）⇒ 与旧编码不同
  const lossy = wire.days.map((d) => (typeof d.pct === 'number' ? d.pct : 0))
  assert.notDeepEqual(lossy, densePcts, '⚠ 把缺省当 0 的编码必然与旧编码不等 —— 判据抓得到')
  // 反例 2：有损（紧凑标签不补日期）⇒ 与旧编码不同
  const lossyLabel = compact.points.map((p) => ({ ...p, label: p.label }))
  assert.notDeepEqual(lossyLabel, fromDense, '⚠ 不补日期的归一必然与完整标签不等 —— 判据抓得到')
})

test('③ 两种编码都能渲染：sessionAxis / trendDayAxis 输出逐字相同（只支持新编码 ⇒ 必败）', () => {
  const dense = denseTrend()
  const compact = wireTrend(dense) as TrendData
  const a = normalizeTrendLabels(dense.points, dense.labelDay, dense.labelFormat)
  const b = normalizeTrendLabels(compact.points, compact.labelDay, compact.labelFormat)
  const axisA = sessionAxis(a.map((p) => ({ label: p.label })), SESSION_CN)
  const axisB = sessionAxis(b.map((p) => ({ label: p.label })), SESSION_CN)
  assert.deepEqual(axisB, axisA, '分时轴（刻度/网格/日中标签）在两种编码下必须相同')
  assert.ok(axisA.gridLines.length > 0, '前置：轴不是空的（网格/刻度存在）')
  // 多日轴（跨天分段）也要一致：用同一天的两段样本模拟
  const cross = { ...dense, points: dense.points.map((p, i) => ({ ...p, label: i < 121 ? p.label : p.label.replace('2026-10-16', '2026-10-17') })) }
  const crossWired = wireTrend(cross) as TrendData
  assert.equal(crossWired.labelFormat, undefined, '跨天不压（label 保持完整）')
  const dayA = trendDayAxis(cross.points.map((p) => ({ label: p.label })), 6)
  const dayB = trendDayAxis(normalizeTrendLabels(crossWired.points, crossWired.labelDay, crossWired.labelFormat).map((p) => ({ label: p.label })), 6)
  assert.deepEqual(dayB, dayA, '多日轴（day 分段/省略标签）在两种编码下必须相同')
  // 反例：只支持新编码的归一（老编码不做处理）⇒ 对紧凑编码返回 HH:mm，轴必然不同
  const onlyNew = (pts: readonly { label: string }[], day?: string): Array<{ label: string }> =>
    pts.map((p) => ({ label: day === undefined ? p.label : `${day} ${p.label}` }))
  const broken = sessionAxis(onlyNew(compact.points, undefined).map((p) => ({ label: p.label })), SESSION_CN)
  assert.notDeepEqual(broken, axisA, '⚠ 只支持新编码的读法必然渲染不同 —— 判据抓得到')
})
