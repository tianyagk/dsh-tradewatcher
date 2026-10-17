/**
 * 搜索候选的**纯视图逻辑**（不 import react ⇒ 可在 node 里直接断言）。
 *
 * 用户要求（v0.95.1）：搜索时**把所有关键字匹配的候选都列出来**。这里负责四件事：
 *   ① 去重（同一标的可能被两个源返回）；
 *   ② 排序：完全匹配 → 前缀匹配 → 包含匹配；同档内按市场（A股/港股/美股/指数…）与代码；
 *   ③ 分组：按市场分组（沿用弹窗既有的行样式与市场标签）；
 *   ④ 计数 + **诚实边界**：拿满上游上限时如实标记，不假装"这就是全部"。
 *
 * 市场分类用共享的 `marketOf(secid)`（`shared/model.ts`）——**不在这里另写一套前缀表**。
 */
import { marketOf, type Market, type SuggestItem } from '../shared/model.ts'

/** 分组顺序（也是同档内的排序键）：A股 → 港股 → 美股 → 国际指数 → 期货/商品 → 其它 */
export const MARKET_ORDER: readonly Market[] = ['cn', 'hk', 'us', 'intl', 'futures', 'unknown']

/** 市场标签（与全项目一致的叫法） */
export const MARKET_TEXT: Record<Market, string> = {
  cn: 'A股',
  hk: '港股',
  us: '美股',
  intl: '国际指数',
  futures: '期货/商品',
  unknown: '其它',
}

/** 匹配档位：0 完全匹配 / 1 前缀匹配 / 2 包含匹配（数字越小越靠前） */
export function matchTierOf(item: Pick<SuggestItem, 'code' | 'name'>, query: string): 0 | 1 | 2 {
  const q = query.trim()
  if (q === '') return 2
  const ql = q.toLowerCase()
  const code = item.code.toLowerCase()
  const name = item.name.toLowerCase()
  if (code === ql || name === ql) return 0
  if (code.startsWith(ql) || name.startsWith(ql)) return 1
  return 2
}

const marketIndex = (secid: string): number => {
  const i = MARKET_ORDER.indexOf(marketOf(secid))
  return i === -1 ? MARKET_ORDER.length : i
}

/**
 * 去重 + 排序（唯一实现）。
 * 去重键 = `secid`（缺失时退回 `market:code`）；重复项保留**首次出现**的那条（上游给的第一条通常最相关）。
 */
export function rankSuggestions(hits: readonly SuggestItem[], query: string): { rows: SuggestItem[]; deduped: number } {
  const seen = new Set<string>()
  const unique: SuggestItem[] = []
  for (const h of hits) {
    const key = h.secid !== '' ? h.secid : `${h.market}:${h.code}`
    if (seen.has(key)) continue
    seen.add(key)
    unique.push(h)
  }
  const rows = unique.slice().sort((a, b) => {
    const ta = matchTierOf(a, query)
    const tb = matchTierOf(b, query)
    if (ta !== tb) return ta - tb
    const ma = marketIndex(a.secid)
    const mb = marketIndex(b.secid)
    if (ma !== mb) return ma - mb
    if (a.code !== b.code) return a.code < b.code ? -1 : 1
    return a.name < b.name ? -1 : a.name > b.name ? 1 : 0
  })
  return { rows, deduped: hits.length - unique.length }
}

export interface SuggestGroup {
  market: Market
  label: string
  rows: SuggestItem[]
}

/** 按市场分组（顺序 = `MARKET_ORDER`；空组不出现） */
export function groupSuggestions(rows: readonly SuggestItem[]): SuggestGroup[] {
  const out: SuggestGroup[] = []
  for (const m of MARKET_ORDER) {
    const inGroup = rows.filter((r) => marketOf(r.secid) === m)
    if (inGroup.length > 0) out.push({ market: m, label: MARKET_TEXT[m], rows: inGroup })
  }
  return out
}

export interface SuggestListView {
  groups: SuggestGroup[]
  /** 去重后的匹配总数（= 列表能给出的全部行数） */
  total: number
  /** 被去重掉的条数（上游给了重复项） */
  deduped: number
  /** 拿满上限 ⇒ **无法排除上游还有更多**（界面必须写"上游本次上限"） */
  truncated: boolean
  /** 本次向上游要的条数；**回包没给 ⇒ null**（旧宿主） */
  requested: number | null
  /**
   * **旧宿主**：回包缺 `requested` 字段（v0.96.0 之前的路由不认识 `count`、也不回这个字段）。
   * 此时**不能**把 `hits.length` 当成"上游上限"写出来 —— 那是拿我们自己的截断数冒充上游上限。
   */
  legacyHost: boolean
}

export function suggestListViewOf(
  hits: readonly SuggestItem[],
  query: string,
  meta: { requested?: number; truncated?: boolean } = {},
): SuggestListView {
  const { rows, deduped } = rankSuggestions(hits, query)
  // ⚠ 回包**没有** `requested` ⇒ 旧宿主：**不许**用 hits.length 冒充"上游上限"（那会把我们自己的截断当成上游的）
  const legacyHost = meta.requested === undefined
  const requested = legacyHost ? null : meta.requested!
  return {
    groups: groupSuggestions(rows),
    total: rows.length,
    deduped,
    // 上游自己说截断了 ⇒ 认；否则"拿满**我们请求的**上限"也算不可排除（两条都指向同一件事：不能说"这是全部"）
    truncated: meta.truncated === true || (requested !== null && requested > 0 && hits.length >= requested),
    requested,
    legacyHost,
  }
}

/** 分批渲染的批大小：一次只挂这么多行，长列表也不会把 DOM 撑爆（比虚拟化简单，且不需要测高度） */
export const SUGGEST_PAGE = 40

/** 按批截取（组内也按顺序截）⇒ 返回可见的分组与"还有多少条没显示" */
export function batchOf(groups: readonly SuggestGroup[], shown: number): { groups: SuggestGroup[]; hidden: number } {
  const total = groups.reduce((a, g) => a + g.rows.length, 0)
  const limit = Math.max(0, Math.min(total, Math.floor(shown)))
  const out: SuggestGroup[] = []
  let used = 0
  for (const g of groups) {
    if (used >= limit) break
    const take = Math.min(g.rows.length, limit - used)
    used += take
    out.push({ ...g, rows: g.rows.slice(0, take) })
  }
  return { groups: out, hidden: total - used }
}

/**
 * 计数文案（唯一实现；界面与断言共用）。
 *
 * 三种情形，**互斥**：
 *   · 旧宿主（回包缺 `requested`）⇒ 只说"上限未知 + 请重启"，**不写任何上限数字**
 *     （写 hits.length 会把自己的截断冒充成上游上限 —— 用户实测就是被这句话误导过）；
 *   · 拿满我们请求的上限 ⇒ 写出具体条数并声明"可能有更多"；
 *   · 其余 ⇒ 只有总数。
 */
export function countTextOf(view: SuggestListView): string {
  const base = `共 ${view.total} 条`
  if (view.legacyHost) return `${base} · 上游本次上限未知（宿主为旧构建，请重启后生效）`
  return view.truncated
    ? `${base} · 已显示全部 ${view.total} 条（上游本次上限 ${view.requested} 条，可能有更多）`
    : base
}

// ── 弹窗里的下拉高度链（v0.96.2）───────────────────────────────────────────
// 症状：分组添加弹窗里只看到计数行，下面的候选被裁掉。根因是**祖先裁剪**：
//   `.tw-modal{max-height:82vh; overflow:auto}`（`styles.ts:369`）是滚动容器 ⇒
//   它是绝对定位下拉的裁剪边界；下拉 `top:calc(100% + 2px)` 只往下长 ⇒ 超出弹窗内容盒的部分看不见。
// 修法：下拉改用**视口坐标定位**（`position:fixed` + 实测矩形）⇒ 不受任何祖先的 overflow 影响，
//   并按"下方空间够不够"决定**向上翻转**或整体上移；高度取"内容高度、上限、可用空间"的最小值，
//   但**保证 ≥ 5 行 / 160px**（只要视口给得出这个空间）。

/** 一行候选的高度（`.tw-suggest button{padding:6px 11px}` + 12px 字 ⇒ 实测 24px） */
export const SUGGEST_ROW_PX = 24
/** 分组头高度（`padding:4px 11px` + 12px 字） */
export const SUGGEST_HEAD_PX = 21
/** 计数行高度（`padding:6px 11px` + 12px 字） */
export const SUGGEST_COUNT_PX = 26
/** 列表区的最小可见高度：≥5 行 与 ≥160px 取较大者 */
export const SUGGEST_MIN_LIST_PX = Math.max(160, 5 * SUGGEST_ROW_PX)
/** 列表区的最大高度（再高就内部滚动）：视口 52vh 与 320px 取小 */
export function suggestCapOf(viewportH: number): number {
  return Math.min(320, Math.max(SUGGEST_MIN_LIST_PX, Math.round(viewportH * 0.52)))
}
/** 边距（与视口上下各留 8px，避免贴边） */
export const SUGGEST_GAP_PX = 8

export interface SuggestDropdownBox {
  /** 视口坐标（用于 `position:fixed`） */
  top: number
  left: number
  width: number
  /** 整个浮层的最大高度（列表 + 计数行） */
  maxHeight: number
  /** 是否向上展开（贴底翻转） */
  up: boolean
}

/**
 * 算出浮层的落点与高度（**纯函数**：输入是输入框矩形、视口与内容高度）。
 *
 * 规则（顺序即优先级）：
 *   ① 先看下方空间：`below = viewportH - rect.bottom - gap`；
 *   ② 下方放不下"最小可见高度"且上方更宽敞 ⇒ **向上翻转**（`up = true`）；
 *   ③ 高度 = min(上限, max(可用空间, 最小高度)) —— 可用空间不足时**保底最小高度**（宁可盖住输入框，
 *      也不给一个只能看一行的列表）；上限由 `suggestCapOf` 给（52vh / 320px）；
 *   ④ `top` 永远夹在视口内（≥ gap，且不超出底边）⇒ 贴底场景整体上移。
 */
export function suggestDropdownBoxOf(input: {
  rect: { top: number; bottom: number; left: number; width: number }
  viewportH: number
  contentHeight: number
}): SuggestDropdownBox {
  const { rect, viewportH, contentHeight } = input
  const cap = suggestCapOf(viewportH)
  const below = viewportH - rect.bottom - SUGGEST_GAP_PX
  const above = rect.top - SUGGEST_GAP_PX
  const up = below < SUGGEST_MIN_LIST_PX && above > below
  const avail = up ? above : below
  const want = Math.max(SUGGEST_COUNT_PX + SUGGEST_MIN_LIST_PX, Math.min(cap, contentHeight))
  const maxHeight = Math.max(SUGGEST_COUNT_PX + SUGGEST_MIN_LIST_PX, Math.min(want, Math.max(avail, want)))
  const rawTop = up ? rect.top - SUGGEST_GAP_PX - maxHeight : rect.bottom + 2
  const top = Math.max(SUGGEST_GAP_PX, Math.min(rawTop, viewportH - maxHeight - SUGGEST_GAP_PX))
  return { top, left: rect.left, width: rect.width, maxHeight, up }
}

/** 给定浮层高度，列表区能显示几行（用于断言"17 条时可见 ≥5 行"） */
export function visibleRowsOf(maxHeight: number): number {
  return Math.max(0, Math.floor((maxHeight - SUGGEST_COUNT_PX) / SUGGEST_ROW_PX))
}

// ── 键盘高亮下标（P1-4，纯函数便于断言）─────────────────────────────────────
// 旧实现候选行只有 `onMouseDown`：键盘 Enter/Space 触发的是 click ⇒ 键盘永远选不中，
// 只能靠输入框里"回车取第一个"。下面两个函数是 ↑/↓/Home/End 的**唯一实现**。

/**
 * 上下键移动高亮：`-1`（没有高亮）时，↓ 落到第一条、↑ 落到最后一条；到边界**环绕**。
 * `total === 0` ⇒ 返回 `-1`（没有候选，不高亮任何东西）。
 */
export function nextActiveOf(current: number, total: number, delta: -1 | 1): number {
  if (total <= 0) return -1
  if (current < 0) return delta === 1 ? 0 : total - 1
  return (((current + delta) % total) + total) % total
}

/** Home/End：跳到第一条 / 最后一条（没有候选时 `-1`） */
export function edgeActiveOf(total: number, edge: 'home' | 'end'): number {
  if (total <= 0) return -1
  return edge === 'home' ? 0 : total - 1
}
