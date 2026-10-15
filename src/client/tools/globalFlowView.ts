/**
 * 工具①「全球资金流蛋糕模型」的**视图映射**（纯函数，无 React 依赖 ⇒ 可直接断言）。
 *
 * 职责边界（这条边界就是可测性的来源）：
 *   · 宿主 `globalFlow.ts` 负责**口径与计算**（份额、动量排名、轮动、曲线、快照）；
 *   · 这里只负责**把载荷渲染成详情页模型**（数字格式化、缺数据 → 「未取到」+ 原因、回放取第几帧）；
 *   · 页面（`ToolsPage.tsx`）只渲染模型 —— 它不许自己算份额、不许自己造数。
 *
 * 回放：`step = 0` 永远是**最新一日**，`step` 越大越早（滑块左端 = 最新）。
 * 所有回放帧都在**同一份载荷**上本地计算 ⇒ 拖动滑块**不会**产生任何上游请求。
 */
import type { GlobalFlowMarketDto, GlobalFlowPayloadDto } from '../api.ts'
// ⚠ 占位文案从**叶子模块**拿，类型从注册表拿（type-only import 会被擦除）——
// 否则 `toolRegistry → tools/cake → tools/globalFlowView → toolRegistry` 会成环（实测 TDZ 报错）。
import { NOT_FETCHED } from '../toolText.ts'
import type { ToolBarRow, ToolCurveSeries, ToolData, ToolKpiDatum, ToolPayload, ToolPieSlice } from '../toolRegistry.ts'

/** 五个市场的画图配色：全部走主题 token（明暗两套都有定义，源码里不写死颜色） */
export const FLOW_SERIES_COLORS: readonly string[] = [
  'var(--tw-accent)',
  'var(--tw-chip-avg)',
  'var(--tw-chip-res)',
  'var(--tw-chip-sup)',
  'var(--tw-chip-profile)',
]

/** 规模（美元）：≥1 万亿用「万亿美元」，否则用「亿美元」 */
export function fmtUsd(n: number | null): string {
  if (n === null || !Number.isFinite(n)) return NOT_FETCHED
  const abs = Math.abs(n)
  if (abs >= 1e12) return `${(n / 1e12).toFixed(2)} 万亿美元`
  if (abs >= 1e8) return `${(n / 1e8).toFixed(2)} 亿美元`
  return `${Math.round(n).toLocaleString('en-US')} 美元`
}

/** 港元金额（亿港元）—— 港股行用 */
export function fmtHkdYi(n: number | null): string {
  if (n === null || !Number.isFinite(n)) return NOT_FETCHED
  return `${(n / 1e8).toFixed(2)} 亿港元`
}

/** 人民币金额（亿元）——A股单列那一栏用 */
export function fmtCnyYi(n: number | null): string {
  if (n === null || !Number.isFinite(n)) return NOT_FETCHED
  return `${(n / 1e8).toFixed(2)} 亿元`
}

/** 份额（百分点，0–100） */
export function fmtSharePct(n: number | null): string {
  if (n === null || !Number.isFinite(n)) return NOT_FETCHED
  return `${n.toFixed(2)}%`
}

/**
 * 悬停提示框的行模型（**唯一来源**）：值直接取自曲线序列，页面不另算一份。
 * 缺值 ⇒ `未取到`（**绝不写 0**：0.00% 会被读成"这个市场当时份额为零"）。
 */
export function hoverRowsOf(series: readonly ToolCurveSeries[], index: number | null): Array<{ name: string; text: string; value: number | null; swatch: number }> {
  if (index === null || index < 0) return []
  return series.map((s, i) => {
    const raw = s.points[index]
    const v = raw === undefined || raw === null || !Number.isFinite(raw) ? null : raw
    return { name: s.name, text: v === null ? `${NOT_FETCHED}` : fmtSharePct(v), value: v, swatch: i }
  })
}

/** 份额变化（百分点）：带符号 */
export function fmtPp(n: number | null): string {
  if (n === null || !Number.isFinite(n)) return NOT_FETCHED
  // |n| < 0.005 时四舍五入后是 0.00 ⇒ 归零，避免出现 `-0.00pp` 这种看起来像错值的负零（review §9.6）
  const v = Math.abs(n) < 0.005 ? 0 : n
  const sign = v > 0 ? '+' : v < 0 ? '-' : ''
  return `${sign}${Math.abs(v).toFixed(2)}pp`
}

/** 动量三口径：`+2.0% / +3.7% / +9.9%`；某口径样本不足 ⇒ `—`（不给 0） */
export function fmtMomentum(m: { d20: number | null; d60: number | null; d120: number | null } | null): string {
  if (m === null) return NOT_FETCHED
  const one = (v: number | null): string => {
    if (v === null || !Number.isFinite(v)) return '—'
    return `${v > 0 ? '+' : v < 0 ? '-' : ''}${Math.abs(v).toFixed(1)}%`
  }
  return `${one(m.d20)} / ${one(m.d60)} / ${one(m.d120)}`
}

/** 偏好分：`0.71`（0–1，两位小数）；缺 ⇒ 「未取到」 */
export function fmtPref(pref: number | null | undefined): string {
  if (pref === undefined || pref === null || !Number.isFinite(pref)) return NOT_FETCHED
  return pref.toFixed(2)
}

/** 排名：`1 / 5`（分母 = 能算出排名的市场数） */
export function fmtRank(rank: number | null, total: number): string {
  if (rank === null || !Number.isFinite(rank)) return NOT_FETCHED
  return `${rank} / ${total}`
}

/** 北京时间文本（含日期）；宿主给的是 epoch ms */
export function fmtBeijing(ts: number | null, day?: string): string {
  if (ts === null || !Number.isFinite(ts)) return NOT_FETCHED
  // 用 Intl 按 Asia/Shanghai 取时刻（与宿主 time.ts 同一时区口径）
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(new Date(ts))
  const get = (t: string): string => parts.find((x) => x.type === t)?.value ?? ''
  const hh = get('hour') === '24' ? '00' : get('hour')
  const stamp = `${get('year')}-${get('month')}-${get('day')} ${hh}:${get('minute')}`
  return day === undefined || day === `${get('year')}-${get('month')}-${get('day')}` ? stamp : `${stamp}（数据日 ${day}）`
}

/** 曲线索引：`step`（0 = 最新）→ points 下标 */
export function pointIndexAt(points: number, step: number): number {
  const idx = points - 1 - Math.max(0, Math.round(step))
  return idx < 0 ? 0 : idx
}

/** 某一步的饼图（份额为 null 的市场**不进饼图**，并在说明里给原因） */
export function pieSlicesAt(payload: GlobalFlowPayloadDto, step: number): { slices: ToolPieSlice[]; center: string | null; note: string | null } {
  const idx = pointIndexAt(payload.curve.points.length, step)
  const point = payload.curve.points[idx]
  if (point === undefined) return { slices: [], center: null, note: `${NOT_FETCHED}：曲线本次没有可用数据点` }
  const slices: ToolPieSlice[] = []
  for (let i = 0; i < payload.markets.length; i += 1) {
    const share = point.share[i]
    if (share === null || !Number.isFinite(share) || share <= 0) continue
    slices.push({ label: payload.markets[i].name, text: `${(share * 100).toFixed(2)}%`, value: share * 100, index: i })
  }
  const dropped = payload.markets.filter((_, i) => point.share[i] === null).map((m) => m.name)
  const note = dropped.length === 0
    ? null
    : `${dropped.join('、')} 当日没有美元规模 ⇒ 不进饼图、也不进份额分母（分母只含有值市场，因此剩余各块合计仍为 100%）；逐行原因见市场表下方说明`
  return { slices, center: point.day, note }
}

/**
 * 近 5 个序列日的份额变化（百分点）。
 *
 * 两个来源，**同一口径**：最新交易日用宿主算好的 `delta5Pp`；回放历史日由曲线的两个点现算
 * （同一份载荷、同一段序列，不引入新数字）。序列不足 5 个点 ⇒ `null`（如实说"判不了"，不写 0）。
 */
function delta5Of(payload: GlobalFlowPayloadDto, idx: number, i: number, isLatest: boolean): number | null {
  const m = payload.markets[i]
  if (isLatest && m.delta5Pp !== null && Number.isFinite(m.delta5Pp)) return m.delta5Pp
  const cur = payload.curve.points[idx]?.share[i]
  const prev = idx >= 5 ? payload.curve.points[idx - 5]?.share[i] : null
  if (cur === null || cur === undefined || prev === null || prev === undefined) return null
  return (cur - prev) * 100
}

/**
 * 市场**横条行**（用户口径：五行横条，不是八列表格）。
 *
 * 表格里原来的诚实信息（规模 / 偏好分 / 动量 / 横截面排名）全部进 `detail`（悬停 + 行内小字可读）；
 * 缺数据的行仍有 `note`（`未取到` + 原因）。条长 = 当前相对份额（百分点）。
 */
export function flowBarsAt(payload: GlobalFlowPayloadDto, step: number, isLatest: boolean): ToolBarRow[] {
  const idx = pointIndexAt(payload.curve.points.length, step)
  const point = payload.curve.points[idx]
  const rankedTotal = payload.markets.filter((m) => m.rank !== null).length
  const shares = payload.markets.map((_, i) => point?.share[i] ?? null)
  const maxShare = shares.reduce<number | null>((best, v) => (v === null ? best : best === null || v > best ? v : best), null)
  return payload.markets.map((m, i) => {
    const share = shares[i]
    const aumUsd = point?.aumUsd[i] ?? null
    const aumNative = nativeAtDay(payload, idx, i, aumUsd)
    const d = delta5Of(payload, idx, i, isLatest)
    const deltaKind: ToolBarRow['deltaKind'] = d === null ? 'unknown' : Math.abs(d) < 0.05 ? 'flat' : d > 0 ? 'warm' : 'cool'
    const deltaText = d === null
      ? '近5日变化未取到（序列不足 5 个交易日 ⇒ 判不了）'
      : `${deltaKind === 'flat' ? '持平' : deltaKind === 'warm' ? '升温' : '降温'} ${fmtPp(d)} 个百分点`
    return {
      name: m.name,
      shareText: fmtSharePct(share === null ? null : share * 100),
      sharePct: share === null ? null : share * 100,
      top: share !== null && maxShare !== null && share === maxShare,
      deltaText,
      deltaKind,
      // 规模 / 偏好分 / 动量 / 排名 —— 一个都不许丢（回放日如实写「不适用（回放日）」）
      detail: `规模 ${fmtSizeCell(m.currency, aumNative, aumUsd, rateOf(payload, m.currency))}｜偏好分 ${fmtPref(m.pref)}｜动量 ${isLatest ? fmtMomentum(m.momentum) : '不适用（回放日）'}｜横截面排名 ${isLatest ? fmtRank(m.rank, rankedTotal === 0 ? payload.markets.length : rankedTotal) : '不适用（回放日）'}`,
      note: rowReasonOf(m, aumNative, aumUsd),
    }
  })
}

/** 某一步的市场表（份额 + 变化；缺数据 → 「未取到」+ 该行的原因说明） */
export function marketRowsAt(payload: GlobalFlowPayloadDto, step: number, isLatest: boolean): { rows: string[][]; rowNotes: Array<string | null> } {
  const idx = pointIndexAt(payload.curve.points.length, step)
  const point = payload.curve.points[idx]
  const prev = idx > 0 ? payload.curve.points[idx - 1] : null
  const rankedTotal = payload.markets.filter((m) => m.rank !== null).length
  const rows: string[][] = []
  const rowNotes: Array<string | null> = []
  for (let i = 0; i < payload.markets.length; i += 1) {
    const m = payload.markets[i]
    const share = point?.share[i] ?? null
    const aumUsd = point?.aumUsd[i] ?? null
    const dPp = share !== null && prev !== null && prev.share[i] !== null ? (share - (prev.share[i] as number)) * 100 : null
    // 当前显示那一日的**原币**规模（历史日按"该日美元规模 × 汇率折算回去"，只对人民币市场做）
    const aumNative = nativeAtDay(payload, idx, i, aumUsd)
    rows.push([
      m.name,
      m.etf,
      fmtSizeCell(m.currency, aumNative, aumUsd, rateOf(payload, m.currency)),
      fmtSharePct(share === null ? null : share * 100),
      fmtPref(m.pref),
      fmtPp(dPp),
      // 动量/排名只反映**最新交易日**：回放到历史日时如实标"不适用"，不重算（上游只留当下的横截面）
      isLatest ? fmtMomentum(m.momentum) : '不适用（回放日）',
      isLatest ? fmtRank(m.rank, rankedTotal === 0 ? payload.markets.length : rankedTotal) : '不适用（回放日）',
    ])
    rowNotes.push(rowReasonOf(m, aumNative, aumUsd))
  }
  return { rows, rowNotes }
}

/**
 * 当前显示那一日的**原币**规模。
 *
 * 默认取载荷里的当期原币值（`markets[].aumNative`，只有最新一日有）；
 * 回放历史日时，对人民币市场按"该日美元规模 × 当日汇率"折回去 —— 这是**重建值**，
 * 只用来把"人民币口径"显示出来（错也错在与当日美元规模同源），不参与任何份额计算。
 */
export function nativeAtDay(payload: GlobalFlowPayloadDto, idx: number, marketIndex: number, aumUsd: number | null): number | null {
  const m = payload.markets[marketIndex]
  const isLatestPoint = idx === payload.curve.points.length - 1
  if (m === undefined) return null
  // ⚠ 最新一日先看载荷里的原币值：**汇率缺时美元值是 null，但原币值仍在** ——
  // 顺序反过来会让"缺汇率"的行连原币都显示不出来、行级原因也无从触发（AUDIT-IMPL47 §3）
  if (isLatestPoint && m.aumNative !== null) return m.aumNative
  if (aumUsd === null) return null
  if (m.currency === 'USD') return aumUsd
  const rate = m.currency === 'CNY' ? payload.fx.usdCny : payload.fx.usdHkd
  return rate === null || rate <= 0 ? null : aumUsd * rate
}

/** 该币种对应的汇率（美/日/韩 用美元 ETF ⇒ 不需要） */
export function rateOf(payload: GlobalFlowPayloadDto, currency: 'USD' | 'CNY' | 'HKD'): number | null {
  if (currency === 'USD') return null
  return currency === 'CNY' ? payload.fx.usdCny : payload.fx.usdHkd
}

/** 币种的中文名（行级原因与单元格用） */
export function currencyLabel(currency: 'USD' | 'CNY' | 'HKD'): string {
  return currency === 'CNY' ? '人民币' : currency === 'HKD' ? '港元' : '美元'
}

/**
 * 规模单元格：**原币值必须在界面上可见**（A股 是人民币，不许只剩"折美元后的份额"）。
 *   · 美元市场：`8222.73 亿美元`
 *   · 人民币市场：`1063.50 亿元 ≈ 158.87 亿美元`；汇率缺 ⇒ `1063.50 亿元（汇率未取到，未折算）`
 *   · 没有值 ⇒ `未取到`（原因在行下）
 */
export function fmtSizeCell(currency: 'USD' | 'CNY' | 'HKD', aumNative: number | null, aumUsd: number | null, fx: number | null): string {
  if (aumNative === null && aumUsd === null) return NOT_FETCHED
  if (currency === 'USD') return aumNative === null ? fmtUsd(aumUsd) : fmtUsd(aumNative)
  const native = currency === 'CNY' ? fmtCnyYi(aumNative) : fmtHkdYi(aumNative)
  if (aumUsd === null) return fx === null ? `${native}（汇率未取到，未折算）` : `${native}（未折算）`
  return `${native} ≈ ${fmtUsd(aumUsd)}`
}

/**
 * 行级原因（渲染层必须消费：原因只在载荷 missing[] 里等于没给用户）。
 * 优先级：该市场自己的缺口 > 人民币市场"汇率缺 ⇒ 不折算"这条口径不一致。
 */
export function rowReasonOf(m: Pick<GlobalFlowMarketDto, 'currency' | 'name' | 'missing'>, aumNative: number | null, aumUsd: number | null): string | null {
  if (m.missing !== null && m.missing !== '') return m.missing
  if (m.currency !== 'USD' && aumNative !== null && aumUsd === null) {
    const native = m.currency === 'CNY' ? fmtCnyYi(aumNative) : fmtHkdYi(aumNative)
    const pair = m.currency === 'CNY' ? '美元/人民币（新浪 fx_susdcny）' : '美元/港元（新浪 fx_susdhkd）'
    return `${m.name} 规模 ${native}（${currencyLabel(m.currency)}）已取到，但本次汇率 ${pair} 未取到 ⇒ 这一行的"规模（美元）"不折算（其余照常）；偏好份额不受影响：权重来自无量纲的偏好分，与汇率无关`
  }
  return null
}

/** 汇率摘要（两条各自显示；缺的那条如实写"未取到"） */
export function rateSummary(payload: GlobalFlowPayloadDto): string {
  const one = (v: number | null, label: string): string => (v === null ? `${label} 未取到` : `${label} ${v.toFixed(4)}`)
  const needCny = payload.markets.some((m) => m.currency === 'CNY' && m.aumUsd !== null)
  const needHkd = payload.markets.some((m) => m.currency === 'HKD' && m.aumUsd !== null)
  const parts: string[] = []
  if (needCny) parts.push(one(payload.fx.usdCny, '美元/人民币'))
  if (needHkd) parts.push(one(payload.fx.usdHkd, '美元/港元'))
  if (parts.length === 0) parts.push('本屏不需要汇率（美/日/韩 用美元计价 ETF）')
  return `汇率：${parts.join('、')}`
}

/**
 * 完整视图模型（页面只渲染它）。
 *
 * `rangeDays` = 曲线窗口（90 / 180 / 365 个序列日，见宿主 `FLOW_CURVE_WINDOWS`）：
 * 只在这里**从同一条曲线上切片**（宿主一次构建到最大档）⇒ 切档不发请求、不重算份额。
 */
/**
 * 两处**自定口径**（用户给的模型概念原文里没有公式；参考版公式未公开 ⇒ 我们自定并写明，
 * 绝不声称与参考版数值可比）。两处都是**纯函数**，注释里的公式就是报告与界面悬停引用同一份。
 *
 * 概念原文：「把全球风险资金看成一块蛋糕……用美元与美国 10 年期国债收益率判断全球流动性压力是否已经传导。」
 */

/** 蛋糕温度的状态词阈值（写进悬停） */
export const TEMP_HOT = 70
export const TEMP_COLD = 30

/**
 * **蛋糕温度**（自定口径）= 五个市场**偏好分**（0–1）的均值 × 100，0–100。
 *
 * - 与"权重用的偏好分"**同一份**（55% × 各自 60 日区间分位 + 30% × 5 日动量分位 + 15% × 20 日动量分位）
 *   ⇒ 不另算一份（断言锁这条）。
 * - 只对有值的市场求均值；一个都没有 ⇒ `null`（不写 0）。
 * - 状态词：≥ 70 偏热 / ≤ 30 偏冷 / 其间平衡（阈值 `TEMP_HOT`/`TEMP_COLD`）。
 * - **不是**参考版的数值：它的公式未公开，两者不可比。
 */
export function cakeTemperature(prefs: ReadonlyArray<number | null>): number | null {
  const vals = prefs.filter((p): p is number => p !== null && Number.isFinite(p))
  if (vals.length === 0) return null
  return (vals.reduce((a, b) => a + b, 0) / vals.length) * 100
}

/** 蛋糕温度的状态词（唯一实现；阈值同上） */
export function temperatureLabel(temp: number | null): string | null {
  if (temp === null || !Number.isFinite(temp)) return null
  return temp >= TEMP_HOT ? '偏热' : temp <= TEMP_COLD ? '偏冷' : '平衡'
}

/** 流动性支持度的口径常量（写进悬停：变化量取 5 日，样本不足退化为当日） */
export const LIQ_SCALE = { dxy: 1.5, us10yPp: 0.25 } as const
export const LIQ_CHANGE_SPAN = 5

/**
 * **流动性支持度**（自定口径，0–10，越高越"支持"＝压力越小）。
 *
 * 公式（唯一实现）：
 *   `支持度 = 5 − 2.5 × ( clamp(Δ美元指数 / 1.5, −1, 1) + clamp(Δ美债10Y(pp) / 0.25, −1, 1) )`
 *
 * - 输入 = 广义美元指数与美国 10Y 的**近期变化**：默认取 **5 个采样交易日**的变化；
 *   自采样不足 5 条 ⇒ 退化为 **1 个交易日**（退化这件事在悬停里写明，不静默）。
 * - 方向：美元走强 / 美债收益率上行 = 全球流动性压力上升 ⇒ 支持度下降；两者都走弱 ⇒ 支持度上升。
 * - 任一侧变化取不到 ⇒ `null`（不写 0、不用单侧冒充双侧）。
 * - **自定口径：与参考版不可比**（其公式未公开）。
 */
export function liquiditySupport(input: {
  dxyChange: number | null
  us10yChangePp: number | null
  span: number
}): { score: number; span: number } | null {
  const { dxyChange, us10yChangePp, span } = input
  if (dxyChange === null || us10yChangePp === null) return null
  if (!Number.isFinite(dxyChange) || !Number.isFinite(us10yChangePp)) return null
  const clamp = (x: number): number => Math.max(-1, Math.min(1, x))
  const score = 5 - 2.5 * (clamp(dxyChange / LIQ_SCALE.dxy) + clamp(us10yChangePp / LIQ_SCALE.us10yPp))
  return { score: Math.max(0, Math.min(10, score)), span }
}

/** 压力是否已传导（自定判定规则；写进悬停） */
export type StressVerdict = '传导' | '未传导' | '数据不足'

/**
 * **压力是否已传导**（自定判定）：美元与美债**同步走强**（压力上升）**且**蛋糕温度**同期下降**
 * ⇒ 「压力已传导」；两者都能算但不同时满足 ⇒ 「暂未传导」；任一输入缺 ⇒ 「数据不足」+ 原因。
 */
export function stressVerdict(input: {
  dxyChange: number | null
  us10yChangePp: number | null
  tempChange: number | null
}): { verdict: StressVerdict; why: string | null } {
  const { dxyChange, us10yChangePp, tempChange } = input
  if (dxyChange === null || us10yChangePp === null) return { verdict: '数据不足', why: '美元指数或美债 10Y 的近期变化未取到（自采样不足）' }
  if (tempChange === null) return { verdict: '数据不足', why: '蛋糕温度的同期变化未取到（曲线序列不足）' }
  const stressUp = dxyChange > 0 && us10yChangePp > 0
  const tempDown = tempChange < 0
  return stressUp && tempDown
    ? { verdict: '传导', why: null }
    : { verdict: '未传导', why: null }
}

/**
 * 四个宏观 KPI 磁贴（用户口径 v0.86.0）。
 *
 * - **蛋糕温度**：五市场偏好分均值 × 100（与权重同源；见 `cakeTemperature`）
 * - **流动性支持度**：美元指数 + 美债 10Y 的近期变化合成 0–10（见 `liquiditySupport`），并给「压力是否已传导」
 * - **美国 10Y / 广义美元指数**：真实读数（新浪），**24 小时品种**（不套 A 股休市冻结）
 *
 * 四块都：`较上日` delta、来源与口径进 `source`（页面渲染成 title/aria-label）、缺数据 ⇒ 「未取到」+ 原因。
 */
function macroTiles(payload: GlobalFlowPayloadDto, idx: number, points: Array<GlobalFlowPayloadDto['curve']['points'][number]>): Record<string, ToolKpiDatum> {
  const out: Record<string, ToolKpiDatum> = {}
  const nullTile = (why: string): ToolKpiDatum => ({ text: NOT_FETCHED, value: null, delta: why, swatch: null, source: why })

  // ── 蛋糕温度（自定口径，与权重同源）──────────────────────────────────────────────
  const tempAt = (i: number): number | null => {
    const p = points[i]
    if (p === undefined) return null
    return cakeTemperature(payload.markets.map((_, m) => p.pref?.[m] ?? null))
  }
  const temp = tempAt(idx)
  const tempPrev = idx + 1 < points.length ? tempAt(idx + 1) : null
  const tempLabel = temperatureLabel(temp)
  const tempSource = `自定口径：蛋糕温度 = 五市场偏好分均值 × 100（偏好分 = 55% × 各自 60 日区间分位 + 30% × 5 日动量分位 + 15% × 20 日动量分位，与权重同源）；状态词：≥${TEMP_HOT} 偏热 / ≤${TEMP_COLD} 偏冷 / 其间平衡；与参考版不可比（其公式未公开）`
  out['蛋糕温度'] = temp === null
    ? nullTile(`未取到：这一天五个市场都算不出偏好分（样本不足或日线缺失）⇒ 温度无从谈起（不用 0 顶替）`)
    : {
        text: `${temp.toFixed(0)}（${tempLabel}）`,
        value: temp,
        delta: tempPrev === null ? `较上日 —（曲线序列不足两步）` : `较上日 ${temp - tempPrev >= 0 ? '+' : ''}${(temp - tempPrev).toFixed(1)}`,
        swatch: null,
        source: tempSource,
      }

  // ── 宏观两档（真实读数）──────────────────────────────────────────────────────────
  const macro = payload.macro ?? null
  const us = macro?.us10y ?? null
  const dxy = macro?.dxy ?? null
  /**
   * 载荷里**根本没有 `macro` 字段** ⇒ 宿主模块比客户端旧（宿主插件还没重载）：
   * 这时给出的原因必须可操作，不能含糊成"上游失败"（现场诊断：真机曾整块缺字段）。
   */
  const noField = '宿主载荷里没有宏观两档字段（宿主插件尚未重载到本版）⇒ 稍后重试或重载宿主插件；此刻不显示数值，也不用 0 顶替'
  const usWhy = macro === null ? noField : (macro.notes.find((n) => n.what.includes('10 年期'))?.note ?? '本次没有取到美国 10 年期国债收益率的现值')
  const dxyWhy = macro === null ? noField : (macro.notes.find((n) => n.what.includes('美元指数'))?.note ?? '本次没有取到广义美元指数的现值')

  const changeOf = (point: { value: number; history: number[] }, span: number): { change: number | null; span: number } => {
    const h = point.history ?? []
    if (h.length >= span) return { change: point.value - (h[h.length - span] as number), span }
    if (h.length >= 1) return { change: point.value - (h[h.length - 1] as number), span: 1 }
    return { change: null, span: 0 }
  }
  const usCh = us === null ? null : changeOf(us, LIQ_CHANGE_SPAN)
  const dxyCh = dxy === null ? null : changeOf(dxy, LIQ_CHANGE_SPAN)
  const usPrevDay = us === null ? null : changeOf({ value: us.history[us.history.length - 1] ?? us.value, history: us.history.slice(0, -1) }, LIQ_CHANGE_SPAN)
  const dxyPrevDay = dxy === null ? null : changeOf({ value: dxy.history[dxy.history.length - 1] ?? dxy.value, history: dxy.history.slice(0, -1) }, LIQ_CHANGE_SPAN)

  const spanNote = (span: number): string => (span >= LIQ_CHANGE_SPAN ? `${LIQ_CHANGE_SPAN} 个采样交易日` : span === 1 ? '当日变化（自采样不足 5 条 ⇒ 已退化为 1 日，不静默）' : '无变化可算')

  out['美国十年期国债收益率'] = us === null
    ? nullTile(`未取到：${usWhy}`)
    : {
        text: `${us.value.toFixed(3)}%`,
        value: us.value,
        delta: usCh === null || usCh.change === null ? `较上日 —（自采样不足一条）` : `较上日 ${usCh.change >= 0 ? '+' : ''}${(usCh.change * 100).toFixed(1)}bp（${spanNote(usCh.span)}）`,
        swatch: null,
        source: `${us.source}｜口径：24 小时品种，不套 A 股休市冻结（任何时刻都给最新真实读数）｜自采样 ${us.samples} 条｜交叉核对：${us.crossCheck ?? '未做'}｜变化量口径：自采样（不用来源不明的"昨收"字段）`,
      }
  out['广义美元指数'] = dxy === null
    ? nullTile(`未取到：${dxyWhy}`)
    : {
        text: dxy.value.toFixed(2),
        value: dxy.value,
        delta: dxyCh === null || dxyCh.change === null ? `较上日 —（自采样不足一条）` : `较上日 ${dxyCh.change >= 0 ? '+' : ''}${dxyCh.change.toFixed(2)}（${spanNote(dxyCh.span)}）`,
        swatch: null,
        source: `${dxy.source}｜口径：24 小时品种，不套 A 股休市冻结｜自采样 ${dxy.samples} 条｜交叉核对：${dxy.crossCheck ?? '未做'}｜变化量口径：自采样（不用来源不明的"昨收"字段）`,
      }

  // ── 流动性支持度（自定口径）+ 压力是否已传导 ─────────────────────────────────────
  const support = usCh === null || dxyCh === null
    ? null
    : liquiditySupport({
        dxyChange: dxyCh.change,
        us10yChangePp: usCh.change,
        span: Math.min(dxyCh.span, usCh.span),
      })
  const supportPrev = usPrevDay === null || dxyPrevDay === null
    ? null
    : liquiditySupport({ dxyChange: dxyPrevDay.change, us10yChangePp: usPrevDay.change, span: Math.min(usPrevDay.span, dxyPrevDay.span) })
  const tempChange = temp !== null && idx + LIQ_CHANGE_SPAN < points.length ? temp - (tempAt(idx + LIQ_CHANGE_SPAN) as number) : null
  const verdict = stressVerdict({
    dxyChange: dxyCh?.change ?? null,
    us10yChangePp: usCh?.change ?? null,
    tempChange,
  })
  const liqSource = `自定口径：流动性支持度 = 5 − 2.5 ×（clamp(Δ美元指数 / ${LIQ_SCALE.dxy}, −1, 1) + clamp(Δ美债10Y / ${LIQ_SCALE.us10yPp}pp, −1, 1)），0–10 越高越支持（压力越小）；变化量取 ${LIQ_CHANGE_SPAN} 个采样交易日、不足则退化为当日；输入=广义美元指数与美债 10Y 的变化方向；与参考版不可比（其公式未公开）｜压力是否已传导：美元与美债同步走强且蛋糕温度同期下降 ⇒ 传导，否则暂未传导，输入缺 ⇒ 数据不足`
  out['流动性支持度'] = support === null
    ? nullTile(`未取到：${us === null ? usWhy : dxy === null ? dxyWhy : '美元指数或美债 10Y 的自采样历史不足一条 ⇒ 变化量算不出（不用 0 顶替）'}`)
    : {
        text: `${support.score.toFixed(1)}（压力${verdict.verdict === '传导' ? '已传导' : verdict.verdict === '未传导' ? '暂未传导' : '数据不足'}）`,
        value: support.score,
        delta: supportPrev === null ? '较上日 —（自采样不足两条）' : `较上日 ${support.score - supportPrev.score >= 0 ? '+' : ''}${(support.score - supportPrev.score).toFixed(1)}`,
        swatch: null,
        source: liqSource + (verdict.why === null ? '' : `｜本次判定：数据不足（${verdict.why}）`),
      }
  return out
}

export function globalFlowToolData(payload: GlobalFlowPayloadDto, step = 0, rangeDays?: number): ToolData {
  const all = payload.curve.points
  const range = rangeDays === undefined ? all.length : Math.max(0, Math.round(rangeDays))
  // 切片 = 最近 `range` 个序列日（曲线的最后一天是最新一天）
  const points = range > 0 && range < all.length ? all.slice(all.length - range) : all
  // 切片后**所有按天的计算都走切片视图**（回放步、合计、饼图、市场表），否则会拿全窗口的份额去凑合计
  const view: GlobalFlowPayloadDto = points === all ? payload : { ...payload, curve: { ...payload.curve, points } }
  const isLatest = step === 0
  const pie = pieSlicesAt(view, step)
  const market = marketRowsAt(view, step, isLatest)
  const idx = pointIndexAt(points.length, step)
  const point = points[idx]
  // ⚠ 合计/榜首一律取**当前显示那一天**的份额（回放历史日时不能拿"今天"的份额去凑合计）
  const shownShares = point?.share.map((v) => (v === null ? null : v * 100)) ?? payload.markets.map(() => null)
  const liveIdx = shownShares.map((v, i) => (v === null ? -1 : i)).filter((i) => i >= 0)
  const top = liveIdx.length === 0 ? null : payload.markets[liveIdx.reduce((best, i) => ((shownShares[i] as number) > (shownShares[best] as number) ? i : best), liveIdx[0])]
  const topShare = top === null ? null : shownShares[payload.markets.indexOf(top)]
  const live = payload.markets.filter((_, i) => shownShares[i] !== null)
  const allMissing = live.length === 0
  const why = allMissing ? (payload.missing[0]?.note ?? '本次没有取到任何一个市场的规模') : null

  // ── 状态行：**常驻只留必要事实**（数据时刻 + 降级/陈旧标记）────────────────────────────────
  // 用户口径（v0.81.0）：图上那几行长说明太啰嗦 ⇒ 常驻只留"数据时刻"和"这一屏有没有降级"，
  // 取数方式、曲线构成等细节全部进 `title`/`aria-label`（`statusDetail`）。**诚实性不许降级**：
  // 凡是"数据不是实时/来自快照/上游全失败/有作废留痕"这类会误导读数的信息，一律留在常驻行里。
  const purged = payload.snapshot.purged ?? []
  const degrade = payload.source === 'snapshot'
    ? `快照只读（累积 ${payload.snapshot.days} 天）`
    : payload.source === 'fallback'
      ? `⚠ 上游全部失败 ⇒ 快照回退${payload.fallbackDay === null ? '' : `（${payload.fallbackDay}）`}，不是实时值`
      : allMissing
        ? '⚠ 上游本次全部失败，且本地还没有任何快照 ⇒ 这一屏没有数据（逐行原因见下）'
        : null
  /**
   * 「另有 N 天旧口径快照已作废」：**不再常驻**（用户口径：一次性迁移说明不该占常驻行）。
   * 事实不消失 ⇒ 只在状态行的 `title`/`aria-label`（`statusDetail`）里保留，见下面的 `purgeMark`。
   */
  const purgeMark = purged.length === 0
    ? null
    : `⚠ 另有 ${purged.length} 天旧口径快照已作废（成分变更；留痕见快照文件，如 ${purged[purged.length - 1].day}）`
  const status = [
    `数据时刻 ${fmtBeijing(payload.asOf, payload.day)}（北京时间）`,
    degrade,
  ].filter((x): x is string => x !== null).join('｜')
  // 细节（进 title/aria-label；缺数据时它就是原因）
  const statusDetail = [
    payload.source === 'snapshot'
      ? `本次只读本地快照（不发上游请求）；快照已累积 ${payload.snapshot.days} 天`
      : payload.source === 'fallback'
        ? `本次上游全部失败 ⇒ 下表与曲线来自最近一次本地快照${payload.fallbackDay === null ? '' : `（${payload.fallbackDay}）`}，不是实时值`
        : allMissing
          ? '上游本次全部失败，且本地还没有任何快照 ⇒ 这一屏没有数据（逐行原因见市场表下方）'
          : '上游现取（宿主三层 TTL：现价类 30 分钟 / 日线 12 小时 / 载荷 10 分钟）',
    `曲线 ${points.length} 个序列日（实测 ${points.filter((p) => p.origin === 'observed').length} / 重建 ${points.filter((p) => p.origin === 'rebuilt').length}）`,
    `窗口 ${points.length} / 可选 ${(payload.curve.windowOptions ?? [payload.curve.window]).join(' / ')} 个序列日`,
    // 旧四块（偏好榜首 / 五市场合计规模 / 近五日轮动 / 数据时刻）**不丢**：磁贴让位给宏观四块后，它们搬到这里
    `旧四块（保留）：偏好榜首 ${top === null ? NOT_FETCHED : `${top.name} ${fmtSharePct(topShare)}`}｜五市场合计规模 ${fmtUsd(payload.totalUsd)}｜近五日轮动 ${payload.rotation.text}｜数据时刻 ${fmtBeijing(payload.asOf, payload.day)}`,
    ...(purged.length === 0 ? [] : [purgeMark as string]),
  ].join('｜')

  return {
    status,
    statusDetail,
    why,
    chartAsOf: point?.day ?? payload.day,
    rangeDays: points.length,
    rangeOptions: payload.curve.windowOptions ?? [payload.curve.window],
    summary: [
      // 摘要卡 ①「资金蛋糕」：值 = 五市场合计规模（真实）；状态词 = 份额集中度（由真实份额导出，不是编造的"温度"）
      {
        key: 'cake',
        label: '资金蛋糕',
        value: fmtUsd(payload.totalUsd),
        // 值 = 五市场合计规模（事实展示）；状态词 = **偏好份额**榜首（权重口径，不是规模占比）
        // 常驻只留短句（用户口径：「规模只作展示，不进权重」不占常驻行）⇒ 该事实进 noteTitle（悬停/读屏）
        note: live.length === 0 ? `${NOT_FETCHED}：没有有值市场` : top === null ? null : `偏好份额榜首 ${top.name} ${fmtSharePct(topShare)}`,
        noteTitle: live.length === 0
          ? `${NOT_FETCHED}：这一天没有一个市场拿到规模 ⇒ 合计无从谈起`
          : `值 = 五市场合计规模（事实展示，美元计价）；规模只作展示，不进权重 —— 权重用的是偏好分（55% × 各自 60 日区间分位 + 30% × 5 日动量分位 + 15% × 20 日动量分位）；「蛋糕温度」与「流动性支持度」是我们自定的公式（参考版未公开口径），与参考版数值不可比`,
      },
      // 摘要卡 ②「当前偏好」：值 = 份额榜首（真实，取当前显示那天）
      {
        key: 'prefer',
        label: '当前偏好',
        value: top?.name ?? NOT_FETCHED,
        note: isLatest ? payload.rotation.text : '（回放历史日：显示那一天的份额榜首）',
      },
    ],
    notes: {
      kpi: payload.notes.kpi,
      curve: payload.notes.curve,
      // 饼图的口径行 = 载荷口径 + "谁没进饼图"（缺市场的说明必须出现在**这一区**，
      // 否则会被载荷口径盖掉，读者只能从表里猜为什么少了一块）
      pie: pie.note === null ? payload.notes.pie : `${payload.notes.pie}；${pie.note}`,
      market: payload.notes.market,
      boundary: payload.notes.boundary,
    },
    kpi: {
      // 宏观四块（用户口径 v0.86.0）：蛋糕温度 / 流动性支持度 / 美国 10Y / 广义美元指数。
      // 旧四块（偏好榜首 / 五市场合计规模 / 近五日轮动 / 数据时刻）**不丢**：搬进 `statusDetail`（状态行悬停）。
      // 色标：四块都不对应某一条曲线序列 ⇒ 一律中性色标（不拿某个市场的颜色冒充）。
      ...macroTiles(payload, idx, points),
    },
    curve: {
      days: points.map((p) => p.day),
      // 曲线的点为零 ⇒ 序列也为零（"没有点"就是"没有曲线"，不要给出五条空序列让页面自己判空）
      series: points.length === 0
        ? []
        : payload.markets.map((m, i) => ({
            name: m.name,
            points: points.map((p) => (p.share[i] === null ? null : (p.share[i] as number) * 100)),
          })),
      marks: points.map((p, i) => (p.origin === 'observed' ? { index: i, label: `${p.day} 实测` } : null)).filter((x): x is { index: number; label: string } => x !== null),
    },
    pie: { slices: pie.slices, center: pie.center, note: pie.note },
    market: {
      rows: market.rows,
      rowNotes: market.rowNotes,
      bars: flowBarsAt(view, step, isLatest),
      footnotes: [
        // ⚠ 分母里一个市场都没有值（整轮全缺）时**不许给 0.00%**：那是"把没有值求和成 0"，
        // 正是红线禁止的 0 顶替（v0.73.0 修，对照见 AUDIT-IMPL46 §1）
        live.length === 0
          ? `${NOT_FETCHED}：这一天没有一个市场拿到规模 ⇒ 份额合计无从谈起（分母里没有有值市场）；缺口原因见下面每一行`
          : `份额合计 = ${fmtSharePct(shownShares.reduce((sum: number, v) => sum + (v ?? 0), 0))}（分母只含这一天有值的 ${live.length} 个市场）`,
        isLatest ? '动量列 = 20 / 60 / 120 日收益率（各市场自己的交易日；样本不足显示 —，不用 0）' : '回放历史日时不给动量与排名（上游只保留当下的横截面）',
      ],
    },
    extras: [
      {
        title: `A股净流入（单列 · 不参与份额计算）｜${payload.netFlow.label}`,
        text: payload.netFlow.sumCny === null
          ? `${NOT_FETCHED}：${payload.netFlow.miss ?? '上游本次没返回可用序列'}`
          : `近 ${payload.netFlow.days} 个交易日累计 ${fmtCnyYi(payload.netFlow.sumCny)}（${payload.netFlow.basis}）`,
      },
    ],
    // 段末一行结论（用户口径）：最新日用宿主的轮动结论；回放历史日如实说明轮动只对最新交易日给出
    conclusion: isLatest
      ? `→ 近5日资金偏好显示：${payload.rotation.text}`
      : '→ 回放历史日：显示那一天的份额榜首；近5日轮动只对最新交易日给出',
    replay: {
      days: [...payload.replay.days].reverse(),
      selected: Math.max(0, Math.round(step)),
      note: `${payload.replay.note}｜滑块位置 0 = 最新一日`,
    },
    boundary: payload.boundary,
  }
}

/**
 * 载荷句柄：一次取数 + 本地回放 + 本地换窗口（都不发请求）。
 *
 * 第二个参数是曲线窗口（90 / 180 / 365 个序列日）；省略 ⇒ 用宿主构建的整条曲线。
 */
export function globalFlowToolPayload(payload: GlobalFlowPayloadDto): ToolPayload {
  const days = payload.replay.days
  return {
    replayMax: Math.max(0, days.length - 1),
    at: (step: number, rangeDays?: number) => globalFlowToolData(payload, step, rangeDays),
  }
}
