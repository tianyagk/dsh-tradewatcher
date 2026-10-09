/** A股大盘行情: index overview + breadth/amount stats, sector & ETF boards,
 *  money-flow ranking (boards sorted by main-capital inflow), stock search
 *  with detail card + intraday chart. */
import React, { useCallback, useEffect, useState } from 'react'
import type { BoardRow, QuoteRow, StockDetail, TrendData } from '../shared/model.ts'
import { api } from './api.ts'
import { UPDOWN_MISSING_NOTE, breadthCells, pickBreadthCounts, upDownPair } from './breadthView.ts'
import { dirClass, fmtAmt, fmtBig, fmtPct, fmtPrice, fmtSigned } from './format.ts'
import { CN_PHASE_LABEL, cnSessionState } from './marketTime.ts'
import { useNow } from './useNow.ts'
import { Btn, ErrorNote, Modal, SuggestInput } from './ui.tsx'
import { Sparkline } from './charts.tsx'
import { RescuePanel } from './RescuePanel.tsx'
import type { PortPrefs, QuoteSource } from '../shared/model.ts'

type Scope = 'industry' | 'concept' | 'etf'

/** 时刻一律 `HH:mm:ss`（用词表：页面级"数据时刻"；禁用 toLocaleString 的默认输出） */
function hhmmssOf(ts: number): string {
  const d = new Date(ts)
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
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
  const [detailLoading, setDetailLoading] = useState(false)
  const [detailError, setDetailError] = useState<string | null>(null)

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
      .breadth()
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
    setDetailLoading(true)
    setDetailError(null)
    api
      .detail(secid)
      .then((r) => setDetail(r.detail))
      .catch((e: Error) => setDetailError(e.message))
    api
      .trend(secid)
      .then((r) => setTrend(r.trend))
      .catch(() => undefined)
      .finally(() => setDetailLoading(false))
  }

  const statCell = (label: string, v: React.ReactNode, cls?: string, title?: string): React.ReactElement =>
    React.createElement('div', { className: 'tw-stat', ...(title === undefined ? {} : { title }) },
      React.createElement('div', { className: 'k' }, label),
      React.createElement('div', { className: `v ${cls ?? ''}` }, v),
    )

  return React.createElement(
    'div',
    { className: 'tw-body' },
    React.createElement('div', { className: 'tw-panel' },
      React.createElement('div', { className: 'tw-panel-h' },
        React.createElement('span', { className: 't' }, 'A股全景'),
        React.createElement('span', { className: 'tw-muted' }, '沪深两市'),
      ),
      React.createElement('div', { className: 'tw-statrow' },
        statCell('上涨', up === null ? '—' : String(up), breadthOk ? (redUp ? 'tw-up' : 'tw-down') : '', countsTitle),
        statCell('下跌', down === null ? '—' : String(down), breadthOk ? (redUp ? 'tw-down' : 'tw-up') : '', countsTitle),
        statCell('平盘', even === null ? '—' : String(even), undefined, countsTitle),
        React.createElement('div', { className: 'tw-stat-sep' }),
        statCell('两市成交额', cells.amountOk ? `${fmtAmt(cells.amount)}` : '—'),
        statCell('上证', sh?.price !== undefined && sh?.price !== null ? fmtPrice(sh.price) : '—', dirClass(sh?.chg ?? null, redUp)),
        statCell('深成', sz?.price !== undefined && sz?.price !== null ? fmtPrice(sz.price) : '—', dirClass(sz?.chg ?? null, redUp)),
      ),
      // 缺失必须能被键盘/触屏读到（不能只挂在 title 上：那是鼠标专属）
      breadthOk
        ? null
        : React.createElement('div', {
            className: 'tw-hint',
            style: { color: 'var(--tw-up)' },
            tabIndex: 0,
            role: 'note',
            'aria-label': `涨跌家数本次未取到：${countsReason ?? '原因未给出'}`,
          }, `涨跌家数本次未取到：${countsReason ?? '原因未给出'}`),
      // P1-8：分位必须带口径与样本量一起读；样本不足或取不到时不显示分位（而不是显示 0）
      breadthErr !== null
        ? React.createElement('div', { className: 'tw-hint', style: { color: 'var(--tw-up)' } }, `涨跌家数分位本次未取到：${breadthErr}（稍后随行情轮询自动重试）`)
        : breadth !== null
          ? React.createElement('div', { className: 'tw-hint', style: { display: 'flex', gap: 12, flexWrap: 'wrap' } },
              breadth.current === null
                ? React.createElement('span', { style: { color: 'var(--tw-up)' } }, breadth.missing[0]?.note ?? '涨跌家数未取到')
                : React.createElement(React.Fragment, null,
                    React.createElement('span', null,
                      `上涨占比 ${breadth.percentile.value === null ? '—' : (breadth.percentile.value * 100).toFixed(1) + '%'}`),
                    breadth.percentile.pct === null
                      ? React.createElement('span', {
                          className: 'tw-muted',
                          tabIndex: 0,
                          role: 'note',
                          title: breadth.percentile.sampleSmall
                            ? `已存 ${breadth.percentile.n} 个交易日，需 ≥ ${breadth.minDays} 天；样本太少的"分位"是噪音，故不显示`
                            : '分位不可算（原因见数据来源）',
                        },
                          breadth.percentile.sampleSmall
                            ? `样本不足 ${breadth.percentile.n}/${breadth.minDays} 天`
                            : '分位不可算')
                      : React.createElement('span', {
                          title: `${breadth.percentile.metric}；分位定义：历史中 ≤ 当前值的比例（0 低 / 100 高）`,
                        }, `近 ${breadth.percentile.n} 日分位 ${breadth.percentile.pct}%`),
                    // 家数可能是**本插件自己统计**出来的（源 A 拿不到时）：来源与时刻必须与上游给的能区分开。
                    // 正文压到 ≤12 字，口径全文进 title/aria（读屏无法悬停 ⇒ aria 必须自包含）
                    breadth.current.source === 'em-index'
                      ? null
                      : React.createElement('span', {
                          tabIndex: 0,
                          role: 'note',
                          title: breadth.current.caliber ?? '本插件自行统计',
                          'aria-label': `涨跌家数由本插件自行统计。${breadth.current.caliber ?? ''}数据时刻 ${
                            breadth.current.asOf === null ? '未知' : hhmmssOf(breadth.current.asOf)
                          }`,
                        }, `· 自统计 ${breadth.current.asOf === null ? '—' : hhmmssOf(breadth.current.asOf)}`),
                  ),
              React.createElement('span', {
                className: 'tw-muted',
                title: `每日快照在收盘后记录一条；窗口 ${breadth.window} 日。累积到 ${breadth.minDays} 天后开始显示分位`,
              }, breadth.storedDays > 0 ? `· 快照 ${breadth.storedDays}/${breadth.window} 天` : `· 快照累积中（${breadth.minDays} 天后出分位）`),
            )
          : null,
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
              React.createElement('button', { 'data-on': sort === 'amount', onClick: () => setSort('amount') }, '成交额'),
            )
          : React.createElement('div', { className: 'tw-seg' },
              React.createElement('button', { 'data-on': sort === 'pct', onClick: () => setSort('pct') }, '涨跌幅'),
              React.createElement('button', { 'data-on': sort === 'money', onClick: () => setSort('money') }, '主力资金'),
            ),
 // 主力资金排行下的两种口径（金额 / 占比）
        sort === 'money' && scope !== 'etf'
          ? React.createElement('div', { className: 'tw-seg', title: '主力净额为本插件直接取用的上游字段；占比＝净额 ÷ 成交额（本页内重排，见下方说明）' },
              React.createElement('button', { 'data-on': moneySort === 'money', onClick: () => setMoneySort('money') }, '金额'),
              React.createElement('button', { 'data-on': moneySort === 'share', onClick: () => setMoneySort('share') }, '占比'),
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
        `数据时刻 ${boardMeta?.asOf !== undefined ? new Date(boardMeta.asOf).toLocaleTimeString('zh-CN', { hour12: false }) : '—'}` +
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
              : `东财行情接口暂不可用，显示上次成功数据（${boardMeta.asOf !== undefined ? new Date(boardMeta.asOf).toLocaleTimeString('zh-CN', { hour12: false }).slice(0, 5) : '—'}）；`,
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
    React.createElement('div', { className: 'tw-panel' },
      React.createElement('div', { className: 'tw-panel-h' },
        React.createElement('span', { className: 't' }, '个股 / 基金查询'),
      ),
      React.createElement(SuggestInput, {
        onPick: (item) => openDetail(item.secid),
        placeholder: '搜索 A股/港股/ETF/基金/指数（600519、02155、茅台…）',
      }),
      detailLoading && pick !== null
        ? React.createElement('div', { className: 'tw-loading' }, '加载行情详情…')
        : detailError !== null
          ? React.createElement('div', { className: 'tw-error' }, detailError)
          : detail !== null
            ? React.createElement(DetailCard, { detail, trend, redUp })
            : React.createElement('div', { className: 'tw-hint', style: { marginTop: 6 } }, '点击指数、ETF 行或搜索后显示详情（价格/分时/基础数据）。'),
    ),
    pick !== null && detail !== null
      ? React.createElement(DetailModal, { detail, trend, redUp, onClose: () => { setPick(null); setDetail(null); setTrend(null) } })
      : null,
  )
}

function DetailCard(props: { detail: StockDetail; trend: TrendData | null; redUp: boolean }): React.ReactElement {
  const d = props.detail
  const cls = dirClass(d.chg ?? null, props.redUp)
  const t = props.trend
  const points = (t?.points ?? []).map((p) => ({ t: p.t, value: p.price }))
  const lastUp = points.length > 1 && t?.prePrice !== null && t?.prePrice !== undefined
    ? points[points.length - 1].value >= (t.prePrice as number)
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
