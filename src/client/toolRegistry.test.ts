/**
 * 工具箱注册表 + 目录页/详情页模型的断言（纯函数层）。
 *
 * 覆盖（每条都配反例注入，证据见 `docs/AUDIT-IMPL43.md` §3）：
 *   ① 目录页模型渲染出 **1 张卡片**且字段齐全（chip / 标题 / 一句话说明 / 页脚入口文案）；
 *   ② 搜索框的**本地过滤**生效（命中/不命中/大小写/多词 AND/空查询）；
 *   ③ 分类标签行**只有「全部」**一个；
 *   ⑤ 注册表新增条目**不改变既有卡片排序规则**（顺序 = 注册顺序，新条目只追加）。
 * 另有三条红线断言（v0.72.0 接数据后扩写）：
 *   · 无数据时每个数据格都是 `未取到` + 原因，且**整份模型零阿拉伯数字**（不得写假数字）；
 *   · 没有 loader 的"结构先行"工具仍走 `PENDING_WHY`（原因分档，不许含糊）；
 *   · 有数据时数值**只来自 ToolData**，数据里没有的格子仍是 `未取到` + null（不许补 0）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  CARD_ACTION,
  CATALOG_TITLE,
  CATEGORY_TABS,
  NO_DATA_WHY,
  NO_MATCH,
  NOT_FETCHED,
  PENDING_WHY,
  SEARCH_PLACEHOLDER,
  TOOL_ENTRIES,
  catalogModel,
  detailModel,
  matchesQuery,
  orderEntries,
  toolById,
  type ToolEntry,
} from './toolRegistry.ts'
import { cakeTool } from './tools/cake.ts'

/** 断言用的固定条目（不碰真实注册表；`sections: []` 时 detailModel 走"缺区"回退） */
function fixture(id: string, name: string, blurb: string, chip: string, category: string): ToolEntry {
  return { id, name, blurb, chip, category, sections: [], boundary: [] }
}

const CAKE_LIKE = fixture('cake', '五市场蛋糕', '把五个市场的宽基 ETF 规模切成一块蛋糕', '蛋糕', 'flow')
const OTHER = fixture('zeta', '估值快照', '看一眼估值与位置', '估值', 'valuation')

test('① 目录页模型：1 张卡片且字段齐全（chip / 标题 / 一句话说明 / 页脚入口文案）', () => {
  const model = catalogModel()
  assert.equal(model.title, CATALOG_TITLE, `页标题必须是「${CATALOG_TITLE}」`)
  assert.equal(model.searchPlaceholder, SEARCH_PLACEHOLDER, `搜索框占位文案必须是「${SEARCH_PLACEHOLDER}」`)
  assert.equal(model.cards.length, 1, `本批只有蛋糕工具 ⇒ 目录页必须恰好 1 张卡片（实得 ${model.cards.length}）`)
  const card = model.cards[0]
  assert.equal(card.id, cakeTool.id, '卡片 id 必须指向注册里的那个工具')
  assert.equal(card.chip, cakeTool.chip)
  assert.equal(card.title, cakeTool.name)
  assert.equal(card.blurb, cakeTool.blurb)
  assert.equal(card.action, CARD_ACTION, '页脚入口文案必须来自唯一来源（CARD_ACTION）')
  // 字段齐全：一个都不许是空串（空串在页面上就是"没有内容"，等于卡片缺胳膊）
  for (const [k, v] of Object.entries(card)) assert.equal(String(v).trim() === '', false, `卡片字段 ${k} 不许为空`)
  assert.equal(model.empty, null, '有卡片 ⇒ 不该有"没有匹配"的空态')
  // 副标题说的是真实数量（不是写死的文案）
  assert.match(model.subtitle, /1/, `副标题应给出真实数量：${model.subtitle}`)
  assert.equal(model.subtitle.includes(String(TOOL_ENTRIES.length)), true, '副标题里的数量必须来自注册表长度')
})

test('② 搜索框本地过滤生效：命中 / 不命中 / 大小写 / 多词 AND / 空查询', () => {
  const all = catalogModel([CAKE_LIKE, OTHER], '', 'all')
  assert.equal(all.cards.length, 2, '空查询 ⇒ 全部（不筛）')
  const hit = catalogModel([CAKE_LIKE, OTHER], '蛋糕', 'all')
  assert.deepEqual(hit.cards.map((c) => c.id), ['cake'], '搜"蛋糕"只该剩蛋糕工具')
  assert.ok(hit.cards.length < all.cards.length, '过滤必须真的减少卡片（否则等于没过滤）')
  const miss = catalogModel([CAKE_LIKE, OTHER], '不存在的关键词', 'all')
  assert.deepEqual(miss.cards, [], '搜不到 ⇒ 零卡片')
  assert.equal(miss.empty, NO_MATCH, '零结果必须给一句空态说明（不是白屏）')
  // 大小写不敏感（搜索文本统一小写后包含匹配）
  assert.deepEqual(catalogModel([CAKE_LIKE, OTHER], 'CAKE', 'all').cards.map((c) => c.id), ['cake'], '大小写不影响命中')
  // 多词 = AND（每个词都要命中）
  assert.deepEqual(catalogModel([CAKE_LIKE, OTHER], '蛋糕 flow', 'all').cards.map((c) => c.id), ['cake'], '多词 AND')
  assert.deepEqual(catalogModel([CAKE_LIKE, OTHER], '蛋糕 zeta', 'all').cards, [], '只要有一个词不命中 ⇒ 不算命中')
  // 命中字段包含一句话说明（用户可能按说明里的词搜）
  assert.equal(matchesQuery(OTHER, '估值'), true, '标题/说明里出现的词必须能命中')
  assert.equal(matchesQuery(OTHER, '估值 '), true, '首尾空白不该让查询失效')
})

test('③ 分类标签行只有「全部」一个（且它就是页面渲染的那一份）', () => {
  assert.deepEqual(CATEGORY_TABS, [{ key: 'all', label: '全部' }], '本批分类标签行只允许「全部」')
  const model = catalogModel()
  assert.deepEqual(model.categories, CATEGORY_TABS, '模型里的标签行必须与 CATEGORY_TABS 同源')
  // 反向确认：条目自己的分类字段**没有**被渲染成标签（下一批才加标签行）
  const labels = model.categories.map((c) => c.label)
  assert.equal(labels.includes(cakeTool.category), false, '条目分类不是标签（本轮标签行只有「全部」）')
  // 分类过滤仍按条目字段生效（`all` = 不筛）
  assert.deepEqual(catalogModel([CAKE_LIKE, OTHER], '', 'flow').cards.map((c) => c.id), ['cake'])
  assert.deepEqual(catalogModel([CAKE_LIKE, OTHER], '', 'all').cards.map((c) => c.id), ['cake', 'zeta'])
})

test('⑤ 注册表新增条目不改变既有卡片排序规则（顺序 = 注册顺序，新条目只追加）', () => {
  const before = catalogModel([CAKE_LIKE, OTHER], '', 'all')
  // 新增一个**名字排在字母表最前**的工具：按名字/分类重排的实现会把它插到最前面 ⇒ 这条会红
  const appended = fixture('aaa', 'AAA 工具', '名字最靠前的工具', 'AAA', 'aaa')
  const after = catalogModel([CAKE_LIKE, OTHER, appended], '', 'all')
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

test('详情页骨架：五个区齐全且顺序固定（KPI 行 / 曲线区 / 饼图区 / 市场表 / 边界声明）', () => {
  const d = detailModel(cakeTool)
  assert.deepEqual(
    [d.kpi.title, d.curve.title, d.pie.title, d.market.title, d.boundary.title],
    ['KPI 行', '曲线区', '饼图区', '市场表', '边界声明'],
    '骨架区的顺序与标题就是详情页的渲染顺序（测试锁它）',
  )
  assert.deepEqual(d.kpi.cells.map((c) => c.label), ['规模榜首', '五市场合计规模', '近五日轮动', '数据时刻'], 'KPI 格子标签是真的（数据源按这些标签填值）')
  assert.deepEqual(
    d.market.columns,
    ['市场', '宽基标的', '规模（美元）', '份额', '份额变化', '动量（多周期）', '横截面排名'],
    '市场表列头是真的（份额 + 变化是用户口径的硬要求）',
  )
  assert.equal(d.backAction.trim() === '', false, '详情页必须有回目录的入口文案')
  assert.deepEqual(d.boundary.lines, [...cakeTool.boundary], '边界声明逐条来自工具文件（不许在页面里另写一份）')
  assert.ok(d.boundary.lines.length >= 3, '边界声明至少要有几条实质内容')
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
  // ④ **整份模型里一个阿拉伯数字都不许有**（`未取到` 之外的任何数都等于编数据）
  const text = JSON.stringify(d)
  assert.equal(/\d/.test(text), false, `详情页骨架里出现了数字（可能是编造的默认值）：${text.slice(0, 200)}`)
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

test('数据路径：给了 ToolData ⇒ 数值只来自数据；缺的格子仍是「未取到」+ value null', () => {
  const d = detailModel(cakeTool, {
    status: '数据时刻 2026-10-12 21:05（北京时间）',
    kpi: { 规模榜首: { text: '美股 89.17%', value: 89.17, delta: '五日 +0.20pp' } },
    curve: { days: ['2026-10-10', '2026-10-12'], series: [{ name: '美股', points: [89.16, 89.17] }] },
    pie: { slices: [{ label: '美股', text: '89.17%', value: 89.17, index: 0 }], center: '2026-10-12' },
    market: { rows: [['美股', 'SPY', '8222.73 亿美元', '89.17%', '+0.01pp', '+2.0% / +3.7% / +9.9%', '1 / 5']], rowNotes: [null] },
    extras: [{ title: 'A股净流入（单列）', text: '近 20 个交易日累计 15.56 亿元' }],
    replay: { days: ['2026-10-12'], selected: 0, note: '回放' },
    boundary: ['来自数据源的边界声明'],
  })
  assert.equal(d.kpi.cells[0].text, '美股 89.17%', '有数据时 KPI 取数据里的文本')
  assert.equal(d.kpi.cells[0].value, 89.17)
  assert.equal(d.kpi.cells[0].delta, '五日 +0.20pp')
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
