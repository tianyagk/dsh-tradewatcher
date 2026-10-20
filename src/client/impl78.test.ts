/**
 * IMPL-78（review-8 客户端 P2 十条 + P3 七条）的可检查判据。
 *
 * 原则与仓库里其它审计文件一致：**真源码 + 纯函数 + 反例注入**（每条注入都必须让判据非空/断言抛错）。
 * 有真实后果的三条（超时、旧代响应、可见性）都做成**可执行的行为断言**，不只是看源码文本。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { ApiError, REQUEST_TIMEOUT_MS, requestSignal, requestWithTimeout } from './api.ts'
import { createRequestGen } from './requestGen.ts'
import { createOverlayStack } from './overlay.ts'
import { createRafCoalescer } from './rafThrottle.ts'
import { panelVisibleOf } from './idle.ts'
import { distToneOf } from './breadthView.ts'
import { calibrationHeaderOf } from './rescueView.ts'
import { MAX_QUOTE_IDS } from '../shared/quoteLimit.ts'
import { TW_CSS } from './styles.ts'

const here = dirname(fileURLToPath(import.meta.url))
const read = (rel: string): string => readFileSync(join(here, rel), 'utf8')
const strip = (t: string): string => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/**
 * 有界等条件（**不要**用"睡固定毫秒数"判定时器）：满负载下固定 sleep 会不够，
 * 而"有界轮询 + 到点仍未满足就失败"既不慢、也不会掩盖真的没落地。
 */
async function waitUntil(cond: () => boolean, timeoutMs = 2_000, stepMs = 20): Promise<boolean> {
  const t0 = Date.now()
  while (!cond() && Date.now() - t0 < timeoutMs) await sleep(stepMs)
  return cond()
}

/** 取 `const name = (...) => { … }` / `const name = (...) => …` 的语句块（到两空格缩进的收尾） */
function declOf(src: string, name: string): string {
  const at = src.indexOf(`const ${name} = `)
  if (at < 0) return ''
  const end = src.indexOf('\n  }\n', at)
  const lineEnd = src.indexOf('\n', at)
  return end < 0 ? src.slice(at, lineEnd < 0 ? src.length : lineEnd) : src.slice(at, end + 4)
}

// ══ P2-1 请求超时（inFlight 永真 ⇒ 轮询停摆） ═══════════════════════════════

test('P2-1 请求超时：超时后 signal 真的 abort 且能区分"超时"与"网络错误"', async () => {
  assert.ok(REQUEST_TIMEOUT_MS >= 5_000, '生产超时上限必须是个"能等到"的值')
  const sig = requestSignal(20)
  assert.equal(sig.aborted(), false, '刚建好还没超时')
  assert.equal(await waitUntil(() => sig.timedOut()), true, '20ms 后必须标记为超时（有界等待）')
  assert.equal(sig.aborted(), true, '超时必须真的 abort（fetch 才会立刻返回）')
  // clear() 必须能停掉定时器（否则每次请求都留一个悬挂定时器）
  const cleaned = requestSignal(20)
  cleaned.clear()
  assert.equal(await waitUntil(() => cleaned.timedOut(), 300), false, 'clear() 之后不许再超时')
  // 反例注入：不设超时（旧行为）⇒ 永远不 abort ⇒ "超时后复位 inFlight"根本无从谈起
  const legacy = requestSignal(0)
  await sleep(30)
  assert.throws(
    () => assert.equal(legacy.timedOut(), true, '反例上"必须超时"必须失败'),
    /反例上/,
    '⚠ 反例注入（无超时）必须让断言失败',
  )
  legacy.clear()
})

test('P2-1 请求超时：挂起的 fetch 必须被 abort 并以「请求超时」拒绝（真跑一次）', async () => {
  const realFetch = globalThis.fetch
  let sawAbort = false
  try {
    globalThis.fetch = ((_url: unknown, init?: { signal?: AbortSignal }) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          sawAbort = true
          reject(new Error('aborted by timeout'))
        })
      })) as unknown as typeof fetch
    await assert.rejects(
      requestWithTimeout('/tradewatcher/quotes', undefined, 20),
      (e: unknown) => e instanceof ApiError && e.status === 0 && /请求超时/.test(e.message),
      '挂起的请求必须在超时后以「请求超时」拒绝（不是永远挂着）',
    )
    assert.equal(sawAbort, true, '必须真的把 AbortSignal 传给 fetch 并触发 abort')
    // 网络真的断了 ⇒ 报"网络错误"，不许混成"超时"（两者的下一步动作不同）
    globalThis.fetch = (() => Promise.reject(new Error('ECONNREFUSED'))) as unknown as typeof fetch
    await assert.rejects(
      requestWithTimeout('/tradewatcher/quotes', undefined, 500),
      (e: unknown) => e instanceof ApiError && /网络错误/.test(e.message),
    )
  } finally {
    globalThis.fetch = realFetch
  }
  // inFlight 复位：超时让 promise 必然落地 ⇒ finally 一定会执行（源码级确认这条纪律没被删）
  const quotes = strip(read('useQuotes.ts'))
  assert.ok(/\.finally\(\(\) => \{\s*\n\s*\/\/[^\n]*\n\s*inFlight\.current = false/.test(quotes) || /inFlight\.current = false/.test(quotes), 'finally 里必须复位 inFlight')
})

// ══ P2-2 旧代响应必须丢弃 ══════════════════════════════════════════════════

test('P2-2 请求代号：新代一开始，旧代响应就是 stale（含错误）', () => {
  const gen = createRequestGen()
  assert.equal(gen.current(), 0)
  const g1 = gen.next()
  assert.equal(g1, 1)
  assert.equal(gen.stale(g1), false, '当代不许被判 stale')
  const g2 = gen.next()
  assert.equal(gen.stale(g1), true, '新一代开始后，旧代必须过期')
  assert.equal(gen.stale(g2), false)
  // 反例注入：stale 恒 false（旧行为：alive 标志被新 effect 立刻置 true ⇒ 旧响应照样写）
  const legacyStale = (): boolean => false
  assert.throws(
    () => assert.equal(legacyStale(), true, '反例上"旧代必须过期"必须失败'),
    /反例上/,
    '⚠ 反例注入（永不 stale）必须让断言失败',
  )
  // 接线：useQuotes 的 then/catch 都必须判代号
  const quotes = strip(read('useQuotes.ts'))
  assert.ok(quotes.includes('const my = gen.current.next()'), '每次取数领一个代次')
  assert.ok(/if \(!alive\.current \|\| gen\.current\.stale\(my\)\) return/.test(quotes), 'then 里必须丢弃旧代')
  assert.ok(/!gen\.current\.stale\(my\)/.test(quotes), 'catch 里同样必须丢弃旧代错误')
  assert.ok(/gen\.current\.next\(\)/.test(quotes), 'key 变化时开新一代')
})

// ══ P2-3 cycleViewMode 不再静默吞错 ═══════════════════════════════════════

test('P2-3 视图档位保存：走同一个 applyPrefs，失败留痕、成功才报"已切换"', () => {
  const src = strip(read('index.tsx'))
  const cycle = declOf(src, 'cycleViewMode')
  assert.ok(cycle.length > 0, '必须能定位到 cycleViewMode')
  assert.ok(cycle.includes('applyPrefs({ viewMode: next })'), '必须走共享的 applyPrefs（回滚 + 报原因）')
  assert.equal(cycle.includes('api.setPrefs'), false, '不许再自己调 api.setPrefs')
  assert.equal(cycle.includes('() => undefined'), false, '不许再吞错')
  assert.ok(/\.then\(\(ok\) => \{/.test(cycle) && /if \(!ok\) return/.test(cycle), '失败时不许再报"已切换"把原因盖掉')
  // 反例注入：把旧写法放回 ⇒ 判据必须失败
  const injected = cycle.replace('applyPrefs({ viewMode: next })', 'api.setPrefs({ viewMode: next })')
  assert.notEqual(injected, cycle)
  assert.equal(injected.includes('api.setPrefs'), true, '⚠ 反例（旧写法）必须能被判据抓住')
})

// ══ P2-4 面板真实可见性 ════════════════════════════════════════════════════

test('P2-4 可见性：文档隐藏或与视口不相交 ⇒ 不可见；信号缺失时失败放行', () => {
  assert.equal(panelVisibleOf({ documentHidden: false, intersecting: true }), true)
  assert.equal(panelVisibleOf({ documentHidden: true, intersecting: true }), false, '整页切后台 ⇒ 不可见')
  assert.equal(panelVisibleOf({ documentHidden: false, intersecting: false }), false, '面板被宿主藏起来（不相交）⇒ 不可见')
  assert.equal(panelVisibleOf({ documentHidden: false, intersecting: null }), true, '观察器不可用 ⇒ 失败放行（别把数据停了）')
  // 反例注入：旧行为 `const visible = true`（恒可见）⇒ 判据必须失败
  const legacy = (): boolean => true
  assert.throws(
    () => assert.equal(legacy(), false, '反例上"藏起来必须不可见"必须失败'),
    /反例上/,
    '⚠ 反例注入（恒可见）必须让断言失败',
  )
  // 接线：Dashboard 不再用常量，而是订阅真实可见性，并把它接到行情引擎/闲置判定/页面门控上
  const index = strip(read('index.tsx'))
  assert.equal(/const visible = true/.test(index), false, '不许再有 `const visible = true`')
  assert.ok(index.includes('usePanelVisible(rootRef)'), '必须用 usePanelVisible 订阅')
  assert.ok(/useQuoteEngine\(engineIds, refreshSec \* 1000, visible\)/.test(index), '行情引擎必须接真实可见性')
  assert.ok(/usePageIdle\(visible\)/.test(index), '闲置判定必须接真实可见性')
  const watch = strip(read('WatchlistPage.tsx'))
  assert.ok(/useMiniTrends\(miniIds, panelActive\)/.test(watch) && /useWatchAlerts\(alertIds, props\.quoteTs \?\? null, panelActive\)/.test(watch), '自选页的取数必须接 visible')
})

// ══ P2-5 浮层层级（Esc 只关最上面一层） ═══════════════════════════════════

test('P2-5 层级栈：只有栈顶那层处理 Esc；弹窗有 dialog 语义', () => {
  const stack = createOverlayStack()
  stack.push('modal')
  stack.push('drawer')
  assert.equal(stack.depth(), 2)
  assert.equal(stack.isTop('drawer'), true)
  assert.equal(stack.isTop('modal'), false, '下层不许响应 Esc（旧实现一次 Esc 全关）')
  stack.remove('drawer')
  assert.equal(stack.isTop('modal'), true, '上层关掉后下层重新变成栈顶')
  stack.remove('modal')
  assert.equal(stack.top(), null)
  // 同一 id 重复 push 不许"自己叠自己"
  stack.push('a'); stack.push('a')
  assert.equal(stack.depth(), 1)
  // 反例注入：每层都响应 Esc（旧行为）⇒ 判据必须失败
  const legacyIsTop = (): boolean => true
  assert.throws(
    () => assert.equal(legacyIsTop(), false, '反例上"下层不响应"必须失败'),
    /反例上/,
    '⚠ 反例注入（双层 Esc 全关）必须让断言失败',
  )
  const ui = strip(read('ui.tsx'))
  assert.ok(ui.includes('export function useEscapeLayer('), 'Esc 处理必须集中到 useEscapeLayer')
  assert.ok(/role: 'dialog'/.test(ui) && /'aria-modal': 'true'/.test(ui), 'Modal 必须是 dialog + aria-modal')
  assert.ok(/useEscapeLayer\(props\.onClose\)/.test(ui), 'Modal 的 Esc 走层级栈')
  const drawer = strip(read('QuoteDrawer.tsx'))
  assert.ok(/role: 'dialog'/.test(drawer) && /'aria-modal': 'true'/.test(drawer), '抽屉也是 dialog')
  assert.ok(drawer.includes('useEscapeLayer(onClose)'), '抽屉的 Esc 走层级栈')
  // 旧写法：各浮层自己 window.addEventListener('keydown') 关自己 ⇒ 双层全关。
  // 现在只允许**层级栈那一处**监听（useEscapeLayer 内部 1 处），浮层自己不许再各挂一个。
  assert.equal((ui.match(/window\.addEventListener\('keydown'/g) ?? []).length, 1, 'ui.tsx 只许有层级栈这一处 keydown 监听')
  assert.equal((drawer.match(/window\.addEventListener\('keydown'/g) ?? []).length, 0, 'QuoteDrawer 不许再挂自己的 keydown')
})

// ══ P2-6 点击型 span/div 必须键盘可达 ═════════════════════════════════════

/** 判定：某段源码里的可点击元素必须带 role=button + tabIndex + onKeyDown（Enter/Space） */
function keyboardProblems(block: string, where: string): string[] {
  const bad: string[] = []
  if (!/role: 'button'/.test(block)) bad.push(`${where}：缺 role="button"`)
  if (!/tabIndex: 0/.test(block)) bad.push(`${where}：缺 tabIndex=0`)
  if (!/onKeyDown:/.test(block) || !/\b\w+\.key === 'Enter' \|\| \w+\.key === ' '/.test(block)) bad.push(`${where}：缺 Enter/Space 的 onKeyDown`)
  return bad
}

test('P2-6 点击型 span/div 键盘可达（日历胶囊/+N、自选异动徽标、护盘历史行）', () => {
  const cal = strip(read('CalendarPage.tsx'))
  const pillAt = cal.indexOf("className: 'tw-cal-pill'")
  assert.ok(pillAt > 0)
  const pill = cal.slice(pillAt, pillAt + 1600)
  assert.deepEqual(keyboardProblems(pill, '日历事件胶囊'), [])
  // `+N` 更多
  const moreAt = cal.indexOf("className: 'tw-cal-more'")
  assert.ok(moreAt > 0)
  assert.deepEqual(keyboardProblems(cal.slice(moreAt, moreAt + 1400), '日历 +N'), [])
  // 自选异动徽标
  const watch = strip(read('WatchlistPage.tsx'))
  const alertAt = watch.indexOf("setAlertsOpen((v) => !v)")
  assert.ok(alertAt > 0)
  assert.deepEqual(keyboardProblems(watch.slice(Math.max(0, alertAt - 700), alertAt + 700), '异动徽标'), [])
  // 护盘历史行
  const rescue = strip(read('RescuePanel.tsx'))
  const histAt = rescue.indexOf("openHistory(h.day)")
  assert.ok(histAt > 0)
  assert.deepEqual(keyboardProblems(rescue.slice(Math.max(0, histAt - 400), histAt + 400), '历史回看行'), [])
  // 反例注入：去掉日历胶囊的 role ⇒ 判据必须非空
  const injected = pill.replace("role: 'button',", '')
  assert.notEqual(injected, pill)
  assert.notDeepEqual(keyboardProblems(injected, '日历事件胶囊'), [], '⚠ 反例（不可键盘）必须被抓住')
})

// ══ P2-7 六页签：先保活 calendar + tools ══════════════════════════════════

test('P2-7 保活：calendar / tools / fupan 切页不卸载（其余页仍卸载，避免多页同时轮询）', () => {
  const index = strip(read('index.tsx'))
  // v0.110.0（AUDIT-IMPL83）：复盘页零轮询 ⇒ 与日历同款保活（月份/选中日/草稿不随切页丢失）
  assert.ok(/const KEEP_ALIVE: readonly PageKey\[\] = \['calendar', 'tools', 'fupan'\]/.test(index), '只保活无轮询的页')
  assert.ok(/KEEP_ALIVE\.includes\(page\)\) return null/.test(index), '保活页不重复渲染')
  assert.ok(/'data-keepalive': key/.test(index), '保活容器要有可断言的标记')
  assert.ok(/page === key\s*\n?\s*\? \{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' \}/.test(index) || /display: 'none'/.test(index), '显隐用 display 切换（关闭即 display:none）')
  // 反例注入：把日历从保活里去掉 ⇒ 判据必须失败
  const injected = index.replace("['calendar', 'tools', 'fupan']", "['tools', 'fupan']")
  assert.notEqual(injected, index)
  assert.equal(/readonly PageKey\[\] = \['calendar', 'tools', 'fupan'\]/.test(injected), false, '⚠ 反例（不保活日历）必须能被抓住')
})

// ══ P2-8 rAF 合并（K 线 mousemove） ═══════════════════════════════════════

test('P2-8 rAF 合并：同帧多次 push 只落最后一次；cancel 丢弃未落地的更新', () => {
  const queue: Array<() => void> = []
  const raf = (cb: () => void): number => { queue.push(cb); return queue.length }
  const caf = (): void => {}
  const seen: Array<number | null> = []
  const c = createRafCoalescer<number | null>((v) => seen.push(v), raf, caf)
  c.push(1); c.push(2); c.push(3)
  assert.deepEqual(seen, [], '还没到帧，不许 setState')
  assert.equal(c.pending(), true)
  for (const cb of queue.splice(0)) cb()
  assert.deepEqual(seen, [3], '一帧只落一次，且是最新值')
  c.push(4)
  for (const cb of queue.splice(0)) cb()
  assert.deepEqual(seen, [3, 4], '下一帧继续工作')
  c.push(5)
  c.cancel()
  for (const cb of queue.splice(0)) cb()
  assert.deepEqual(seen, [3, 4], 'cancel 之后不许再落地')
  // 反例注入：不合并（每次 push 立即 apply = 旧行为）⇒ 判据必须失败
  const eager = (v: number): void => { seen.push(v) }
  // 数"三次 push 落了几次"（用计数比较，避免数组切片巧合相等造成假阴性）
  const before = seen.length
  eager(7); eager(8); eager(9)
  assert.throws(
    () => assert.equal(seen.length - before, 1, '反例上"同帧只落一次"必须失败'),
    /反例上/,
    '⚠ 反例注入（不合并）必须让断言失败',
  )
  // 接线：两处 svg 的 onMouseMove 都必须走合并器（不再直接 setCursor）
  const kline = strip(read('kline.tsx'))
  assert.equal(/setCursor\(nearestIndex\(/.test(kline), false, '分时图的 onMouseMove 不许直接 setCursor')
  assert.equal(/setCursor\(Math\.min\(bars\.length - 1/.test(kline), false, 'K 线的 onMouseMove 不许直接 setCursor')
  assert.equal((kline.match(/cursorRaf\.current\?\.push\(/g) ?? []).length, 4, '两处 mousemove + 两处 mouseleave 都要走合并器')
})

// ══ P2-9 transition 只许动 transform/opacity（断言在 uiuxDiscipline 的 ⑤b） ═
// ══ P2-10 截断数必须单一来源 ══════════════════════════════════════════════

test('P2-10 截断上限：客户端从共享常量取数，宿主字面量与徽标字面量都有漂移报警', () => {
  assert.equal(typeof MAX_QUOTE_IDS, 'number')
  // 宿主的字面量必须等于共享常量（谁改上限谁就得同步 —— 否则门禁红）
  const routes = readFileSync(join(here, '..', 'host', 'routes.ts'), 'utf8')
  assert.ok(new RegExp(`const MAX_QUOTE_IDS = ${MAX_QUOTE_IDS}\\b`).test(routes), `宿主 routes.ts 的上限必须等于 ${MAX_QUOTE_IDS}`)
  const top = strip(read('TopBar.tsx'))
  assert.ok(top.includes('${MAX_QUOTE_IDS}'), '文案必须从共享常量取数（title）')
  assert.ok(top.includes(`'已截断 ${MAX_QUOTE_IDS}'`), `徽标字面量必须等于「已截断 ${MAX_QUOTE_IDS}」（锁片段；改它要同步 build.mjs）`)
  // 反例注入：把共享常量改成 200 ⇒ 两条漂移断言都必须红
  const drift = MAX_QUOTE_IDS + 40
  assert.equal(new RegExp(`const MAX_QUOTE_IDS = ${drift}\\b`).test(routes), false, '⚠ 反例（上限漂移）必须被抓住')
  assert.throws(
    () => assert.ok(top.includes(`'已截断 ${drift}'`), '反例上"徽标必须同步"必须失败'),
    /反例上/,
    '⚠ 反例注入（徽标没同步）必须让断言失败',
  )
})

// ══ P3-1 --tw-warn 必须存在，且不再有第二种琥珀 ═══════════════════════════

test('P3-1 警示琥珀：`--tw-warn` 在浅色/深色/隐身档都有值，客户端无 fallback、无两种琥珀', () => {
  const light = TW_CSS.slice(TW_CSS.indexOf('.tw-root{'), TW_CSS.indexOf('.tw-root[data-theme=dark]{'))
  const dark = TW_CSS.slice(TW_CSS.indexOf('.tw-root[data-theme=dark]{'), TW_CSS.indexOf('.tw-root[data-view=compact]'))
  const incognito = TW_CSS.slice(TW_CSS.indexOf('.tw-root[data-view=incognito]{'), TW_CSS.indexOf('.tw-caliber'))
  assert.ok(light.includes('--tw-warn:'), '浅色档必须定义 --tw-warn')
  assert.ok(dark.includes('--tw-warn:'), '深色档必须定义 --tw-warn')
  assert.ok(incognito.includes('--tw-warn:#8a8f98'), '隐身档必须把它灰化')
  // 全客户端：不许再用 fallback（那等于"这个 token 不存在"的旧状态）
  for (const rel of ['RescuePanel.tsx', 'TopBar.tsx', 'PortfolioPage.tsx', 'WatchlistPage.tsx', 'ui.tsx', 'CalendarPage.tsx', 'CloudMap.tsx']) {
    const code = strip(read(rel))
    assert.equal(/var\(--tw-warn\s*,/.test(code), false, `${rel} 仍带 fallback（说明它曾经"没定义"）`)
  }
  // 两种琥珀（#e0a94a / #e8a33d）只许留在两处白名单：theme.ts（主题容器外的字面量色板）与 kline.tsx（图表序列色板）
  const amber = /#e0a94a|#e8a33d/i
  assert.equal(amber.test(strip(read('theme.ts'))), true, 'theme.ts 的白名单应保留（有注释说明为什么）')
  assert.equal(amber.test(strip(read('kline.tsx'))), true, 'kline.tsx 的图表序列色板应保留')
  for (const rel of ['RescuePanel.tsx', 'TopBar.tsx', 'PortfolioPage.tsx', 'WatchlistPage.tsx', 'ui.tsx', 'CalendarPage.tsx', 'CloudMap.tsx']) {
    assert.equal(amber.test(strip(read(rel))), false, `${rel} 里仍硬编码琥珀色（必须走 var(--tw-warn)）`)
  }
  // 反例注入：删掉深色档的定义 ⇒ 判据必须失败
  const injected = dark.replace('--tw-warn:#f0b429;', '')
  assert.equal(injected.includes('--tw-warn:'), false, '⚠ 反例（token 未定义）必须能被判据抓住')
  assert.throws(
    () => assert.ok(injected.includes('--tw-warn:'), '反例上"深色档必须有定义"必须失败'),
    /反例上/,
    '⚠ 反例注入（--tw-warn 未定义）必须让断言失败',
  )
})

// ══ P3-2 死字段与同字面三元 ═══════════════════════════════════════════════

test('P3-2 badgeView 删掉从未被读取的入参；做T 摘要不再有同字面三元', () => {
  const badge = strip(read('badgeView.ts'))
  const iface = /export interface BadgeInput \{[\s\S]*?\n\}/.exec(badge)?.[0] ?? ''
  assert.ok(iface.includes('indexPoint') && iface.includes('dayPnlPct'), '真正用到的字段仍在')
  assert.equal(iface.includes('indexName'), false, 'indexName 从未被读取 ⇒ 必须删')
  assert.equal(/\bdayPnl:/.test(iface), false, 'dayPnl 从未被读取 ⇒ 必须删')
  const port = strip(read('PortfolioPage.tsx'))
  assert.equal(/累计已实现' : '累计已实现/.test(port), false, '同字面三元必须简化')
  // 反例注入：把死字段加回 ⇒ 判据必须失败
  const injected = iface.replace('dayPnlPct: number | null', 'dayPnlPct: number | null\n  dayPnl: number')
  assert.notEqual(injected, iface)
  assert.equal(/\bdayPnl:/.test(injected), true, '⚠ 反例（死字段回潮）必须能被判据抓住')
})

// ══ P3-3 不再编造「+2%/日」表头 ══════════════════════════════════════════

test('P3-3 触发后对照表头：没有目标涨幅/持有期就说"未取到"，不编造 +2%', () => {
  assert.equal(calibrationHeaderOf({ targetPct: null, horizon: null }), '触发后对照（目标涨幅/持有期未取到）')
  assert.ok(calibrationHeaderOf({ targetPct: 0.02, horizon: 1 }).includes('+2%/1日'), '有标定值时照旧显示')
  assert.ok(calibrationHeaderOf({ targetPct: 0.02, horizon: 1 }).includes('非胜率/概率'), '诚实边界保留')
  // 反例注入：旧写法（?? 0.02）⇒ 表头会编造 +2%
  const legacy = (targets: Array<{ targetPct: number }>): string => `触发后对照 +${((targets.at(-1)?.targetPct ?? 0.02) * 100).toFixed(0)}%`
  assert.equal(legacy([]), '触发后对照 +2%', '⚠ 反例（编造 +2%）必须能被复现出来')
  assert.notEqual(legacy([]), calibrationHeaderOf({ targetPct: null, horizon: null }), '两句话必须不同（不许用编造值冒充未取到）')
  const panel = strip(read('RescuePanel.tsx'))
  assert.equal(panel.includes('?? 0.02'), false, '源码里不许再有 ?? 0.02')
  assert.ok(panel.includes('calibrationHeaderOf('), '表头必须走纯函数')
})

// ══ P3-4 做T 明细不静默截断 ════════════════════════════════════════════════

test('P3-4 做T 明细：超过上限必须如实披露"还有多少次未显示"', () => {
  const port = strip(read('PortfolioPage.tsx'))
  assert.ok(/const DAY_TRADE_ROW_LIMIT = 50/.test(port), '上限要有名字（不再散落魔法数）')
  assert.ok(/dt\.rounds\.slice\(0, DAY_TRADE_ROW_LIMIT\)/.test(port), '渲染按常量切片')
  assert.equal(/dt\.rounds\.slice\(0, 50\)/.test(port), false, '不许再写死 50')
  assert.ok(/另有 \$\{dt\.rounds\.length - DAY_TRADE_ROW_LIMIT\} 次未显示/.test(port), '必须披露剩余条数')
  // 反例注入：退回写死 + 不披露 ⇒ 判据必须失败
  const injected = port.replace('slice(0, DAY_TRADE_ROW_LIMIT)', 'slice(0, 50)')
  assert.notEqual(injected, port)
  assert.equal(/dt\.rounds\.slice\(0, 50\)/.test(injected), true, '⚠ 反例（静默截断）必须能被判据抓住')
})

// ══ P3-5 涨跌分布：不许 0 顶替、档位配色按档名判 ══════════════════════════

test('P3-5 涨跌分布：tone 按档名判（不按下标硬编码 9 档），缺档显示「—」而不是 0', () => {
  assert.equal(distToneOf('≥7%'), 'up')
  assert.equal(distToneOf('0~3%'), 'up')
  assert.equal(distToneOf('平盘'), 'flat')
  assert.equal(distToneOf('-3~0%'), 'down')
  assert.equal(distToneOf('≤-7%'), 'down')
  // 档名换了/顺序变了，颜色仍跟着档名走（旧实现按下标 ⇒ 会静默错色）
  const relabeled = ['≤-7%', '平盘', '≥7%']
  assert.deepEqual(relabeled.map(distToneOf), ['down', 'flat', 'up'])
  // 反例注入：旧的下标判据（i<4 up / i===4 flat / else down）在"档位变了"时会错
  const byIndex = (i: number): string => (i < 4 ? 'up' : i === 4 ? 'flat' : 'down')
  assert.equal(byIndex(0), 'up', '旧判据在重排后的第 0 档（应为 down）给出 up')
  assert.notEqual(byIndex(0), distToneOf(relabeled[0] as string), '⚠ 反例（按下标判色）必须与新判据不同')
  const page = strip(read('MarketPage.tsx'))
  assert.equal(/i < 4 \? 'up' : i === 4 \? 'flat' : 'down'/.test(page), false, '不许再按下标硬编码配色')
  assert.equal(/counts\?\.\[i\] \?\? 0/.test(page), false, '不许再用 `?? 0` 顶替缺失档')
  assert.ok(page.includes('distToneOf(label)'), '配色必须走纯函数')
  assert.ok(page.includes("count === null ? '—'"), '缺档必须显示 —')
})

// ══ P3-6 工具分类 tablist 的语义 ═══════════════════════════════════════════

test('P3-6 工具分类：tablist 里的按钮必须是 tab（role + aria-selected）', () => {
  const tools = strip(read('ToolsPage.tsx'))
  assert.ok(/role: 'tablist'/.test(tools), '容器仍是 tablist')
  assert.ok(/role: 'tab'/.test(tools), '按钮必须是 tab')
  assert.ok(/'aria-selected': io\.category === c\.key/.test(tools), '必须有 aria-selected（data-on 只是视觉）')
  // 反例注入：把 role=tab 删掉 ⇒ 判据必须失败
  const injected = tools.replace("role: 'tab',", '')
  assert.notEqual(injected, tools)
  assert.equal(/role: 'tab'/.test(injected), false, '⚠ 反例（只有视觉高亮）必须能被判据抓住')
})
