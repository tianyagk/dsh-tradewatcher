/**
 * AUDIT-CLIENT-PERF 客户端 P1 批（P1-1 / P1-3 / P1-4 / P1-5·6·7 + P2-1 / P2-2）的可检查判据。
 *
 * 原则与仓库其它审计文件一致：**真源码 + 纯函数 + 反例注入**。凡是有真实后果的（定时器要不要发请求、
 * 同帧合并几次、旧代响应会不会覆盖新代），都做成**可执行的行为断言**（注入假 api / 假 raf / 乱序响应），
 * 不只看源码文本；源码文本断言只用来钉"接线"（组件确实调了这个纯函数）。
 *
 * 每条源码判据都写成 `xxxProblems(src) ⇒ string[]`：真源码必须 `[]`，注入反例必须非空。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { createRequestGen } from './requestGen.ts'
import { createRafCoalescer } from './rafThrottle.ts'
import { createPrismRefresher, prismRefreshAllowed, type PrismRefreshGate } from './prismRefresh.ts'
import { debugFlagOf } from './debugFlag.ts'
import { panelVisibleOf } from './idle.ts'
import { BREADTH_MIN_INTERVAL_MS, CALL_BUDGET_10MIN, callsInWindowInterval } from './pacing.ts'

const here = dirname(fileURLToPath(import.meta.url))
const read = (rel: string): string => readFileSync(join(here, rel), 'utf8')
/** 去注释（源码断言只认活代码：注释里提到某个词不算接线） */
const strip = (t: string): string => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '')

const PRISM = read('PrismPage.tsx')
const MARKET = read('MarketPage.tsx')

/** 从 `from` 起切到 `to`（不含）：只取某个组件的函数体 */
function sliceBetween(src: string, from: string, to: string): string {
  const at = src.indexOf(from)
  if (at < 0) return ''
  const end = to === '' ? src.length : src.indexOf(to, at + from.length)
  return src.slice(at, end < 0 ? src.length : end)
}

const PRISM_SRC = strip(PRISM)
const MARKET_SRC = strip(MARKET)
const prismRoot = (src: string): string => sliceBetween(src, 'export function PrismPage(', '')
const prismClock = (src: string): string => sliceBetween(src, 'export function AgentClock(', 'export function PrismPage(')
const prismRefreshEffect = (src: string): string => sliceBetween(src, 'const loadAlreadyRan', '}, [isActive, refresh])')
const marketRoot = (src: string): string => sliceBetween(src, 'export function MarketPage(', 'function DetailCard(')
const dwChartSrc = (src: string): string => sliceBetween(src, 'function DwChart(', 'export function MarketPage(')

// ══ P1-1 棱镜 30s 轮询：文档可见 **且** 本页激活 ══════════════════════════

test('P1-1 放行判据：未激活 / 文档隐藏 任一成立都不许刷（含 undefined 反例）', () => {
  assert.equal(prismRefreshAllowed({ active: true, documentHidden: false }), true, '激活 + 可见 ⇒ 放行')
  assert.equal(prismRefreshAllowed({ active: true, documentHidden: true }), false, '文档隐藏（切后台）⇒ 不刷')
  assert.equal(prismRefreshAllowed({ active: false, documentHidden: false }), false, '本页未激活（display:none）⇒ 不刷')
  // 反例注入：`active` 缺失（旧代码收了 props.active 却从不读它）⇒ 必须按"不刷"处理
  const missing = { documentHidden: false } as unknown as PrismRefreshGate
  assert.equal(prismRefreshAllowed(missing), false, '没有 active 信号时不许当成"激活"')
  assert.throws(
    () => assert.equal(prismRefreshAllowed(missing), true, '反例上"缺 active 也放行"必须失败'),
    /反例上/,
    '⚠ 反例注入（缺 active 仍刷）必须让断言失败',
  )
})

test('P1-1 假 api 计数：切走后 60 拍 0 请求；文档隐藏 0 请求；切回立即刷 1 次', () => {
  const hit: number[] = [] // 假 api：只数"到底发了几次 /prism"
  let gate: PrismRefreshGate = { active: false, documentHidden: false }
  const refresher = createPrismRefresher({ read: () => gate, refresh: () => hit.push(Date.now()) })
  // ① 停在别的页签：30s × 30 分钟 = 60 拍
  for (let i = 0; i < 60; i += 1) assert.equal(refresher.tick(), false, '未激活的每一拍都必须被拦下')
  assert.equal(hit.length, 0, '切走后定时器一拍都不许发请求')
  // ② 文档被切到后台（本页仍"激活"）
  gate = { active: true, documentHidden: true }
  for (let i = 0; i < 10; i += 1) refresher.tick()
  assert.equal(hit.length, 0, '文档隐藏时也不许发')
  // ③ 切回本页 ⇒ 立即刷一次
  gate = { active: true, documentHidden: false }
  assert.equal(refresher.activate(), true, '切回必须立即刷一次')
  assert.equal(hit.length, 1)
  refresher.tick()
  assert.equal(hit.length, 2, '激活后仍是每拍一次（30s 节拍不变）')
  // 反例注入：旧守卫只判 document.hidden ⇒ 同样 60 拍会发 60 次
  let legacy = 0
  const legacyTick = (g: PrismRefreshGate): void => { if (!g.documentHidden) legacy += 1 }
  for (let i = 0; i < 60; i += 1) legacyTick({ active: false, documentHidden: false })
  assert.equal(legacy, 60, '⚠ 反例（只判文档隐藏）确实是 60 次 —— 正是被修掉的行为')
  assert.throws(
    () => assert.equal(legacy, 0, '反例上"切走后 0 请求"必须失败'),
    /反例上/,
    '⚠ 反例注入（旧守卫）必须让断言失败',
  )
})

/** 判据：30s 刷新 effect 的接线问题清单 */
function prismRefreshProblems(src: string): string[] {
  const effect = prismRefreshEffect(src)
  const bad: string[] = []
  if (effect.length === 0) return ['找不到 30s 刷新 effect']
  if (!/if \(!isActive\) return undefined/.test(effect)) bad.push('未激活时没有提前返回（仍会建 interval）')
  if (!/createPrismRefresher\(\{/.test(effect)) bad.push('没有走 createPrismRefresher（放行判据没接上）')
  if (!/document\.visibilityState === 'hidden'/.test(effect)) bad.push('没有判文档可见性')
  if (!/setInterval\(\(\) => \{ gate\.tick\(\) \}/.test(effect)) bad.push('定时器回调没走 gate.tick()')
  if (!/if \(!loadAlreadyRan\.current\) gate\.activate\(\)/.test(effect)) bad.push('切回本页没有立即补刷')
  if (!/clearInterval\(id\)/.test(effect)) bad.push('没清 interval（切走后定时器还在跑）')
  return bad
}

test('P1-1 接线：未激活不建 interval、切回补刷、active 与容器可见性都进判据', () => {
  assert.deepEqual(prismRefreshProblems(PRISM_SRC), [])
  const comp = prismRoot(PRISM_SRC)
  assert.match(comp, /const containerVisible = usePanelVisible\(pageRef\)/, '无 active 时必须退化为"容器在视口内"')
  assert.match(comp, /const isActive = props\.active === false \? false : containerVisible/, 'active=false 直接否；其余看容器是否在视口内')
  // 反例注入：删掉提前返回（= 旧的"永远建 interval"）⇒ 判据必须非空
  const injected = prismRefreshEffect(PRISM_SRC).replace('if (!isActive) return undefined', '')
  const full = PRISM_SRC.replace(prismRefreshEffect(PRISM_SRC), injected)
  assert.notEqual(full, PRISM_SRC, '反例注入必须真改到源码')
  assert.notDeepEqual(prismRefreshProblems(full), [], '⚠ 反例（未激活也建定时器）必须被抓住')
})

test('P1-1 无 active 的退化路径：容器不在视口（display:none）⇒ 未激活 ⇒ 不刷', () => {
  // `usePanelVisible` 的纯判定半区：IntersectionObserver 对 display:none 报 isIntersecting:false
  const visible = panelVisibleOf({ documentHidden: false, intersecting: false })
  assert.equal(visible, false, '容器不在视口 ⇒ 不可见')
  assert.equal(prismRefreshAllowed({ active: visible, documentHidden: false }), false, '不可见 ⇒ 不刷')
  // 观察器不可用（null）⇒ 失败放行：宁可多取一次，也不要把数据停了（与 idle.ts 的既有口径一致）
  assert.equal(panelVisibleOf({ documentHidden: false, intersecting: null }), true, '观察器不可用时放行')
  assert.equal(prismRefreshAllowed({ active: true, documentHidden: true }), false, '文档隐藏仍优先拦截')
})

// ══ P1-3 1s 时钟下沉到叶子 ══════════════════════════════════════════════════

/** 判据：根组件直接消费 1s 时钟的问题清单 */
function rootClockProblems(src: string): string[] {
  const root = prismRoot(src)
  if (root.length === 0) return ['找不到 PrismPage 根组件']
  const bad: string[] = []
  if (/useNow\(/.test(root)) bad.push('根组件仍在调用 useNow（秒针每跳重建整个三栏）')
  if (/shClockText\(now\)/.test(root)) bad.push('根组件仍在自己格式化时钟')
  if (!/React\.createElement\(AgentClock, null\)/.test(root)) bad.push('顶栏没有渲染时钟叶子')
  return bad
}

test('P1-3 根组件不再直接 useNow(1000)；时钟 leaf 仍每秒更新', () => {
  assert.ok(prismRoot(PRISM_SRC).includes("'prism-agentdesk'"), '切片必须是真正的根组件（否则断言无意义）')
  assert.deepEqual(rootClockProblems(PRISM_SRC), [])
  const leaf = prismClock(PRISM_SRC)
  assert.ok(leaf.length > 0, '找不到 AgentClock 叶子')
  assert.match(leaf, /useNow\(1000\)/, '时钟叶子必须仍按 1s 更新')
  assert.match(leaf, /shClockText\(now\)/, '时钟叶子必须渲染北京时间')
  assert.match(leaf, /'data-role': 'ad-clock'/, '时钟占位（结构断言/样式挂点）不许丢')
  // 反例注入 ①：把 1s 时钟加回根组件 ⇒ 判据必须非空
  const injectedRoot = PRISM_SRC.replace('const isActive =', 'const now = useNow(1000)\n  const isActive =')
  assert.notEqual(injectedRoot, PRISM_SRC)
  assert.notDeepEqual(rootClockProblems(injectedRoot), [], '⚠ 反例（根组件挂 1s 时钟）必须被抓住')
  // 反例注入 ②：把时钟叶子的 1s 降成 60s ⇒ "时钟仍每秒更新"必须失败
  const slowLeaf = leaf.replace('useNow(1000)', 'useNow(60_000)')
  assert.notEqual(slowLeaf, leaf)
  assert.equal(/useNow\(1000\)/.test(slowLeaf), false, '⚠ 反例（时钟降频）必须能被抓住')
})

// ══ P1-4 汪汪队 mousemove：同帧合并 ≤1 次提交 ═════════════════════════════

type Tip = { x: number; y: number; text: string }

test('P1-4 同帧 5 次移动 ⇒ 最多 1 次提交（且落最后一条）', () => {
  const queue: Array<() => void> = []
  const raf = (cb: () => void): number => { queue.push(cb); return queue.length }
  const commits: Array<Tip | null> = []
  const c = createRafCoalescer<Tip | null>((v) => commits.push(v), raf, () => undefined)
  // 一次 mousemove 序列：同一帧内 5 个事件
  for (let i = 1; i <= 5; i += 1) c.push({ x: i, y: i * 2, text: `第 ${i} 天 份额变化` })
  assert.deepEqual(commits, [], '还没到帧，一次提交都不许有')
  for (const cb of queue.splice(0)) cb()
  assert.equal(commits.length, 1, '同一帧 5 次移动必须只提交 1 次')
  assert.deepEqual(commits[0], { x: 5, y: 10, text: '第 5 天 份额变化' }, '落地的必须是最新一次')
  // 反例注入：直连 setState（旧行为：每次 mousemove 一次提交）⇒ 5 次
  const eager: number[] = []
  const eagerSet = (v: number): void => { eager.push(v) }
  for (let i = 1; i <= 5; i += 1) eagerSet(i)
  assert.equal(eager.length, 5, '⚠ 反例（不合并）确实是 5 次提交 —— 正是被修掉的行为')
  assert.throws(
    () => assert.equal(eager.length, 1, '反例上"同帧只提交一次"必须失败'),
    /反例上/,
    '⚠ 反例注入（不合并）必须让断言失败',
  )
})

/** 判据：悬停提示 state 跑到根组件 / 事件直连 setState 的问题清单 */
function dwTipProblems(src: string): string[] {
  const root = marketRoot(src)
  const chart = dwChartSrc(src)
  const bad: string[] = []
  if (root.length === 0) return ['找不到 MarketPage 根组件']
  if (chart.length === 0) return ['找不到 DwChart 子组件']
  if (/\bsetDwTip\b/.test(root)) bad.push('MarketPage 根组件仍持有悬停 state（每次移动整页重渲）')
  if (!/const \[dwTip, setDwTip\] = React\.useState<DwTipState \| null>\(null\)/.test(chart)) bad.push('提示 state 不在 DwChart 内')
  if (!/createRafCoalescer<DwTipState \| null>\(setDwTip\)/.test(chart)) bad.push('DwChart 没有用 rAF 合并 setDwTip')
  if (!/onMouseMove: dwHover/.test(chart)) bad.push('SVG 的 mousemove 没接合并后的处理函数')
  const handler = sliceBetween(chart, 'const dwHover = (e: React.MouseEvent<SVGSVGElement>)', 'const dwTipEl')
  if (/setDwTip\(/.test(handler)) bad.push('事件处理里直接 setDwTip（没有走 raf.push）')
  if (!/raf\.push\(/.test(handler)) bad.push('事件处理没有把值交给合并器')
  return bad
}

test('P1-4 接线：提示 state 只在 DwChart 内，mousemove 走 raf.push 而不是 setState', () => {
  assert.deepEqual(dwTipProblems(MARKET_SRC), [])
  // 反例注入：把 state 搬回根组件（= 旧结构）⇒ 判据必须非空
  const injected = MARKET_SRC.replace(
    'const openDetail = (secid: string)',
    'const [dwTip, setDwTip] = React.useState<DwTipState | null>(null)\n  const openDetail = (secid: string)',
  )
  assert.notEqual(injected, MARKET_SRC, '反例注入必须真改到源码')
  assert.notDeepEqual(dwTipProblems(injected), [], '⚠ 反例（根组件持有提示 state）必须被抓住')
})

// ══ P1-5 / P1-6 / P1-7 请求代号（乱序响应） ════════════════════════════════

interface Deferred<T> { promise: Promise<T>; resolve: (v: T) => void }
function deferred<T>(): Deferred<T> {
  let resolve: (v: T) => void = () => undefined
  const promise = new Promise<T>((r) => { resolve = r })
  return { promise, resolve }
}
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

test('P1-6 切 scope：旧 scope 的慢响应落地时被丢弃（最终是新 scope 的行）', async () => {
  const run = async (useGen: boolean): Promise<string[]> => {
    const gen = createRequestGen()
    const state = { rows: [] as string[] }
    const inflight: Array<Deferred<string[]>> = []
    const load = (): void => {
      const my = gen.next()
      const d = deferred<string[]>()
      d.promise.then((rows) => {
        if (useGen && gen.stale(my)) return
        state.rows = rows
      })
      inflight.push(d)
    }
    load() // industry
    load() // concept
    inflight[1]!.resolve(['concept-a', 'concept-b']) // 新 scope 先回
    await tick()
    inflight[0]!.resolve(['industry-x']) // 旧 scope 后回（乱序）
    await tick()
    return state.rows
  }
  assert.deepEqual(await run(true), ['concept-a', 'concept-b'], '旧 scope 的响应必须被丢弃')
  // 反例注入：去掉代号（旧行为）⇒ 旧响应覆盖新响应
  assert.deepEqual(await run(false), ['industry-x'], '⚠ 反例（无代号）确实被旧响应覆盖 —— 表头写概念、内容是行业')
})

test('P1-5 连点"加载更多"：同页只追加一次（4 行，不是 6 行）', async () => {
  const run = async (useGen: boolean): Promise<string[]> => {
    const gen = createRequestGen()
    let rows = ['a', 'b']
    const inflight: Array<Deferred<string[]>> = []
    const loadMore = (): void => {
      const my = gen.next()
      const d = deferred<string[]>()
      d.promise.then((r) => {
        if (useGen && gen.stale(my)) return
        rows = [...rows, ...r]
      })
      inflight.push(d)
    }
    loadMore(); loadMore() // 双击：两次请求都带 append
    inflight[0]!.resolve(['c', 'd'])
    inflight[1]!.resolve(['c', 'd'])
    await tick(); await tick()
    return rows
  }
  const rows = await run(true)
  assert.deepEqual(rows, ['a', 'b', 'c', 'd'], '同一页只许追加一次')
  assert.equal(new Set(rows).size, rows.length, '不许出现重复行（重复 key / 重复 40 行的根因）')
  // 反例注入：无代号 ⇒ 两批都追加（6 行、2 行重复）
  const legacy = await run(false)
  assert.equal(legacy.length, 6, '⚠ 反例（无代号）确实是 6 行 —— 旧行为')
  assert.notEqual(new Set(legacy).size, legacy.length, '⚠ 反例必须真的产生重复行')
})

test('P1-7 ETF 详情：连点两只标的，旧代响应不许覆盖新选择', async () => {
  const run = async (useGen: boolean): Promise<{ secid: string | null; price: number | null }> => {
    const gen = createRequestGen()
    const shown: { secid: string | null; price: number | null } = { secid: null, price: null }
    const inflight: Array<Deferred<number>> = []
    const open = (secid: string): void => {
      const my = gen.next()
      shown.secid = secid
      shown.price = null
      const d = deferred<number>()
      d.promise.then((price) => {
        if (useGen && gen.stale(my)) return
        shown.price = price
      })
      inflight.push(d)
    }
    open('510300')
    open('159915')
    inflight[1]!.resolve(2.05) // 新选择先回
    await tick()
    inflight[0]!.resolve(3.91) // 旧选择后回（乱序）
    await tick()
    return shown
  }
  assert.deepEqual(await run(true), { secid: '159915', price: 2.05 }, '标题与数值必须是同一只标的')
  // 反例注入：无代号 ⇒ 标题 159915 / 价格 3.91（510300 的价）
  assert.deepEqual(await run(false), { secid: '159915', price: 3.91 }, '⚠ 反例（无代号）确实串台')
})

/** 判据：三处请求没有统一接入 `createRequestGen` 的问题清单 */
function requestGenProblems(src: string): string[] {
  const bad: string[] = []
  const load = sliceBetween(src, 'const loadBoard = useCallback(', 'useEffect(() => {')
  const open = sliceBetween(src, 'const openDetail = (secid: string)', 'const closeDetail')
  const closeAt = src.indexOf('const closeDetail = ()')
  const close = closeAt < 0 ? '' : src.slice(closeAt, closeAt + 400)
  if (!/const my = boardGen\.current\.next\(\)/.test(load)) bad.push('loadBoard 没领代号')
  if ((load.match(/boardGen\.current\.stale\(my\)/g) ?? []).length < 3) bad.push('loadBoard 的 then/catch/finally 没全判代号')
  if (!/const my = detailGen\.current\.next\(\)/.test(open)) bad.push('openDetail 没领代号')
  if ((open.match(/detailGen\.current\.stale\(my\)/g) ?? []).length < 2) bad.push('openDetail 的 /detail 与 /trend 没全判代号')
  if (!/detailGen\.current\.next\(\(\)\)?/.test(close) && !/detailGen\.current\.next\(\)/.test(close)) bad.push('关闭详情没开新代')
  if (!/disabled: boardLoading/.test(src)) bad.push('"加载更多"在途没禁用')
  if ((src.match(/useRef\(createRequestGen\(\)\)/g) ?? []).length < 2) bad.push('代号器不是"一处一套"（board / detail 各一套）')
  // 不许自研计数器：统一走仓内 createRequestGen
  if (/let\s+(reqId|genId|requestId)\b/.test(src)) bad.push('自研了请求计数器（应与 P1-5/6/7 共用 createRequestGen）')
  return bad
}

test('P1-5/6/7 接线：board / detail 各一套 createRequestGen，旧代一律丢弃', () => {
  assert.ok(marketRoot(MARKET_SRC).length > 0, '找不到 MarketPage 函数体')
  assert.deepEqual(requestGenProblems(MARKET_SRC), [])
  // 反例注入：把 detailGen 的 stale 守卫删掉 ⇒ 判据必须非空
  const injected = MARKET_SRC.replace(/if \(!detailGen\.current\.stale\(my\)\) setDetail/g, 'setDetail')
  assert.notEqual(injected, MARKET_SRC, '反例注入必须真改到源码')
  assert.notDeepEqual(requestGenProblems(injected), [], '⚠ 反例（详情不判代号）必须被抓住')
})

// ══ P2-1 / P2-2 ════════════════════════════════════════════════════════════

/** 判据：`/breadth` 是否退回了"每拍都发" */
function breadthProblems(src: string): string[] {
  const bad: string[] = []
  if (!/api\.breadth\(/.test(src)) bad.push('/breadth 调用点没了（宿主 rowOwnership 门禁会红，见源码注释）')
  if (!/dueByInterval\(tick, breadthAt\.current, BREADTH_MIN_INTERVAL_MS\)/.test(src)) bad.push('/breadth 没有 60s 节流（旧注释只声称过）')
  if (!/\[props\.quoteTs, mkRetry\]/.test(src)) bad.push('节流没挂节拍信号（props.quoteTs）')
  return bad
}

test('P2-1 /breadth：真的按 60s 节流（选"节流"而非"删除"）', () => {
  // 选型理由必须写在源码里：删除会让宿主侧 rowOwnership 门禁红（/breadth 归 market 行，必须有调用点）
  assert.match(MARKET, /\/breadth`：\*\*按 60s 节流\*\*（AUDIT-CLIENT-PERF P2-1/, '必须写清"节流"这个选型')
  assert.match(MARKET, /rowOwnership\.test\.ts/, '理由要指明是哪条门禁挡住了删除')
  assert.match(MARKET, /没有任何一格渲染/, '必须如实标注"页面不渲染这份回包"')
  assert.deepEqual(breadthProblems(MARKET_SRC), [])
  // 模型：静置 10 分钟 60 次 → ≤10 次（`pacing.ts` 的预算就是按这个口径定的）
  assert.equal(callsInWindowInterval(600, 10, BREADTH_MIN_INTERVAL_MS), 10, '60s 节流后 10 分钟只发 10 次')
  assert.equal(callsInWindowInterval(600, 10, 0), 60, '⚠ 反例（不节流）确实是每拍一次 = 60 次')
  assert.ok(callsInWindowInterval(600, 10, BREADTH_MIN_INTERVAL_MS) <= CALL_BUDGET_10MIN.breadth, '必须落在预算内')
  // 反例注入：删掉节流守卫（= 旧行为"每拍都请求"）⇒ 判据必须非空
  const injected = MARKET_SRC.replace('if (!dueByInterval(tick, breadthAt.current, BREADTH_MIN_INTERVAL_MS)) return', '')
  assert.notEqual(injected, MARKET_SRC, '反例注入必须真改到源码')
  assert.notDeepEqual(breadthProblems(injected), [], '⚠ 反例（每拍都请求）必须被抓住')
})

/** 判据：`/marketExtras` 是否默认就发 */
function extrasProblems(src: string): string[] {
  const bad: string[] = []
  if (!/const debugMode = debugFlagOf\(/.test(src)) bad.push('没有 debug 开关')
  const at = src.indexOf('api.marketExtras(')
  if (at < 0) return bad
  const head = src.slice(Math.max(0, at - 600), at)
  if (!/if \(!debugMode\) \{ setExtras\(null\); return undefined \}/.test(head)) bad.push('默认（未开 debug）会发 /marketExtras')
  if (/data-limits/.test(src)) bad.push('仍在挂 data-limits 排障属性')
  return bad
}

test('P2-2 /marketExtras 改为按需：默认不发，只有 ?debug=1 才取', () => {
  // 纯函数真值表（默认关、显式开）
  assert.equal(debugFlagOf(''), false, '没有 query ⇒ 关')
  assert.equal(debugFlagOf(undefined), false, '缺失 ⇒ 关')
  assert.equal(debugFlagOf('?debug=0'), false, 'debug=0 ⇒ 关')
  assert.equal(debugFlagOf('?debug=1'), true, 'debug=1 ⇒ 开')
  assert.equal(debugFlagOf('?a=1&debug=true&b=2'), true, 'debug=true ⇒ 开（在中间也认）')
  assert.equal(debugFlagOf('?debug'), true, '裸 debug ⇒ 开')
  assert.equal(debugFlagOf('?nodebug=1'), false, '不是名为 debug 的键不许误开')
  assert.deepEqual(extrasProblems(MARKET_SRC), [])
  // 反例注入：删掉开关守卫（= 默认请求）⇒ 判据必须非空
  const injected = MARKET_SRC.replace('if (!debugMode) { setExtras(null); return undefined }', '')
  assert.notEqual(injected, MARKET_SRC, '反例注入必须真改到源码')
  assert.notDeepEqual(extrasProblems(injected), [], '⚠ 反例（默认就发 marketExtras）必须被抓住')
})
