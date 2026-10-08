/** 自选 page: grouped watchlist with live quotes from the shared engine. */
import React, { useCallback, useEffect, useRef, useState } from 'react'
import { DEFAULT_PREFS, type PortPrefs, type QuoteRow, type SuggestItem, type WatchData } from '../shared/model.ts'
import { api } from './api.ts'
import { dirClass, fmtAmt, fmtPct, fmtPrice, fmtSigned, pctArrow } from './format.ts'
import { Btn, EmptyHint, ErrorNote, Field, Modal, MoreMenu, Skeleton, SuggestInput } from './ui.tsx'
import { MiniTrend } from './charts.tsx'
import { useMiniTrends } from './mini.ts'
import { NO_SOURCE_LABEL, PENDING_LABEL, PENDING_TITLE } from './quoteState.ts'
import { SILENCE_MS, useWatchAlerts, type AlertRow } from './alerts.ts'
import { SortBar } from './SortBar.tsx'
import { SortHeader } from './SortHeader.tsx'
import { WATCH_COLUMNS, WATCH_SORT_HINT, WATCH_SORT_KEYS, WATCH_SORT_LABEL, normalizeSortState, sortWatch, type WatchSortKey } from './sort.ts'
import { useYtd } from './useYtd.ts'
import { useWideLayout } from './useWide.ts'
import { ytdMissingSummary, ytdText, ytdTooltip } from './ytdView.ts'

type ModalState =
  | { kind: 'addGroup' }
  | { kind: 'renameGroup'; groupId: string; name: string }
  | { kind: 'noteGroup'; groupId: string; name: string; note: string }
  | { kind: 'addItem'; groupId: string; groupName: string }
  | { kind: 'moveItem'; groupId: string; groupName: string; itemId: string; itemName: string; secid: string }
  | null

export function WatchlistPage(props: {
  quotes: Record<string, QuoteRow>
  /** 共享行情引擎最近一次成功更新的时间戳：异动判定跟着它走（行情没变就不重判） */
  quoteTs?: number | null
  /** 没有任何源给出价格的标的（大写键）；用于区分「无行情源」与「暂无行情」（等下一拍） */
  missing?: Set<string>
  quotesReady: boolean
  prefs: PortPrefs
  setPrefs: (patch: Partial<PortPrefs>) => void
  onSymbols: (ids: string[]) => void
  /** 打开详情抽屉（由 App 统一渲染，见 index.tsx） */
  onOpenDetail?: (secid: string, name: string) => void
}): React.ReactElement {
  const { quotes, missing, quotesReady, prefs, setPrefs, onSymbols, onOpenDetail } = props
  const [alertsOpen, setAlertsOpen] = useState(false)
  const openDetail = (secid: string, name: string): void => onOpenDetail?.(secid, name)
  const noSource = (secid: string): boolean => missing?.has(secid.toUpperCase()) === true
  // 兼容"客户端已刷新、宿主还没重启"：旧 /prefs 响应里没有 watchSort 字段，
  // 此时回退默认而不是让 state.key 取到 undefined（否则整页崩）
  const watchSort = normalizeSortState(prefs.watchSort, WATCH_SORT_KEYS, DEFAULT_PREFS.watchSort)
  const [watch, setWatch] = useState<WatchData | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [modal, setModal] = useState<ModalState>(null)
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})
  const [showArchived, setShowArchived] = useState(false)
  const miniIds = React.useMemo(() => {
    const ids = new Set<string>()
    if (watch !== null) for (const it of watch.items) ids.add(it.secid)
    return [...ids]
  }, [watch])
  const minis = useMiniTrends(miniIds, true)
  const alertIds = React.useMemo(() => {
    const ids = new Set<string>()
    if (watch !== null) for (const it of watch.items) ids.add(it.secid)
    return [...ids]
  }, [watch])
  // P1-4：异动判定（宿主侧算，客户端只负责提醒策略与静默窗口）
  const alerts = useWatchAlerts(alertIds, props.quoteTs ?? null, true)
  const alertOf = React.useMemo(() => {
    const m = new Map<string, AlertRow>()
    for (const a of alerts.alerts) m.set(a.secid, a)
    // 被静默压制的也算"正在异动"：行高亮不该因为"提醒过了"就消失
    for (const a of alerts.suppressed) m.set(a.secid, a)
    return m
  }, [alerts.alerts, alerts.suppressed])
  const [inds, setInds] = useState<Record<string, { name: string; pct: number | null }>>({})
  /**
   * 行业/板块请求的状态（P1-3）。
   *
   * 此前失败被 `catch(() => undefined)` 静默吞掉：上游限流时每一行都不显示板块信息，
   * 看上去就像"这些标的本来就没有行业归属"。两种情形的含义完全不同 ——
   * 前者等一会儿就有，后者等多久都没有 —— 所以必须区分并说出来。
   */
  const [indState, setIndState] = useState<{ status: 'idle' | 'ok' | 'error'; at: number | null; error: string | null }>({ status: 'idle', at: null, error: null })
  const indSeq = useRef(0)
  useEffect(() => {
    if (watch === null) return
    const secs = [...new Set(watch.items.map((i) => i.secid))]
    if (secs.length === 0) {
      setInds({})
      setIndState({ status: 'ok', at: Date.now(), error: null })
      return
    }
    const n = ++indSeq.current
    api
      .industries(secs)
      .then((r) => {
        if (n !== indSeq.current) return
        setInds(r.map)
        setIndState({ status: 'ok', at: Date.now(), error: null })
      })
      .catch((e: Error) => {
        if (n !== indSeq.current) return
        setIndState({ status: 'error', at: Date.now(), error: e.message })
      })
    // 依赖 quotes：每次行情轮询后同步刷新板块涨幅与 alpha
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [watch, quotes])

  // 年初至今（YTD）：现价来自共享行情引擎，基准是宿主按日 memo 的日线（见 host/ytd.ts）
  const ytd = useYtd(miniIds, props.quoteTs ?? null, true)

  /**
   * α 的**唯一**算法（P1-3）：个股涨跌幅 − 板块涨跌幅。
   *
   * 列头排序（「行业 α」）与行内显示共用这一处 —— 否则会出现"按 α 排出来的顺序与列里
   * 显示的 α 对不上"，而这种错在界面上看不出来。任一侧取不到就是 null（不拿 0 顶替）。
   */
  const alphaOf = (secid: string): { stockPct: number | null; boardPct: number | null; alpha: number | null } => {
    const stockPct = quotes[secid]?.pct ?? null
    const boardPct = inds[secid]?.pct ?? null
    const alpha = stockPct !== null && boardPct !== null ? Math.round((stockPct - boardPct) * 100) / 100 : null
    return { stockPct, boardPct, alpha }
  }

  // 页面级 YTD 缺失摘要：逐行给 tooltip，整体只说"有几项算不出 + 第一条原因"
  const ytdSummary = ytd.loaded ? ytdMissingSummary(Object.values(ytd.map)) : null
  // 宽窄判定：**只挂其中一个**排序控件（此前是两个都挂、靠 CSS 藏一个，实测会同时出现）
  const wide = useWideLayout()

  const reload = useCallback(() => {
    api
      .watch()
      .then((r) => {
        setWatch(r.watch)
        setError(null)
      })
      .catch((e: Error) => setError(e.message))
  }, [])

  useEffect(() => {
    reload()
  }, [reload])

  useEffect(() => {
    if (watch === null) return
    const ids = [...new Set(watch.items.filter((i) => i.groupId !== undefined).map((i) => i.secid))]
    onSymbols(ids)
  }, [watch, onSymbols])

  const mutate = (body: Parameters<typeof api.mutateWatch>[0], done?: () => void): void => {
    setError(null)
    api
      .mutateWatch(body)
      .then((r) => {
        setWatch(r.watch)
        done?.()
      })
      .catch((e: Error) => setError(e.message))
  }

  if (watch === null) return React.createElement('div', { className: 'tw-body' }, React.createElement(Skeleton, { lines: 4, height: 16 }))

  const groups = [...watch.groups].sort((a, b) => a.order - b.order)
  const active = groups.filter((g) => g.archived !== true)
  const archived = groups.filter((g) => g.archived === true)

  const itemsOf = (groupId: string): Array<{ id: string; groupId: string; name: string; secid: string; note?: string }> =>
    watch.items.filter((i) => i.groupId === groupId)

  return React.createElement(
    'div',
    { className: 'tw-body' },
    React.createElement(ErrorNote, { error }),
    React.createElement(
      'div',
      { className: 'tw-panel', style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } },
      React.createElement('span', { className: 't' }, '自选分组'),
      // 排序：分组内生效（同一设置应用到所有分组），存进 prefs 所以重开面板仍生效
      // 窄屏才挂段控；宽屏挂列头（见下方）。**互斥由这里决定，不再依赖 CSS 隐藏**
      wide
        ? null
        : React.createElement(SortBar<WatchSortKey>, {
            keys: WATCH_SORT_KEYS,
            labels: WATCH_SORT_LABEL,
            hints: WATCH_SORT_HINT,
            state: watchSort,
            onChange: (next) => setPrefs({ watchSort: next }),
            ariaLabel: '自选排序',
          }),
      React.createElement('span', { style: { flex: 1 } }),
      // P1-4：异动徽标队列。数字是"需要提醒的条数"；被静默压制的单独标出，
      // 否则"我明明看到它在异动，为什么徽标是 0"会变成新的困惑
      alerts.alerts.length > 0 || alerts.suppressed.length > 0
        ? React.createElement('span', {
            className: 'tw-badge',
            style: { cursor: 'pointer', color: alerts.alerts.length > 0 ? 'var(--tw-up)' : 'var(--tw-muted)', borderColor: alerts.alerts.length > 0 ? 'var(--tw-up)' : undefined },
            title: '点击展开异动队列（同一条目 30 分钟内只提醒一次，静默不改变"它正在异动"这个事实）',
            onClick: () => setAlertsOpen((v) => !v),
          }, `异动 ${alerts.alerts.length}${alerts.suppressed.length > 0 ? `（静默 ${alerts.suppressed.length}）` : ''}${alertsOpen ? ' ▲' : ' ▼'}`)
        : null,
      archived.length > 0
        ? React.createElement(Btn, { onClick: () => setShowArchived((v) => !v) }, `已归档 ${archived.length}`)
        : null,
      React.createElement(Btn, { primary: true, onClick: () => setModal({ kind: 'addGroup' }) }, '+ 新建分组'),
    ),
    // 异动队列（P1-4）
    alertsOpen
      ? React.createElement('div', { className: 'tw-panel', style: { padding: '6px 8px' } },
          React.createElement('div', { className: 'tw-sub-h' }, '异动队列',
            React.createElement('span', { style: { flex: 1 } }),
            React.createElement('span', { className: 'tw-muted', style: { fontSize: 10.5 } },
              alerts.asOf === null ? '尚未判定' : `判定于 ${new Date(alerts.asOf).toLocaleTimeString('zh-CN', { hour12: false })} · 静默窗口 ${SILENCE_MS / 60000} 分钟`),
          ),
          alerts.alerts.length === 0 && alerts.suppressed.length === 0
            ? React.createElement('div', { className: 'tw-hint', style: { margin: 0 } },
                alerts.calm > 0 ? `${alerts.calm} 条已判定、均无异常。` : '本轮没有可判定的条目。')
            : React.createElement('div', null,
                ...alerts.alerts.map((a) =>
                  React.createElement('div', { key: a.secid, className: 'tw-wrow', style: { borderTop: '1px solid var(--tw-border)', padding: '4px 2px', cursor: 'pointer' }, onClick: () => openDetail(a.secid, a.name) },
                    React.createElement('div', { className: 'nm' },
                      React.createElement('b', null, a.name),
                      React.createElement('span', { className: 'tw-code' }, a.secid),
                    ),
                    React.createElement('div', { className: 'tw-hint', style: { margin: 0, flex: 1 } }, a.reasons.join(' · ')),
                  ),
                ),
                ...alerts.suppressed.map((a) =>
                  React.createElement('div', { key: `s-${a.secid}`, className: 'tw-wrow', style: { borderTop: '1px solid var(--tw-border)', padding: '4px 2px', opacity: 0.6 } },
                    React.createElement('div', { className: 'nm' }, React.createElement('b', null, a.name), ' ', React.createElement('span', { className: 'tw-muted', style: { fontSize: 10.5 } }, '静默中')),
                    React.createElement('div', { className: 'tw-hint', style: { margin: 0, flex: 1 } }, a.reasons.join(' · ')),
                  ),
                ),
              ),
          // 「没判定」必须与「判定过且正常」分开说：样本不足时说"正常"是错的信息
          alerts.skipped.length > 0
            ? React.createElement('div', { className: 'tw-hint', style: { marginTop: 4 } },
                `${alerts.skipped.length} 条本次「未判定」（不等于正常）：` +
                [...new Set(alerts.skipped.flatMap((s) => s.skip))].join('；'),
              )
            : null,
          alerts.missing.length > 0
            ? React.createElement('div', { className: 'tw-hint', style: { color: 'var(--tw-up)' } },
                `${alerts.missing.length} 条取不到日线：${alerts.missing[0].note}`)
            : null,
          alerts.error !== null
            ? React.createElement('div', { className: 'tw-hint', style: { color: 'var(--tw-up)' } }, `异动判定接口不可用：${alerts.error}`)
            : null,
        )
      : null,
    // 行业/板块请求失败必须说出来（否则每一行都"看起来本来就没有行业"）。
    // 正文只留一行：原因与时刻可见，长解释进 tooltip —— 这类横幅每轮刷新都在，写成三行会把面板挤满。
    indState.status === 'error'
      ? React.createElement('div', {
          className: 'tw-hint',
          style: { color: 'var(--tw-up)' },
          tabIndex: 0,
          role: 'note',
          'aria-label':
            `板块涨跌与 α 本次未取到（${indState.error ?? '上游不可用'}）。` +
            '板块涨幅与 α 显示 — 而不是 0：0 会被读成"没涨没跌"，那是错的；下一次行情轮询会自动重试。',
          title:
            '板块涨幅与 α 显示 — 而不是 0：0 会被读成"没涨没跌"，那是错的。' +
            '行业归属与板块行情取不到时，下一次行情轮询会自动重试。',
        },
          `板块涨跌与 α 本次未取到 · ${indState.at === null ? '时刻未知' : new Date(indState.at).toLocaleTimeString('zh-CN', { hour12: false })} · ${indState.error ?? '上游不可用'}`,
        )
      : null,
    // 列头排序（宽屏）：与段控读写**同一份** watchSort 偏好。两者由 `wide` 二选一挂载，
    // 因此任一宽度下都只有一个排序入口（此前靠 CSS 隐藏，实测会同时出现两个）
    wide
      ? React.createElement(SortHeader<WatchSortKey>, {
          columns: WATCH_COLUMNS,
          state: watchSort,
          onChange: (next) => setPrefs({ watchSort: next }),
          ariaLabel: '自选列头排序',
        })
      : null,
    // 年初至今（YTD）的失败与上限必须说出来：数字静静变 — 会被读成"这只票今年没动"
    ytd.error !== null
      ? React.createElement('div', { className: 'tw-hint', style: { color: 'var(--tw-up)' } },
          `年初至今（YTD）本次未取到：${ytd.error}。已取到的数字保留上一次结果，取不到的显示 —（不用 0 顶替）。`)
      : null,
    ytd.truncated
      ? React.createElement('div', {
          className: 'tw-hint',
          title: `YTD 单次上限 ${ytd.limit} 项；超出部分不静默截断，而是显示 — 并在此说明。`,
        }, `YTD 单次上限 ${ytd.limit} 项，超出部分显示 —`)
      : null,
    ytdSummary !== null
      ? React.createElement('div', {
          className: 'tw-hint',
          tabIndex: 0,
          role: 'note',
          'aria-label': `年初至今：${ytdSummary}。取不到的一律显示 — 而不是 0：0 会被读成"今年没涨没跌"。逐行原因见各行的悬停提示。`,
          title: '取不到的一律显示 — 而不是 0：0 会被读成"今年没涨没跌"。逐行原因见各行的悬停提示。',
        }, `YTD：${ytdSummary}`)
      : null,
    active.length === 0
      ? React.createElement(EmptyHint, { action: React.createElement(Btn, { primary: true, onClick: () => setModal({ kind: 'addGroup' }) }, '+ 新建分组') }, '暂无自选分组：新建分组后，往组里添加证券（支持搜索代码/名称）。')
      : null,
    active.map((g) => {
      // 排序在分组内生效；无行情/无市值的条目恒沉底（见 sort.ts）
      const items = sortWatch(itemsOf(g.id), watchSort, (it) => {
        const q = quotes[it.secid]
        return {
          pct: q?.pct ?? null,
          totalMv: q?.totalMv ?? null,
          amount: q?.amount ?? null,
          chg: q?.chg ?? null,
          alpha: alphaOf(it.secid).alpha,
        }
      })
      const isCollapsed = collapsed[g.id] === true
      return React.createElement(
        'div',
        { key: g.id, className: 'tw-group' },
        React.createElement('div', { className: 'tw-group-h' },
          React.createElement('div', { className: 'tw-gh-row' },
          React.createElement('button', {
            className: 'gname',
            title: isCollapsed ? '展开' : '折叠',
            'aria-label': `${isCollapsed ? '展开' : '折叠'}分组 ${g.name}`,
            onClick: () => setCollapsed((s) => ({ ...s, [g.id]: !isCollapsed })),
          }, isCollapsed ? '▸ ' : '▾ '),
          React.createElement('span', { className: 'gname' }, g.name),
          React.createElement('span', { className: 'tw-muted', style: { fontSize: 11 } }, `${items.length} 只`),
          React.createElement('span', { style: { flex: 1 } }),
          React.createElement(Btn, { onClick: () => setModal({ kind: 'addItem', groupId: g.id, groupName: g.name }) }, '添加证券'),
          React.createElement(MoreMenu, {
            ariaLabel: `分组 ${g.name} 更多操作`,
            items: [
              { label: '重命名分组', onClick: () => setModal({ kind: 'renameGroup', groupId: g.id, name: g.name }) },
              { label: '编辑备注', onClick: () => setModal({ kind: 'noteGroup', groupId: g.id, name: g.name, note: g.note ?? '' }) },
              {
                label: '删除分组（归档）',
                danger: true,
                onClick: () => {
                  if (window.confirm(`归档删除分组「${g.name}」？组内条目保留并可随分组恢复。`)) mutate({ op: 'archiveGroup', groupId: g.id })
                },
              },
            ],
          }),
          ),
        ),
        isCollapsed || items.length === 0
          ? null
          : React.createElement('div', { className: 'tw-wlist' },
            ...items.map((it) => {
              const q = quotes[it.secid]
              const alert = alertOf.get(it.secid)
              const cls = dirClass(q?.chg ?? null, prefs.redUp)
              const pct = q?.pct ?? null
              const mini = minis[it.secid]
              const ind = inds[it.secid]
              // α 与列头排序共用同一处实现（见 alphaOf）
              const { stockPct, boardPct, alpha } = alphaOf(it.secid)
              const ytdRow = ytd.map[it.secid]
              const hasQuote = q !== undefined && q.price !== null
              return React.createElement(
                'div',
                {
                  key: it.id,
                  className: 'tw-wrow',
                  // P1-4：异动行呼吸高亮（CSS 动画；静默只压制提醒，不改变"它在异动"）
                  'data-alert': alert === undefined ? undefined : alert.kind,
                  title: alert === undefined ? undefined : `异动：${alert.reasons.join(' · ')}`,
                  tabIndex: 0,
                  role: 'button',
                  'aria-label': `${it.name} ${it.secid}${alert === undefined ? '' : '（异动）'}，回车打开分时明细`,
                  onKeyDown: (e: React.KeyboardEvent) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault()
                      openDetail(it.secid, it.name)
                    }
                  },
                                  onClick: (e: React.MouseEvent) => {
                    // 行内还有迷你图按钮/更多菜单：点它们时不要连带触发整行
                    if ((e.target as HTMLElement).closest('button,a,input,select,textarea') !== null) return
                    openDetail(it.secid, it.name)
                  },
                },
                React.createElement('button', {
                  className: 'tw-mini',
                  // P1-1：开/高/低/振幅放在 hover 里显示 —— 缩略图只有 56×20，往图上加字就是噪音
                  title: miniHover(it.name, mini),
                  onClick: () => openDetail(it.secid, it.name),
                },
                  React.createElement(MiniTrend, { values: mini?.values ?? [], avg: mini?.avg, up: mini?.up ?? null, width: 56, height: 20, redUp: prefs.redUp }),
                ),
                React.createElement('div', { className: 'nm' },
                  React.createElement('div', null,
                    React.createElement('b', null, it.name),
                    React.createElement('span', { className: 'tw-code' }, it.secid),
                    alert !== undefined
                      ? React.createElement('span', {
                          className: 'tw-badge',
                          style: { marginLeft: 6, color: 'var(--tw-up)', borderColor: 'var(--tw-up)' },
                          title: alert.reasons.join(' · '),
                        }, alert.kind === 'volume' ? '放量' : alert.kind === 'price' ? '异动' : '量价')
                      : null,
                  ),
                  React.createElement('small', { style: { display: 'flex', gap: 6, alignItems: 'baseline', flexWrap: 'wrap' } },
                    q?.amount !== null && q?.amount !== undefined && q.amount > 0
                      ? React.createElement('span', { className: 'tw-num' }, `额 ${fmtAmt(q.amount)}`)
                      : null,
                    // 市值：排序键是它，就必须看得见（新浪备用源/国际指数/商品没有该字段 → 不显示）
                    q?.totalMv !== null && q?.totalMv !== undefined && q.totalMv > 0
                      ? React.createElement('span', { className: 'tw-dim tw-num' }, `市值 ${fmtAmt(q.totalMv)}`)
                      : null,
                    ind !== undefined
                      ? React.createElement(React.Fragment, null,
                          React.createElement('span', { className: 'tw-dim' }, `行业 ${ind.name}`),
                          ind.pct !== null
                            ? React.createElement('span', { className: dirClass(ind.pct, prefs.redUp) }, fmtPct(ind.pct))
                            : React.createElement('span', {
                                className: 'tw-muted',
                                // 板块涨幅缺失一律显示 —，**绝不拿 0 代替**：0 会被读成"没涨没跌"，
                                // 那是错的信息，而"取不到"是另一件事
                                // 原因不能只挂在 title 上：title 是鼠标专属（键盘/触屏拿不到），
                                // 因此缺失态补 tabIndex + aria-label（P1-5）
                                title: '板块当日涨幅未取到：该板块不在本次榜单返回里，或板块行情接口暂不可用（稍后随行情轮询重试）。这里显示 — 而不是 0，因为 0 会被读成"没涨没跌"——那是错的',
                                tabIndex: 0,
                                role: 'note',
                                'aria-label': '板块当日涨幅未取到：该板块不在本次榜单返回里，或板块行情接口暂不可用（稍后随行情轮询重试）。这里显示 — 而不是 0，因为 0 会被读成"没涨没跌"',
                              }, '板块 —'),
                          React.createElement('span', {
                            className: 'tw-num ' + dirClass(alpha, prefs.redUp),
                            title: alpha !== null
                              ? `α = 个股涨跌幅 ${stockPct?.toFixed(2)}% − 板块涨跌幅 ${boardPct?.toFixed(2)}%`
                              : stockPct === null
                                ? 'α 不可算：该标的本次没有可用行情（个股涨跌幅缺失）'
                                : 'α 不可算：板块涨跌幅未取到（见左侧「板块 —」的说明）',
                            // 不可算时给键盘/触屏一条可读的原因（可计算时不需要）
                            ...(alpha === null
                              ? {
                                  tabIndex: 0,
                                  role: 'note',
                                  'aria-label': stockPct === null
                                    ? 'α 不可算：该标的本次没有可用行情（个股涨跌幅缺失）'
                                    : 'α 不可算：板块涨跌幅未取到（见左侧「板块 —」的说明）',
                                }
                              : {}),
                          }, `α ${alpha === null ? '—' : `${pctArrow(alpha)}${Math.abs(alpha).toFixed(2)}%`}`),
                        )
                      : null,
                    // 年初至今（YTD）：口径写在 tooltip 里（shared/model.ts 的 YTD_CALIBER）；
                    // 不可算就显示 — 并说明原因 —— 不用 0 顶替
                    React.createElement('span', {
                      className: `tw-num tw-ytd ${dirClass(ytdRow?.ytd ?? null, prefs.redUp)}`,
                      title: ytdTooltip(it.name, ytdRow, ytd.loaded),
                      ...(ytdRow?.ytd == null
                        ? { tabIndex: 0, role: 'note', 'aria-label': ytdTooltip(it.name, ytdRow, ytd.loaded) }
                        : {}),
                    }, `YTD ${ytdText(ytdRow)}`),
                    it.note !== undefined && it.note !== '' ? React.createElement('span', { className: 'tw-muted' }, it.note) : null,
                  ),
                ),
                hasQuote
                  ? React.createElement('div', { className: 'wq' },
                      React.createElement('span', { className: 'px ' + cls, style: { fontSize: 15, fontWeight: 650 } }, fmtPrice(q?.price ?? null)),
                      React.createElement('span', { className: 'chg ' + cls }, fmtSigned(q?.chg ?? null)),
                      React.createElement('span', { className: `tw-chg-chip ${pct === null ? 'tw-chip-flat' : pct >= 0 ? (prefs.redUp ? 'tw-chip-up' : 'tw-chip-down') : (prefs.redUp ? 'tw-chip-down' : 'tw-chip-up')}` }, fmtPct(pct)),
                    )
                  : quotesReady
                    ? noSource(it.secid)
                      // 区分两种"没有数字"：没有任何可用行情源 vs 本轮还没拿到数据
                      ? React.createElement('div', { className: 'wq' },
                          React.createElement('span', {
                            className: 'tw-badge',
                            title: '东财、腾讯、新浪三个源都没有返回该标的的可用价格。若为期货主连/商品合约，请核对代码大小写（如 114.lhm 与 114.LHM 是同一标的，现已大小写无关匹配）。',
                            style: { fontSize: 9.5, color: '#e0a94a' },
                            tabIndex: 0,
                            role: 'note',
                            'aria-label': '无行情源：东财、腾讯、新浪三个源都没有返回该标的的可用价格。若为期货主连/商品合约，请核对代码大小写（114.lhm 与 114.LHM 是同一标的，现已大小写无关匹配）',
                          }, NO_SOURCE_LABEL))
                      : React.createElement('div', { className: 'wq' }, React.createElement('span', {
                          className: 'tw-muted',
                          title: PENDING_TITLE,
                          tabIndex: 0,
                          role: 'note',
                          'aria-label': `${PENDING_LABEL}：${PENDING_TITLE}`,
                        }, PENDING_LABEL))
                    : React.createElement('div', { className: 'wq' }, React.createElement('div', { className: 'tw-skel', style: { width: 76, height: 16 } })),
                React.createElement(MoreMenu, {
                  ariaLabel: `${it.name} 更多操作`,
                  title: '更多',
                  items: [
                    { label: '移动分组', onClick: () => setModal({ kind: 'moveItem', groupId: g.id, groupName: g.name, itemId: it.id, itemName: it.name, secid: it.secid }) },
                    { label: '移除', danger: true, onClick: () => mutate({ op: 'removeItem', itemId: it.id }) },
                  ],
                }),
              )
            }),
          ),
      )
    }),
    showArchived && archived.length > 0
      ? React.createElement('div', { className: 'tw-panel', style: { opacity: 0.72 } },
          React.createElement('div', { className: 'tw-panel-h' }, React.createElement('span', { className: 't tw-dim' }, '已归档分组')), 
          archived.map((g) =>
            React.createElement('div', { key: g.id, className: 'tw-wrow' },
              React.createElement('div', { className: 'nm' }, React.createElement('b', null, g.name), React.createElement('small', null, `${itemsOf(g.id).length} 只（原条目保留）`)),
              React.createElement(Btn, { onClick: () => mutate({ op: 'restoreGroup', groupId: g.id }) }, '恢复'),
            ),
          ),
        )
      : null,
    modal !== null ? React.createElement(WatchModal, { key: `${modal.kind}:${(modal as { groupId?: string }).groupId ?? (modal as { itemId?: string }).itemId ?? 'n'}`, modal, groups: active, onClose: () => setModal(null), mutate }) : null,
  )
}

function WatchModal(props: {
  modal: NonNullable<ModalState>
  groups: Array<{ id: string; name: string }>
  onClose: () => void
  mutate: (body: Parameters<typeof api.mutateWatch>[0], done?: () => void) => void
}): React.ReactElement {
  const { modal, groups, onClose, mutate } = props
  const [name, setName] = useState(modal.kind === 'renameGroup' ? modal.name : '')
  const [note, setNote] = useState(modal.kind === 'noteGroup' ? modal.note : '')
  const [err, setErr] = useState<string | null>(null)
  const [targetGroup, setTargetGroup] = useState<string | null>(null)

  if (modal.kind === 'addGroup' || modal.kind === 'renameGroup' || modal.kind === 'noteGroup') {
    // 备注模态此前把输入框绑在 `name` 上、保存时却提交从未更新的 `note`：
    // 打开是空框、输入任何内容保存都不生效（实测确认）。这里按模态切换状态源。
    const isNote = modal.kind === 'noteGroup'
    return React.createElement(
      Modal,
      { title: modal.kind === 'addGroup' ? '新建分组' : modal.kind === 'renameGroup' ? '重命名分组' : '分组备注', onClose },
      React.createElement(ErrorNote, { error: err }),
      React.createElement(
        Field,
        { label: isNote ? '备注（200 字内，留空即清除）' : '分组名' },
        React.createElement('input', {
          className: 'tw-input',
          value: isNote ? note : name,
          autoFocus: true,
          placeholder: modal.kind === 'addGroup' ? '如：科技成长' : undefined,
          onChange: (e) => (isNote ? setNote(e.target.value) : setName(e.target.value)),
        }),
      ),
      React.createElement('div', { style: { display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 6 } },
        React.createElement(Btn, { onClick: onClose }, '取消'),
        React.createElement(Btn, {
          primary: true,
          onClick: () => {
            if (modal.kind === 'addGroup') {
              if (name.trim() === '') { setErr('请输入分组名'); return }
              mutate({ op: 'addGroup', name }, onClose)
            } else if (modal.kind === 'renameGroup') {
              if (name.trim() === '') { setErr('请输入分组名'); return }
              mutate({ op: 'renameGroup', groupId: modal.groupId, name }, onClose)
            } else {
              mutate({ op: 'noteGroup', groupId: modal.groupId, note }, onClose)
            }
          },
        }, '保存'),
      ),
    )
  }
  if (modal.kind === 'addItem') {
    const pick = (item: SuggestItem): void => {
      setErr(null)
      mutate({ op: 'addItem', groupId: modal.groupId, secid: item.secid, symbolName: item.name }, onClose)
    }
    return React.createElement(
      Modal,
      { title: `添加证券到「${modal.groupName}」`, onClose },
      React.createElement(ErrorNote, { error: err }),
      React.createElement(SuggestInput, { onPick: pick, autoFocus: true }),
      React.createElement('div', { className: 'tw-hint' }, '支持 A股/港股/美股/ETF/基金/指数/期货主连/现货，如 688825、02155、510300、114.lhm'),
    )
  }
  if (modal.kind === 'moveItem') {
    const targets = groups.filter((g) => g.id !== modal.groupId)
    return React.createElement(
      Modal,
      { title: `移动「${modal.itemName}」`, onClose },
      React.createElement(ErrorNote, { error: err }),
      targets.length === 0
        ? React.createElement('div', { className: 'tw-hint' }, '没有其他可选分组（目标分组需先创建）。')
        : React.createElement(
            Field,
            { label: '目标分组' },
            React.createElement('select', { className: 'tw-input', value: targetGroup ?? '', onChange: (e) => setTargetGroup(e.target.value) } as React.SelectHTMLAttributes<HTMLSelectElement>,
              React.createElement('option', { value: '', disabled: true }, '选择分组…'),
              targets.map((g) => React.createElement('option', { key: g.id, value: g.id }, g.name)),
            ),
          ),
      React.createElement('div', { style: { display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 6 } },
        React.createElement(Btn, { onClick: onClose }, '取消'),
        React.createElement(Btn, {
          primary: true,
          disabled: targets.length === 0 || targetGroup === null,
          onClick: () => { if (targetGroup !== null) mutate({ op: 'moveItem', itemId: modal.itemId, groupId: targetGroup }, onClose) },
        }, '移动'),
      ),
    )
  }
  return React.createElement('div', null)
}

/**
 * 缩略图的 hover 说明（P1-1）：名称 + 开/高/低/振幅 + 均价。
 *
 * 振幅 = (高 − 低) ÷ 昨收；缺昨收时不编数（振幅分母不对等于给了一个错的波动幅度）。
 * 数据不全时只列能算的项，不显示占位符 —— hover 里一堆 `—` 只是噪音。
 */
function miniHover(name: string, mini: { open?: number | null; high?: number | null; low?: number | null; prePrice?: number | null; values?: number[] } | undefined): string {
  const head = `${name} 分时 · 点击打开明细`
  if (mini === undefined) return head
  const parts: string[] = []
  if (mini.open !== null && mini.open !== undefined) parts.push(`开 ${mini.open.toFixed(3)}`)
  if (mini.high !== null && mini.high !== undefined) parts.push(`高 ${mini.high.toFixed(3)}`)
  if (mini.low !== null && mini.low !== undefined) parts.push(`低 ${mini.low.toFixed(3)}`)
  const pre = mini.prePrice
  if (pre !== null && pre !== undefined && pre > 0 && mini.high != null && mini.low != null) {
    parts.push(`振幅 ${(((mini.high - mini.low) / pre) * 100).toFixed(2)}%`)
  } else {
    parts.push('振幅 —（上游未给昨收）')
  }
  // 相对昨收的涨跌幅：只在"有昨收且有最新价"时给（缺一就是 NaN 或一个错的分母）
  const last = mini.values !== undefined && mini.values.length > 0 ? mini.values[mini.values.length - 1] : null
  if (last !== null && pre !== null && pre !== undefined && pre > 0) {
    parts.push(`相对昨收 ${(((last - pre) / pre) * 100).toFixed(2)}%`)
  }
  return `${head}\n${parts.join(' · ')}`
}
