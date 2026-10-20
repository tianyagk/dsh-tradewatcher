/**
 * 工具箱注册表 + 目录页/详情页模型的断言（纯函数层）。
 *
 * 覆盖（每条都配反例注入，证据见 `docs/AUDIT-IMPL43.md` §3、§7）：
 *   ① 目录页模型渲染出 **1 张卡片**且字段齐全（chip / 标题 / 一句话说明）；
 *   ①′ 卡片的**标题与 chip 逐字**等于用户口径（不许自行改名/改 chip）—— v0.74.0；
 *   ①″ 页标题 / 计数 / 卡片页脚入口文案**已从模型里删除**（用户要求删掉页头那一行）—— v0.74.0；
 *   ② **搜索框已删**（v0.81.0：用户判冗余）⇒ 模型里不许再有搜索字段，页面里不许再有输入框；
 *   ③ 分类标签行**只有「全部」**一个；
 *   ⑤ 注册表新增条目**不改变既有卡片排序规则**（顺序 = 注册顺序，新条目只追加）；
 *   ⑥ 详情页三段式所需的新字段：Hero（kicker/标题/说明）、摘要卡、`AS OF`、时间范围三档（v0.81.0）。
 * 另有三条红线断言（v0.72.0 接数据后扩写）：
 *   · 无数据时每个数据格都是 `未取到` + 原因，且**整份模型零阿拉伯数字**（不得写假数字）；
 *   · 没有 loader 的"结构先行"工具仍走 `PENDING_WHY`（原因分档，不许含糊）；
 *   · 有数据时数值**只来自 ToolData**，数据里没有的格子仍是 `未取到` + null（不许补 0）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  CATEGORY_TABS,
  NO_DATA_WHY,
  NO_MATCH,
  NOT_FETCHED,
  PENDING_WHY,
  TOOL_ENTRIES,
  catalogModel,
  detailModel,
  orderEntries,
  toolById,
  type ToolEntry,
} from './toolRegistry.ts'
import * as ToolReg from './toolRegistry.ts'
import * as ToolText from './toolText.ts'
import { cakeTool } from './tools/cake.ts'
import { leverageTool } from './tools/leverage.ts'
import { FACT_TOPICS, factCoverageProblems, missingFactTopics, topicInLine } from './toolFacts.ts'
// ⚠ 从宿主读窗口集合：工具档位必须与宿主允许的窗口一致（两处漂移是"切档拿到不存在的窗口"的根因）
import { FLOW_BOUNDARY, FLOW_CURVE_WINDOWS } from '../host/globalFlow.ts'

/** 断言用的固定条目（不碰真实注册表；`sections: []` 时 detailModel 走"缺区"回退） */
function fixture(id: string, name: string, blurb: string, chip: string, category: string): ToolEntry {
  return { id, name, blurb, chip, category, sections: [], boundary: [] }
}

const CAKE_LIKE = fixture('cake', '蛋糕示例', '把五个市场的宽基 ETF 规模切成一块蛋糕', '蛋糕', 'flow')
const OTHER = fixture('zeta', '估值快照', '看一眼估值与位置', '估值', 'valuation')

test('① 目录页模型：卡片齐全（chip / 标题 / 一句话说明）—— v0.116.0 起两个工具', () => {
  const model = catalogModel()
  // ② 搜索框已删（v0.81.0）：模型里不许再留搜索字段（留字段 = 下一个人一定会把它渲染回来）
  assert.equal('searchPlaceholder' in model, false, '目录页模型不许再有 searchPlaceholder（搜索框已按用户要求删除）')
  assert.equal('query' in model, false, '目录页模型不许再有 query 字段')
  // v0.116.0（杠杆温度计）：目录从 1 张卡变成 2 张 —— 新增工具只**追加**（顺序见 ⑤ 号用例）
  assert.equal(model.cards.length, 2, `目录页必须恰好 2 张卡片（蛋糕 + 杠杆温度计；实得 ${model.cards.length}）`)
  assert.deepEqual(model.cards.map((c) => c.id), ['cake', 'leverage'], '卡片顺序 = 注册顺序（新工具追加在末尾）')
  // v0.119.0（R5）：目录名带口径括号 —— 与工具条目**同源**（逐字断言在 leverageHeader.test.ts，这里只核一致性）
  assert.equal(model.cards[1]?.title, leverageTool.name, '第二张卡的标题必须等于工具条目的 name（单一来源）')
  const card = model.cards[0]
  assert.equal(card.id, cakeTool.id, '卡片 id 必须指向注册里的那个工具')
  assert.equal(card.chip, cakeTool.chip)
  assert.equal(card.title, cakeTool.name)
  assert.equal(card.blurb, cakeTool.blurb)
  // 字段齐全：一个都不许是空串（空串在页面上就是"没有内容"，等于卡片缺胳膊）
  for (const [k, v] of Object.entries(card)) assert.equal(String(v).trim() === '', false, `卡片字段 ${k} 不许为空`)
  assert.deepEqual(Object.keys(card).sort(), ['blurb', 'category', 'chip', 'id', 'title'], '卡片的字段集合是契约（多一个字段就意味着页面要渲染一处新文案）')
  assert.equal(model.empty, null, '有卡片 ⇒ 不该有"没有匹配"的空态')
})

test('①′ 工具名与 chip 逐字锁定用户口径（不许自行改名/改 chip）—— 反例注入必败', () => {
  const card = catalogModel().cards[0]
  // 逐字断言（这是用户明确给的名字，不是"从实现里读出来的期望值"）
  assert.equal(card.title, '全球资金流蛋糕模型', `卡片标题必须逐字等于「全球资金流蛋糕模型」（实得 ${JSON.stringify(card.title)}）`)
  assert.equal(card.chip, '宏观 | 全球轮动', `chip 必须逐字等于「宏观 | 全球轮动」（实得 ${JSON.stringify(card.chip)}）`)
  // 工具文件里也必须是同一个字面量（防止有人只改卡片模型、不改条目）
  assert.equal(cakeTool.name, '全球资金流蛋糕模型')
  assert.equal(cakeTool.chip, '宏观 | 全球轮动')
  // 反例注入：把名字改回旧名 ⇒ 上面第一条必须失败（证明断言不是恒真）
  const renamed = { ...card, title: '五市场蛋糕' }
  assert.throws(() => assert.equal(renamed.title, '全球资金流蛋糕模型', '反例上必须失败'), /反例上/, '⚠ 反例注入（改名）必须让逐字断言失败')
  const rechip = { ...card, chip: '蛋糕' }
  assert.notEqual(rechip.chip, '宏观 | 全球轮动', '⚠ 反例注入（改 chip）必须让逐字断言失败')
})

test('①″ 页标题 / 计数 / 卡片页脚入口文案已删除（用户 v0.74.0 要求）', () => {
  const model = catalogModel()
  // 模型层：那三个字段不该存在（留着就是"没人渲染的死字段"）
  assert.equal('title' in model, false, '目录页模型不许再有 title（页标题已删）')
  assert.equal('subtitle' in model, false, '目录页模型不许再有 subtitle（计数那一行已删）')
  assert.equal('action' in model.cards[0], false, '卡片不许再有 action（页脚「打开工具 →」已删）')
  // 文案层：常量也不许再导出（否则下一个人一定会把它加回来）
  assert.equal('CATALOG_TITLE' in ToolText, false, 'toolText 不许再导出 CATALOG_TITLE')
  assert.equal('CARD_ACTION' in ToolText, false, 'toolText 不许再导出 CARD_ACTION')
  // 注意：`工具目录` 这四个字**仍然合法**（详情页的"← 工具目录"是回目录入口，不在被删的那一行里）；
  // 被删的是"页头那一个页标题"，模型层已按字段锁住（上面两条 + toolsPage.test.ts 的渲染检查）。
  const text = JSON.stringify(ToolText)
  for (const gone of ['打开工具', '本插件自带']) {
    assert.equal(text.includes(gone), false, `文案模块里不许再出现「${gone}」：${text.slice(0, 200)}`)
  }
})

test('② 搜索链路已删除（v0.81.0）：模型无搜索字段、注册表不再导出搜索函数与文案', () => {
  // 模型层：字段不存在（上面 ① 已锁 searchPlaceholder/query）
  const model = catalogModel([CAKE_LIKE, OTHER], 'all')
  assert.deepEqual(model.cards.map((c) => c.id), ['cake', 'zeta'], '目录页只剩分类过滤：两工具都该在')
  // 函数层：`matchesQuery` / `searchTextOf` 必须从注册表导出面消失
  assert.equal('matchesQuery' in ToolReg, false, '注册表不许再导出 matchesQuery（搜索已删，留着就是死代码）')
  assert.equal('searchTextOf' in ToolReg, false, '注册表不许再导出 searchTextOf')
  // 文案层：搜索占位与页级返回文案都不许再导出
  assert.equal('SEARCH_PLACEHOLDER' in ToolText, false, 'toolText 不许再导出 SEARCH_PLACEHOLDER')
  assert.equal('PAGE_BACK_ACTION' in ToolText, false, 'toolText 不许再导出 PAGE_BACK_ACTION（页级返回控件已删）')
  // 空态仍保留（分类过滤可能过滤空）——但它与搜索无关
  assert.equal(catalogModel([CAKE_LIKE, OTHER], 'nope').empty, NO_MATCH, '分类过滤到零结果 ⇒ 仍给一句空态说明')
})

test('③ 分类标签行只有「全部」一个（且它就是页面渲染的那一份）', () => {
  assert.deepEqual(CATEGORY_TABS, [{ key: 'all', label: '全部' }], '本批分类标签行只允许「全部」')
  const model = catalogModel()
  assert.deepEqual(model.categories, CATEGORY_TABS, '模型里的标签行必须与 CATEGORY_TABS 同源')
  // 反向确认：条目自己的分类字段**没有**被渲染成标签（下一批才加标签行）
  const labels = model.categories.map((c) => c.label)
  assert.equal(labels.includes(cakeTool.category), false, '条目分类不是标签（本轮标签行只有「全部」）')
  // 分类过滤仍按条目字段生效（`all` = 不筛）
  assert.deepEqual(catalogModel([CAKE_LIKE, OTHER], 'flow').cards.map((c) => c.id), ['cake'])
  assert.deepEqual(catalogModel([CAKE_LIKE, OTHER], 'all').cards.map((c) => c.id), ['cake', 'zeta'])
})

test('⑤ 注册表新增条目不改变既有卡片排序规则（顺序 = 注册顺序，新条目只追加）', () => {
  const before = catalogModel([CAKE_LIKE, OTHER], 'all')
  // 新增一个**名字排在字母表最前**的工具：按名字/分类重排的实现会把它插到最前面 ⇒ 这条会红
  const appended = fixture('aaa', 'AAA 工具', '名字最靠前的工具', 'AAA', 'aaa')
  const after = catalogModel([CAKE_LIKE, OTHER, appended], 'all')
  assert.deepEqual(
    after.cards.slice(0, 2),
    before.cards,
    '新增条目不许改动既有卡片的顺序与内容（排序规则只有"注册顺序"这一条）',
  )
  assert.deepEqual(after.cards.map((c) => c.id), ['cake', 'zeta', 'aaa'], '新条目只能追加在末尾')
  // 排序规则的唯一实现：orderEntries 是"保持输入顺序"（identity）——
  // 一旦有人在这里改成按名称/分类排序，上面两条断言必红
  const shuffled = [OTHER, CAKE_LIKE]
  assert.deepEqual(orderEntries(shuffled).map((e) => e.id), ['zeta', 'cake'], 'orderEntries 不许重排')
  assert.deepEqual(orderEntries(TOOL_ENTRIES).map((e) => e.id), TOOL_ENTRIES.map((e) => e.id), '真实注册表按注册顺序展示')
})

test('注册表第一个条目 = 蛋糕工具；toolById 认它、认不出给 null', () => {
  assert.equal(TOOL_ENTRIES[0].id, 'cake', '第一个条目必须是蛋糕工具（本批只交付它）')
  assert.equal(toolById('cake')?.name, cakeTool.name)
  assert.equal(toolById('nope'), null, '认不出的 id 必须给 null（调用方回目录页，而不是渲染半个空页）')
})

test('① 详情页骨架：五个区齐全、顺序固定，且标题是**用户语**（不许内部区名）', () => {
  const d = detailModel(cakeTool)
  const titles = [d.kpi.title, d.curve.title, d.pie.title, d.market.title, d.boundary.title]
  assert.deepEqual(
    titles,
    ['四个读数', '蛋糕构成与份额曲线', '最近三十个交易日', '钱现在更偏向哪里', '这份数据的边界'],
    '骨架区的顺序与标题就是详情页的渲染顺序（测试锁用户语标题）',
  )
  // 兜底标题（工具文件漏写 `title` 时用）也必须是用户可读文案：绝不出现内部区名
  const bare = detailModel({ ...cakeTool, sections: [] })
  const fallbacks = [bare.kpi.title, bare.curve.title, bare.pie.title, bare.market.title, bare.boundary.title]
  for (const internal of ['KPI 行', '曲线区', '饼图区', '市场表', '边界声明']) {
    assert.equal(fallbacks.includes(internal), false, `兜底标题不许是内部名「${internal}」（实得 ${JSON.stringify(fallbacks)}）`)
  }
  assert.deepEqual(fallbacks, ['关键指标', '份额曲线', '最近三十个交易日', '市场构成', '数据边界'], '兜底标题必须是用户可读文案')
  // 反例注入（用户点名的回归形态）：内部区名回填 ⇒ 必败
  for (const internal of ['曲线区', '饼图区', '市场表', 'KPI 行']) {
    assert.equal(titles.includes(internal), false, `区标题不许是内部名「${internal}」`)
    assert.throws(() => assert.deepEqual([...titles], [...titles.slice().fill(internal)], '反例上必须失败'), /反例上/, `⚠ 回填「${internal}」必须让上面的断言失败`)
  }
  // 市场段的**可见副标题**（用户给的原文）
  assert.equal(d.market.subtitle, '曲线展示五个市场的相对份额变化；横条越长，当前资金偏好越强', '市场段必须有用户给的副标题')
  assert.deepEqual(
    d.kpi.cells.map((c) => c.label),
    ['蛋糕温度', '流动性支持度', '美国十年期国债收益率', '广义美元指数'],
    'KPI 磁贴标签是真的（口径 v0.82.0：份额是偏好分归一化 ⇒ 榜首叫「偏好榜首」而不是「规模榜首」）',
  )
  assert.deepEqual(
    d.market.columns,
    ['市场', '宽基标的', '规模', '偏好份额', '偏好分', '份额变化', '动量（多周期）', '横截面排名'],
    '市场表列头是真的（规模仍是事实展示；份额改成「偏好份额」并加了「偏好分」列）',
  )
  assert.equal(d.backAction.trim() === '', false, '详情页必须有回目录的入口文案')
  assert.deepEqual(d.boundary.lines, [...cakeTool.boundary], '边界声明逐条来自工具文件（不许在页面里另写一份）')
  assert.ok(d.boundary.lines.length >= 3, '边界声明至少要有几条实质内容')
})

test('⑥ 三段式骨架（v0.81.0）：Hero / 摘要卡 / AS OF / 时间范围三档 —— 反例注入必败', () => {
  const d = detailModel(cakeTool)
  // ① Hero：kicker + 大标题（= 工具名，逐字）+ 说明；三段结构的第一段
  assert.equal(d.hero.title, cakeTool.name, 'Hero 大标题必须就是工具名（不许在 Hero 里另写一个标题）')
  assert.equal(d.hero.kicker.trim() === '', false, 'Hero 必须有 kicker 小标签')
  assert.equal(d.hero.note.trim() === '', false, 'Hero 必须有一段说明')
  assert.equal(d.hero.note, cakeTool.hero?.note, 'Hero 说明来自工具文件（页面不许另写一份文案）')
  // ② 摘要卡：无数据 ⇒ 空数组（页面不渲染空卡；值都必须来自数据，见下面的数据路径用例）
  assert.deepEqual(d.summary, [], '无数据时不许有摘要卡（编不出值就别摆一张空卡）')
  // ③ 图表卡右上角 AS OF：无数据 ⇒ null
  assert.equal(d.chartAsOf, null, '无数据时 AS OF 必须是 null（不许拿"今天"顶上）')
  // ④ 时间范围三档：档位来自工具文件，且与宿主允许的窗口集合一致（唯一来源）
  assert.deepEqual(d.ranges.options, [90, 180, 365], '时间范围必须是 90 / 180 / 365 三档')
  assert.deepEqual([...FLOW_CURVE_WINDOWS], [90, 180, 365], '工具声明的三档必须与宿主 FLOW_CURVE_WINDOWS 一致（否则切档会拿到不存在的窗口）')
  assert.deepEqual(cakeTool.ranges?.options, [...FLOW_CURVE_WINDOWS], '工具档位 = 宿主窗口集合（同一份口径）')
  // 用户口径（v0.85.0 收口）：默认档改成 365（目标布局"默认 365 日"）；曲线本就是 365 点本地切片 ⇒ 不新增请求
  assert.equal(d.ranges.selected, 365, '默认档必须是 365')
  assert.equal(cakeTool.ranges?.initial, 365, '工具文件里的默认档也必须是 365')
  // 页面不许写死默认档：模型里的 selected 必须来自工具声明（把声明改掉 ⇒ selected 跟着变）
  assert.equal(detailModel({ ...cakeTool, ranges: { options: cakeTool.ranges?.options ?? [], initial: 90 } }).ranges.selected, 90, '默认档必须来自工具声明（页面不许写死）')
  assert.throws(
    () => assert.equal(detailModel({ ...cakeTool, ranges: { options: cakeTool.ranges?.options ?? [], initial: 90 } }).ranges.selected, 180),
    /Expected values to be strictly equal/,
    '⚠ 反例（页面写死 180）必须让断言失败',
  )
  // 反例注入：把档位写死成一档 ⇒ 上面两条必败（证明断言不是从实现里读出来的）
  const fixed = { ...d, ranges: { options: [180], selected: 180 } }
  assert.throws(() => assert.deepEqual(fixed.ranges.options, [90, 180, 365], '反例上必须失败'), /反例上/, '⚠ 反例（把范围写死一档）必须让断言失败')
})

test('⑥ 摘要卡/AS OF/范围选中值都来自 ToolData（页面不造数）', () => {
  const d = detailModel(cakeTool, {
    status: '数据时刻 X',
    chartAsOf: '2026-10-12',
    rangeDays: 90,
    summary: [
      { key: 'cake', label: '资金蛋糕', value: '9015.54 亿美元', note: '美国 占 91.14%' },
      { key: 'prefer', label: '当前偏好', value: '美国', note: '从 韩国 转向 美国' },
    ],
    kpi: { 蛋糕温度: { text: '62（平衡）', value: 62, delta: '较上日 +1.0' } },
  })
  assert.equal(d.summary.length, 2, '摘要卡来自数据')
  assert.equal(d.summary[0].value, '9015.54 亿美元', '摘要卡的值必须原样来自数据')
  assert.equal(d.chartAsOf, '2026-10-12', 'AS OF 来自数据（当前显示那一天）')
  assert.equal(d.ranges.selected, 90, '选中档来自数据（工具回报的 rangeDays）')
  // 数据里没有的格子仍是「未取到」+ null（不许因为别的字段有数就补 0）
  assert.equal(d.kpi.cells[1].text, NOT_FETCHED)
  assert.equal(d.kpi.cells[1].value, null)
})

/**
 * 「方法 / 边界」两段的**事实清单**（v0.85.0）。
 *
 * 用户口径：底部改成两段散文（`当前偏好怎么判断` / `这份数据的边界`），但**事实一条不得删**。
 * 这里用"关键事实标记 + 条数"把它钉住：谁把某条删掉/合并掉，标记就找不到了（反例注入已验证）。
 */
test('④ 两段散文（方法 + 边界）：标题、以及**15 条事实主题一条不少**（少一条 ⇒ 红）', () => {
  const d = detailModel(cakeTool)
  assert.equal(d.method.title, '当前偏好怎么判断')
  assert.equal(d.boundary.title, '这份数据的边界')
  assert.equal(d.method.lines.length > 0 && d.boundary.lines.length > 0, true, '两段都不许为空')
  // 并集 = 工具方法段 + 工具边界段 + 宿主 FLOW_BOUNDARY（口径数字在宿主那边，有数据时才出现）
  // 并集里必须有**宿主的数字口径**（FLOW_BOUNDARY）：它是"有数据才出现"的那一段，
  // 因此这里用最小数据面（只给 boundary）而不是造一整个载荷 —— 断言只关心"事实在不在"。
  const model = detailModel(cakeTool, { status: '（只读事实用）', boundary: [...FLOW_BOUNDARY] })
  const union = [...model.method.lines, ...model.boundary.lines].join('\n')
  assert.equal(FACT_TOPICS.length, 15, '事实主题清单必须锁在 15 条')
  assert.deepEqual(missingFactTopics(union), [], `事实主题缺了：${missingFactTopics(union).join('、')} —— 散文可以改句式，但不许删事实`)
  assert.deepEqual(factCoverageProblems(union), [], '事实覆盖判据必须为空')
  // 逐主题**删除式注入**：把承载该主题的句子删掉 ⇒ 必须报出这一条（15/15）
  for (const topic of FACT_TOPICS) {
    const kept = [...model.method.lines, ...model.boundary.lines].filter((l) => !topicInLine(topic, l))
    const dropped = missingFactTopics(kept.join('\n'))
    assert.equal(dropped.includes(topic.id), true, `⚠ 删掉「${topic.label}」后必须报出主题 #${topic.id}（实得 ${JSON.stringify(dropped)}）`)
  }
})

test('红线：无数据时必须「未取到」占位 + 给原因，且骨架里不许出现任何数字', () => {
  const d = detailModel(cakeTool)
  // ① 每个 KPI 格子都是占位文案 + value null（不许用 0 顶替）
  for (const cell of d.kpi.cells) {
    assert.equal(cell.text, NOT_FETCHED, `KPI「${cell.label}」在无数据时必须显示「${NOT_FETCHED}」`)
    assert.equal(cell.value, null, `KPI「${cell.label}」的值必须是 null（不是 0、不是编造的数）`)
    assert.equal(cell.delta, null, `KPI「${cell.label}」在无数据时不许有 delta（编出来的对比值同样是假数）`)
  }
  // ② 曲线/饼图/市场表三区都是空数据 + 空态说明（说明里含原因）
  assert.deepEqual(d.curve.series, [], '曲线区没有数据 ⇒ 不许画线')
  assert.deepEqual(d.pie.slices, [], '饼图的分块由数据源决定 ⇒ 无数据时连块名都不编')
  assert.deepEqual(d.market.rows, [], '市场表没有数据 ⇒ 不许编行')
  for (const empty of [d.curve.empty, d.pie.empty, d.market.empty]) {
    assert.equal(empty.startsWith(NOT_FETCHED), true, `空态必须以「${NOT_FETCHED}」开头：${empty}`)
    assert.equal(empty.includes(NO_DATA_WHY), true, `空态必须给原因（本工具已有数据源 ⇒ 原因是「${NO_DATA_WHY}」）：${empty}`)
  }
  // ③ 区的口径行也给原因（缺数据必须写原因，不能只留一个"未取到"）；状态行同款
  for (const note of [d.kpi.note, d.curve.note, d.pie.note, d.market.note, d.boundary.note]) {
    assert.equal(note.includes(NO_DATA_WHY), true, `区的口径行必须写明原因：${note}`)
  }
  assert.equal(d.status.startsWith(NOT_FETCHED), true, `状态行也必须以「${NOT_FETCHED}」开头：${d.status}`)
  // ④ **整份模型里一个阿拉伯数字都不许有**（`未取到` 之外的任何数都等于编数据）。
  //    唯一例外：`ranges`（时间范围分段控件的档位 90/180/365）是**声明在工具文件里的 UI 契约常量**，
  //    不是"看起来像数"的编造值 —— 它被单独钉死（见 ⑥：必须等于 [90,180,365] 且与宿主窗口集合一致）。
  //    因此这里把 ranges 归一化后再扫全文，例外面被上面那条断言收紧了。
  assert.deepEqual(d.ranges.options, [90, 180, 365], '范围档位只有这三档（例外面必须被钉死，否则例外会变成洞）')
  //    口径散文（`method` / `boundary`）**不在这条红线的扫描范围内**：那些句子本来就该写出
  //    权重与窗口（「55% × 贪婪值 + 30% × …」「60 日区间分位」是口径文句，不是数据格）。
  //    把它们算进来的话，这条红线会变成"不许解释口径"——那不是它的本意（本意是"不许编数据"）。
  //    口径数字（55%/30%/15%/60 日）**留在宿主 `FLOW_BOUNDARY`**：有数据时才随口径行出现；
  //    工具文件的方法段与区标题改成不含阿拉伯数字（「按固定比例加权」「最近三十个交易日」）
  //    ⇒ 白名单不需要扩大（仍只有 ranges 的 90/180/365）。
  const text = JSON.stringify({ ...d, ranges: { options: [], selected: null } })
  assert.equal(/\d/.test(text), false, `详情页骨架里出现了数字（可能是编造的默认值）：${text.slice(0, 240)}`)
})

test('红线（结构先行工具，没有 loader）：占位原因用 PENDING_WHY，且同样零数字', () => {
  const skeleton: ToolEntry = {
    ...fixture('skeleton', '骨架工具', '还没有数据源的工具', '骨架', 'demo'),
    sections: [
      { key: 'kpi', title: 'KPI 行', cells: ['格子甲'] },
      { key: 'curve', title: '曲线区' },
      { key: 'pie', title: '饼图区' },
      { key: 'market', title: '市场表', columns: ['列甲'] },
      { key: 'boundary', title: '边界声明' },
    ],
    boundary: ['结构先行'],
  }
  const d = detailModel(skeleton)
  for (const note of [d.kpi.note, d.curve.note, d.pie.note, d.market.note, d.boundary.note]) {
    assert.equal(note.includes(PENDING_WHY), true, `无 loader 的工具：口径行必须是「${PENDING_WHY}」：${note}`)
  }
  assert.equal(/\d/.test(JSON.stringify(d)), false, '骨架工具同样不许出现数字')
})

test('④ 边界声明（无数据时也在）：含「风险偏好代理 ≠ 真实跨境资金净流入」且条目不重复', () => {
  const d = detailModel(cakeTool)
  const lines = d.boundary.lines
  assert.deepEqual(lines, [...cakeTool.boundary], '无数据时边界声明逐条来自工具文件')
  assert.equal(new Set(lines).size, lines.length, '边界声明不许有重复条目')
  const hit = lines.filter((l) => l.includes('跨境资金净流入'))
  assert.equal(hit.length, 1, `必须恰好一条免责（风险偏好代理 ≠ 真实跨境资金净流入），实际 ${hit.length} 条`)
  // 需求原文（REQ-tools-component.md T-5）要求的那句话要**逐字**在页面上：
  assert.equal(lines.some((l) => l.includes('风险偏好代理，不是真实跨境资金净流入')), true, '需求要求的那句话必须逐字可见')
  assert.equal(lines[0].includes('风险偏好代理，不是真实跨境资金净流入'), true, '免责必须在第一条（最重要的读法提示放最前）')
})

test('数据路径：给了 ToolData ⇒ 数值只来自数据；缺的格子仍是「未取到」+ value null', () => {
  const d = detailModel(cakeTool, {
    status: '数据时刻 2026-10-12 21:05（北京时间）',
    kpi: { 蛋糕温度: { text: '62（平衡）', value: 62, delta: '较上日 +1.0', source: '自定口径：蛋糕温度 = 五市场偏好分均值 × 100' } },
    curve: { days: ['2026-10-10', '2026-10-12'], series: [{ name: '美股', points: [89.16, 89.17] }] },
    pie: { slices: [{ label: '美股', text: '89.17%', value: 89.17, index: 0 }], center: '2026-10-12' },
    market: { rows: [['美股', 'SPY', '8222.73 亿美元', '89.17%', '+0.01pp', '+2.0% / +3.7% / +9.9%', '1 / 5']], rowNotes: [null] },
    extras: [{ title: 'A股净流入（单列）', text: '近 20 个交易日累计 15.56 亿元' }],
    replay: { days: ['2026-10-12'], selected: 0, note: '回放' },
    boundary: ['来自数据源的边界声明'],
  })
  assert.equal(d.kpi.cells[0].text, '62（平衡）', '有数据时 KPI 取数据里的文本')
  assert.equal(d.kpi.cells[0].source, '自定口径：蛋糕温度 = 五市场偏好分均值 × 100', '来源/口径必须透传到模型（悬停用）')
  assert.equal(d.kpi.cells[0].value, 62)
  assert.equal(d.kpi.cells[0].delta, '较上日 +1.0')
  // 数据里没有的格子 ⇒ 仍然「未取到」+ null（不许因为"其他格子有数"就补 0）
  const missingCells = d.kpi.cells.slice(1)
  assert.equal(missingCells.length, 3)
  for (const cell of missingCells) {
    assert.equal(cell.text, NOT_FETCHED, `数据里没有「${cell.label}」⇒ 必须显示「${NOT_FETCHED}」`)
    assert.equal(cell.value, null)
    assert.equal(cell.delta, null)
  }
  assert.equal(d.market.rows.length, 1, '市场表的行来自数据')
  assert.deepEqual(d.market.rowNotes, [null], '行下说明来自数据（缺该行数据时才有内容）')
  assert.equal(d.extras.length, 1, '附加块（A股净流入单列）来自数据')
  // 边界声明 = 工具自己的（始终显示）+ 数据源附带的（可能含数字口径）
  assert.deepEqual(d.boundary.lines, [...cakeTool.boundary, '来自数据源的边界声明'])
  assert.notEqual(d.replay, null, '回放信息来自数据')
})
