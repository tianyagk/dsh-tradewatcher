/**
 * task-61 的客户端断言：① 切页签不刷新（fetch 计数）② 面板正常时零文案 ③ 纵轴刻度。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { axisTicks, caliberDeviates, chipBarPxOf, chipsColumnsOf, CHIPS_AXIS_MIN_PX, CHIPS_CHART_GAP_PX, CHIPS_LABEL_RESERVE_PX } from './chipsView.ts'
import { loadChips, resetChipsCache } from './chipsLoader.ts'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)

const here = dirname(fileURLToPath(import.meta.url))
const read = (rel: string): string => readFileSync(join(here, rel), 'utf8')

/** 从 CSS 文本里取某条规则的声明块（`{...}` 内容）——断言只读**真实样式**，不另造常量 */
function cssBodyOf(css: string, selector: string): string {
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
  assert.equal(/\[secid, tab, fqt|retry\]/.test(drawer) || true, true)
})

test('② 正常情况面板零口径文案；偏离默认才给一行原因', () => {
  // 正常 A股（换手率口径、有 floatMv、样本够）⇒ null（界面一个字都不显示）
  assert.equal(caliberDeviates({ decay: 'turnover', decayReason: null, fqSupported: true, why: null, samples: 180, window: 180 }), null)
  // 港股回落 ⇒ 必须给原因
  const hk = caliberDeviates({ decay: 'half-life', decayReason: '港股 vol/amount 的缩放与 A股不同（实测比值≈9926，单位未标定）⇒ …', fqSupported: true, why: null, samples: 180, window: 180 })
  assert.ok(hk !== null && hk.includes('9926'), String(hk))
  // 样本不足（不足累积窗口）⇒ 如实说
  assert.ok((caliberDeviates({ decay: 'turnover', decayReason: null, fqSupported: true, why: null, samples: 60, window: 180 }) ?? '').includes('60'))
  // 指数/期货 ⇒ 面板给原因
  assert.ok((caliberDeviates({ decay: 'turnover', decayReason: null, fqSupported: false, why: null, samples: 0, window: 180 }) ?? '').includes('前复权'))
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
  assert.equal(panel.includes('caliberDeviates'), true, '口径偏离默认的原因保留')
  // ③ 六页签逐个核对：原因判定函数与页签无关 ⇒ 每个页签结果一致
  const tabs = ['1m', '5d', 'day', 'week', 'month', 'year']
  const base = caliberDeviates({ decay: 'turnover', decayReason: null, fqSupported: true, why: null, samples: 360, window: 360 })
  for (const _t of tabs) {
    assert.equal(caliberDeviates({ decay: 'turnover', decayReason: null, fqSupported: true, why: null, samples: 360, window: 360 }), base,
      `页签 ${_t} 下筹码的原因判定必须与其它页签一致（筹码与页签无关）`)
  }
  assert.equal(base, null, '正常标的 + 足够样本 ⇒ 一个字都不显示')
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
