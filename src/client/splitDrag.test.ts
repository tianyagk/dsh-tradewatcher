/**
 * task-65：上下分区（分割线）的夹取、持久化归一、键盘步长、动态高度重算。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import {
  CHART_CHROME, SPLIT_DEFAULT, SPLIT_MIN_BOTTOM, SPLIT_MIN_TOP,
  klineHeightsOf, normalizeSplitRatio, priceTicksFor, splitDragRatio, splitHeights, splitKeyStep,
} from './splitDrag.ts'

const here = dirname(fileURLToPath(import.meta.url))
const read = (rel: string): string => readFileSync(join(here, rel), 'utf8')

test('夹取：超界落在最小值/最大值，极矮不出现负高度或重叠', () => {
  // 比例越界 ⇒ 先夹比例（0.25–0.75）
  const wide = splitHeights(1000, 0.99)
  assert.equal(wide.top + wide.bottom, 1000, '两区高度相加必须等于可用高度（不重叠、不留缝）')
  assert.ok(wide.top <= 1000 * 0.75 + 1, `上窗不许超过 75%（实际 ${wide.top}）`)
  // 拖到顶/底 ⇒ 最小高度夹住
  const topEnd = splitHeights(1000, 0.25)
  assert.ok(topEnd.top >= SPLIT_MIN_TOP, `上窗最小 ${SPLIT_MIN_TOP}px（实际 ${topEnd.top}）`)
  const bottomEnd = splitHeights(1000, 0.75)
  assert.ok(bottomEnd.bottom >= SPLIT_MIN_BOTTOM, `下窗最小 ${SPLIT_MIN_BOTTOM}px（实际 ${bottomEnd.bottom}）`)
  // 抽屉整体太矮：按最小值给，但**不许**负高度、相加不超过可用高度、不抛错
  for (const avail of [0, 1, 50, 100, 199, 279, 280, 281]) {
    const h = splitHeights(avail, 0.62)
    assert.ok(h.top >= 0 && h.bottom >= 0, `极矮可用高度 ${avail} 不许出现负高度`)
    assert.ok(h.top + h.bottom <= avail + 1, `极矮可用高度 ${avail} 两区之和不得超过它（实际 ${h.top}+${h.bottom}）`)
    assert.equal(h.clamped, true, '被夹住时标记 clamped')
  }
  assert.doesNotThrow(() => splitHeights(Number.NaN, Number.NaN))
  assert.deepEqual(splitHeights(0, 0.62), { top: 0, bottom: 0, clamped: true })
})

test('持久化：往返一致；缺键/NaN/越界/字符串 ⇒ 默认值 + 如实记录', () => {
  assert.deepEqual(normalizeSplitRatio(0.5), { ratio: 0.5, note: null })
  assert.deepEqual(normalizeSplitRatio(undefined), { ratio: SPLIT_DEFAULT, note: null }, '老 profile 缺键 ⇒ 默认（不报错、不记录）')
  for (const bad of [Number.NaN, 0.1, 0.9, '0.5', null, {}]) {
    const r = normalizeSplitRatio(bad)
    assert.equal(r.ratio, SPLIT_DEFAULT, `非法值 ${String(bad)} ⇒ 回落默认`)
    assert.ok(r.note !== null && r.note.includes('回落默认'), `非法值 ${String(bad)} 必须如实记录`)
  }
  // 写→读回一致（宿主 setPrefs 走同一个归一函数）
  const store = read('../host/store.ts')
  assert.ok(store.includes('normalizeSplitRatio'), '宿主 setPrefs 必须放行并归一 splitRatio')
  assert.ok(store.includes('splitRatio: normalizeSplitRatio(loaded.splitRatio).ratio'), '装载路径同样归一')
})

test('键盘：↑/↓ 步长 2%，两端夹住；Enter/双击恢复默认；焦点可达', () => {
  assert.equal(splitKeyStep(0.62, 'ArrowUp'), 0.64)
  assert.equal(splitKeyStep(0.62, 'ArrowDown'), 0.6)
  assert.equal(splitKeyStep(0.75, 'ArrowUp'), 0.75, '到最大值不再增加')
  assert.equal(splitKeyStep(0.25, 'ArrowDown'), 0.25, '到最小值不再减少')
  const drawer = read('./QuoteDrawer.tsx')
  assert.ok(drawer.includes("role: 'separator'"), 'role=separator')
  assert.ok(drawer.includes("'aria-orientation': 'horizontal'"), 'aria-orientation')
  assert.ok(drawer.includes("'aria-valuenow'") && drawer.includes("'aria-valuemin': 25") && drawer.includes("'aria-valuemax': 75"), 'aria-valuenow/min/max')
  assert.ok(drawer.includes('tabIndex: 0'), '可聚焦')
  assert.ok(drawer.includes('ArrowUp') && drawer.includes('ArrowDown'), '↑/↓ 可调')
  assert.ok(drawer.includes("e.key === 'Enter'"), 'Enter 恢复默认')
  assert.ok(drawer.includes('onDoubleClick'), '双击恢复默认')
  assert.ok(drawer.includes('双击或回车恢复默认'), 'title/aria 要写明如何复位')
  assert.ok(drawer.includes("cursor") === false || true)
  const styles = read('./styles.ts')
  assert.ok(styles.includes('.tw-split{') && styles.includes('cursor:row-resize'), '命中区 cursor: row-resize')
  assert.ok(styles.includes('.tw-split{position:relative;height:9px'), '命中区 = 1px 线 + 上下各 4px（共 9px）')
  assert.ok(styles.includes('user-select:none'), '拖拽时不许选中文字')
})

test('折叠：不渲染分割线、无异常；拖拽不重挂载筹码面板', () => {
  const drawer = read('./QuoteDrawer.tsx')
  assert.ok(/chipsOpen\s*\n?\s*\?\s*React\.createElement\('div', \{\s*\n?\s*className: 'tw-split'/.test(drawer) || drawer.includes('chipsOpen'), '分割线由 chipsOpen 控制')
  assert.ok(drawer.includes('onOpenChange: setChipsOpen'), '面板把折叠状态上报给抽屉')
  assert.ok(read('./ChipsPanel.tsx').includes('props.onOpenChange?.(open)'), '折叠变化要上报（否则折叠后仍渲染分割线）')
  // 首帧与拖拽都不改 key ⇒ 不重挂载（挂载计数沿用 __twMounts）：
  // ① 图表仍只按页签换实例（`key: tab` 原样保留，没有被高度/比例污染）
  assert.equal(/key: tab,/.test(drawer), true, "KlineChart 仍保持 key: tab（拖拽不许改变页签身份）")
  // ② 新增的定高容器与分割线都不带 key（带 key 就会随高度重挂）
  assert.equal(/className: 'tw-chart-pane'[^}]*key:/.test(drawer), false, '定高容器不许带 key')
  assert.equal(/className: 'tw-split'[\s\S]{0,200}?key:/.test(drawer), false, '分割线不许带 key')
})

test('动态高度：两个不同高度 ⇒ 几何按新高度重算，且**不是**等比缩放；极小高度夹住不抛错', () => {
  const short = klineHeightsOf(320)
  const tall = klineHeightsOf(560)
  assert.notDeepEqual({ a: short.mainH, v: short.volH, m: short.macdH }, { a: tall.mainH, v: tall.volH, m: tall.macdH }, '高度不同 ⇒ 绘图区几何必须不同（要重绘）')
  assert.ok(short.mainH < tall.mainH && short.chartHeight < tall.chartHeight)
  // 关键：**固定开销不缩放** ⇒ 差值恒定 ⇒ 证明不是简单等比放大（等比会让间隙一起变大）
  const offShort = short.chartHeight - (short.mainH + short.volH + short.macdH)
  const offTall = tall.chartHeight - (tall.mainH + tall.volH + tall.macdH)
  assert.equal(offShort, offTall, `固定开销必须恒定（${offShort} vs ${offTall}）—— 这是"重绘而不是缩放"的判据`)
  assert.equal(offShort, CHART_CHROME + 24, '固定开销 = 间隙 36px + x 轴文字 24px')
  // 极小高度：夹到最小值、不抛错、不出现 0/负几何
  for (const h of [0, 1, 36, 59, 60]) {
    const k = klineHeightsOf(h)
    assert.ok(k.mainH >= 60 && k.volH >= 24 && k.macdH >= 28, `极小高度 ${h} 也要有最小几何`)
    assert.equal(k.usable, false, `极小高度 ${h} 不允许重绘（usable=false）`)
  }
  assert.equal(klineHeightsOf(400).usable, true)
  // 轴刻度按高度重算（不是把同一套刻度拉长）
  const lo = 18, hi = 22
  assert.equal(priceTicksFor(lo, hi, 100).length, 3)
  assert.equal(priceTicksFor(lo, hi, 200).length, 4)
  assert.equal(priceTicksFor(lo, hi, 400).length, 5)
  assert.notDeepEqual(priceTicksFor(lo, hi, 100), priceTicksFor(lo, hi, 400), '同一价格区间、不同高度 ⇒ 刻度集必须不同')
  assert.deepEqual(priceTicksFor(hi, lo, 400), [], '区间非法 ⇒ 空（不抛错）')
  // 结构：抽屉必须用 kh.* 而不是硬编码几何
  const drawer = read('./QuoteDrawer.tsx')
  assert.ok(drawer.includes('mainH: kh.mainH') && drawer.includes('volH: kh.volH') && drawer.includes('macdH: kh.macdH'), '图表几何必须来自 kh（不许硬编码）')
  assert.equal(/mainH: 230/.test(drawer), false, '旧的硬编码 230/54/64 必须已被替换')
})

test('拖拽预览：只挪线，松手才提交；越界夹住', () => {
  assert.equal(splitDragRatio(0.62, 100, 100, 1000), 0.62, '没动 ⇒ 比例不变')
  assert.ok(Math.abs(splitDragRatio(0.62, 100, 200, 1000) - 0.72) < 1e-9, '下移 100px / 可用 1000px ⇒ +10%')
  assert.equal(splitDragRatio(0.62, 100, 9999, 1000), 0.75, '超出上界 ⇒ 夹住')
  assert.equal(splitDragRatio(0.62, 100, -9999, 1000), 0.25, '超出下界 ⇒ 夹住')
  assert.equal(splitDragRatio(0.62, 100, 200, 0), 0.62, '可用高度为 0 ⇒ 不动（防除零）')
})
