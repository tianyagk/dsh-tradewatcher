/**
 * 工具箱注册表 + 卡片/详情模型（**纯函数**，无 React 依赖 ⇒ 可直接断言）。
 *
 * 约定（本批定下，新增工具只做两件事）：
 *  ① 加一个文件 `src/client/tools/<id>.ts`，导出该工具的 `ToolEntry`（id / 名称 / 一句话说明 /
 *     标识 chip / 分类 / **详情页各区的结构声明**）；
 *  ② 在本文件的 `TOOL_ENTRIES` 里注册一行。
 * 本文件**不写**任何具体工具的用户可见文案（那属于工具自己的文件）。
 *
 * 红线（与全项目一致）：**缺数据必须写原因，不许用 0 顶替**。
 * 本批只接结构不接数据源 ⇒ 所有数据格一律 `null` + `未取到` 占位（`NOT_FETCHED`），
 * 由 `detailModel()` 统一生成 —— 页面里不许出现第二个"占位/默认值"来源。
 */
import { cakeTool } from './tools/cake.ts'

/** 详情页的五个区（顺序即渲染顺序；测试锁这个顺序） */
export type ToolSectionKey = 'kpi' | 'curve' | 'pie' | 'market' | 'boundary'

/** 单个区的结构声明（**结构是真的**：标题、口径行、KPI 格子标签、市场表列头都在这里） */
export interface ToolSectionSpec {
  key: ToolSectionKey
  /** 区块标题 */
  title: string
  /**
   * 标题右侧的口径/来源说明。**可省略** ⇒ 取 `PENDING_WHY`（"数据源下一批接入"）。
   * 省略是刻意的：工具文件不该为了写占位原因而回引注册表（那会形成运行时循环 import）。
   */
  note?: string
  /** KPI 行：格子标签（其它区为空数组） */
  cells?: readonly string[]
  /** 市场表：列头（其它区为空数组） */
  columns?: readonly string[]
}

/** 一个工具 = 一个文件里的一份声明（注册表只认这个形状） */
export interface ToolEntry {
  /** 稳定 id（= 文件名；打开详情页、搜索、断言都靠它） */
  id: string
  /** 卡片标题 */
  name: string
  /** 一句话说明（卡片正文；也参与搜索） */
  blurb: string
  /** 左上角标识 chip（短，2–4 字） */
  chip: string
  /** 分类键（分类标签行用它过滤；本轮标签行只有「全部」） */
  category: string
  /** 详情页各区（顺序即渲染顺序） */
  sections: readonly ToolSectionSpec[]
  /** 边界声明（详情页最后一区的正文，逐条） */
  boundary: readonly string[]
}

/** 目录页固定文案（唯一来源：页面与断言都读这里，别处不许再抄一份） */
export const CATALOG_TITLE = '工具目录'
export const SEARCH_PLACEHOLDER = '搜索工具、市场或指标'
/** 卡片页脚入口文案 */
export const CARD_ACTION = '打开工具 →'
/** 详情页"回到目录"的入口文案 */
export const DETAIL_BACK_ACTION = '← 工具目录'
/** 页级返回按钮文案（回上一个非 tools 页签） */
export const PAGE_BACK_ACTION = '← 返回'
/** 无数据占位（**唯一来源**：不许用 `0` / `—` / `暂无` 冒充） */
export const NOT_FETCHED = '未取到'
/** 占位的原因（缺数据必须给原因） */
export const PENDING_WHY = '数据源下一批接入（本轮只搭结构骨架）'
/** 搜索无结果的空态 */
export const NO_MATCH = '没有匹配的工具'

/** 分类标签行（本轮只有「全部」一个；工具条目自己的分类字段先落库，标签行下一批再加） */
export const CATEGORY_TABS: ReadonlyArray<{ key: string; label: string }> = [{ key: 'all', label: '全部' }]

/**
 * 注册表（**顺序 = 卡片顺序**；新增工具追加在末尾）。
 *
 * 排序规则只此一条：**按注册顺序**，不按名称/分类/热度重排 —— 新增一个工具不许让既有卡片挪位
 * （`orderEntries` 是这条规则的唯一实现，`toolRegistry.test.ts` 锁它）。
 */
export const TOOL_ENTRIES: readonly ToolEntry[] = [cakeTool]

/** 排序规则（唯一实现）：注册顺序即展示顺序 */
export function orderEntries(entries: readonly ToolEntry[]): readonly ToolEntry[] {
  return [...entries]
}

/** 卡片模型（页面只渲染它；断言只读它） */
export interface ToolCard {
  id: string
  chip: string
  title: string
  blurb: string
  /** 页脚入口文案 */
  action: string
  category: string
}

/** 目录页模型（标题 / 副标题 / 分类标签行 / 搜索框占位 / 卡片 / 空态） */
export interface CatalogModel {
  title: string
  subtitle: string
  categories: ReadonlyArray<{ key: string; label: string }>
  searchPlaceholder: string
  cards: ToolCard[]
  /** 过滤后为空时的说明（否则 null） */
  empty: string | null
}

/** 一条卡片的搜索文本（一句话说明 + 标题 + chip + 分类 —— 全部小写后做包含匹配） */
export function searchTextOf(entry: ToolEntry): string {
  return [entry.name, entry.blurb, entry.chip, entry.category, entry.id].join(' ').toLowerCase()
}

/** 本地过滤：查询串按空白切成词，**每个词都要命中**（AND）；空查询 ⇒ 全部 */
export function matchesQuery(entry: ToolEntry, query: string): boolean {
  const words = query.trim().toLowerCase().split(/\s+/).filter((w) => w !== '')
  if (words.length === 0) return true
  const hay = searchTextOf(entry)
  return words.every((w) => hay.includes(w))
}

/** 目录页模型（分类过滤 + 本地搜索；`all` 显示全部） */
export function catalogModel(
  entries: readonly ToolEntry[] = TOOL_ENTRIES,
  query = '',
  category = 'all',
  categories: ReadonlyArray<{ key: string; label: string }> = CATEGORY_TABS,
): CatalogModel {
  const cards = orderEntries(entries)
    .filter((e) => category === 'all' || e.category === category)
    .filter((e) => matchesQuery(e, query))
    .map((e): ToolCard => ({ id: e.id, chip: e.chip, title: e.name, blurb: e.blurb, action: CARD_ACTION, category: e.category }))
  const total = orderEntries(entries).filter((e) => category === 'all' || e.category === category).length
  return {
    title: CATALOG_TITLE,
    subtitle: total === 1 ? '本插件自带 1 个工具' : `本插件自带 ${total} 个工具`,
    categories,
    searchPlaceholder: SEARCH_PLACEHOLDER,
    cards,
    empty: cards.length === 0 ? NO_MATCH : null,
  }
}

/** 详情页模型：**结构是真的，数据一律 null**（本批不接数据源） */
export interface DetailModel {
  id: string
  title: string
  chip: string
  backAction: string
  kpi: { title: string; note: string; cells: Array<{ label: string; text: string; value: null }> }
  curve: { title: string; note: string; points: number[]; empty: string }
  pie: { title: string; note: string; slices: Array<{ label: string; text: string; value: null }>; empty: string }
  market: { title: string; note: string; columns: string[]; rows: string[][]; empty: string }
  boundary: { title: string; note: string; lines: string[] }
}

/** 取一个工具（详情页路由用）；认不出 ⇒ null（调用方回目录） */
export function toolById(id: string, entries: readonly ToolEntry[] = TOOL_ENTRIES): ToolEntry | null {
  return entries.find((e) => e.id === id) ?? null
}

function sectionOf(entry: ToolEntry, key: ToolSectionKey): ToolSectionSpec | null {
  return entry.sections.find((s) => s.key === key) ?? null
}

/** 区的口径行：工具没写 ⇒ 统一的占位原因（唯一来源在注册表这一侧） */
function noteOf(spec: ToolSectionSpec): string {
  return spec.note ?? PENDING_WHY
}

/**
 * 详情页模型。
 *
 * ⚠ 除区标题/口径行/格子标签/列头/边界声明以外，**不允许出现任何数值或数字文本** ——
 * 本批没有数据源，凡是"数"都必须走 `NOT_FETCHED` 占位（`toolRegistry.test.ts` 扫这条）。
 */
export function detailModel(entry: ToolEntry): DetailModel {
  const sec = (key: ToolSectionKey, title: string): ToolSectionSpec => sectionOf(entry, key) ?? { key, title, note: PENDING_WHY }
  const kpi = sec('kpi', 'KPI 行')
  const curve = sec('curve', '曲线区')
  const pie = sec('pie', '饼图区')
  const market = sec('market', '市场表')
  const boundary = sec('boundary', '边界声明')
  return {
    id: entry.id,
    title: entry.name,
    chip: entry.chip,
    backAction: DETAIL_BACK_ACTION,
    kpi: {
      title: kpi.title,
      note: noteOf(kpi),
      cells: (kpi.cells ?? []).map((label) => ({ label, text: NOT_FETCHED, value: null })),
    },
    curve: { title: curve.title, note: noteOf(curve), points: [], empty: `${NOT_FETCHED}：${PENDING_WHY}` },
    pie: {
      title: pie.title,
      note: noteOf(pie),
      // 饼图的层由数据源决定 ⇒ 本批连层名都不编（空数组 + 空态说明）
      slices: [],
      empty: `${NOT_FETCHED}：${PENDING_WHY}`,
    },
    market: {
      title: market.title,
      note: noteOf(market),
      columns: [...(market.columns ?? [])],
      rows: [],
      empty: `${NOT_FETCHED}：${PENDING_WHY}`,
    },
    boundary: { title: boundary.title, note: noteOf(boundary), lines: [...entry.boundary] },
  }
}
