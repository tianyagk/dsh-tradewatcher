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
import type { ToolData, ToolPayload, ToolPieSlice } from '../toolRegistry.ts'

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
    return `${m.name} 规模 ${native}（${currencyLabel(m.currency)}）已取到，但本次汇率 ${pair} 未取到 ⇒ 不做美元折算、不进美元合计；其余市场照常（口径不一致，不许静默混算）`
  }
  return null
}

/** 前一序列日某市场的份额（百分点）；没有前一天或那天缺值 ⇒ null */
function prevShareOf(payload: GlobalFlowPayloadDto, idx: number, marketIndex: number): number | null {
  const prev = idx > 0 ? payload.curve.points[idx - 1] : undefined
  const v = prev?.share[marketIndex]
  return v === null || v === undefined ? null : v * 100
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
  const purgeMark = purged.length === 0
    ? null
    : `⚠ 另有 ${purged.length} 天旧口径快照已作废（成分变更；留痕见快照文件，如 ${purged[purged.length - 1].day}）`
  const status = [
    `数据时刻 ${fmtBeijing(payload.asOf, payload.day)}（北京时间）`,
    degrade,
    purgeMark,
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
        note: live.length === 0 ? `${NOT_FETCHED}：没有有值市场` : top === null ? null : `${top.name} 占 ${fmtSharePct(topShare)}`,
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
      '规模榜首': top === null
        ? { text: NOT_FETCHED, value: null, delta: null }
        : { text: `${top.name} ${fmtSharePct(topShare)}`, value: topShare, delta: isLatest ? `五日 ${fmtPp(top.delta5Pp)}` : `较前一序列日 ${fmtPp(topShare === null || prevShareOf(view, idx, payload.markets.indexOf(top)) === null ? null : topShare - (prevShareOf(view, idx, payload.markets.indexOf(top)) as number))}` },
      '五市场合计规模': {
        text: fmtUsd(payload.totalUsd),
        value: payload.totalUsd,
        delta: payload.totalNote ?? rateSummary(payload),
      },
      '近五日轮动': {
        text: payload.rotation.text,
        value: payload.rotation.maxAbsPp,
        delta: payload.rotation.kind === 'rotation' ? '明确轮动' : payload.rotation.kind === 'flat' ? '持平' : '判不了',
      },
      '数据时刻': {
        text: point === undefined ? NOT_FETCHED : `${point.day}（${point.origin === 'observed' ? '实测' : '重建'}）`,
        value: null,
        delta: payload.snapshot.lastDay === null ? '本地快照尚未建立' : `快照至 ${payload.snapshot.lastDay}（${payload.snapshot.days} 天）`,
      },
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
