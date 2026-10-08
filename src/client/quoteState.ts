/**
 * 行情卡片四态判定（P0-2）。
 *
 * 目的：一眼分辨一张卡片是「实时 / 延迟 / 定稿复用 / 没有」。
 * 此前只有列表头的汇总徽标（滞后 N / 无行情源 N），具体是哪几张要看 tooltip 才知道，
 * 而"这张卡上的价到底是刚拿到的还是十分钟前的"恰恰是单个数字可信度的前提。
 *
 * 四态与判据（顺序敏感 —— 从上往下第一个命中者生效）：
 *   1. `missing`  红：没有可用价格（三源都没有）→ 卡片是 `—`，不是"还没刷新"
 *   2. `settled`  灰：休市定稿（`cached`）→ 数据已确定，没有回源的必要，**未开盘不得显示绿色**
 *   3. `delayed`  黄：兜底值（`source==='lkg'`）或观测时刻超过刷新间隔的 3 倍
 *   4. `live`     绿：以上都不成立
 *
 * 这里的判定与 `/quotes` 的 `asOf`/`stale`/`cached` **同源**（都用行内 `at`/`source`），
 * 不另起一套算法 —— 否则列表头汇总与逐卡颜色会互相矛盾。
 */
import type { QuoteRow } from '../shared/model.ts'

export type QuoteState = 'live' | 'delayed' | 'settled' | 'missing'

export const QUOTE_STATE_LABEL: Record<QuoteState, string> = {
  live: '实时',
  delayed: '延迟',
  settled: '定稿',
  missing: '缺失',
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
  const base = `状态：${QUOTE_STATE_LABEL[state]} · 来源 ${src} · 观测时刻 ${at}`
  if (state === 'missing') return `${base}\n东财/腾讯/新浪三源都没有给出可用价格；卡片显示 —，重试可能恢复`
  if (state === 'settled') return `${base}\n休市定稿：非交易时段且本批数据无兜底行，数据已确定，刷新不会产生新值`
  if (state === 'delayed') {
    return row?.source === 'lkg'
      ? `${base}\n该价格取自最近一次成功值（上游本次未返回），重试可能恢复`
      : `${base}\n观测时刻已超过刷新间隔（${refreshSec}s）的 3 倍，上游可能被限流`
  }
  return `${base}\n观测时刻在刷新间隔内，视为实时`
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
