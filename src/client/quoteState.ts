/**
 *   2. `settled`  灰：休市定稿（`cached`）→ 数据已确定，没有回源的必要，**未开盘不得显示绿色**
 * 不另起一套算法 —— 否则列表头汇总与逐卡颜色会互相矛盾。
 */
import type { QuoteRow } from '../shared/model.ts'
import { shClockText } from './marketTime.ts'
export { QUOTE_STATE_COLOR } from './theme.ts'

/**
 * 五态（P0-2/U1）：`live / delayed / settled / missing` 之上补 **`pending`**。
 *
 * `pending` = **本轮还没拿到**（该 secid 不在本次请求里，或首拍还没回来）。它与 `missing`
 * （三源都给了"没有可用价格"）是**两件相反的事**：前者等下一拍就有，后者重试也可能没有。
 * 旧实现把二者都塞进 `missing` ⇒ 用户隐藏一张卡、或首屏第一拍之前，行情条就断言
 * "三源都没有"（一句当时并不成立的话），且与相邻的「无行情源 N」互相打脸。
 */
export type QuoteState = 'live' | 'delayed' | 'settled' | 'pending' | 'missing'

/**
 * **同一状态只能有一个名字**（审计 。
 *
 * 此前"三源都没有价格"在界面里有四种叫法：徽标「缺失」、持仓页「无价」、
 * 行内「无行情源」、未刷新时「未取到」—— 用户无法确认它们是不是同一件事，
 * 也就无法判断"要不要重试"。现在统一走下面这几个常量：
 *   - `NO_SOURCE_LABEL`：三源都没有 → **无行情源**（重试可能恢复，也可能只是东财没恢复）
 *   - `PENDING_LABEL`：本轮还没拿到（尚未刷新）→ **未取到**（等下一拍）
 */
export const NO_SOURCE_LABEL = '无行情源'
export const PENDING_LABEL = '未取到'

export const NO_SOURCE_TITLE =
  '东财、腾讯、新浪三个源都没有返回该标的的可用价格。若为期货主连/商品合约，请核对代码大小写（如 114.lhm 与 114.LHM 是同一标的，现已大小写无关匹配）。'
export const PENDING_TITLE = '本轮行情未取到该标的（还没刷新完），不是"这个标的没有行情"'

export const QUOTE_STATE_LABEL: Record<QuoteState, string> = {
  live: '实时',
  delayed: '延迟',
  settled: '定稿',
  // 与 PENDING_LABEL 同一个词：徽标里的"未取到"和行内的标记指的是同一件事
  pending: PENDING_LABEL,
  // 与 NO_SOURCE_LABEL 同一个词：徽标里的"无行情源 N"和行内的标记指的是同一件事
  missing: NO_SOURCE_LABEL,
}

/** 五态色点（跟随主题 token，深/浅色都成立） */

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
  // 服务端明确的"三源都没有可用价"优先：它是**结论**，不是"还没取到"
  if (isMissing) return 'missing'
  // 没有这一行 = 本轮没请求它 / 首拍还没回来 ⇒ **未取到**（等下一拍），不是"三源都没有"
  if (row === undefined) return 'pending'
  if (row.price === null) return 'missing'
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
  // R5：行情卡 title 里的"数据时刻"固定北京时间（浏览器时区无关）
  const at = row !== undefined && typeof row.at === 'number' && Number.isFinite(row.at)
    ? shClockText(row.at)
    : '—'
  const src = row?.source ?? 'em'
  const base = `状态：${QUOTE_STATE_LABEL[state]} · 来源 ${src} · 数据时刻 ${at}`
  if (state === 'pending') return `${base}\n${PENDING_TITLE}`
  if (state === 'missing') return `${base}\n东财/腾讯/新浪三源都没有给出可用价格；卡片显示 —，重试可能恢复`
  if (state === 'settled') return `${base}\n休市定稿：非交易时段且本批数据无兜底行，数据已确定，刷新不会产生新值`
  if (state === 'delayed') {
    return row?.source === 'lkg'
      ? `${base}\n该价格取自最近一次成功值（上游本次未取到），重试可能恢复`
      : `${base}\n数据时刻距今已超过刷新间隔（${refreshSec}s）的 3 倍，上游可能被限流`
  }
  return `${base}\n数据时刻在刷新间隔内，视为实时`
}

export interface QuoteStateSummary {
  live: number
  delayed: number
  settled: number
  pending: number
  missing: number
  total: number
}

/** 汇总（列表头显示 `12/23 实时 · 9 延迟 · 2 无行情源`） */
export function summarizeQuoteStates(states: readonly QuoteState[]): QuoteStateSummary {
  const out: QuoteStateSummary = { live: 0, delayed: 0, settled: 0, pending: 0, missing: 0, total: states.length }
  for (const s of states) out[s] += 1
  return out
}

/** 行情条上**真正渲染**的一张卡（只要 secid；与 `TW_ROWS` 的结构解耦，便于断言） */
export interface StripCardRef {
  secid: string
}

export interface StripSummaryInput {
  /** **屏幕上**的卡片（已按 `stripCfg.hidden` 过滤，见 `visibleCards`） */
  screen: ReadonlyArray<{ items: ReadonlyArray<StripCardRef> }>
  /** 用户隐藏的卡片数（这些既不请求、也不进汇总） */
  hiddenCount: number
  /** 服务端"三源都没有可用价"集合（大写键） */
  missing?: ReadonlySet<string>
  /** 逐卡状态判定（与卡片色点共用同一函数） */
  stateOf: (secid: string) => QuoteState
}

export interface StripSummary {
  summary: QuoteStateSummary
  /** 屏幕上的卡片数（徽标分母） */
  screen: number
  /** 已隐藏、不请求、**不计入**分母的卡片数 */
  hidden: number
  /** 屏幕上三源都没有可用价的张数（相邻「无行情源 N」徽标用它；隐藏卡永不计入） */
  noSourceOnScreen: number
  /** 徽标正文 */
  badgeText: string
}

/**
 * 行情条汇总（P0-2）：分母 = **屏幕上的卡片数**。
 *
 * 隐藏的卡已经不请求（`engineIds.quoteIds...`），把它们算进来会得到"永久缺失 1 张"的常驻误报；
 * 这里只对 `screen` 求值，隐藏张数如实写进 title（见 `stripSummaryTitle`）。
 */
export function summarizeStrip(input: StripSummaryInput): StripSummary {
  const ids = input.screen.flatMap((row) => row.items.map((it) => it.secid))
  const summary = summarizeQuoteStates(ids.map((id) => input.stateOf(id)))
  const screenUpper = new Set(ids.map((id) => id.toUpperCase()))
  const noSourceOnScreen = [...(input.missing ?? [])].filter((key) => screenUpper.has(key.toUpperCase())).length
  const parts = [`${summary.live}/${summary.total} 实时`]
  if (summary.delayed > 0) parts.push(`${summary.delayed} 延迟`)
  if (summary.settled > 0) parts.push(`${summary.settled} 定稿`)
  if (summary.pending > 0) parts.push(`${summary.pending} ${QUOTE_STATE_LABEL.pending}`)
  if (summary.missing > 0) parts.push(`${summary.missing} ${QUOTE_STATE_LABEL.missing}`)
  return {
    summary,
    screen: ids.length,
    hidden: Math.max(0, input.hiddenCount),
    noSourceOnScreen,
    badgeText: parts.join(' · '),
  }
}

/**
 * 汇总徽标的 title：屏幕张数、隐藏张数（不请求、不计入）、数据时刻与来源明细。
 * 「隐藏 M 张」必须说出来 —— 否则用户数一遍屏幕发现少几张，却没有任何解释。
 */
export function stripSummaryTitle(input: {
  summary: QuoteStateSummary
  screen: number
  hidden: number
  asOfText: string
  sourcesText: string
}): string {
  const { summary, screen, hidden } = input
  const hiddenNote = hidden > 0 ? `；另有 ${hidden} 张已隐藏（不请求、不计入本行）` : ''
  return (
    `屏幕 ${screen} 张卡片：实时 ${summary.live} · 延迟 ${summary.delayed} · 定稿复用 ${summary.settled}` +
    ` · ${QUOTE_STATE_LABEL.pending} ${summary.pending} · ${QUOTE_STATE_LABEL.missing} ${summary.missing}${hiddenNote}\n` +
    `最近一次成功行情 ${input.asOfText}；来源明细：${input.sourcesText}`
  )
}
