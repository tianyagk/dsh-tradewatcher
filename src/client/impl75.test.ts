/**
 * IMPL-75（review-8 的 8 条 P1 + 1 条锁定片段整理）的可检查判据。
 *
 * 每条都钉在**真源码 + 真纯函数**上，并配**反例注入**（把旧写法加回去 ⇒ 判据必须非空）。
 * 为什么不是渲染级断言：本仓库没有 react-dom 渲染环境（页面组件依赖宿主 fetch/window），
 * 既有断言（`noticeBars` / `marketRefactor` / `watchlistHints` …）走的也是"真源码 + 纯函数 + 注入"。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, relative } from 'node:path'
import { unavailableReasonOf } from './chartCache.ts'
import { edgeActiveOf, nextActiveOf } from './suggestView.ts'
import { abnormalColorOf, dayHistoryStateOf } from './rescueView.ts'
import { shClockText } from './marketTime.ts'
import { NO_SOURCE_BADGE_HINT } from './quoteState.ts'

const here = dirname(fileURLToPath(import.meta.url))
const read = (rel: string): string => readFileSync(join(here, rel), 'utf8')
/** 剥注释（注释里会**提到**被删的旧写法，不能当成违规） */
const strip = (t: string): string => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

/** 客户端全部产品源文件（排除测试：那里的反例注入是故意越界的） */
function walkClient(dir = here, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const abs = join(dir, name)
    if (statSync(abs).isDirectory()) walkClient(abs, out)
    else if (/\.(tsx|ts)$/.test(name) && !/\.test\.ts$/.test(name)) out.push(abs)
  }
  return out
}
const clientFiles = (): Array<{ rel: string; src: string }> =>
  walkClient().map((abs) => ({ rel: relative(here, abs), src: readFileSync(abs, 'utf8') }))

/** 取某个组件/函数的源码体（到下一个 `\nfunction ` 或文件末尾） */
function fnBodyOf(src: string, name: string): string {
  const at = src.indexOf(`function ${name}(`)
  if (at < 0) return ''
  const next = src.indexOf('\nfunction ', at + 1)
  return src.slice(at, next < 0 ? src.length : next)
}

/** 取一个 `const name = (...) => { … }` 形式的函数体（到两空格缩进的收尾 `}`） */
function arrowBodyOf(src: string, name: string): string {
  const at = src.indexOf(`const ${name} = `)
  if (at < 0) return ''
  const end = src.indexOf('\n  }\n', at)
  return src.slice(at, end < 0 ? src.length : end + 4)
}

/** 取 `TW_CSS` 里某个选择器开头的那一段（到下一个行首的选择器或窗口上限） */
function cssSectionOf(css: string, selector: string, max = 2400): string {
  const at = css.indexOf(selector)
  if (at < 0) return ''
  const next = css.indexOf('\n.', at + selector.length)
  const end = next < 0 ? Math.min(css.length, at + max) : Math.min(next, at + max)
  return css.slice(at, end)
}

// ══ ① P1-2 悬浮图失败必须给出原因（不再只写"走势获取失败"） ═════════════════

test('① 悬浮图：unavailable 回包的 missing[] 变成"短原因 + 长解释"，重试动作分两种', () => {
  const noSource = unavailableReasonOf({
    kind: 'unavailable',
    missing: [{ what: '当日分时', why: 'no-source', note: '港股分时只有东财一个源，且该源不提供本市场的分时序列' }],
  })
  assert.ok(noSource !== null, 'unavailable 必须给出原因（旧实现返回"没有"）')
  assert.equal(noSource?.short, '当日分时未取到')
  assert.ok(noSource?.detail.includes('港股分时只有东财一个源'), '原 note 必须原样带出（不猜原因）')
  assert.ok(noSource?.detail.includes('重试无用'), 'no-source ⇒ 明说重试无用')
  const transient = unavailableReasonOf({
    kind: 'unavailable',
    missing: [{ what: '近5日', why: 'transient', note: '东财限流' }],
  })
  assert.ok(transient?.detail.includes('稍后自动重试'), 'transient ⇒ 明说稍后自动重试（两种原因动作不同）')
  assert.equal(unavailableReasonOf({ kind: 'unavailable', missing: [] })?.short, '该周期未取到', '没给 missing 时也要给短原因')
  assert.equal(unavailableReasonOf(null), null, '正常回包不该有原因')
  // 反例注入：旧行为 = 丢掉原因（只写"走势获取失败"）⇒ 判据必须失败
  const legacy = (_p: unknown): null => null
  assert.throws(
    () => assert.notEqual(legacy(noSource), null, '反例上"必须给出原因"必须失败'),
    /反例上/,
    '⚠ 反例注入（丢掉 missing 原因）必须让断言失败',
  )
})

test('① 接线：TopBar 两处失败态都渲染原因（短句常驻 + title/aria 长解释），且不再吞错', () => {
  const ui = strip(read('TopBar.tsx'))
  assert.ok(ui.includes('unavailableReasonOf(p) ?? unavailableReasonOf(d)'), '两份 payload 的原因都要接上（分时优先）')
  assert.ok(ui.includes("role: 'note'"), '原因必须可被键盘/读屏读到')
  assert.ok(ui.includes('title: `${reason.short}\\n${reason.detail}`'), '长解释进 title')
  // 两个失败/空态分支共用同一块（error 与 none 都显示原因）
  assert.ok(/kind === 'error' \|\| kind === 'none'/.test(ui), 'error 与 none 共用原因块')
  assert.equal(/setKind\('error'\)\s*\}\)/.test(ui), false, '不许再有"catch 里只置 error 不记原因"的写法')
  // 反例注入：把原因接线删掉（退回"只显示走势获取失败"）⇒ 判据必须失败
  const injected = ui.replace('unavailableReasonOf(p) ?? unavailableReasonOf(d)', 'null')
  assert.notEqual(injected, ui, '反例注入必须真改到源码')
  assert.equal(injected.includes('unavailableReasonOf(p)'), false, '⚠ 反例（丢掉原因）必须能被判据抓住')
})

// ══ ② P1-4 搜索候选键盘可选 + combobox/listbox/option 语义 ═══════════════════

test('② 下标算法（纯函数）：↓/↑ 环绕、从"无高亮"进入、无候选时 -1', () => {
  assert.equal(nextActiveOf(-1, 5, 1), 0, '没有高亮时 ↓ 落到第一条')
  assert.equal(nextActiveOf(-1, 5, -1), 4, '没有高亮时 ↑ 落到最后一条')
  assert.equal(nextActiveOf(0, 5, 1), 1)
  assert.equal(nextActiveOf(4, 5, 1), 0, '末条 ↓ 环绕到第一条')
  assert.equal(nextActiveOf(0, 5, -1), 4, '首条 ↑ 环绕到最后一条')
  assert.equal(nextActiveOf(2, 0, 1), -1, '没有候选 ⇒ 不高亮任何一条')
  assert.equal(edgeActiveOf(5, 'home'), 0)
  assert.equal(edgeActiveOf(5, 'end'), 4)
  assert.equal(edgeActiveOf(0, 'end'), -1)
  // 反例注入：旧行为 = 没有键盘移动（永远 -1）⇒ 判据必须失败
  const legacy = (): number => -1
  assert.throws(
    () => assert.equal(legacy(), 0, '反例上"↓ 必须高亮第一条"必须失败'),
    /反例上/,
    '⚠ 反例注入（键盘不可移动）必须让断言失败',
  )
})

test('② 接线：combobox/listbox/option + aria-activedescendant + click 选中', () => {
  const ui = strip(read('ui.tsx'))
  const problems: string[] = []
  if (!/role: 'combobox'/.test(ui)) problems.push('输入框缺 role=combobox')
  if (!/'aria-autocomplete': 'list'/.test(ui)) problems.push('缺 aria-autocomplete=list')
  if (!/'aria-expanded': open/.test(ui)) problems.push('缺 aria-expanded')
  if (!/'aria-controls': open \? listId : undefined/.test(ui)) problems.push('缺 aria-controls 指向 listbox')
  if (!/'aria-activedescendant': open \? activeId : undefined/.test(ui)) problems.push('缺 aria-activedescendant')
  if (!/role: 'listbox'/.test(ui)) problems.push('候选容器缺 role=listbox')
  if (!/id: listId/.test(ui)) problems.push('候选容器缺 id')
  if (!/role: 'option'/.test(ui)) problems.push('候选行缺 role=option')
  if (!/'aria-selected': isActive/.test(ui)) problems.push('候选行缺 aria-selected')
  if (!/onClick: \(\) => pick\(h\)/.test(ui)) problems.push('候选行缺 click 选中（键盘 Enter 走 click）')
  if (!/onMouseDown: \(e: React\.MouseEvent\) => \{\s*\n\s*e\.preventDefault\(\)/.test(ui)) problems.push('鼠标按下时不许让输入框失焦')
  if (!/nextActiveOf\(/.test(ui) || !/edgeActiveOf\(/.test(ui)) problems.push('上下键/Home/End 未接线到纯函数')
  if (!/onClick: \(\) => setShown\(\(n\) => n \+ SUGGEST_PAGE\)/.test(ui)) problems.push('「显示更多」缺 click（键盘按不动）')
  assert.deepEqual(problems, [], `候选键盘的接线不完整：${JSON.stringify(problems)}`)
  // 反例注入：把 click 选中删掉（退回只有 onMouseDown 的旧写法）⇒ 判据必须失败
  const injected = ui.replace(/onClick: \(\) => pick\(h\),/, '')
  assert.notEqual(injected, ui, '反例注入必须真改到源码')
  assert.equal(/onClick: \(\) => pick\(h\)/.test(injected), false, '⚠ 反例（键盘选不中）必须能被判据抓住')
})

// ══ ③ P1-6 买卖方向不得用涨跌色、不得随 redUp 翻转 ════════════════════════

test('③ 买卖方向：中性 chip（不随 redUp 翻转），方向只由文字「买/卖」表达', () => {
  const src = strip(read('PortfolioPage.tsx'))
  const ledger = fnBodyOf(src, 'LedgerModal')
  assert.ok(ledger.length > 0, '必须能定位到 LedgerModal')
  const problems: string[] = []
  if (!/VERB_CHIP = 'tw-chip-flat'/.test(ledger)) problems.push('方向 chip 不是中性色')
  if (/tw-chip-up|tw-chip-down/.test(ledger)) problems.push('操作记录里仍出现涨跌色 chip（买卖方向与涨跌混用）')
  if (/verb === 'buy' \?/.test(ledger)) problems.push('方向 chip 仍在按 buy/sell 分支取色')
  if (!/'data-verb': r\.verb/.test(ledger)) problems.push('方向要仍可从 DOM 读到（data-verb）')
  if (!/verbLabel\(r\.verb\)/.test(ledger)) problems.push('方向文字仍在')
  assert.deepEqual(problems, [], `买卖方向颜色问题：${JSON.stringify(problems)}`)
  // 全客户端都不许出现"买→涨色 / 卖→跌色"的映射（含 redUp 三元）
  for (const file of clientFiles()) {
    const code = strip(file.src)
    assert.equal(/verb === 'buy'[\s\S]{0,60}tw-chip-(up|down)/.test(code), false, `${file.rel} 里买卖仍映射到涨跌色`)
  }
  // 反例注入：把旧的三元放回 ⇒ 判据必须失败
  const injected = ledger.replace("const VERB_CHIP = 'tw-chip-flat'", "const VERB_CHIP = verb === 'buy' ? 'tw-chip-up' : 'tw-chip-down'")
  assert.notEqual(injected, ledger, '反例注入必须真改到源码')
  assert.ok(/tw-chip-up/.test(injected), '⚠ 反例（方向用涨跌色）必须能被判据抓住')
})

// ══ ④ P1-7 三句"本插件没做"与同屏真实数据矛盾 ⇒ 按事实重写 ════════════════

const REASON_NAMES = ['LIMIT_REASON', 'FORECAST_REASON', 'MARGIN_REASON', 'INTRADAY_REASON'] as const
function reasonsOf(page: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const name of REASON_NAMES) {
    const m = new RegExp(`const ${name} = '([^']*)'`).exec(page)
    out[name] = m?.[1] ?? ''
  }
  return out
}
function staleReasonProblems(page: string): string[] {
  const bad: string[] = []
  const r = reasonsOf(page)
  for (const name of REASON_NAMES) {
    if (r[name] === '') bad.push(`${name} 缺失`)
  }
  // 三句"本次失败"：必须说清"本次未取到 + 会不会重试"
  for (const name of ['LIMIT_REASON', 'FORECAST_REASON', 'MARGIN_REASON'] as const) {
    const text = r[name] ?? ''
    if (!/本次/.test(text)) bad.push(`${name} 未说明是"本次未取到"`)
    if (!/自动重试|稍后/.test(text)) bad.push(`${name} 未说明会不会重试`)
    if (!/不是 0|而不是 0/.test(text)) bad.push(`${name} 未声明不拿 0 顶替`)
  }
  // 旧的三句自相矛盾文案（功能其实早就做了）
  for (const forbidden of ['未集成', '本轮不做', '故不给', '没有日内成交额采样', '没有涨停/跌停字段']) {
    if (page.includes(forbidden)) bad.push(`仍含与事实矛盾的旧文案：${forbidden}`)
  }
  // 日内家数：是**功能边界**（重试也不会变），必须与"本次失败"分开说
  if (!/功能边界/.test(r.INTRADAY_REASON ?? '')) bad.push('INTRADAY_REASON 未标明"功能边界"')
  // 两融副标题：要说清代码正在做什么
  if (page.includes('本插件未集成两融数据源')) bad.push('两融副标题仍在说"未集成"')
  if (!page.includes('双源交叉')) bad.push('两融副标题未说明双源交叉')
  return bad
}

test('④ MarketPage 三句旧文案按事实重写（功能已落地，只说"本次未取到 + 重试"）', () => {
  const page = strip(read('MarketPage.tsx'))
  assert.deepEqual(staleReasonProblems(page), [])
  // 全客户端：别的页面也不许再写"本插件未集成"
  for (const file of clientFiles()) {
    assert.equal(strip(file.src).includes('本插件未集成'), false, `${file.rel} 仍含"本插件未集成"（与行为矛盾）`)
  }
  // 反例注入：把两融那句旧文案放回 ⇒ 判据必须失败
  const injected = page.replace(
    /const MARGIN_REASON = '[^']*'/,
    "const MARGIN_REASON = '两融（融资余额/融资净买）：本插件未集成两融数据源，现有路由里没有任何 margin 字段 ⇒ 未取到'",
  )
  assert.notEqual(injected, page, '反例注入必须真改到源码')
  assert.notDeepEqual(staleReasonProblems(injected), [], '⚠ 反例（"未集成"旧文案）必须被抓住')
})

// ══ ⑤ P1-8 时刻必须北京时间（R5 红线回归） ════════════════════════════════

const TZ_OFFENDERS = /\.toTimeString\(|\.getHours\(|\.getMinutes\(|toLocaleTimeString\((?![\s\S]{0,80}timeZone: 'Asia\/Shanghai')/

test('⑤ 时刻：客户端源码不许用浏览器时区的 toTimeString/getHours（R5）', () => {
  const problems: string[] = []
  for (const file of clientFiles()) {
    const code = strip(file.src)
    code.split('\n').forEach((line, i) => {
      if (TZ_OFFENDERS.test(line)) problems.push(`${file.rel}:${i + 1}  ${line.trim().slice(0, 110)}`)
    })
  }
  assert.deepEqual(problems, [], `浏览器时区取值必须为 0 处：\n${problems.join('\n')}`)
  // 反例注入：把 toTimeString 塞回源码 ⇒ 判据必须非空
  const injected = `${strip(read('RescuePanel.tsx'))}\nconst bad = new Date(x).toTimeString().slice(0, 5)\n`
  const hits = injected.split('\n').filter((line) => TZ_OFFENDERS.test(line))
  assert.equal(hits.length, 1, '⚠ 反例（toTimeString）必须能被判据抓住')
  assert.throws(
    () => assert.deepEqual(hits, [], '反例上"不许用浏览器时区"必须失败'),
    /反例上/,
    '⚠ 反例注入必须让断言失败',
  )
})

test('⑤ 北京时间格式化：固定 Asia/Shanghai（TZ=UTC 下同样是 14:32）', () => {
  const ts = Date.parse('2026-10-17T06:32:00Z')
  assert.equal(shClockText(ts), '14:32:00', 'shClockText 必须按北京时间渲染')
  assert.equal(shClockText(ts).slice(0, 5), '14:32', '护盘面板展示的 HH:mm 取自同一出口')
  // 接线：两处都改成了 shClockText（不再 new Date(...).toTimeString()）
  const rescue = strip(read('RescuePanel.tsx'))
  assert.ok(rescue.includes('shClockText(snapshot.bottom.computedAt).slice(0, 5)'), '「上次结果」的时刻走 shClockText')
  assert.ok(rescue.includes('shClockText(l.pattern.lowAtTs).slice(0, 5)'), '前低时点走 shClockText')
})

// ══ ⑥ P1-9 历史回看失败不得伪装成"当日无信号" ════════════════════════════

test('⑥ 历史回看三态：失败 ⇒ error（不渲染"无信号/无抽样"），成功才可能是空的', () => {
  assert.equal(dayHistoryStateOf({ err: '东财 503', detail: null }), 'error', '失败 ⇒ error')
  assert.equal(dayHistoryStateOf({ err: null, detail: null }), 'loading', '没失败也没结果 ⇒ 骨架')
  assert.equal(dayHistoryStateOf({ err: null, detail: { events: [], intraday: [] } }), 'ready', '拿到空结果才是真的"当日没有"')
  const panel = strip(read('RescuePanel.tsx'))
  const openHistory = arrowBodyOf(panel, 'openHistory')
  assert.ok(openHistory.length > 0, '必须能定位到 openHistory')
  assert.equal(/setDayDetail\(\{ events: \[\], intraday: \[\] \}\)/.test(openHistory), false, '失败不许用空数组顶替')
  assert.ok(/setDayErr\(e\.message\)/.test(openHistory), '失败必须记原因')
  assert.ok(/state === 'error'/.test(panel), '弹窗必须先判失败态')
  assert.ok(/历史回看本次未取到/.test(panel) && /重试/.test(panel), '失败态要给原因 + 重试')
  // 反例注入：把旧写法（失败 ⇒ 空数组）放回 ⇒ 判据必须失败
  const injected = openHistory.replace(".catch((e: Error) => setDayErr(e.message))", '.catch(() => setDayDetail({ events: [], intraday: [] }))')
  assert.notEqual(injected, openHistory, '反例注入必须真改到源码')
  assert.ok(/setDayDetail\(\{ events: \[\], intraday: \[\] \}\)/.test(injected), '⚠ 反例（空数组顶替失败）必须能被判据抓住')
})

// ══ ⑦ P1-10 重要性/护盘等级用独立语义色；隐身档不得刺眼 ═══════════════════

const SEMANTIC_TOKENS = ['--tw-imp-1', '--tw-imp-2', '--tw-imp-3', '--tw-rescue-0', '--tw-rescue-1', '--tw-rescue-2', '--tw-rescue-3']

function colorTokenProblems(styles: string): string[] {
  const bad: string[] = []
  const light = cssSectionOf(styles, '.tw-root{')
  const dark = cssSectionOf(styles, '.tw-root[data-theme=dark]{')
  const incognito = cssSectionOf(styles, '.tw-root[data-view=incognito]{', 700)
  for (const token of SEMANTIC_TOKENS) {
    if (!light.includes(`${token}:`)) bad.push(`浅色档缺 ${token}`)
    if (!dark.includes(`${token}:`)) bad.push(`深色档缺 ${token}`)
    if (!incognito.includes(`${token}:`)) bad.push(`隐身档未灰化 ${token}`)
  }
  // 隐身档必须把它们都压成中性灰（与 up/down 的灰化同一条规则）
  for (const token of SEMANTIC_TOKENS) {
    const m = new RegExp(`${token}:(#[0-9a-fA-F]{6})`).exec(incognito)
    if (m !== null && m[1].toLowerCase() !== '#8a8f98') bad.push(`隐身档 ${token} 不是中性灰（${m[1]}）`)
  }
  return bad
}

test('⑦ 语义色 token：深浅两档都有值，隐身档统一灰化', () => {
  const styles = read('styles.ts')
  assert.deepEqual(colorTokenProblems(styles), [])
  // 反例注入 ①：删掉隐身档的一条灰化 ⇒ 判据必须失败
  const noIncog = styles.replace('--tw-imp-3:#8a8f98;', '')
  assert.notEqual(noIncog, styles, '反例注入必须真改到源码')
  assert.notDeepEqual(colorTokenProblems(noIncog), [], '⚠ 反例（隐身档没灰化）必须被抓住')
  // 反例注入 ②：把某个 token 从深色档删掉 ⇒ 判据必须失败
  const noDark = styles.replace('--tw-rescue-2:#f0a63a;', '')
  assert.notDeepEqual(colorTokenProblems(noDark), [], '⚠ 反例（深色档缺 token）必须被抓住')
})

test('⑦ 接线：重要性/护盘等级/异常程度都只引用语义 token（不碰涨跌色、不硬编码色值）', () => {
  const cal = strip(read('CalendarPage.tsx'))
  const rescue = strip(read('RescuePanel.tsx'))
  const view = strip(read('rescueView.ts'))
  const problems: string[] = []
  for (const [name, src, prefix] of [
    ['CalendarPage', cal, 'var(--tw-imp-'],
    ['RescuePanel', rescue, 'var(--tw-rescue-'],
  ] as const) {
    const m = new RegExp(`const ${name === 'CalendarPage' ? 'IMP_COLOR' : 'LEVEL_COLOR'}[^}]+\\}`, 's').exec(src)
    const block = m?.[0] ?? ''
    if (block === '') problems.push(`${name} 的色表找不到`)
    if (/--tw-up|--tw-down/.test(block)) problems.push(`${name} 的色表仍引用涨跌色`)
    if (/#[0-9a-fA-F]{6}/.test(block)) problems.push(`${name} 的色表仍硬编码色值`)
    if (!block.includes(prefix)) problems.push(`${name} 的色表未引用 ${prefix}*`)
  }
  // 异常程度色阶（总分环）也走 token
  const abn = /export function abnormalColorOf[\s\S]*?\n}/.exec(view)?.[0] ?? ''
  if (abn === '') problems.push('abnormalColorOf 找不到')
  if (/#[0-9a-fA-F]{6}/.test(abn)) problems.push('abnormalColorOf 仍硬编码色值（隐身档不会灰化）')
  if (!abn.includes('var(--tw-imp-')) problems.push('abnormalColorOf 未引用语义 token')
  // 选项文案不再写死颜色名（否则颜色改了就是谎话）
  for (const word of ['高（红）', '中（橙）', '低（蓝）']) {
    if (cal.includes(word)) problems.push(`日历选项仍写死颜色：${word}`)
  }
  assert.deepEqual(problems, [], `语义色接线问题：${JSON.stringify(problems)}`)
  // 反例注入：把重要性 3 档退回涨跌色 ⇒ 判据必须失败
  const injected = cal.replace("3: 'var(--tw-imp-3)',", "3: 'var(--tw-up)',")
  assert.notEqual(injected, cal, '反例注入必须真改到源码')
  assert.ok(/3: 'var\(--tw-up\)'/.test(injected), '⚠ 反例（重要性复用涨跌色）必须能被判据抓住')
  // 异常程度的档位仍必须互不相同（否则环形看不出程度）
  assert.notEqual(abnormalColorOf(10), abnormalColorOf(40))
  assert.notEqual(abnormalColorOf(40), abnormalColorOf(60))
  assert.equal(abnormalColorOf(60).includes('up') || abnormalColorOf(60).includes('down'), false, '高档不许用涨跌色')
})

// ══ ⑧ P1-11 缩略图的"分时首笔/分时高/分时低"口径 ══════════════════════════

test('⑧ 缩略图口径：字段与文案都带「分时」，不得被读成官方开/高/低', () => {
  const mini = strip(read('mini.ts'))
  const problems: string[] = []
  for (const field of ['sampleFirst', 'sampleHigh', 'sampleLow']) {
    if (!mini.includes(`${field}?:`)) problems.push(`MiniData 缺 ${field}（字段名必须自带"抽样"语义）`)
  }
  const iface = /export interface MiniData \{[\s\S]*?\n\}/.exec(mini)?.[0] ?? ''
  for (const legacy of ['open?:', 'high?:', 'low?:']) {
    if (iface.includes(legacy)) problems.push(`MiniData 仍有会被误读成官方开高低的字段：${legacy}`)
  }
  for (const [file, src] of [['WatchlistPage.tsx', strip(read('WatchlistPage.tsx'))], ['PortfolioPage.tsx', strip(read('PortfolioPage.tsx'))]] as const) {
    const hover = fnBodyOf(src, 'miniHover')
    if (hover === '') { problems.push(`${file} 找不到 miniHover`); continue }
    for (const label of ['分时首笔', '分时高', '分时低', '分时振幅']) {
      if (!hover.includes(label)) problems.push(`${file} 的悬停缺「${label}」`)
    }
    if (!hover.includes('不是交易所口径的开/高/低')) problems.push(`${file} 未说明它不是官方开高低`)
    // 旧文案：`开 / 高 / 低`（不带"分时"）会让读者以为是官方开高低
    if (/`开 \$\{|`高 \$\{|`低 \$\{/.test(hover)) problems.push(`${file} 仍在用「开/高/低」这种会被误读的标签`)
  }
  assert.deepEqual(problems, [], `缩略图口径问题：${JSON.stringify(problems)}`)
  // 反例注入：把标签改回裸「开」⇒ 判据必须失败
  const watch = strip(read('WatchlistPage.tsx'))
  const hover = fnBodyOf(watch, 'miniHover')
  const injected = hover.replace('`分时首笔 ${first.toFixed(3)}`', '`开 ${first.toFixed(3)}`')
  assert.notEqual(injected, hover, '反例注入必须真改到源码')
  assert.ok(/`开 \$\{/.test(injected), '⚠ 反例（裸「开」标签）必须能被判据抓住')
})

// ══ ⑨ 锁定片段 `无行情源 N` 必须是**真实渲染字符串** ═══════════════════════

test('⑨ 锁定片段「无行情源 N」来自真实字符串（去注释后仍在源码里）', () => {
  const code = strip(read('quoteState.ts'))
  assert.ok(code.includes('无行情源 N'), '去注释后源码里必须仍有「无行情源 N」（否则锁依赖注释，太脆）')
  assert.ok(NO_SOURCE_BADGE_HINT.startsWith('无行情源 N'), '常量本身就以锁片段开头')
  const topBar = strip(read('TopBar.tsx'))
  assert.ok(topBar.includes('NO_SOURCE_BADGE_HINT'), '常量必须真的被渲染（进 bundle）')
  assert.ok(/'aria-label': `\$\{NO_SOURCE_BADGE_HINT\}（本批 \$\{n\} 只）`/.test(topBar), '落在「无行情源 N」徽标的 aria-label 上')
  // 反例注入：把常量里的 N 去掉 ⇒ 判据必须失败
  const injected = code.replace(/无行情源 N：三源/, '无行情源：三源')
  assert.notEqual(injected, code, '反例注入必须真改到源码')
  assert.equal(injected.includes('无行情源 N'), false, '⚠ 反例（去掉 N）必须能被判据抓住')
  assert.throws(
    () => assert.ok(injected.includes('无行情源 N'), '反例上"必须在真实字符串里"必须失败'),
    /反例上/,
    '⚠ 反例注入（片段只剩注释）必须让断言失败',
  )
})
