/**
 * 指数技术面（信息面之外的另一条腿）：给模型一份**算好的**指标读数，避免它自己编。
 *
 * 覆盖（用户点名）：中证1000（小微盘）、中证2000（更小盘）、沪深300（蓝筹）、科创50（科技）、科创半导体ETF（国产 AI 硬件）。
 * 指标：收盘/当日涨跌、5/20/60 日动量、MA5/20/60 与多头排列、MACD(DIF/DEA/HIST)、RSI14、
 * 5/20 日均量比、20 日区间位置。全部由日线计算，缺数据写 —（不拿 0 顶替）。
 */
import type { DayBar } from '../shared/model.ts'

export interface IndexDef {
  name: string; secid: string; role: string
  /** 指数日线不可用时的代理（ETF），命中会在行内注明 */
  fallback?: { secid: string; note: string }
}

export const INDEX_DEFS: readonly IndexDef[] = [
  { name: '中证1000', secid: '1.000852', role: '小微盘' },
  { name: '中证2000', secid: '2.932000', role: '微盘', fallback: { secid: '1.563300', note: '中证2000ETF华泰柏瑞' } },
  { name: '沪深300', secid: '1.000300', role: '核心蓝筹' },
  { name: '科创50', secid: '1.000688', role: '科技' },
  { name: '科创半导体ETF', secid: '1.588170', role: '国产AI硬件' },
]

export interface IndexTech {
  name: string; secid: string; role: string
  /** 实际取数用的 secid（走代理时与 def.secid 不同） */
  source?: string
  bars: number
  close: number | null
  chg1: number | null; chg5: number | null; chg20: number | null; chg60: number | null
  ma5: number | null; ma20: number | null; ma60: number | null
  maState: '多头排列' | '空头排列' | '交织' | null
  dif: number | null; dea: number | null; hist: number | null
  macdState: '金叉' | '死叉' | null
  rsi14: number | null
  volRatio: number | null
  pos20: number | null
}

const round = (v: number, n = 2): number => Math.round(v * 10 ** n) / 10 ** n
const closesOf = (bars: readonly DayBar[]): number[] => bars.map((b) => b.close).filter((v) => Number.isFinite(v))
const sma = (values: readonly number[], period: number): number | null => {
  if (values.length < period) return null
  const slice = values.slice(-period)
  return slice.reduce((a, b) => a + b, 0) / period
}
const emaSeries = (values: readonly number[], period: number): number[] => {
  if (values.length === 0) return []
  const k = 2 / (period + 1)
  let prev = values[0] as number
  const out: number[] = [prev]
  for (let i = 1; i < values.length; i += 1) { prev = (values[i] as number) * k + prev * (1 - k); out.push(prev) }
  return out
}
const changeOf = (closes: readonly number[], n: number): number | null => {
  if (closes.length <= n) return null
  const last = closes[closes.length - 1] as number
  const prev = closes[closes.length - 1 - n] as number
  if (!Number.isFinite(prev) || prev === 0) return null
  return ((last - prev) / prev) * 100
}

/** RSI14（Wilder 平滑） */
export function rsiOf(closes: readonly number[], period = 14): number | null {
  if (closes.length <= period) return null
  let gain = 0; let loss = 0
  for (let i = 1; i <= period; i += 1) {
    const d = (closes[i] as number) - (closes[i - 1] as number)
    if (d >= 0) gain += d; else loss -= d
  }
  let avgGain = gain / period; let avgLoss = loss / period
  for (let i = period + 1; i < closes.length; i += 1) {
    const d = (closes[i] as number) - (closes[i - 1] as number)
    avgGain = (avgGain * (period - 1) + Math.max(0, d)) / period
    avgLoss = (avgLoss * (period - 1) + Math.max(0, -d)) / period
  }
  if (avgLoss === 0) return 100
  const rs = avgGain / avgLoss
  return 100 - 100 / (1 + rs)
}

export function techOf(def: IndexDef, bars: readonly DayBar[]): IndexTech {
  const closes = closesOf(bars)
  const vols = bars.map((b) => b.vol).filter((v): v is number => typeof v === 'number' && v > 0)
  const n = closes.length
  const last = n > 0 ? (closes[n - 1] as number) : null
  const ma5 = sma(closes, 5); const ma20 = sma(closes, 20); const ma60 = sma(closes, 60)
  const maState = ma5 === null || ma20 === null || ma60 === null
    ? null
    : ma5 > ma20 && ma20 > ma60 ? '多头排列' : ma5 < ma20 && ma20 < ma60 ? '空头排列' : '交织'
  // MACD(12,26,9)
  let dif: number | null = null; let dea: number | null = null; let hist: number | null = null
  let macdState: IndexTech['macdState'] = null
  if (n >= 35) {
    const e12 = emaSeries(closes, 12); const e26 = emaSeries(closes, 26)
    const difS = e12.map((v, i) => v - (e26[i] as number))
    const deaS = emaSeries(difS, 9)
    dif = difS[n - 1] as number
    dea = deaS[n - 1] as number
    hist = (dif - dea) * 2
    const prevDif = difS[n - 2] as number; const prevDea = deaS[n - 2] as number
    macdState = prevDif <= prevDea && dif > dea ? '金叉' : prevDif >= prevDea && dif < dea ? '死叉' : (dif > dea ? '金叉' : '死叉')
  }
  const v5 = vols.length >= 5 ? vols.slice(-5).reduce((a, b) => a + b, 0) / 5 : null
  const v20 = vols.length >= 20 ? vols.slice(-20).reduce((a, b) => a + b, 0) / 20 : null
  const volRatio = v5 !== null && v20 !== null && v20 > 0 ? v5 / v20 : null
  const recent20 = bars.slice(-20)
  const hi = recent20.length > 0 ? Math.max(...recent20.map((b) => b.high)) : null
  const lo = recent20.length > 0 ? Math.min(...recent20.map((b) => b.low)) : null
  const pos20 = last !== null && hi !== null && lo !== null && hi > lo ? ((last - lo) / (hi - lo)) * 100 : null
  return {
    name: def.name, secid: def.secid, role: def.role, bars: n,
    close: last,
    chg1: changeOf(closes, 1), chg5: changeOf(closes, 5), chg20: changeOf(closes, 20), chg60: changeOf(closes, 60),
    ma5, ma20, ma60, maState,
    dif: dif === null ? null : round(dif, 2), dea: dea === null ? null : round(dea, 2), hist: hist === null ? null : round(hist, 2), macdState,
    rsi14: (() => { const r = rsiOf(closes); return r === null ? null : round(r, 1) })(),
    volRatio: volRatio === null ? null : round(volRatio, 2),
    pos20: pos20 === null ? null : round(pos20, 1),
  }
}

const pct = (v: number | null): string => (v === null ? '—' : `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`)
const num = (v: number | null, n = 2): string => (v === null ? '—' : v.toFixed(n))
/** 价格按量级给小数位：指数 2 位，低价 ETF（<10）3 位 */
const px = (v: number | null): string => (v === null ? '—' : v < 10 ? v.toFixed(3) : v.toFixed(2))

/** 一行一只指数（缺数据写 — 并给原因，不编） */
export function indexTechLineOf(t: IndexTech, why?: string): string {
  if (t.close === null) return `- ${t.name}（${t.secid}，${t.role}）：—（${why ?? '未取到日线'}）`
  return `- ${t.name}（${t.secid}，${t.role}）：收 ${px(t.close)}（当日 ${pct(t.chg1)}）；动量 5日 ${pct(t.chg5)} / 20日 ${pct(t.chg20)} / 60日 ${pct(t.chg60)}；MA5 ${px(t.ma5)} / MA20 ${px(t.ma20)} / MA60 ${px(t.ma60)}（${t.maState ?? '—'}）；MACD DIF ${num(t.dif)} / DEA ${num(t.dea)} / 柱 ${num(t.hist)}（${t.macdState ?? '—'}）；RSI14 ${num(t.rsi14, 1)}；量比(5日均量/20日均量) ${num(t.volRatio)}；20日区间位置 ${t.pos20 === null ? '—' : `${t.pos20.toFixed(1)}%`}`
}

export interface IndexTechDeps {
  /** 取日线（返回 null = 上游无数据） */
  loadBars: (secid: string) => Promise<readonly DayBar[] | null>
}

/** 生成【指数技术面】整段；单只失败只影响它自己 */
export async function indexTechTextOf(deps: IndexTechDeps): Promise<string> {
  const lines: string[] = []
  // 串行取数：5 条并行会触发上游熔断（实测 3 台主机同时熔断），这里宁可慢 1-2 秒
  for (const def of INDEX_DEFS) {
    try {
      let bars = await deps.loadBars(def.secid)
      let via = def.secid
      if ((bars === null || bars.length === 0) && def.fallback !== undefined) {
        bars = await deps.loadBars(def.fallback.secid)
        via = def.fallback.secid
      }
      if (bars === null || bars.length === 0) { lines.push(indexTechLineOf(techOf(def, []), '未取到日线')); continue }
      const t = techOf(def, bars)
      const line = indexTechLineOf(t, undefined)
      lines.push(via === def.secid ? line : `${line}（数据源：${via} ${def.fallback?.note ?? ''} 代理；指数日线不可用）`)
    } catch (error) {
      lines.push(indexTechLineOf(techOf(def, []), `取数失败：${error instanceof Error ? error.message : String(error)}`))
    }
  }
  return ['【指数技术面（由本地日线计算；缺数据写 —）】', '（技术面只讲指标/量能/动量，不解读新闻——新闻统一由信息面分析）', ...lines].join('\n')
}
