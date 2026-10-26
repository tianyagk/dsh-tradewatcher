/**
 * 做T 网格"装进绘图区"的断言（用户 2026-10-26）：
 * ① 间距 = min(ATR%/4, 振幅%/4)；② 半跨度 ≤ 振幅%；③ 所有档位线与标签 ≤ plotRight−8；
 * ④ 8 档全可见（标签数 = 8、纵向不重叠）；⑤ 右侧 plotRight−8 以外无任何做T 图元。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tWindowLabelsOf, tWindowOf } from './tWindowView.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const chart = readFileSync(join(HERE, 'kline.tsx'), 'utf8')
const PL = 40
const PR = 640
const yOf = (p: number): number => 330 - (p - 16) * 60 // 16 元 ⇒ y=330

test('① 间距 = min(ATR%÷4, 振幅%÷4)（写死 ATR%/4 ⇒ 必败）', () => {
  const w = tWindowOf({ atrPct: 8.15, avg: 17.06, ampPct: 3.6 })
  assert.ok(!('reason' in w))
  assert.equal(w.spacingPct, Math.min(8.15 / 4, 3.6 / 4), '间距必须取两者较小值')
  assert.equal(w.spacingPct, 0.9)
  assert.equal(w.spacingSource, 'amp')
  // 反例注入：只用 ATR%/4 ⇒ 2.0375 > 0.9 ⇒ 必败
  assert.throws(() => assert.equal(8.15 / 4, w.spacingPct, '反例上：只看 ATR'), /反例上/, '⚠ 反例注入（只用 ATR）必须失败')
})

test('② 半跨度 ≤ 当日振幅%（越界 ⇒ 必败）', () => {
  for (const [atr, amp] of [[8.15, 3.6], [12, 1.2], [2.2, 0.6]] as const) {
    const w = tWindowOf({ atrPct: atr, avg: 100, ampPct: amp })
    assert.ok(!('reason' in w))
    assert.ok(w.halfSpanPct <= amp + 1e-9, `半跨度 ${w.halfSpanPct} 必须 ≤ 振幅 ${amp}`)
    assert.ok(Math.abs(w.halfSpanPct - (w.spacingPct * w.bands) / 2) < 1e-9, '半跨度 = 间距 × 档数/2')
  }
  // 反例注入：不压间距（ATR 12 / 振幅 1.2，8 档）⇒ 半跨度 12 > 1.2 ⇒ 必败
  assert.throws(() => assert.ok((12 / 4 * 8) / 2 <= 1.2, '反例上：越界'), /反例上/, '⚠ 反例注入（越界）必须失败')
})

test('③ 每个档位的线与标签都在 [plotLeft, plotRight−8]（有一个越界 ⇒ 必败）', () => {
  const w = tWindowOf({ atrPct: 8.15, avg: 17.06, ampPct: 3.6 })
  assert.ok(!('reason' in w))
  const labels = tWindowLabelsOf({ levels: w.levels, yOf, plotLeft: PL, plotRight: PR, plotTop: 20, plotBottom: 360 })
  assert.equal(labels.length, w.levels.length)
  for (const lb of labels) {
    assert.ok(lb.x >= PL, '标签越过左边界')
    assert.ok(lb.x + lb.width <= PR - 8, `标签越过 plotRight−8（${lb.x + lb.width} > ${PR - 8}）`)
  }
  // 虚线右端也不得顶到轴
  assert.equal(/key: `tw-\$\{lv\.side\}-\$\{lv\.devPct\}`,?[\s\S]{0,120}x2: PAD_X \+ innerW - 8/.test(chart), true, '做T 虚线右端必须收在 plotRight−8')
  // 反例注入：标签画到 plotRight ⇒ 必败
  const bad = { ...labels[0]!, x: PR - 10, width: 30 }
  assert.throws(() => assert.ok(bad.x + bad.width <= PR - 8, '反例上：越界'), /反例上/, '⚠ 反例注入（越界）必须失败')
})

test('④ 该票 8 档全部可见（标签数 = 8、纵向不重叠、都在绘图区内）', () => {
  const w = tWindowOf({ atrPct: 8.15, avg: 17.06, ampPct: 3.6 })
  assert.ok(!('reason' in w))
  assert.equal(w.bands, 8, 'ATR 8.15% ⇒ 8 档')
  const labels = tWindowLabelsOf({ levels: w.levels, yOf, plotLeft: PL, plotRight: PR, plotTop: 20, plotBottom: 360 })
  assert.equal(labels.length, 8, '8 档必须全部画出来（截图那种只见 3 个 ⇒ 必败）')
  const ys = labels.map((l) => l.y).sort((a, b) => a - b)
  for (let i = 1; i < ys.length; i += 1) assert.ok(ys[i]! - ys[i - 1]! >= 13, `第 ${i} 个标签与上一个间距不足（${ys[i]! - ys[i - 1]!}）`)
  assert.ok(ys[0]! >= 20 && ys[ys.length - 1]! <= 352, '标签必须全在绘图区内')
  // 反例注入：只画 3 个 ⇒ 必败
  assert.throws(() => assert.equal(labels.slice(0, 3).length, 8, '反例上：只画 3 个'), /反例上/, '⚠ 反例注入（只见 3 个）必须失败')
})

test('⑤ plotRight−8 以外无任何做T 图元（虚线端点/文字/tick）', () => {
  // 源码：旧右侧节点已清；做T 虚线终点是 innerW−8；右侧刻度从 +4 起（与绘图区留出干净间隙）
  assert.equal(chart.includes('twr-'), false, '右侧档位文字节点必须已删除')
  assert.equal(chart.includes('innerW + 6'), false, '不允许再有右侧做T 文字')
  // 做T 虚线对象：key 后 200 字内必须出现 `innerW - 8`（其它线如昨收基准/现价线不受此限）
  const m = /key: `tw-\$\{lv\.side\}-\$\{lv\.devPct\}`([\s\S]{0,200})/.exec(chart)
  assert.ok(m !== null, '找不到做T 虚线对象')
  assert.ok(m[1].includes('x2: PAD_X + innerW - 8'), '做T 虚线端点必须收在 plotRight−8')
  assert.equal(/x: padX \+ innerW \+ 4, y: y - 2/.test(chart), true, '右侧价格刻度左移 4px（+4），与绘图区保持间隙')
  // 反例注入：把端点改回 plotRight ⇒ 必败
  const bad = 'x1: PAD_X, y1: y, x2: PAD_X + innerW, y2: y'
  assert.throws(() => assert.ok(bad.includes('innerW - 8'), '反例上：端点顶到轴'), /反例上/, '⚠ 反例注入（顶到轴）必须失败')
})
