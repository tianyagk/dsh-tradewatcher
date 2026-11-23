/**
 * 候选池（持仓 + 自选）指标表：把「技术面/动量/估值」算成一行一只，交给模型做选股判断。
 *
 * 口径（用户裁决 2026-11-23）：**不做选股评分**，只提供客观指标；叙事状态由模型结合新闻与骨架自行判断。
 * 缺数据写 — 并给一句原因，不拿 0 或"平"冒充。
 */
import type { DayBar } from '../shared/model.ts'
import { techOf, type IndexTech } from './indexTech.ts'

export interface CandidateInput { secid: string; name: string; held: boolean }
export interface CandidateValuation { pe: number | null; pb: number | null; totalMv: number | null; name: string | null }
export interface CandidateRow extends IndexTech { held: boolean; pe: number | null; pb: number | null; totalMv: number | null }

export interface CandidateDeps {
  loadBars: (secid: string) => Promise<readonly DayBar[] | null>
  loadValuation: (secids: string[]) => Promise<Record<string, CandidateValuation>>
}

const pyi = (v: number | null): string => (v === null ? '—' : `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`)
const num = (v: number | null, n = 2): string => (v === null ? '—' : v.toFixed(n))
const px = (v: number | null): string => (v === null ? '—' : v < 10 ? v.toFixed(3) : v.toFixed(2))
/** 市值（元 → 亿元） */
const mvYi = (v: number | null): string => (v === null ? '—' : `${(v / 1e8).toFixed(1)} 亿`)

export function candidateRowOf(c: CandidateInput, bars: readonly DayBar[], val: CandidateValuation | undefined): CandidateRow {
  const t = techOf({ name: c.name, secid: c.secid, role: c.held ? '持仓' : '自选' }, bars)
  return { ...t, held: c.held, pe: val?.pe ?? null, pb: val?.pb ?? null, totalMv: val?.totalMv ?? null }
}

/** 一行一只：指标全部是算好的数，叙事状态明确交由模型判断 */
export function candidateLineOf(row: CandidateRow): string {
  const tag = row.held ? '持仓' : '自选'
  if (row.close === null) return `- [${tag}] ${row.name}（${row.secid}）：—（未取到日线，无法计算指标）`
  return `- [${tag}] ${row.name}（${row.secid}）：现价 ${px(row.close)}（当日 ${pyi(row.chg1)}）；`
    + `动量 5日 ${pyi(row.chg5)} / 20日 ${pyi(row.chg20)} / 60日 ${pyi(row.chg60)}；`
    + `MA20 ${px(row.ma20)} / MA60 ${px(row.ma60)}（${row.maState ?? '—'}）；`
    + `RSI14 ${num(row.rsi14, 1)}；量比(5/20) ${num(row.volRatio)}；20日位置 ${row.pos20 === null ? '—' : `${row.pos20.toFixed(1)}%`}；`
    + `PE ${num(row.pe, 1)} / PB ${num(row.pb, 2)} / 总市值 ${mvYi(row.totalMv)}`
}

/**
 * 生成【候选池】整段。顺序 = 传入顺序（调用方：持仓按权重降序在前，自选按分组顺序在后），
 * 不做排序打分——排序本身就会变成隐性选股。
 */
export async function candidatesTextOf(candidates: readonly CandidateInput[], deps: CandidateDeps): Promise<string> {
  const list = candidates.slice(0, 80)
  let valuation: Record<string, CandidateValuation> = {}
  try { valuation = await deps.loadValuation(list.map((c) => c.secid)) } catch { valuation = {} }
  const rows: CandidateRow[] = []
  for (const c of list) {
    let bars: readonly DayBar[] | null = null
    try { bars = await deps.loadBars(c.secid) } catch { bars = null }
    rows.push(candidateRowOf(c, bars ?? [], valuation[c.secid]))
  }
  return [
    '【候选池（持仓 + 自选；指标由后端算好，叙事状态由你判断）】',
    '（买卖只能在候选池内选；指标不得自行编造。缺失写 —。叙事状态需结合新闻与骨架说明处在展望期还是兑现期）',
    ...rows.map(candidateLineOf),
  ].join('\n')
}
