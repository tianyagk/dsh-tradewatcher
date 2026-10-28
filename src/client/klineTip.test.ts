/**
 * 日K 信息框摆放（v0.179.0）：① 右半翻边 ② 不压最新 3 根柱 ③ 末柱离右缘 ≥28px
 * ④ 右轴预留 ≥56px ⑤ 信息框不吃鼠标事件。每条都配反例注入（必败）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { KLINE_AXIS_W, KLINE_TAIL_GAP, klineLayoutOf, klineTipPlacement, overlapAreaOf, type PlotBox } from './chartCursor.ts'

const here = dirname(fileURLToPath(import.meta.url))
const read = (f: string): string => readFileSync(join(here, f), 'utf8')
const TIP_W = 152
const TIP_H = 190
const W = 670
const COUNT = 240
const layout = klineLayoutOf(W, COUNT)
const plot: PlotBox = { left: layout.padX, right: layout.plotRight, top: 8, bottom: 300 }
/** 最新 3 根柱的包围盒（用真实 layout 算） */
const tail: PlotBox = {
  left: layout.lastBarCenterX - layout.step * 2.5,
  right: layout.lastBarCenterX + layout.step / 2,
  top: 100,
  bottom: 160,
}

test('① 光标在右半 ⇒ 信息框画在光标左侧（`x + w ≤ cursorX − 8`）；仍画右侧 ⇒ 败', () => {
  const cursorX = plot.left + (plot.right - plot.left) * 0.8
  const pos = klineTipPlacement({ cursorX, cursorY: 150, tipW: TIP_W, tipH: TIP_H, plot, keepOut: null })
  assert.equal(pos.flipped, true, '右半必须翻边')
  assert.ok(pos.left + TIP_W <= cursorX - 8, `信息框右缘 ${pos.left + TIP_W} 必须在光标左 8px 外（cursor ${cursorX}）`)
  // 左半：仍画右侧
  const leftHalf = klineTipPlacement({ cursorX: plot.left + 60, cursorY: 150, tipW: TIP_W, tipH: TIP_H, plot, keepOut: null })
  assert.equal(leftHalf.flipped, false)
  assert.ok(leftHalf.left > plot.left + 60, '左半必须画在光标右侧')
  // 反例注入：把右半也画到右侧 ⇒ 上述"右缘在光标左"断言必须失败
  const wrong = klineTipPlacement({ cursorX: plot.left + 60, cursorY: 150, tipW: TIP_W, tipH: TIP_H, plot, keepOut: null })
  assert.throws(() => assert.ok(wrong.left + TIP_W <= plot.left + 60 - 8, '反例上：画到右侧'), /反例上/, '⚠ 反例注入（不翻边）必须失败')
})

test('② 与最新 3 根柱包围盒交集面积 = 0（重叠 ⇒ 败）', () => {
  // 光标落在最后一根柱上：翻边后仍要保证不压柱
  const pos = klineTipPlacement({ cursorX: layout.lastBarCenterX, cursorY: 150, tipW: TIP_W, tipH: TIP_H, plot, keepOut: tail })
  const rect: PlotBox = { left: pos.left, top: pos.top, right: pos.left + TIP_W, bottom: pos.top + TIP_H }
  assert.equal(overlapAreaOf(rect, tail), 0, `信息框与最新 3 柱不得有交集（实际 ${overlapAreaOf(rect, tail)}px²）`)
  // 反例注入：把信息框按"贴右缘"摆（旧实现在末柱附近的形态）⇒ 交集必然 > 0
  const naive: PlotBox = { left: plot.right - TIP_W, top: 120, right: plot.right, bottom: 120 + TIP_H }
  assert.ok(overlapAreaOf(naive, tail) > 0, '反例：贴右缘的信息框必然压住最新柱（证明避让判据非空）')
  assert.throws(() => assert.equal(overlapAreaOf(naive, tail), 0, '反例上：贴右缘'), /反例上/, '⚠ 反例注入（压住最新柱）必须失败')
})

test('②b 窄图/贴边时退化到左上角（fallback）且仍不压柱', () => {
  const narrow: PlotBox = { left: 8, right: 300, top: 8, bottom: 260 }
  const narrowTail: PlotBox = { left: 250, right: 296, top: 60, bottom: 120 }
  const pos = klineTipPlacement({ cursorX: 290, cursorY: 90, tipW: TIP_W, tipH: TIP_H, plot: narrow, keepOut: narrowTail })
  assert.equal(pos.fallback, true, '窄图翻边后仍冲突 ⇒ 必须退化到左上角')
  assert.equal(pos.left, narrow.left + 4)
  assert.equal(pos.top, narrow.top + 4)
})

test('③ 最后一根柱中心距绘图区右缘 ≥ 28px（贴边 ⇒ 败）', () => {
  assert.equal(KLINE_TAIL_GAP, 28)
  const gap = layout.plotRight - layout.lastBarCenterX
  assert.ok(gap >= 28, `末柱中心到 plotRight 必须 ≥28px（实际 ${gap.toFixed(2)}）`)
  // 反例注入：去掉尾距（柱子铺满 innerW）⇒ 只剩半步长 ⇒ 必小于 28
  const noTail = layout.lastBarCenterX + (layout.innerW - layout.barSpan)
  assert.throws(() => assert.ok(layout.plotRight - noTail >= 28, '反例上：贴边'), /反例上/, '⚠ 反例注入（取消尾距）必须失败')
})

test('④ 右侧价格轴预留 ≥56px，且末日期标签以 end 停在绘图区右缘（不被裁剪）', () => {
  assert.equal(KLINE_AXIS_W, 56)
  assert.equal(layout.axisW, 56)
  assert.equal(layout.plotRight, W - 56, '绘图区右缘 = 画布宽 − 56')
  const src = read('kline.tsx')
  // 末日期标签：textAnchor end + x=PAD_X+innerW（向右不溢出）
  assert.ok(/k === 2 \? 'end'/.test(src), '末日期标签必须 text-anchor=end')
  assert.ok(src.includes("x: k === 0 ? PAD_X : k === 2 ? PAD_X + innerW : xAt(i)"), '末日期标签必须落在绘图区右缘')
  // 反例注入：轴宽改成 0 ⇒ 右缘贴到画布边，末标签没有余量
  assert.throws(() => assert.equal(layout.plotRight, W, '反例上：轴宽 0'), /反例上/, '⚠ 反例注入（去掉右轴）必须失败')
})

test('⑤ 信息框 pointer-events:none（可拦截鼠标 ⇒ 败）', () => {
  const src = read('kline.tsx')
  assert.ok(src.includes("pointerEvents: 'none'"), "信息框必须 pointerEvents: 'none'")
  // 反例注入：换成 auto ⇒ 判据必须认出
  const injected = src.replace("pointerEvents: 'none'", "pointerEvents: 'auto'")
  assert.notEqual(injected, src, '反例注入必须真改到源码')
  assert.equal(injected.includes("pointerEvents: 'none'"), false, '⚠ 反例（可拦截事件）必须能被抓住')
})
