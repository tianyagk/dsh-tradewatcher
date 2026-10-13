/**
 * 行情引擎的**请求集合**（纯函数，可断言）—— 只请求"会被用到"的标的。
 *
 * ## 为什么单独成模块
 *
 * 这个集合决定"每一拍向上游请求哪些标的"（行情条 / 自选页 / 持仓页共用同一个引擎，
 * `index.tsx` 把它交给 `useQuoteEngine` 后按 `refreshSec` 轮询）。此前它直接取 `TW_ROWS` 全量，
 * 于是**用户明确隐藏的卡片仍然每 10 秒被请求一次** —— 实测 `1.000012`（中国国债，用户已在
 * `prefs.stripCfg.hidden` 里隐藏）出现在每一次东财请求里，而结果永远不会被渲染
 * （见 docs/AUDIT-CACHE-2.md §3.11 / 命题 C11）。
 *
 * ## 口径（与渲染完全一致，不引入新的可见性语义）
 *
 *   请求集合 = ① **会被渲染的**卡片（＝ `visibleCards(rows, hidden)` 的结果）
 *              ∪ ② **当前页面需要的**标的（自选/持仓页的行；大盘页直接读的那几个指数）
 *
 * 说明两点，免得被误读：
 *  - 隐藏（`hidden`）的语义**不变**：它仍然只是"行情条上不显示这张卡"，不改变任何数据含义；
 *    这里顺带让它不再产生每拍的请求 —— 不渲染的东西不该被轮询。
 *  - ② 里的标的**不因隐藏而被过滤**：隐藏作用于行情条卡片，而自选页/持仓页/大盘页上
 *    真正要显示的那一行必须继续取数，否则那些页面会凭空出现空值（那才是语义被改坏）。
 */
import { visibleCards, type StripCardLike, type StripRowLike } from './stripTone.ts'

/**
 * 大盘页**直接读 `quotes[secid]`** 的标的（`MarketPage.tsx`）：
 *   - `quotes['1.000001']`（上证）/ `quotes['0.399001']`（深证）：涨跌家数/成交额那几格的分量
 *     （`breadthCells(sh, sz)`，见 `MarketPage.tsx` 顶部）。
 *
 * ⚠ v0.81.1（归属收窄）：页内那 6 个 A 股指数行（原 `cnIndices` 表 /【指数行情】模块）已按用户要求**删除**
 * ⇒ 大盘页真正还会读的只剩这 2 个。按本文件开头的原则（"不渲染的东西不该被轮询"），
 * 这里从"6 个 `cn` 行"收窄成这 2 个：其余指数照常由行情条**可见卡片**取数，隐藏语义不变。
 *
 * `engineIds.test.ts` 钉住这 2 个确实在 `TW_ROWS` 里、且被隐藏时仍不断供（改了 MarketPage 会红，逼人回来核对）。
 */
export const MARKET_PAGE_SECIDS: readonly string[] = ['1.000001', '0.399001']

/** 页面 key（与 `index.tsx` 的 `PageKey` 同一套值；这里只声明用得到的那些） */
export interface EnginePageLike {
  page: string
  watchIds: readonly string[]
  posIds: readonly string[]
}

/**
 * 当前页面额外需要的标的（这些**不**受 `hidden` 过滤）：
 *   - `watch` / `portfolio`：页面上真有一行要显示；
 *   - `market`：大盘页直接读的那几个指数（见 `MARKET_PAGE_SECIDS`）；
 *   - 其它页（`cloud` / `calendar`）：不额外取数。
 */
export function pageExtraIds(input: EnginePageLike): string[] {
  if (input.page === 'watch') return [...input.watchIds]
  if (input.page === 'portfolio') return [...input.posIds]
  if (input.page === 'market') return [...MARKET_PAGE_SECIDS]
  return []
}

/**
 * 引擎的请求集合：渲染的卡片 ∪ 页面额外需要的标的（去重、保持先后顺序）。
 *
 * `hidden` 传原始值即可（非数组/未知 secid 由 `effectiveHidden` 宽容收敛，
 * 与 store 装载、配置窗、渲染三处共用同一套规则）。
 */
export function quoteEngineIds<T extends StripRowLike>(
  rows: readonly T[],
  hidden: unknown,
  extraIds: readonly string[] = [],
): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  const push = (secid: string): void => {
    if (seen.has(secid)) return
    seen.add(secid)
    out.push(secid)
  }
  for (const view of visibleCards(rows, hidden)) {
    for (const card of view.items as readonly StripCardLike[]) push(card.secid)
  }
  for (const id of extraIds) push(id)
  return out
}
