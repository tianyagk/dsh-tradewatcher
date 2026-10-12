/**
 * 工具箱**页面接线**的断言：门控（⑥倒 页签）、返回按钮（④）、目录页/详情页真的渲染模型。
 *
 * 为什么用"读源码 + 纯函数"两层：
 *   · 这个仓库没有 DOM 测试环境（devDependencies 里没有 jsdom / testing-library）⇒ 渲染层只能靠
 *     **源码接线断言**（与 `src/index.test.ts` 的 `checkManifest` / `boardOwnershipProblems` 同一手法）；
 *   · 行为规则（门控 / 返回目标）全部下沉到**纯函数**（`tabsGate.ts` / `toolsNav.ts`）⇒ 行为本身是可断言的。
 * 两层缺一不可：只有纯函数 ⇒ 页面可能根本没接线；只有源码字符串 ⇒ 规则错也照样绿。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gateTabs, type TabLike } from './tabsGate.ts'
import { backTarget, rememberPage } from './toolsNav.ts'

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
 * 页头块（`// 页头：` 到页面主体 `entry === null ?` 之间），已剥注释。
 *
 * 为什么按块而不是全文：详情页那个"回到工具目录"tooltip 是**合法**的（它是回目录入口，不是被删掉的页标题）；
 * 用户删掉的是**页头那一行**。按块断言才能既锁住"页头没有标题"，又不误伤别处的正当文案。
 */
function headerBlock(src: string): string {
  const start = src.indexOf('// 页头：')
  const end = src.indexOf('entry === null', start)
  return start >= 0 && end > start ? stripComments(src.slice(start, end)) : ''
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

test('⑥ 门控：`rows` 含 tools ⇒ 渲染该页签；不含 ⇒ 不渲染（沿用既有 gateTabs 逻辑）', () => {
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
 * 工具箱的**接线检查**：返回规则必须来自 `toolsNav.ts`，且四个接线点一个都不能少。
 * 返回**失败原因列表**（空 = 通过）⇒ 同一份检查既跑真实源码、也跑下面的注入（证明断言非恒真）。
 */
export function toolsWiringProblems(src: string): string[] {
  const bad: string[] = []
  const need = (cond: boolean, msg: string): void => {
    if (!cond) bad.push(msg)
  }
  need(/import \{ backTarget, rememberPage \} from '\.\/toolsNav\.ts'/.test(src), 'index.tsx 必须从 toolsNav.ts 引入 backTarget/rememberPage（规则只有一份实现）')
  need(/const TOOLS_PAGE: PageKey = 'tools'/.test(src), "缺少 TOOLS_PAGE 常量（'tools'）")
  need(/type PageKey = [^\n]*'tools'/.test(src), 'PageKey 必须含 tools')
  need(/lastNonTools\.current = rememberPage\(lastNonTools\.current, next, TOOLS_PAGE\)/.test(src), 'goPage 必须用 rememberPage 记录「上一个非 tools 页」')
  need(/onClick: \(\) => goPage\(t\.key\)/.test(src), 'tab 按钮必须走 goPage（直接 setPage 会漏记返回目标）')
  need(/backTarget\(lastNonTools\.current, visibleTabs\.map\(\(t\) => t\.key\), TOOLS_PAGE\)/.test(src), '返回目标必须由 backTarget + visibleTabs 算出（被停用的页签不能当返回目标）')
  need(/React\.createElement\(ToolsPage, \{ onBack: backPage === null \? null : \(\) => goPage\(backPage\) \}\)/.test(src), 'ToolsPage 的 onBack 必须来自 backPage（null ⇒ 不渲染按钮）')
  need(/if \(page === 'tools'\)/.test(src), '缺少 tools 页的渲染分支')
  return bad
}

test('④ 返回按钮：回到**上一个非 tools 页签**（纯函数语义）', () => {
  type K = 'watch' | 'portfolio' | 'market' | 'tools'
  const T: K = 'tools'
  const visible: readonly K[] = ['watch', 'portfolio', 'tools']
  // 从持仓进工具箱 ⇒ 返回目标是持仓（不是工具箱自己、也不是首个页签）
  const last = rememberPage<K>(rememberPage<K>(null, 'portfolio', T), 'tools', T)
  assert.equal(last, 'portfolio', '进入工具页不该改写返回目标')
  assert.equal(backTarget(last, visible, T), 'portfolio', '返回按钮必须切回上一个非 tools 页')
  // 在工具页里连着开两个工具（页面内切换，不改页签）⇒ 返回目标不变
  assert.equal(rememberPage(last, 'tools', T), 'portfolio', '页签不变时返回目标必须保持不变')
  // 换页会改写返回目标
  assert.equal(rememberPage<'watch' | 'market' | 'tools'>('watch', 'market', T), 'market', '换成大盘页 ⇒ 返回目标跟着换')
  // 上一页被停用（页签已不在条上）⇒ 回落到首个可见的非 tools 页
  assert.equal(backTarget(last, ['watch', 'tools'], T), 'watch', '返回目标必须仍可见，否则回落')
  // ⚠ 传入的"上一页"本身就是工具页（调用方误用 / 状态被写坏）⇒ **绝不能把 tools 当返回目标**
  // （那样按钮等于没效果：点一下还在工具箱）。这条专门锁 toolsNav 里那句 `last !== toolsKey` 守卫。
  assert.notEqual(backTarget<K>('tools', ['watch', 'portfolio', 'tools'], T), 'tools', '返回目标永远不许是 tools 页本身')
  assert.equal(backTarget<K>('tools', ['watch', 'portfolio', 'tools'], T), 'watch', '误用形态也走回落：首个可见的非 tools 页')
  // 没有任何非 tools 页可用 ⇒ null（调用方不渲染按钮，而不是返回一个不存在的页）
  assert.equal(backTarget<K>(null, ['tools'], T), null, '只有工具页可用 ⇒ 不渲染返回按钮')
  assert.equal(backTarget<K>('watch', ['tools'], T), null, '上一页已不可见且没有别的非 tools 页 ⇒ null')
})

test('④ 返回按钮：index.tsx 的**四个接线点**都在（读真实源码 + 四种注入各让检查非空）', () => {
  const bad = toolsWiringProblems(INDEX_SRC)
  assert.deepEqual(bad, [], `工具箱接线检查未通过：${bad.join(' ／ ')}`)
  const injections: Array<{ name: string; mutate: (s: string) => string; hit: RegExp }> = [
    // ① 页签点击不再记录返回目标（"返回"会回到一个陈旧的页）
    { name: 'tab 直接 setPage（漏记返回目标）', mutate: (s) => s.replace('onClick: () => goPage(t.key)', 'onClick: () => setPage(t.key)'), hit: /goPage/ },
    // ② 记录逻辑被就地重写（绕过 toolsNav 的规则）
    { name: '自己写记录逻辑（绕过 toolsNav）', mutate: (s) => s.replace('lastNonTools.current = rememberPage(lastNonTools.current, next, TOOLS_PAGE)', 'lastNonTools.current = next'), hit: /rememberPage/ },
    // ③ 返回目标不校验可见性（行被停用 ⇒ 返回一个不存在的页）
    { name: '返回目标不过 visibleTabs', mutate: (s) => s.replace('backTarget(lastNonTools.current, visibleTabs.map((t) => t.key), TOOLS_PAGE)', 'backTarget(lastNonTools.current, [], TOOLS_PAGE)'), hit: /visibleTabs/ },
    // ④ 返回按钮指向固定页（"回上一个页签"变成"回自选"）
    { name: '返回按钮指向固定页', mutate: (s) => s.replace('onBack: backPage === null ? null : () => goPage(backPage)', "onBack: () => goPage('watch')"), hit: /onBack/ },
  ]
  for (const { name, mutate, hit } of injections) {
    const mutated = mutate(INDEX_SRC)
    assert.notEqual(mutated, INDEX_SRC, `注入「${name}」必须真的改到了源码（否则这条证明无效）`)
    const fail = toolsWiringProblems(mutated)
    assert.ok(fail.length > 0, `注入「${name}」必须被接线检查抓到（实际一条都没报 ⇒ 断言恒真）`)
    assert.match(fail.join(' ／ '), hit, `注入「${name}」报的原因应是预期的：${JSON.stringify(fail)}`)
  }
})

/**
 * 目录页 / 详情页的**渲染接线**检查：模型里的字段必须真的被渲染（防"模型有了、页面没接线"）。
 * 返回失败原因列表（空 = 通过）。
 */
export function renderWiringProblems(src: string): string[] {
  const bad: string[] = []
  const need = (cond: boolean, msg: string): void => {
    if (!cond) bad.push(msg)
  }
  need(/catalogModel\(TOOL_ENTRIES, query, category, CATEGORY_TABS\)/.test(src), '目录页必须由 catalogModel 生成（页面不许自己拼卡片）')
  // v0.72.0 接数据后：详情页 = detailModel(entry, data)，数据由工具自己的 load() 取一次、本地回放
  need(/detailModel\(entry, data\)/.test(src), '详情页必须由 detailModel(entry, data) 生成（占位/原因只有一份来源）')
  need(/payload\.at\(step\)/.test(src), '回放必须走载荷句柄的 at(step)（本地换帧，不许每帧发请求）')
  need(/entry\?\.load/.test(src), '数据必须来自工具自己的 load()（页面不许另写一份取数）')
  // 目录页要素（v0.74.0 起：**没有**页标题/副标题，用户要求删掉那一行）
  need(/model\.categories\.map\(/.test(src), '分类标签行未渲染')
  need(/placeholder: model\.searchPlaceholder/.test(src), '搜索框占位必须来自 catalogModel（不许在页面里另写一份文案）')
  need(/repeat\(3, minmax\(0, 1fr\)\)/.test(src), '卡片网格必须是三列（repeat(3, minmax(0, 1fr))）')
  need(/model\.cards\.map\(/.test(src), '卡片网格未渲染目录页模型给出的卡片')
  // ⚠ 反向断言：被用户删掉的那三样**不许回来**（模型层的字段删了、页面也不许再渲染）
  for (const gone of ['model.title', 'model.subtitle', 'card.action']) need(src.includes(gone) === false, `页头标题/计数或卡片页脚入口文案被加回来了：${gone}`)
  const head = headerBlock(src)
  need(head !== '', '页头块锚点变了（`// 页头：` … `entry === null ?`），负向断言会失效 —— 请同步锚点')
  need(head.includes('工具目录') === false, '页头不许再出现页标题「工具目录」（用户要求删掉那一行）')
  need(head.includes('本插件自带') === false, '页头不许再出现「本插件自带 N 个工具」这句计数')
  need(head.includes('model.title') === false && head.includes('model.subtitle') === false, '页头不许再渲染目录页模型的标题/副标题')
  need(/BackIcon/.test(head) && /PAGE_BACK_ACTION/.test(head), '页头必须保留最小返回控件（图标 + 返回）')
  const visible = stripComments(src)
  need(visible.includes('打开工具') === false, '卡片页脚入口文案「打开工具」不许再出现在用户可见文案里')
  // 卡片三个字段（chip / 标题 / 一句话说明）——整卡可点，所以没有页脚入口文案
  for (const field of ['card.chip', 'card.title', 'card.blurb']) need(src.includes(field), `卡片字段未渲染：${field}`)
  need(/\.\.\.CARD_PROPS/.test(src) && /style: CARD_STYLE/.test(src) && /React\.createElement\(\s*CARD_TAG,/.test(src), '卡片必须用 toolCardView 的常量建（原生 button 语义 + 阴影圆角的唯一来源）')
  // 详情页五个区
  for (const field of ['model.kpi.cells.map(', 'model.curve.empty', 'model.pie.empty', 'model.market.columns.map(', 'model.boundary.lines.map(']) {
    need(src.includes(field), `详情页骨架未渲染：${field}`)
  }
  need(/model\.market\.columns\.length/.test(src), '市场表空态必须跨全部列（colSpan 来自列数）')
  // 接数据后的四个新接线点（缺一个都会造成"模型有数、页面不显示"）
  need(/cell\.delta === null \? null : React\.createElement/.test(src), 'KPI 的 delta（变化）必须渲染（用户口径要求 KPI 行含 delta）')
  need(/type: 'range'/.test(src) && /io\.onStep/.test(src), '回放滑块必须渲染（最近 30 个交易日手动回放）')
  need(/cell\.text/.test(src), 'KPI 的文本必须渲染')
  need(/model\.market\.rowNotes\[i\]/.test(src), '市场表的逐行原因必须渲染（缺数据行要显示「未取到 + 原因」）')
  need(/model\.extras\.map\(/.test(src), '附加块（A股净流入单列）必须渲染')
  need(/model\.status/.test(src), '状态行（数据时刻/来源/原因）必须渲染')
  // 返回控件：只有拿到 onBack 才渲染（null ⇒ 不渲染）；**图标 + `返回` 文案成对**（用户要"一个小倒退按钮"）
  need(/props\.onBack === null\s*\?\s*null/.test(src), '没有可返回的页时不许渲染返回按钮')
  need(/React\.createElement\(BackIcon, null\),\s*PAGE_BACK_ACTION/.test(src), '返回控件必须是「图标 + 返回文案」成对出现（缺一个都算把控件做丢）')
  // ④ 边界声明（含「不是真实跨境资金净流入」这条免责）与状态行**不许复用 tw-hint**：
  // 那个类在紧凑/隐身视图下 display:none（styles.ts:90-98）⇒ 复用等于把免责声明藏起来。
  need(/'data-role': 'tool-legal'/.test(src), '边界声明区块必须带 data-role="tool-legal"（可断言且可定位）')
  for (const [role, label] of [['tool-legal-line', '边界声明的每一条'], ['tool-status', '状态行'], ['tool-row-note', '逐行缺口原因']] as const) {
    const at = src.indexOf(`'data-role': '${role}'`)
    need(at >= 0, `${label}必须带 data-role="${role}"（可断言且可定位）`)
    if (at >= 0) {
      // 只扫这个元素紧挨着的 props（前面的注释会提到 tw-hint，别把注释当成复用了它；
      // 窗口也刻意开小，免得把后面 curveChart 里的 tw-hint 算进来）
      const block = src.slice(at, at + 160)
      need(/className: 'tw-hint'/.test(block) === false, `${label}不许复用 tw-hint（紧凑/隐身视图会把它整块隐藏）`)
    }
  }
  return bad
}

test('目录页/详情页渲染接线齐全；十四种"关掉渲染/藏起免责/删掉控件"的注入各让检查非空', () => {
  const src = readSrc('src/client/ToolsPage.tsx')
  const bad = renderWiringProblems(src)
  assert.deepEqual(bad, [], `渲染接线检查未通过：${bad.join(' ／ ')}`)
  const injections: Array<{ name: string; mutate: (s: string) => string; hit: RegExp }> = [
    { name: '卡片网格改成两列', mutate: (s) => s.replace('repeat(3, minmax(0, 1fr))', 'repeat(2, minmax(0, 1fr))'), hit: /三列/ },
    // v0.74.0（用户三项改动）：页头那一行 / 卡片入口文案 / 卡片视觉与语义
    { name: '页标题那一行加回来', mutate: (s) => s.replace('            PAGE_BACK_ACTION,\n          ),', "            PAGE_BACK_ACTION,\n          ), React.createElement('div', null, '工具目录'),"), hit: /页标题|页头/ },
    { name: '卡片页脚入口文案加回来', mutate: (s) => s.replace('}, card.blurb),', "}, card.blurb), React.createElement('div', null, '打开工具 →'),"), hit: /打开工具/ },
    { name: '卡片换成 div（丢按钮语义）', mutate: (s) => s.replace('React.createElement(\n              CARD_TAG,', "React.createElement(\n              'div',"), hit: /CARD_TAG|toolCardView/ },
    { name: '卡片不再用 CARD_PROPS（键盘可达与 type=button 没了）', mutate: (s) => s.replace('...CARD_PROPS,\n                key: card.id,', 'key: card.id,'), hit: /CARD_PROPS|toolCardView/ },
    { name: '卡片不再用 CARD_STYLE（阴影/圆角没了）', mutate: (s) => s.replace('style: CARD_STYLE,', "style: { cursor: 'pointer' },"), hit: /CARD_STYLE|toolCardView/ },
    { name: '返回控件只剩文字（图标丢了）', mutate: (s) => s.replace('React.createElement(BackIcon, null),\n            PAGE_BACK_ACTION,', 'PAGE_BACK_ACTION,'), hit: /图标/ },
    { name: '搜索框占位改写字面量（绕过唯一来源）', mutate: (s) => s.replace('placeholder: model.searchPlaceholder', "placeholder: '搜索'"), hit: /搜索框占位/ },
    { name: '空数据时不再渲染占位文案', mutate: (s) => s.replace('model.pie.empty', "''"), hit: /model\.pie\.empty/ },
    // v0.72.0：接数据后的四个接线点，各自配一条注入
    { name: 'KPI 的 delta 不渲染', mutate: (s) => s.replace('cell.delta === null ? null :', 'null ? null :'), hit: /delta/ },
    { name: '回放滑块改成固定文本', mutate: (s) => s.replace("type: 'range',", "type: 'hidden',"), hit: /回放滑块/ },
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
      mutate: (s) => s.replace("'data-role': 'tool-status', style: { margin: 0, fontSize: 11.5, lineHeight: 1.6, color: 'var(--tw-muted)' }", "'data-role': 'tool-status', className: 'tw-hint'"),
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
