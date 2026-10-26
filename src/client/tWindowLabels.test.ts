/**
 * 做T 档位标签**全部在左侧**的断言（用户 2026-10-26 反馈：标签压在右侧 Y 轴刻度上）。
 * ① 左内侧 [plotLeft, plotLeft+80]；② 右侧轴区无做T 文字；③ 数量==档数；
 * ④ 标签矩形与折线不重叠；⑤ 虚线仍贯穿 plotLeft→plotRight。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { rectOverlapArea, tWindowLabelRect, tWindowLabelsOf, tWindowOf } from './tWindowView.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const chart = readFileSync(join(HERE, 'kline.tsx'), 'utf8')

const PLOT_LEFT = 40
const PLOT_RIGHT = 640
const yOf = (price: number): number => 200 - (price - 100) * 8 // 价格 100 ⇒ y=200；每元 8px

function labelsFor(atrPct = 3, avg = 100) {
  const w = tWindowOf({ atrPct, avg })
  if ('reason' in w) throw new Error(w.reason)
  return { w, labels: tWindowLabelsOf({ levels: w.levels, yOf, plotLeft: PLOT_LEFT, plotTop: 20, plotBottom: 360 }) }
}

test('① 每个档位标签 x 落在 [plotLeft, plotLeft+80]（画到右侧 ⇒ 必败）', () => {
  const { labels } = labelsFor()
  assert.ok(labels.length > 0)
  for (const lb of labels) {
    assert.ok(lb.x >= PLOT_LEFT, `x 不得越过左边界（${lb.x}）`)
    assert.ok(lb.x <= PLOT_LEFT + 80, `x 不得超过 plotLeft+80（${lb.x}）`)
    assert.ok(lb.x + lb.width <= PLOT_RIGHT, '标签不得超出绘图区右边界')
  }
  // 反例注入：把 x 放到右侧轴（原 bug）⇒ 必败
  const legacy = { ...labels[0]!, x: PLOT_RIGHT + 6 }
  assert.throws(() => assert.ok(legacy.x <= PLOT_LEFT + 80, '反例上：右侧轴'), /反例上/, '⚠ 反例注入（右侧）必须失败')
})

test('② 右侧轴区域不含任何做T 文字（x > plotRight 出现档位标签 ⇒ 必败）', () => {
  const { labels } = labelsFor()
  for (const lb of labels) assert.ok(lb.x + lb.width < PLOT_RIGHT, '标签必须完全落在绘图区内')
  // 源码：旧的右侧价格文字节点（twr-）必须已删除
  assert.equal(chart.includes('twr-'), false, 'kline.tsx 仍存在右侧档位文字节点')
  assert.equal(chart.includes('x: PAD_X + innerW + 6'), false, '右侧轴外仍画着文字')
  // 反例注入：加回右侧文字 ⇒ 判据必败
  const legacy = chart.replace("key: lb.key, x: lb.x", "key: 'twr-x', x: PAD_X + innerW + 6")
  assert.throws(() => assert.equal(legacy.includes('x: PAD_X + innerW + 6'), false, '反例上：右侧文字回来了'), /反例上/, '⚠ 反例注入必须失败')
})

test('③ 标签数量 == 档数（缺一个 ⇒ 必败）', () => {
  for (const atrPct of [1.5, 3, 5]) {
    const { w, labels } = labelsFor(atrPct, 100)
    assert.equal(labels.length, w.levels.length, `ATR% ${atrPct} 的标签数必须等于档数`)
    assert.equal(w.levels.length, w.bands)
  }
  // 反例注入：少画一个 ⇒ 必败
  const { labels } = labelsFor()
  assert.throws(() => assert.equal(labels.slice(0, -1).length, labels.length, '反例上：少一个'), /反例上/, '⚠ 反例注入（缺一个）必须失败')
})

test('④ 标签矩形与折线路径不相交（重叠 ⇒ 必败；靠 halo + 轻推保证）', () => {
  const w = tWindowOf({ atrPct: 3, avg: 100 })
  if ('reason' in w) throw new Error(w.reason)
  // 折线在标签 x 区间内是一条水平线，正好穿过**最上面一档**的 y
  const topLevel = w.levels[w.levels.length - 1]!
  const pathY = yOf(topLevel.price)
  const labels = tWindowLabelsOf({
    levels: w.levels, yOf, plotLeft: PLOT_LEFT, plotTop: 20, plotBottom: 360,
    pathYsAt: () => [pathY],
  })
  const pathRect = { x0: PLOT_LEFT + 6, x1: PLOT_LEFT + 80, y0: pathY, y1: pathY + 0.5 }
  for (const lb of labels) {
    assert.equal(rectOverlapArea(tWindowLabelRect(lb), pathRect), 0, `标签 ${lb.text} 压在折线上（y=${lb.y}）`)
  }
  // 反例注入：不轻推（直接用档位 y）⇒ 中间档（均价 100 ⇒ y=200）与折线重叠
  const naive = tWindowLabelsOf({ levels: w.levels, yOf, plotLeft: PLOT_LEFT })
  const mid = naive.find((l) => Math.abs(l.y - pathY) < 0.5)
  assert.ok(mid !== undefined, '前置：存在与均价线同 y 的档位')
  assert.throws(() => assert.equal(rectOverlapArea(tWindowLabelRect(mid), pathRect), 0, '反例上：未轻推必然重叠'), /反例上/, '⚠ 反例注入（不轻推）必须失败')
})

test('⑤ 虚线仍从 plotLeft 到 plotRight（缩短 ⇒ 必败）', () => {
  const dashLines = chart.split('\n').filter((l) => l.includes('x1: PAD_X, y1: y'))
  assert.ok(dashLines.length >= 1, '找不到做T 虚线')
  for (const l of dashLines) {
    assert.ok(l.includes('x1: PAD_X, y1: y, x2: PAD_X + innerW, y2: y'), `虚线必须贯穿整个绘图区（实际：${l.trim()}）`)
  }
  assert.equal(chart.includes('innerW / 2, y2: y'), false, '不许把做T 虚线缩短到一半')
  // 反例注入：构造一条"只画到一半"的虚线 ⇒ 判据必败
  const half = 'x1: PAD_X, y1: y, x2: PAD_X + innerW / 2, y2: y'
  assert.throws(
    () => assert.ok(half.includes('x2: PAD_X + innerW, y2: y'), '反例上：虚线缩短'),
    /反例上/,
    '⚠ 反例注入（缩短）必须失败',
  )
})
