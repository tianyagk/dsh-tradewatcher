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

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const readSrc = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8')

/**
 * 剥掉块注释与行注释（**只用于"用户可见文案"类断言**）。
 *
 * 为什么必须剥：源码注释里会写"页脚 `打开工具 →` 已按用户要求删除"这类**说明历史**的话；
 * 把注释算进去就等于禁止注释提到那个词 —— 那会逼着后续维护者把历史删掉（信息反而丢了）。
 * 规则与 `src/host/markdownScan.test.ts` 的 `stripComments` 同源（先块后行；`//` 前不能是 `:` 免得吃掉 URL）。
 */
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
  assert.equal(TABS.length, 6, `必须能抽出 6 个页签（锚点变了？实得 ${TABS.length}）`)
  const keys = TABS.map((t) => t.key)
  assert.deepEqual(keys, ['watch', 'portfolio', 'market', 'cloud', 'calendar', 'tools'], `页签集合/顺序不对：${JSON.stringify(keys)}`)
  const tools = TABS.find((t) => t.key === 'tools')
  assert.equal(tools?.label, '工具', '工具箱页签的标签必须是「工具」')
  assert.equal(tools?.row, 'tools', '工具箱页签归属 tools 行（门控靠它）')
  assert.equal(keys.indexOf('tools'), keys.indexOf('calendar') + 1, '工具箱必须紧跟在「日历」之后')
})

test('门控：`rows` 含 tools ⇒ 渲染该页签；不含 ⇒ 不渲染（沿用既有 gateTabs 逻辑）', () => {
  // 七行全开（manifest 的默认形态）
  const on = gateTabs(TABS, new Set(['core', 'calendar', 'watchlist', 'portfolio', 'market', 'cloudmap', 'tools']), 'watch')
  assert.equal(on.visible.some((t) => t.key === 'tools'), true, 'rows 含 tools ⇒ 工具页签必须出现')
  assert.equal(on.visible.length, 6, '七行全开时六个页签都在')
  // profile 层 `- id: tradewatcher-tools` + `disabled: true` ⇒ /rows 不含 tools
  const off = gateTabs(TABS, new Set(['core', 'calendar', 'watchlist', 'portfolio', 'market', 'cloudmap']), 'watch')
  assert.equal(off.visible.some((t) => t.key === 'tools'), false, '⚠ 门控：rows 不含 tools ⇒ **不渲染**工具页签')
  assert.equal(off.visible.length, 5, '关掉工具箱不影响其余五个页签')
  assert.equal(off.fallback, null, '当前页仍可用 ⇒ 不回退')
  // 当前页就是工具箱、而该行被关掉 ⇒ 回退到首个可见页（不许白屏）
  const gone = gateTabs(TABS, new Set(['core', 'calendar']), 'tools')
  assert.deepEqual(gone.visible.map((t) => t.key), ['calendar'], '只开日历 ⇒ 只剩日历页签')
  assert.equal(gone.fallback, 'calendar', '当前页（工具）被停用 ⇒ 必须回退')
  // 端点不可达（rows = null）⇒ 失败放行：与其余页签同款（抖动不该让界面整块消失）
  assert.equal(gateTabs(TABS, null, 'watch').visible.length, 6, '失败放行：六个页签都在')
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
  for (const field of ['model.curve.empty', 'model.pie.empty', 'model.market.columns.map(', 'model.boundary.lines.map(']) {
    need(src.includes(field), `详情页功能区未渲染：${field}`)
  }
  need(/model\.market\.columns\.length/.test(src), '市场表空态必须跨全部列（colSpan 来自列数）')
  // 接数据后的接线点
  need(/cell\.delta === null \? null : React\.createElement/.test(src), 'KPI 的 delta（变化）必须渲染（用户口径要求磁贴含 delta）')
  need(/type: 'range'/.test(src) && /io\.onStep/.test(src), '回放滑块必须渲染（最近 30 个交易日手动回放）')
  need(/cell\.text/.test(src), 'KPI 的文本必须渲染')
  need(/model\.market\.rowNotes\[i\]/.test(src), '市场表的逐行原因必须渲染（缺数据行要显示「未取到 + 原因」）')
  need(/model\.extras\.map\(/.test(src), '附加块（A股净流入单列）必须渲染')
  // 常驻状态行只留必要事实：文本来自 model.status，完整口径进 title/aria-label
  need(/'data-role': 'tool-status'/.test(src), '状态行必须带 data-role（可断言且可定位）')
  need(/model\.status\b/.test(src), '状态行文本必须来自 model.status')
  need(/title: model\.statusTitle/.test(src) && /'aria-label': model\.statusTitle/.test(src), '状态行的完整版必须进 title 与 aria-label（长文案不占版面但仍可读）')
  // ④ 边界声明（含「不是真实跨境资金净流入」这条免责）与状态行**不许复用 tw-hint**：
  // 那个类在紧凑/隐身视图下 display:none（styles.ts:90-98）⇒ 复用等于把免责声明藏起来。
  need(/'data-role': 'tool-legal'/.test(src), '边界声明区块必须带 data-role="tool-legal"（可断言且可定位）')
  for (const [role, label] of [['tool-legal-line', '边界声明的每一条'], ['tool-status', '状态行'], ['tool-row-note', '逐行缺口原因']] as const) {
    const at = src.indexOf(`'data-role': '${role}'`)
    need(at >= 0, `${label}必须带 data-role="${role}"（可断言且可定位）`)
    if (at >= 0) {
      // 只扫这个元素紧挨着的 props（前面的注释会提到 tw-hint，别把注释当成复用了它；
      // 窗口也刻意开小，免得把后面 curveChart 里的 tw-hint 算进来）
      const block = src.slice(at, at + 240)
      need(/className: 'tw-hint'/.test(block) === false, `${label}不许复用 tw-hint（紧凑/隐身视图会把它整块隐藏）`)
    }
  }
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
    { name: 'KPI 的 delta 不渲染', mutate: (s) => s.replace('cell.delta === null ? null :', 'null ? null :'), hit: /delta/ },
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
          "{ className: 't', 'data-role': 'tool-chart-title', title: `${model.kpi.title}｜${model.kpi.note}`, 'aria-label': `${model.kpi.title}：${model.kpi.note}` },",
          "{ className: 't', 'data-role': 'tool-chart-title' },",
        ),
      hit: /KPI 口径行/,
    },
    { name: '状态行不再把完整口径放进 title/aria-label', mutate: (s) => s.replace('title: model.statusTitle,', 'title: undefined,'), hit: /statusTitle|title/ },
    {
      name: '边界声明复用 tw-hint（紧凑/隐身视图会把免责藏掉）',
      mutate: (s) => s.replace("'data-role': 'tool-legal-line', style: { margin: 0, fontSize: 11, lineHeight: 1.65, color: 'var(--tw-muted)' }", "'data-role': 'tool-legal-line', className: 'tw-hint'"),
      hit: /边界声明.*不许复用 tw-hint/,
    },
    {
      name: '逐行缺口原因复用 tw-hint（紧凑档只剩「未取到」没有原因）',
      mutate: (s) => s.replace("'data-role': 'tool-row-note', colSpan", "'data-role': 'tool-row-note', className: 'tw-hint', colSpan"),
      hit: /逐行缺口原因.*不许复用 tw-hint/,
    },
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

test('③ KPI 磁贴四块的值都来自模型（不是常量）：无数据 ⇒ 全是「未取到」+ null', () => {
  const d = detailModel(cakeTool)
  assert.equal(d.kpi.cells.length, 4, `图表卡必须正好四块磁贴（实得 ${d.kpi.cells.length}）`)
  for (const cell of d.kpi.cells) {
    assert.equal(cell.text, NOT_FETCHED, `无数据时磁贴「${cell.label}」必须是「${NOT_FETCHED}」`)
    assert.equal(cell.value, null, `无数据时磁贴「${cell.label}」的值必须是 null（不许 0 顶替）`)
  }
  // 磁贴的文案里**不许出现"蛋糕温度/流动性支持度"这类我们根本没有的口径**（严禁凑数编造）
  const labels = d.kpi.cells.map((c) => c.label)
  for (const invented of ['温度', '流动性支持', '美元指数', '10Y']) {
    assert.equal(labels.some((l) => l.includes(invented)), false, `KPI 磁贴不许出现没有数据来源的口径「${invented}」：${labels.join(' / ')}`)
  }
  assert.deepEqual(labels, ['规模榜首', '五市场合计规模', '近五日轮动', '数据时刻'], '四块磁贴 = 我们真有的四个指标')
  // 反例注入：把某块磁贴改成常量（页面/模型里都不许出现"常量磁贴"）
  const fake = { ...d, kpi: { ...d.kpi, cells: d.kpi.cells.map((c, i) => (i === 0 ? { ...c, text: '蛋糕温度 42', value: 42 } : c)) } }
  assert.throws(() => assert.deepEqual(fake.kpi.cells.map((c) => c.text), [NOT_FETCHED, NOT_FETCHED, NOT_FETCHED, NOT_FETCHED], '反例上必须失败'), /反例上/, '⚠ 反例（塞一个常量磁贴）必须让断言失败')
})
