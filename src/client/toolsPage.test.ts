/**
 * 工具箱**页面接线**的断言：门控（页签）、目录页/详情页真的渲染模型、**三段式结构**与时间范围控件。
 *
 * 为什么用"读源码 + 纯函数"两层：
 *   · 这个仓库没有 DOM 测试环境（devDependencies 里没有 jsdom / testing-library）⇒ 渲染层只能靠
 *     **源码接线断言**（与 `src/index.test.ts` 的 `checkManifest` / `boardOwnershipProblems` 同一手法）；
 *   · 行为规则（门控 / 回放步 / 范围切片）全部下沉到**纯函数**（`tabsGate.ts` / `toolRegistry.ts` /
 *     `tools/globalFlowView.ts`）⇒ 行为本身是可断言的。
 * 两层缺一不可：只有纯函数 ⇒ 页面可能根本没接线；只有源码字符串 ⇒ 规则错也照样绿。
 *
 * v0.81.0（用户两项界面改动）：
 *   ① 目录页删掉**页级返回控件**与**搜索框** ⇒ 本文件改为"这两处不得再出现"的负向断言 + 反例注入；
 *   ② 详情页改成三段式（Hero → 摘要卡 → 图表卡）⇒ 结构断言 + 时间范围三档断言 + 反例注入。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gateTabs, type TabLike } from './tabsGate.ts'
import { catalogModel, detailModel, NOT_FETCHED, TOOL_ENTRIES } from './toolRegistry.ts'
import { cakeTool } from './tools/cake.ts'
import {
  BACK_BTN_FOCUS_STYLE,
  BACK_BTN_HOVER_STYLE,
  BACK_BTN_PRESS_STYLE,
  BACK_BTN_PROPS,
  BACK_BTN_STYLE,
  BACK_BTN_TAG,
  BACK_BTN_TITLE,
  backButtonInteractionProblems,
  backButtonLayoutProblems,
} from './toolBackButton.ts'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const readSrc = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8')

/**
 * 剥掉块注释与行注释（**只用于"用户可见文案"类断言**）。
 *
 * 为什么必须剥：源码注释里会写"页脚 `打开工具 →` 已按用户要求删除"这类**说明历史**的话；
 * 把注释算进去就等于禁止注释提到那个词 —— 那会逼着后续维护者把历史删掉（信息反而丢了）。
 * 规则与 `src/host/markdownScan.test.ts` 的 `stripComments` 同源（先块后行；`//` 前不能是 `:` 免得吃掉 URL）。
 */
/**
 * 剥掉 import/export 语句（**只用于"常量真的被用了"类断言**）。
 *
 * 为什么必须剥：`src.includes('LEGEND_ROW')` 会被**导入语句本身**满足 ⇒ 页面把常量用丢了、
 * 断言照样绿。剥掉 import 后，剩下的出现才是"真的用在这段 JSX 里"。
 */
function stripImports(src: string): string {
  return src.replace(/^import[\s\S]*?from '[^']+'\n/gm, '').replace(/^import '[^']+'\n/gm, '')
}

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1')
}

/**
 * 从 `src/client/index.tsx` 抽出**真实的** `tabs` 字面量（不另抄一份）——
 * 抄一份就必然漂移：页面加/删页签，测试还是绿的。
 * 抽不到 ⇒ 返回空数组（下面的断言会以"少于 6 项"失败，而不是静默通过）。
 */
export function tabsFromSource(src: string): Array<{ key: string; label: string; row: string }> {
  const start = src.indexOf('const tabs:')
  if (start < 0) return []
  const open = src.indexOf('[', start)
  const end = src.indexOf('\n  ]', open)
  if (open < 0 || end < 0) return []
  return [...src.slice(open, end).matchAll(/\{ key: '([a-z]+)', label: '([^']*)', full: '[^']*', row: '([a-z]+)' \}/g)].map((m) => ({ key: m[1], label: m[2], row: m[3] }))
}

const INDEX_SRC = readSrc('src/client/index.tsx')
const TABS: Array<TabLike<string>> = tabsFromSource(INDEX_SRC).map((t) => ({ ...t, full: t.label }))

test('页签：工具箱在「日历」之后，标签「工具」，归属行 `tools`', () => {
  // v0.110.0（AUDIT-IMPL83）：第 7 个页签「复盘」追加在「工具」之后 ⇒ 页签总数 6 → 7
  assert.equal(TABS.length, 8, `必须能抽出 8 个页签（锚点变了？实得 ${TABS.length}）`)
  const keys = TABS.map((t) => t.key)
  assert.deepEqual(keys, ['watch', 'portfolio', 'market', 'cloud', 'calendar', 'tools', 'fupan', 'prism'], `页签集合/顺序不对：${JSON.stringify(keys)}`)
  const tools = TABS.find((t) => t.key === 'tools')
  assert.equal(tools?.label, '工具', '工具箱页签的标签必须是「工具」')
  assert.equal(tools?.row, 'tools', '工具箱页签归属 tools 行（门控靠它）')
  assert.equal(keys.indexOf('tools'), keys.indexOf('calendar') + 1, '工具箱必须紧跟在「日历」之后')
})

test('门控：`rows` 含 tools ⇒ 渲染该页签；不含 ⇒ 不渲染（沿用既有 gateTabs 逻辑）', () => {
  // 七行全开（manifest 的默认形态）
  const on = gateTabs(TABS, new Set(['core', 'calendar', 'watchlist', 'portfolio', 'market', 'cloudmap', 'tools', 'fupan', 'prism']), 'watch')
  assert.equal(on.visible.some((t) => t.key === 'tools'), true, 'rows 含 tools ⇒ 工具页签必须出现')
  assert.equal(on.visible.length, 8, '全部行都开时八个页签都在')
  // profile 层 `- id: tradewatcher-tools` + `disabled: true` ⇒ /rows 不含 tools
  const off = gateTabs(TABS, new Set(['core', 'calendar', 'watchlist', 'portfolio', 'market', 'cloudmap', 'fupan', 'prism']), 'watch')
  assert.equal(off.visible.some((t) => t.key === 'tools'), false, '⚠ 门控：rows 不含 tools ⇒ **不渲染**工具页签')
  assert.equal(off.visible.length, 7, '关掉工具箱不影响其余七个页签')
  assert.equal(off.fallback, null, '当前页仍可用 ⇒ 不回退')
  // 当前页就是工具箱、而该行被关掉 ⇒ 回退到首个可见页（不许白屏）
  const gone = gateTabs(TABS, new Set(['core', 'calendar']), 'tools')
  assert.deepEqual(gone.visible.map((t) => t.key), ['calendar'], '只开日历 ⇒ 只剩日历页签')
  assert.equal(gone.fallback, 'calendar', '当前页（工具）被停用 ⇒ 必须回退')
  // 端点不可达（rows = null）⇒ 失败放行：与其余页签同款（抖动不该让界面整块消失）
  assert.equal(gateTabs(TABS, null, 'watch').visible.length, 8, '失败放行：八个页签都在')
})

/**
 * ① 目录页**不得再出现**页级返回控件与搜索框（v0.81.0 用户判定冗余）。
 *
 * 检查分三层：源码（连 `toolsNav.ts` 这类只服务它的模块都算）、文案常量导出面、渲染模型。
 * 返回失败原因列表（空 = 通过）⇒ 同一份检查既跑真实源码、也跑注入（证明断言非恒真）。
 */
export function catalogCleanProblems(files: { page: string; index: string; text: string; registry: string }, exists: (rel: string) => boolean): string[] {
  const bad: string[] = []
  const need = (cond: boolean, msg: string): void => {
    if (!cond) bad.push(msg)
  }
  const page = stripComments(files.page)
  // 1) 源码里不许再有这两处（含 aria/title/placeholder 那些属性位置）
  for (const dead of ['PAGE_BACK_ACTION', 'BackIcon', "type: 'search'", 'searchPlaceholder', 'matchesQuery', 'searchTextOf']) {
    need(page.includes(dead) === false, `目录页源码里不许再出现「${dead}」（这两处已按用户要求删除）`)
  }
  need(/props\.onBack/.test(page) === false, '目录页不许再接收 onBack（页级返回控件已删）')
  // 用户可见文案层面也不许出现那两个词（剥注释后再扫，注释里讲历史是允许的）
  need(page.includes('搜索') === false, '目录页不许再出现「搜索」字样')
  // 「返回」只剩详情页的"← 工具目录"里有「回」字，不含「返回」二字 ⇒ 全文不许出现「返回」
  need(page.includes('返回') === false, '目录页不许再出现「返回」字样（页级返回控件已删）')
  // 2) index.tsx 的接线层：不许再传 onBack、不许再 import 已删除的 toolsNav
  const idx = stripComments(files.index)
  need(idx.includes('onBack') === false, 'index.tsx 不许再给 ToolsPage 传 onBack')
  need(idx.includes('toolsNav') === false, 'index.tsx 不许再 import toolsNav（那个模块只服务已删除的返回按钮）')
  need(idx.includes('rememberPage') === false && idx.includes('backTarget') === false, 'index.tsx 不许再引用 rememberPage/backTarget')
  // 3) 只服务这两处的东西必须**整块删掉**（不是留着不用）
  need(exists('src/client/toolsNav.ts') === false, 'toolsNav.ts 必须删除（它是返回按钮的唯一实现）')
  for (const dead of ['PAGE_BACK_ACTION', 'SEARCH_PLACEHOLDER']) {
    need(files.text.includes(`export const ${dead}`) === false, `toolText.ts 不许再导出 ${dead}`)
    need(stripComments(files.registry).includes(dead) === false, `toolRegistry.ts 不许再转出 ${dead}`)
  }
  // 4) 渲染模型层：目录页模型没有搜索字段；卡片模型没有页脚入口
  const model = catalogModel(TOOL_ENTRIES)
  need('searchPlaceholder' in model === false, '目录页模型不许再有 searchPlaceholder 字段')
  need('query' in model === false, '目录页模型不许再有 query 字段')
  // 5) 该保留的必须还在：分类标签行 + 卡片 + 详情页的回目录入口
  need(page.includes('model.categories.map('), '分类标签行必须保留（用户只删了搜索与返回）')
  need(page.includes('model.cards.map('), '卡片网格必须保留')
  need(page.includes('model.backAction'), '详情页的「回到工具目录」入口必须保留（从工具回目录的唯一入口）')
  return bad
}

const FILES = {
  page: readSrc('src/client/ToolsPage.tsx'),
  index: INDEX_SRC,
  text: readSrc('src/client/toolText.ts'),
  registry: readSrc('src/client/toolRegistry.ts'),
}
const existsOnDisk = (rel: string): boolean => {
  try {
    readFileSync(join(ROOT, rel), 'utf8')
    return true
  } catch {
    return false
  }
}

test('① 目录页：页级返回控件与搜索框都已删除（源码/文案/模型三层 + 反例注入）', () => {
  const bad = catalogCleanProblems(FILES, existsOnDisk)
  assert.deepEqual(bad, [], `目录页清理检查未通过：${bad.join(' ／ ')}`)
  const injections: Array<{ name: string; mutate: (f: typeof FILES) => typeof FILES; hit: RegExp }> = [
    { name: '返回按钮加回来', mutate: (f) => ({ ...f, page: f.page.replace("const hasCurve =", "React.createElement('button', { title: '返回' }, '返回')\n  const hasCurve =") }), hit: /返回/ },
    { name: '搜索框加回来', mutate: (f) => ({ ...f, page: f.page.replace("const hasCurve =", "React.createElement('input', { type: 'search', 'aria-label': '搜索工具、市场或指标' })\n  const hasCurve =") }), hit: /搜索|search/ },
    { name: 'onBack 传回来', mutate: (f) => ({ ...f, index: f.index.replace('React.createElement(ToolsPage)', "React.createElement(ToolsPage, { onBack: null })") }), hit: /onBack/ },
    { name: 'toolsNav 再导入', mutate: (f) => ({ ...f, index: `import { backTarget } from './toolsNav.ts'\n${f.index}` }), hit: /toolsNav|rememberPage|backTarget/ },
    { name: '文案常量再导出', mutate: (f) => ({ ...f, text: `${f.text}\nexport const SEARCH_PLACEHOLDER = '搜索工具、市场或指标'\n` }), hit: /SEARCH_PLACEHOLDER/ },
  ]
  for (const { name, mutate, hit } of injections) {
    const mutated = mutate(FILES)
    assert.notEqual(JSON.stringify(mutated), JSON.stringify(FILES), `注入「${name}」必须真的改到了源码`)
    const fail = catalogCleanProblems(mutated, (rel) => (name === 'toolsNav 再导入' && rel.endsWith('toolsNav.ts') ? true : existsOnDisk(rel)))
    assert.ok(fail.length > 0, `注入「${name}」必须被检查抓到（实际一条都没报 ⇒ 断言恒真）`)
    assert.match(fail.join(' ／ '), hit, `注入「${name}」报的原因应是预期的：${JSON.stringify(fail)}`)
  }
})

/** `detailView` 的函数体（从 `function detailView(` 到下一个顶层 `function `）—— 渲染顺序只在它里面比 */
function detailViewBody(src: string): string {
  const start = src.indexOf('function detailView(')
  if (start < 0) return ''
  const end = src.indexOf('\nfunction ', start)
  return end < 0 ? src.slice(start) : src.slice(start, end)
}

/**
 * 详情页三段式 + 渲染接线检查。返回失败原因列表（空 = 通过）。
 */
export function renderWiringProblems(src: string): string[] {
  const bad: string[] = []
  const need = (cond: boolean, msg: string): void => {
    if (!cond) bad.push(msg)
  }
  need(/catalogModel\(TOOL_ENTRIES, category, CATEGORY_TABS\)/.test(src), '目录页必须由 catalogModel 生成（页面不许自己拼卡片）')
  // v0.72.0 接数据后：详情页 = detailModel(entry, data)，数据由工具自己的 load() 取一次、本地回放 + 本地换窗口
  need(/detailModel\(entry, data\)/.test(src), '详情页必须由 detailModel(entry, data) 生成（占位/原因只有一份来源）')
  need(/payload\.at\(step, selectedRange \?\? undefined\)/.test(src), '回放/换窗口必须走载荷句柄的 at(step, range)（本地换帧，不许每帧发请求）')
  need(/entry\?\.load/.test(src), '数据必须来自工具自己的 load()（页面不许另写一份取数）')
  need(/entry\?\.ranges\?\.initial/.test(src), '默认窗口必须来自工具声明（页面不许写死 180）')
  // v0.86.0：KPI 磁贴的**来源与口径**必须渲染成 title/aria-label（悬停/读屏都能读到；缺数据时不出现）
  need(/cell\.source === null \? \{\} : \{ title: cell\.source/.test(src), 'KPI 磁贴必须把来源/口径渲染成 title/aria-label')
  // 目录页要素（v0.74.0 起：**没有**页标题/副标题；v0.81.0 起：**没有**返回控件与搜索框）
  need(/model\.categories\.map\(/.test(src), '分类标签行未渲染')
  need(/repeat\(3, minmax\(0, 1fr\)\)/.test(src), '卡片网格必须是三列（repeat(3, minmax(0, 1fr))）')
  need(/model\.cards\.map\(/.test(src), '卡片网格未渲染目录页模型给出的卡片')
  // ⚠ 反向断言：被用户删掉的那些**不许回来**（模型层的字段删了、页面也不许再渲染）
  for (const gone of ['model.title', 'model.subtitle', 'card.action', 'model.searchPlaceholder', 'PAGE_BACK_ACTION', 'props.onBack', "type: 'search'"]) {
    need(src.includes(gone) === false, `页头标题/卡片页脚/返回控件/搜索框被加回来了：${gone}`)
  }
  const visible = stripComments(src)
  need(visible.includes('打开工具') === false, '卡片页脚入口文案「打开工具」不许再出现在用户可见文案里')
  need(visible.includes('搜索') === false, '页面里不许再出现「搜索」字样')
  // 卡片三个字段（chip / 标题 / 一句话说明）——整卡可点，所以没有页脚入口文案
  for (const field of ['card.chip', 'card.title', 'card.blurb']) need(src.includes(field), `卡片字段未渲染：${field}`)
  need(/\.\.\.CARD_PROPS/.test(src) && /style: CARD_STYLE/.test(src) && /React\.createElement\(\s*CARD_TAG,/.test(src), '卡片必须用 toolCardView 的常量建（原生 button 语义 + 阴影圆角的唯一来源）')
  // 详情页三段式：Hero → 摘要卡 → 图表卡。
  // ⚠ 只能按**渲染顺序**比：Hero 与摘要卡各自是一个函数，定义位置与渲染位置无关 ⇒
  //    在 `detailView` 的函数体里比"调用/锚点"的先后才是真的顺序。
  const body = detailViewBody(src)
  need(body !== '', '找不到 detailView 的函数体（锚点变了？负向断言会失效）')
  const order = ['model.backAction', 'heroView(model, io)', 'summaryCards(model)', "'data-role': 'tool-chart-card'"]
  const positions = order.map((k) => body.indexOf(k))
  for (let i = 0; i < order.length; i += 1) need(positions[i] >= 0, `三段式缺少 ${order[i]}（detailView 里没渲染）`)
  if (positions.every((p) => p >= 0)) {
    need(
      positions[0] < positions[1] && positions[1] < positions[2] && positions[2] < positions[3],
      `渲染顺序必须是 回目录入口 → Hero → 摘要卡 → 图表卡（实得 ${JSON.stringify(positions)}）`,
    )
  }
  need(/'data-role': 'tool-hero'/.test(src) && /'data-role': 'tool-hero-kicker'/.test(src), 'Hero 必须渲染（含 kicker 小标签）')
  need(/model\.hero\.title/.test(src) && /model\.hero\.note/.test(src), 'Hero 必须渲染大标题与说明')
  need(/'data-role': 'tool-summary'/.test(src) && /model\.summary\.map\(/.test(src), '摘要卡未渲染')
  need(/'data-role': 'tool-summary-card'/.test(src), '摘要卡必须有结构锚点（可断言）')
  need(/model\.chartAsOf/.test(src) && /'data-role': 'tool-chart-asof'/.test(src), '图表卡右上角必须渲染 AS OF（日期来自模型）')
  // KPI 口径行（缺数据时它是原因）不占版面，但必须仍可读 ⇒ 进图表卡标题的 title/aria-label
  need(/model\.kpi\.note/.test(src) && /'data-role': 'tool-chart-title'/.test(src), 'KPI 口径行必须进图表卡标题的 title/aria-label（缺数据时的原因不许丢）')
  need(/model\.kpi\.cells\.map\(/.test(src) && /'data-role': 'tool-kpi-tile'/.test(src), '四个 KPI 磁贴必须渲染（结构锚点 tool-kpi-tile）')
  // 时间范围分段控件：三档都来自模型，点击改本地状态
  need(/'data-role': 'tool-range'/.test(src), '缺少时间范围分段控件（Hero 右上角）')
  need(/model\.ranges\.options\.map\(/.test(src), '范围档位必须来自模型（不许在页面里写死三档）')
  need(/'data-role': 'tool-range-option'/.test(src) && /io\.onRange\(n\)/.test(src), '范围档位必须可点（onRange 改本地状态）')
  need(/model\.ranges\.selected === n/.test(src), '当前档必须有选中态')
  // 详情页其余五个功能区
  for (const field of ['model.curve.empty', 'model.pie.empty', 'model.market.columns.map(', 'model.boundary.lines']) {
    need(src.includes(field), `详情页功能区未渲染：${field}`)
  }
  need(/model\.market\.columns\.length/.test(src), '市场表空态必须跨全部列（colSpan 来自列数）')
  // ③ 市场段主视图 = 五行**横条**（表格只作载荷缺 bars 时的回退）
  need(
    /model\.market\.bars\.length > 0/.test(src) && /'data-role': 'tool-flow-bars'/.test(src) && /model\.market\.bars\.map\(barRow\)/.test(src),
    '市场段必须渲染横条（按 model.market.bars 的长度分支 + 逐行 barRow）',
  )
  need(/'data-role': 'tool-bar-badge'/.test(src) && /bar\.top/.test(src), '横条必须渲染「当前最多」徽标（按模型的 top 标记）')
  need(/'data-role': 'tool-bar-track'/.test(src) && /bar\.sharePct/.test(src), '横条必须按 sharePct 画长条')
  need(/'data-role': 'tool-bar-delta'/.test(src) && /bar\.deltaText/.test(src), '横条右端必须渲染「近5日 升温/降温」')
  need(/'data-role': 'tool-bar-detail'/.test(src) && /bar\.detail/.test(src), '横条必须把规模/偏好分/动量/排名的诚实信息渲染到行内小字（并进 title 悬停）')
  need(/bar\.note === null/.test(src), '横条里缺数据的行仍必须给原因（未取到：…）')
  need(/model\.market\.rows\.flatMap\(/.test(src), '载荷没给 bars 时必须回退到表格（诚实信息一处不少）')
  // ⑤ 段末一行结论
  need(/'data-role': 'tool-conclusion'/.test(src) && /model\.conclusion/.test(src), '段末必须渲染一行结论（→ 近5日资金偏好显示：…）')
  // ④ 底部两段散文 + 逐句渲染（事实不删）+ 不再用项目符号列表
  need(/proseSection\(model\.method\.title, model\.method\.lines, 'tool-method', 'tool-method-line'\)/.test(src), '方法段必须由 proseSection 渲染（匿名口径 → 散文）')
  need(/proseSection\(model\.boundary\.title, model\.boundary\.lines, 'tool-legal', 'tool-legal-line'\)/.test(src), '边界段必须由 proseSection 渲染（两段散文）')
  need(/lines\.map\(\(line, i\) =>/.test(src), '散文段必须逐句渲染（不许摘要/截断：事实一条不删）')
  need(/React\.createElement\('li'/.test(src) === false, '边界声明不许再渲染成项目符号列表')
  // ② 饼图实心 + 回放播放/暂停 + N/30
  need(/M \$\{CX\} \$\{CY\} L/.test(src), '饼图必须是实心扇形（从圆心起画）')
  // ⚠ 用剥注释的正文：注释里会写"这里没有 tool-pie-center"（拿 src 判会被自己的注释判红，实测踩到）
  need(/tool-pie-center/.test(visible) === false, '饼图不许再挖中心孔（实心饼；日期改到饼上方小字）')
  need(/'data-role': 'tool-pie-day'/.test(src), '饼图上方必须仍显示当前日期（信息不丢）')
  need(/'data-role': 'tool-replay-toggle'/.test(src) && /onTogglePlay/.test(src), '回放必须有播放/暂停按钮')
  need(/'data-role': 'tool-replay-count'/.test(src) && /replayCountText\(/.test(src), '回放必须有 N/30 计数（唯一来源 replayCountText）')
  need(/REPLAY\.tickMs/.test(src) && /setPlaying/.test(src), '播放必须是本地步进（REPLAY.tickMs；不发请求）')
  // ① 段标题是用户语：可见副标题必须渲染（标题文案本身由 toolRegistry 的模型断言锁住）
  need(/'data-role': 'tool-section-subtitle'/.test(src) && /model\.market\.subtitle/.test(src), '段标题下必须渲染可见副标题（model.market.subtitle）')
  // 副标题必须**默认可见**（不许只进 title；也不许复用 tw-hint）
  const subAt = src.indexOf("'data-role': 'tool-section-subtitle'")
  need(subAt >= 0 && /className: 'tw-hint'/.test(src.slice(subAt, subAt + 240)) === false, '副标题不许复用 tw-hint（紧凑/隐身档会把它藏掉）')
  // ③′ 横条几何走 BAR 令牌（条高/圆角/行距；不许在页面里写死像素）
  need(/BAR\.trackHeight/.test(src) && /BAR\.radius/.test(src) && /BAR\.rowGap/.test(src) && /BAR\.barGap/.test(src), '横条的条高/圆角/行距必须走 BAR 令牌（判据见 toolDetailTheme.barProblems）')
  need(/bar\.deltaKind === 'warm' \? BAR\.warm/.test(src), '升温/降温的颜色必须走 BAR 的语义色（warm/cool/flat）')
  // ⑥ 播放语义：默认暂停、点击才步进、到最新即停、不循环、不发请求
  need(/const \[playing, setPlaying\] = useState\(false\)/.test(src), '播放必须默认暂停（不许加载即自动播放）')
  const playAt = src.indexOf('const [playing, setPlaying] = useState(false)')
  const playBlock = playAt < 0 ? '' : src.slice(playAt, src.indexOf('// 选中档', playAt))
  need(playBlock !== '', '找不到播放状态的 useEffect 区块（播放语义判据会失效）')
  need(/if \(step >= replayMax\) \{[\s\S]{0,120}?setPlaying\(false\)/.test(playBlock), '走到最新一步必须自动停下（不循环播放）')
  need(/window\.setTimeout\(\(\) => setStep/.test(playBlock), '播放步进必须走本地 setStep（不重新取数）')
  need(/api\.|fetch\(|reload\(/.test(playBlock) === false, '播放步进不许发请求（本地切片）')
  need(/'aria-label': io\.playing \? '暂停回放' : '播放回放'/.test(src), '播放按钮的 aria-label 必须随状态变化（可读屏操作）')
  // 接数据后的接线点
  need(/type: 'range'/.test(src) && /io\.onStep/.test(src), '回放滑块必须渲染（最近 30 个交易日手动回放）')
  // ③ 磁贴四件套：色标 + 标签 + 大号数值 +（右端）delta —— 缺一个都算磁贴没做全
  need(/'data-role': 'tool-kpi-swatch'/.test(src) && /cell\.swatch/.test(src), '磁贴必须有色标元素且颜色来自模型的 swatch')
  need(/'data-role': 'tool-kpi-delta'/.test(src) && /cell\.delta/.test(src), 'KPI 的 delta（较上日 ±x）必须渲染在右端')
  need(/'data-role': 'tool-kpi-value'/.test(src) && /cell\.text/.test(src), 'KPI 的大号数值必须渲染（文本来自模型）')
  need(/style: \{ \.\.\.SWATCH/.test(src) && /FLOW_SERIES_COLORS\[cell\.swatch/.test(src), '色标颜色必须取序列色（与曲线/图例同色）')
  // 版式令牌（唯一来源在 toolDetailTheme.ts）：页面必须用同一批常量，而不是再写一份字面量
  const used = stripImports(src)
  for (const [token, label] of [
    ['HERO_TYPE.title', 'Hero 大标题字号/字重'],
    ['HERO_TYPE.kicker', 'kicker 大写宽字距'],
    ['SUMMARY_TYPE.value', '摘要卡数值层级'],
    ['CARD_SURFACE', '卡片细边框 + 大圆角 + 无重阴影'],
    ['TILE_SURFACE', '磁贴表面'],
    ['CHART_TYPE.cardTitle', '卡内标题 16–18px 粗'],
    ['CHART_TYPE.asOf', 'AS OF 小号次要色'],
    ['CHART_TYPE.tileLabel', '磁贴标签小号'],
    ['CHART_TYPE.tileValue', '磁贴数值大号（20/700）'],
    ['CHART_TYPE.tileDelta', '磁贴右端「较上日 ±x」小号'],
    ['PLOT.heightCss', '绘图区有界高度（clamp 280–380）'],
    ['PIE.sizeCss', '饼图有界直径（clamp 220–320）'],
    ['CHART_SPLIT', '两列顺序契约（折线在左、饼在右）'],
    ['LEGEND_ROW', '图例居中'],
    ['LEGEND_DOT', '图例圆点'],
    ['RANGE_BOX', '范围控件凹陷容器'],
    ['RANGE_ON', '选中档浅底圆角块'],
    ['TOOL_SPACE.sectionGap', '区块间距'],
  ] as const) {
    need(used.includes(token), `详情页必须**真的用上** toolDetailTheme 的 ${token}（${label}）—— 只 import 不算`)
  }
  need((src.match(/className: 'tw-tool-card'/g) ?? []).length >= 4, '详情页卡片必须走 .tw-tool-card（细边框 + 大圆角 + 无重阴影）')
  // A 组：绘图区高度契约 + 真实像素画布 + reduced-motion 开关
  need(/height: PLOT\.heightCss/.test(src), '绘图区高度必须走 PLOT.heightCss（有界 clamp；不许由整卡 aspect-ratio 决定）')
  need(/plotHeightProblems\(boxStyle\)/.test(src), '绘图区必须自检高度契约（写死 160px / 回到 16-7 都要能拦住）')
  // ④ 两列：折线在左、饼在右；顺序来自 CHART_SPLIT；饼图尺寸走 PIE.sizeCss + pieProblems 自检
  need(/\.\.\.CHART_SPLIT\.map\(\(slot\) =>\s*\n?\s*slot === 'plot'/.test(src), '两列必须按 CHART_SPLIT 渲染（折线在左、饼在右；顺序判据的唯一来源）')
  need(/'data-role': 'tool-split-left'/.test(src) && /'data-role': 'tool-split-right'/.test(src), '两列必须有结构锚点（tool-split-left / tool-split-right）')
  need(/width: PIE\.sizeCss, height: PIE\.sizeCss/.test(src) && /pieProblems\(box\)/.test(src), '饼图尺寸必须走 PIE.sizeCss（有界）并自检')
  // 图例在饼**下方**：右列里"饼图组件调用"必须早于"饼图例容器"
  // ⚠ 比的是**渲染点**（`React.createElement(pieChart`），不是 pieChart 函数体里的 svg 锚点
  //   —— 函数定义在文件后面，直接比 svg 的源码位置会得出相反结论（实测踩到）。
  need(/'data-role': 'tool-pie'/.test(src), '饼图 svg 必须带结构锚点 tool-pie')
  const pieAt = src.indexOf('React.createElement(pieChart,')
  const pieLegendAt = src.indexOf("'data-role': 'tool-pie-legend'")
  need(pieAt >= 0 && pieLegendAt >= 0 && pieAt < pieLegendAt, `饼图图例必须在饼**下方**（渲染点 pie@${pieAt} 应早于 legend@${pieLegendAt}）`)
  need(/new ResizeObserver\(/.test(src) && /usePlotSize\(boxRef\)/.test(src), '绘图区必须按容器真实像素绘制（填满卡片、随容器自适应）')
  need(/'data-anim': props\.animOff \? 'off' : 'on'/.test(src) && /matchMedia\('\(prefers-reduced-motion: reduce\)'\)/.test(src), '动效必须有 reduced-motion 降级开关（matchMedia 驱动 data-anim）')
  // A 组：图例在**图表上方**（顺序断言：curveChart 里 legend 锚点必须早于 svg 绘制锚点）
  const curveBody = src.slice(src.indexOf('function curveChart('), src.indexOf('/** 静态饼图'))
  const legendAt = curveBody.indexOf("'data-role': 'tool-chart-legend'")
  const svgAt = curveBody.indexOf('viewBox: `0 0 ${W} ${H}`')
  need(curveBody !== '' && legendAt >= 0 && svgAt >= 0, '找不到 curveChart 的图例/画布锚点（顺序断言会失效）')
  need(legendAt >= 0 && svgAt >= 0 && legendAt < svgAt, `图例必须在图表**上方**（居中）：legend@${legendAt} 应早于 svg@${svgAt}`)
  // 顺序的**唯一来源**是 CHART_STACK（页面必须照它渲染）——否则"源码位置"与"真实渲染顺序"会脱钩
  need(/\.\.\.CHART_STACK\.map\(\(slot\) => \(slot === 'legend' \? legend : plotEl\)\),/.test(src), '主线图表卡必须按 CHART_STACK 渲染（图例在上、画布在下；顺序判据的唯一来源）')
  // B 组：悬停十字线 + 提示框；切档淡入；回放平滑；不用任何第三方图表库
  need(/'data-role': 'tool-crosshair'/.test(src) && /nearestIndex\(/.test(src), '悬停必须有十字线与取点（nearestIndex）')
  need(/'data-role': 'tool-hover-tip'/.test(src) && /hoverRowsOf\(props\.series, hover\)/.test(src), '悬停提示框必须渲染（行模型来自 hoverRowsOf，页面不另算一份）')
  need(/hoverRows\.map\(/.test(src) && /r\.text/.test(src), '提示框必须逐序列列出值（缺值走模型里的「未取到」）')
  // ⚠ 用**剥注释**的正文：注释里也会写 `MOTION_STYLE.fadeIn`，拿 src 判会被注释满足（实测踩到）
  need(/style: MOTION_STYLE\.fadeIn/.test(visible) && /key: `range-\$\{props\.days\.length\}`/.test(src), '切档必须有过渡动画（按窗口长度重挂载绘图组 ⇒ 重放淡入）')
  need(/pathStyle\(/.test(src) && /key: `line-\$\{si\}`/.test(src), '回放平滑跟随：路径经 pathStyle 交给 CSS，且 key 不含回放步（不重建、不闪）')
  need(/from 'recharts'|from 'chart\.js'|from 'echarts'|from 'd3'/.test(src) === false, '不许引入第三方图表库（只用 CSS/SVG）')
  // ④ 口径降噪：sectionHead 的 note 只进 title/aria-label，**不再**作为常驻文本渲染（事实仍可读）
  need(/'data-role': 'tool-section-title'/.test(src) && /title: note/.test(src) && /'aria-label': `\$\{title\}：\$\{note\}`/.test(src), '区块口径行必须降噪进 title/aria-label（事实不许丢）')
  const headAt = src.indexOf('function sectionHead(')
  // 只取**函数体**：从签名的 `): React.ReactElement {` 之后开始（跳过形参 `note`，也避开别的函数里的 `) {`）
  const SIG = '): React.ReactElement {'
  const sigAt = headAt < 0 ? -1 : src.indexOf(SIG, headAt)
  const headBody = sigAt < 0 ? '' : src.slice(sigAt + SIG.length, src.indexOf('\n}', sigAt) + 2)
  const noteUses = (headBody.match(/\bnote\b/g) ?? []).length
  need(headBody !== '', '找不到 sectionHead 的函数体（降噪判据会失效）')
  // 降噪的**可判定**形态：`note` 只允许出现在 title 与 aria-label 两处；多一处就是又变成常驻文本了
  need(noteUses === 2, `区块口径行不许再作为常驻文本渲染（sectionHead 里 note 只允许出现在 title/aria-label；实得 ${noteUses} 处）`)
  need(/cell\.text/.test(src), 'KPI 的文本必须渲染')
  need(/model\.market\.rowNotes\[i\]/.test(src), '市场表的逐行原因必须渲染（缺数据行要显示「未取到 + 原因」）')
  need(/model\.extras\.map\(/.test(src), '附加块（A股净流入单列）必须渲染')
  // 常驻状态行只留必要事实：文本来自 model.status，完整口径进 title/aria-label
  need(/'data-role': 'tool-status'/.test(src), '状态行必须带 data-role（可断言且可定位）')
  need(/model\.status\b/.test(src), '状态行文本必须来自 model.status')
  need(/title: model\.statusTitle/.test(src) && /'aria-label': model\.statusTitle/.test(src), '状态行的完整版必须进 title 与 aria-label（长文案不占版面但仍可读）')
  // ④ 边界声明（含「不是真实跨境资金净流入」这条免责）与状态行**不许复用 tw-hint**：
  // 那个类在紧凑/隐身视图下 display:none（styles.ts:90-98）⇒ 复用等于把免责声明藏起来。
  need(/'tool-legal'/.test(src) && /'tool-legal-line'/.test(src), '边界散文段必须带 tool-legal / tool-legal-line 锚点（可断言且可定位）')
  for (const [role, label] of [['tool-status', '状态行'], ['tool-row-note', '逐行缺口原因'], ['tool-pie-missing', '饼图缺块说明'], ['tool-market-total', '份额合计（分母口径）'], ['tool-marks-note', '实测/重建说明'], ['tool-bar-detail', '横条里的诚实信息']] as const) {
    // ⚠ 扫**每一处**出现（不只第一处）：同一个锚点可能在横条与表格回退里各有一份，
    //    只看第一处的话，给另一处挂上 tw-hint 就抓不到了（实测踩到）。
    let at = src.indexOf(`'data-role': '${role}'`)
    need(at >= 0, `${label}必须带 data-role="${role}"（可断言且可定位）`)
    while (at >= 0) {
      // 只扫这个元素紧挨着的 props（前面的注释会提到 tw-hint，别把注释当成复用了它；
      // 窗口也刻意开小，免得把后面 curveChart 里的 tw-hint 算进来）
      const block = src.slice(at, at + 240)
      need(/className: 'tw-hint'/.test(block) === false, `${label}不许复用 tw-hint（紧凑/隐身视图会把它整块隐藏）`)
      at = src.indexOf(`'data-role': '${role}'`, at + 1)
    }
  }
  // 两段散文的渲染器本身也不许复用 tw-hint（它是整块免责/口径的载体）
  const proseAt = src.indexOf('function proseSection(')
  const proseBody = proseAt < 0 ? '' : src.slice(proseAt, src.indexOf('\n}', proseAt) + 2)
  need(proseBody !== '', '找不到 proseSection 的函数体（可见性判据会失效）')
  need(/className: 'tw-hint'/.test(proseBody) === false, '散文段不许复用 tw-hint（紧凑/隐身视图会把免责与口径整块藏掉）')
  return bad
}

test('② 详情页三段式 + 时间范围控件 + 功能区接线齐全；十六种注入各让检查非空', () => {
  const src = FILES.page
  const bad = renderWiringProblems(src)
  assert.deepEqual(bad, [], `渲染接线检查未通过：${bad.join(' ／ ')}`)
  const injections: Array<{ name: string; mutate: (s: string) => string; hit: RegExp }> = [
    { name: '卡片网格改成两列', mutate: (s) => s.replace('repeat(3, minmax(0, 1fr))', 'repeat(2, minmax(0, 1fr))'), hit: /三列/ },
    { name: '卡片页脚入口文案加回来', mutate: (s) => s.replace('}, card.blurb),', "}, card.blurb), React.createElement('div', null, '打开工具 →'),"), hit: /打开工具/ },
    { name: '卡片换成 div（丢按钮语义）', mutate: (s) => s.replace('React.createElement(\n              CARD_TAG,', "React.createElement(\n              'div',"), hit: /CARD_TAG|toolCardView/ },
    { name: '卡片不再用 CARD_PROPS（键盘可达与 type=button 没了）', mutate: (s) => s.replace('...CARD_PROPS,\n                key: card.id,', 'key: card.id,'), hit: /CARD_PROPS|toolCardView/ },
    { name: '卡片不再用 CARD_STYLE（阴影/圆角没了）', mutate: (s) => s.replace('style: CARD_STYLE,', "style: { cursor: 'pointer' },"), hit: /CARD_STYLE|toolCardView/ },
    { name: '空数据时不再渲染占位文案', mutate: (s) => s.replace('model.pie.empty', "''"), hit: /model\.pie\.empty/ },
    { name: 'KPI 的 delta 不渲染', mutate: (s) => s.replace("'data-role': 'tool-kpi-delta'", "'data-role': 'tool-kpi-delta-x'"), hit: /delta/ },
    { name: '回放滑块改成固定文本', mutate: (s) => s.replace("type: 'range',", "type: 'hidden',"), hit: /回放滑块/ },
    // v0.81.0 新增：三段结构 / 范围控件 / 状态行压缩
    { name: 'Hero 整段删掉', mutate: (s) => s.replace("    heroView(model, io),\n", ''), hit: /三段式|Hero/ },
    { name: '摘要卡整段删掉', mutate: (s) => s.replace("    summaryCards(model),\n", ''), hit: /三段式|摘要卡/ },
    { name: '图表卡整段删掉', mutate: (s) => s.replace("'data-role': 'tool-chart-card'", "'data-role': 'tool-chart-x'"), hit: /三段式|图表卡/ },
    { name: '三段顺序颠倒（摘要在 Hero 之前）', mutate: (s) => s.replace("    heroView(model, io),\n    summaryCards(model),", "    summaryCards(model),\n    heroView(model, io),"), hit: /Hero|摘要卡|顺序/ },
    { name: '范围档位写死三档（绕过模型）', mutate: (s) => s.replace('model.ranges.options.map(', '[90, 180, 365].map('), hit: /范围档位/ },
    { name: '范围控件不可点（去掉 onRange）', mutate: (s) => s.replace('onClick: () => io.onRange(n)', 'onClick: () => undefined'), hit: /范围档位|onRange/ },
    { name: '默认窗口写死 180（绕过工具声明）', mutate: (s) => s.replace('entry?.ranges?.initial ?? null', '180'), hit: /默认窗口/ },
    {
      name: 'KPI 口径行（缺数据原因）被丢掉',
      mutate: (s) =>
        s.replace(
          "{ 'data-role': 'tool-chart-title', style: CHART_TYPE.cardTitle, title: `${model.curve.title}｜${model.kpi.note}`, 'aria-label': `${model.curve.title}：${model.kpi.note}` },",
          "{ 'data-role': 'tool-chart-title', style: CHART_TYPE.cardTitle },",
        ),
      hit: /KPI 口径行/,
    },
    { name: '状态行不再把完整口径放进 title/aria-label', mutate: (s) => s.replace('title: model.statusTitle,', 'title: undefined,'), hit: /statusTitle|title/ },
    {
      name: '散文段复用 tw-hint（紧凑/隐身视图会把免责与口径藏掉）',
      mutate: (s) => s.replace("{ 'data-role': lineRole, style: { margin: 0, fontSize: 12.5, lineHeight: 1.8, color: 'var(--tw-muted)' } }", "{ 'data-role': lineRole, className: 'tw-hint' }"),
      hit: /散文段不许复用 tw-hint/,
    },
    // ── v0.85.0（目标布局 5 条）：区名回填 / 饼图计数 / 播放按钮 / 中心孔 / 横条回表格 / 诚实信息 / 结论行 ──
    { name: '饼图去掉 N/30 计数', mutate: (s) => s.replace("'data-role': 'tool-replay-count'", "'data-role': 'tool-replay-count-x'"), hit: /N\/30 计数|回放/ },
    { name: '回放去掉播放/暂停按钮', mutate: (s) => s.replace("'data-role': 'tool-replay-toggle'", "'data-role': 'tool-replay-toggle-x'"), hit: /播放\/暂停|回放/ },
    { name: '饼图挖回中心孔（改回圆环）', mutate: (s) => s.replace("    // ⚠ **实心饼**", "    React.createElement('circle', { 'data-role': 'tool-pie-center', cx: CX, cy: CY, r: R * 0.42, fill: 'var(--tw-card)' }),\n    // ⚠ **实心饼**"), hit: /中心孔|实心/ },
    { name: '横条改回表格（bars 不渲染）', mutate: (s) => s.replace('model.market.bars.map(barRow)', '[]'), hit: /横条|bars/ },
    { name: '横条丢掉诚实信息（规模/偏好分/动量/排名）', mutate: (s) => s.replace("{ 'data-role': 'tool-bar-detail', title: bar.detail, 'aria-label': bar.detail,", "{ 'data-role': 'tool-bar-detail-x', title: '', 'aria-label': '',"), hit: /诚实信息|横条/ },
    { name: '段末结论行删掉', mutate: (s) => s.replace("'data-role': 'tool-conclusion'", "'data-role': 'tool-conclusion-x'"), hit: /结论/ },
    { name: '回放改成加载即自动播放（违背"不做自动播放"）', mutate: (s) => s.replace('const [playing, setPlaying] = useState(false)', 'const [playing, setPlaying] = useState(true)'), hit: /默认暂停|自动播放|播放/ },
    { name: '回放改成循环播放（到最新也不停）', mutate: (s) => s.replace('if (step >= replayMax) {', 'if (false) {'), hit: /自动停下|不循环|播放/ },
    { name: '播放步进改去发请求（不再是本地切片）', mutate: (s) => s.replace('const timer = window.setTimeout(() => setStep((prev) => Math.min(replayMax, prev + 1)), REPLAY.tickMs)', 'const timer = window.setTimeout(() => { void api().then(() => setStep((prev) => Math.min(replayMax, prev + 1))) }, REPLAY.tickMs)'), hit: /不许发请求|本地|播放/ },
    { name: '横条几何写死像素（不用 BAR 令牌）', mutate: (s) => s.replace('height: BAR.trackHeight, borderRadius: BAR.radius', 'height: 10, borderRadius: 5'), hit: /BAR 令牌|横条/ },
    { name: '副标题复用 tw-hint（紧凑档看不见）', mutate: (s) => s.replace("'data-role': 'tool-section-subtitle', style:", "'data-role': 'tool-section-subtitle', className: 'tw-hint', style:"), hit: /副标题.*tw-hint/ },
    { name: '可见副标题删掉', mutate: (s) => s.replace("'data-role': 'tool-section-subtitle'", "'data-role': 'tool-section-subtitle-x'"), hit: /副标题/ },
    { name: '边界段改回项目符号列表', mutate: (s) => s.replace("proseSection(model.boundary.title, model.boundary.lines, 'tool-legal', 'tool-legal-line')", "React.createElement('ul', { 'data-role': 'tool-legal' }, React.createElement('li', { 'data-role': 'tool-legal-line' }, model.boundary.lines.join('；')))"), hit: /项目符号|散文段|边界/ },
    {
      name: '逐行缺口原因复用 tw-hint（紧凑档只剩「未取到」没有原因）',
      mutate: (s) => s.replace("'data-role': 'tool-row-note', colSpan", "'data-role': 'tool-row-note', className: 'tw-hint', colSpan"),
      hit: /逐行缺口原因.*不许复用 tw-hint/,
    },
    // ── 本批（对齐参考版 A/B 两组）：排版 / 卡片 / 磁贴 / 图例顺序 / 绘图区 / 动效 / 降噪 ──
    { name: 'Hero 标题缩回 17px（回到对齐前）', mutate: (s) => s.replace('style: { margin: 0, ...HERO_TYPE.title }', 'style: { margin: 0, fontSize: 17, fontWeight: 600 }'), hit: /HERO_TYPE|标题字号/ },
    { name: 'kicker 退回胶囊标签', mutate: (s) => s.replace("'data-role': 'tool-hero-kicker', style: HERO_TYPE.kicker", "'data-role': 'tool-hero-kicker', style: { fontSize: 10.5, borderRadius: 6, border: '1px solid var(--tw-border)', background: 'var(--tw-accent-soft)' }"), hit: /kicker/ },
    { name: '摘要卡数值回到 16px（层级塌掉）', mutate: (s) => s.replace("style: { ...SUMMARY_TYPE.value, color: card.value", "style: { fontSize: 16, fontWeight: 600, color: card.value"), hit: /SUMMARY_TYPE|摘要卡/ },
    {
      name: '卡片改回 tw-panel（细边框/大圆角/无重阴影全丢）',
      mutate: (s) => s.split("className: 'tw-tool-card'").join("className: 'tw-panel'").split('style: { ...CARD_SURFACE').join('style: {').split('style: CARD_SURFACE').join('style: {}'),
      hit: /tw-tool-card|CARD_SURFACE/,
    },
    { name: '磁贴色标删掉（参考版每块都有色标）', mutate: (s) => s.replace("'data-role': 'tool-kpi-swatch'", "'data-role': 'tool-kpi-swatch-x'"), hit: /色标/ },
    { name: '磁贴值不再用大号字（回到 12.5px）', mutate: (s) => s.replace("'data-role': 'tool-kpi-value', style: { ...CHART_TYPE.tileValue,", "'data-role': 'tool-kpi-value', style: { fontSize: 12.5,"), hit: /CHART_TYPE|磁贴/ },
    { name: '图例挪到画布之后（顺序颠倒）', mutate: (s) => s.replace('...CHART_STACK.map((slot) => (slot === \'legend\' ? legend : plotEl)),', 'plotEl,\n    legend,'), hit: /图例|CHART_STACK/ },
    { name: '图例不再居中（退回左对齐）', mutate: (s) => s.replace("{ 'data-role': 'tool-chart-legend', style: LEGEND_ROW }", "{ 'data-role': 'tool-chart-legend', style: { display: 'flex', gap: 10 } }"), hit: /LEGEND_ROW|图例/ },
    { name: '绘图区写死 160px（用户点名的塌陷写法）', mutate: (s) => s.replace('height: PLOT.heightCss', "height: '160px'"), hit: /高度|绘图区/ },
    { name: '绘图区回到整卡 aspect-ratio（上一版病根）', mutate: (s) => s.replace('height: PLOT.heightCss }', "aspectRatio: '16 / 7' }"), hit: /高度|绘图区/ },
    { name: '两列顺序颠倒（饼在左、折线在右）', mutate: (s) => s.replace("slot === 'plot'", "slot === 'pie'"), hit: /两列|CHART_SPLIT|顺序/ },
    { name: '两列改回单列（整块只剩折线图）', mutate: (s) => s.split('...CHART_SPLIT.map((slot) =>').join('...["plot"].map((slot) =>'), hit: /两列|CHART_SPLIT/ },
    { name: '饼图尺寸改成 80px（参考版尺寸丢）', mutate: (s) => s.replace('width: PIE.sizeCss, height: PIE.sizeCss', "width: '80px', height: '80px'"), hit: /饼图|PIE\.sizeCss/ },
    { name: '饼图图例删掉（看不出每块是谁）', mutate: (s) => s.replace("'data-role': 'tool-pie-legend'", "'data-role': 'tool-pie-legend-x'"), hit: /饼图图例|tool-pie-legend/ },
    { name: '绘图区不再按容器真实像素绘制（ResizeObserver 拿掉）', mutate: (s) => s.replace('const size = usePlotSize(boxRef)', 'const size = { w: 720, h: 180 }'), hit: /真实像素|绘图区/ },
    { name: '悬停提示框删掉（看不见逐序列的值）', mutate: (s) => s.replace("'data-role': 'tool-hover-tip'", "'data-role': 'tool-hover-tip-x'"), hit: /提示框|悬停/ },
    { name: '悬停十字线删掉', mutate: (s) => s.replace("'data-role': 'tool-crosshair'", "'data-role': 'tool-crosshair-x'"), hit: /十字线/ },
    { name: '切档过渡动画删掉', mutate: (s) => s.replace('style: MOTION_STYLE.fadeIn', 'style: undefined'), hit: /切档|过渡|MOTION_STYLE/ },
    { name: '回放平滑跟随删掉（路径不再交给 CSS）', mutate: (s) => s.replace('style: pathStyle(d.trim()),', ''), hit: /pathStyle|回放/ },
    { name: 'reduced-motion 开关删掉（动效无法降级）', mutate: (s) => s.split("'data-anim': props.animOff ? 'off' : 'on',").join(''), hit: /reduced-motion|动效/ },
    {
      name: '区块口径行又变回常驻文本（噪声回来了）',
      mutate: (s) => s.replace("React.createElement('span', { className: 't', 'data-role': 'tool-section-title', title: note,", "React.createElement('span', { className: 't', 'data-role': 'tool-section-title', children: note, title: note,"),
      hit: /降噪|口径行|常驻/,
    },
    { name: '饼图缺块说明复用 tw-hint（紧凑档看不见缺了哪些）', mutate: (s) => s.replace("'data-role': 'tool-pie-missing', style:", "'data-role': 'tool-pie-missing', className: 'tw-hint', style:"), hit: /饼图缺块/ },
    { name: '份额合计（分母口径）复用 tw-hint（紧凑档看不见分母）', mutate: (s) => s.replace("'data-role': 'tool-market-total',", "'data-role': 'tool-market-total', className: 'tw-hint',"), hit: /份额合计/ },
    {
      name: '状态行复用 tw-hint（数据来源/回退态会被藏掉）',
      mutate: (s) => s.replace("'data-role': 'tool-status',\n            title: model.statusTitle,", "'data-role': 'tool-status',\n            className: 'tw-hint',\n            title: model.statusTitle,"),
      hit: /状态行不许复用 tw-hint/,
    },
  ]
  for (const { name, mutate, hit } of injections) {
    const mutated = mutate(src)
    assert.notEqual(mutated, src, `注入「${name}」必须真的改到了源码（否则这条证明无效）`)
    const fail = renderWiringProblems(mutated)
    assert.ok(fail.length > 0, `注入「${name}」必须被检查抓到（实际一条都没报 ⇒ 断言恒真）`)
    assert.match(fail.join(' ／ '), hit, `注入「${name}」报的原因应是预期的：${JSON.stringify(fail)}`)
  }
})

/**
 * 回目录按钮（v0.82.0：移到左上角、改成圆角卡片按钮、Material 风格）的**接线检查**。
 * 返回失败原因列表（空 = 通过）⇒ 同一份检查既跑真实源码，也跑下面的注入（证明断言非恒真）。
 */
export function backButtonWiringProblems(src: string): string[] {
  const bad: string[] = []
  const need = (cond: boolean, msg: string): void => {
    if (!cond) bad.push(msg)
  }
  need(/'data-role': 'tool-back'/.test(src), '回目录按钮必须带 data-role="tool-back"（可断言且可定位）')
  // 外观与判据的唯一来源：常量必须从 toolBackButton.ts 引入并使用
  for (const token of ['BACK_BTN_TAG', 'BACK_BTN_PROPS', 'BACK_BTN_STYLE', 'BACK_BTN_HOVER_STYLE', 'BACK_BTN_PRESS_STYLE', 'BACK_BTN_FOCUS_STYLE', 'BACK_BTN_TITLE']) {
    need(src.includes(token), `回目录按钮必须用 toolBackButton.ts 的 ${token}（外观/文案只有一份来源）`)
  }
  // 三态反馈 + 键盘可达（原生 button + type=button 由 BACK_BTN_PROPS 给）
  for (const handler of ['onMouseEnter', 'onMouseLeave', 'onMouseDown', 'onMouseUp', 'onFocus', 'onBlur']) {
    need(src.includes(handler), `回目录按钮缺少 ${handler}（悬停/按下/focus 三态反馈）`)
  }
  // 仍然是回目录的**唯一入口**：onClick 必须接到目录返回
  // 唯一入口要**两端都接上**：调用点传 backToCatalog、组件内部把它接到 onClick
  need(/React\.createElement\(BackToCatalog, \{ onClick: backToCatalog/.test(src), '回目录按钮的调用点必须接上 backToCatalog（它是回目录的唯一入口）')
  need(/onClick: props\.onClick/.test(src), '按钮内部必须把 onClick 接到 props.onClick（否则点不动，回目录入口等于断了）')
  // 无障碍名齐备
  need(/title: BACK_BTN_TITLE/.test(src) && /'aria-label': BACK_BTN_TITLE/.test(src), 'title 与 aria-label 必须齐备（同一份文案）')
  // 不许复用会被紧凑/隐身视图隐藏的 class（那个按钮只允许内联样式）
  const at = src.indexOf("'data-role': 'tool-back'")
  if (at >= 0) {
    const block = src.slice(at, at + 700)
    need(/className: 'tw-(hint|chartnote|drawer-foot|pop-hint)'/.test(block) === false, '回目录按钮不许复用会被紧凑/隐身视图隐藏的 class（tw-hint 一类）')
    need(/style: \{/.test(block) && /BACK_BTN_STYLE/.test(block), '回目录按钮的外观必须来自 BACK_BTN_STYLE（内联样式）')
  }
  // 位置：仍在 Hero 之前（回目录入口在页顶左侧）
  const body = detailViewBody(src)
  const backAt = body.indexOf('BackToCatalog')
  const heroAt = body.indexOf('heroView(model, io)')
  need(backAt >= 0 && heroAt > backAt, '回目录按钮必须仍在 Hero 之前（且不许被挪到 Hero 里面/之后）')
  return bad
}

test('④ 回目录按钮：左上角圆角卡片（Material）——常量判据 + 源码接线 + 五条注入必败', () => {
  // ① 常量层：真实常量必须通过布局判据与交互判据
  const layout = backButtonLayoutProblems(BACK_BTN_STYLE)
  assert.deepEqual(layout, [], `回目录按钮布局判据未通过：${layout.join(' ／ ')}`)
  const interaction = backButtonInteractionProblems({
    tag: BACK_BTN_TAG,
    props: BACK_BTN_PROPS,
    hasHover: Object.keys(BACK_BTN_HOVER_STYLE).length > 0,
    hasPress: Object.keys(BACK_BTN_PRESS_STYLE).length > 0,
    hasFocus: Object.keys(BACK_BTN_FOCUS_STYLE).length > 0,
    hasReturn: true,
    title: BACK_BTN_TITLE,
    ariaLabel: BACK_BTN_TITLE,
  })
  assert.deepEqual(interaction, [], `回目录按钮交互判据未通过：${interaction.join(' ／ ')}`)
  assert.equal(BACK_BTN_STYLE.alignSelf, 'flex-start', '左上角对齐（不居中、不占整行）')
  assert.equal(BACK_BTN_STYLE.width, 'auto', '按内容宽度排布（不占整行）')
  assert.notEqual(String(BACK_BTN_STYLE.borderRadius), '0', '圆角非 0')
  assert.equal(String(BACK_BTN_STYLE.boxShadow).includes('none'), false, '必须有阴影层级')

  // ② 注入层：把每一项要求关掉 ⇒ 对应判据必须报错（每条都验"非恒真"）
  const layoutInjections: Array<{ name: string; style: Record<string, unknown>; hit: RegExp }> = [
    { name: '按钮居中/占整行', style: { ...BACK_BTN_STYLE, alignSelf: 'stretch', width: '100%' }, hit: /左上角对齐|不许占整行/ },
    { name: '圆角改成 0', style: { ...BACK_BTN_STYLE, borderRadius: 0 }, hit: /圆角必须是 8–12px/ },
    { name: '阴影去掉', style: { ...BACK_BTN_STYLE, boxShadow: 'none' }, hit: /必须有轻微阴影/ },
    { name: '内边距/间距/字重不达 Material 度量', style: { ...BACK_BTN_STYLE, padding: '0', gap: 0, fontWeight: 400, fontSize: 18 }, hit: /内边距|间距|字重|字号/ },
  ]
  for (const { name, style, hit } of layoutInjections) {
    const fail = backButtonLayoutProblems(style as never)
    assert.ok(fail.length > 0, `注入「${name}」必须被布局判据抓到（一条都没报 ⇒ 断言恒真）`)
    assert.match(fail.join(' ／ '), hit, `注入「${name}」报的原因应是预期的：${JSON.stringify(fail)}`)
  }
  const interactionInjections: Array<{ name: string; patch: Record<string, unknown>; hit: RegExp }> = [
    { name: '键盘不可达（换成 div）', patch: { tag: 'div' }, hit: /原生 button/ },
    { name: '没有悬停反馈', patch: { hasHover: false }, hit: /悬停反馈/ },
    { name: '没有按下反馈', patch: { hasPress: false }, hit: /按下反馈/ },
    { name: '没有 focus 可见环', patch: { hasFocus: false }, hit: /focus 可见环/ },
    { name: '断掉回目录接线', patch: { hasReturn: false }, hit: /回到工具目录/ },
    { name: '无障碍名缺失', patch: { title: '', ariaLabel: '' }, hit: /title 必须齐备|aria-label 必须齐备/ },
  ]
  const base = { tag: BACK_BTN_TAG, props: BACK_BTN_PROPS, hasHover: true, hasPress: true, hasFocus: true, hasReturn: true, title: BACK_BTN_TITLE, ariaLabel: BACK_BTN_TITLE }
  for (const { name, patch, hit } of interactionInjections) {
    const fail = backButtonInteractionProblems({ ...base, ...patch } as never)
    assert.ok(fail.length > 0, `注入「${name}」必须被交互判据抓到（一条都没报 ⇒ 断言恒真）`)
    assert.match(fail.join(' ／ '), hit, `注入「${name}」报的原因应是预期的：${JSON.stringify(fail)}`)
  }

  // ③ 源码接线层（含三条注入）
  const src = FILES.page
  const bad = backButtonWiringProblems(src)
  assert.deepEqual(bad, [], `回目录按钮接线检查未通过：${bad.join(' ／ ')}`)
  const srcInjections: Array<{ name: string; mutate: (s: string) => string; hit: RegExp }> = [
    { name: '回目录按钮整块删掉', mutate: (s) => s.replace("    React.createElement(BackToCatalog, { onClick: backToCatalog, label: model.backAction }),\n", ''), hit: /回目录按钮必须带|必须仍在 Hero 之前/ },
    { name: '接线断开（onClick 不接目录返回）', mutate: (s) => s.replace('onClick: props.onClick,', 'onClick: () => undefined,'), hit: /唯一入口|onClick/ },
    { name: '复用会被隐藏的 class（tw-hint）', mutate: (s) => s.replace("'data-role': 'tool-back',", "'data-role': 'tool-back', className: 'tw-hint',"), hit: /不许复用/ },
    {
      name: '挪到 Hero 之后',
      mutate: (s) => {
        const line = '    React.createElement(BackToCatalog, { onClick: backToCatalog, label: model.backAction }),\n'
        return s.replace(line, '').replace('    summaryCards(model),', `${line}    summaryCards(model),`)
      },
      hit: /Hero 之前/,
    },
  ]
  for (const { name, mutate, hit } of srcInjections) {
    const mutated = mutate(src)
    assert.notEqual(mutated, src, `注入「${name}」必须真的改到了源码`)
    const fail = backButtonWiringProblems(mutated)
    assert.ok(fail.length > 0, `注入「${name}」必须被接线检查抓到（一条都没报 ⇒ 断言恒真）`)
    assert.match(fail.join(' ／ '), hit, `注入「${name}」报的原因应是预期的：${JSON.stringify(fail)}`)
  }
})

test('③ KPI 磁贴四块 = 宏观四块（对齐参考版）；无数据 ⇒ 全是「未取到」+ null；标签零阿拉伯数字', () => {
  const d = detailModel(cakeTool)
  assert.equal(d.kpi.cells.length, 4, `图表卡必须正好四块磁贴（实得 ${d.kpi.cells.length}）`)
  for (const cell of d.kpi.cells) {
    assert.equal(cell.text, NOT_FETCHED, `无数据时磁贴「${cell.label}」必须是「${NOT_FETCHED}」`)
    assert.equal(cell.value, null, `无数据时磁贴「${cell.label}」的值必须是 null（不许 0 顶替）`)
  }
  const labels = d.kpi.cells.map((c) => c.label)
  assert.deepEqual(labels, ['蛋糕温度', '流动性支持度', '美国十年期国债收益率', '广义美元指数'], '四块磁贴 = 用户指定的宏观四块')
  // 工具声明进的是"无数据"整份模型 ⇒ **标签必须零阿拉伯数字**（所以写「十年期」而不是「10Y」）
  for (const l of labels) {
    assert.equal(/\d/.test(l), false, `磁贴标签不许含阿拉伯数字（红线：无数据模型零数字）：${l}`)
  }
  assert.equal(labels.some((l) => l.includes('10Y')), false, '「10Y」这种带数字的写法只允许出现在**有数据的**悬停口径里')
  // 反例注入：把某块磁贴改成常量（页面/模型里都不许出现"常量磁贴"）
  const fake = { ...d, kpi: { ...d.kpi, cells: d.kpi.cells.map((c, i) => (i === 0 ? { ...c, text: '蛋糕温度 42', value: 42 } : c)) } }
  assert.throws(() => assert.deepEqual(fake.kpi.cells.map((c) => c.text), [NOT_FETCHED, NOT_FETCHED, NOT_FETCHED, NOT_FETCHED], '反例上必须失败'), /反例上/, '⚠ 反例（塞一个常量磁贴）必须让断言失败')
})

test('④ 回目录按钮：左上角圆角卡片（Material）——常量判据 + 源码接线 + 五条注入必败', () => {
  // ① 常量层：真实常量必须通过布局判据与交互判据
  const layout = backButtonLayoutProblems(BACK_BTN_STYLE)
  assert.deepEqual(layout, [], `回目录按钮布局判据未通过：${layout.join(' ／ ')}`)
  const interaction = backButtonInteractionProblems({
    tag: BACK_BTN_TAG,
    props: BACK_BTN_PROPS,
    hasHover: Object.keys(BACK_BTN_HOVER_STYLE).length > 0,
    hasPress: Object.keys(BACK_BTN_PRESS_STYLE).length > 0,
    hasFocus: Object.keys(BACK_BTN_FOCUS_STYLE).length > 0,
    hasReturn: true,
    title: BACK_BTN_TITLE,
    ariaLabel: BACK_BTN_TITLE,
  })
  assert.deepEqual(interaction, [], `回目录按钮交互判据未通过：${interaction.join(' ／ ')}`)
  assert.equal(BACK_BTN_STYLE.alignSelf, 'flex-start', '左上角对齐（不居中、不占整行）')
  assert.equal(BACK_BTN_STYLE.width, 'auto', '按内容宽度排布（不占整行）')
  assert.notEqual(String(BACK_BTN_STYLE.borderRadius), '0', '圆角非 0')
  assert.equal(String(BACK_BTN_STYLE.boxShadow).includes('none'), false, '必须有阴影层级')

  // ② 注入层：把每一项要求关掉 ⇒ 对应判据必须报错（每条都验"非恒真"）
  const layoutInjections: Array<{ name: string; style: Record<string, unknown>; hit: RegExp }> = [
    { name: '按钮居中/占整行', style: { ...BACK_BTN_STYLE, alignSelf: 'stretch', width: '100%' }, hit: /左上角对齐|不许占整行/ },
    { name: '圆角改成 0', style: { ...BACK_BTN_STYLE, borderRadius: 0 }, hit: /圆角必须是 8–12px/ },
    { name: '阴影去掉', style: { ...BACK_BTN_STYLE, boxShadow: 'none' }, hit: /必须有轻微阴影/ },
    { name: '内边距/间距/字重不达 Material 度量', style: { ...BACK_BTN_STYLE, padding: '0', gap: 0, fontWeight: 400, fontSize: 18 }, hit: /内边距|间距|字重|字号/ },
  ]
  for (const { name, style, hit } of layoutInjections) {
    const fail = backButtonLayoutProblems(style as never)
    assert.ok(fail.length > 0, `注入「${name}」必须被布局判据抓到（一条都没报 ⇒ 断言恒真）`)
    assert.match(fail.join(' ／ '), hit, `注入「${name}」报的原因应是预期的：${JSON.stringify(fail)}`)
  }
  const interactionInjections: Array<{ name: string; patch: Record<string, unknown>; hit: RegExp }> = [
    { name: '键盘不可达（换成 div）', patch: { tag: 'div' }, hit: /原生 button/ },
    { name: '没有悬停反馈', patch: { hasHover: false }, hit: /悬停反馈/ },
    { name: '没有按下反馈', patch: { hasPress: false }, hit: /按下反馈/ },
    { name: '没有 focus 可见环', patch: { hasFocus: false }, hit: /focus 可见环/ },
    { name: '断掉回目录接线', patch: { hasReturn: false }, hit: /回到工具目录/ },
    { name: '无障碍名缺失', patch: { title: '', ariaLabel: '' }, hit: /title 必须齐备|aria-label 必须齐备/ },
  ]
  const base = { tag: BACK_BTN_TAG, props: BACK_BTN_PROPS, hasHover: true, hasPress: true, hasFocus: true, hasReturn: true, title: BACK_BTN_TITLE, ariaLabel: BACK_BTN_TITLE }
  for (const { name, patch, hit } of interactionInjections) {
    const fail = backButtonInteractionProblems({ ...base, ...patch } as never)
    assert.ok(fail.length > 0, `注入「${name}」必须被交互判据抓到（一条都没报 ⇒ 断言恒真）`)
    assert.match(fail.join(' ／ '), hit, `注入「${name}」报的原因应是预期的：${JSON.stringify(fail)}`)
  }

  // ③ 源码接线层（含三条注入）
  const src = FILES.page
  const bad = backButtonWiringProblems(src)
  assert.deepEqual(bad, [], `回目录按钮接线检查未通过：${bad.join(' ／ ')}`)
  const srcInjections: Array<{ name: string; mutate: (s: string) => string; hit: RegExp }> = [
    { name: '回目录按钮整块删掉', mutate: (s) => s.replace("    React.createElement(BackToCatalog, { onClick: backToCatalog, label: model.backAction }),\n", ''), hit: /回目录按钮必须带|必须仍在 Hero 之前/ },
    { name: '接线断开（onClick 不接目录返回）', mutate: (s) => s.replace('onClick: props.onClick,', 'onClick: () => undefined,'), hit: /唯一入口|onClick/ },
    { name: '复用会被隐藏的 class（tw-hint）', mutate: (s) => s.replace("'data-role': 'tool-back',", "'data-role': 'tool-back', className: 'tw-hint',"), hit: /不许复用/ },
    {
      name: '挪到 Hero 之后',
      mutate: (s) => {
        const line = '    React.createElement(BackToCatalog, { onClick: backToCatalog, label: model.backAction }),\n'
        return s.replace(line, '').replace('    summaryCards(model),', `${line}    summaryCards(model),`)
      },
      hit: /Hero 之前/,
    },
  ]
  for (const { name, mutate, hit } of srcInjections) {
    const mutated = mutate(src)
    assert.notEqual(mutated, src, `注入「${name}」必须真的改到了源码`)
    const fail = backButtonWiringProblems(mutated)
    assert.ok(fail.length > 0, `注入「${name}」必须被接线检查抓到（一条都没报 ⇒ 断言恒真）`)
    assert.match(fail.join(' ／ '), hit, `注入「${name}」报的原因应是预期的：${JSON.stringify(fail)}`)
  }
})
