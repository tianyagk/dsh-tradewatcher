/** A股大盘行情: index overview + breadth/amount stats, sector & ETF boards,
 *  money-flow ranking (boards sorted by main-capital inflow), stock search
 *  with detail card + intraday chart. */
import React, { useCallback, useEffect, useRef, useState } from 'react'
import type { BoardRow, QuoteRow, StockDetail, TrendData } from '../shared/model.ts'
import { api } from './api.ts'
import { MINUTE_BARS, missingCellText } from './marketBlocks.ts'
import { UPDOWN_MISSING_NOTE, upDownPair } from './breadthView.ts'
import { dirClass, fmtAmt, fmtBig, fmtPct, fmtPrice, fmtSigned } from './format.ts'
import { CN_PHASE_LABEL, cnSessionState, shClockText } from './marketTime.ts'
import { useNow } from './useNow.ts'
import { Btn, EmptyHint, ErrorNote, Modal } from './ui.tsx'
import { Sparkline } from './charts.tsx'
import { RescuePanel } from './RescuePanel.tsx'
import type { PortPrefs, QuoteSource } from '../shared/model.ts'
import { isUsableBaseline } from './trendView.ts'
import { BREADTH_MIN_INTERVAL_MS, EXTRAS_MIN_INTERVAL_MS, dueByInterval } from './pacing.ts'

type Scope = 'industry' | 'concept' | 'etf'

type Sort = 'pct' | 'money' | 'amount'

const SCOPE_LABEL: Record<Scope, string> = { industry: '行业板块', concept: '概念板块', etf: 'ETF排行' }

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
  /** 四类数据块的统一重试令牌（点一次 +1，相关 effect 重新拉取） */
  const [mkRetry, setMkRetry] = useState(0)
  /** 汪汪队跟踪（v0.186.0）：窗口 + 回包 + 错误 */
  const [dwWindow, setDwWindow] = useState<'3m' | '6m' | '1y' | '2y'>('1y')
  const [dogwatch, setDogwatch] = useState<Awaited<ReturnType<typeof api.dogwatch>> | null>(null)
  const [dwErr, setDwErr] = useState<string | null>(null)
  const [breadth, setBreadth] = useState<Awaited<ReturnType<typeof api.breadth>> | null>(null)
  /** 附加行情（v0.187.0：只剩涨停/跌停家数一处消费，挂在汪汪队卡头） */
  const [extras, setExtras] = useState<Awaited<ReturnType<typeof api.marketExtras>> | null>(null)
  /**
   * 涨跌家数分布（U3）：依赖从 `quotes`（**对象身份**，每拍都换）改成 `quoteTs`（节拍信号），
   * 并且最小间隔 **60s** —— `dist=1` 会在宿主侧"多扫 ~56 页"，每 10s 重来一次纯属浪费。
   * 副作用（数据最多旧 60s）写在下方格子的 `title` 里。
   */
  const breadthAt = useRef<number | null>(null)
  useEffect(() => {
    const at = Date.now()
    if (!dueByInterval(at, breadthAt.current, BREADTH_MIN_INTERVAL_MS)) return
    breadthAt.current = at
    let alive = true
    api
      // v0.187.0：直方图已下线 ⇒ 不再请求 dist=1（宿主侧 56 页扫描不再触发）
      .breadth()
      .then((b) => {
        if (alive) {
          setBreadth(b)
        }
      })
      .catch(() => undefined)
    return () => {
      alive = false
    }
    // 只跟节拍走：不再依赖 quotes 对象身份（分位只在收盘后变化，当日数值跟着 60s 节拍动）
  }, [props.quoteTs, mkRetry])

  // 附加行情（v0.81.2）：涨停/跌停家数、两融（双源交叉）、全天成交额预测。
  // 预测要把"页面自己已经显示的那个当日成交额"带过去（宿主不再抓一遍）；缺/0 ⇒ 预测部分如实缺失。
  /** 成交额分时/分钟增减的数据（指数 2 日分时；每分钟带 amount） */
  const amountForForecast = breadth?.current?.amount ?? null
  /**
   * 附加行情（U3）：同样从"每拍一次"改成**按节拍 + 30s 最小间隔**。
   * 预测要用页面上那个当日成交额 ⇒ `amountForForecast` 仍是实参、也在依赖里（它是数字，
   * 不是会换身份的对象）；有了 30s 下限，它最多把调用提到"30 秒一次"。
   */
  /**
   * 成交额分时 / 分钟增减：取指数（沪指）**2 日**分时 —— 每分钟 bar 自带 `amount`，
   * 今日/昨日各自逐分钟累加即可；预测线用 `extras.forecast.forecast` 画水平虚线。
   * 昨日序列拿不到 ⇒ 分钟卡 `—（昨日分钟额不可得）`，不拿今日冒充。
   */
  /** 附加行情（涨停/跌停/两融/预测）的节拍说明：写进各自 `title`，别让用户以为它跟行情条同频 */
  useEffect(() => {
    let alive = true
    api.marketExtras(null).then((x) => { if (alive) setExtras(x) }).catch(() => undefined)
    return () => { alive = false }
  }, [mkRetry])

  useEffect(() => {
    let alive = true
    setDwErr(null)
    api.dogwatch(dwWindow).then((r) => { if (alive) setDogwatch(r) }).catch((e: Error) => { if (alive) setDwErr(e.message) })
    return () => { alive = false }
  }, [dwWindow, mkRetry])

  const EXTRAS_POLL_NOTE = '；本格按 30 秒节拍刷新（节流后最多旧 30 秒）'


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
    { className: 'tw-body' },
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
  void INTRADAY_REASON; void seg; void legendRow; void amountForForecast; void EXTRAS_MIN_INTERVAL_MS
  const dwMetric = (k: string, v: string, sub: string): React.ReactElement =>
        React.createElement('div', { className: 'tw-dw-m' },
          React.createElement('div', { className: 'k' }, k),
          React.createElement('div', { className: 'v' }, v),
          sub === '' ? null : React.createElement('div', { className: 's' }, sub))
      const b = breadth?.current ?? null
      void b
      // v0.184.0：用户要求下线左列四卡 —— 单列只剩「涨跌分布」与「分钟成交额较昨日增减」
      // v0.187.0：用户要求下线「涨跌分布」「分钟成交额较昨日增减」；页面只剩护盘信号 + 汪汪队跟踪
      const dogwatchCard = (
        card('汪汪队跟踪', React.createElement(React.Fragment, null,
          React.createElement('div', { className: 'tw-seg' },
          ...(['3m', '6m', '1y', '2y'] as const).map((w) => React.createElement('button', {
            key: w, className: `tw-tab${dwWindow === w ? ' is-on' : ''}`, style: { fontSize: 12 },
            onClick: () => setDwWindow(w),
          }, w === '3m' ? '3月' : w === '6m' ? '6月' : w === '1y' ? '1年' : '2年')))),
          dwErr !== null
            ? React.createElement('div', { className: 'tw-mk-empty' }, missingCellText(dwErr))
            : dogwatch === null
              ? React.createElement('div', { className: 'tw-mk-empty' }, missingCellText('加载中'))
              : React.createElement(React.Fragment, null,
                  React.createElement('div', { className: 'tw-dw-metrics', 'data-role': 'dw-metrics' },
                    dwMetric('总份额', dogwatch.rows.reduce((a, r) => a + (r.shares ?? 0), 0).toFixed(1), '亿份'),
                    dwMetric('合计成交额', dogwatch.summary.totalAmount === null ? '—' : (dogwatch.summary.totalAmount / 1e8).toFixed(1), '亿元'),
                    dwMetric('放大倍数', dogwatch.summary.ratio === null ? '—' : `${dogwatch.summary.ratio.toFixed(2)}x`, '当日 ÷ 20日均'),
                    dwMetric('主动净买入', dogwatch.summary.netBuy === null ? '—' : (dogwatch.summary.netBuy / 1e8).toFixed(2), '亿元'),
                    dwMetric('加权涨跌', dogwatch.summary.weightedPct === null ? '—' : `${dogwatch.summary.weightedPct.toFixed(2)}%`, ''),
                    dwMetric('加仓指数', dogwatch.series.length === 0 ? '—' : dogwatch.series[dogwatch.series.length - 1]!.index.toFixed(1), dogwatch.summary.baseDate ?? '')),
                  dogwatch.sharesStale
                    ? React.createElement('div', { className: 'tw-hint', style: { fontSize: 12, color: 'var(--tw-warn)' } }, '—（份额源未日更）')
                    : null,
                  React.createElement('table', { className: 'tw-dw-table', 'data-role': 'dw-table' },
                    React.createElement('thead', null, React.createElement('tr', null,
                      React.createElement('th', null, 'ETF'), React.createElement('th', null, '指数'),
                      React.createElement('th', null, '规模(亿份)'), React.createElement('th', null, '份额变化(亿份)'),
                      React.createElement('th', null, '成交额(亿)'), React.createElement('th', null, '涨跌'))),
                    React.createElement('tbody', null, ...dogwatch.rows.map((r) => React.createElement('tr', { key: r.secid },
                      React.createElement('td', null, r.name),
                      React.createElement('td', { className: 'tw-muted' }, r.indexName),
                      React.createElement('td', null, r.scale === null ? '—' : r.scale.toFixed(1)),
                      React.createElement('td', { title: dogwatch.sharesStale ? '份额源未日更' : (r.sharesDelta === null ? '缺上一交易日份额' : undefined) }, dogwatch.sharesStale || r.sharesDelta === null ? '—' : `${r.sharesDelta > 0 ? '+' : ''}${r.sharesDelta.toFixed(2)}`),
                      React.createElement('td', null, r.amount === null ? '—' : (r.amount / 1e8).toFixed(2)),
                      React.createElement('td', null, r.pct === null ? '—' : `${r.pct > 0 ? '+' : ''}${r.pct.toFixed(2)}%`))))),
                  dogwatch.missing.length > 0
                    ? React.createElement('div', { className: 'tw-hint tw-dim', style: { fontSize: 12 }, title: dogwatch.missing.map((m) => m.note).join('；') }, `缺 ${dogwatch.missing.length} 项（悬停看原因）`)
                    : null))
      )
      return React.createElement('div', {
        className: 'tw-mk-body',
        'data-bars': String(MINUTE_BARS),
        // 附加行情仍在使用（供 agent/排障读原始家数；界面不再展示）
        'data-limits': `${extras?.limits.up.count ?? ''}/${extras?.limits.down.count ?? ''}`,
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
