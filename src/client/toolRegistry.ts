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
  /** **可见副标题**（用户口径：段标题下面那一句导航说明）；与 `note` 不同，它默认可见 */
  subtitle?: string
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
  /**
   * Hero 区（详情页最上面那块）：小标签（kicker）+ 大标题 + 一段说明。
   * 标题取 `name`（工具名逐字锁定，不许在 Hero 里另写一个）；这里只补 kicker 与说明。
   */
  hero?: { kicker: string; note: string }
  /** 曲线窗口档位与默认档（如 `{ options: [90, 180, 365], initial: 180 }`）；省略 ⇒ 不渲染时间范围控件 */
  ranges?: { options: readonly number[]; initial: number }
  /** 详情页各区（顺序即渲染顺序） */
  sections: readonly ToolSectionSpec[]
  /**
   * 「当前偏好怎么判断」那一段散文的句子（用户口径：方法归方法、边界归边界）。
   * 与 `boundary` 的分工只是**叙事位置**不同，事实一条都不许少（测试会核对并集）。
   */
  method?: readonly string[]
  /** 边界声明（详情页最后一区的正文，逐条）。**不许含阿拉伯数字**（红线：无数据时整份模型零数字） */
  boundary: readonly string[]
  /**
   * 数据加载器（可选）：**只有需要数据的工具才写**。
   *
   * 为什么是"两步"（先 load，再 `at(回放步)`）：详情页的回放滑块要在**同一个载荷**上换视图，
   * 换一帧就发一次请求是不可接受的。因此 `load()` 负责取数一次，`at()` 只做本地视图映射
   * （纯函数 ⇒ 可直接断言"回放零上游请求"）。
   */
  load?: () => Promise<ToolPayload>
}

/** 工具的载荷句柄：一次取数 + 本地回放 */
export interface ToolPayload {
  /** 回放最大步数（0 = 最新一日；越大越早） */
  replayMax: number
  /**
   * 取某一回放步的详情视图模型（本地计算，不发请求）。
   * 第二个参数是曲线窗口（工具的 `ranges` 档位之一）；省略 ⇒ 用宿主构建的整条曲线。
   */
  at(replayIndex: number, rangeDays?: number): ToolData
}

/** KPI 格子：`text` 是显示文本（缺数据时必须走 `NOT_FETCHED`），`delta` 是右侧的对比值 */
export interface ToolKpiDatum {
  text: string
  value: number | null
  delta: string | null
  /**
   * 来源与口径（进磁贴的 `title`/`aria-label`；用户口径 v0.86.0：四块磁贴都要能悬停读到来源）。
   * **自定口径必须写明"自定"+ 公式**，不许写成上游口径。无数据时不出现。
   */
  source?: string
  /**
   * 色标：该磁贴对应的**曲线序列序号**（与曲线/图例同色）；`null`/缺省 ⇒ 中性色标
   * （该格不对应任何一条序列，例如"五市场合计规模""数据时刻"）。
   *
   * 只影响颜色，不引入任何新数值 —— 无数据时它不出现（红线：整份模型零阿拉伯数字）。
   */
  swatch?: number | null
}

/**
 * 市场横条行（用户口径：五个市场各一条横条，而不是八列表格）。
 *
 * **诚实信息不许丢**：原来表格里的规模 / 偏好分 / 动量 / 横截面排名全部进 `detail`
 * （悬停 + 行内小字都能读到）；缺数据的行仍有 `note`（`未取到` + 原因）。
 */
export interface ToolBarRow {
  name: string
  /** 当前相对份额的显示文本（缺 ⇒ `未取到`） */
  shareText: string
  /** 份额（百分点 0–100）：条长按它画；null ⇒ 不画条（缺数据） */
  sharePct: number | null
  /** 是否「当前最多」（该日份额榜首） */
  top: boolean
  /** 条右侧的「近5日」说明（升/降温 × 个百分点；判不了就如实说） */
  deltaText: string
  /** 上面那句的语义（页面据此配色；`unknown` ⇒ 中性色） */
  deltaKind: 'warm' | 'cool' | 'flat' | 'unknown'
  /** 悬停/行内小字：规模 ｜ 偏好分 ｜ 动量 ｜ 横截面排名（回放日写「不适用（回放日）」） */
  detail: string
  /** 该行缺什么 + 原因（null = 全齐） */
  note: string | null
}

/** 曲线的一条序列（**数值是真的**；缺的点用 null，画断，不连成假线） */
export interface ToolCurveSeries {
  name: string
  points: Array<number | null>
}

/** 饼图一块：`value` 用于算弧长（null ⇒ 这一块不进饼图，必须在 `missing` 里给原因） */
export interface ToolPieSlice {
  label: string
  text: string
  value: number | null
  /** 该块在数据源里的序号（页面配色按它取，保证与曲线同色） */
  index?: number
}

/** 工具的真实数据（缺什么就缺什么：`未取到` 由 detailModel 统一补，页面不许再写一份） */
export interface ToolData {
  /** 常驻状态行：**只放必要事实**（数据时刻 + 降级/陈旧标记） */
  status: string
  /** 状态行的完整版（取数方式/曲线构成/作废留痕等）⇒ 进 `title` / `aria-label`，不占版面 */
  statusDetail?: string
  /** 图表卡右上角 `AS OF`（当前显示那一天的日期） */
  chartAsOf?: string | null
  /** 当前窗口（序列日数）与可选档位（时间范围分段控件用） */
  rangeDays?: number
  rangeOptions?: number[]
  /** 摘要卡（Hero 下方的 1–2 张：值 + 状态词，值必须来自真实数据） */
  summary?: Array<{ key: string; label: string; value: string; note: string | null }>
  /** 整份数据缺失时的原因（分区里单点缺失各自写在 notes/missing 里） */
  why?: string | null
  /** 方法段的可覆写句子（缺省 = 工具文件里的 `method`；例如"这一屏用的是快照"） */
  method?: readonly string[]
  /** 各区可覆写的口径行（缺省 = 结构声明里的文案） */
  notes?: Partial<Record<ToolSectionKey, string>>
  /** KPI：按**格子标签**取值（标签是工具文件的契约；取不到就显示未取到 + 原因） */
  kpi?: Record<string, ToolKpiDatum>
  curve?: { days: string[]; series: ToolCurveSeries[]; marks?: Array<{ index: number; label: string }> }
  pie?: { slices: ToolPieSlice[]; center?: string | null; note?: string | null }
  market?: { rows: string[][]; rowNotes?: Array<string | null>; footnotes?: string[]; bars?: ToolBarRow[] }
  /** 附加块（例如"单列、不参与份额计算"的 A股净流入） */
  extras?: Array<{ title: string; text: string }>
  /**
   * 段末**一行结论**（用户口径：`→ 近5日资金偏好显示：…`）。
   * 与 KPI 磁贴里的简短版并存：磁贴给读数，这一行给结论。
   */
  conclusion?: string | null
  /** 回放（最近 N 个交易日的本地回放） */
  replay?: { days: string[]; selected: number; note: string }
  /** 来自数据源的附加边界声明（可能含数字口径） */
  boundary?: readonly string[]
}

/**
 * 固定文案（唯一来源）：实体定义在叶子模块 `toolText.ts`（那里解释了为什么必须单独一个文件
 * —— 工具文件里的运行时 import 会让常量留在这里形成"注册表 → 工具 → 视图 → 注册表"的环），
 * 这里**原样再导出**，调用方与断言仍然只从 `toolRegistry` 拿。
 */
export {
  BOUNDARY_TITLE,
  DETAIL_BACK_ACTION,
  METHOD_TITLE,
  NO_DATA_WHY,
  NO_MATCH,
  NOT_FETCHED,
  PENDING_WHY,
  SECTION_EMPTY_WHY,
} from './toolText.ts'
import {
  DETAIL_BACK_ACTION,
  METHOD_TITLE,
  NO_DATA_WHY,
  NO_MATCH,
  NOT_FETCHED,
  PENDING_WHY,
  SECTION_EMPTY_WHY,
} from './toolText.ts'

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
  category: string
}

/**
 * 目录页模型（分类标签行 / 搜索框占位 / 卡片 / 空态）。
 *
 * ⚠ 曾经有 `title`（`工具目录`）与 `subtitle`（`本插件自带 N 个工具`）两个字段：用户要求**删掉页头那一行**
 * ⇒ 字段一并删除（留着就是"没人渲染的死字段"，还会误导下一个人以为页头该有标题）。
 */
export interface CatalogModel {
  categories: ReadonlyArray<{ key: string; label: string }>
  cards: ToolCard[]
  /** 过滤后为空时的说明（否则 null） */
  empty: string | null
}

/**
 * 目录页模型（分类过滤；`all` 显示全部）。
 *
 * ⚠ v0.81.0：用户判定**搜索框冗余** ⇒ 整条搜索链路（`query` 参数、`matchesQuery`、`searchTextOf`、
 * `searchPlaceholder` 字段与 `SEARCH_PLACEHOLDER` 文案）全部删除。`empty` 仍保留：
 * 分类过滤（或将来工具变多）仍可能过滤出零结果，页面照旧给一句空态而不是白屏。
 */
export function catalogModel(
  entries: readonly ToolEntry[] = TOOL_ENTRIES,
  category = 'all',
  categories: ReadonlyArray<{ key: string; label: string }> = CATEGORY_TABS,
): CatalogModel {
  const cards = orderEntries(entries)
    .filter((e) => category === 'all' || e.category === category)
    .map((e): ToolCard => ({ id: e.id, chip: e.chip, title: e.name, blurb: e.blurb, category: e.category }))
  return { categories, cards, empty: cards.length === 0 ? NO_MATCH : null }
}

/**
 * 详情页模型：**结构是真的**，数据来自 `ToolData`（没给数据 ⇒ 一律 `未取到` + 原因）。
 *
 * ⚠ 红线（`toolRegistry.test.ts` 扫这条）：**没有数据时**（`detailModel(entry)`）整份模型里
 * 一个阿拉伯数字都不许有 —— 那意味着有人写了一个"看起来像数"的默认值。有数据时数字只能来自
 * `ToolData`（页面不许自己造数）。
 */
export interface DetailModel {
  id: string
  title: string
  chip: string
  backAction: string
  /** Hero：小标签 + 大标题 + 一段说明（标题 = 工具名） */
  hero: { kicker: string; title: string; note: string }
  /** 摘要卡（0–2 张；值来自数据，取不到 ⇒ 未取到） */
  summary: Array<{ key: string; label: string; value: string; note: string | null }>
  /** 图表卡右上角 `AS OF` */
  chartAsOf: string | null
  /** 时间范围分段控件（`options` 为空 ⇒ 不渲染） */
  ranges: { options: number[]; selected: number | null }
  /** 常驻状态行：有数据 = 数据时刻 + 降级标记；无数据 = 缺失原因 */
  status: string
  /** 状态行的完整版（进 title/aria-label） */
  statusTitle: string
  kpi: { title: string; note: string; cells: Array<{ label: string; text: string; value: number | null; delta: string | null; swatch: number | null; source: string | null }> }
  curve: { title: string; note: string; days: string[]; series: ToolCurveSeries[]; marks: Array<{ index: number; label: string }>; empty: string }
  pie: { title: string; note: string; slices: ToolPieSlice[]; center: string | null; empty: string }
  market: { title: string; subtitle: string | null; note: string; columns: string[]; rows: string[][]; rowNotes: Array<string | null>; footnotes: string[]; empty: string; bars: ToolBarRow[] }
  boundary: { title: string; note: string; lines: string[] }
  /** 「当前偏好怎么判断」那一段（标题 + 句子） */
  method: { title: string; lines: string[] }
  /** 段末一行结论（`→ 近5日资金偏好显示：…`）；判不了时也如实给一句 */
  conclusion: string | null
  extras: Array<{ title: string; text: string }>
  replay: { days: string[]; selected: number; note: string } | null
}

/** 取一个工具（详情页路由用）；认不出 ⇒ null（调用方回目录） */
export function toolById(id: string, entries: readonly ToolEntry[] = TOOL_ENTRIES): ToolEntry | null {
  return entries.find((e) => e.id === id) ?? null
}

function sectionOf(entry: ToolEntry, key: ToolSectionKey): ToolSectionSpec | null {
  return entry.sections.find((s) => s.key === key) ?? null
}

/** 区的口径行：数据源给了就用它（带真实口径），否则用工具文件里的，再否则统一的占位原因（唯一来源在注册表这一侧） */
function noteOf(spec: ToolSectionSpec, data: ToolData | null, key: ToolSectionKey, fallback: string): string {
  const fromData = data?.notes?.[key]
  if (fromData !== undefined && fromData.trim() !== '') return fromData
  return spec.note ?? fallback
}

/**
 * 详情页模型。`data` 省略 ⇒ 保持"结构骨架 + 未取到占位"（本批之前的行为，红线断言照旧）。
 */
export function detailModel(entry: ToolEntry, data: ToolData | null = null): DetailModel {
  // 兜底标题（工具文件漏写 `title` 时用）：**必须是用户可读文案**。
  // ⚠ 曾经这里放的是内部区名（`KPI 行`/`曲线区`/`饼图区`/`市场表`/`边界声明`）——
  //   蛋糕工具自己给了新标题 ⇒ 今天不显示，但任何工具只要漏写 `title` 就会把内部名端给用户。
  //   断言：这五个兜底标题里不许出现内部区名（见 toolRegistry.test.ts「兜底标题」）。
  const sec = (key: ToolSectionKey, title: string): ToolSectionSpec => sectionOf(entry, key) ?? { key, title, note: PENDING_WHY }
  const kpi = sec('kpi', '关键指标')
  const curve = sec('curve', '份额曲线')
  const pie = sec('pie', '最近三十个交易日')
  const market = sec('market', '市场构成')
  const boundary = sec('boundary', '数据边界')
  // "没有数据"的原因分三种（不许含糊）：工具无数据源 / 这一屏没取到 / 这一区没有
  const fallback = data === null ? (entry.load === undefined ? PENDING_WHY : NO_DATA_WHY) : SECTION_EMPTY_WHY
  const why = data === null ? fallback : (data.why ?? fallback)
  const emptyOf = (): string => `${NOT_FETCHED}：${why}`
  // KPI：标签来自工具文件（契约），值来自数据（取不到 ⇒ 未取到 + value null）
  const kpiCells = (kpi.cells ?? []).map((label) => {
    const datum = data?.kpi?.[label]
    if (datum === undefined) return { label, text: NOT_FETCHED, value: null, delta: null, swatch: null, source: null }
    return { label, text: datum.text, value: datum.value, delta: datum.delta, swatch: datum.swatch ?? null, source: datum.source ?? null }
  })
  const boundaryLines = data?.boundary === undefined ? [...entry.boundary] : [...entry.boundary, ...data.boundary]
  const ranges = [...(entry.ranges?.options ?? [])]
  return {
    id: entry.id,
    title: entry.name,
    chip: entry.chip,
    backAction: DETAIL_BACK_ACTION,
    hero: {
      kicker: entry.hero?.kicker ?? entry.chip,
      title: entry.name,
      note: entry.hero?.note ?? entry.blurb,
    },
    summary: data?.summary ?? [],
    chartAsOf: data?.chartAsOf ?? null,
    ranges: {
      options: ranges,
      selected: ranges.length === 0 ? null : (data?.rangeDays ?? entry.ranges?.initial ?? ranges[0]),
    },
    status: data?.status ?? `${NOT_FETCHED}：${why}`,
    statusTitle: data?.statusDetail ?? data?.status ?? `${NOT_FETCHED}：${why}`,
    kpi: { title: kpi.title, note: noteOf(kpi, data, 'kpi', fallback), cells: kpiCells },
    curve: {
      title: curve.title,
      note: noteOf(curve, data, 'curve', fallback),
      days: data?.curve?.days ?? [],
      series: data?.curve?.series ?? [],
      marks: data?.curve?.marks ?? [],
      empty: emptyOf(),
    },
    pie: {
      title: pie.title,
      note: noteOf(pie, data, 'pie', fallback),
      slices: data?.pie?.slices ?? [],
      center: data?.pie?.center ?? null,
      empty: data?.pie?.note ?? emptyOf(),
    },
    method: {
      title: METHOD_TITLE,
      // 数据侧可以覆写（例如"这一屏用的是快照"），缺省用工具文件里的方法段
      lines: [...(data?.method ?? entry.method ?? [])],
    },
    conclusion: data?.conclusion ?? null,
    market: {
      title: market.title,
      subtitle: market.subtitle ?? null,
      bars: data?.market?.bars ?? [],
      note: noteOf(market, data, 'market', fallback),
      columns: [...(market.columns ?? [])],
      rows: data?.market?.rows ?? [],
      rowNotes: data?.market?.rowNotes ?? [],
      footnotes: data?.market?.footnotes ?? [],
      empty: emptyOf(),
    },
    boundary: { title: boundary.title, note: noteOf(boundary, data, 'boundary', fallback), lines: boundaryLines },
    extras: data?.extras ?? [],
    replay: data?.replay ?? null,
  }
}
