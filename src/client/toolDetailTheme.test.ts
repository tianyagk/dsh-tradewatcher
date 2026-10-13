/**
 * 详情页对齐参考版（Arkvol）的**可检查规格**断言：排版层级 / 卡片表面 / 磁贴色标 / 图例 /
 * 绘图区高度契约 / 动效令牌 / 悬停提示框行模型 / 绘图区几何。
 *
 * 依据：`docs/DESIGN-TOOL-PAGE-ALIGN.md`（§2 令牌、§8 绘图区、§9 动效）。
 * 每条断言都跑在**页面真正使用的常量**上（不是另抄一份期望值），并配数据级反例注入证明非恒真；
 * 源码接线与顺序断言在 `toolsPage.test.ts`（同一批，互为补充）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  CARD_SURFACE,
  CHART_STACK,
  CHART_TYPE,
  HERO_TYPE,
  LEGEND_DOT,
  LEGEND_ROW,
  MOTION,
  MOTION_STYLE,
  PLOT,
  RANGE_ON,
  SUMMARY_TYPE,
  SWATCH,
  TILE_SURFACE,
  TOOL_SPACE,
  cardSurfaceProblems,
  chartStackProblems,
  heroTypeProblems,
  legendProblems,
  motionProblems,
  nearestIndex,
  pathStyle,
  plotHeightProblems,
  plotX,
  rangeProblems,
  summaryHierarchyProblems,
  tileProblems,
} from './toolDetailTheme.ts'
import { NOT_FETCHED } from './toolRegistry.ts'
import { hoverRowsOf } from './tools/globalFlowView.ts'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const STYLES = readFileSync(join(ROOT, 'src/client/styles.ts'), 'utf8')

test('① Hero 排版达规格：标题 40–60px/≥700，kicker 大写宽字距且不是胶囊，说明段 14–16 行高松', () => {
  const bad = heroTypeProblems(HERO_TYPE)
  assert.deepEqual(bad, [], `Hero 排版判据未通过：${bad.join(' ／ ')}`)
  // 证据（实际值）
  assert.equal(HERO_TYPE.title.fontSize, 46)
  assert.equal(HERO_TYPE.title.fontWeight, 800)
  assert.equal(HERO_TYPE.kicker.textTransform, 'uppercase')
  assert.equal(HERO_TYPE.kicker.letterSpacing, '0.14em')
  // 反例注入（关掉行为 ⇒ 判据必须非空）
  assert.notDeepEqual(heroTypeProblems({ ...HERO_TYPE, title: { ...HERO_TYPE.title, fontSize: 17 } }), [], '⚠ 标题缩回 17px 必须被抓到')
  assert.notDeepEqual(heroTypeProblems({ ...HERO_TYPE, title: { ...HERO_TYPE.title, fontWeight: 600 } }), [], '⚠ 标题字重降回 600 必须被抓到')
  assert.notDeepEqual(
    heroTypeProblems({ ...HERO_TYPE, kicker: { ...HERO_TYPE.kicker, border: '1px solid var(--tw-border)', background: 'var(--tw-accent-soft)', borderRadius: 6 } }),
    [],
    '⚠ kicker 退回胶囊必须被抓到',
  )
  assert.notDeepEqual(heroTypeProblems({ ...HERO_TYPE, note: { ...HERO_TYPE.note, fontSize: 11.5 } }), [], '⚠ 说明段缩回 11.5px 必须被抓到')
})

test('② 摘要卡层级：标签 12–13px、数值 32–40px/≥700、字号差 ≥ 18', () => {
  const bad = summaryHierarchyProblems(SUMMARY_TYPE)
  assert.deepEqual(bad, [], `摘要卡层级判据未通过：${bad.join(' ／ ')}`)
  assert.ok(SUMMARY_TYPE.value.fontSize - SUMMARY_TYPE.label.fontSize >= 18, '字号差必须 ≥ 18px（参考版层级）')
  // 反例注入
  assert.notDeepEqual(summaryHierarchyProblems({ ...SUMMARY_TYPE, value: { ...SUMMARY_TYPE.value, fontSize: 16, fontWeight: 600 } }), [], '⚠ 数值缩回 16px/600 必须被抓到')
})

test('③ 磁贴：色标 ≥6px 有圆角走主题 token；磁贴细边框/圆角/内边距达标', () => {
  const bad = tileProblems(TILE_SURFACE, SWATCH)
  assert.deepEqual(bad, [], `磁贴判据未通过：${bad.join(' ／ ')}`)
  // 反例注入
  assert.notDeepEqual(tileProblems(TILE_SURFACE, { ...SWATCH, width: 0, height: 0 }), [], '⚠ 色标塌成 0 必须被抓到')
  assert.notDeepEqual(tileProblems(TILE_SURFACE, { ...SWATCH, borderRadius: undefined }), [], '⚠ 色标丢圆角必须被抓到')
  assert.notDeepEqual(tileProblems({ ...TILE_SURFACE, border: 'none' }, SWATCH), [], '⚠ 磁贴丢边框必须被抓到')
})

test('③ 卡片表面：1px 主题边框 + 圆角 ≥12 + 无重阴影 + 内边距 16–20', () => {
  const bad = cardSurfaceProblems(CARD_SURFACE)
  assert.deepEqual(bad, [], `卡片表面判据未通过：${bad.join(' ／ ')}`)
  assert.equal(CARD_SURFACE.boxShadow, 'none', '用户口径：暗底靠边框分层，不靠重阴影')
  assert.equal(TOOL_SPACE.sectionGap >= 20 && TOOL_SPACE.sectionGap <= 28, true, `区块间距必须 20–28px（实得 ${TOOL_SPACE.sectionGap}）`)
  // 反例注入
  assert.notDeepEqual(cardSurfaceProblems({ ...CARD_SURFACE, boxShadow: '0 14px 36px rgba(0,0,0,.5)' }), [], '⚠ 改回重阴影必须被抓到')
  assert.notDeepEqual(cardSurfaceProblems({ ...CARD_SURFACE, border: 'none' }), [], '⚠ 丢边框必须被抓到')
  assert.notDeepEqual(cardSurfaceProblems({ ...CARD_SURFACE, borderRadius: 8 }), [], '⚠ 圆角缩回 8px 必须被抓到')
})

test('④ 图例：居中 + 圆点（宽高相等、50%）+ 名称 11–13px；**在画布上方**（顺序来自 CHART_STACK）', () => {
  const bad = legendProblems(LEGEND_ROW, LEGEND_DOT, CHART_TYPE.legend)
  assert.deepEqual(bad, [], `图例判据未通过：${bad.join(' ／ ')}`)
  assert.deepEqual([...CHART_STACK], ['legend', 'plot'], '渲染顺序契约：图例在上、画布在下')
  assert.deepEqual(chartStackProblems(CHART_STACK), [], '图例必须在画布上方')
  // 反例注入（关掉顺序 ⇒ 判据必须非空）
  assert.notDeepEqual(chartStackProblems(['plot', 'legend']), [], '⚠ 图例挪到画布之后必须被抓到')
  assert.notDeepEqual(chartStackProblems(['legend']), [], '⚠ 画布丢了必须被抓到')
  // 反例注入
  assert.notDeepEqual(legendProblems({ ...LEGEND_ROW, justifyContent: 'flex-start' }, LEGEND_DOT, CHART_TYPE.legend), [], '⚠ 图例不再居中必须被抓到')
  assert.notDeepEqual(legendProblems(LEGEND_ROW, { ...LEGEND_DOT, borderRadius: 2 }, CHART_TYPE.legend), [], '⚠ 色标从圆点退回小矩形必须被抓到')
})

test('④′ 范围控件：三档 + 选中档是浅底圆角块', () => {
  const bad = rangeProblems([90, 180, 365], RANGE_ON)
  assert.deepEqual(bad, [], `范围控件判据未通过：${bad.join(' ／ ')}`)
  assert.notDeepEqual(rangeProblems([90, 180, 365], { ...RANGE_ON, background: 'transparent' }), [], '⚠ 选中档失去浅底必须被抓到')
  assert.notDeepEqual(rangeProblems([90, 180], RANGE_ON), [], '⚠ 少一档必须被抓到')
})

test('A 绘图区高度契约：下限 ≥ 420 + 必须有高度来源（只写 flex 会塌成 1px）', () => {
  const box = { minHeight: PLOT.minHeight, aspectRatio: PLOT.aspectRatio }
  assert.deepEqual(plotHeightProblems(box), [], `绘图区高度判据未通过：${plotHeightProblems(box).join(' ／ ')}`)
  assert.equal(PLOT.minHeight >= 420, true, `下限必须 ≥ 420px（实得 ${PLOT.minHeight}）`)
  // 反例注入（用户点名的两种塌陷写法）
  assert.notDeepEqual(plotHeightProblems({ ...box, minHeight: 160 }), [], '⚠ 写死 160px 必须被抓到')
  assert.notDeepEqual(plotHeightProblems({ minHeight: 0, aspectRatio: '16 / 7' }), [], '⚠ height 塌成 0 必须被抓到')
  assert.notDeepEqual(plotHeightProblems({ flex: 1 }), [], '⚠ 只写 flex:1（历史事故 .tw-chips-plot 形态）必须被抓到')
})

test('B 动效令牌：切档 150–250ms、回放 120–250ms、reduced-motion 有 CSS 媒体查询 + 页面开关', () => {
  const hasMediaQuery = /@media \(prefers-reduced-motion:reduce\)/.test(STYLES) && /\.tw-tool-plot \*/.test(STYLES)
  const hasOffSwitch = /\.tw-tool-plot\[data-anim=off\] \*/.test(STYLES) || /\.tw-tool-plot\[data-anim=off\]\*/.test(STYLES)
  const bad = motionProblems({ rangeMs: MOTION.rangeMs, replayMs: MOTION.replayMs, reducedMotion: MOTION.reducedMotion, hasMediaQuery, hasOffSwitch })
  assert.deepEqual(bad, [], `动效判据未通过：${bad.join(' ／ ')}`)
  assert.equal(String(MOTION_STYLE.fadeIn.animation).includes(`${MOTION.rangeMs}ms`), true, '淡入动画的时长必须来自 MOTION（唯一来源）')
  assert.equal(String(MOTION_STYLE.line.transition).includes(`d ${MOTION.replayMs}ms`), true, '回放跟随必须给 d 一个 transition')
  assert.equal(pathStyle('M 1 1 L 2 2').d, 'path("M 1 1 L 2 2")', '折线路径必须同时交给 CSS（支持 CSS d 的浏览器据此做平滑跟随）')
  // 反例注入
  assert.notDeepEqual(motionProblems({ rangeMs: 400, replayMs: MOTION.replayMs, reducedMotion: MOTION.reducedMotion, hasMediaQuery, hasOffSwitch }), [], '⚠ 切档过渡超时（400ms）必须被抓到')
  assert.notDeepEqual(motionProblems({ rangeMs: MOTION.rangeMs, replayMs: 10, reducedMotion: MOTION.reducedMotion, hasMediaQuery, hasOffSwitch }), [], '⚠ 回放跟随太短（10ms）必须被抓到')
  assert.notDeepEqual(motionProblems({ rangeMs: MOTION.rangeMs, replayMs: MOTION.replayMs, reducedMotion: MOTION.reducedMotion, hasMediaQuery: false, hasOffSwitch }), [], '⚠ 去掉 reduced-motion 媒体查询必须被抓到')
  assert.notDeepEqual(motionProblems({ rangeMs: MOTION.rangeMs, replayMs: MOTION.replayMs, reducedMotion: MOTION.reducedMotion, hasMediaQuery, hasOffSwitch: false }), [], '⚠ 去掉 data-anim=off 开关必须被抓到')
})

test('B 悬停提示框行模型：逐序列给值；缺值写「未取到」；**绝不写 0**；无悬停 ⇒ 空', () => {
  const series = [
    { name: 'A股', points: [12.5, null] },
    { name: '港股', points: [8, 9.25] },
  ]
  const rows = hoverRowsOf(series, 0)
  assert.deepEqual(rows.map((r) => [r.name, r.text]), [['A股', '12.50%'], ['港股', '8.00%']], '有值时必须逐序列给出真实值')
  const missing = hoverRowsOf(series, 1)
  assert.equal(missing[0].text, NOT_FETCHED, '缺值必须写「未取到」')
  assert.equal(missing[0].value, null, '缺值的 value 必须是 null（不是 0）')
  assert.equal(missing.some((r) => r.text.startsWith('0')), false, '⚠ 缺值绝不许写 0')
  assert.equal(rows.length, series.length, '提示框必须**逐序列**列出（有几条序列就几行，不许只列榜首）')
  assert.deepEqual(hoverRowsOf(series, null), [], '没有悬停 ⇒ 不给行（不硬凑一个点）')
  assert.deepEqual(hoverRowsOf(series, -1), [], '非法下标 ⇒ 空')
  // 反例注入：假想一个"缺值写 0"的实现
  const badImpl = series.map((s) => ({ text: s.points[1] === null ? '0.00%' : 'x' }))
  assert.throws(() => assert.equal(badImpl[0].text, NOT_FETCHED, '反例上必须失败'), /反例上/, '⚠ 反例（缺值写 0）必须让"未取到"断言失败')
})

test('A′ 绘图区几何：x 单调、端点贴内边距；悬停带外返回 null（不硬凑端点）', () => {
  const W = 960
  const x0 = plotX(0, 10, W)
  const x9 = plotX(9, 10, W)
  assert.equal(Math.round(x0), PLOT.pad.left, '第一个点贴左内边距')
  assert.equal(Math.round(x9), W - PLOT.pad.right, '最后一个点贴右内边距（纵轴标签区）')
  assert.equal(plotX(5, 10, W) > x0 && plotX(5, 10, W) < x9, true, 'x 单调递增')
  assert.equal(nearestIndex(x9 + 4, 10, W), 9, '靠近右端 ⇒ 最后一个点')
  assert.equal(nearestIndex(-999, 10, W), null, '带外（左侧）⇒ null')
  assert.equal(nearestIndex(W + 999, 10, W), null, '带外（右侧）⇒ null')
  assert.equal(nearestIndex(500, 0, W), null, '没有点 ⇒ null')
})
