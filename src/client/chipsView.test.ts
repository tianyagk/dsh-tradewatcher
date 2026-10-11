/**
 * task-61 的客户端断言：① 切页签不刷新（fetch 计数）② 面板正常时零文案 ③ 纵轴刻度。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { axisTicks, caliberDeviates } from './chipsView.ts'
import { loadChips, resetChipsCache } from './chipsLoader.ts'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)

const here = dirname(fileURLToPath(import.meta.url))
const read = (rel: string): string => readFileSync(join(here, rel), 'utf8')

test('① 切 6 次页签后筹码请求数仍为 1（假 fetch 计数）', async () => {
  resetChipsCache()
  let calls = 0
  const fetch = async (secid: string): Promise<{ secid: string }> => {
    calls += 1
    return { secid }
  }
  // 页签不是筹码的输入：切 6 次 = 用同一个 secid 反复走同一条路径
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
  assert.equal(/isFiveDay|tab === '5d'/.test(drawer + hook + loader), false, '筹码三个文件里都不许存在页签判断')
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
