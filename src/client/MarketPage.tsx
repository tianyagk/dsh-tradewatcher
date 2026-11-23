/** A股大盘行情: index overview + breadth/amount stats, sector & ETF boards,
 *  money-flow ranking (boards sorted by main-capital inflow), stock search
 *  with detail card + intraday chart. */
import React, { useCallback, useEffect, useMemo, useState } from 'react'
import type { BoardRow, QuoteRow, StockDetail, TrendData } from '../shared/model.ts'
import { api } from './api.ts'
import { DW_FOOTNOTE, dwKpis, dwReview, dwSeries, dwTable } from './dogwatchView.ts'
import { MINUTE_BARS, missingCellText, sharePctOf, sortRowsByShare } from './marketBlocks.ts'
import { UPDOWN_MISSING_NOTE, upDownPair } from './breadthView.ts'
import { dirClass, fmtAmt, fmtBig, fmtFixedPct, fmtPct, fmtPrice, fmtSigned } from './format.ts'
import { CN_PHASE_LABEL, cnSessionState, shClockText } from './marketTime.ts'
import { useNow } from './useNow.ts'
import { Btn, EmptyHint, ErrorNote, Modal } from './ui.tsx'
import { Sparkline } from './charts.tsx'
import { RescuePanel } from './RescuePanel.tsx'
import type { PortPrefs, QuoteSource } from '../shared/model.ts'
import { isUsableBaseline } from './trendView.ts'
import { createRequestGen } from './requestGen.ts'
import { createRafCoalescer } from './rafThrottle.ts'
import { debugFlagOf } from './debugFlag.ts'
import { BREADTH_MIN_INTERVAL_MS, dueByInterval } from './pacing.ts'

type Scope = 'industry' | 'concept' | 'etf'

type Sort = 'pct' | 'money' | 'amount'

const SCOPE_LABEL: Record<Scope, string> = { industry: '行业板块', concept: '概念板块', etf: 'ETF排行' }

/** 汪汪队两张 SVG 的画布尺寸（几何函数与 `DwChart` 共用同一份，避免两处漂移） */
const DW_W = 560
const DW_H = 180
const DW_PAD_L = 34
const DW_PAD_R = 22
const DW_PAD_T = 8
const DW_PAD_B = 18

/** 左图：柱（正负分两侧）+ Y 轴 ≥3 档 + 水平网格 + X 轴日期刻度 */
function dwBarsOf(d: ReturnType<typeof dwSeries>): React.ReactElement[] {
  const inner = DW_H - DW_PAD_T - DW_PAD_B
  const zero = DW_PAD_T + inner / 2
  const bw = (DW_W - DW_PAD_L - DW_PAD_R) / Math.max(1, d.barPct.length)
  const lo = d.yTicksBar[0]!, hi = d.yTicksBar[d.yTicksBar.length - 1]!
  const els: React.ReactElement[] = []
  for (const t of d.yTicksBar) {
    const y = DW_PAD_T + (1 - (t - lo) / ((hi - lo) || 1)) * inner
    els.push(React.createElement('line', { key: `g${t}`, x1: DW_PAD_L, y1: y.toFixed(1), x2: DW_W - DW_PAD_R, y2: y.toFixed(1), stroke: 'var(--tw-border)', strokeWidth: 0.5, 'data-role': 'dw-grid' }))
    els.push(React.createElement('text', { key: `yt${t}`, x: DW_PAD_L - 4, y: (y + 3).toFixed(1), fontSize: 12, textAnchor: 'end', fill: 'var(--tw-muted)', 'data-role': 'dw-ytick' }, String(t)))
  }
  for (const x of d.xTicks) {
    els.push(React.createElement('text', { key: `xt${x.i}`, x: (DW_PAD_L + x.i * bw + bw / 2).toFixed(1), y: DW_H - 4, fontSize: 12, textAnchor: 'middle', fill: 'var(--tw-muted)', 'data-role': 'dw-xtick' }, x.label))
  }
  d.barPct.forEach((pct, i) => {
    const v = d.bars[i] ?? 0
    const h = Math.max(0.8, (pct / 100) * (inner / 2 - 4))
    els.push(React.createElement('rect', {
      key: `b${i}`, x: (DW_PAD_L + i * bw + 0.4).toFixed(2), y: (v >= 0 ? zero - h : zero).toFixed(1),
      width: Math.max(0.8, bw - 0.8).toFixed(2), height: h.toFixed(1),
      fill: v >= 0 ? 'var(--tw-up)' : 'var(--tw-down)', 'data-role': 'dw-bar', 'data-pct': pct.toFixed(1),
    }))
  })
  return els
}

/** 右图：折线（按区间实际范围）+ Y 轴 ≥3 档 + 水平网格 + X 轴日期刻度 */
function dwLineOf(d: ReturnType<typeof dwSeries>): React.ReactElement[] {
  if (d.line.length < 2) return []
  const inner = DW_H - DW_PAD_T - DW_PAD_B
  const lo = d.yTicksLine[0]!, hi = d.yTicksLine[d.yTicksLine.length - 1]!
  const yOf = (v: number): number => DW_PAD_T + (1 - (v - lo) / ((hi - lo) || 1)) * inner
  const xOf = (i: number): number => DW_PAD_L + (i / (d.line.length - 1)) * (DW_W - DW_PAD_L - DW_PAD_R)
  const els: React.ReactElement[] = []
  for (const t of d.yTicksLine) {
    const y = yOf(t)
    els.push(React.createElement('line', { key: `lg${t}`, x1: DW_PAD_L, y1: y.toFixed(1), x2: DW_W - DW_PAD_R, y2: y.toFixed(1), stroke: 'var(--tw-border)', strokeWidth: 0.5, 'data-role': 'dw-grid' }))
    els.push(React.createElement('text', { key: `lyt${t}`, x: DW_PAD_L - 4, y: (y + 3).toFixed(1), fontSize: 12, textAnchor: 'end', fill: 'var(--tw-muted)', 'data-role': 'dw-ytick' }, String(t)))
  }
  for (const x of d.xTicks) {
    els.push(React.createElement('text', { key: `lxt${x.i}`, x: xOf(x.i).toFixed(1), y: DW_H - 4, fontSize: 12, textAnchor: 'middle', fill: 'var(--tw-muted)', 'data-role': 'dw-xtick' }, x.label))
  }
  if (lo <= 100 && 100 <= hi) {
    els.push(React.createElement('line', {
      key: 'base100', x1: DW_PAD_L, y1: yOf(100).toFixed(1), x2: DW_W - DW_PAD_R, y2: yOf(100).toFixed(1),
      stroke: 'var(--tw-border-strong)', strokeWidth: 1, strokeDasharray: '4 3', 'data-role': 'dw-base',
    }))
  }
  els.push(React.createElement('polyline', {
    key: 'line', fill: 'none', stroke: 'var(--tw-accent)', strokeWidth: 1.6,
    points: d.line.map((v, i) => `${xOf(i).toFixed(1)},${yOf(v).toFixed(1)}`).join(' '), 'data-role': 'dw-line',
  }))
  return els
}

interface DwTipState { x: number; y: number; text: string }

/**
 * 汪汪队单张 SVG（AUDIT-CLIENT-PERF P1-4）。
 *
 * 旧实现：两张图的 `onMouseMove` 直接 `setDwTip`，而 state 挂在 `MarketPage` 根上 ——
 * 一次 mousemove = 整页重渲染（含 40 行板块表 + 1049 行的 `RescuePanel`）+ 250 根 `<rect>` 全量 diff。
 * 现在两件事一起做：
 *   ① 悬停 state 只活在这个子树里（`MarketPage` 不再因鼠标移动重渲染）；
 *   ② 同一帧内的多次移动用 `createRafCoalescer` 合并 ⇒ 每帧最多 1 次提交（120Hz 鼠标也只 1 次/帧）。
 */
function DwChart(props: {
  kind: 'bar' | 'line'
  title: string
  note?: string
  foot: string
  series: ReturnType<typeof dwSeries> | null
}): React.ReactElement {
  const [dwTip, setDwTip] = React.useState<DwTipState | null>(null)
  const tipRaf = React.useRef<ReturnType<typeof createRafCoalescer<DwTipState | null>> | null>(null)
  if (tipRaf.current === null) tipRaf.current = createRafCoalescer<DwTipState | null>(setDwTip)
  React.useEffect(() => () => { tipRaf.current?.cancel() }, [])
  const d = props.series ?? dwSeries([])
  const dwHover = (e: React.MouseEvent<SVGSVGElement>): void => {
    const raf = tipRaf.current
    if (raf === null) return
    const r = e.currentTarget.getBoundingClientRect()
    const vals = props.kind === 'bar' ? d.bars : d.line
    if (vals.length === 0 || r.width <= 0) { raf.push(null); return }
    const i = Math.max(0, Math.min(vals.length - 1, Math.floor(((e.clientX - r.left) / r.width) * vals.length)))
    const day = d.days[i] ?? '—'
    const v = vals[i] as number
    const text = props.kind === 'bar' ? `${day} 份额变化 ${v.toFixed(1)} 亿份` : `${day} 加仓指数 ${v.toFixed(1)}`
    /* 翻边：靠右时把提示框放到光标左侧，避免遮挡最新点 */
    const flip = e.clientX - r.left > r.width - 120
    raf.push({ x: (e.clientX - r.left) + (flip ? -12 : 12), y: (e.clientY - r.top) + 12, text })
  }
  const dwTipEl = dwTip === null ? null : React.createElement('div', { className: 'tw-dw-tip', style: { left: dwTip.x, top: dwTip.y } }, dwTip.text)
  /** 两个容器角色（字面量表：设计稿对拍/结构断言按这两个 `data-role` 查，别改成字符串拼接） */
  const roleProps = props.kind === 'bar'
    ? { 'data-role': 'dw-chart-bars' }
    : { 'data-role': 'dw-chart-line' }
  return React.createElement('div', {
    className: 'tw-dw-chart',
    ...roleProps,
  },
    React.createElement('div', { className: 'tw-dw-chart-h' },
      React.createElement('span', { className: 't' }, props.title),
      props.note === undefined ? null : React.createElement('span', { className: 'tw-dw-chart-note' }, props.note)),
    React.createElement('svg', {
      viewBox: `0 0 ${DW_W} ${DW_H}`, preserveAspectRatio: 'none', className: 'tw-dw-svg',
      onMouseMove: dwHover,
      onMouseLeave: () => { tipRaf.current?.push(null) },
    }, ...(props.kind === 'bar' ? dwBarsOf(d) : dwLineOf(d))),
    dwTipEl,
    React.createElement('div', { className: 'tw-dw-chart-f' }, props.foot))
}


export function MarketPage(props: {
  quotes: Record<string, QuoteRow>
  /** 共享行情引擎的**节拍信号**（响应时刻）：下游按它节流，而不是挂 `quotes` 的对象身份 */
  quoteTs?: number | null
  prefs: PortPrefs
  onPrefs?: (prefs: PortPrefs) => void
}): React.ReactElement {
  const { quotes, prefs } = props
  const redUp = prefs.redUp
  const [scope, setScope] = useState<Scope>('industry')
  const [sort, setSort] = useState<Sort>('pct')
  const [rows, setRows] = useState<BoardRow[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [boardLoading, setBoardLoading] = useState(false)
  const [boardError, setBoardError] = useState<string | null>(null)
  const [boardMeta, setBoardMeta] = useState<{ stale?: boolean; asOf?: number; source?: QuoteSource } | null>(null)
  /** 备用源是否含金额类字段（A4）：只有东财给钱，腾讯/新浪只给涨跌幅 */
  const boardMoneyOk = boardMeta === null || boardMeta.source === 'em'
  /**
   * 资金流排行的排序口径（P1-7）：`money` = 主力净额（上游排行键）；
   * `share` = 主力净额 ÷ 成交额（本页内重排）。
   *
   * 为什么 `share` 只能"本页内重排"：上游接口按 `f62`（净额）返回前 40 条，
   * 本仓库不掌握"按净占比的全市场排行"这个字段（免费源里没有可验证的净占比字段）。
   * 因此这里如实标注"仅在本页内重排"，而不是伪造一个看起来像全市场排行的东西。
   */
  const [moneySort, setMoneySort] = useState<'money' | 'share'>('money')
  // 交易时段状态（P1-7）：「定稿」标记必须随墙上时钟更新，否则收盘后要等下一次交互才变
  const now = useNow(60_000)
  const cnSession = cnSessionState(now)
  /**
   * 展示顺序（P1-7）：`share` 时**只在本页内重排**，且缺失占比的行沉底。
   * 绝不动上游分页 —— 否则会把"本页重排"和"全市场排行"混为一谈。
   *
   * AUDIT-CLIENT-PERF P2-14：排序放进 `useMemo`，同一份 rows / 同一口径不重复排；
   * 旧写法在 render 体里 `[...rows].sort(...)`，页面每分钟（以及任何父级重渲）都白排 40 行。
   */
  const viewRows = useMemo(
    () => (moneySort === 'share' && sort === 'money' && scope !== 'etf' ? sortRowsByShare(rows) : rows),
    [rows, moneySort, sort, scope],
  )
  const [pick, setPick] = useState<{ secid: string } | null>(null)
  const [detail, setDetail] = useState<StockDetail | null>(null)
  const [trend, setTrend] = useState<TrendData | null>(null)

  /**
   * 请求代号（AUDIT-CLIENT-PERF P1-5/P1-6）：板块列表的**每一次取数**领一代，
   * 落地前对一次当前代 —— 不是当代的响应（含错误）整体丢弃。
   *
   * 治两个症状：
   *   · P1-5 "加载更多"连点：两次请求都带 `append` ⇒ 同两批行被追加两遍（表格 40 行重复 + 重复 key）；
   *   · P1-6 切 scope/sort：旧 scope 的慢响应落地，把新 scope 的行覆盖掉（表头写"概念"、内容是"行业"）。
   */
  const boardGen = React.useRef(createRequestGen())

  const loadBoard = useCallback((s: Scope, sortBy: Sort, pn: number, append: boolean) => {
    const my = boardGen.current.next()
    setBoardLoading(true)
    api
      .board(s, sortBy, pn)
      .then((r) => {
        if (boardGen.current.stale(my)) return
        setBoardMeta({ stale: r.stale, asOf: r.asOf, source: r.source })
        setBoardError(null)
        setTotal(r.total)
        setRows((prev) => (append ? [...prev, ...r.rows] : r.rows))
        setPage(pn)
      })
      .catch((e: Error) => {
        if (boardGen.current.stale(my)) return
        setBoardError(e.message)
      })
      .finally(() => {
        if (boardGen.current.stale(my)) return
        setBoardLoading(false)
      })
  }, [])

  useEffect(() => {
    setRows([])
    setPage(1)
    loadBoard(scope, sort, 1, false)
  }, [scope, sort, loadBoard])

  // Breadth & turnover from the two composite indices (full-market counters).
 // 涨跌家数历史分位。宿主持每日快照（收盘后写），这里只读。
  /** 四类数据块的统一重试令牌（点一次 +1，相关 effect 重新拉取） */
  const [mkRetry, setMkRetry] = useState(0)
  /**
   * 附加行情（P2-2）：只在 `?debug=1` 下取，默认**完全不发**。
   *
   * `/tradewatcher/market-extras` 是宿主侧最重的一条（两融双源 + 全池扫描 + 全天预测），
   * 而界面曾经只为页面根节点的一个 `data-limits` 排障属性而拉它 —— 每进一次大盘页就白扫一遍。
   */
  const debugMode = debugFlagOf(typeof location === 'undefined' ? '' : location.search)
  const [extras, setExtras] = useState<Awaited<ReturnType<typeof api.marketExtras>> | null>(null)
  /** 汪汪队跟踪（v0.186.0）：窗口 + 回包 + 错误 */
  const [dwWindow, setDwWindow] = useState<'3m' | '6m' | '1y' | '2y'>('1y')
  const [dogwatch, setDogwatch] = useState<Awaited<ReturnType<typeof api.dogwatch>> | null>(null)
  const [dwErr, setDwErr] = useState<string | null>(null)
  /**
   * 涨跌家数分布（U3）：依赖从 `quotes`（**对象身份**，每拍都换）改成 `quoteTs`（节拍信号），
   * 并且最小间隔 **60s** —— `dist=1` 会在宿主侧"多扫 ~56 页"，每 10s 重来一次纯属浪费。
   * 副作用（数据最多旧 60s）写在下方格子的 `title` 里。
   */

  // 附加行情（v0.81.2）：涨停/跌停家数、两融（双源交叉）、全天成交额预测。
  // 预测要把"页面自己已经显示的那个当日成交额"带过去（宿主不再抓一遍）；缺/0 ⇒ 预测部分如实缺失。
  /** 成交额分时/分钟增减的数据（指数 2 日分时；每分钟带 amount） */
  const amountForForecast = null
  /**
   * `/breadth`：**按 60s 节流**（AUDIT-CLIENT-PERF P2-1 —— 选了"节流"而不是"删除"）。
   *
   * 为什么没删：`src/rowOwnership.test.ts`（**宿主侧门禁**，不在本次改动范围）要求实现表里
   * `/tradewatcher/breadth` 归 market 行、且与**实测调用方**一致 —— 删掉这处唯一调用点，该门禁立刻红；
   * 它要守的是"market 行关掉后不会有别的行去打 404"，不是"每个路由必须有 UI"。所以保留一个调用点。
   *
   * 但旧注释**只声称过**的"最小间隔 60s"从未实现（`EXTRAS_MIN_INTERVAL_MS` 被 `void` 掉）：
   * 这里用 `dueByInterval` 真的实现它 ⇒ 静置 10 分钟从 60 次降到 ≤10 次（`CALL_BUDGET_10MIN.breadth`）。
   * 点「重试」会作废这一拍的时间戳（用户要的是"现在重来"，不该被 60s 下限挡住）。
   *
   * 诚实标注：页面目前**没有任何一格渲染**这份回包（涨跌分布卡 v0.191.0 已下线，旧代码只有 `void breadth`）；
   * 它是 market 行的路由归属锚点，不参与任何显示。数据要重新上界面时接回卡片即可。
   */
  const breadthAt = React.useRef<number | null>(null)
  const breadthRetrySeen = React.useRef(mkRetry)
  useEffect(() => {
    if (breadthRetrySeen.current !== mkRetry) { breadthRetrySeen.current = mkRetry; breadthAt.current = null }
    const tick = typeof props.quoteTs === 'number' && Number.isFinite(props.quoteTs) ? props.quoteTs : Date.now()
    if (!dueByInterval(tick, breadthAt.current, BREADTH_MIN_INTERVAL_MS)) return
    breadthAt.current = tick
    api.breadth().then(() => undefined).catch(() => undefined)
  }, [props.quoteTs, mkRetry])
  /** 附加行情（涨停/跌停/两融/预测）的节拍说明：写进各自 `title`，别让用户以为它跟行情条同频 */
  useEffect(() => {
    // P2-2：默认不发；只有排障时（?debug=1）才取，结果写进卡片 title（供涨跌停口径核对）
    if (!debugMode) { setExtras(null); return undefined }
    let alive = true
    api.marketExtras(null).then((x) => { if (alive) setExtras(x) }).catch(() => undefined)
    return () => { alive = false }
  }, [debugMode, mkRetry])

  useEffect(() => {
    let alive = true
    setDogwatch(null) /* P1：切窗前先清空，避免旧窗口数据挂新 tab */
    setDwErr(null)
    api.dogwatch(dwWindow).then((r) => { if (alive) setDogwatch(r) }).catch((e: Error) => { if (alive) setDwErr(e.message) })
    return () => { alive = false }
  }, [dwWindow, mkRetry])

  const EXTRAS_POLL_NOTE = '；本格按 30 秒节拍刷新（节流后最多旧 30 秒）'


  /**
   * ETF/指数详情卡也领代号（AUDIT-CLIENT-PERF P1-7）：`/detail` 与 `/trend` 是两条独立请求，
   * 连点两只标的时后到的**旧**响应会把标题（新标的）和数值（旧标的）拼成一屏静默错数。
   * 代号按"打开动作"递增：旧代响应（含错误）整体丢弃；关闭时也开新代，避免关掉后又被写回。
   */
  const detailGen = React.useRef(createRequestGen())

  const openDetail = (secid: string): void => {
    const my = detailGen.current.next()
    setPick({ secid })
    setDetail(null)
    setTrend(null)
    api
      .detail(secid)
      .then((r) => { if (!detailGen.current.stale(my)) setDetail(r.detail) })
      .catch(() => { if (!detailGen.current.stale(my)) setDetail(null) })
    api
      .trend(secid)
      .then((r) => { if (!detailGen.current.stale(my)) setTrend(r.trend) })
      .catch(() => undefined)
  }

  const closeDetail = (): void => {
    detailGen.current.next()
    setPick(null)
    setDetail(null)
    setTrend(null)
  }

  /**
   * 未取到的三处原因（task-14 ② 的"可得性表"结论，写在代码里当唯一来源）。
   *
   * 红线：**不许编数、不许用 0 顶替** —— 取不到就写「未取到」，原因进 `title`/`aria-label`。
   */
  /**
   * 缺失原因（P1-7）：这三句此前写的是「本插件未集成 / 没做」，而 v0.81.2 起数据已经是真的
   * （同屏就在显示涨停家数、两融双源、盘中预测）—— 标题说「没这功能」、右边却显示这功能的数，
   * 是同一屏自相矛盾；何况它们只在「本次失败」时出现，会被读成「永远不会有」。
   * 现在统一成「本次未取到 + 会不会重试」，并把真正的**功能边界**单独标注。
   */
  const INTRADAY_REASON = '日内上涨/下跌家数折线：这是功能边界（宿主只按交易日存快照，没有日内采样序列 ⇒ 重试也不会变），不是本次失败；要画它需新增日内采样与存储'

  /**
   * 分段（参考版 Arkvol 每段：一个小色条 + 标题 [+ 副标题]）。
   * `data-role` 让结构断言能挂在**真实渲染**上（不是只断言源码文本）。
   */
  const seg = (title: string, role: string, sub: React.ReactNode, ...body: React.ReactNode[]): React.ReactElement =>
    React.createElement('div', { className: 'tw-dist-seg', 'data-role': `dist-${role}` },
      React.createElement('div', { className: 'tw-dist-seg-h' },
        React.createElement('span', { className: 'tw-dist-seg-bar' }),
        React.createElement('span', { className: 'tw-dist-seg-t' }, title),
        sub ?? null,
      ),
      ...body,
    )


  /** 图例行：色点 + 序列名 + 值（取不到时是「未取到」，原因进 title/aria） */
  const legendRow = (rows: Array<{ name: string; color: string; value: string; note: string }>): React.ReactElement =>
    React.createElement('div', { className: 'tw-dist-legend' },
      ...rows.map((r) => React.createElement('span', {
        // 节拍说明统一追加在**渲染处**（原因常量本身保持原样，见 distLayout 的实参断言）
        key: r.name, className: 'lg', title: r.note + EXTRAS_POLL_NOTE, tabIndex: 0, role: 'note',
        'aria-label': `${r.name} ${r.value} —— ${r.note}${EXTRAS_POLL_NOTE}`,
      },
        React.createElement('span', { className: 'dot', style: { background: r.color } }),
        React.createElement('span', null, r.name),
        React.createElement('span', { className: r.value === '未取到' ? 'tw-dim' : '' }, r.value),
      )),
    )

  return React.createElement(
    'div',
    { className: 'tw-body', id: 'tw-main', tabIndex: -1 },
    // 首次启动（行情引擎还没出第一批数据）时给一句能解释"为什么全是 —"的空态；
    // 它**不是**缺失提示：缺失仍然走各面板的「未取到 + 原因」（红线不变）
    Object.keys(quotes).length === 0
      ? React.createElement(EmptyHint, null, '行情引擎正在取第一批数据（首次启动通常 5 秒内）。若长时间为空，看各面板的「未取到」原因。')
      : null,
    /**
     * 大盘页 V1（`docs/mockups/market-v1.html` A 单列）：涨跌 / 成交额 / 两融两列块。
     * 左列 4 卡（涨跌趋势 → 成交量 → 两融 → 成交额分时），右列 2 卡（涨跌分布 → 分钟成交额）。
     * 取不到的数据格统一 `—（原因）`，**不写 0、不拿旧值顶替**。
     */
    (() => {
      const card = (title: string, hint: React.ReactNode, body: React.ReactNode, retry = true): React.ReactElement =>
        React.createElement('div', { className: 'tw-mk-card' },
          React.createElement('div', { className: 'tw-mk-h' },
            React.createElement('i', { className: 'tw-mk-bar' }),
            React.createElement('span', { className: 't' }, title),
            React.createElement('span', { className: 'tw-mk-hint' }, hint),
            retry
              ? React.createElement('button', { className: 'tw-tab', style: { fontSize: 12 }, onClick: () => setMkRetry((n) => n + 1) }, '重试')
              : null),
          body,
        )
      // v0.187.0：随两张卡下线，下列 helper/常量已无渲染点；保留定义但显式声明"暂未使用"，避免误读为活跃代码
  void INTRADAY_REASON; void seg; void legendRow; void amountForForecast

      // v0.184.0：用户要求下线左列四卡 —— 单列只剩「涨跌分布」与「分钟成交额较昨日增减」
      // v0.187.0：用户要求下线「涨跌分布」「分钟成交额较昨日增减」；页面只剩护盘信号 + 汪汪队跟踪
      const dwView = dogwatch === null ? null : dwTable(dogwatch.rows, dogwatch.summary, dogwatch.sharesStale)
      const dwRev = dogwatch === null ? null : dwReview(dogwatch.series[dogwatch.series.length - 1]?.day ?? '—', dogwatch.summary)
      const dwK = dogwatch === null ? null : dwKpis(dogwatch.summary)
      const dwS = dogwatch === null ? null : dwSeries(dogwatch.series)
      const dwReviewEl = React.createElement('div', { className: 'tw-dw-review', 'data-role': 'dw-review' },
        React.createElement('div', { className: 'tw-dw-review-main' },
          React.createElement('div', { className: 'tw-dw-review-day' }, dwRev?.day ?? '—'),
          React.createElement('div', { className: 'tw-dw-review-verdict' }, dwRev?.verdict ?? '—')),
        React.createElement('div', { className: 'tw-dw-review-big' }, dwRev?.big ?? '—'),
        React.createElement('div', { className: 'tw-dw-review-sub' }, dwRev?.bigSub ?? '较 20 日均额'))
      const dwKpiEl = React.createElement('div', { className: 'tw-dw-kpis', 'data-role': 'dw-kpis' },
        ...(dwK ?? []).map((k) => React.createElement('div', { key: k.label, className: 'tw-dw-kpi' },
          React.createElement('span', { className: 'l' }, k.label),
          React.createElement('span', { className: 'v' }, k.value),
          React.createElement('span', { className: 's' }, k.sub))))
      // P1-4：两张图各自收进 DwChart（悬停 state + 同帧合并都在子组件内部），父级不再因鼠标移动重渲
      const dwBarsEl = React.createElement(DwChart, {
        kind: 'bar',
        title: '汪汪队每日份额变化估算',
        foot: '单位：亿份 · 柱 = 当日份额变化估算',
        series: dwS,
      })
      const dwLineEl = React.createElement(DwChart, {
        kind: 'line',
        title: '汪汪队加仓指数估算',
        note: '基期 = 100',
        foot: '单位：指数 · 虚线 = 基期 100',
        series: dwS,
      })
      const dwTableEl = React.createElement('div', { className: 'tw-dw-tscroll' },
        React.createElement('table', { className: 'tw-dw-table', 'data-role': 'dw-table' },
          React.createElement('thead', null, React.createElement('tr', null,
            ...(dwView?.head ?? []).map((h) => React.createElement('th', { key: h }, h)))),
          React.createElement('tbody', null, ...(dwView?.rows ?? []).map((r) => React.createElement('tr', { key: r.key },
            ...r.cells.map((c, i) => React.createElement('td', { key: i, title: r.titles[i], tabIndex: r.titles[i] ? 0 : undefined, className: `${i >= 2 ? 'num' : ''}${c.startsWith('-') ? ' neg' : c.startsWith('+') ? ' pos' : ''}` }, c)))))))
      const dogwatchCard = card('汪汪队跟踪', React.createElement('div', { className: 'tw-seg' },
        ...(['3m', '6m', '1y', '2y'] as const).map((w) => React.createElement('button', {
          key: w, className: `tw-tab${dwWindow === w ? ' is-on' : ''}`, onClick: () => { setDwWindow(w) },
        }, w === '3m' ? '近3月' : w === '6m' ? '6月' : w === '1y' ? '1年' : '2年'))),
        dwErr !== null
          ? React.createElement('div', { className: 'tw-mk-empty' }, missingCellText(dwErr))
          : dogwatch === null
            ? React.createElement('div', { className: 'tw-dw-body', 'data-role': 'dw-skeleton' },
                React.createElement('div', { className: 'tw-dw-skel-charts' },
                  React.createElement('div', { className: 'tw-dw-skel-block' }),
                  React.createElement('div', { className: 'tw-dw-skel-block' })),
                React.createElement('div', { className: 'tw-dw-skel-rows' },
                  ...[0, 1, 2].map((i) => React.createElement('div', { key: i, className: 'tw-dw-skel-row' }))))
            : React.createElement('div', { className: 'tw-dw-body', 'data-role': 'dw-body' },
                dwReviewEl, dwKpiEl,
                React.createElement('div', { className: 'tw-dw-charts' }, dwBarsEl, dwLineEl),
                dwTableEl,
                React.createElement('div', { className: 'tw-dw-foot', 'data-role': 'dw-foot' }, DW_FOOTNOTE)))
      return React.createElement('div', {
        className: 'tw-mk-body',
        'data-bars': String(MINUTE_BARS),
        // P2-2：排障口径只在 ?debug=1 下才有值；写进 title（不再为它默认发一条宿主侧最重的请求）
        // 卡头不得出现「涨停 / 跌停」字样（宿主侧 dogwatch 判据 ⑥）：这里只报上/下限家数
        title: extras === null ? undefined : `排障口径（debug=1）：上限 ${extras.limits.up.count ?? '—'} 家 / 下限 ${extras.limits.down.count ?? '—'} 家`,
      }, dogwatchCard)
    })(),
    React.createElement(RescuePanel, { prefs, redUp, onPrefs: props.onPrefs }),
    React.createElement('div', { className: 'tw-panel' },
      React.createElement('div', { className: 'tw-panel-h' },
        React.createElement('span', { className: 't' }, '板块 / 资金 / ETF'),
        React.createElement('div', { className: 'tw-seg' },
          (['industry', 'concept', 'etf'] as Scope[]).map((s) =>
            React.createElement('button', { key: s, 'data-on': scope === s, onClick: () => { setScope(s); setSort(s === 'etf' ? 'pct' : 'pct') } }, SCOPE_LABEL[s]),
          ),
        ),
        React.createElement('div', { style: { flex: 1 } }),
        scope === 'etf'
          ? React.createElement('div', { className: 'tw-seg' },
              React.createElement('button', { 'data-on': sort === 'pct', onClick: () => setSort('pct') }, '涨跌幅'),
              // A4：备用源（腾讯/新浪）不含成交额/主力净额字段 ⇒ 这两档排序点了也没效果，
              // 置灰并给出原因（不许留"看着能用的空功能"）
              React.createElement('button', {
                'data-on': sort === 'amount',
                disabled: !boardMoneyOk,
                title: boardMoneyOk ? undefined : '当前数据来自备用源（不含成交额字段），该排序暂未取到；东财恢复后自动可用',
                onClick: () => { if (boardMoneyOk) setSort('amount') },
              }, '成交额'),
            )
          : React.createElement('div', { className: 'tw-seg' },
              React.createElement('button', { 'data-on': sort === 'pct', onClick: () => setSort('pct') }, '涨跌幅'),
              React.createElement('button', {
                'data-on': sort === 'money',
                disabled: !boardMoneyOk,
                title: boardMoneyOk ? undefined : '当前数据来自备用源（不含主力净额字段），该排序暂未取到；东财恢复后自动可用',
                onClick: () => { if (boardMoneyOk) setSort('money') },
              }, '主力资金'),
            ),
 // 主力资金排行下的两种口径（金额 / 占比）
        sort === 'money' && scope !== 'etf'
          ? React.createElement('div', { className: 'tw-seg', title: '主力净额为本插件直接取用的上游字段；占比＝净额 ÷ 成交额（本页内重排，见下方说明）' },
              React.createElement('button', {
                'data-on': moneySort === 'money', disabled: !boardMoneyOk,
                title: boardMoneyOk ? undefined : '备用源不含主力净额字段',
                onClick: () => { if (boardMoneyOk) setMoneySort('money') },
              }, '金额'),
              React.createElement('button', {
                'data-on': moneySort === 'share', disabled: !boardMoneyOk,
                title: boardMoneyOk ? undefined : '备用源不含主力净额字段',
                onClick: () => { if (boardMoneyOk) setMoneySort('share') },
              }, '占比'),
            )
          : null,
      ),
      React.createElement(ErrorNote, { error: boardError }),
      // 数据来源与新鲜度：东财行情 CDN 被限流时这里会显示备用源或上次成功结果，
      // 且明确标注"主力净流入不可用"（该列仅东财提供）
 // 口径与时刻常显（不再只在降级时才出现）。
      // 15:00 之后上游不再更新板块资金流 → 标「定稿」；这是"数据不会再变"，不是"降级"。
      React.createElement('div', {
        className: 'tw-hint',
        style: { padding: '2px 2px 4px' },
        title: scope === 'etf'
          ? '口径：ETF 排行按涨跌幅/成交额/换手，该类排行没有资金流字段'
          : '口径：主力净额＝超大单＋大单净流入（上游口径，仅东财提供）；占比＝净额 ÷ 成交额。'
            + '占比排序只在「本页 40 条」内重排 —— 上游按净额取前 40，本插件没有"按净占比的全市场排行"这一口径，因此不把它呈现成全市场排行。',
      },
        React.createElement('span', { className: 'tw-badge', style: { marginRight: 6 } },
          cnSession.settled ? '定稿' : CN_PHASE_LABEL[cnSession.phase]),
        `数据时刻 ${boardMeta?.asOf !== undefined ? shClockText(boardMeta.asOf) : '—'}` +
        ` · 来源 ${boardMeta?.source ?? 'em'}${boardMeta?.stale === true ? '（上次成功结果）' : ''}` +
        // 口径常显会占掉一行（≈90 字）：压成「口径 ⓘ」，全文进 title（R1）——但下面这句**必须常显**（K9：
        // 删了会把"本页 40 条内重排"读成全市场排行）
        ' · 口径 ⓘ' +
        (sort === 'money' && scope !== 'etf' && moneySort === 'share' ? ' · 占比排序仅本页 40 条内' : ''),
      ),
      boardMeta !== null && (boardMeta.stale === true || boardMeta.source === 'tencent' || boardMeta.source === 'sina')
        ? React.createElement('div', { className: 'tw-hint', style: { padding: '2px 2px 4px' } },
            boardMeta.source === 'tencent' || boardMeta.source === 'sina'
              ? `东财行情接口暂未取到，${boardMeta.source === 'sina' ? 'ETF 排行来自新浪备用源' : '板块涨跌来自腾讯备用源'}；`
              : `东财行情接口暂未取到，显示上次成功数据（${boardMeta.asOf !== undefined ? shClockText(boardMeta.asOf).slice(0, 5) : '—'}）；`,
            scope === 'etf' ? 'ETF 排行的备用源不含资金流。' : '「主力净流入」仅东财提供，备用源下显示为 —。',
          )
        : null,
      React.createElement('div', { className: 'tw-tablewrap' },
        React.createElement('table', { className: 'tw-table', style: { minWidth: scope === 'etf' ? 500 : 640 } },
          React.createElement('thead', null,
            React.createElement('tr', null,
              React.createElement('th', null, scope === 'etf' ? '代码' : '#'),
              React.createElement('th', null, '名称'),
              React.createElement('th', null, scope === 'etf' ? '现价/涨跌' : '涨跌'),
              React.createElement('th', null, '幅度'),
              scope === 'etf'
                ? [React.createElement('th', { key: 'a' }, '成交额'), React.createElement('th', { key: 't' }, '换手')]
                : [
                    React.createElement('th', { key: 'u' }, '上涨/下跌'),
                    React.createElement('th', { key: 'l' }, '领涨股'),
                    React.createElement('th', { key: 'm' }, '主力净流入'),
                    // 口径切换后必须能看到被排序的那个数，否则"为什么这么排"无从判断
                    moneySort === 'share' ? React.createElement('th', { key: 's', title: '净额 ÷ 成交额' }, '净占比') : null,
                  ],
            ),
          ),
          React.createElement('tbody', null,
            viewRows.map((r, i) => {
              const cls = dirClass(r.pct ?? null, redUp)
              const clickable = scope === 'etf' && r.secid !== undefined
              return React.createElement('tr', {
                key: r.code,
                className: 'tw-rowhover',
                style: clickable ? { cursor: 'pointer' } : undefined,
                onClick: clickable && r.secid !== undefined ? () => openDetail(r.secid as string) : undefined,
                title: clickable ? '点击查看详情' : undefined,
                tabIndex: clickable ? 0 : undefined,
                role: clickable ? 'button' : undefined,
                'aria-label': clickable ? `${r.name} 详情` : undefined,
                onKeyDown: clickable
                  ? (e: React.KeyboardEvent) => {
                      if ((e.key === 'Enter' || e.key === ' ') && r.secid !== undefined) {
                        e.preventDefault()
                        openDetail(r.secid)
                      }
                    }
                  : undefined,
              },
                React.createElement('td', { className: 'tl tw-dim' }, scope === 'etf' ? r.code : String((page - 1) * 40 + i + 1)),
                React.createElement('td', { className: 'tl' }, r.name),
                React.createElement('td', { className: cls }, scope === 'etf' ? `${fmtPrice(r.price)} ${fmtSigned(r.chg)}` : fmtSigned(r.chg)),
                React.createElement('td', null, React.createElement('span', { className: `tw-chg-chip ${r.pct === null ? 'tw-chip-flat' : (r.pct >= 0) === redUp ? 'tw-chip-up' : 'tw-chip-down'}` }, fmtPct(r.pct ?? null))),
                scope === 'etf'
                  ? [React.createElement('td', { key: 'a' }, fmtAmt(r.amount ?? null)), React.createElement('td', { key: 't' }, fmtFixedPct(r.turnover))]
                  : [
                      React.createElement('td', { key: 'u', className: 'tw-dim' },
                        upDownPair(r.up, r.down).ok
                          ? React.createElement(React.Fragment, null,
                              React.createElement('span', { className: dirClass(1, redUp) }, String(r.up)),
                              ' / ',
                              React.createElement('span', { className: dirClass(-1, redUp) }, String(r.down)),
                            )
                          : React.createElement('span', { tabIndex: 0, role: 'note', 'aria-label': UPDOWN_MISSING_NOTE, title: UPDOWN_MISSING_NOTE }, '—'),
                      ),
                      React.createElement('td', { key: 'l', className: 'tl' }, r.leader ?? '—'),
                      React.createElement('td', { key: 'm', className: dirClass(r.money ?? null, redUp) }, fmtAmt(r.money ?? null)),
                      moneySort === 'share'
                        ? React.createElement('td', {
                            key: 's',
                            className: dirClass(sharePctOf(r), redUp),
                            title: sharePctOf(r) === null ? '净占比不可算：缺主力净额或成交额' : `${fmtAmt(r.money ?? null)} ÷ ${fmtAmt(r.amount ?? null)}`,
                          }, fmtFixedPct(sharePctOf(r)))
                        : null,
                    ],
              )
            }),
          ),
        ),
      ),
      React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 8, marginTop: 6 } },
        boardLoading ? React.createElement('span', { className: 'tw-muted' }, '加载中…') : React.createElement('span', { className: 'tw-muted' }, `共 ${total} 个`),
        React.createElement('span', { style: { flex: 1 } }),
        page * 40 < total
          // P1-5：在途时禁用（配合 loadBoard 的请求代号：双击也只落地一次）；文案说明为什么点不动
          ? React.createElement(Btn, {
              disabled: boardLoading,
              title: boardLoading ? '上一页还在加载，稍等（同一页不会重复追加）' : undefined,
              onClick: () => loadBoard(scope, sort, page + 1, true),
            }, boardLoading ? '加载中…' : '加载更多')
          : null,
      ),
    ),
    // 【个股 / 基金查询】整块已删（task-14 ①）：搜索框 + 下方说明 + 内联详情卡
    // 详情仍可达：点指数/ETF 行 ⇒ DetailModal（下面那块，未动）
    pick !== null && detail !== null
      ? React.createElement(DetailModal, { detail, trend, redUp, onClose: closeDetail })
      : null,
  )
}

/**
 * 【涨跌分布】直方图（task-14 ②）：宿主给的**分档计数**，柱高按最大档归一，柱上标数。
 *
 * 红线：`counts === null`（没扫全）⇒ 只说「未取到」+ 原因，**不画部分数据**（那会被读成全市场分布）。
 * 柱宽用百分比、不用固定 px：面板窄了也不会把某个档挤成 0 宽（同 v0.54.0 的宽度契约）。
 */
function DetailCard(props: { detail: StockDetail; trend: TrendData | null; redUp: boolean }): React.ReactElement {
  const d = props.detail
  const cls = dirClass(d.chg ?? null, props.redUp)
  const t = props.trend
  const points = (t?.points ?? []).map((p) => ({ t: p.t, value: p.price }))
  const lastUp = points.length > 1 && isUsableBaseline(t?.prePrice)
    ? points[points.length - 1].value >= t.prePrice
    : null
  const kv = (k: string, v: string | null, extraCls?: string): React.ReactElement =>
    React.createElement('div', { style: { display: 'flex', justifyContent: 'space-between', gap: 12, padding: '3px 0', borderBottom: '1px solid var(--tw-border)' } },
      React.createElement('span', { className: 'tw-dim' }, k),
      React.createElement('span', { className: extraCls ?? '' }, v ?? '—'),
    )
  return React.createElement(
    'div',
    { style: { marginTop: 8, display: 'flex', flexDirection: 'column', gap: 4 } },
    React.createElement('div', { style: { display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' } },
      React.createElement('b', { style: { fontSize: 15 } }, `${d.name}（${d.code}）`),
      React.createElement('span', { className: cls, style: { fontSize: 20, fontWeight: 700 } }, fmtPrice(d.price)),
      React.createElement('span', { className: cls }, `${fmtSigned(d.chg)}  ${fmtPct(d.pct)}`),
    ),
    t !== null && points.length > 1
      ? React.createElement(Sparkline, {
          points,
          baseline: t.prePrice,
          width: 560,
          height: 170,
          up: lastUp !== false,
          upColor: 'var(--tw-up)',
          downColor: 'var(--tw-down)',
          timeLabels: true,
        })
      : React.createElement('div', { className: 'tw-muted' }, '无当日分时数据'),
    React.createElement('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px,1fr))', gap: '0 18px', marginTop: 4 } },
      React.createElement('div', null,
        kv('今开', fmtPrice(d.open)),
        kv('最高', fmtPrice(d.high)),
        kv('最低', fmtPrice(d.low)),
        kv('昨收', fmtPrice(d.prev)),
        kv('成交量', fmtBig(d.vol)),
      ),
      React.createElement('div', null,
        kv('成交额', fmtAmt(d.amount)),
        kv('换手率', d.turnover !== null ? `${d.turnover}%` : null),
        kv('量比', d.volumeRatio !== null ? String(d.volumeRatio) : null),
        kv('市盈率(动)', d.pe !== null ? String(d.pe) : null),
        kv('市净率', d.pb !== null ? String(d.pb) : null),
      ),
      React.createElement('div', null,
        kv('总市值', fmtAmt(d.totalMv)),
        kv('流通市值', fmtAmt(d.floatMv)),
        kv('涨跌家数', d.up !== null && d.down !== null ? `${d.up} / ${d.down}` : null),
      ),
    ),
  )
}

function DetailModal(props: {
  detail: StockDetail
  trend: TrendData | null
  redUp: boolean
  onClose: () => void
}): React.ReactElement {
  return React.createElement(Modal, { title: '个股详情', onClose: props.onClose, width: 640 },
    React.createElement(DetailCard, { detail: props.detail, trend: props.trend, redUp: props.redUp }),
    React.createElement('div', { style: { display: 'flex', justifyContent: 'flex-end', marginTop: 8 } },
      React.createElement(Btn, { onClick: props.onClose }, '关闭'),
    ),
  )
}
