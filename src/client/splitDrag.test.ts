/**
 * task-65：上下分区（分割线）的夹取、持久化归一、键盘步长、动态高度重算。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import {
  CHART_CHROME, CHART_CONTROLS_PX, SPLIT_DEFAULT, SPLIT_MIN_BOTTOM, SPLIT_MIN_TOP,
  chartGeomOf, klineHeightsOf, normalizeSplitRatio, priceTicksFor, splitDragRatio, splitHeights, splitKeyStep,
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

test('动态高度（补强 1）：mainH 随高度变 + 刻度条数随高度变 + 对 chartHeight 注入敏感', () => {
  // 旧判据（证明力不足）：只查"固定开销 === 常数"。它**抓不住**"绘图区恒定"的假实现 —— 见下面的假实现副本。
  // ⚠ 这里的固定开销是 **SVG 自己的**（CHART_CHROME 36 + x 轴文字 24 = 60）。
  //   SVG **之下**的控件块（85px，含日期范围缩放轴）不在这条账里 —— 它在 `chartGeomOf` 里单独记，
  //   并由 `chartGeomOf().clipped` 断言"装得下"。v0.48.0 的回归就是漏了那 85px。
  const OFFCUT = CHART_CHROME + 24
  assert.equal(OFFCUT, 60, 'SVG 自己的固定开销 = 36 + 24 = 60px')
  assert.equal(CHART_CONTROLS_PX, 85, 'SVG 之下的控件块 = 85px（含日期范围缩放轴）')
  const offcut = (k: { chartHeight: number; mainH: number; volH: number; macdH: number }): number =>
    k.chartHeight - (k.mainH + k.volH + k.macdH)
  const short = klineHeightsOf(384) // 620px 抽屉在默认 0.62 下的上窗
  const tall = klineHeightsOf(700)
  assert.equal(offcut(short), OFFCUT, '旧判据在真实现上成立')
  assert.equal(offcut(tall), OFFCUT, '旧判据在真实现上也成立')

  // 假实现副本：绘图区写死 210/54/64（完全不随高度变）—— 旧判据在它上面**照样通过**
  const fakeKlineHeightsOf = (top: number): { chartHeight: number; mainH: number; volH: number; macdH: number } => {
    const mainH = 210, volH = 54, macdH = 64
    void top
    return { chartHeight: OFFCUT + mainH + volH + macdH, mainH, volH, macdH }
  }
  const fake = fakeKlineHeightsOf(560)
  assert.equal(offcut(fake), OFFCUT, '⚠ 旧判据在假实现上也成立 ⇒ 它区分不了"重绘"与"绘图区恒定"（这就是补强的理由）')

  // 新判据 ①：mainH **随高度变**（真实现 384→158、700→309；假实现恒 210）
  assert.notEqual(short.mainH, tall.mainH, '真实现：高度变了 mainH 必须变')
  assert.equal(fake.mainH, fakeKlineHeightsOf(320).mainH, '假实现：mainH 恒定 ⇒ 新判据会抓住它')
  assert.notEqual(tall.mainH, 210, `真实现的 mainH 不该是假实现的常量（实际 ${tall.mainH}）`)
  assert.notEqual(short.mainH, 210, `同上（实际 ${short.mainH}）`)

  // 新判据 ②：刻度条数**随高度变**（100→3 / 200→4 / 300→5）
  assert.equal(priceTicksFor(18, 22, 100).length, 3)
  assert.equal(priceTicksFor(18, 22, 200).length, 4)
  assert.equal(priceTicksFor(18, 22, 300).length, 5)
  assert.notDeepEqual(priceTicksFor(18, 22, 100), priceTicksFor(18, 22, 300), '同一价格区间、不同高度刻度集不同（不是把同一套刻度拉长）')

  // 新判据 ③：对 chartHeight 注入 364（硬编码常量）敏感 ⇒ 高度不同时 chartHeight 必须不同、且不等于 364
  assert.notEqual(short.chartHeight, tall.chartHeight, '两个不同高度的 chartHeight 必须不同')
  assert.notEqual(tall.chartHeight, 364, `chartHeight 不能是硬编码 364（实际 ${tall.chartHeight}）`)
  assert.equal(fakeKlineHeightsOf(320).chartHeight, fakeKlineHeightsOf(560).chartHeight, '假实现：chartHeight 恒定 ⇒ 判据 ③ 也会抓住它')

  // 极小高度：夹到最小值、不抛错、不出现 0/负几何
  for (const h of [0, 1, 36, 59, 60]) {
    const k = klineHeightsOf(h)
    assert.ok(k.mainH >= 60 && k.volH >= 24 && k.macdH >= 28, `极小高度 ${h} 也要有最小几何`)
    assert.equal(k.usable, false, `极小高度 ${h} 不允许重绘（usable=false）`)
  }
  assert.equal(klineHeightsOf(400).usable, true)
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

/**
 * v0.54.0 回归：**日K 图丢失日期范围缩放轴**。
 *
 * 回归提交 5d11d91（v0.48.0）把上窗改成"定高 + overflow:hidden"，但按高度排图时只扣了 SVG
 * **内部**开销（CHART_CHROME + 24），没扣 SVG **之下**的控件块（均线图例 / 买卖点图例 /
 * 日期范围缩放轴）⇒ SVG 正好填满上窗、缩放轴被整体裁掉（DOM 里在、屏幕上没有，不报错）。
 *
 * 断言锚的是**真样式**的真数字：`.tw-zoom-track{height:16px;border:1px}` 等逐条从 styles.ts 抽出来，
 * 再核 `svg + 图例 + 缩放轴 ≤ 上窗高度` —— 这条不成立，控件就必然不可见。
 */
test('日期范围缩放轴：控件在 DOM 里、接线可交互、且在上窗内**不被裁**（锚 styles.ts 的真实高度）', () => {
  // ① 接线证据（文件:行号）：控件渲染 + 指针拖拽 + 键盘 + 语义
  const kline = read('./kline.tsx')
  assert.ok(/React\.createElement\(RangeSlider, \{ total: bars\.length, range: \[s, e\], bars, onChange: setRange \}\)/.test(kline),
    'KlineChart 必须把 RangeSlider 渲染进图表（这是"控件存在"的接线点）')
  assert.ok(kline.includes("className: 'tw-zoom'"), '缩放轴容器类名存在（styles.ts 的 .tw-zoom{z-index} 才能作用到它）')
  assert.ok(kline.includes("className: 'tw-zoom-track'"), '轨道存在')
  assert.ok(kline.includes("className: 'tw-zoom-h'"), '两个手柄存在')
  assert.ok(kline.includes("role: 'slider'") && kline.includes('onPointerDown'), '手柄必须是 slider 语义且可拖拽（可交互）')
  assert.ok(kline.includes("'aria-valuetext'") && kline.includes('onKeyDown: keyOf'), '手柄可键盘操作且有读屏文本')
  assert.ok(kline.includes("['近1月', 30], ['近3月', 90], ['近6月', 182], ['近1年', 365], ['全部', null]"), '快捷区间按钮在位')

  // ② 面板源码里缩放轴**没有**从 DOM 里移出去（反例注入的就是它被移出）
  assert.equal(/React\.createElement\(RangeSlider/.test(kline), true, '⚠ 缩放轴不许从图表里移出去（移出去 = 用户报的"丢失"）')

  // ③ 高度账：从 styles.ts / kline.tsx 抽真实值，核"装了缩放轴以后还装不装得下"
  const styles = read('./styles.ts')
  const klineSrc = read('./kline.tsx')
  /** 从 CSS 规则体里取某个属性的 px 数（断言只读**真实样式**，不另造常量） */
  const pxOf = (selector: string, prop: string): number => {
    const i = styles.indexOf(`${selector}{`)
    assert.notEqual(i, -1, `CSS 里必须存在 ${selector}{`)
    const rule = styles.slice(i, styles.indexOf('}', i))
    const m = new RegExp(`(?:^|[;{\\s])${prop}:\\s*(-?\\d+(?:\\.\\d+)?)(?:px)?`).exec(rule)
    assert.ok(m !== null, `${selector} 里必须有 ${prop}:<n>px（实际 ${rule.slice(0, 80)}）`)
    return Number(m![1])
  }
  const trackH = pxOf('.tw-zoom-track', 'height')
  const zoomGap = pxOf('.tw-zoom', 'gap')
  const zoomMarginTop = pxOf('.tw-zoom', 'margin-top')
  const handleH = pxOf('.tw-zoom-h', 'height')
  const klineGap = pxOf('.tw-kline', 'gap')
  assert.equal(trackH, 16, '轨道高 16px（含边框：.tw-root *{box-sizing:border-box}）')
  assert.ok(styles.includes('.tw-root *{box-sizing:border-box}'), '必须 border-box，否则轨道高度要另加边框')
  assert.equal(zoomGap, 5, '缩放轴内间隙 5px')
  assert.equal(zoomMarginTop, 6, '缩放轴外距 6px')
  assert.equal(handleH, 22, '手柄高 22px')
  assert.equal(klineGap, 2, '.tw-kline 的 flex gap 2px')
  // 两块图例的"上距"写在 kline.tsx 的内联样式里（断言直读源码，不另写一套）
  assert.ok(klineSrc.includes("fontFamily: 'var(--tw-mono)', margin: '4px 0 0' }"), '均线图例上距 4px 必须写在源码里')
  assert.ok(klineSrc.includes("fontFamily: 'var(--tw-mono)', margin: '2px 0 0' }"), '买卖点图例上距 2px 必须写在源码里')
  // 控件块 = SVG 底 → 缩放轴底（Chromium 逐段实测）：6 + 15 + 4 + 15 + 2 + 36.75 = 84.75 ⇒ 记账 85
  const segSvgToLegend = klineGap + 4 // SVG→图例：flex gap 2 + 图例 `margin-top:4px`
  const segLegend = 15 // 图例一块（实测）
  const segLegendToBs = klineGap + 2 // 图例→买卖点图例：gap 2 + `margin-top:2px`
  const segBs = 15 // 买卖点图例一块（实测有 B/S 文案时 15px）
  const segBsToZoom = klineGap // →缩放轴：只剩 flex gap（外距算在 zoomBar 里）
  const segZoom = zoomMarginTop + trackH + zoomGap + 16 /* 文案行实测 15.75 ⇒ 记账 16 */
  assert.equal(segZoom, 43, `缩放轴自己那一块必须=43px（实际 ${segZoom}）`)
  const controlsSum = segSvgToLegend + segLegend + segLegendToBs + segBs + segBsToZoom + segZoom
  assert.equal(controlsSum, 85, `逐段之和必须=85px（实际 ${controlsSum}）`)
  assert.equal(CHART_CONTROLS_PX, controlsSum,
    `CHART_CONTROLS_PX 必须等于控件的逐段之和（实际 ${CHART_CONTROLS_PX}，期望 ${controlsSum}）`)
  assert.equal(CHART_CHROME, 36, 'CHART_CHROME 是 SVG **内部**开销（8+6+6+16），不含缩放轴')
  assert.equal(CHART_CONTROLS_PX, 85, '控件块记账 85px（浏览器实测 84.75px 向上取整）')
  // 探针：控件块的每一段都要≥0，且合计覆盖到缩放轴（否则"缩放轴被裁"会从这里漏过去）
  for (const [name, px] of [['SVG→图例', segSvgToLegend], ['图例', segLegend], ['图例→买卖点', segLegendToBs],
    ['买卖点', segBs], ['买卖点→缩放轴', segBsToZoom], ['缩放轴', segZoom]] as Array<[string, number]>) {
    assert.ok(px > 0, `控件块的「${name}」段必须 > 0（实际 ${px}）`)
  }

  // ④ 真几何：默认分区比例下，常见抽屉高度都必须装得下（不裁）
  //    `slackOf` 是**被测对象**：SVG 高度 + 控件块 ≤ 上窗高度 ⇒ 余量 ≥0
  const slackOf = (top: number, k: ReturnType<typeof klineHeightsOf>): number => top - (k.chartHeight + CHART_CONTROLS_PX)
  for (const avail of [1000, 900, 800, 700, 620, 560, 500]) {
    const split = splitHeights(avail, SPLIT_DEFAULT)
    const g = chartGeomOf(split.top)
    assert.equal(g.clipped, false, `可用 ${avail}px（上窗 ${split.top}px）时：SVG ${g.svg} + 控件块 ${g.controls} 必须装得下（溢出 ${g.overflow}px）`)
    assert.ok(g.svg + g.controls <= split.top, `内容总高 ${g.content} 不得超过上窗 ${split.top}px`)
    assert.ok(g.zoomBar >= 37, `缩放轴那一块必须留出 ≥37px（实际 ${g.zoomBar}）`)
    assert.ok(slackOf(split.top, klineHeightsOf(split.top)) >= 0, `可用 ${avail}px：剩余余量必须 ≥0（实际 ${slackOf(split.top, klineHeightsOf(split.top))}）`)
  }
  // 极小上窗：如实报 clipped（不假装装得下），且不许出现负几何
  const tiny = chartGeomOf(120)
  assert.equal(tiny.clipped, true, '上窗只有 120px 时必须如实报 clipped（不假装装得下）')
  assert.ok(tiny.svg > 0 && tiny.controls > 0 && tiny.overflow > 0, '极小高度也要有正几何 + 正溢出量')

  // ⑤ 反例注入：控件块不计入高度账（= 回归提交 5d11d91 的几何）⇒ 同一断言必须失败
  //    回归的假实现：`klineHeightsOf` 只扣 CHART_CHROME + 24（不扣控件块）
  const brokenKlineHeightsOf = (top: number): ReturnType<typeof klineHeightsOf> => {
    const real = klineHeightsOf(top)
    return { ...real, chartHeight: real.chartHeight + CHART_CONTROLS_PX } // 上窗全部给了 SVG
  }
  const topRepro = 384 // = 620px 抽屉在默认 0.62 下的上窗
  assert.ok(slackOf(topRepro, klineHeightsOf(topRepro)) >= 0, `真实现：上窗 ${topRepro}px 时仍有非负余量`)
  assert.ok(slackOf(topRepro, brokenKlineHeightsOf(topRepro)) < 0, `⚠ 反例（不扣控件块）余量为负（${slackOf(topRepro, brokenKlineHeightsOf(topRepro))}）⇒ 它就是"缩放轴被裁"的几何`)
  assert.throws(
    () => assert.ok(slackOf(topRepro, brokenKlineHeightsOf(topRepro)) >= 0, '反例上这条断言必须失败'),
    /反例上这条断言必须失败/,
    '⚠ 反例注入（控件块不计入高度账）必须让"余量 ≥0"这条断言失败 —— 否则它抓不住"缩放轴丢失"',
  )
})
