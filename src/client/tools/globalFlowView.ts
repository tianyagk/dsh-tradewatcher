/**
 * 工具①「五市场蛋糕」的**视图映射**（纯函数，无 React 依赖 ⇒ 可直接断言）。
 *
 * 职责边界（这条边界就是可测性的来源）：
 *   · 宿主 `globalFlow.ts` 负责**口径与计算**（份额、动量排名、轮动、曲线、快照）；
 *   · 这里只负责**把载荷渲染成详情页模型**（数字格式化、缺数据 → 「未取到」+ 原因、回放取第几帧）；
 *   · 页面（`ToolsPage.tsx`）只渲染模型 —— 它不许自己算份额、不许自己造数。
 *
 * 回放：`step = 0` 永远是**最新一日**，`step` 越大越早（滑块左端 = 最新）。
 * 所有回放帧都在**同一份载荷**上本地计算 ⇒ 拖动滑块**不会**产生任何上游请求。
 */
import type { GlobalFlowPayloadDto } from '../api.ts'
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
  const sign = n > 0 ? '+' : n < 0 ? '-' : ''
  return `${sign}${Math.abs(n).toFixed(2)}pp`
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
    : `${dropped.join('、')} 当日缺规模 ⇒ 不进饼图、也不进份额分母（分母只含有值市场，因此剩余各块合计仍为 100%）`
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
    rows.push([
      m.name,
      m.etf,
      fmtUsd(aumUsd),
      fmtSharePct(share === null ? null : share * 100),
      fmtPp(dPp),
      // 动量/排名只反映**最新交易日**：回放到历史日时如实标"不适用"，不重算（上游只留当下的横截面）
      isLatest ? fmtMomentum(m.momentum) : '不适用（回放日）',
      isLatest ? fmtRank(m.rank, rankedTotal === 0 ? payload.markets.length : rankedTotal) : '不适用（回放日）',
    ])
    rowNotes.push(m.missing)
  }
  return { rows, rowNotes }
}

/** 前一序列日某市场的份额（百分点）；没有前一天或那天缺值 ⇒ null */
function prevShareOf(payload: GlobalFlowPayloadDto, idx: number, marketIndex: number): number | null {
  const prev = idx > 0 ? payload.curve.points[idx - 1] : undefined
  const v = prev?.share[marketIndex]
  return v === null || v === undefined ? null : v * 100
}

/** 完整视图模型（页面只渲染它） */
export function globalFlowToolData(payload: GlobalFlowPayloadDto, step = 0): ToolData {
  const points = payload.curve.points
  const isLatest = step === 0
  const pie = pieSlicesAt(payload, step)
  const market = marketRowsAt(payload, step, isLatest)
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
  const snapshotNote = payload.source === 'snapshot'
    ? `本次只读本地快照（不发上游请求）；快照已累积 ${payload.snapshot.days} 天`
    : payload.fallbackDay !== null
      ? `上游本次全部失败 ⇒ 下面是最近一次本地快照（${payload.fallbackDay}）`
      : `上游现取（宿主三层 TTL：现价类 30 分钟 / 日线 12 小时 / 载荷 10 分钟）`
  const status = [
    `数据时刻 ${fmtBeijing(payload.asOf, payload.day)}（北京时间）`,
    snapshotNote,
    `曲线 ${points.length} 个序列日（实测 ${payload.curve.observedDays} / 重建 ${payload.curve.rebuiltDays}）`,
  ].join('｜')

  return {
    status,
    why,
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
        : { text: `${top.name} ${fmtSharePct(topShare)}`, value: topShare, delta: isLatest ? `五日 ${fmtPp(top.delta5Pp)}` : `较前一序列日 ${fmtPp(topShare === null || prevShareOf(payload, idx, payload.markets.indexOf(top)) === null ? null : topShare - (prevShareOf(payload, idx, payload.markets.indexOf(top)) as number))}` },
      '五市场合计规模': {
        text: fmtUsd(payload.totalUsd),
        value: payload.totalUsd,
        delta: payload.totalNote ?? (payload.fx.usdCny === null ? '汇率未取到 ⇒ A股 未折算进合计' : `汇率 ${payload.fx.usdCny.toFixed(4)}（${payload.fx.source}）`),
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
      series: payload.markets.map((m, i) => ({
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
        `份额合计 = ${fmtSharePct(shownShares.reduce((sum: number, v) => sum + (v ?? 0), 0))}（分母只含这一天有值的 ${live.length} 个市场）`,
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

/** 载荷句柄：一次取数 + 本地回放（换帧不发请求） */
export function globalFlowToolPayload(payload: GlobalFlowPayloadDto): ToolPayload {
  const days = payload.replay.days
  return { replayMax: Math.max(0, days.length - 1), at: (step: number) => globalFlowToolData(payload, step) }
}
