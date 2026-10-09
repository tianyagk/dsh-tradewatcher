/**
 *   2. `settled`  灰：休市定稿（`cached`）→ 数据已确定，没有回源的必要，**未开盘不得显示绿色**
 * 不另起一套算法 —— 否则列表头汇总与逐卡颜色会互相矛盾。
 */
import type { QuoteRow } from '../shared/model.ts'

export type QuoteState = 'live' | 'delayed' | 'settled' | 'missing'

/**
 * **同一状态只能有一个名字**（审计 。
 *
 * 此前"三源都没有价格"在界面里有四种叫法：徽标「缺失」、持仓页「无价」、
 * 行内「无行情源」、未刷新时「暂无行情」—— 用户无法确认它们是不是同一件事，
 * 也就无法判断"要不要重试"。现在统一走下面这几个常量：
 *   - `NO_SOURCE_LABEL`：三源都没有 → **无行情源**（重试可能恢复，也可能只是东财没恢复）
 *   - `PENDING_LABEL`：本轮还没拿到（尚未刷新）→ **暂无行情**（等下一拍）
 */
export const NO_SOURCE_LABEL = '无行情源'
export const PENDING_LABEL = '暂无行情'

export const NO_SOURCE_TITLE =
  '东财、腾讯、新浪三个源都没有返回该标的的可用价格。若为期货主连/商品合约，请核对代码大小写（如 114.lhm 与 114.LHM 是同一标的，现已大小写无关匹配）。'
export const PENDING_TITLE = '本轮行情尚未返回该标的（还没刷新完），不是"这个标的没有行情"'

export const QUOTE_STATE_LABEL: Record<QuoteState, string> = {
  live: '实时',
  delayed: '延迟',
  settled: '定稿',
  // 与 NO_SOURCE_LABEL 同一个词：徽标里的"无行情源 N"和行内的标记指的是同一件事
  missing: NO_SOURCE_LABEL,
}

/** 四态色点（跟随主题 token，深/浅色都成立） */
export const QUOTE_STATE_COLOR: Record<QuoteState, string> = {
  live: '#27a644',
  delayed: '#e0a94a',
  settled: '#8a8f98',
  missing: '#ff5f6d',
}

export interface QuoteStateInput {
  row: QuoteRow | undefined
  /** 该 secid 是否在"三源都没有可用价"集合里（大写键） */
  isMissing: boolean
  /** 本次整批是否休市定稿（来自 /quotes 的 cached） */
  cached: boolean
  refreshSec: number
  now: number
}

export function quoteStateOf(input: QuoteStateInput): QuoteState {
  const { row, isMissing, cached, refreshSec, now } = input
  if (isMissing || row === undefined || row.price === null) return 'missing'
  // 定稿优先于实时：休市时数据不会变，显示绿色会让人以为"还在跳动"
  if (cached) return 'settled'
  if (row.source === 'lkg') return 'delayed'
  const at = typeof row.at === 'number' && Number.isFinite(row.at) ? row.at : null
  if (at === null) return 'delayed'
  if (now - at > refreshSec * 1000 * 3) return 'delayed'
  return 'live'
}

export function quoteStateTitle(
  state: QuoteState,
  row: QuoteRow | undefined,
  refreshSec: number,
): string {
  const at = row !== undefined && typeof row.at === 'number' && Number.isFinite(row.at)
    ? new Date(row.at).toLocaleTimeString('zh-CN', { hour12: false })
    : '—'
  const src = row?.source ?? 'em'
  const base = `状态：${QUOTE_STATE_LABEL[state]} · 来源 ${src} · 数据时刻 ${at}`
  if (state === 'missing') return `${base}\n东财/腾讯/新浪三源都没有给出可用价格；卡片显示 —，重试可能恢复`
  if (state === 'settled') return `${base}\n休市定稿：非交易时段且本批数据无兜底行，数据已确定，刷新不会产生新值`
  if (state === 'delayed') {
    return row?.source === 'lkg'
      ? `${base}\n该价格取自最近一次成功值（上游本次未返回），重试可能恢复`
      : `${base}\n数据时刻距今已超过刷新间隔（${refreshSec}s）的 3 倍，上游可能被限流`
  }
  return `${base}\n数据时刻在刷新间隔内，视为实时`
}

export interface QuoteStateSummary {
  live: number
  delayed: number
  settled: number
  missing: number
  total: number
}

/** 汇总（列表头显示 `12/23 实时 · 9 延迟 · 2 缺失`） */
export function summarizeQuoteStates(states: readonly QuoteState[]): QuoteStateSummary {
  const out: QuoteStateSummary = { live: 0, delayed: 0, settled: 0, missing: 0, total: states.length }
  for (const s of states) out[s] += 1
  return out
}
