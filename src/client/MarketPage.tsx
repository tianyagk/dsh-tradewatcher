/** A股大盘行情: index overview + breadth/amount stats, sector & ETF boards,
 *  money-flow ranking (boards sorted by main-capital inflow), stock search
 *  with detail card + intraday chart. */
import React, { useCallback, useEffect, useState } from 'react'
import type { BoardRow, QuoteRow, StockDetail, TrendData } from '../shared/model.ts'
import { api } from './api.ts'
import { UPDOWN_MISSING_NOTE, breadthCells, pickBreadthCounts, upDownPair } from './breadthView.ts'
import { distAxisOf, distBarPctOf } from './distView.ts'
import { dirClass, fmtAmt, fmtBig, fmtPct, fmtPrice, fmtSigned } from './format.ts'
import { CN_PHASE_LABEL, cnSessionState, shClockText } from './marketTime.ts'
import { useNow } from './useNow.ts'
import { Btn, ErrorNote, Modal } from './ui.tsx'
import { Sparkline } from './charts.tsx'
import { RescuePanel } from './RescuePanel.tsx'
import type { PortPrefs, QuoteSource } from '../shared/model.ts'
import { isUsableBaseline } from './trendView.ts'

type Scope = 'industry' | 'concept' | 'etf'

/** 时刻一律 `HH:mm:ss`（用词表：页面级"数据时刻"；固定北京时间，禁用 toLocaleString 的默认输出与本地 getHours） */
function hhmmssOf(ts: number): string {
  return shClockText(ts)
}
type Sort = 'pct' | 'money' | 'amount'

const SCOPE_LABEL: Record<Scope, string> = { industry: '行业板块', concept: '概念板块', etf: 'ETF排行' }

export function MarketPage(props: {
  quotes: Record<string, QuoteRow>
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
  /** 净占比（%）= 主力净额 ÷ 成交额；任一项缺失即 null（不拿 0 顶替） */
  const shareOf = (r: BoardRow): number | null =>
    r.money === null || r.amount === null || r.amount === 0 ? null : (r.money / r.amount) * 100
  /**
   * 展示顺序（P1-7）：`share` 时**只在本页内重排**，且缺失占比的行沉底。
   * 绝不动上游分页 —— 否则会把"本页重排"和"全市场排行"混为一谈。
   */
  const viewRows = moneySort === 'share' && sort === 'money' && scope !== 'etf'
    ? [...rows].sort((a, b) => {
        const sa = shareOf(a)
        const sb = shareOf(b)
        if (sa === null && sb === null) return 0
        if (sa === null) return 1
        if (sb === null) return -1
        return sb - sa
      })
    : rows
  const [pick, setPick] = useState<{ secid: string } | null>(null)
  const [detail, setDetail] = useState<StockDetail | null>(null)
  const [trend, setTrend] = useState<TrendData | null>(null)

  const loadBoard = useCallback((s: Scope, sortBy: Sort, pn: number, append: boolean) => {
    setBoardLoading(true)
    api
      .board(s, sortBy, pn)
      .then((r) => {
        setBoardMeta({ stale: r.stale, asOf: r.asOf, source: r.source })
        setBoardError(null)
        setTotal(r.total)
        setRows((prev) => (append ? [...prev, ...r.rows] : r.rows))
        setPage(pn)
      })
      .catch((e: Error) => setBoardError(e.message))
      .finally(() => setBoardLoading(false))
  }, [])

  useEffect(() => {
    setRows([])
    setPage(1)
    loadBoard(scope, sort, 1, false)
  }, [scope, sort, loadBoard])

  // Breadth & turnover from the two composite indices (full-market counters).
 // 涨跌家数历史分位。宿主持每日快照（收盘后写），这里只读。
  const [breadth, setBreadth] = useState<Awaited<ReturnType<typeof api.breadth>> | null>(null)
  const [breadthErr, setBreadthErr] = useState<string | null>(null)
  useEffect(() => {
    let alive = true
    api
      // dist=1：额外要一份【涨跌分布】直方图（多扫 ~56 页，宿主侧 60s 缓存）——只有这一页要
      .breadth({ dist: true })
      .then((b) => {
        if (alive) {
          setBreadth(b)
          setBreadthErr(null)
        }
      })
      .catch((e: Error) => {
        if (alive) setBreadthErr(e.message)
      })
    return () => {
      alive = false
    }
    // 行情每轮刷新后顺带重读（分位只在收盘后变化，但当日数值要跟着动）
  }, [props.quotes])

  const sh = quotes['1.000001']
  const sz = quotes['0.399001']
  // 涨跌家数与成交额：任一分量缺失即整格 `—` + 原因（**不用 0 顶替**，见 breadthView.ts）
  const cells = breadthCells(sh, sz)
  /**
   * 家数取哪一份：**指数行情优先，拿不到才用自统计**。
   *
   * 指数行情走备用源时 `f104/f105/f106` 就没有了，此时必须用 `/tradewatcher/breadth` 的
   * `current`（本插件自行统计）顶上 —— 否则会出现"三格 `—` ＋ 一行说家数是自己统计的 ＋ 一个占比"
   * 这种同屏自相矛盾的读数。
   */
  const picked = pickBreadthCounts(cells, breadth?.current ?? null)
  const selfCount = picked.from === 'self' ? breadth?.current ?? null : null
  const { up, down, even } = picked
  const breadthOk = picked.from !== 'none'
  // 自统计时三格要带自己的时刻与口径（`em-index` = 上游直接给的，不标）
  const countsTitle = selfCount === null || selfCount.source === 'em-index'
    ? undefined
    : `${selfCount.caliber ?? '本插件自行统计的沪深A股家数'}；数据时刻 ${
        selfCount.asOf === null ? '未知' : hhmmssOf(selfCount.asOf)
      }（不是行情条那一刻）`
  const countsReason = breadth?.missing[0]?.note ?? cells.reason ?? null
  /**
   * 「上涨/平盘/下跌」三格的**悬停说明**（唯一来源）：
   * 缺失 ⇒ 带原因（红线：缺失必须给原因，且要能被键盘/触屏读到）；有数据 ⇒ 带口径与自统计时刻。
   */
  const countsNote = !breadthOk
    ? `涨跌家数本次未取到 —— ${countsReason ?? '原因未给出'}`
    : (countsTitle ?? '沪深两市涨跌家数（指数行情 f104/f105/f106；取不到时由本插件自统计）')
  // 昨日成交（本地上一交易日快照）：取不到就是 null ⇒ 显示「未取到」，**不拿今天的数顶替**
  const prevAmt = breadth?.prevAmount ?? null
  const delta = prevAmt === null || !cells.amountOk ? null : cells.amount - prevAmt.amount

  const cnIndices: Array<{ secid: string; name: string }> = [
    { secid: '1.000001', name: '上证指数' },
    { secid: '0.399001', name: '深证成指' },
    { secid: '0.399006', name: '创业板指' },
    { secid: '1.000688', name: '科创50' },
    { secid: '1.000300', name: '沪深300' },
    { secid: '1.000905', name: '中证500' },
  ]

  const openDetail = (secid: string): void => {
    setPick({ secid })
    setDetail(null)
    setTrend(null)
    api
      .detail(secid)
      .then((r) => setDetail(r.detail))
      .catch(() => setDetail(null))
    api
      .trend(secid)
      .then((r) => setTrend(r.trend))
      .catch(() => undefined)
  }

  /**
   * 未取到的三处原因（task-14 ② 的"可得性表"结论，写在代码里当唯一来源）。
   *
   * 红线：**不许编数、不许用 0 顶替** —— 取不到就写「未取到」，原因进 `title`/`aria-label`。
   */
  const LIMIT_REASON = '涨停/跌停家数：指数行情只给涨/跌/平家数（f104/f105/f106），没有涨停/跌停字段；按板块（10%/20%/30%）与 ST（5%）规则自行判定需要本插件没取的名字/板块字段 ⇒ 本轮不做（不是 0）'
  const FORECAST_REASON = '预测全天成交额：本插件没有日内成交额采样，也没有任何校准基准 ⇒ 任何"预测"都是编的，故不给'
  const MARGIN_REASON = '两融（融资余额/融资净买）：本插件未集成两融数据源，现有路由里没有任何 margin 字段 ⇒ 未取到（需新路由 + 新缓存 + 归属，另开）'
  const INTRADAY_REASON = '日内上涨/下跌家数折线：宿主只按**交易日**存快照（breadth.json 每天一条），没有日内采样序列 ⇒ 画不出来（需新增日内采样与存储，另开）'

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

  /**
   * **内联**统计项（一行 5 个/4 个，**不做磁贴**）：只有一个"标签 + 值"。
   * 口径与原因进 `title`/`aria-label`；取不到时值就是「未取到」四个字（原因照旧在悬停层）。
   */
  const item = (label: string, value: React.ReactNode, cls: string, note: string): React.ReactElement =>
    React.createElement('span', {
      className: 'it', title: note, tabIndex: 0, role: 'note',
      'aria-label': `${label} ${typeof value === 'string' ? value : ''} —— ${note}`,
    },
      React.createElement('span', { className: 'k' }, label),
      React.createElement('span', { className: `v ${cls}` }, value),
    )

  /** 内联行容器（一行到底，窄面板自动换行） */
  const inline = (...items: Array<React.ReactNode | null>): React.ReactElement =>
    React.createElement('div', { className: 'tw-dist-inline' }, ...items.filter((x) => x !== null))

  /** 图例行：色点 + 序列名 + 值（取不到时是「未取到」，原因进 title/aria） */
  const legendRow = (rows: Array<{ name: string; color: string; value: string; note: string }>): React.ReactElement =>
    React.createElement('div', { className: 'tw-dist-legend' },
      ...rows.map((r) => React.createElement('span', {
        key: r.name, className: 'lg', title: r.note, tabIndex: 0, role: 'note',
        'aria-label': `${r.name} ${r.value} —— ${r.note}`,
      },
        React.createElement('span', { className: 'dot', style: { background: r.color } }),
        React.createElement('span', null, r.name),
        React.createElement('span', { className: r.value === '未取到' ? 'tw-dim' : '' }, r.value),
      )),
    )

  return React.createElement(
    'div',
    { className: 'tw-body' },
    React.createElement('div', { className: 'tw-panel' },
      React.createElement('div', { className: 'tw-panel-h' },
        React.createElement('span', { className: 't' }, '涨跌分布'),
        React.createElement('span', { className: 'tw-muted' }, '沪深两市'),
      ),
      // ── 【涨跌分布】模块（v0.81.0 重排，对齐参考版 Arkvol）──
      // 左列三段（每段：小色条 + 标题）：涨跌趋势（一行 5 个内联统计）｜成交量（一行 4 个内联统计）｜两融走势（图例行）
      // 右列两块：涨跌分布（直方图，带纵轴与网格线）｜日内家数（双序列折线，无源 ⇒ 未取到 + 原因）
      React.createElement('div', { className: 'tw-dist-cols', 'data-role': 'dist-cols', 'data-cols': '2' },
        React.createElement('div', { className: 'tw-dist-col' },
          seg('涨跌趋势', 'trend',
            React.createElement('span', { className: 'tw-dist-seg-sub' }, '沪深两市'),
            inline(
              item('上涨', up === null ? '—' : String(up), breadthOk ? (redUp ? 'tw-up' : 'tw-down') : 'tw-dim', countsNote),
              item('平盘', even === null ? '—' : String(even), 'tw-dim', countsNote),
              item('下跌', down === null ? '—' : String(down), breadthOk ? (redUp ? 'tw-down' : 'tw-up') : 'tw-dim', countsNote),
              item('涨停', '未取到', 'tw-dim', LIMIT_REASON),
              item('跌停', '未取到', 'tw-dim', LIMIT_REASON),
            ),
            // 参考版副标题样式的一行小字：上涨占比 + 样本/快照说明（过长部分进悬停）
            // ⚠ 原「上证/深成两张大卡」按用户决定**直接删除**（这两个值在下方移出的「指数行情」表里仍可见）
            inline(
              item('上涨占比',
                breadth === null || breadth.percentile.value === null ? '—' : `${(breadth.percentile.value * 100).toFixed(1)}%`,
                'tw-dim',
                '上涨家数 ÷ 三类之和；与上方三格同一份家数口径'),
              breadth === null || breadth.percentile.pct === null
                ? item('近 N 日分位', '—', 'tw-dim', breadth === null
                    ? `涨跌家数分位本次未取到${breadthErr === null ? '' : `：${breadthErr}`}（稍后随行情轮询自动重试）`
                    : breadth.percentile.sampleSmall
                      ? `已存 ${breadth.percentile.n} 个交易日，需 ≥ ${breadth.minDays} 天；样本太少的"分位"是噪音，故不显示`
                      : '分位不可算（原因见数据来源）')
                : item('近 N 日分位', `${breadth.percentile.pct}%`, 'tw-dim',
                    `${breadth.percentile.metric}；分位定义：历史中 ≤ 当前值的比例（0 低 / 100 高）；样本 ${breadth.percentile.n} 日`),
              breadth === null || breadth.storedDays <= 0
                ? null
                : item('快照', `${breadth.storedDays}/${breadth.window} 天`, 'tw-dim',
                    `每日快照在收盘后记录一条；窗口 ${breadth.window} 日。累积到 ${breadth.minDays} 天后开始显示分位`),
            ),
          ),
          seg('成交量', 'volume', null,
            inline(
              item('当日成交额', cells.amountOk ? fmtAmt(cells.amount) : '未取到', cells.amountOk ? '' : 'tw-dim',
                cells.amountOk ? '沪深两市成交额（指数行情 f6 之和）' : cells.reason ?? '指数行情本轮没给成交额'),
              item('昨日成交', prevAmt === null ? '未取到' : fmtAmt(prevAmt.amount), prevAmt === null ? 'tw-dim' : '',
                prevAmt === null
                  ? '本地没有上一交易日的收盘快照（breadth.json 里没有那一天）——不用今天的数顶替'
                  : `上一交易日 ${prevAmt.day} 的收盘快照${prevAmt.final ? '（已定稿）' : '（尚未定稿）'}`),
              item('较昨日变动', delta === null ? '未取到' : `${delta >= 0 ? '+' : ''}${fmtAmt(delta)}`,
                delta === null ? 'tw-dim' : (delta >= 0 ? (redUp ? 'tw-up' : 'tw-down') : (redUp ? 'tw-down' : 'tw-up')),
                delta === null ? '取不到昨日成交就无法算变动（不是 0）' : '当日成交额 − 上一交易日收盘快照'),
              item('预测全天', '未取到', 'tw-dim', FORECAST_REASON),
            ),
          ),
          seg('两融走势', 'margin',
            React.createElement('span', { className: 'tw-dist-seg-sub' }, '本插件未集成两融数据源'),
            legendRow([
              { name: '两融余额', color: 'var(--tw-chip-avg, #c97a1c)', value: '未取到', note: MARGIN_REASON },
              { name: '上证指数', color: 'var(--tw-chip-sup, #2f74c0)', value: '未取到', note: '本段的主序列（两融余额）无源，单画一条指数会被读成"两融走势" ⇒ 不画' },
              { name: '融资净买', color: 'var(--tw-chip-res, #7a5cc4)', value: '未取到', note: MARGIN_REASON },
            ]),
          ),
        ),
        React.createElement('div', { className: 'tw-dist-col' },
          seg('涨跌分布', 'hist', null,
            React.createElement(DistHistogram, { distribution: breadth?.distribution ?? null, distErr: breadthErr }),
          ),
          seg('日内家数', 'intraday', null,
            legendRow([
              { name: '上涨家数', color: 'var(--tw-up)', value: '未取到', note: INTRADAY_REASON },
              { name: '下跌家数', color: 'var(--tw-down)', value: '未取到', note: INTRADAY_REASON },
            ]),
          ),
        ),
      ),
      // 家数整体取不到时的说明已并入上面三格（`countsNote`）；本模块不再单开常驻提示行
    ),
    // 指数表：**移出**【涨跌分布】模块，作为大盘页独立区块（自带标题；功能不变，点行仍看详情）
    React.createElement('div', { className: 'tw-panel', 'data-role': 'index-table' },
      React.createElement('div', { className: 'tw-panel-h' },
        React.createElement('span', { className: 't' }, '指数行情'),
        React.createElement('span', { className: 'tw-muted' }, '点行看详情'),
      ),
      React.createElement('div', { className: 'tw-tablewrap' },
        React.createElement('table', { className: 'tw-table', style: { minWidth: 560 } },
          React.createElement('thead', null,
            React.createElement('tr', null,
              React.createElement('th', null, '指数'),
              React.createElement('th', null, '现价'),
              React.createElement('th', null, '涨跌'),
              React.createElement('th', null, '幅度'),
              React.createElement('th', null, '上涨/下跌'),
              React.createElement('th', null, '成交额'),
            ),
          ),
          React.createElement('tbody', null,
            cnIndices.map((it) => {
              const q = quotes[it.secid]
              const cls = dirClass(q?.chg ?? null, redUp)
              return React.createElement('tr', {
                key: it.secid,
                className: 'tw-rowhover',
                style: { cursor: 'pointer' },
                tabIndex: 0,
                role: 'button',
                'aria-label': `${it.name} 详情`,
                onClick: () => openDetail(it.secid),
                onKeyDown: (e: React.KeyboardEvent) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault()
                    openDetail(it.secid)
                  }
                },
              },
                React.createElement('td', { className: 'tl' }, it.name),
                React.createElement('td', null, fmtPrice(q?.price ?? null)),
                React.createElement('td', { className: cls }, fmtSigned(q?.chg ?? null)),
                React.createElement('td', null, React.createElement('span', { className: `tw-chg-chip ${q?.pct === null || q?.pct === undefined ? 'tw-chip-flat' : (q.pct >= 0) === redUp ? 'tw-chip-up' : 'tw-chip-down'}` }, fmtPct(q?.pct ?? null))),
                React.createElement('td', { className: 'tw-dim' },
                  // 上涨/下跌是同一个事实的两个分量：一侧缺失就整格 —（否则会读成"没有一只下跌"）
                  upDownPair(q?.up, q?.down).ok
                    ? React.createElement(React.Fragment, null,
                        React.createElement('span', { className: dirClass(1, redUp) }, String(q?.up)),
                        ' / ',
                        React.createElement('span', { className: dirClass(-1, redUp) }, String(q?.down)),
                      )
                    : React.createElement('span', { tabIndex: 0, role: 'note', 'aria-label': UPDOWN_MISSING_NOTE, title: UPDOWN_MISSING_NOTE }, '—'),
                ),
                React.createElement('td', null, fmtAmt(q?.amount ?? null)),
              )
            }),
          ),
        ),
      ),
    ),
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
                title: boardMoneyOk ? undefined : '当前数据来自备用源（不含成交额字段），该排序暂不可用；东财恢复后自动可用',
                onClick: () => { if (boardMoneyOk) setSort('amount') },
              }, '成交额'),
            )
          : React.createElement('div', { className: 'tw-seg' },
              React.createElement('button', { 'data-on': sort === 'pct', onClick: () => setSort('pct') }, '涨跌幅'),
              React.createElement('button', {
                'data-on': sort === 'money',
                disabled: !boardMoneyOk,
                title: boardMoneyOk ? undefined : '当前数据来自备用源（不含主力净额字段），该排序暂不可用；东财恢复后自动可用',
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
              ? `东财行情接口暂不可用，${boardMeta.source === 'sina' ? 'ETF 排行来自新浪备用源' : '板块涨跌来自腾讯备用源'}；`
              : `东财行情接口暂不可用，显示上次成功数据（${boardMeta.asOf !== undefined ? shClockText(boardMeta.asOf).slice(0, 5) : '—'}）；`,
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
                key: `${r.code}-${i}`,
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
                  ? [React.createElement('td', { key: 'a' }, fmtAmt(r.amount ?? null)), React.createElement('td', { key: 't' }, r.turnover !== null && r.turnover !== undefined ? `${r.turnover.toFixed(2)}%` : '—')]
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
                            className: dirClass(shareOf(r), redUp),
                            title: shareOf(r) === null ? '净占比不可算：缺主力净额或成交额' : `${fmtAmt(r.money ?? null)} ÷ ${fmtAmt(r.amount ?? null)}`,
                          }, shareOf(r) === null ? '—' : `${shareOf(r)!.toFixed(2)}%`)
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
          ? React.createElement(Btn, { onClick: () => loadBoard(scope, sort, page + 1, true) }, '加载更多')
          : null,
      ),
    ),
    // 【个股 / 基金查询】整块已删（task-14 ①）：搜索框 + 下方说明 + 内联详情卡
    // 详情仍可达：点指数/ETF 行 ⇒ DetailModal（下面那块，未动）
    pick !== null && detail !== null
      ? React.createElement(DetailModal, { detail, trend, redUp, onClose: () => { setPick(null); setDetail(null); setTrend(null) } })
      : null,
  )
}

/**
 * 【涨跌分布】直方图（task-14 ②）：宿主给的**分档计数**，柱高按最大档归一，柱上标数。
 *
 * 红线：`counts === null`（没扫全）⇒ 只说「未取到」+ 原因，**不画部分数据**（那会被读成全市场分布）。
 * 柱宽用百分比、不用固定 px：面板窄了也不会把某个档挤成 0 宽（同 v0.54.0 的宽度契约）。
 */
function DistHistogram(props: {
  distribution: { labels: string[]; counts: number[] | null; blank: number; scanned: number; total: number | null; reason: string | null } | null
  distErr: string | null
}): React.ReactElement {
  const d = props.distribution
  if (d === null || d.counts === null) {
    const reason = props.distErr ?? d?.reason ?? '本轮没取到分档计数（稍后自动重试）'
    return React.createElement('div', {
      className: 'tw-hint tw-dim',
      title: reason,
      'aria-label': `涨跌分布未取到 —— ${reason}`,
      tabIndex: 0,
      role: 'note',
    }, '未取到')
  }
  // 纵轴：值域按数据取整（1/2/5 × 10ⁿ）⇒ 刻度是整洁数字；柱高按**轴的上界**归一（与网格线对齐）
  const axis = distAxisOf(d.counts)
  const yAxis = React.createElement('div', { className: 'tw-dist-axis', 'data-role': 'dist-axis' },
    ...axis.ticks.map((t) => React.createElement('span', {
      key: `t${t}`, className: 'tk', 'data-role': 'dist-ytick', style: { bottom: `${distBarPctOf(t, axis.max)}%` },
    }, String(t))),
  )
  const grid = React.createElement('div', { className: 'tw-dist-grid', 'data-role': 'dist-grid' },
    ...axis.ticks.filter((t) => t > 0).map((t) => React.createElement('span', {
      key: `g${t}`, className: 'gl', 'data-role': 'dist-gridline', style: { bottom: `${distBarPctOf(t, axis.max)}%` },
    })),
  )
  return React.createElement('div', {
    className: 'tw-dist-chart',
    'data-role': 'dist-chart',
    title: `纵轴上界 ${axis.max}（按数据取整）；覆盖 ${d.scanned} 只 / 全市场 ${d.total ?? '未知'} 只；无涨跌幅（停牌等）${d.blank} 只未计入任何档`,
  },
    yAxis,
    grid,
    React.createElement('div', { className: 'tw-dist-hist' },
      ...d.labels.map((label, i) => React.createElement('div', { key: label, className: 'tw-dist-bar-wrap' },
        React.createElement('div', { className: 'tw-dist-count' }, String(d.counts?.[i] ?? 0)),
        React.createElement('div', { className: `tw-dist-bar ${i < 4 ? 'up' : i === 4 ? 'flat' : 'down'}` },
          React.createElement('div', { className: 'tw-dist-bar-fill', style: { height: `${Math.max(1, distBarPctOf(d.counts?.[i] ?? 0, axis.max))}%` } }),
        ),
        React.createElement('div', { className: 'tw-dist-label' }, label),
      )),
    ),
  )
}

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
