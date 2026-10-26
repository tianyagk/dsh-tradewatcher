/**
 */
import * as React from 'react'
import { abnormalColorOf, abnormalLabelOf, calibrationHeaderOf, caliberEntryOf, dayHistoryStateOf, ringDashOf } from './rescueView.ts'
import { breakerBadgeOf } from './rescueView.ts'
import type {
  PortPrefs, RescueConfig, RescueDaySummary, RescueEtfMeta, RescueEtfView, RescueFactor,
  RescueIntradayPoint, RescueLevel, RescueSignalEvent, RescueSnapshot, TrendData,
} from '../shared/model'
import { RESCUE_CORE_INDEXES, RESCUE_ETF_CATALOG, RESCUE_LEVEL_DESC, RESCUE_LEVEL_LABEL, rescueUniverseMeta } from '../shared/model'
import type { RescueCustomChannel } from '../shared/model'
/** 缺失原因的显示用压缩：只截断，不编造（完整原文放 title） */
function shortReason(text: string, max = 42): string {
  const t = text.trim()
  return t.length <= max ? t : `${t.slice(0, max - 1)}…`
}

import { api } from './api'
import { Btn, ErrorNote, Field, Modal, Skeleton } from './ui'
import { fmtStamp } from './format.ts'
import { TREND_MIN_INTERVAL_MS, dueByInterval } from './pacing.ts'
import { isUsableBaseline } from './trendView.ts'
import { shClockText, shDayText } from './marketTime.ts'
import { coverageBadgeOf, latestCoverageOf } from './rescueCoverage.ts'
import type { RescueCoverageLike } from './rescueCoverage.ts'

/** 「同时点量能」的极端档阈值（= 标定 f1.extreme = P95 = 1.92x；见上方注释的同步断言） */
const RESCUE_F1_EXTREME = 1.92

/**
 * 护盘等级配色（P1-10）：走 `styles.ts` 的语义 token `--tw-rescue-0..3`（中性 → 警示），
 * **不复用涨跌色相**。
 *
 * 旧实现把 3 档硬编码成 '#f2555a'（与浅色档 `--tw-up:#e5484d` 几乎同色）：日历的「高」跟随
 * `--tw-up` 在隐身档被灰化，而这里的「强」**保持鲜红** —— 隐身视图下最刺眼的一处颜色泄漏。
 * 现在两处同源，隐身档由 `[data-view=incognito]` 统一灰化。
 */
const LEVEL_COLOR: Record<RescueLevel, string> = {
  0: 'var(--tw-rescue-0)',
  1: 'var(--tw-rescue-1)',
  2: 'var(--tw-rescue-2)',
  3: 'var(--tw-rescue-3)',
}

interface Calibration {
  generatedAt: string
  progressCurve: number[]
  progressDays: number
  f1: { mid: number; high: number; extreme: number }
  f2: { watch: number; mid: number; strong: number }
  pooled: { p50: number; p75: number; p90: number; p95: number; p99: number }
  baselines: Record<string, number>
}

interface BreakerHost {
  host: string
  open: boolean
  until: number
  trips: number
  fails: number
  minutesLeft: number
  lastError: string | null
}

interface RescueData {
  snapshot: RescueSnapshot
  history: RescueDaySummary[]
  calibration?: Calibration
  /** 熔断状态聚合（逐主机明细 + 最早/全部恢复时间） */
  breaker?: {
    open: boolean
    allOpen: boolean
    openHosts: number
    hosts: number
    minutesLeft: number
    allMinutesLeft: number
    lastError: string | null
    detail: BreakerHost[]
  }
  staleNote?: string
}

const fmtX = (v: number | null | undefined, digits = 2): string => (typeof v === 'number' && Number.isFinite(v) ? `${v.toFixed(digits)}x` : '—')
const fmtYi = (v: number | null | undefined): string => (typeof v === 'number' && Number.isFinite(v) ? `${(v / 1e8).toFixed(2)}亿` : '—')
const fmtPct = (v: number | null | undefined, digits = 2): string => (typeof v === 'number' && Number.isFinite(v) ? `${v > 0 ? '+' : ''}${v.toFixed(digits)}%` : '—')

function pctColor(v: number | null | undefined, redUp: boolean): string {
  if (typeof v !== 'number' || !Number.isFinite(v)) return 'var(--tw-fg-dim)'
  if (v === 0) return 'var(--tw-fg-dim)'
  const up = v > 0
  return up === redUp ? 'var(--tw-up)' : 'var(--tw-down)'
}

/** 权重条：把 0–100 映射成一根细条，颜色随分值变化 */
/**
 * 量能"进度条 + 阈值线"（用户建议批 ②）：**只画宿主给得出来的标定阈值**。
 * 这里唯一的标定数是 `f1.extreme`（P95 = 1.92x）⇒ 条长按 `2×extreme` 归一，
 * 阈值线落在 50% 处（= extreme）。**没有第二个阈值就不画第二条线**（不编阈值）。
 */
function ThresholdBar(props: { value: number | null; width?: number }): React.ReactElement {
  const max = RESCUE_F1_EXTREME * 2
  const pct = props.value === null || !Number.isFinite(props.value) ? 0 : Math.max(0, Math.min(100, (props.value / max) * 100))
  return React.createElement('div', {
    className: 'tw-rescue-bar', style: { width: props.width ?? 72, position: 'relative' },
    title: `同时点量能 ${props.value === null ? '未取到' : `${props.value.toFixed(2)}x`}；阈值线 = f1.extreme（P95 = ${RESCUE_F1_EXTREME}x），条长按 ${max.toFixed(2)}x 归一`,
    'data-role': 'volume-threshold-bar',
  },
    // P2-11：条长用 transform:scaleX（CSS 里 transition 只动 transform）——旧的 width% 会触发布局
    React.createElement('i', { style: { transform: `scaleX(${pct / 100})`, background: (props.value ?? 0) >= RESCUE_F1_EXTREME ? LEVEL_COLOR[3] : 'currentColor' } }),
    // 阈值线：位置固定 50%（= extreme / 2×extreme），是**标定值**不是我们拍的
    React.createElement('span', {
      'data-role': 'threshold-line',
      style: { position: 'absolute', left: '50%', top: 0, bottom: 0, width: 1, background: LEVEL_COLOR[3], opacity: 0.9 },
    }),
  )
}

function ScoreBar(props: { value: number; color?: string; width?: number; threshold?: number }): React.ReactElement {
  const pct = Math.max(0, Math.min(100, props.value))
  return React.createElement('div', { className: 'tw-rescue-bar', style: { width: props.width ?? 72, position: 'relative' } },
    // P2-11：同上（transform 而不是 width，避免每帧重排）
    React.createElement('i', { style: { transform: `scaleX(${pct / 100})`, background: props.color ?? 'currentColor' } }),
    props.threshold === undefined
      ? null
      : React.createElement('span', {
          'data-role': 'threshold-line',
          style: { position: 'absolute', left: `${Math.max(0, Math.min(100, props.threshold))}%`, top: 0, bottom: 0, width: 1, background: 'currentColor', opacity: 0.55 },
        }),
  )
}

function exportCsv(rows: RescueEtfView[], snap: RescueSnapshot): void {
  const head = ['通道', 'secid', '涨跌幅%', '成交额', '量比', '同时点量能倍数', '超大单净额', '超大单占成交额', '超大单比20日均额', '脉冲倍数', '活跃度', '触发']
  const line = (e: RescueEtfView): string[] => [
    e.name, e.secid, e.pct === null ? '' : e.pct.toFixed(2), e.amount === null ? '' : (e.amount / 1e8).toFixed(2),
    e.volRatio === null ? '' : String(e.volRatio), e.timeAdjMult === null ? '' : e.timeAdjMult.toFixed(2),
    e.superNet === null ? '' : (e.superNet / 1e8).toFixed(2), e.superShare === null ? '' : e.superShare.toFixed(4),
    e.superVsAvg === null ? '' : e.superVsAvg.toFixed(3), e.pulseMult === null ? '' : e.pulseMult.toFixed(2),
    String(e.activity), e.triggered ? '是' : '否',
  ]
  const csv = [head.join(','), ...rows.map((e) => line(e).join(','))].join('\n')
  const blob = new Blob([`\ufeff${csv}`], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `护盘信号_${shDayText(snap.ts)}.csv`
  a.click()
  URL.revokeObjectURL(url)
}

/** 分时量能图：分钟成交额柱 + 同时点基准线 + 超阈值高亮 */
function PulseChart(props: {
  trend: TrendData | null
  base: number | null
  curve: number[] | null
  loading: boolean
  /** 宿主给的"为什么没有量能"（v0.66.0 起 `/trend` 会给；三情形文案见 host/em.ts） */
  amountReason?: string | null
}): React.ReactElement {
  const { trend, base, curve } = props
  if (props.loading) return React.createElement(Skeleton, { lines: 4, height: 20 })
  const pts = (trend?.points ?? []).filter((p) => typeof p.amount === 'number' && (p.amount ?? 0) > 0)
  if (pts.length < 5) {
    // 常驻只有这一句（不给长句）；**原因进 title/aria**（红线：缺失必须给原因，且要能被键盘/触屏读到）
    const reason = props.amountReason ?? '原因未给出（宿主未回 missing）'
    return React.createElement('div', {
      className: 'tw-hint',
      style: { padding: '10px 4px' },
      tabIndex: 0,
      role: 'note',
      title: reason,
      'aria-label': `分钟成交额未取到 —— ${reason}`,
    }, '分钟成交额未取到')
  }
  const W = 620
  const H = 118
  const padL = 4
  const amounts = pts.map((p) => p.amount ?? 0)
  // 数据里带了"推算"标记（host 对腾讯兜底序列挂的 `amountDerived`）⇒ 常驻出一个 4 字标记，
  // 说明进 title（不新增常驻长句；不标就等于把推导值当上游直给）
  const derivedNote = (() => {
    const flagged = pts.find((p) => (p as { amountDerived?: boolean; amountNote?: string }).amountDerived === true)
    return flagged === undefined
      ? null
      : ((flagged as { amountNote?: string }).amountNote ?? '分钟成交额由上游累计值推导（非上游直给的分钟额）')
  })()
  const maxAmt = Math.max(...amounts)
  // 同时点基准：base × (曲线[t] − 曲线[t-1])，均匀回退
  const expected: number[] = pts.map((_, i) => {
    if (base === null || base <= 0) return 0
    const n = pts.length
    if (curve !== null && curve.length === 49) {
      const a = curve[Math.min(48, Math.floor((i / n) * 48))]
      const b = curve[Math.min(48, Math.floor(((i + 1) / n) * 48))]
      return base * Math.max(0, b - a)
    }
    return base / n
  })
  const maxScale = Math.max(maxAmt, ...expected) || 1
  const bw = W / pts.length
  const y = (v: number): number => H - (v / maxScale) * H
  const bars = pts.map((p, i) => {
    const amt = p.amount ?? 0
    const exp = expected[i]
    const ratio = exp > 0 ? amt / exp : 0
    const color = ratio >= 2.5 ? LEVEL_COLOR[3] : ratio >= 1.5 ? LEVEL_COLOR[2] : 'var(--tw-accent, #5da5ff)'
    const h = Math.max(1, H - y(amt))
    return React.createElement('rect', {
      key: i, x: padL + i * bw * 0.86, y: y(amt), width: Math.max(1, bw * 0.8), height: h,
      fill: color, opacity: ratio >= 1.5 ? 0.95 : 0.55,
    })
  })
  const baseline = isUsableBaseline(base)
    ? React.createElement('polyline', {
        points: expected.map((v, i) => `${padL + i * bw + bw * 0.4},${y(v)}`).join(' '),
        fill: 'none', stroke: 'var(--tw-fg-dim, #8b93a7)', strokeWidth: 1, strokeDasharray: '3 3', opacity: 0.8,
      })
    : null
  const svg = React.createElement('svg', { viewBox: `0 0 ${W} ${H}`, width: '100%', height: H, preserveAspectRatio: 'none', className: 'tw-rescue-svg' },
    React.createElement('line', { x1: 0, y1: H, x2: W, y2: H, stroke: 'var(--tw-line, #262a33)', strokeWidth: 1 }),
    ...bars,
    baseline,
  )
  if (derivedNote === null) return svg
  // 推导值标记（4 字，常驻）+ 说明进 title/aria（不给常驻长句）
  return React.createElement('div', null,
    React.createElement('span', {
      className: 'tw-badge',
      style: { marginBottom: 2 },
      tabIndex: 0,
      role: 'note',
      title: derivedNote,
      'aria-label': derivedNote,
    }, '量能推算'),
    svg,
  )
}

function EtfCard(props: { etf: RescueEtfView; redUp: boolean }): React.ReactElement {
  const { etf, redUp } = props
  return React.createElement('div', {
    className: 'tw-rescue-card',
    style: etf.triggered ? { borderColor: LEVEL_COLOR[2], boxShadow: 'inset 0 0 0 1px ' + LEVEL_COLOR[2] } : undefined,
  },
    React.createElement('div', { className: 'tw-rescue-card-h' },
      React.createElement('b', null, etf.name),
      RESCUE_CORE_INDEXES.includes(etf.index)
        ? React.createElement('span', { className: 'tw-badge', title: '核心护盘通道：F2 以核心通道为主，且大额净流出会封顶信号等级' }, '核心')
        : null,
      etf.provisional === true
        ? React.createElement('span', { className: 'tw-badge', title: '上游不可用：这张卡是当日峰值的复盘数据，非实时快照' }, '复盘')
        : null,
      etf.secid !== '' && !RESCUE_ETF_CATALOG.some((c) => c.secid === etf.secid)
        ? React.createElement('span', { className: 'tw-badge', title: '自定义通道（通常为板块 ETF）：仅作量能与脉冲观察，不计入护盘评分与共振' }, '板块')
        : null,
      React.createElement('span', { style: { color: pctColor(etf.pct, redUp), fontFamily: 'var(--tw-mono)' } }, fmtPct(etf.pct)),
    ),
    React.createElement('div', { className: 'tw-rescue-card-grid' },
      React.createElement('span', { className: 'k' }, '成交额'),
      React.createElement('span', { className: 'v' }, fmtYi(etf.amount)),
      React.createElement('span', { className: 'k' }, '量比'),
      React.createElement('span', { className: 'v' }, etf.volRatio === null ? '—' : etf.volRatio.toFixed(2)),
      React.createElement('span', { className: 'k' }, '同时点量能'),
      // 「同时点量能」达到**极端档**时用极端档配色。阈值取标定值 f1.extreme（= P95 = 1.92x），
      // 与 `src/host/rescue-thresholds.ts` 的 `RESCUE_CALIBRATION.f1` 同源；两处一致性由
      // `src/client/rescuePanel.test.ts` 的同步断言守着（旧值 1.63 是更早一次标定的 P90，早已失效）。
      React.createElement('span', { className: 'v', style: { display: 'flex', alignItems: 'center', gap: 6 } },
        React.createElement(ThresholdBar, { value: etf.timeAdjMult, width: 48 }),
        React.createElement('span', { style: { color: (etf.timeAdjMult ?? 0) >= RESCUE_F1_EXTREME ? LEVEL_COLOR[3] : undefined } }, fmtX(etf.timeAdjMult))),
      React.createElement('span', { className: 'k' }, '超大单净额'),
      React.createElement('span', { className: 'v', style: { color: pctColor(etf.superNet, redUp) } }, fmtYi(etf.superNet)),
      React.createElement('span', { className: 'k' }, '占成交额'),
      React.createElement('span', { className: 'v' }, etf.superShare === null ? '—' : `${(etf.superShare * 100).toFixed(1)}%`),
      React.createElement('span', { className: 'k' }, '比20日均额'),
      React.createElement('span', { className: 'v' }, fmtX(etf.superVsAvg, 3)),
      React.createElement('span', { className: 'k' }, '尾盘脉冲'),
      React.createElement('span', { className: 'v' }, fmtX(etf.pulseMult)),
    ),
    React.createElement('div', { className: 'tw-rescue-card-f' },
      React.createElement('span', { className: 'tw-muted', style: { fontSize: 12 } }, `活跃度 ${etf.activity}`),
      React.createElement(ScoreBar, { value: etf.activity, color: LEVEL_COLOR[etf.activity >= 60 ? 3 : etf.activity >= 35 ? 2 : 1], width: 90 }),
      etf.flowDirection === 'out'
        ? React.createElement('span', { className: 'tw-badge', title: '超大单净流出占成交额 ≥15%：不是「哑火」，是资金在撤', style: { color: 'var(--tw-down)', borderColor: 'var(--tw-down)' } }, `撤离 ${fmtYi(etf.superNet)}`)
        : etf.flowDirection === 'in'
          ? React.createElement('span', { className: 'tw-badge', style: { color: 'var(--tw-up)', borderColor: 'var(--tw-up)' } }, `吸纳 ${fmtYi(etf.superNet)}`)
          : null,
      etf.triggered ? React.createElement('span', { className: 'tw-badge', style: { color: LEVEL_COLOR[2], borderColor: LEVEL_COLOR[2] } }, '触发') : null,
    ),
  )
}

/**
 * 因子表（P0-7）。
 *
 * 加了「贡献」列（权 × 得分 × 时点系数）与一行合计：此前只有总分与各因子分数，
 * 看到 `评分 68` 而 `量能 ×2.1`、`超大单 ×0.3` 时无法判断这一分是谁加的 ——
 * 量能撑起来的和"跌出来的背离"撑起来的，操作含义完全相反。
 */
function FactorTable(props: {
  factors: RescueFactor[]
  /** 贡献度（与 factors 同序；缺失时不显示该列，避免显示一个算不出来的数） */
  contrib?: Array<{ id: string; contribution: number }>
  timeCoef?: number
  total?: number
}): React.ReactElement {
  const byId = new Map((props.contrib ?? []).map((c) => [c.id, c.contribution]))
  const hasContrib = byId.size > 0
  const sum = [...byId.values()].reduce((a, b) => a + b, 0)
  return React.createElement('table', { className: 'tw-rescue-factor' },
    React.createElement('thead', null,
      React.createElement('tr', null,
        React.createElement('th', null, '因子'),
        React.createElement('th', null, '实测'),
        React.createElement('th', { style: { width: 46 } }, '得分'),
        React.createElement('th', { style: { width: 36 } }, '权重'),
        hasContrib
          ? React.createElement('th', {
              style: { width: 64 },
              title: '贡献 = 权重 × 得分 × 时点系数；每行满分 = 权重 × 100（即该因子全部命中时的贡献）',
            }, '贡献/满分')
          : null,
        React.createElement('th', null, '阈值口径'),
      ),
    ),
    React.createElement('tbody', null,
      ...props.factors.map((f) => {
        const c = byId.get(f.id)
        return React.createElement('tr', { key: f.id, 'data-hit': f.hit },
          React.createElement('td', null, f.hit ? React.createElement('span', { style: { color: LEVEL_COLOR[2] } }, '● ') : React.createElement('span', { className: 'tw-muted' }, '○ '), f.label),
          React.createElement('td', { style: { fontFamily: 'var(--tw-mono)' } }, f.actual),
          React.createElement('td', null, React.createElement(ScoreBar, { value: f.score, width: 40, color: f.hit ? LEVEL_COLOR[2] : 'var(--tw-fg-dim)' })),
          React.createElement('td', { className: 'tw-muted' }, f.weight.toFixed(2)),
          hasContrib
            ? React.createElement('td', {
                style: { fontFamily: 'var(--tw-mono)' },
                title: `${f.weight.toFixed(2)} × ${f.score} × ${props.timeCoef ?? 1} = ${(c ?? 0).toFixed(1)}；满分 ${Math.round(f.weight * 100)}（权重 × 100）`,
              }, `${(c ?? 0).toFixed(1)}/${Math.round(f.weight * 100)}`)
            : null,
          React.createElement('td', { className: 'tw-muted', style: { fontSize: 12 } }, f.threshold),
        )
      }),
      hasContrib
        ? React.createElement('tr', { key: '__sum' },
            React.createElement('td', { className: 'tw-muted', colSpan: 4 }, `合计（权×得分×时点系数 ${props.timeCoef ?? 1}）`),
            React.createElement('td', {
              style: { fontFamily: 'var(--tw-mono)', fontWeight: 600 },
              title: '与总分一致（差值仅来自四舍五入）；满分 100',
            }, `${sum.toFixed(1)}/100`),
            React.createElement('td', { className: 'tw-muted', style: { fontSize: 12 } }, `总分 ${props.total ?? Math.round(sum)}`),
          )
        : null,
    ),
  )
}


/**
 * 覆盖广度**短标记**（主线 / 今日时间线 / 历史回看共用的唯一实现）。
 *
 * 常驻只有 `cov.marker`（`3 族 · 5/6`，算不出来就是 `—`）；完整口径 —— 三族归属、`z ≥ 2` 阈值、
 * 确认档 1（方向一致性）与确认档 2（30 年国债 ETF 反向读数）的读数、「当前未计入评分（阶段一）」这句
 * 状态、以及缺失原因 —— 全部在 `title` / `aria-label` 里（悬停与键盘读屏都能拿到，版面不占）。
 */
function CoverageMark(props: {
  cov: RescueCoverageLike | null | undefined
  why?: readonly string[] | null
  enabled?: boolean | null
}): React.ReactElement {
  const badge = coverageBadgeOf({ coverage: props.cov ?? null, why: props.why ?? null, enabled: props.enabled ?? null })
  return React.createElement('span', {
    className: 'tw-badge tw-rescue-cov',
    'data-role': 'rescue-coverage-badge',
    title: badge.title,
    'aria-label': `覆盖广度 ${badge.marker} —— ${badge.title}`,
    tabIndex: 0,
    role: 'note',
    style: { cursor: 'help' },
  }, badge.marker)
}

export function RescuePanel(props: {
  prefs: PortPrefs
  redUp: boolean
  onPrefs?: (p: PortPrefs) => void
  /** 12 栏网格里的占位（大盘页 B3 用）；不传则不写属性（其它挂载点不受影响） */
}): React.ReactElement {
  const [data, setData] = React.useState<RescueData | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const [loading, setLoading] = React.useState(true)
  const [settings, setSettings] = React.useState(false)
  const [lane, setLane] = React.useState<string>(RESCUE_ETF_CATALOG[0].secid)
  const [trend, setTrend] = React.useState<TrendData | null>(null)
  /** 宿主给的"为什么量能用不了"（`/trend` 的 missing[0].note）；v0.66.0 起三情形都会给 */
  const [trendAmountReason, setTrendAmountReason] = React.useState<string | null>(null)
  const [trendLoading, setTrendLoading] = React.useState(false)
  const [openDay, setOpenDay] = React.useState<string | null>(null)
  const [dayDetail, setDayDetail] = React.useState<{ events: RescueSignalEvent[]; intraday: RescueIntradayPoint[] } | null>(null)
  /** 历史回看**失败原因**（P1-9）：失败时 detail 保持 null（=未取到），绝不拿空事件数组冒充"当日无信号" */
  const [dayErr, setDayErr] = React.useState<string | null>(null)

  const config: RescueConfig = props.prefs.rescue
  const snapshot = data?.snapshot ?? null
  /**
   * 「口径与边界」常驻入口（IMPL-79）：三段披露（宿主口径句 + 两段红线）的**唯一来源**，
   * 常驻区只渲染 `label` 一行，三段原文进 `title`/`aria-label`（见 `rescueView.caliberEntryOf`）。
   */
  const caliberEntry = caliberEntryOf(snapshot?.bottom?.model)
  /**
   * 本拍的覆盖广度（阶段一）：优先 `snapshot.coverage`，老宿主退回最新一条带该字段的事件。
   * 缺失时不补 0 —— `coverageBadgeOf` 会给 `—` + 原因。
   */
  const covNow = latestCoverageOf(snapshot)
  /**
   * 当日抽样峰值（**唯一实现**）：总分的"与最近相比"参照与下方"最高评分"那行共用它
   * —— 两处各算一次迟早会漂移。契约里只有"当日抽样"（`intraday`），跨日分位不在快照里。
   */
  const peakToday = (snapshot?.intraday ?? []).reduce<null | (typeof snapshot.intraday)[number]>(
    (a, p) => (a === null || p.score > a.score ? p : a),
    null,
  )

  const load = React.useCallback((force = false): void => {
    setLoading(true)
    api
      .rescue(force)
      .then((r) => {
        const next = r as RescueData
        // 空快照（上游取数失败/尚未采样）不要抹掉已有数据 —— 与行情「不因一次失败清空」同一原则
        setData((prev) => {
          const empty = (next.snapshot?.etfs.length ?? 0) === 0
          const have = (prev?.snapshot?.etfs.length ?? 0) > 0
          return empty && have ? { ...prev!, staleNote: '本次刷新未取到数据，显示上一次结果' } as RescueData : next
        })
        setError(null)
      })
      .catch((e: Error) => {
        setError(
          e.message.includes('404')
            ? '护盘监测接口未加载：host 侧改动需要重启 dsh web 后生效（客户端刷新不够）'
            : e.message,
        )
      })
      .finally(() => setLoading(false))
  }, [])

  // 首次拉取 + 按采样节奏轮询（交易时段跟随后端配置，非交易时段 60s 兜底）
  React.useEffect(() => {
    load(false)
  }, [load])

  React.useEffect(() => {
    const sec = snapshot !== null && snapshot.trading ? Math.max(10, snapshot.activeIntervalSec) : 60
    const timer = window.setInterval(() => load(false), sec * 1000)
    return () => window.clearInterval(timer)
  }, [load, snapshot?.trading, snapshot?.activeIntervalSec])

  /**
   * 分时量能图：跟随选中通道 + **60 秒最小间隔**（U3）。
   *
   * 旧写法每来一次采样（交易时段 ≈10s 一拍）就重取一次 `/trend`，静置 10 分钟 ≈60 次；
   * 分时量能本来就按分钟聚合，10s 一取只是把同一条曲线反复画。切通道时**立刻**取（不等节拍）。
   * 副作用（最多旧 60 秒）写在图下方那行的 `title` 里。
   */
  const trendAt = React.useRef<number | null>(null)
  const trendLane = React.useRef<string | null>(null)
  React.useEffect(() => {
    if (settings || lane === '') return
    const at = Date.now()
    const switched = trendLane.current !== lane
    if (!switched && !dueByInterval(at, trendAt.current, TREND_MIN_INTERVAL_MS)) return
    trendLane.current = lane
    trendAt.current = at
    setTrendLoading(true)
    api
      .trend(lane, 1)
      .then((r) => {
        setTrend(r.trend)
        setTrendAmountReason(r.missing?.[0]?.note ?? null)
      })
      .catch(() => setTrend(null))
      .finally(() => setTrendLoading(false))
  }, [lane, snapshot?.ts])

  const openHistory = (day: string): void => {
    setOpenDay(day)
    setDayDetail(null)
    setDayErr(null)
    api
      .rescueDay(day)
      .then((r) => setDayDetail({ events: r.dayEvents ?? [], intraday: r.dayIntraday ?? [] }))
      // P1-9：失败**不许**写成 `{events: [], intraday: []}` —— 那两句会变成
      // "当日无信号事件""当日无抽样点"，两句话都是**未经验证的否定**。
      // 这里保持 `dayDetail === null`（= 未取到）并把原因交给弹窗显示 + 重试。
      .catch((e: Error) => setDayErr(e.message))
  }

  const saveConfig = (patch: Partial<RescueConfig>): void => {
    api
      .setPrefs({ rescue: { ...config, ...patch } })
      .then((r) => {
        props.onPrefs?.(r.prefs)
        load(true)
      })
      .catch((e: Error) => {
        setError(
          e.message.includes('404')
            ? '护盘监测接口未加载：host 侧改动需要重启 dsh web 后生效（客户端刷新不够）'
            : e.message,
        )
      })
  }

  /**
   * 非交易日（周末/法定假日）：**不出等级** —— 显示「休市（非交易日）」而不是「平静」。
   * 宿主给的 `level` 此时是 `null`，这里的 `0` 只用于配色索引，文案一律走 `shutLabel`。
   */
  const shut = snapshot?.nonTrading ?? null
  const level = snapshot?.level ?? 0
  /**
   * `level === null` 有两种情形：①休市（`nonTrading` 有值）；②**非交易时段**（A-1 闸门，收盘后/午休/盘前）。
   * 后者不能显示成「平静」—— 那不是"没事发生"，而是"这次没判"。
   */
  const offSession = shut === null && snapshot?.level === null
  const levelText = shut !== null ? '休市（非交易日）' : offSession ? '非交易时段' : RESCUE_LEVEL_LABEL[level]
 // 采样窗口状态由宿主给出（含下次采样时刻）；老宿主没有该字段时不冒充"暂停"
  const win = snapshot?.activeWindow
  const paused = snapshot !== null && win !== undefined && win.sampling !== true
  const pauseReason = win?.reason === 'weekend' ? '周末休市'
    : win?.reason === 'holiday' ? `法定假日休市${shut?.label != null ? `（${shut.label}）` : ''}`
    : win?.reason === 'noon-break' ? '午休'
      : win?.reason === 'disabled' ? '监测已关闭'
        : win?.reason === 'closed' ? '已收盘' : '非交易时段'
  /**
   * 默认展开判据（DESIGN-DASHBOARD §3 / B3）：
   *  - 取数失败（`etfs.length === 0`）**不再默认展开一个空壳** —— 塌成一行 `— + 原因 + 重试`（≤60px）；
   *  - 有实时数据时：等级 ≥2 自动展开（此时展开区里的分时图/时间线/抽样条都是真实记录），
   *    否则默认收起。
   */
  const rescueEmpty = snapshot !== null && snapshot.etfs.length === 0
  /**
   * v0.170.0（用户定稿）：护盘信号**删除展开/缩回**，全部常驻。
   * `expanded` 恒 true ⇒ 下面所有区块（共振/六卡/因子/分时量能/时间线/抽样/历史）同时渲染。
   */
  const expanded = true

  const lanes: RescueEtfMeta[] = rescueUniverseMeta(config.universe)
  const laneBase = snapshot?.etfs.find((e) => e.secid === lane)?.avgAmt20 ?? null

  return React.createElement('div', { className: 'tw-panel tw-rescue' },
    React.createElement('div', { className: 'tw-panel-h' },
      React.createElement('span', {
        className: 'tw-rescue-dot',
        style: {
          background: offSession ? 'var(--tw-muted)' : LEVEL_COLOR[level],
          boxShadow: !offSession && level >= 2 ? `0 0 8px ${LEVEL_COLOR[level]}` : undefined,
        },
      }),
      React.createElement('span', { className: 't' }, '护盘信号'),
      snapshot !== null
        ? React.createElement('span', { className: 'tw-badge', style: { color: LEVEL_COLOR[level], borderColor: LEVEL_COLOR[level] } }, levelText)
        : null,
      // 覆盖广度短标记（`3 族 · 5/6`）：与等级并排，**只有短标记**；口径全在悬停/读屏里
      snapshot !== null
        ? React.createElement(CoverageMark, { cov: covNow.coverage, why: covNow.why, enabled: snapshot.coverageEnabled === true })
        : null,
      snapshot !== null
        ? React.createElement('span', {
            className: 'tw-muted',
            style: { fontFamily: 'var(--tw-mono)', fontSize: 12 },
 // 非采样时段分数位显示 —（不是把上一次的分数留在那里假装是当前分）
            title: paused
              ? `采样暂停（${pauseReason}）：分数位显示 —，因为当前没有在采样；下方与该分数相关的结论都是最近一次采样的结果`
              : `本次快照评分（Σ 权×因子分×时点系数）；参照：当日抽样峰值 ${
                  peakToday === null ? '—（当日还没有抽样点）' : `${peakToday.score} @${peakToday.hhmm}`
                }${peakToday !== null && peakToday.score === snapshot.score ? '（当前就是当日峰值）' : ''}；阈值口径 ${
                  snapshot.thresholdSource === 'self' ? `自建分位（${snapshot.selfSampleDays} 天）`
                    : snapshot.thresholdSource === 'calibrated' ? '历史标定' : `经验锚点（自建样本 ${snapshot.selfSampleDays}/20 天）`
                }。${
                  // v0.16.0：跨日分位**来自快照契约**（宿主算、界面只显示）——**不在客户端现算**
                  typeof snapshot.continuousPercentile === 'number'
                    ? `连续评分 ${snapshot.continuous === null || snapshot.continuous === undefined ? '—' : snapshot.continuous}/100 的近 20 日分位 ${snapshot.continuousPercentile.toFixed(0)}%（N=${snapshot.continuousPercentileN ?? 0}）`
                    : `连续评分的近 20 日分位：${snapshot.continuousPercentileWhy ?? '未取到（快照里没有分位字段）'}`
                }`,
          },
            // 可见部分保持紧凑：分数 + 一句**能用现有数据算出来**的参照（当日峰值）+ 跨日分位
            // （分位数与样本数都来自快照契约；缺数据时显示"分位 —"这个短标记，原因在 title 里）
            paused
              ? '—'
              : React.createElement(React.Fragment, null,
                  // 环形进度条（SVG，无依赖）：**中性色阶**，只表示"异常程度"，不是买卖信号
                  React.createElement('svg', {
                    width: 22, height: 22, viewBox: '0 0 60 60', 'data-role': 'score-ring',
                    'aria-label': `${abnormalLabelOf(snapshot.score)}（${snapshot.score}/100，非买卖建议）`,
                    style: { verticalAlign: 'middle', marginRight: 4 },
                  },
                    React.createElement('circle', { cx: 30, cy: 30, r: 26, fill: 'none', stroke: 'var(--tw-border)', strokeWidth: 7 }),
                    React.createElement('circle', {
                      cx: 30, cy: 30, r: 26, fill: 'none', stroke: abnormalColorOf(snapshot.score), strokeWidth: 7,
                      strokeDasharray: `${ringDashOf(snapshot.score).dash} ${ringDashOf(snapshot.score).gap}`,
                      strokeLinecap: 'round', transform: 'rotate(-90 30 30)',
                    }),
                  ),
                  `${snapshot.score}/100 · 当日峰 ${peakToday === null ? '—' : peakToday.score} · 分位 ${
                  typeof snapshot.continuousPercentile === 'number'
                    ? `${snapshot.continuousPercentile.toFixed(0)}%（N=${snapshot.continuousPercentileN ?? 0}）`
                    : '—'
                }`))
        : null,
      React.createElement('span', { style: { flex: 1 } }),
      snapshot !== null && (snapshot.stale === true || (data as { staleNote?: string })?.staleNote !== undefined)
        ? React.createElement('span', {
            className: 'tw-badge',
            title: snapshot.note ?? (data as { staleNote?: string })?.staleNote ?? '',
            style: { color: LEVEL_COLOR[1], borderColor: LEVEL_COLOR[1] },
          }, `上次数据 ${snapshot.lastSampleTs !== null ? shClockText(snapshot.lastSampleTs).slice(0, 5) : ''}`)
        : null,
      snapshot !== null && (snapshot.completeness?.missing.length ?? 0) > 0
        ? React.createElement('span', {
            className: 'tw-badge',
            // 缺因子的**原因**必须说清：备用数据源（腾讯）没有分单资金流，等多久都不会补齐；
            // 东财源下的缺因子才是"冷启动/采样满 5 分钟自动补齐"。此前一律写"5 分钟后自动补齐"，
            // 在备用数据源场景下是空头承诺。
            title: snapshot.flowSource === 'tencent'
              ? `本次快照缺少因子：${snapshot.completeness?.missing.join('、')} —— 数据来自「腾讯备用数据源」，该源不含分单资金流（超大单/主力净额），因此「持续性」无法计算，不是等几分钟就能补齐的；量能、脉冲、背离仍为真实数据，评分偏保守。（「超大单强度」已整体剔除：宽基 ETF 分单数据稀疏，不可用。）`
              : `本次快照缺少因子：${snapshot.completeness?.missing.join('、')}（评分偏保守；冷启动回填完成或盘中采样 5 分钟后自动补齐）`,
            style: { color: LEVEL_COLOR[2], borderColor: LEVEL_COLOR[2] },
          }, `因子 ${snapshot.completeness?.available}/${snapshot.completeness?.total}`)
        : null,
      snapshot !== null
        ? React.createElement('span', {
            className: 'tw-muted',
            style: { fontSize: 12 },
            title: [
              snapshot.lastSampleTs !== null ? `数据时刻 ${fmtStamp(snapshot.lastSampleTs)}（最近一次成功采样）` : '尚未成功采样',
              snapshot.lastFailTs !== null && snapshot.lastFailTs !== undefined ? `最近一次采样失败：${fmtStamp(snapshot.lastFailTs)}` : null,
              snapshot.flowSource === 'tencent' ? '数据来源：腾讯备用数据源（无分单资金流）' : snapshot.flowSource === 'em' ? '数据来源：东方财富（含分单资金流）' : null,
              snapshot.note ?? null,
            ].filter(Boolean).join('\n'),
          },
            // P0-4：暂停时段必须说清"暂停"而不是让人以为"坏了"，并给出下次采样时刻
            `${paused
              ? `采样暂停 · 下次 ${snapshot.activeWindow?.nextLabel ?? '—'}（${pauseReason}）`
              : `采样中 · ${snapshot.activeIntervalSec}s`}` +
            // 「数据 HH:mm:ss」= 这份数据是几点拿到的（不是响应时刻、更不是失败时刻）
            `${snapshot.lastSampleTs !== null ? ` · 数据 ${shClockText(snapshot.lastSampleTs)}` : ''}` +
            `${snapshot.flowSource === 'tencent' ? ' · 腾讯源' : ''}` +
            // 两种"不新鲜"必须分开说：有失败时刻 = 采样失败；只有缺口标记 = 当日有过缺口
            //（磁盘上的旧快照、会话未采样等）；仅 stale（本会话未采样）由「上次数据」红标说明。
 // **暂停时段一律不出现「采样缺口」字样** —— 那时缺口不是正在发生的事
            // 说成"缺口"会让人以为要处理；改为陈述"当日曾中断"。
            `${paused
              ? snapshot.lastFailTs !== null && snapshot.lastFailTs !== undefined
                ? ` · 当日曾采样失败 ${shClockText(snapshot.lastFailTs)}`
                : snapshot.gap ? ' · 当日采样曾中断（非当前故障）' : ''
              : snapshot.gap && snapshot.lastFailTs !== null && snapshot.lastFailTs !== undefined
                ? ` · ⚠ 采样失败 ${shClockText(snapshot.lastFailTs)}`
                : snapshot.gap ? ' · ⚠ 当日有采样缺口' : ''}`,
          )
        : null,
      React.createElement(Btn, { onClick: () => load(true) }, loading ? '刷新中…' : '立即采样'),
      React.createElement(Btn, { onClick: () => setSettings(true) }, '设置'),
      snapshot !== null && snapshot.etfs.length > 0
        ? React.createElement(Btn, { onClick: () => exportCsv(snapshot.etfs, snapshot) }, '导出')
        : null,
    ),
    React.createElement(ErrorNote, { error }),
    (() => {
      const b = data?.breaker
      if (b?.open !== true || snapshot === null) return null
      // 一行短句 + tooltip 明细，且**说清影响范围**：
      //  - 东财主机熔断只影响"东财那条链路"；面板数据若已由腾讯备用数据源兜底，
      //    结论是"缺分单资金流因子"，而不是"没有数据"（此前一律写"面板显示当日复盘数据"，
      //    在备用数据源兜底成功的场景下与事实不符）；
      //  - 收盘后不再承诺"最早 N 分钟可重试"（那时没有采样需求），改为"下次开盘自动重试"；
      //  - "期间不发起请求"只对熔断中的东财主机成立，备用数据源照常请求（「立即采样」仍可用）。
      // 紧凑形式（task-14 ③）：常驻只留标记（≤6 字），完整原因在 title/aria —— 用户要"少提示"，
      // 但降级事实不许丢（那条长句仍在，只是不再常驻占位）。
      const badge = breakerBadgeOf({
        openHosts: b.openHosts,
        hosts: b.hosts,
        allOpen: b.allOpen,
        minutesLeft: b.minutesLeft,
        allMinutesLeft: b.allMinutesLeft,
        closed: snapshot.trading !== true,
        flowSource: snapshot.flowSource,
        stale: snapshot.stale === true,
        fallback: snapshot.fallback,
      })
      return React.createElement(
        'div',
        {
          className: 'tw-badge',
          style: { color: LEVEL_COLOR[2], borderColor: LEVEL_COLOR[2], cursor: 'help' },
          tabIndex: 0,
          role: 'note',
          'aria-label': badge.reason,
          title: [
            badge.reason,
            `熔断明细（按主机独立计数）：${b.detail.filter((h) => h.open).map((h) => `${h.host} 剩余 ${h.minutesLeft} 分钟（连续熔断 ${h.trips} 次）`).join('；')}`,
            `最后错误：${b.lastError ?? '—'}`,
            '熔断期间不再请求「熔断中的东财主机」（避免把限流推成封锁）；腾讯/新浪备用数据源不受影响，「立即采样」照常可用。',
            '熔断是进程级状态，不随面板开关变化。',
          ].join('\n'),
        },
        badge.marker,
      )
    })(),
    /**
     * 交易日历告警（未更新到本月 / 文件损坏被隔离）——**必须在面板上可见**：
     * 退回内置规则意味着"这个月可能有假期被当成交易日采样"，用户要能立刻看到并去补文件。
     */
    snapshot?.calendarStatus != null && snapshot.calendarStatus.warning != null
      ? React.createElement('div', {
          className: 'tw-muted',
          style: { fontSize: 12, color: 'var(--tw-warn)', padding: '2px 0' },
          title: `交易日历文件：${snapshot.calendarStatus.path}`,
        }, `⚠ ${snapshot.calendarStatus.warning}`)
      : null,
    loading && data === null ? React.createElement(Skeleton, { lines: 3, height: 20 }) : null,
    // B3 缺失收缩（DESIGN-DASHBOARD §4）：取数失败（空壳）或没有快照时，塌成**一行**
    // `— + 原因 + 重试`（≤60px）——此前 `etfs.length===0` 会默认展开一个空壳，白占 150px。
    rescueEmpty || (snapshot === null && error !== null && !loading)
      ? React.createElement('div', {
          className: 'tw-hint',
          style: { padding: '2px 10px 8px', display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' },
          tabIndex: 0,
          role: 'note',
          'aria-label': `护盘通道本次未取到：${error ?? '上游未取到宽基通道数据（下一次采样自动重试）'}`,
        },
          React.createElement('span', { className: 'tw-muted' }, '护盘通道 —'),
          error !== null
            ? React.createElement('span', { className: 'tw-muted', title: error }, shortReason(error))
            : paused
              // 时段性（收盘/午休/周末/未开盘）：这不是故障，别写成"上游未返回"
              ? React.createElement('span', { className: 'tw-muted' }, `${pauseReason}，无采样（下次开盘自动重试）`)
              : React.createElement('span', { className: 'tw-muted' }, '上游本次未取到（下次采样自动重试）'),
          React.createElement(Btn, { onClick: () => load(true) }, '重试'),
        )
      : !expanded && snapshot !== null
        ? React.createElement('div', { className: 'tw-hint', style: { padding: '2px 10px 8px' } },
            RESCUE_LEVEL_DESC[level])
        : null,
    // 上游不可用时的「当日记录」条：通道本身由常规卡片区渲染（含复盘态）
    snapshot !== null && snapshot.fallback !== undefined
      ? React.createElement('div', { className: 'tw-rescue-resonance' },
          React.createElement('span', { className: 'tw-muted' }, `当日记录（${snapshot.fallback.day}）`),
          React.createElement('span', null, `采样 ${snapshot.sampleCount} 次`),
          React.createElement('span', null, `5 分钟抽样 ${snapshot.intraday.length} 点`),
          (() => {
            const peak = peakToday
            if (peak === null) return React.createElement('span', { className: 'tw-muted' }, '当日无抽样')
            return React.createElement('span', null,
              `最高评分 ${peak.score} @${peak.hhmm}（${RESCUE_LEVEL_LABEL[peak.level]}）`,
              peak.timeAdjMult !== null ? ` · 量能峰值 ${peak.timeAdjMult.toFixed(2)}x` : '',
              peak.superVsAvg !== null ? ` · 超大单峰值 ${peak.superVsAvg.toFixed(3)}x` : '',
            )
          })(),
          React.createElement('span', null, `触发事件 ${snapshot.today.filter((e) => e.level >= 1).length} 次`),
        )
      : null,
    expanded && snapshot !== null
      ? React.createElement(React.Fragment, null,
          React.createElement('div', { className: 'tw-rescue-resonance' },
            React.createElement('span', { className: 'tw-muted' }, '共振'),
            snapshot.resonance.intensity === 'none'
              ? React.createElement('span', { className: 'tw-muted' }, '无通道触发')
              : React.createElement('span', null,
                  `${snapshot.resonance.lanes.join('、')}（核心 ${snapshot.resonance.core} / 外围 ${snapshot.resonance.peripheral}）`),
            snapshot.resonance.intensity === 'systemic'
              ? React.createElement('span', { className: 'tw-badge', style: { color: LEVEL_COLOR[3], borderColor: LEVEL_COLOR[3] } }, '系统性（核心通道参与）')
              : snapshot.resonance.intensity === 'local'
                ? React.createElement('span', { className: 'tw-badge' }, '局部（仅外围通道）')
                : null,
          ),
          snapshot.etfs.length > 0
            ? React.createElement('div', { className: 'tw-rescue-cards' },
                ...snapshot.etfs.map((e) => React.createElement(EtfCard, { key: e.secid, etf: e, redUp: props.redUp })),
              )
            : null,
          React.createElement('div', { className: 'tw-rescue-split' },
            React.createElement('div', null,
              React.createElement('div', { className: 'tw-sub-h' }, '因子明细（实测值 / 阈值 / 贡献）'),
              snapshot.factors.length > 0
                ? React.createElement(FactorTable, {
                    factors: snapshot.factors,
                    contrib: snapshot.factorContrib,
                    timeCoef: snapshot.timeCoef,
                    total: snapshot.score,
                  })
                : React.createElement('div', { className: 'tw-hint' }, '无实时数据：本次快照没有因子得分（上游不可用时只提供复盘数据）。'),
            ),
            React.createElement('div', null,
              React.createElement('div', { className: 'tw-sub-h' },
                '分时量能',
                React.createElement('span', { style: { flex: 1 } }),
                ...lanes.slice(0, 6).map((m) =>
                  React.createElement('span', {
                    key: m.secid, className: 'tw-chip', 'data-on': m.secid === lane,
                    onClick: () => setLane(m.secid), title: m.name,
                  }, m.index),
                ),
              ),
              React.createElement(PulseChart, {
                trend, base: laneBase, curve: data?.calibration?.progressCurve ?? null, loading: trendLoading,
                amountReason: trendAmountReason,
              }),
              React.createElement('div', {
                className: 'tw-hint',
                style: { fontSize: 12 },
                title: '分时量能按 60 秒节拍刷新（与护盘采样同频；节流后最多旧 60 秒）。柱＝每分钟成交额，本身按分钟聚合。',
              },
                '柱＝每分钟成交额；虚线＝同时点基准（20日均额 × 标定的日内进度曲线）；红柱＝达同时点 2.5 倍以上的脉冲。',
              ),
            ),
          ),
          snapshot.bottom !== undefined && snapshot.bottom.lanes.length > 0
            ? React.createElement('div', { className: 'tw-panel', style: { padding: '6px 8px' } },
                React.createElement('div', { className: 'tw-sub-h' }, '底部位置 / 形态 / 触发后对照',
                  React.createElement('span', { style: { flex: 1 } }),
                  // 保留视图必须显式标注：这是「日线/校准样本暂时拿不到」时的上次结果，
                  // 不是本次计算 —— 否则会被当成刚算出来的实时结论
                  snapshot.bottom.stale === true
                    ? React.createElement('span', {
                        className: 'tw-badge',
                        title: '日线或校准样本暂时不可用，这里展示上一次成功计算的结果（位置/形态/触发后对照都是慢变量，仍可参考）',
                        style: { fontSize: 12, color: 'var(--tw-warn)' },
                      }, `上次结果${
                        typeof snapshot.bottom.computedAt === 'number'
                          // R5：这里曾用 `new Date(x).toTimeString()` ⇒ 按**浏览器时区**渲染
                          // （UTC 浏览器里 14:32 会显示 06:32），与页面其它"数据时刻"不同源。
                          // 一律走 `shClockText`（固定 Asia/Shanghai）。
                          ? ` · ${shClockText(snapshot.bottom.computedAt).slice(0, 5)}`
                          : ''
                      }`)
                    : null,
                  React.createElement('span', { className: 'tw-muted', style: { fontSize: 12 } }, snapshot.bottom.asOf),
                ),
                React.createElement('table', { className: 'tw-rescue-factor' },
                  React.createElement('thead', null, React.createElement('tr', null,
                    React.createElement('th', null, '通道'),
                    React.createElement('th', null, '位置分'), React.createElement('th', null, '60日分位'),
                    React.createElement('th', null, '距60日高'), React.createElement('th', null, '距60日低'), React.createElement('th', null, '连跌'),
                    React.createElement('th', null, '形态分'), React.createElement('th', null, '日内回升'), React.createElement('th', null, '下影线'), React.createElement('th', null, '收回前低'),
                    // P3-3：目标涨幅/持有期缺失时**不再编造 +2%**（表头如实说"未取到"）
                    React.createElement('th', null, calibrationHeaderOf({
                      targetPct: snapshot.bottom.lanes[0].calibration.targets.at(-1)?.targetPct ?? null,
                      horizon: snapshot.bottom.lanes[0].calibration.horizon,
                    })),
                  )),
                  React.createElement('tbody', null,
                    ...snapshot.bottom.lanes.map((l) =>
                      React.createElement('tr', { key: l.secid, 'data-hit': l.positionScore >= 70 },
                        React.createElement('td', null, l.name),
                        React.createElement('td', { style: { fontFamily: 'var(--tw-mono)' } }, String(l.positionScore)),
                        React.createElement('td', { className: 'tw-muted' }, l.position.percentile60 === null ? '—' : `${(l.position.percentile60 * 100).toFixed(0)}%`),
                        React.createElement('td', { className: 'tw-muted' }, l.position.drawdown60 === null ? '—' : `${(l.position.drawdown60 * 100).toFixed(1)}%`),
                        React.createElement('td', { className: 'tw-muted' }, l.position.aboveLow60 === null ? '—' : `+${(l.position.aboveLow60 * 100).toFixed(1)}%`),
                        React.createElement('td', { className: 'tw-muted' }, `${l.position.downStreak} 日`),
                        React.createElement('td', { style: { fontFamily: 'var(--tw-mono)' } }, String(l.patternScore)),
                        React.createElement('td', { className: 'tw-muted' }, l.pattern.bouncePct === null ? '—' : `${l.pattern.bouncePct.toFixed(2)}%`),
                        React.createElement('td', { className: 'tw-muted' }, l.pattern.lowerShadow === null ? '—' : `${(l.pattern.lowerShadow * 100).toFixed(0)}%`),
                        React.createElement('td', { className: 'tw-muted' }, l.pattern.reclaimedPrevLow ? '是' : '否'),
                        React.createElement('td', { className: 'tw-muted', title: '前低时点（北京时间）' }, l.pattern.lowAtTs !== null ? shClockText(l.pattern.lowAtTs).slice(0, 5) : '—'),
                      ),
                    ),
                  ),
                ),
                snapshot.bottom.lanes.length > 0
                  ? React.createElement('div', { className: 'tw-rescue-resonance', style: { marginTop: 6 } },
                      // 区间口径的已知局限（R2 测量后上屏）：**只挂在 title / aria-label**，不占常驻行、
                      // 不写任何数字。来源是校准结果上的 `intervalNote`（单一来源在 shared/model.ts），
                      // 客户端不自己算、也不在这里编一句。
                      React.createElement('span', {
                        className: 'tw-muted',
                        ...(snapshot.bottom.lanes[0].calibration.intervalNote === undefined || snapshot.bottom.lanes[0].calibration.intervalNote === ''
                          ? {}
                          : {
                              title: snapshot.bottom.lanes[0].calibration.intervalNote,
                              'aria-label': `历史频率：${snapshot.bottom.lanes[0].calibration.intervalNote}`,
                            }),
                      }, '历史频率'),
                      // P1-9：概率必须带 Wilson 95% 区间 —— 20 个样本的 80% 与 500 个样本的
                      // 80% 不是一回事，只给点估计会被读成"准确率"
                      ...snapshot.bottom.lanes[0].calibration.targets.map((t) => {
                        const ci = (lo: number | null | undefined, hi: number | null | undefined): string =>
                          lo === null || lo === undefined || hi === null || hi === undefined
                            ? ''
                            : `（95% 区间 ${(lo * 100).toFixed(1)}–${(hi * 100).toFixed(1)}%）`
                        return React.createElement('span', {
                          key: t.targetPct,
                          title:
                            `同类 ${t.prob === null ? '—' : (t.prob * 100).toFixed(1) + '%'}${ci(t.probLo, t.probHi)}` +
                            ` · 基线 ${t.baseRate === null ? '—' : (t.baseRate * 100).toFixed(1) + '%'}${ci(t.baseLo, t.baseHi)}`,
                        },
                          `+${(t.targetPct * 100).toFixed(0)}%：${t.prob === null ? '—' : (t.prob * 100).toFixed(1) + '%'}` +
                          (t.probLo != null && t.probHi != null ? `［${(t.probLo * 100).toFixed(1)}–${(t.probHi * 100).toFixed(1)}］` : '') +
                          ` vs 基线 ${t.baseRate === null ? '—' : (t.baseRate * 100).toFixed(1) + '%'}`,
                        )
                      }),
                      // 样本量必须与区间一起读：不足以支撑结论时要显式说出来
                      snapshot.bottom.lanes[0].calibration.sampleSmall === true
                        ? React.createElement('span', {
                            className: 'tw-badge',
                            style: { color: 'var(--tw-warn)', borderColor: 'var(--tw-warn)' },
                            title: `同类样本 N=${snapshot.bottom.lanes[0].calibration.n} < 30：样本不足，仅作参考`,
                          }, '样本少')
                        : null,
                      React.createElement('span', { className: 'tw-muted' }, `样本 N=${snapshot.bottom.lanes[0].calibration.n}（基线 ${snapshot.bottom.lanes[0].calibration.baseN}${snapshot.bottom.lanes[0].calibration.baseSampleSmall === true ? ' · 偏少' : ''}）`),
                      React.createElement('span', null, `前向${snapshot.bottom.lanes[0].calibration.horizon}日收益中位数 ${snapshot.bottom.lanes[0].calibration.medianForward === null ? '—' : (snapshot.bottom.lanes[0].calibration.medianForward * 100).toFixed(2) + '%'}`),
                      React.createElement('span', null, `期间最大回撤中位数 ${snapshot.bottom.lanes[0].calibration.medianDrawdown === null ? '—' : (snapshot.bottom.lanes[0].calibration.medianDrawdown * 100).toFixed(2) + '%'}`),
                    )
                  : null,
                // IMPL-79（用户要求）：这三段披露（宿主口径句 + 两段红线）不再常驻占版面，
                // 收进**一行**入口：鼠标悬停读 title、键盘 Tab 到读 aria-label（事实一条不少）。
                React.createElement('div', {
                  className: 'tw-hint tw-rescue-caliber-entry',
                  tabIndex: 0,
                  role: 'note',
                  'data-role': 'rescue-caliber',
                  title: caliberEntry.title,
                  'aria-label': caliberEntry.ariaLabel,
                  style: { fontSize: 12, marginTop: 4, cursor: 'help' },
                }, caliberEntry.label),
              )
            : null,
          React.createElement('div', { className: 'tw-rescue-split' },
            React.createElement('div', null,
              React.createElement('div', { className: 'tw-sub-h' }, `今日信号时间线（${snapshot.today.length}）`),
              snapshot.today.length === 0
                ? React.createElement('div', { className: 'tw-hint', style: { padding: '6px 2px' } }, '今日暂无信号事件。')
                : React.createElement('div', { className: 'tw-rescue-timeline' },
                    ...snapshot.today.map((e) =>
                      React.createElement('div', { key: `${e.ts}-${e.level}`, className: 'tw-rescue-tl-row' },
                        React.createElement('span', { style: { fontFamily: 'var(--tw-mono)', color: LEVEL_COLOR[e.level] } }, e.hhmm),
                        React.createElement('span', { className: 'tw-badge', style: { color: LEVEL_COLOR[e.level], borderColor: LEVEL_COLOR[e.level] } }, RESCUE_LEVEL_LABEL[e.level]),
                        // 时间线每条也给同一枚覆盖广度短标记（缺字段 ⇒ `—` + 原因，不写 0 顶替）
                        React.createElement(CoverageMark, { cov: e.coverage, why: e.coverageWhy, enabled: snapshot.coverageEnabled === true }),
                        e.engine === undefined
                          ? React.createElement('span', { className: 'tw-badge', title: '该事件由更早的评分口径记录（因子构成与当前不同，仅作历史留痕）' }, '旧口径')
                          : null,
                        React.createElement('span', { className: 'tw-muted', style: { fontSize: 12, flex: 1, minWidth: 0 } }, e.reason),
                      ),
                    ),
                  ),
              React.createElement('div', { className: 'tw-hint', style: { fontSize: 12 } },
                '注：「旧口径」标记的事件是升级前记录的，其评分逻辑与当前不同（例如尾盘脉冲口径、时点系数未接入），不得与今天的信号比较。'),
              React.createElement('div', { className: 'tw-sub-h', style: { marginTop: 8 } }, `今日 5 分钟抽样（${snapshot.intraday.length}）`),
              snapshot.intraday.length === 0
                ? React.createElement('div', { className: 'tw-hint' }, '尚未累积当日抽样点。')
                : React.createElement('div', { className: 'tw-rescue-intraday' },
                    ...snapshot.intraday.map((p) =>
                      React.createElement('span', {
                        key: p.hhmm, className: 'tw-rescue-ip', title: `${p.hhmm} 评分 ${p.score} · 量能 ${fmtX(p.timeAdjMult)} · 超大单比均额 ${fmtX(p.superVsAvg, 3)}`,
                        style: { background: LEVEL_COLOR[p.level], opacity: Math.max(0.25, Math.min(1, p.score / 100)) },
                      }),
                    ),
                  ),
            ),
            React.createElement('div', null,
              React.createElement('div', { className: 'tw-sub-h', style: { marginTop: 8 } }, `历史回看（${data?.history.length ?? 0} 天，自采样器上线起）`),
              (data?.history.length ?? 0) === 0
                ? React.createElement('div', { className: 'tw-hint', style: { padding: '6px 2px' } },
                    '尚无历史记录：host 采样器已启动，交易时段会自动累积（免费源无 ETF 资金流历史，历史回看只能从上线日算起）。')
                : React.createElement('div', { className: 'tw-rescue-history' },
                    ...(data?.history ?? []).map((h) =>
                      // 键盘可达（P2-6）：历史回看行是点击型 div
                      React.createElement('div', {
                        key: h.day,
                        className: 'tw-rescue-h-row',
                        role: 'button',
                        tabIndex: 0,
                        'aria-label': `${h.day} 历史回看（峰值 ${h.maxScore}）`,
                        onClick: () => openHistory(h.day),
                        onKeyDown: (e: React.KeyboardEvent) => {
                          if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault()
                            openHistory(h.day)
                          }
                        },
                      },
                        React.createElement('span', { style: { fontFamily: 'var(--tw-mono)', fontSize: 12 } }, h.day),
                        React.createElement('span', { className: 'tw-badge', style: { color: LEVEL_COLOR[h.maxLevel], borderColor: LEVEL_COLOR[h.maxLevel] } }, RESCUE_LEVEL_LABEL[h.maxLevel]),
                        React.createElement('span', { className: 'tw-muted', style: { fontSize: 12 } }, `峰值 ${h.maxScore}${h.peakHhmm !== null ? ` @${h.peakHhmm}` : ''}`),
                        React.createElement('span', { style: { flex: 1 } }),
                        React.createElement('span', { className: 'tw-muted', style: { fontSize: 12 } }, `触发 ${h.events} 次`),
                      ),
                    ),
                  ),
            ),
          ),
        )
      : null,
    settings
      ? React.createElement(SettingsModal, {
          config,
          onClose: () => setSettings(false),
          onSave: saveConfig,
        })
      : null,
    openDay !== null
      ? React.createElement(DayModal, {
          day: openDay,
          detail: dayDetail,
          err: dayErr,
          coverageEnabled: snapshot?.coverageEnabled === true,
          onRetry: () => openHistory(openDay),
          onClose: () => setOpenDay(null),
        })
      : null,
    React.createElement('div', { className: 'tw-hint', style: { fontSize: 12, padding: '4px 10px 0' } },
      '口径说明：识别的是「符合国家队历史行为模式的宽基 ETF 放量 + 超大单净流入」，' +
      '汇金/国新/诚通不披露日内成交，因此这是概率性信号而非身份确认；超大单为东财按单笔金额的分类口径，ETF 天量含做市与套利盘。',
    ),
  )
}

function SettingsModal(props: {
  config: RescueConfig
  onClose: () => void
  onSave: (patch: Partial<RescueConfig>) => void
}): React.ReactElement {
  const [enabled, setEnabled] = React.useState(props.config.enabled)
  const [intervalSec, setIntervalSec] = React.useState(String(props.config.intervalSec))
  const [tailIntervalSec, setTailIntervalSec] = React.useState(String(props.config.tailIntervalSec))
  const [tailFrom, setTailFrom] = React.useState(props.config.tailFrom)
  const [universe, setUniverse] = React.useState<string[]>(props.config.universe)
  const [custom, setCustom] = React.useState<RescueCustomChannel[]>(props.config.custom ?? [])
  const [newSecid, setNewSecid] = React.useState('')
  const [newName, setNewName] = React.useState('')
  const [newIndex, setNewIndex] = React.useState('')
  const [err, setErr] = React.useState<string | null>(null)

  const toggle = (secid: string): void => {
    setUniverse((prev) => (prev.includes(secid) ? prev.filter((s) => s !== secid) : [...prev, secid]))
  }

  const submit = (): void => {
    const iv = Number(intervalSec)
    const tv = Number(tailIntervalSec)
    if (!Number.isFinite(iv) || iv < 5 || iv > 600) {
      setErr('常态采样间隔需在 5–600 秒之间')
      return
    }
    if (!Number.isFinite(tv) || tv < 5 || tv > 600) {
      setErr('尾盘采样间隔需在 5–600 秒之间')
      return
    }
    const tm = /^(\d{2}):(\d{2})$/.exec(tailFrom)
    if (tm === null || Number(tm[1]) > 23 || Number(tm[2]) > 59) {
      setErr('尾盘起始时刻应为 00:00–23:59 之间的 HH:mm')
      return
    }
    for (const c of custom) {
      if (!/^[0-9]\.[A-Za-z0-9]{4,8}$/.test(c.secid)) {
        setErr(`自定义通道代码格式应为「市场.代码」，如 1.512480（半导体ETF）：${c.secid}`)
        return
      }
    }
    props.onSave({ enabled, intervalSec: Math.round(iv), tailIntervalSec: Math.round(tv), tailFrom, universe, custom })
    props.onClose()
  }

  return React.createElement(Modal, { title: '护盘监测设置', onClose: props.onClose, width: 560 },
    React.createElement(ErrorNote, { error: err }),
    React.createElement(Field, { label: '启用常驻采样（交易时段自动记录，页面关闭也在跑）' },
      React.createElement('input', { type: 'checkbox', checked: enabled, onChange: (e) => setEnabled(e.target.checked) }),
    ),
    React.createElement(Field, { label: '常态采样间隔（秒）' },
      React.createElement('input', { className: 'tw-input', value: intervalSec, onChange: (e) => setIntervalSec(e.target.value), inputMode: 'numeric' }),
    ),
    React.createElement(Field, { label: '尾盘采样间隔（秒）' },
      React.createElement('input', { className: 'tw-input', value: tailIntervalSec, onChange: (e) => setTailIntervalSec(e.target.value), inputMode: 'numeric' }),
    ),
    React.createElement(Field, { label: '尾盘起始时刻（HH:mm，之后切到尾盘频率）' },
      React.createElement('input', { className: 'tw-input', value: tailFrom, onChange: (e) => setTailFrom(e.target.value), placeholder: '14:30' }),
    ),
    React.createElement(Field, { label: '监测通道' },
      React.createElement('div', { className: 'tw-rescue-pool' },
        ...RESCUE_ETF_CATALOG.map((m) =>
          React.createElement('label', { key: m.secid, className: 'tw-rescue-pool-item', 'data-on': universe.includes(m.secid) || (universe.length === 0 && m.core) },
            React.createElement('input', {
              type: 'checkbox',
              checked: universe.length === 0 ? m.core : universe.includes(m.secid),
              onChange: () => toggle(m.secid),
            }),
            `${m.name} · ${m.index}`,
          ),
        ),
      ),
    ),
    React.createElement(Field, { label: '自定义通道（板块 ETF 等；仅展示量能与脉冲，不计入护盘评分与共振）' },
      React.createElement('div', { className: 'tw-rescue-pool' },
        ...custom.map((c) =>
          React.createElement('label', { key: c.secid, className: 'tw-rescue-pool-item', 'data-on': true },
            React.createElement('span', null, `${c.name}（${c.secid}）${c.index !== undefined ? ` · ${c.index}` : ''}`),
            React.createElement(Btn, {
              onClick: () => setCustom((prev) => prev.filter((x) => x.secid !== c.secid)),
            }, '移除'),
          ),
        ),
        custom.length === 0 ? React.createElement('span', { className: 'tw-muted', style: { fontSize: 12 } }, '尚未添加自定义通道') : null,
      ),
      React.createElement('div', { style: { display: 'flex', gap: 6, marginTop: 6, flexWrap: 'wrap' } },
        React.createElement('input', { className: 'tw-input', style: { width: 110 }, placeholder: '1.512480', value: newSecid, onChange: (e) => setNewSecid(e.target.value) }),
        React.createElement('input', { className: 'tw-input', style: { width: 130 }, placeholder: '半导体ETF', value: newName, onChange: (e) => setNewName(e.target.value) }),
        React.createElement('input', { className: 'tw-input', style: { width: 96 }, placeholder: '板块备注', value: newIndex, onChange: (e) => setNewIndex(e.target.value) }),
        React.createElement(Btn, {
          onClick: () => {
            // 保留原始大小写（114.lhm 这类后缀区分大小写）；主机侧另有 SECID_RE 校验
            const secid = newSecid.trim()
            const name = newName.trim()
            if (!/^[0-9]\.[A-Za-z0-9]{4,8}$/.test(secid)) { setErr('代码格式应为「市场.代码」，如 1.512480'); return }
            if (name === '') { setErr('请填写通道名称'); return }
            if (custom.some((c) => c.secid === secid)) { setErr('该通道已存在'); return }
            setCustom((prev) => [...prev, { secid, name, index: newIndex.trim() === '' ? undefined : newIndex.trim() }])
            setNewSecid(''); setNewName(''); setNewIndex(''); setErr(null)
          },
        }, '添加'),
      ),
      React.createElement('div', { className: 'tw-hint', style: { marginTop: 4 } },
        '代码取自东财 secid 前缀：沪市 1.（如 1.512480 半导体ETF）、深市 0.（如 0.159915）。' +
        '自定义通道与宽基分开统计，避免把板块异动读成国家队护盘。',
      ),
    ),
    React.createElement('div', { className: 'tw-hint' },
      '采样时段 09:25–11:35 / 12:55–15:05，每次采样 1 个批量请求（约 2 请求/分钟）；' +
      '非交易时段不产生请求。',
    ),
    React.createElement('div', { style: { display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 10 } },
      React.createElement(Btn, { onClick: submit, primary: true }, '保存'),
      React.createElement(Btn, { onClick: props.onClose }, '取消'),
    ),
  )
}

function DayModal(props: {
  day: string
  detail: { events: RescueSignalEvent[]; intraday: RescueIntradayPoint[] } | null
  /** 取数失败原因（非 null ⇒ 只显示原因 + 重试，**不显示"无信号/无抽样"**） */
  err: string | null
  /** 覆盖广度附加分开关（阶段一/阶段二）：只影响悬停里那句状态，不影响读数 */
  coverageEnabled?: boolean | null
  onRetry: () => void
  onClose: () => void
}): React.ReactElement {
  const d = props.detail
  /** 三态由纯函数决定（`rescueView.dayHistoryStateOf`，可单测）：失败态**不渲染**任何"无信号/无抽样"的句子 */
  const state = dayHistoryStateOf({ err: props.err, detail: d })
  return React.createElement(Modal, { title: `${props.day} 护盘信号回看`, onClose: props.onClose, width: 620 },
    state === 'error'
      ? React.createElement('div', {
          className: 'tw-hint',
          style: { color: 'var(--tw-up)' },
          tabIndex: 0,
          role: 'note',
          'aria-label': `历史回看未取到：${props.err}（可重试）`,
        },
          `历史回看本次未取到 —— ${props.err}`,
          React.createElement('div', { style: { marginTop: 8 } },
            React.createElement(Btn, { onClick: props.onRetry, primary: true }, '重试'),
          ),
        )
      : state === 'loading'
      ? React.createElement(Skeleton, { lines: 4, height: 18 })
      : React.createElement(React.Fragment, null,
          React.createElement('div', { className: 'tw-sub-h' }, `信号事件（${d.events.length}）`),
          d.events.length === 0
            ? React.createElement('div', { className: 'tw-hint' }, '当日无信号事件。')
            : d.events.map((e) =>
                React.createElement('div', { key: `${e.ts}-${e.level}`, className: 'tw-rescue-tl-row' },
                  React.createElement('span', { style: { fontFamily: 'var(--tw-mono)', color: LEVEL_COLOR[e.level] } }, e.hhmm),
                  React.createElement('span', { className: 'tw-badge', style: { color: LEVEL_COLOR[e.level], borderColor: LEVEL_COLOR[e.level] } }, RESCUE_LEVEL_LABEL[e.level]),
                  // 历史回看每条同样给短标记（与主线/时间线同一实现）
                  React.createElement(CoverageMark, { cov: e.coverage, why: e.coverageWhy, enabled: props.coverageEnabled === true }),
                  React.createElement('span', { className: 'tw-muted', style: { fontSize: 12, flex: 1, minWidth: 0 } }, `${e.score} 分 · ${e.reason}`),
                ),
              ),
          React.createElement('div', { className: 'tw-sub-h', style: { marginTop: 10 } }, `5 分钟抽样（${d.intraday.length}）`),
          d.intraday.length === 0
            ? React.createElement('div', { className: 'tw-hint' }, '当日无抽样点（可能未处于采样时段）。')
            : React.createElement('div', { className: 'tw-rescue-history' },
                ...d.intraday.map((p) =>
                  React.createElement('div', { key: p.hhmm, className: 'tw-rescue-h-row' },
                    React.createElement('span', { style: { fontFamily: 'var(--tw-mono)', fontSize: 12 } }, p.hhmm),
                    React.createElement('span', { className: 'tw-badge', style: { color: LEVEL_COLOR[p.level], borderColor: LEVEL_COLOR[p.level] } }, RESCUE_LEVEL_LABEL[p.level]),
                    React.createElement('span', { className: 'tw-muted', style: { fontSize: 12 } }, `评分 ${p.score}`),
                    React.createElement('span', { style: { flex: 1 } }),
                    React.createElement('span', { className: 'tw-muted', style: { fontSize: 12 } }, `量能 ${fmtX(p.timeAdjMult)} · 超大单比均额 ${fmtX(p.superVsAvg, 3)}`),
                  ),
                ),
              ),
        ),
  )
}
