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
  /** 本次向上游要的条数 */
  requested: number
}

export function suggestListViewOf(
  hits: readonly SuggestItem[],
  query: string,
  meta: { requested?: number; truncated?: boolean } = {},
): SuggestListView {
  const { rows, deduped } = rankSuggestions(hits, query)
  const requested = meta.requested ?? hits.length
  return {
    groups: groupSuggestions(rows),
    total: rows.length,
    deduped,
    // 上游自己说截断了 ⇒ 认；否则"拿满上限"也算不可排除（两条都指向同一件事：不能说"这是全部"）
    truncated: meta.truncated === true || (requested > 0 && hits.length >= requested),
    requested,
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

/** 计数文案（唯一实现；界面与断言共用）：`共 N 条` + 截断时如实补一句 */
export function countTextOf(view: SuggestListView): string {
  const base = `共 ${view.total} 条`
  return view.truncated ? `${base} · 已显示全部 ${view.total} 条（上游本次上限 ${view.requested} 条，可能有更多）` : base
}
