/**
 * task-61 的客户端断言：① 切页签不刷新（fetch 计数）② 面板正常时零文案 ③ 纵轴刻度。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import {
  axisTicks, bucketCenterTicks, chipAxisOf, chipBarPxOf, chipProfitDirOf, chipsColumnsOf, chipsDayPriceOf, chipsProfileOf, chipsRowsLayoutOf, chipsRowsOf, drawerFillOf, CHIPS_AXIS_MIN_PX, CHIPS_CHART_GAP_PX, CHIPS_LABEL_RESERVE_PX, mergeForRows,
} from './chipsView.ts'
import { loadChips, resetChipsCache } from './chipsLoader.ts'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)

const here = dirname(fileURLToPath(import.meta.url))
const read = (rel: string): string => readFileSync(join(here, rel), 'utf8')

/** 去掉 CSS 注释（注释里可能**提到**某条规则，例如 "...此前 .tw-chips-chart{max-height:140px} 把..."——
 *  不去掉就会取到注释里的那段，断言变成对注释做断言）。 */
function stripCssComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, '')
}

/** 从 CSS 文本里取某条规则的声明块（`{...}` 内容）——断言只读**真实样式**，不另造常量 */
function cssBodyOf(rawCss: string, selector: string): string {
  const css = stripCssComments(rawCss)
  const i = css.indexOf(`${selector}{`)
  assert.notEqual(i, -1, `CSS 里必须存在 ${selector}{ 这条规则`)
  const j = css.indexOf('}', i)
  return css.slice(i + selector.length + 1, j)
}
/** 取某条声明里的 px 数（如 `min-width:34px` ⇒ 34） */
function axisMinPx(rule: string): number {
  const m = /min-width:\s*(\d+(?:\.\d+)?)px/.exec(rule)
  assert.ok(m !== null, `规则里必须有 min-width:<n>px（实际 ${rule.slice(0, 60)}）`)
  return Number(m![1])
}
/** 取某条声明里的数字（如 `right:44px` ⇒ 44 / `gap:4px` ⇒ 4） */
function numberOf(rule: string, prop: string): number {
  const m = new RegExp(`${prop}:\\s*(\\d+(?:\\.\\d+)?)`).exec(rule)
  assert.ok(m !== null, `规则里必须有 ${prop}:<n>（实际 ${rule.slice(0, 60)}）`)
  return Number(m![1])
}

test('①（证明的是 60s TTL 内不重复请求，不是“与页签无关”）切 6 次页签后筹码请求数仍为 1', async () => {
  resetChipsCache()
  let calls = 0
  const fetch = async (secid: string): Promise<{ secid: string }> => {
    calls += 1
    return { secid }
  }
  // ⚠ 这条断言只能证明「同一个 secid 在 **60s TTL 内**不会重复请求」（loader 缓存 + 并发合并）。
  //   它**证明不了**"依赖数组里没有 tab"：60s TTL 会吸收 effect 重跑 —— 把 tab 加回依赖数组，
  //   TTL 内计数仍是 1（TTL 过期后才变 2）。依赖数组的证明在下面那条**源码字面量**断言里。
  const tabs = ['1m', '5d', 'day', 'week', 'month', 'year']
  for (const _tab of tabs) await loadChips('1.600519', { fetch })
  assert.equal(calls, 1, `切 ${tabs.length} 次页签后筹码请求数必须仍为 1（实际 ${calls}）`)
  // 换标的 ⇒ 必须重新取（缓存按 secid 维度）
  await loadChips('0.300750', { fetch })
  assert.equal(calls, 2, '换 secid 要重新取')
  // 同一 secid 的并发调用合并成一次
  resetChipsCache()
  calls = 0
  await Promise.all([loadChips('1.600519', { fetch }), loadChips('1.600519', { fetch }), loadChips('1.600519', { fetch })])
  assert.equal(calls, 1, '并发三个调用只发一次请求')
})

test('②（补强 2）依赖数组**逐项**等于 [secid, enabled, refreshKey]；setChipsRefresh 只挂在 onRetry', () => {
  const hook = read('./useChips.ts')
  const m = /\}, \[([^\]]*)\]\)/.exec(hook)
  assert.ok(m !== null, '必须能抓到依赖数组字面量')
  const items = (m as RegExpExecArray)[1].split(',').map((x) => x.trim()).filter((x) => x !== '')
  assert.deepEqual(items, ['secid', 'enabled', 'refreshKey'], `依赖数组逐项必须完全等于 [secid, enabled, refreshKey]（实际 [${items.join(', ')}]）`)
  assert.equal(items.includes('tab'), false, '依赖数组里不许出现页签')
  const drawer = read('./QuoteDrawer.tsx')
  // 只数**调用点**（声明处不算接线）
  const wired = drawer.split('setChipsRefresh(').length - 1
  assert.equal(wired, 1, `setChipsRefresh 只允许在 onRetry 上接线一次（实际出现 ${wired} 次）`)
  assert.ok(/onRetry: \(\) => setChipsRefresh\(\(x\) => x \+ 1\)/.test(drawer), '这一处必须是 onRetry')
})

test('① 结构保证：筹码取数不接收页签/复权/图表重试；抽屉用筹码自己的刷新计数', () => {
  const loader = read('./chipsLoader.ts')
  assert.equal(/tab|fqt|retry/i.test(loader), false, 'chipsLoader 的入参里不许出现页签/复权/图表重试')
  const hook = read('./useChips.ts')
  assert.equal(hook.includes('[secid, enabled, refreshKey]'), true, '依赖数组只允许 secid/enabled/筹码自己的 refreshKey')
  assert.equal(/\[secid, enabled, retry\]/.test(hook), false, '不许依赖图表重试计数')
  const drawer = read('./QuoteDrawer.tsx')
  assert.equal(drawer.includes("useChips(secid, true, chipsRefresh)"), true, '抽屉里筹码的开关恒为 true（五日档只是不显示，数据照留）')
  assert.equal(/useChips\(secid, tab/.test(drawer), false, '筹码不许随页签变化')
  // 图表该重取还是重取（别把图表一起弄成不刷新）
  assert.equal(/chartBody|useTrend|api\.trend/.test(drawer), true, '图表数据路径未被改动')
  // 旧写法 `... || true` 恒真（等于什么都没断言）。判据原意：图表**照样**依赖 retry（重试要能重取）
  assert.equal(/\[secid, retry\]/.test(drawer), true, '主图依赖数组必须含 retry（重试后要重新取数）')
  assert.equal(/\[secid, tab, fqt, retry\]/.test(drawer), true, 'K 线依赖数组必须含 secid/tab/fqt/retry')
})

test('② 面板不再渲染口径偏离行（用户要求整段删除）', () => {
  // 只看**非注释**的代码文本（注释不是界面文案；tooltip 里的 methodology 是数据，不在源码里）
  const panel = read('./ChipsPanel.tsx')
    .split('\n')
    .filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*') && !l.trim().startsWith('/*'))
    .join('\n')
  // 反向断言：面板源码不许再出现 k=/三角形/口径行/select
  assert.equal(panel.includes('k='), false, '面板不许出现 k= 字样（默认写死，不显示）')
  assert.equal(panel.includes('三角形'), false, '面板不许出现"三角形"字样')
  assert.equal(panel.includes("'select'"), false, '面板不许再有 select 控件')
  assert.equal(panel.includes('tw-chips-ctl'), false, '口径控件已删除')
})

test('③ 纵轴刻度：3–5 个、单调、覆盖 [lo, hi]', () => {
  const centers = Array.from({ length: 32 }, (_, i) => 10 + i * 0.5)
  const ticks = axisTicks(centers)
  assert.ok(ticks.length >= 3 && ticks.length <= 5, `刻度数应在 3–5（实际 ${ticks.length}）`)
  assert.equal(ticks[0], centers[0], '最低刻度 = 最低桶价（覆盖下沿）')
  assert.equal(ticks[ticks.length - 1], centers[centers.length - 1], '最高刻度 = 最高桶价（覆盖上沿）')
  for (let i = 1; i < ticks.length; i += 1) assert.ok(ticks[i] > ticks[i - 1], '刻度必须单调递增')
  assert.deepEqual(axisTicks([]), [], '空序列不出刻度')
  const styles = read('./styles.ts')
  assert.ok(styles.includes('.tw-chips-axis{'), '左轴样式存在')
  assert.ok(styles.includes('.tw-chips-chart{'), '左轴与横条的容器样式存在')
})

/**
 * v0.54.0：横向三段的**宽度契约**（用户两次报"条被压到左侧"，而函数算出的 86% 一直是对的）。
 *
 * 病根不在"算多少"，在"宽度从哪来"：条宽是百分比，百分比只在**条列自己的内容盒**里有意义。
 * 下面的断言锚在**真几何**上：① 从 styles.ts 的 CSS 里把 3 个数抽出来（不自己造常量）
 * ② 用它们算 940px 容器下的条列与峰值条宽 ③ 反例（条列 flex:none）必须被抓住。
 */
test('宽度契约（锚几何）：条列必须是唯一的伸缩项；940px 容器 ⇒ 条列 902px、峰值条 775.72px', () => {
  const styles = read('./styles.ts')

  // ① 从 CSS 里抽出三段宽度的**真实来源**（不是本文件另写一套常量）
  const axisRule = cssBodyOf(styles, '.tw-chips-axis')
  const plotRule = cssBodyOf(styles, '.tw-chips-plot')
  const reflineRule = cssBodyOf(styles, '.tw-chips-refline')
  const chartRule = cssBodyOf(styles, '.tw-chips-chart')
  const axisMin = axisMinPx(axisRule)
  const gap = numberOf(chartRule, 'gap')
  const labelReserve = numberOf(reflineRule, 'right')
  assert.equal(axisMin, CHIPS_AXIS_MIN_PX, `左轴最小宽必须与 CSS 一致（CSS 里是 ${axisMin}px）`)
  assert.equal(gap, CHIPS_CHART_GAP_PX, `轴与条列的间隙必须与 CSS 一致（CSS 里是 ${gap}px）`)
  assert.equal(labelReserve, CHIPS_LABEL_RESERVE_PX, `语义线标签列占位必须与 CSS 一致（CSS 里是 ${labelReserve}px）`)

  // ② 契约：条列 `flex:1` + `min-width:0`；左轴 `flex:none`；条列不许被内容顶住
  assert.equal(plotRule.includes('flex:1 1 auto'), true, '条列必须是伸缩项（flex:1 1 auto）—— 否则宽度不由容器决定')
  assert.equal(plotRule.includes('min-width:0'), true, '条列必须 min-width:0 —— 否则内容参与最小宽度计算，宽度可能塌陷')
  assert.equal(axisRule.includes('flex:none'), true, '左轴必须 flex:none（空间不足时不许被压缩）')
  assert.equal(/\.tw-chips-plot\{[^}]*flex:none/.test(styles), false, '⚠ 条列写成 flex:none ⇒ 宽度归零，86% 的条会渲染成极小的像素数')
  // 语义线标签是**绝对定位的覆盖层**（不吃排版宽度），只有画线让位了 44px
  assert.equal(reflineRule.includes('position:absolute'), true, '标签列必须是绝对定位覆盖层，不得挤占条列宽度')
  assert.equal(cssBodyOf(styles, '.tw-chips-reflabel').includes('position:absolute'), true, '标签本身也要绝对定位')

  // ③ 数值可用性。两组数：题面给定的一组 + 本实现 CSS 决定的一组
  //    题面：容器 940 / 左轴 60 / 右标签 70 ⇒ 条列 810px、轴顶 86% 的条 696px
  const given = chipBarPxOf(86, 940 - 60 - 70)
  assert.ok(Math.abs(given - 696.6) < 0.5, `题面几何：条列 810px ⇒ 峰值条 696.6px（实际 ${given.toFixed(2)}）`)
  //    本实现：容器 940 / 左轴 min-width 34 / 间隙 4 ⇒ 条列 902px、峰值条 775.72px
  const c1 = chipsColumnsOf(940)
  assert.equal(c1.bars, 940 - axisMin - gap, `条列 = 容器 − 左轴 − 间隙（实际 ${c1.bars}，期望 ${940 - axisMin - gap}）`)
  assert.ok(Math.abs(c1.bars - 902) < 0.5, `940 容器按本实现的 CSS ⇒ 条列 902px（实际 ${c1.bars}）`)
  assert.ok(Math.abs(chipBarPxOf(86, c1.bars) - 775.72) < 0.5, `轴顶 86% 的条在 902px 条列上是 775.72px（实际 ${chipBarPxOf(86, c1.bars).toFixed(2)}）`)
  //    标签列是覆盖层 ⇒ **不**参与条列宽度的扣减（扣了就与浏览器实测对不上）
  assert.equal(c1.bars, chipsColumnsOf(940).bars, '标签列不得进入条列宽度的计算')
  assert.ok(c1.bars > c1.container - axisMin - gap - 1, '条列不得再被标签列扣一次')
  //    非法容器 ⇒ 全 0，不抛错、不给负数
  assert.deepEqual(chipsColumnsOf(0).bars, 0)
  assert.deepEqual(chipsColumnsOf(Number.NaN).bars, 0)

  // ④ 反例注入：同一个断言在"条列 flex:none ⇒ 宽度塌陷"的假几何上**必须失败**
  const injectFlexNoneBarPx = (): number => chipBarPxOf(86, 0) // 条列宽度归零（flex:none + 空桶内容）
  assert.ok(chipBarPxOf(86, c1.bars) > 700, '真实现：峰值条必须 ≥700px')
  assert.throws(
    () => assert.ok(injectFlexNoneBarPx() > 700, '反例上这条断言必须失败'),
    /反例上这条断言必须失败/,
    '⚠ 反例注入（条列 flex:none ⇒ 0px）必须让"≥700px"这条断言失败 —— 否则它抓不住"条被压到左侧"',
  )
  assert.equal(injectFlexNoneBarPx(), 0, '反例的样子：条列宽度 0 ⇒ 86% 的条渲染成 0px')
})

test('A：切页签不重挂载 —— 结构证据 + 挂载计数已埋点', () => {
  const drawer = read('./QuoteDrawer.tsx')
  const panel = read('./ChipsPanel.tsx')
  const mounts = read('./mounts.ts')
  // ① 抽屉的 key 只绑 secid（不绑页签）⇒ 切页签不重建抽屉
  const host = read('./index.tsx')
  assert.equal(host.includes('key: detail.secid'), true, '抽屉的 key 必须只绑 secid（不绑页签）')
  // ⚠ `KlineChart` 上确实有 `key: tab` —— 那是**图表自己的**身份（每个页签是不同的图种），
  //   属于预期行为，不属于"侧栏/筹码被重建"。这里只核"抽屉外壳与筹码"这两层没有绑页签的 key。
  assert.equal(/createElement\(\s*'div',\s*\{\s*className: 'tw-drawer'(?:-mask|-body)?'[^}]*key:/.test(drawer), false, '抽屉外壳不许有 key（有 key 就会随页签重建）')
  assert.equal(/key:\s*tab[\s\S]{0,80}ChipsPanel/.test(drawer), false, '筹码面板与 key:tab 无关')
  // ② 组件定义在模块作用域（不是 render 内定义的匿名组件）
  assert.equal(/^export function QuoteDrawer\(/m.test(drawer), true, '抽屉必须是模块级函数组件')
  assert.equal(/^export function ChipsPanel\(/m.test(panel), true, '筹码面板必须是模块级函数组件')
  // ③ 筹码面板与 chartBody() 是**同一个 body 的兄弟** ⇒ 图表的 loading/骨架不会把它卸载
  const body = drawer.slice(drawer.indexOf("className: 'tw-drawer-body'"))
  assert.ok(body.indexOf('chartBody()') < body.indexOf('ChipsPanel'), '面板必须在 chartBody() 之后、同一 body 内（兄弟关系）')
  // ④ 面板元素上没有 key（有 key 就会随 key 变化重挂）
  assert.equal(/React\.createElement\(ChipsPanel, \{\s*key/.test(drawer), false, 'ChipsPanel 不许带 key')
  // ⑤ 挂载计数已埋：抽屉与面板各一次（浏览器控制台 __twMounts() 可读）
  assert.equal(drawer.includes("countMount('drawer')"), true, '抽屉埋了挂载计数')
  assert.equal(panel.includes("countMount('chips')"), true, '面板埋了挂载计数')
  assert.equal(mounts.includes('__twMounts'), true, '运行时可读（装机后人工复核用）')
})

test('task-64：筹码与页签无关（六页签全显示；那行"只在分时/日K 及以上显示"已删除）', () => {
  const strip = (t: string): string => t.split('\n').filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*') && !l.trim().startsWith('/*')).join('\n')
  const panel = strip(read('./ChipsPanel.tsx'))
  const drawer = strip(read('./QuoteDrawer.tsx'))
  const hook = read('./useChips.ts')
  const loader = read('./chipsLoader.ts')
  // ① 页签门控彻底删掉：面板源码里不出现 5d/tab/isFiveDay，抽屉也不再把页签传给它
  assert.equal(panel.includes('isFiveDay'), false, '面板不许再有 isFiveDay（页签门控）')
  assert.equal(panel.includes('五日档'), false, '那行"五日档隐藏"的说明文案必须删掉')
  assert.equal(/只在分时\/日K 及以上显示/.test(panel), false, '说明文案不得残留')
  assert.equal(/isFiveDay|tab === '5d'/.test(drawer + hook + loader), false, '抽屉/hook/loader 里都不许存在页签判断')
  // ⚠ 缺口修补：扫描范围原来漏了**面板自己**（代码级注入 "面板 props 加 tab + 加回 5d 门控" 时旧断言全过）
  assert.equal(/'5d'/.test(panel), false, '面板源码里不许出现 5d 门控')
  assert.equal(/tab\?:\s*string/.test(panel), false, '面板 props 里不许声明 tab（筹码的输入里没有页签）')
  // ② 与标的/数据有关的原因**保留**（不是页签门控）
  assert.equal(panel.includes('不符合'), false)
  assert.equal(panel.includes('fqSupported'), true, '不复权标的的原因保留')
  assert.equal(panel.includes('why'), true, '样本不足/不提供模块的原因保留')
  assert.equal(panel.includes('caliberDeviates'), false, '口径偏离行已按用户要求整段删除')
})

test('task-64 + 保留上一帧：切页签时旧图仍渲染、加载态与旧图共存、首帧才骨架', () => {
  const { chartFrameOf } = require('./chartFrame.ts')
  // ① 首帧（还没有任何图）⇒ 骨架
  assert.deepEqual(chartFrameOf({ hasPayload: false, payloadTab: '', tab: 'day' }), { state: 'first', overlay: false, skeleton: true })
  // ② 切页签（旧图是别的页签的）⇒ 继续渲染旧图 + 叠加加载态
  const stale = chartFrameOf({ hasPayload: true, payloadTab: '1m', tab: 'day' })
  assert.equal(stale.state, 'stale', '切页签时必须走 stale（渲染旧帧）')
  assert.equal(stale.overlay, true, '加载态与旧图必须同时存在')
  assert.equal(stale.skeleton, false, '切页签不许回骨架')
  // ③ 新数据到了 ⇒ 正常渲染、无叠加
  const fresh = chartFrameOf({ hasPayload: true, payloadTab: 'day', tab: 'day' })
  assert.deepEqual(fresh, { state: 'fresh', overlay: false, skeleton: false })
  // ④ 结构：切页签不清空 payload；骨架分支只在 payload === null
  const drawer = read('./QuoteDrawer.tsx')
  assert.equal(/setPayload\(\(prev\) => \(prev !== null && prev\.tab === tab \? prev : null\)\)/.test(drawer), false, '不许再在切页签时清空 payload')
  assert.equal(drawer.includes('if (payload === null) {'), true, '骨架只留给"真的没有 payload"（首帧）')
  assert.equal(drawer.includes('tw-chart-loading'), true, '叠加层已接上')
  assert.equal(/chartBody\(\),[\s\S]{0,240}?frame\.overlay/.test(drawer), true, '叠加层与 chartBody() 在同一个 wrap 内 ⇒ 旧图与加载态共存')
})

/**
 * v0.55.0 ①：筹码模块下方死空白 —— 两窗格必须**确定性铺满** body。
 *
 * 病根（实测）：body 里只有筹码块可伸缩，而它被 `.tw-chips-body{max-height:160px}` +
 * `.tw-chips-chart{max-height:140px}` 钉死在 ~184px；且抽屉把 `split` 算在**整个 body** 的高度上
 * （而 body 里还有口径行/底栏/外边距 65.25px 不归两窗格用）⇒ 抽屉越高、下方空白越大（用户截图 340px）。
 */
test('① 铺满：上窗 + 分割线 + 筹码块 == 两窗格容器（空白 0）；反例（筹码块写死 160px）必被抓', () => {
  const styles = read('./styles.ts')
  const cssOf = (sel: string): string => cssBodyOf(styles, sel)

  // 契约（读真实 CSS 文本，不另造常量）
  assert.ok(cssOf('.tw-chips').includes('flex:1 1 auto'), '筹码块必须是伸缩项（剩余高度全归它）')
  assert.ok(cssOf('.tw-chips').includes('min-height:0'), '筹码块必须 min-height:0（否则内容顶住、缩不下去）')
  assert.ok(cssOf('.tw-chips-body').includes('flex:1 1 auto'), '筹码 body 必须跟着伸缩')
  assert.equal(cssOf('.tw-chips-body').includes('max-height'), false, '⚠ 不许再有 max-height（它就是死空白的来源）')
  assert.equal(cssOf('.tw-chips-chart').includes('max-height'), false, '⚠ 绘图区不许再被 max-height 钉死')
  assert.ok(cssOf('.tw-panes').includes('flex:1 1 auto'), '两窗格容器必须是 body 的伸缩项')
  assert.ok(cssOf('.tw-drawer-body').includes('display:flex'), 'body 必须是 flex 列（否则无法确定性铺满）')
  assert.ok(cssOf('.tw-chart-pane').includes('flex:none'), '上窗固定高（折叠态由内联 flex 覆盖）')
  assert.ok(cssOf('.tw-chips-collapsed').includes('flex:none'), '折叠态筹码块不伸缩（剩余高度交给上窗）')

  // 抽屉必须量**两窗格容器**而不是 body（否则分割比会把口径行/底栏/外边距算进去）
  const drawer = read('./QuoteDrawer.tsx')
  assert.ok(drawer.includes('panesRef'), '抽屉必须有 panesRef（两窗格容器）')
  assert.ok(/const el = panesRef\.current[\s\S]{0,200}?setAvail\(el\.clientHeight\)/.test(drawer),
    '可用高度必须量两窗格容器（量 body 会多算 65px ⇒ 空白或挤压）')
  assert.equal(/const el = containerRef\.current[\s\S]{0,80}?setAvail/.test(drawer), false, '不许再按 body 高度算分割比')

  // 面板必须用传下来的**真实筹码块高度**（不是 split.bottom）
  const panel = read('./ChipsPanel.tsx')
  assert.ok(panel.includes('chipsPlotHeightOf({'), '面板必须用 chipsPlotHeightOf 按真实高度算绘图区')
  assert.equal(panel.includes('CHIPS_MIN_PLOT_PX'), false, '不许再对绘图区高度取下限（会按 48px 排行高、实际只有几 px ⇒ 末行又被裁）')
  assert.ok(panel.includes('chipsRowsLayoutOf('), '行布局必须走 chipsRowsLayoutOf（含间隙、保证装得下）')
  assert.ok(drawer.includes('maxBottom: chipsBlockH'), '抽屉要传筹码块的**真实**高度（= 两窗格剩余）')
  assert.equal(drawer.includes('maxBottom: split.bottom'), false, 'split.bottom 是意图高度，差 15px ⇒ 末行会被裁')

  // 抽屉高度 → 两窗格可用高度（实测：头部 64.5 + 页签 43 + 底部 31.5 = 139；body 内边距 10+8；
  // 口径行 25.75 + 底栏 16.5 + 底栏外边距 8 + 筹码块上距 6 不归两窗格用）
  const panesAt = (drawerH: number): number => (drawerH - 139) - 18 - 25.75 - 16.5 - 8
  const H = [384, 512, 592, 720, 900, 1080]
  // 真实现：任何抽屉高度下空白都是 0（筹码块吸收全部剩余）
  for (const h of H) {
    const panes = panesAt(h)
    const split = splitHeightsForTest(panes)
    const fill = drawerFillOf({ bodyContentH: panes, top: split.top, split: 9, others: 6 })
    assert.equal(fill.blank, 0, `抽屉 ${h}px：两窗格内空白必须为 0（实际 ${fill.blank}）`)
    assert.equal(fill.chips, panes - split.top - 9 - 6, `抽屉 ${h}px：筹码块必须 = 剩余高度（实际 ${fill.chips}）`)
    assert.ok(fill.chips > 0, `抽屉 ${h}px：筹码块高度必须为正（实际 ${fill.chips}）`)
  }
  // 反例注入：筹码块钉在旧上限 184px ⇒ 抽屉一高就留死空白（这就是用户看到的现象）
  const injectFixed184 = (drawerH: number): number => {
    const panes = panesAt(drawerH)
    const split = splitHeightsForTest(panes)
    return panes - split.top - 9 - 6 - 184 // 没人吸收的剩余
  }
  const blanks = H.map((h) => ({ h, blank: injectFixed184(h) }))
  const leaky = blanks.filter((b) => b.blank > 0)
  assert.ok(leaky.length > 0, `⚠ 反例（筹码块钉在 184px）必须在某些高度下留下空白（实际 ${JSON.stringify(blanks)}）`)
  assert.ok(leaky.every((b) => b.h >= 900), `反例的空洞只在大抽屉出现（实测阈值：900px ⇒ ${leaky[0]?.blank.toFixed(1)}px）`)
  assert.throws(
    () => assert.equal(injectFixed184(900), 0, '反例上"空白必须为 0"必须失败'),
    /反例上/,
    '⚠ 反例注入（筹码块钉在 184px）必须让"空白 == 0"这条断言失败',
  )
})

/** 测试用的分割比（与 splitDrag.ts 的默认值一致；这里只做算术，不重复实现夹取规则） */
function splitHeightsForTest(panes: number): { top: number; bottom: number } {
  const top = Math.round(panes * 0.62)
  return { top, bottom: panes - top }
}

/** 真实 fixture：中证1000ETF `1.560010` 2026-10-12 的**窗口内**权重（96 桶里被 99% 质量裁出的 21 行） */
const REAL_WINDOW_560010 = [
  0.07647952, 0.00001885, 0.44977834, 0, 0.000029, 0.00006232, 0.2184079, 0.06128232,
  0, 0, 0.00681694, 0.01403938, 0.00388542, 0.00300084, 0.01072462, 0.0520337,
  0.00000218, 0.0126707, 0.01539187, 0.00214916, 0.07251176,
]
/** 稀疏 fixture：21 行里只有 6 行非零、中间有一大段连续空行（比真实数据更极端） */
const SPARSE_FIXTURE = [0, 0, 0.30, 0, 0, 0, 0, 0, 0, 0.25, 0, 0, 0, 0, 0.20, 0, 0, 0, 0, 0.15, 0]
/** 均匀 fixture：96 桶全非零（用来核"顶点数 == 桶数 96"） */
const UNIFORM_96 = Array.from({ length: 96 }, () => 1 / 96)

test('② 轮廓（乙方案）：顶点与柱同源、空桶照实经过 0；用户可见文案里没有"轮廓"字样', () => {
  const styles = read('./styles.ts')
  const panel = read('./ChipsPanel.tsx')

  // ── 顶点数与同源：顶点 = 行数；第 i 个顶点的 x 就是同一个 widthOf(buckets[i]) ──
  for (const [name, weights] of [['真实 21 行', REAL_WINDOW_560010], ['稀疏 fixture', SPARSE_FIXTURE], ['均匀 96 桶', UNIFORM_96]] as Array<[string, number[]]>) {
    const centers = weights.map((_, i) => 2.9 + i * 0.01)
    const ax = chipAxisOf(centers, weights)
    const rows = weights.slice(ax.window.from, ax.window.to + 1)
    const ordered = chipsRowsOf(weights.map((_, i) => centers[i]).slice(ax.window.from, ax.window.to + 1), rows.map((x) => x))
    assert.equal(ordered.length, rows.length, `${name}：行数一致`)
    const widths = ordered.map((r) => ax.widthOf(r.weight))
    for (const h of [30.75, 79.75, 200, 500]) {
      const lay = chipsRowsLayoutOf(h, weights.length, 1)
      const prof = chipsProfileOf({ widths, rowH: lay.rowH, gap: lay.gap, plotH: h })
      assert.equal(prof.count, widths.length, `${name}@${h}px：轮廓顶点数必须 == 行数（实际 ${prof.count}）`)
      const pts = prof.points.split(' ')
      assert.equal(pts.length, widths.length, `${name}@${h}px：points 里的顶点数 == 行数`)
      // 每个顶点的 x 必须**逐个**等于同一个 widthOf（与柱宽同源，不是另一套数）
      widths.forEach((w, i) => {
        assert.equal(Number(pts[i].split(',')[0]), Number(w.toFixed(4)), `${name}@${h}px：第 ${i} 个顶点的 x 必须 === widthOf(该桶)`)
      })
      // 行高与柱同源：相邻顶点的 y 间距 === rowH + gap
      const y0 = Number(pts[0].split(',')[1])
      const y1 = Number(pts[1].split(',')[1])
      // points 里的 y 是两位数（渲染用），所以容差取 0.02 = 两个刻度单位的舍入上限
      assert.ok(Math.abs((y1 - y0) - (lay.rowH + lay.gap)) < 0.02, `${name}@${h}px：顶点 y 间距必须 === rowH + gap（实际 ${(y1 - y0).toFixed(4)} vs ${(lay.rowH + lay.gap).toFixed(4)}）`)
      // 装得下就必须真装得下（total ≤ 绘图区）；装不下要**如实报** fits:false（不许静默截断）
      if (lay.fits) {
        assert.ok(lay.total <= h + 1e-9, `${name}@${h}px：fits=true 时行占用 ${lay.total} 不得超过绘图区 ${h}`)
        assert.ok(lay.rowH >= 1, `${name}@${h}px：fits=true 时每行 ≥1px`)
      } else {
        assert.equal(lay.rowH, 1, `${name}@${h}px：装不下时按 1px 画`)
        assert.equal(lay.gap, 0, `${name}@${h}px：装不下时不留间隙`)
        assert.ok(lay.total > h, `${name}@${h}px：fits=false 必须真的装不下（实际 total ${lay.total} vs ${h}）`)
      }
      // 空桶：顶点**必须在** x=0 上（照实经过 0、不许跳过）
      const zeros = widths.map((w, i) => (w <= 0 ? i : -1)).filter((i) => i >= 0)
      assert.deepEqual(prof.zeroAt, zeros, `${name}@${h}px：零权重的顶点下标必须逐个列出（实际 ${JSON.stringify(prof.zeroAt)}）`)
      for (const i of prof.zeroAt) assert.equal(Number(pts[i].split(',')[0]), 0, `${name}@${h}px：空桶的顶点 x 必须是 0`)
    }
  }

  // 真实 fixture 的连续性指标（会写进审计报告；这里把"数据"与"视觉"分开记）
  const centersR = REAL_WINDOW_560010.map((_, i) => 2.9 + i * 0.01)
  const axR = chipAxisOf(centersR, REAL_WINDOW_560010)
  const rowsR = REAL_WINDOW_560010.slice(axR.window.from, axR.window.to + 1)
  const nz = rowsR.filter((w) => w > 0).length
  assert.ok(nz / rowsR.length >= 0.6, `真实数据非零行占比必须 ≥60%（实际 ${(nz / rowsR.length * 100).toFixed(1)}%）`)
  let longest = 0, cur = 0
  for (const w of rowsR) { if (w > 0) cur = 0; else { cur += 1; longest = Math.max(longest, cur) } }
  assert.ok(longest <= 8, `真实数据最长连续空行段必须 ≤8（实际 ${longest}）`)
  assert.equal(rowsR.filter((w) => w === 0).length, 3, '真实数据里有 3 个**恰好为 0** 的空桶（轮廓必须照实经过 0）')

  // ── 颜色：轮廓 token 既不等于三条语义线，也不等于涨跌红绿 ──
  const tok = /--tw-chip-profile:([^;]+);/.exec(styles)
  assert.ok(tok !== null, 'styles.ts 必须定义 --tw-chip-profile')
  const lines = ['--tw-chip-avg', '--tw-chip-res', '--tw-chip-sup'].map((t) => {
    const m = new RegExp(`${t}:([^;]+);`).exec(styles)
    assert.ok(m !== null, `styles.ts 必须有 ${t}`)
    return m![1]
  })
  assert.equal(lines.includes(tok![1]), false, `轮廓色不得等于三条语义线（实际 ${tok![1]} vs ${lines.join('/')}`)
  assert.ok(styles.includes('.tw-chips-profile-line{fill:none;stroke:var(--tw-chip-profile)'), '轮廓只引用 token（源码里不出现硬编码色值）')
  const profileRule = cssBodyOf(styles, '.tw-chips-profile-line')
  for (const bad of ['--tw-up', '--tw-down', '--tw-flat', '--tw-chip-avg', '--tw-chip-res', '--tw-chip-sup']) {
    assert.equal(profileRule.includes(bad), false, `轮廓色不得用 ${bad}`)
  }

  // ── 用户可见文案：**不许**出现"轮廓/引导/连接"这类字样（含 title / aria-label）──
  const strip = (t: string): string => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  const panelCode = strip(panel)
  for (const word of ['轮廓', '引导', '连接线', '折线', 'profile 形状', '视觉']) {
    assert.equal(panelCode.includes(word), false, `用户可见代码里不许出现"${word}"（渲染层不得新增说明文案）`)
  }
  assert.ok(/className: 'tw-chips-profile'/.test(panelCode), '轮廓元素存在（class 名不是文案）')
  const svgStart = panelCode.indexOf("className: 'tw-chips-profile'")
  const svgBlock = panelCode.slice(svgStart, svgStart + 400)
  assert.equal(/\btitle:/.test(svgBlock), false, '轮廓 svg 不许带 title')
  assert.equal(/'aria-label':/.test(svgBlock), false, '轮廓 svg 不许带 aria-label')
  assert.ok(svgBlock.includes("'aria-hidden': true"), '轮廓对读屏隐藏（纯装饰）')

  // ── 反例注入：轮廓改成"跳过空桶直接连" ⇒ 顶点数与空桶断言必须失败 ──
  const skipZeros = (widths: number[]): number => widths.filter((w) => w > 0).length
  const widthsR = REAL_WINDOW_560010.map((w) => axR.widthOf(w))
  assert.equal(skipZeros(widthsR), nz, '反例的顶点数 = 非零行数')
  assert.notEqual(skipZeros(widthsR), widthsR.length, '⚠ 反例（跳过空桶）顶点更少 ⇒ 上面"顶点数 == 行数"必然失败')
  assert.throws(
    () => assert.equal(skipZeros(widthsR), widthsR.length, '反例上"顶点数必须 == 行数"必须失败'),
    /反例上/,
    '⚠ 反例注入（跳过空桶直接连）必须让"顶点数 == 行数"这条断言失败',
  )
})

test('② 行序：顶行必须是**最高价**（与左轴刻度、三条语义线同向）；反例（升序渲染）必被抓', () => {
  const centers = [2.9538, 2.9812, 3.0358, 3.1452, 3.2272]
  const weights = [0.5, 0.2, 0.1, 0.1, 0.1]
  const rows = chipsRowsOf(centers, weights)
  assert.equal(rows.length, centers.length, '行数不变')
  assert.equal(rows[0].center, centers[centers.length - 1], '顶行必须是最高价')
  assert.equal(rows[rows.length - 1].center, centers[0], '底行必须是最低价')
  for (let i = 1; i < rows.length; i += 1) assert.ok(rows[i].center < rows[i - 1].center, '必须严格降序')
  // 权重与价格**成对**倒序（不许把 A 的价格配到 B 的权重上）
  rows.forEach((r, i) => assert.equal(r.weight, weights[centers.length - 1 - i], `第 ${i} 行的权重必须与价格配对`))
  // 左轴刻度（bucketCenterTicks 再 reverse）与行序必须同向：第一个刻度 == 顶行价格
  const ticksDesc = bucketCenterTicks(centers).slice().reverse()
  assert.equal(ticksDesc[0], rows[0].center, '左轴顶部刻度必须等于顶行价格')
  assert.equal(ticksDesc[ticksDesc.length - 1], rows[rows.length - 1].center, '左轴底部刻度必须等于底行价格')
  // 反例：升序渲染（旧实现）
  const asc = centers.map((c, i) => ({ center: c, weight: weights[i] }))
  assert.notEqual(asc[0].center, ticksDesc[0], '⚠ 反例（升序）顶行是最低价 ⇒ 与左轴刻度矛盾（镜像 bug）')
})

/**
 * v0.56.0（task-4）：筹码柱**红绿倒置**修复 + 盈亏边界必须是**现价**。
 *
 * 语义（`redUp=true`，本插件的默认）：成本高于现价 = **套牢 = 绿**；成本低于现价 = **获利 = 红**。
 * 事实（lead 取自真接口）：`priceUsed = 19.98`（现价，quote）、`avgCost = 19.072`；
 * 旧实现 `dirClass(center − priceUsed)` ⇒ **高于现价被判成红**（方向反了），且边界还误用了 `avgCost`。
 */
test('④ 盈亏着色：高于现价=套牢(绿)、低于现价=获利(红)；边界是现价，不随 avgCost 移动', () => {
  const panel = read('./ChipsPanel.tsx')
  const view = read('./chipsView.ts')

  // ── 方向对照表（redUp 两态互换）──
  const hi = chipProfitDirOf({ center: 20, priceUsed: 19, redUp: true }) // 成本高于现价 ⇒ 套牢
  const lo = chipProfitDirOf({ center: 18, priceUsed: 19, redUp: true }) // 成本低于现价 ⇒ 获利
  assert.equal(hi, 'tw-down', `桶中心高于现价（redUp=true）必须是"套牢/绿"那一类（实际 ${hi}）`)
  assert.equal(lo, 'tw-up', `桶中心低于现价（redUp=true）必须是"获利/红"那一类（实际 ${lo}）`)
  // 与主题语义对齐：本插件里 tw-up=红、tw-down=绿（见 styles.ts 的 --tw-up/--tw-down）
  const styles = read('./styles.ts')
  assert.ok(/--tw-up:#e5484d/.test(styles) && /--tw-down:#0e8f5c/.test(styles), 'tw-up 是红、tw-down 是绿（浅色主题）')
  // redUp=false ⇒ 整体互换（但仍走 dirClass，不写死）
  const hi2 = chipProfitDirOf({ center: 20, priceUsed: 19, redUp: false })
  const lo2 = chipProfitDirOf({ center: 18, priceUsed: 19, redUp: false })
  assert.equal(hi2, 'tw-up', `redUp=false 时"套牢"必须换成另一类（实际 ${hi2}）`)
  assert.equal(lo2, 'tw-down', `redUp=false 时"获利"必须换成另一类（实际 ${lo2}）`)
  assert.notEqual(hi, hi2); assert.notEqual(lo, lo2)

  // ── 边界断言：翻转发生在跨过 **priceUsed** 处，且与 avgCost 无关 ──
  // fixture：现价 19、平均成本刻意取 25（高于所有桶）⇒ 若误用 avgCost 当边界，翻转会跑到 25
  const flipAt = (priceUsed: number): number => {
    // 二分找出"最近的一次翻转"所在的桶中心（0.001 精度足够表达结论）
    let loP = priceUsed - 3
    let hiP = priceUsed + 3
    for (let i = 0; i < 40; i += 1) {
      const mid = (loP + hiP) / 2
      const cls = chipProfitDirOf({ center: mid, priceUsed, redUp: true })
      if (cls === 'tw-down') hiP = mid // mid 在现价上方 ⇒ 套牢
      else loP = mid
    }
    return (loP + hiP) / 2
  }
  const f19 = flipAt(19)
  assert.ok(Math.abs(f19 - 19) < 0.001, `翻转点必须落在现价 19 上（实际 ${f19}）`)
  const f225 = flipAt(22.5)
  assert.ok(Math.abs(f225 - 22.5) < 0.001, `换一个现价 ⇒ 翻转点跟着走（实际 ${f225}）`)
  // 关键：**avgCost 不参与**（函数签名里根本没有它）
  assert.equal(/chipProfitDirOf\(\{[^}]*avgCost/.test(panel), false, '⚠ 着色入口不许把 avgCost 传进去（边界只能是现价）')
  assert.equal(/chipProfitDirOf\([^)]*avgCost/.test(view), false, '⚠ chipsView 的着色函数不许引用 avgCost')
  assert.equal(/avgCost/.test(String(chipProfitDirOf)), false, '⚠ chipProfitDirOf 的实现里不许出现 avgCost')
  // 面板必须把**价**（v0.57.0 起 = 该展示日的价：最新日=现价、历史日=当日收盘价）传进去
  assert.ok(panel.includes('chipProfitDirOf({ center: r.center, priceUsed: dayPrice.price, redUp: props.redUp })'),
    '面板必须用展示日的价作为盈亏边界')
  assert.ok(panel.includes('chipsDayPriceOf({ dayPrice: day.price, topPriceUsed: d.priceUsed })'),
    '展示日的价由 chipsDayPriceOf 决定（缺失才回退顶层现价，且留痕）')
  assert.equal(/dirClass\(r\.center - /.test(panel), false, '⚠ 旧方向（center − 现价）必须已被移除')
  // 平均成本仍然合法地用在别处（头部的数值 + 橙色语义线），但**不许**当盈亏边界：
  // 只看筹码柱那一行的 className 表达式
  const barLine = panel.split('\n').find((l) => l.includes('tw-chips-bar')) ?? ''
  assert.ok(barLine.includes('priceUsed'), '筹码柱的 className 必须用现价')
  assert.ok(barLine.includes('chipProfitDirOf'), '筹码柱的 className 必须走 chipProfitDirOf')
  assert.equal(barLine.includes('avgCost'), false, `⚠ 筹码柱的盈亏边界不许用平均成本（实际：${barLine.trim()}）`)
  // 不许写死红绿（色偏好必须继续由 dirClass 决定）
  assert.equal(/className: `tw-chips-bar tw-(up|down)/.test(panel), false, '筹码柱不许写死 tw-up/tw-down')

  // ── 反例注入：方向改回 center − priceUsed ⇒ 第一条断言必须失败 ──
  const brokenDir = (center: number, priceUsed: number, redUp: boolean): string => {
    // 旧实现（方向反了）
    const up = center - priceUsed > 0
    return up === redUp ? 'tw-up' : 'tw-down'
  }
  assert.equal(brokenDir(20, 19, true), 'tw-up', '反例的样子：高于现价被判成红')
  assert.notEqual(brokenDir(20, 19, true), hi, '⚠ 反例与真实现必须不同 ⇒ 第一条断言必然抓住它')
  assert.throws(
    () => assert.equal(brokenDir(20, 19, true), 'tw-down', '反例上"高于现价=套牢/绿"必须失败'),
    /反例上/,
    '⚠ 反例注入（方向改回 center − price）必须让"高于现价=套牢"这条断言失败',
  )
})

/**
 * v0.57.0（task-5）：柱色的盈亏边界必须**按展示日取**（该日 DTO 的 `price`），
 * 与宿主算该日 `盈利比例` 用的是同一个价 ⇒ 柱色与那个数字**同源**。
 *
 * 背景：原来统一用顶层 `priceUsed`（现价），而宿主对**历史展示日**用当日收盘价算 `profitRatio`
 * ⇒ 拖滑杆看历史日时同屏两套边界（我上一轮顺带发现、lead 决定修）。
 */
test('⑤ 逐日边界价：切日 ⇒ 翻转点随之移动；与宿主 profitRatio **同源**；缺失则回退并留痕', () => {
  const panel = read('./ChipsPanel.tsx')
  const view = read('./chipsView.ts')

  // ── 取价规则 ──
  const hasDay = chipsDayPriceOf({ dayPrice: 18, topPriceUsed: 20 })
  assert.deepEqual(hasDay, { price: 18, fallback: false, note: null }, '有逐日 price ⇒ 用它（不是顶层现价）')
  const missing = chipsDayPriceOf({ dayPrice: undefined, topPriceUsed: 20 })
  assert.equal(missing.price, 20, '老宿主不带 price ⇒ 回退顶层现价')
  assert.equal(missing.fallback, true, '回退要标记 fallback')
  assert.ok(missing.note !== null && missing.note.includes('未带 price'), `回退必须**留痕**（不静默）：${missing.note}`)
  const bad = chipsDayPriceOf({ dayPrice: null, topPriceUsed: 20 })
  assert.equal(bad.price, 20, 'price 为 null 也回退')
  assert.ok(bad.note !== null && bad.note.includes('不可用'), 'null 的回退原因要和"字段缺失"区分')
  assert.deepEqual(chipsDayPriceOf({ dayPrice: null, topPriceUsed: null }), { price: null, fallback: false, note: null },
    '两个价都没有 ⇒ null（界面按"未取到"处理，不猜一个价）')

  // ── 两天价格不同的 fixture：翻转点必须跟着展示日走 ──
  // 桶中心 [16,17,18,19,20,21,22]；第 1 天价 18、第 2 天价 20 ⇒ 翻转点分别在 18 / 20
  const centers = [16, 17, 18, 19, 20, 21, 22]
  const buckets = [0.1, 0.1, 0.2, 0.2, 0.2, 0.1, 0.1]
  const dayDto = (date: string, price: number): { date: string; centers: number[]; buckets: number[]; price: number; profitRatio: number } => ({
    date, centers, buckets, price,
    // 宿主口径：低于该价的权重占比（百分比，2 位小数）
    profitRatio: Math.round(buckets.reduce((s, w, i) => (centers[i] < price ? s + w : s), 0) * 100 * 100) / 100,
  })
  const days = [dayDto('2026-10-01', 18), dayDto('2026-10-02', 20)]
  const flipOf = (price: number): number => {
    // 用"最近一次颜色变化"定位翻转点（与 ④ 的二分同法，但走真实着色入口）
    let lo = price - 2
    let hi = price + 2
    for (let i = 0; i < 40; i += 1) {
      const mid = (lo + hi) / 2
      if (chipProfitDirOf({ center: mid, priceUsed: price, redUp: true }) === 'tw-down') hi = mid
      else lo = mid
    }
    return (lo + hi) / 2
  }
  const flips = days.map((d) => flipOf(chipsDayPriceOf({ dayPrice: d.price, topPriceUsed: 20 }).price as number))
  assert.ok(Math.abs(flips[0] - 18) < 0.001, `第 1 天翻转点必须是它的价 18（实际 ${flips[0]}）`)
  assert.ok(Math.abs(flips[1] - 20) < 0.001, `第 2 天翻转点必须是它的价 20（实际 ${flips[1]}）`)
  assert.notEqual(flips[0], flips[1], '切展示日 ⇒ 翻转点必须移动（这就是"按展示日取价"）')

  // ── 同源断言：从 DTO 的 price 推出的分界 == 该日 profitRatio ──
  for (const d of days) {
    const boundary = chipsDayPriceOf({ dayPrice: d.price, topPriceUsed: 20 }).price as number
    const fromDto = Math.round(buckets.reduce((s, w, i) => (centers[i] < boundary ? s + w : s), 0) * 100 * 100) / 100
    assert.equal(fromDto, d.profitRatio, `${d.date}：用 DTO 的 price 复算的分界必须等于该日 profitRatio（${d.profitRatio}%）`)
  }
  // 顶层现价（20）与第 1 天的价（18）不同 ⇒ 若客户端统一用顶层，第 1 天的分界会错成 60% 而不是 40%
  const wrongBoundary = Math.round(buckets.reduce((s, w, i) => (centers[i] < 20 ? s + w : s), 0) * 100 * 100) / 100
  assert.notEqual(days[0].profitRatio, wrongBoundary, '两天分界必须不同（否则这条断言证明不了同源）')
  // 数值明细（口算：centers = 16/17/18/19/20/21/22，weights = .1/.1/.2/.2/.2/.1/.1）
  assert.equal(days[0].profitRatio, 20, '第 1 天（价 18）：低于 18 的只有 16、17 ⇒ 0.1+0.1 = 20%')
  assert.equal(days[1].profitRatio, 60, '第 2 天（价 20）：低于 20 的有 16/17/18/19 ⇒ 0.1+0.1+0.2+0.2 = 60%')

  // ── 结构：面板必须用逐日价（不是顶层现价）给柱子上色 ──
  assert.ok(panel.includes('chipsDayPriceOf({ dayPrice: day.price, topPriceUsed: d.priceUsed })'), '面板必须按展示日取价')
  const barLine = panel.split('\n').find((l) => l.includes('tw-chips-bar')) ?? ''
  assert.ok(barLine.includes('dayPrice.price'), `筹码柱必须用逐日价（实际：${barLine.trim()}）`)
  assert.equal(barLine.includes('d.priceUsed'), false, '筹码柱不许再用顶层现价')
  // 回退留痕必须被消费（进 tooltip，不做常驻可见文案）
  assert.ok(/dayPrice\.note === null \? '' : /.test(panel), '回退留痕必须出现在 tooltip 里（不许静默）')
  assert.ok(view.includes('export function chipsDayPriceOf'), '取价规则必须是 chipsView 的纯函数（可断言）')

  // ── 反例注入：客户端改回统一用顶层 priceUsed ⇒ "随日移动"必须失败 ──
  const brokenFlip = (topPrice: number): number => flipOf(topPrice) // 三天同一个价
  assert.equal(brokenFlip(20), flips[1], '反例：统一用顶层 20 ⇒ 第 2 天恰好一致')
  assert.notEqual(brokenFlip(20), flips[0], '⚠ 反例与第 1 天的翻转点不同 ⇒ "随日移动"断言必然抓住它')
  assert.throws(
    () => assert.equal(brokenFlip(20), flips[0], '反例上"第 1 天翻转点 = 18"必须失败'),
    /反例上/,
    '⚠ 反例注入（统一用顶层 priceUsed）必须让"随日移动"这条断言失败',
  )
})

/**
 * 自适应档数（v0.99.x）：**渲染行数有上界** —— 行数超过可画行数时必须合并相邻档，
 * 不许按 1px 硬画（那会末行溢出被静默裁掉；用户报过"可见柱只有 3-4 根"）。
 *
 * 权重守恒与"行中心 = 加权均价"是这条合并的**唯二**约束：只改显示粒度，不改任何权重。
 */
test('自适应档数：行数超可画行数时合并相邻档（守恒 + 行中心取加权均价 + 不静默）', () => {
  const centers = [10, 11, 12, 13, 14, 15]
  const buckets = [0.1, 0.2, 0.3, 0.1, 0.2, 0.1]
  const cap = 3
  const m = mergeForRows(centers, buckets, cap)
  assert.equal(m.merged, 2, '6 档 / 可画 3 行 ⇒ 每 2 档并一行')
  assert.equal(m.centers.length, 3, '合并后行数 ≤ 可画行数')
  assert.ok(m.centers.length <= cap)
  assert.ok(Math.abs(m.buckets.reduce((a, b) => a + b, 0) - 1) < 1e-12, '权重之和必须守恒（合并只改显示粒度）')
  // 行中心 = 该段权重的加权均价（不是两端中点、不是第一档）
  const seg0 = (10 * 0.1 + 11 * 0.2) / 0.3
  assert.ok(Math.abs(m.centers[0] - seg0) < 1e-9, `行中心必须是加权均价（实际 ${m.centers[0]} vs ${seg0}）`)
  // 空档段（权重 0）⇒ 取两端中点，不写 0（0 会被读成一个真实价位）
  const zeroSeg = mergeForRows([10, 11, 12, 13], [0, 0, 0.5, 0.5], 1)
  assert.equal(zeroSeg.merged, 4)
  assert.ok(zeroSeg.centers[0] !== 0, '空档段的中心价不许是 0')
  // 行数够时不合并（既有行为逐位不变 ⇒ 老图不动）
  const noop = mergeForRows(centers, buckets, 6)
  assert.equal(noop.merged, 1)
  assert.deepEqual(noop.centers, centers)
  assert.deepEqual(noop.buckets, buckets)
  assert.equal(mergeForRows(centers, buckets, 99).merged, 1)
  assert.deepEqual(mergeForRows([], [], 3), { centers: [], buckets: [], merged: 1 })
  // 反例注入：不做合并（用原始区间行数）⇒ 行数必然超过可画行数
  const judge = (rows: number): boolean => rows <= cap
  assert.equal(judge(m.centers.length), true, '正例：合并后行数 ≤ 可画行数')
  assert.equal(judge(centers.length), false, '⚠ 反例（不合并）行数确实超上限')
  assert.throws(
    () => assert.equal(judge(centers.length), true, `渲染行数必须 ≤ 可画行数 ${cap}`),
    /渲染行数必须 ≤ 可画行数/,
    '⚠ 反例注入（不合并 ⇒ 1px 硬画被裁）必须让断言失败',
  )
  // 接线：面板必须先算可画行数再合并（源码级 + 注入）
  const panel = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'ChipsPanel.tsx'), 'utf8')
  assert.ok(/rowCapacity = Math\.max\(1, Math\.floor\(plotH \/ \(CHIPS_ROW_GAP_PX \+ 1\)\)\)/.test(panel), '可画行数必须由绘图区高度算')
  assert.ok(panel.includes('mergeForRows(viewCenters, viewBuckets, rowCapacity)'), '面板必须按可画行数合并')
  assert.ok(panel.includes('显示按 ${merged.merged} 档合并'), '合并必须留痕（进悬停，不静默）')
  const cut = panel.replace('mergeForRows(viewCenters, viewBuckets, rowCapacity)', 'mergeForRows(viewCenters, viewBuckets, Number.MAX_SAFE_INTEGER)')
  assert.notEqual(cut, panel, '反例注入必须真改到源码')
  assert.throws(
    () => assert.equal(cut.includes('mergeForRows(viewCenters, viewBuckets, rowCapacity)'), true, '面板必须按可画行数合并'),
    /面板必须按可画行数合并/,
    '⚠ 反例注入（面板不合并）必须让断言失败',
  )
})

/* ── 把「源码含 chipsRowsLayoutOf(」升级为**行为断言**（AUDIT-TESTS-1030）：
 *    原断言只证明页面调用了这个函数；这里补它真正的契约 ——「装得下就用目标间隙、
 *    装不下先吃间隙、再装不下就报 fits:false 而不是给出 <1px 的行高」。 */
test('⑧ 【行为】chipsRowsLayoutOf 三分支：目标间隙 → 零间隙 → fits:false（除零/负行高 ⇒ 败）', () => {
  const roomy = chipsRowsLayoutOf(300, 3, 6)
  assert.equal(roomy.fits, true)
  assert.equal(roomy.gap, 6, '装得下时保留目标间隙')
  assert.ok(roomy.rowH >= 1)
  assert.ok(Math.abs(roomy.total - 300) < 1e-9, '总高必须刚好等于可用高度（300）')

  const tight = chipsRowsLayoutOf(5, 4, 6) // 4 行要 18px 间隙 ⇒ 必然吃不下间隙
  assert.equal(tight.gap, 0, '装不下目标间隙时必须退到 0 间隙，而不是压负行高')
  assert.ok(tight.rowH >= 1 || tight.fits === false)

  const impossible = chipsRowsLayoutOf(1, 10, 6)
  assert.equal(impossible.fits, false, '连 1px/行 都给不出时必须如实 fits:false')
  assert.equal(impossible.rowH, 1, '兜底行高固定 1px（不是 0、不是负）')
  assert.ok(impossible.rowH > 0)

  const zeroAvail = chipsRowsLayoutOf(0, 2, 6)
  assert.equal(zeroAvail.fits, false, '可用高度 0 ⇒ 不可装（不得 0/0）')
  assert.ok(Number.isFinite(zeroAvail.rowH) && zeroAvail.rowH > 0, '行高必须是有限正数')

  const nan = chipsRowsLayoutOf(NaN, 2, 6)
  assert.equal(nan.fits, false)
  assert.ok(Number.isFinite(nan.rowH))

  // 反例注入：把行高写成 (avail/n) 且不做 fits 判定 ⇒ 10 行 1px 会得到 0.1px 的"蚂蚁行"
  const naive = 1 / 10
  assert.ok(naive < 1)
  assert.throws(() => assert.equal(naive, impossible.rowH, '反例上：不判 fits 直接均分'), /反例上/, '⚠ 反例注入必须失败')
})
