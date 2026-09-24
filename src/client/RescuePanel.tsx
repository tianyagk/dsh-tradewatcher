/**
 * 【护盘信号】面板：国家队潜在护盘行为的概率性监测。
 *
 * 设计要点：
 *  - 常驻状态条（等级/评分/归因/采样节奏），信号 ≥ 疑似时面板自动展开
 *  - 六因子明细表把「实测值 / 阈值 / 来源」全部摆出来，便于自查，不做黑箱
 *  - 分时量能图：分钟成交额柱 + 同时点基准线（用标定的日内进度曲线算），超出 2× 的柱子高亮
 *  - 信号时间线 + 近 60 日历史回看（自采样器上线日起）
 */
import * as React from 'react'
import type {
  PortPrefs, RescueConfig, RescueDaySummary, RescueEtfMeta, RescueEtfView, RescueFactor,
  RescueIntradayPoint, RescueLevel, RescueSignalEvent, RescueSnapshot, TrendData,
} from '../shared/model'
import { RESCUE_CORE_INDEXES, RESCUE_ETF_CATALOG, RESCUE_LEVEL_DESC, RESCUE_LEVEL_LABEL, rescueUniverseMeta } from '../shared/model'
import { api } from './api'
import { Btn, ErrorNote, Field, Modal, Skeleton } from './ui'

const LEVEL_COLOR: Record<RescueLevel, string> = {
  0: 'var(--tw-fg-dim, #8b93a7)',
  1: '#5da5ff',
  2: '#f0a63a',
  3: '#f2555a',
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

interface RescueData {
  snapshot: RescueSnapshot
  history: RescueDaySummary[]
  calibration?: Calibration
  breaker?: { open: boolean; until: number; trips: number; minutesLeft: number; lastError: string | null }
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
function ScoreBar(props: { value: number; color?: string; width?: number }): React.ReactElement {
  const pct = Math.max(0, Math.min(100, props.value))
  return React.createElement('div', { className: 'tw-rescue-bar', style: { width: props.width ?? 72 } },
    React.createElement('i', { style: { width: `${pct}%`, background: props.color ?? 'currentColor' } }),
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
  a.download = `护盘信号_${new Date(snap.ts).toISOString().slice(0, 10)}.csv`
  a.click()
  URL.revokeObjectURL(url)
}

/** 分时量能图：分钟成交额柱 + 同时点基准线 + 超阈值高亮 */
function PulseChart(props: {
  trend: TrendData | null
  base: number | null
  curve: number[] | null
  loading: boolean
}): React.ReactElement {
  const { trend, base, curve } = props
  if (props.loading) return React.createElement(Skeleton, { lines: 4, height: 20 })
  const pts = (trend?.points ?? []).filter((p) => typeof p.amount === 'number' && (p.amount ?? 0) > 0)
  if (pts.length < 5) {
    return React.createElement('div', { className: 'tw-hint', style: { padding: '10px 4px' } }, '暂无分钟成交额数据（该标的当日分时不可用）')
  }
  const W = 620
  const H = 118
  const padL = 4
  const amounts = pts.map((p) => p.amount ?? 0)
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
  const baseline = base !== null && base > 0
    ? React.createElement('polyline', {
        points: expected.map((v, i) => `${padL + i * bw + bw * 0.4},${y(v)}`).join(' '),
        fill: 'none', stroke: 'var(--tw-fg-dim, #8b93a7)', strokeWidth: 1, strokeDasharray: '3 3', opacity: 0.8,
      })
    : null
  return React.createElement('svg', { viewBox: `0 0 ${W} ${H}`, width: '100%', height: H, preserveAspectRatio: 'none', className: 'tw-rescue-svg' },
    React.createElement('line', { x1: 0, y1: H, x2: W, y2: H, stroke: 'var(--tw-line, #262a33)', strokeWidth: 1 }),
    ...bars,
    baseline,
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
      React.createElement('span', { style: { color: pctColor(etf.pct, redUp), fontFamily: 'var(--tw-mono)' } }, fmtPct(etf.pct)),
    ),
    React.createElement('div', { className: 'tw-rescue-card-grid' },
      React.createElement('span', { className: 'k' }, '成交额'),
      React.createElement('span', { className: 'v' }, fmtYi(etf.amount)),
      React.createElement('span', { className: 'k' }, '量比'),
      React.createElement('span', { className: 'v' }, etf.volRatio === null ? '—' : etf.volRatio.toFixed(2)),
      React.createElement('span', { className: 'k' }, '同时点量能'),
      React.createElement('span', { className: 'v', style: { color: (etf.timeAdjMult ?? 0) >= 1.63 ? LEVEL_COLOR[3] : undefined } }, fmtX(etf.timeAdjMult)),
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
      React.createElement('span', { className: 'tw-muted', style: { fontSize: 10.5 } }, `活跃度 ${etf.activity}`),
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

function FactorTable(props: { factors: RescueFactor[] }): React.ReactElement {
  return React.createElement('table', { className: 'tw-rescue-factor' },
    React.createElement('thead', null,
      React.createElement('tr', null,
        React.createElement('th', null, '因子'),
        React.createElement('th', null, '实测'),
        React.createElement('th', { style: { width: 46 } }, '得分'),
        React.createElement('th', { style: { width: 36 } }, '权重'),
        React.createElement('th', null, '阈值口径'),
      ),
    ),
    React.createElement('tbody', null,
      ...props.factors.map((f) =>
        React.createElement('tr', { key: f.id, 'data-hit': f.hit },
          React.createElement('td', null, f.hit ? React.createElement('span', { style: { color: LEVEL_COLOR[2] } }, '● ') : React.createElement('span', { className: 'tw-muted' }, '○ '), f.label),
          React.createElement('td', { style: { fontFamily: 'var(--tw-mono)' } }, f.actual),
          React.createElement('td', null, React.createElement(ScoreBar, { value: f.score, width: 40, color: f.hit ? LEVEL_COLOR[2] : 'var(--tw-fg-dim)' })),
          React.createElement('td', { className: 'tw-muted' }, f.weight.toFixed(2)),
          React.createElement('td', { className: 'tw-muted', style: { fontSize: 10.5 } }, f.threshold),
        ),
      ),
    ),
  )
}

export function RescuePanel(props: { prefs: PortPrefs; redUp: boolean; onPrefs?: (p: PortPrefs) => void }): React.ReactElement {
  const [data, setData] = React.useState<RescueData | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const [loading, setLoading] = React.useState(true)
  const [manualOpen, setManualOpen] = React.useState<boolean | null>(null)
  const [settings, setSettings] = React.useState(false)
  const [lane, setLane] = React.useState<string>(RESCUE_ETF_CATALOG[0].secid)
  const [trend, setTrend] = React.useState<TrendData | null>(null)
  const [trendLoading, setTrendLoading] = React.useState(false)
  const [openDay, setOpenDay] = React.useState<string | null>(null)
  const [dayDetail, setDayDetail] = React.useState<{ events: RescueSignalEvent[]; intraday: RescueIntradayPoint[] } | null>(null)

  const config: RescueConfig = props.prefs.rescue
  const snapshot = data?.snapshot ?? null

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

  // 分时量能图：跟随选中通道
  React.useEffect(() => {
    if (!settings && lane !== '') {
      setTrendLoading(true)
      api
        .trend(lane, 1)
        .then((r) => setTrend(r.trend))
        .catch(() => setTrend(null))
        .finally(() => setTrendLoading(false))
    }
  }, [lane, snapshot?.ts])

  const openHistory = (day: string): void => {
    setOpenDay(day)
    setDayDetail(null)
    api
      .rescueDay(day)
      .then((r) => setDayDetail({ events: r.dayEvents ?? [], intraday: r.dayIntraday ?? [] }))
      .catch(() => setDayDetail({ events: [], intraday: [] }))
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

  const level = snapshot?.level ?? 0
  const expanded = manualOpen ?? level >= 2
  const lanes: RescueEtfMeta[] = rescueUniverseMeta(config.universe)
  const laneBase = snapshot?.etfs.find((e) => e.secid === lane)?.avgAmt20 ?? null

  return React.createElement('div', { className: 'tw-panel tw-rescue' },
    React.createElement('div', { className: 'tw-panel-h' },
      React.createElement('span', {
        className: 'tw-rescue-dot', style: { background: LEVEL_COLOR[level], boxShadow: level >= 2 ? `0 0 8px ${LEVEL_COLOR[level]}` : undefined },
      }),
      React.createElement('span', { className: 't' }, '护盘信号'),
      snapshot !== null
        ? React.createElement('span', { className: 'tw-badge', style: { color: LEVEL_COLOR[level], borderColor: LEVEL_COLOR[level] } }, RESCUE_LEVEL_LABEL[level])
        : null,
      snapshot !== null
        ? React.createElement('span', { className: 'tw-muted', style: { fontFamily: 'var(--tw-mono)', fontSize: 11 } }, `${snapshot.score}/100`)
        : null,
      React.createElement('span', { style: { flex: 1 } }),
      snapshot !== null && (snapshot.stale === true || (data as { staleNote?: string })?.staleNote !== undefined)
        ? React.createElement('span', {
            className: 'tw-badge',
            title: snapshot.note ?? (data as { staleNote?: string })?.staleNote ?? '',
            style: { color: LEVEL_COLOR[1], borderColor: LEVEL_COLOR[1] },
          }, `上次数据 ${snapshot.lastSampleTs !== null ? new Date(snapshot.lastSampleTs).toLocaleTimeString('zh-CN', { hour12: false }).slice(0, 5) : ''}`)
        : null,
      snapshot !== null && (snapshot.completeness?.missing.length ?? 0) > 0
        ? React.createElement('span', {
            className: 'tw-badge',
            title: `本次快照缺少因子：${snapshot.completeness?.missing.join('、')}（评分偏保守；冷启动回填完成或盘中采样 5 分钟后自动补齐）`,
            style: { color: LEVEL_COLOR[2], borderColor: LEVEL_COLOR[2] },
          }, `因子 ${snapshot.completeness?.available}/${snapshot.completeness?.total}`)
        : null,
      snapshot !== null
        ? React.createElement('span', { className: 'tw-muted', style: { fontSize: 10.5 } },
            `${snapshot.trading ? `采样中 · ${snapshot.activeIntervalSec}s` : snapshot.pulseBand.phase === 'closed' ? '已收盘' : '非交易时段'}` +
            `${snapshot.lastSampleTs !== null ? ` · ${new Date(snapshot.lastSampleTs).toLocaleTimeString('zh-CN', { hour12: false })}` : ''}` +
            `${snapshot.gap ? ' · ⚠ 缺口' : ''}`,
          )
        : null,
      React.createElement(Btn, { onClick: () => load(true) }, loading ? '刷新中…' : '立即采样'),
      React.createElement(Btn, { onClick: () => setManualOpen(expanded ? false : true) }, expanded ? '收起' : '展开'),
      React.createElement(Btn, { onClick: () => setSettings(true) }, '设置'),
      snapshot !== null && snapshot.etfs.length > 0
        ? React.createElement(Btn, { onClick: () => exportCsv(snapshot.etfs, snapshot) }, '导出')
        : null,
    ),
    React.createElement(ErrorNote, { error }),
    data?.breaker?.open === true
      ? React.createElement('div', { className: 'tw-hint', style: { color: LEVEL_COLOR[2], padding: '2px 2px 4px' } },
          `上游行情暂时不可用（连续失败已熔断，约 ${data.breaker.minutesLeft} 分钟后自动重试）：` +
          `期间不发起请求以免加重封锁，面板显示当日复盘数据。最后错误：${data.breaker.lastError ?? '—'}`)
      : null,
    loading && data === null ? React.createElement(Skeleton, { lines: 3, height: 20 }) : null,
    snapshot !== null
      ? React.createElement('div', { className: 'tw-rescue-summary' },
          React.createElement('span', { style: { color: LEVEL_COLOR[level], fontWeight: 600, flex: 'none' } }, RESCUE_LEVEL_LABEL[level]),
          React.createElement('span', { className: 'tw-muted', style: { flex: 1, minWidth: 0 } }, snapshot.summary),
          React.createElement('span', { className: 'tw-muted', style: { fontSize: 10.5, flex: 'none' } },
            `${snapshot.indexName} ${fmtPct(snapshot.indexPct)} · ${snapshot.pulseBand.label}${
              snapshot.pulseBand.phase === 'closed' ? '' : snapshot.pulseBand.isTail ? '（满分权重）' : '（脉冲打 0.6 折）'
            } · 阈值来源 ${
              snapshot.thresholdSource === 'self' ? `自建分位（${snapshot.selfSampleDays} 天）` : snapshot.thresholdSource === 'calibrated' ? '历史标定' : `经验锚点（自建样本 ${snapshot.selfSampleDays}/20 天）`
            }`,
          ),
        )
      : null,
    !expanded && snapshot !== null
      ? React.createElement('div', { className: 'tw-hint', style: { padding: '2px 10px 8px' } },
          `${RESCUE_LEVEL_DESC[level]}${level >= 2 ? '' : '（信号达到「疑似护盘」时本面板会自动展开）'}`)
      : null,
    // 上游不可用且无卡片时：渲染当日复盘表，避免整块空白
    snapshot !== null && snapshot.etfs.length === 0 && snapshot.fallback !== undefined
      ? React.createElement('div', { className: 'tw-panel', style: { padding: '6px 8px' } },
          React.createElement('div', { className: 'tw-sub-h' }, `当日通道复盘（${snapshot.fallback.day}）`,
            React.createElement('span', { style: { flex: 1 } }),
            React.createElement('span', { className: 'tw-muted', style: { fontSize: 10.5 } }, '超大单净额 ÷ 20日均额 的当日峰值'),
          ),
          React.createElement('table', { className: 'tw-rescue-factor' },
            React.createElement('thead', null, React.createElement('tr', null,
              React.createElement('th', null, '通道'), React.createElement('th', null, '指数'),
              React.createElement('th', null, '当日峰值'), React.createElement('th', null, '状态'),
            )),
            React.createElement('tbody', null,
              ...snapshot.fallback.peaks.map((p) => {
                const v = p.peakSuperVsAvg
                return React.createElement('tr', { key: p.secid, 'data-hit': (v ?? 0) >= 0.2 },
                  React.createElement('td', null, p.name),
                  React.createElement('td', { className: 'tw-muted' }, p.index),
                  React.createElement('td', { style: { fontFamily: 'var(--tw-mono)' } }, v === null ? '—' : `${v.toFixed(3)}x`),
                  React.createElement('td', { className: 'tw-muted', style: { fontSize: 10.5 } },
                    v === null ? '当日无样本' : v >= 0.2 ? '曾达异动线' : v <= -0.15 ? '当日净流出' : '常态'),
                )
              }),
            ),
          ),
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
                ? React.createElement(FactorTable, { factors: snapshot.factors })
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
              }),
              React.createElement('div', { className: 'tw-hint', style: { fontSize: 10.5 } },
                '柱＝每分钟成交额；虚线＝同时点基准（20日均额 × 标定的日内进度曲线）；红柱＝达同时点 2.5 倍以上的脉冲。',
              ),
            ),
          ),
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
                        e.engine === undefined
                          ? React.createElement('span', { className: 'tw-badge', title: '该事件由更早的评分口径记录（因子构成与当前不同，仅作历史留痕）' }, '旧口径')
                          : null,
                        React.createElement('span', { className: 'tw-muted', style: { fontSize: 10.5, flex: 1, minWidth: 0 } }, e.reason),
                      ),
                    ),
                  ),
              React.createElement('div', { className: 'tw-hint', style: { fontSize: 10.5 } },
                '注：「旧口径」标记的事件是升级前记录的，其评分逻辑与当前不同（例如尾盘脉冲口径、时点系数未接入），不要与今天的信号直接比较。'),
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
              React.createElement('div', { className: 'tw-sub-h' }, `历史回看（${data?.history.length ?? 0} 天，自采样器上线起）`),
              (data?.history.length ?? 0) === 0
                ? React.createElement('div', { className: 'tw-hint', style: { padding: '6px 2px' } },
                    '尚无历史记录：host 采样器已启动，交易时段会自动累积（免费源无 ETF 资金流历史，历史回看只能从上线日算起）。')
                : React.createElement('div', { className: 'tw-rescue-history' },
                    ...(data?.history ?? []).map((h) =>
                      React.createElement('div', { key: h.day, className: 'tw-rescue-h-row', onClick: () => openHistory(h.day) },
                        React.createElement('span', { style: { fontFamily: 'var(--tw-mono)', fontSize: 11 } }, h.day),
                        React.createElement('span', { className: 'tw-badge', style: { color: LEVEL_COLOR[h.maxLevel], borderColor: LEVEL_COLOR[h.maxLevel] } }, RESCUE_LEVEL_LABEL[h.maxLevel]),
                        React.createElement('span', { className: 'tw-muted', style: { fontSize: 10.5 } }, `峰值 ${h.maxScore}${h.peakHhmm !== null ? ` @${h.peakHhmm}` : ''}`),
                        React.createElement('span', { style: { flex: 1 } }),
                        React.createElement('span', { className: 'tw-muted', style: { fontSize: 10.5 } }, `触发 ${h.events} 次`),
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
      ? React.createElement(DayModal, { day: openDay, detail: dayDetail, onClose: () => setOpenDay(null) })
      : null,
    React.createElement('div', { className: 'tw-hint', style: { fontSize: 10.5, padding: '4px 10px 0' } },
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
    props.onSave({ enabled, intervalSec: Math.round(iv), tailIntervalSec: Math.round(tv), tailFrom, universe })
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
    React.createElement(Field, { label: '监测通道（默认核心 6 只；勾选后按指数去重计入共振）' },
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
    React.createElement('div', { className: 'tw-hint' },
      '采样仅在工作日 09:25–11:35 / 12:55–15:05 进行，每次采样 1 个批量请求（约 2 请求/分钟）；' +
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
  onClose: () => void
}): React.ReactElement {
  const d = props.detail
  return React.createElement(Modal, { title: `${props.day} 护盘信号回看`, onClose: props.onClose, width: 620 },
    d === null
      ? React.createElement(Skeleton, { lines: 4, height: 18 })
      : React.createElement(React.Fragment, null,
          React.createElement('div', { className: 'tw-sub-h' }, `信号事件（${d.events.length}）`),
          d.events.length === 0
            ? React.createElement('div', { className: 'tw-hint' }, '当日无信号事件。')
            : d.events.map((e) =>
                React.createElement('div', { key: `${e.ts}-${e.level}`, className: 'tw-rescue-tl-row' },
                  React.createElement('span', { style: { fontFamily: 'var(--tw-mono)', color: LEVEL_COLOR[e.level] } }, e.hhmm),
                  React.createElement('span', { className: 'tw-badge', style: { color: LEVEL_COLOR[e.level], borderColor: LEVEL_COLOR[e.level] } }, RESCUE_LEVEL_LABEL[e.level]),
                  React.createElement('span', { className: 'tw-muted', style: { fontSize: 11, flex: 1, minWidth: 0 } }, `${e.score} 分 · ${e.reason}`),
                ),
              ),
          React.createElement('div', { className: 'tw-sub-h', style: { marginTop: 10 } }, `5 分钟抽样（${d.intraday.length}）`),
          d.intraday.length === 0
            ? React.createElement('div', { className: 'tw-hint' }, '当日无抽样点（可能未处于采样时段）。')
            : React.createElement('div', { className: 'tw-rescue-history' },
                ...d.intraday.map((p) =>
                  React.createElement('div', { key: p.hhmm, className: 'tw-rescue-h-row' },
                    React.createElement('span', { style: { fontFamily: 'var(--tw-mono)', fontSize: 11 } }, p.hhmm),
                    React.createElement('span', { className: 'tw-badge', style: { color: LEVEL_COLOR[p.level], borderColor: LEVEL_COLOR[p.level] } }, RESCUE_LEVEL_LABEL[p.level]),
                    React.createElement('span', { className: 'tw-muted', style: { fontSize: 10.5 } }, `评分 ${p.score}`),
                    React.createElement('span', { style: { flex: 1 } }),
                    React.createElement('span', { className: 'tw-muted', style: { fontSize: 10.5 } }, `量能 ${fmtX(p.timeAdjMult)} · 超大单比均额 ${fmtX(p.superVsAvg, 3)}`),
                  ),
                ),
              ),
        ),
  )
}
